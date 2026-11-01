// Análisis: todos los gráficos sobre un mismo periodo elegido arriba.
import { get } from '../api.js';
import {
  $, METHOD_NAMES, compactMoney, fmtDateFull, fmtDateLong, html, icon, money, monthEnd, monthLabelFull, monthShort, monthStart, on,
  pct, plural, sheet, shiftMonth, thisMonth, today, skeletonPage,
} from '../ui.js';
import { catAxis, grid, mountChart, tipBox, tipHTML, valAxis, axisLabel } from '../charts.js';

const PRESETS = [
  ['month', 'Este mes'], ['prev', 'Mes pasado'], ['3m', 'Últimos 3 meses'], ['year', 'Este año'], ['12m', 'Últimos 12 meses'], ['lastyear', 'Año pasado'],
];
const OTHER_COLOR = '#9AA3B2';

function presetRange(k) {
  const m = thisMonth();
  const y = Number(m.slice(0, 4));
  switch (k) {
    case 'month': return [monthStart(m), monthEnd(m)];
    case 'prev': return [monthStart(shiftMonth(m, -1)), monthEnd(shiftMonth(m, -1))];
    case '3m': return [monthStart(shiftMonth(m, -2)), monthEnd(m)];
    case 'year': return [`${y}-01-01`, `${y}-12-31`];
    case 'lastyear': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    default: return [monthStart(shiftMonth(m, -11)), monthEnd(m)];
  }
}

export default async function analyticsView(ctx) {
  let preset = PRESETS.some((p) => p[0] === ctx.query.p) ? ctx.query.p : '12m';
  let [from, to] = presetRange(preset);
  let d = null;
  const tables = new Set();
  let stackPct = false;

  ctx.setHeader('Análisis', 'Hacia dónde va el dinero de casa', html`<a class="btn" href="#/resumen">${icon('sparkles')}<span class="desktop-only">Resumen del mes</span></a>`);

  async function load() {
    $('.an', ctx.el)?.classList.add('loading');
    try {
      d = await get(`/stats/analytics?from=${from}&to=${to}`);
      if (ctx.isCurrent()) draw();
    } catch (e) {
      ctx.el.innerHTML = String(html`<div class="empty"><p>${e.message}</p></div>`);
    }
  }

  const label = () => (preset === 'custom' ? `${fmtDateFull(from)} – ${fmtDateFull(to)}` : PRESETS.find((p) => p[0] === preset)[1]);
  const topCats = (n = 6) => {
    const top = d.byCategory.slice(0, n);
    const rest = d.byCategory.slice(n);
    return { top, rest, restTotal: rest.reduce((s, c) => s + c.total, 0) };
  };

  function draw() {
    const exp = d.totals.expense;
    const inc = d.totals.income;
    const net = inc - exp;
    const nonEmpty = d.totals.count > 0;
    const src = d.sources;
    const srcTotal = src.recurring + src.bills + src.shopping + src.other || 1;
    const SRC = [['recurring', 'Fijos y plazos', 'var(--chart-1)'], ['bills', 'Facturas', 'var(--chart-7)'], ['shopping', 'Lista de la compra', 'var(--chart-2)'], ['other', 'Día a día', 'var(--chart-4)']];

    ctx.el.innerHTML = String(html`<div class="an stack" style="gap:18px">
      <div class="filters" style="margin:0">
        <div class="chips scroll">${PRESETS.map(([k, l]) => html`<button class="chip" data-preset="${k}" aria-pressed="${preset === k}">${l}</button>`)}
          <button class="chip" data-act="custom" aria-pressed="${preset === 'custom'}">${icon('calendar-days', 'sm')}${preset === 'custom' ? label() : 'Fechas…'}</button></div>
      </div>
      ${!nonEmpty ? html`<div class="empty"><div class="art">📊</div><h3>Sin datos en este periodo</h3><p>Prueba con otro periodo o anota algunos movimientos.</p></div>` : html`
      <section class="stat-strip">
        <div class="stat"><span class="label">Gastos</span><span class="value">${money(exp, { decimals: 0 })}</span><span class="delta">${plural(d.totals.count, 'movimiento', 'movimientos')}</span></div>
        <div class="stat"><span class="label">Ingresos</span><span class="value pos">${money(inc, { decimals: 0 })}</span></div>
        <div class="stat"><span class="label">Ahorro</span><span class="value ${net >= 0 ? 'pos' : 'neg'}">${money(net, { sign: true, decimals: 0 })}</span>
          <span class="delta ${net >= 0 ? 'good' : 'bad'}">${inc ? `${pct(net / inc)} de los ingresos` : ''}</span></div>
        <div class="stat"><span class="label">Gasto medio al mes</span><span class="value">${money((exp / d.effDays) * 30.44, { decimals: 0 })}</span>
          <span class="delta">${money(exp / d.effDays, { decimals: 0 })} al día</span></div>
      </section>

      <section class="panel"><div class="panel-head"><h2>Ingresos y gastos</h2><span class="sub">${label()}</span>
        <div class="actions">${tableToggle('monthly')}</div></div>
        <div class="chart-legend"><span><i style="--c:var(--chart-1)"></i>Gastos</span><span><i style="--c:var(--chart-2)"></i>Ingresos</span>
          <span><i class="line" style="--c:var(--ink)"></i>Ahorro del mes</span></div>
        ${tables.has('monthly') ? monthlyTable() : html`<div class="chart tall" id="c-monthly" role="img" aria-label="Ingresos, gastos y ahorro por mes"></div>`}
      </section>

      <section class="panel"><div class="panel-head"><h2>Flujo del dinero</h2><span class="sub">de dónde viene y a dónde va</span></div>
        <div class="chart tall sankey" id="c-sankey" role="img" aria-label="Diagrama de flujo de ingresos a gastos"></div></section>

      <div class="grid cols-2">
        <section class="panel"><div class="panel-head"><h2>Reparto del gasto</h2><div class="actions">${tableToggle('cats')}</div></div>
          ${tables.has('cats') ? catsTable() : html`<div class="chart tall" id="c-tree" role="img" aria-label="Reparto del gasto por categoría"></div>`}</section>
        <section class="panel"><div class="panel-head"><h2>De dónde salen los gastos</h2></div>
          <div class="cat-strip" style="height:22px;margin-bottom:16px">${SRC.map(([k, , c]) => (src[k] ? html`<span style="--c:${c};flex:${src[k]}"></span>` : ''))}</div>
          <div>${SRC.map(([k, l, c]) => html`<div class="cat-line"><span class="cat-dot sm" style="--c:${c}"><i style="width:10px;height:10px;border-radius:3px;background:${c}"></i></span>
            <span class="n">${l}<span class="pct">${pct(src[k] / srcTotal)}</span></span><span class="v">${money(src[k], { decimals: 0 })}</span></div>`)}</div>
          <p class="small muted" style="margin-top:10px">«Día a día» son los gastos anotados a mano: súper, restaurantes, gasolina, caprichos… Es donde más margen hay para ahorrar.</p>
        </section>
      </div>

      <section class="panel"><div class="panel-head"><h2>Evolución por categoría</h2>
        <div class="actions"><div class="segmented" data-stack><button data-v="0" aria-pressed="${!stackPct}">Euros</button><button data-v="1" aria-pressed="${stackPct}">Porcentaje</button></div></div></div>
        <div class="chart-legend">${(() => {
          const { top, restTotal } = topCats();
          return [...top.map((c) => html`<span><i style="--c:${c.color}"></i>${c.icon} ${c.name}</span>`), restTotal ? html`<span><i style="--c:${OTHER_COLOR}"></i>Otras</span>` : ''];
        })()}</div>
        <div class="chart tall" id="c-stack" role="img" aria-label="Gasto mensual por categoría"></div></section>

      ${d.daily.length ? html`<section class="panel"><div class="panel-head"><h2>Calendario de gasto</h2><span class="sub">cuanto más oscuro, más gasto ese día</span></div>
        <div class="chart" id="c-heat" role="img" aria-label="Mapa de calor del gasto diario" style="height:${heatHeight()}px"></div></section>` : ''}

      <div class="grid cols-2">
        <section class="panel"><div class="panel-head"><h2>Por día de la semana</h2><span class="sub">gasto medio</span></div>
          <div class="chart short" id="c-wd" role="img" aria-label="Gasto medio por día de la semana"></div>
          ${(() => {
            const max = d.weekday.reduce((a, b) => (b.avg > a.avg ? b : a), d.weekday[0]);
            const names = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
            return max.avg ? html`<p class="small ink-2">Los ${names[max.wd]} es cuando más gastáis: ${money(max.avg, { decimals: 0 })} de media.</p>` : '';
          })()}</section>
        <section class="panel"><div class="panel-head"><h2>Año contra año</h2><span class="sub">${d.yoy.year - 1} frente a ${d.yoy.year}</span></div>
          <div class="chart-legend"><span><i class="line" style="--c:var(--chart-1)"></i>${d.yoy.year}</span><span><i class="line" style="--c:var(--chart-muted)"></i>${d.yoy.year - 1}</span></div>
          <div class="chart short" id="c-yoy" role="img" aria-label="Comparativa interanual"></div></section>
      </div>

      <div class="grid cols-3">
        ${barList('Quién gasta', d.byPerson.map((p) => ({ label: `${p.emoji} ${p.name}`, value: p.total, color: p.color, n: p.n })))}
        ${barList('Cómo se paga', d.byMethod.map((m) => ({ label: METHOD_NAMES[m.method] || 'Sin indicar', value: m.total, color: 'var(--chart-1)', n: m.n })))}
        ${d.byPet.length ? barList('Mascotas', d.byPet.map((p) => ({ label: p.name, value: p.total, color: p.color, n: p.n })))
          : barList('Ingresos por tipo', d.incomeByCategory.map((c) => ({ label: `${c.icon} ${c.name}`, value: c.total, color: 'var(--chart-2)', n: c.n })))}
      </div>

      <div class="grid cols-2">
        ${barList('Dónde más gastáis', d.merchants.map((m) => ({ label: m.name, value: m.total, color: 'var(--chart-1)', n: m.n })), true)}
        <section class="panel"><div class="panel-head"><h2>Gastos puntuales más grandes</h2><span class="sub">sin contar fijos ni facturas</span></div>
          <div class="rows">${d.biggest.map((t) => html`<div class="rowi">
            <span class="cat-dot sm" style="--c:${t.category_color || '#8A8F98'}"><span class="emoji">${t.category_icon || '❔'}</span></span>
            <span class="main-txt"><span class="title">${t.description || t.merchant}</span><span class="meta">${fmtDateFull(t.date)} · ${t.category_name || 'Sin categoría'}</span></span>
            <span class="amount">${money(t.amount)}</span></div>`)}</div></section>
      </div>`}
    </div>`);
    if (nonEmpty) drawCharts();
  }

  const tableToggle = (k) => html`<button class="btn ghost sm" data-table="${k}">${icon(tables.has(k) ? 'chart-column' : 'table-2', 'sm')}${tables.has(k) ? 'Ver gráfico' : 'Ver tabla'}</button>`;
  const monthlyTable = () => html`<div class="table-scroll"><table class="table-view"><thead><tr><th>Mes</th><th class="n">Ingresos</th><th class="n">Gastos</th><th class="n">Ahorro</th></tr></thead>
    <tbody>${d.monthly.map((m) => html`<tr><td>${monthLabelFull(m.month)}</td><td class="n">${money(m.income)}</td><td class="n">${money(m.expense)}</td>
      <td class="n ${m.income - m.expense >= 0 ? 'pos' : 'neg'}">${money(m.income - m.expense, { sign: true })}</td></tr>`)}</tbody></table></div>`;
  const catsTable = () => html`<div class="table-scroll"><table class="table-view"><thead><tr><th>Categoría</th><th class="n">Movs.</th><th class="n">Total</th><th class="n">%</th></tr></thead>
    <tbody>${d.byCategory.map((c) => html`<tr><td>${c.icon} ${c.name}</td><td class="n">${c.n}</td><td class="n">${money(c.total)}</td><td class="n">${pct(c.total / (d.totals.expense || 1), 1)}</td></tr>`)}</tbody></table></div>`;

  function barList(title, items, numbered = false) {
    const max = Math.max(...items.map((i) => i.value), 1);
    const total = items.reduce((s, i) => s + i.value, 0) || 1;
    return html`<section class="panel"><div class="panel-head"><h2>${title}</h2></div>
      ${items.length ? html`<div>${items.slice(0, 10).map((it, i) => html`<div class="cat-line" style="grid-template-columns:${numbered ? '22px' : '0'} minmax(0,1fr) auto">
        ${numbered ? html`<span class="small muted num" style="grid-row:span 2">${i + 1}</span>` : html`<span style="grid-row:span 2"></span>`}
        <span class="n"><span class="ellipsis">${it.label}</span><span class="pct">${pct(it.value / total)}</span></span>
        <span class="v">${money(it.value, { decimals: 0 })}</span>
        <span class="bar"><span class="meter" style="--c:${it.color}"><span class="fill" style="width:${(it.value / max) * 100}%"></span></span>
          <small>${plural(it.n, 'vez', 'veces')}</small></span></div>`)}</div>` : html`<p class="small muted">Sin datos.</p>`}</section>`;
  }

  const heatHeight = () => {
    const weeks = Math.ceil(d.dayCount / 7) + 2;
    return weeks > 30 ? 230 : 210;
  };

  function drawCharts() {
    // Ingresos y gastos por mes
    if (!tables.has('monthly')) {
      mountChart($('#c-monthly', ctx.el), (t) => ({
        animationDuration: 600,
        grid: grid({ top: 14 }),
        tooltip: {
          ...tipBox(t), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.dark ? 'rgba(255,255,255,.04)' : 'rgba(17,26,48,.04)' } },
          formatter: (ps) => {
            const m = d.monthly[ps[0].dataIndex];
            return tipHTML(monthLabelFull(m.month), [
              { color: t.series[1], value: money(m.income, { decimals: 0 }), label: 'ingresos', box: true },
              { color: t.series[0], value: money(m.expense, { decimals: 0 }), label: 'gastos', box: true },
              { color: t.ink, value: money(m.income - m.expense, { sign: true, decimals: 0 }), label: 'ahorro' },
            ]);
          },
        },
        xAxis: catAxis(t, d.monthly.map((m) => monthShort(m.month))),
        yAxis: valAxis(t),
        series: [
          { name: 'Gastos', type: 'bar', data: d.monthly.map((m) => m.expense), barMaxWidth: 16, barGap: '15%', itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] } },
          { name: 'Ingresos', type: 'bar', data: d.monthly.map((m) => m.income), barMaxWidth: 16, itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] } },
          {
            name: 'Ahorro', type: 'line', data: d.monthly.map((m) => m.income - m.expense), symbol: 'circle', symbolSize: 8, showSymbol: d.monthly.length <= 14,
            lineStyle: { width: 2, color: t.ink }, itemStyle: { color: t.ink, borderColor: t.surface, borderWidth: 2 }, z: 5,
            markLine: { symbol: 'none', silent: true, data: [{ yAxis: 0 }], lineStyle: { color: t.axis, width: 1, type: 'solid' }, label: { show: false } },
          },
        ],
      }));
    }

    // En el móvil hay menos sitio: menos nodos y lo pequeño agrupado, para que no se pisen las etiquetas.
    const narrow = ctx.el.clientWidth < 560;

    // Sankey: ingresos → hogar → categorías de gasto (+ ahorro)
    {
      const { top, restTotal } = topCats(narrow ? 5 : 7);
      let inc = d.incomeByCategory;
      const incTotal = inc.reduce((s, c) => s + c.total, 0);
      if (narrow) {
        const small = inc.filter((c) => c.total < incTotal * 0.08);
        if (small.length > 1) {
          inc = [...inc.filter((c) => !small.includes(c)), { icon: '➕', name: 'Otros ingresos', color: OTHER_COLOR, total: small.reduce((a, c) => a + c.total, 0) }];
        }
      }
      const expTotal = d.totals.expense;
      const nodes = [];
      const links = [];
      const HUB = 'Presupuesto de casa';
      inc.forEach((c) => {
        nodes.push({ name: `${c.icon} ${c.name}`, itemStyle: { color: c.color } });
        links.push({ source: `${c.icon} ${c.name}`, target: HUB, value: c.total });
      });
      if (expTotal > incTotal) {
        nodes.push({ name: 'Ahorros previos', itemStyle: { color: OTHER_COLOR } });
        links.push({ source: 'Ahorros previos', target: HUB, value: expTotal - incTotal });
      }
      nodes.push({ name: HUB, itemStyle: { color: '#2347C5' }, ...(narrow ? { label: { show: false } } : {}) });
      top.forEach((c) => {
        nodes.push({ name: `${c.icon} ${c.name} `, itemStyle: { color: c.color } });
        links.push({ source: HUB, target: `${c.icon} ${c.name} `, value: c.total });
      });
      if (restTotal) {
        nodes.push({ name: 'Otras categorías', itemStyle: { color: OTHER_COLOR } });
        links.push({ source: HUB, target: 'Otras categorías', value: restTotal });
      }
      if (incTotal > expTotal) {
        nodes.push({ name: '💰 Ahorro', itemStyle: { color: '#0B7A5C' } });
        links.push({ source: HUB, target: '💰 Ahorro', value: incTotal - expTotal });
      }
      mountChart($('#c-sankey', ctx.el), (t) => ({
        animationDuration: 800,
        tooltip: {
          ...tipBox(t), trigger: 'item',
          formatter: (p) => (p.dataType === 'edge'
            ? tipHTML(`${p.data.source.trim()} → ${p.data.target.trim()}`, [{ color: t.cobalt, value: money(p.data.value, { decimals: 0 }), label: pct(p.data.value / Math.max(incTotal, expTotal)) }])
            : tipHTML(p.name.trim(), [{ color: p.color, value: money(p.value, { decimals: 0 }), label: '', box: true }])),
        },
        series: [{
          type: 'sankey', left: 4, right: narrow ? 128 : 160, top: 8, bottom: 8, nodeWidth: narrow ? 12 : 14, nodeGap: narrow ? 14 : 16, layoutIterations: 48, draggable: false,
          emphasis: { focus: 'adjacency' },
          data: nodes, links,
          lineStyle: { color: 'gradient', opacity: t.dark ? 0.32 : 0.22, curveness: 0.5 },
          itemStyle: { borderWidth: 0, borderRadius: 3 },
          label: {
            color: t.ink, fontFamily: t.font, fontSize: 12.5, fontWeight: 560,
            formatter: (p) => `{n|${p.name.trim()}}\n{v|${compactMoney(p.value)}}`,
            rich: { n: { color: t.ink, fontSize: 12.5, fontWeight: 600, fontFamily: t.font }, v: { color: t.ink3, fontSize: 11.5, fontFamily: t.font, padding: [2, 0, 0, 0] } },
          },
        }],
      }));
    }

    // Treemap del reparto
    if (!tables.has('cats')) {
      mountChart($('#c-tree', ctx.el), (t) => ({
        tooltip: { ...tipBox(t), formatter: (p) => tipHTML(p.name, [{ color: p.color, value: money(p.value), label: pct(p.value / d.totals.expense, 1), box: true }]) },
        series: [{
          type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, right: 0, top: 0, bottom: 0,
          itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2, borderRadius: 8 },
          label: {
            show: true, fontFamily: t.font, color: '#fff', fontSize: narrow ? 12 : 13, fontWeight: 650, overflow: 'truncate', ellipsis: '…',
            formatter: (p) => `${p.name}\n{v|${compactMoney(p.value)}}`, rich: { v: { fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,.85)', padding: [3, 0, 0, 0] } },
          },
          upperLabel: { show: false },
          data: (() => {
            // Casillas diminutas no se leen (y cortan el emoji): en el móvil, lo que no llega al 4 % va junto.
            const big = narrow ? d.byCategory.filter((c) => c.total >= d.totals.expense * 0.04) : d.byCategory;
            const rest = d.byCategory.filter((c) => !big.includes(c));
            return [
              ...big.map((c) => ({ name: `${c.icon} ${c.name}`, value: c.total, itemStyle: { color: c.color } })),
              ...(rest.length ? [{ name: rest.length === 1 ? `${rest[0].icon} ${rest[0].name}` : `Otras (${rest.length})`, value: rest.reduce((a, c) => a + c.total, 0), itemStyle: { color: OTHER_COLOR } }] : []),
            ];
          })(),
        }],
      }));
    }

    // Evolución apilada por categoría
    {
      const { top, rest } = topCats();
      const months = d.months;
      const restVals = months.map((_, i) => rest.reduce((s, c) => s + (d.monthlyByCategory.find((x) => x.id === c.id)?.values[i] || 0), 0));
      const seriesData = [
        ...top.map((c) => ({ c, values: d.monthlyByCategory.find((x) => x.id === c.id)?.values || [] })),
        ...(rest.length ? [{ c: { name: 'Otras', icon: '', color: OTHER_COLOR }, values: restVals }] : []),
      ];
      const totals = months.map((_, i) => seriesData.reduce((s, x) => s + (x.values[i] || 0), 0));
      mountChart($('#c-stack', ctx.el), (t) => ({
        animationDuration: 600,
        grid: grid({ top: 10 }),
        tooltip: {
          ...tipBox(t), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.dark ? 'rgba(255,255,255,.04)' : 'rgba(17,26,48,.04)' } },
          formatter: (ps) => {
            const i = ps[0].dataIndex;
            return tipHTML(`${monthLabelFull(months[i])} · ${money(totals[i], { decimals: 0 })}`, seriesData.slice().reverse()
              .filter((x) => x.values[i]).map((x) => ({ color: x.c.color, value: money(x.values[i], { decimals: 0 }), label: `${x.c.icon} ${x.c.name}`.trim(), box: true })));
          },
        },
        xAxis: catAxis(t, months.map(monthShort)),
        yAxis: stackPct ? { ...valAxis(t), max: 100, axisLabel: axisLabel(t, { formatter: (v) => `${v} %` }) } : valAxis(t),
        series: seriesData.map((x, si) => ({
          name: x.c.name, type: 'bar', stack: 'total', barMaxWidth: 30,
          data: x.values.map((v, i) => (stackPct ? (totals[i] ? Math.round((v / totals[i]) * 1000) / 10 : 0) : v)),
          itemStyle: { color: x.c.color, borderColor: t.surface, borderWidth: 1, borderRadius: si === seriesData.length - 1 ? [4, 4, 0, 0] : 0 },
          emphasis: { focus: 'series' },
        })),
      }));
    }

    // Calendario de calor (una sola tonalidad)
    if (d.daily.length) {
      const max = Math.max(...d.daily.map((x) => x.total));
      const p90 = d.daily.map((x) => x.total).sort((a, b) => a - b)[Math.floor(d.daily.length * 0.92)] || max;
      mountChart($('#c-heat', ctx.el), (t) => ({
        tooltip: { ...tipBox(t), formatter: (p) => tipHTML(fmtDateLong(p.value[0]), [{ color: t.series[0], value: money(p.value[1]), label: `${p.value[2]} movimientos`, box: true }]) },
        visualMap: {
          show: false, min: 0, max: p90, dimension: 1, inRange: { color: t.dark ? ['#16244a', '#1c4a8f', '#3987e5', '#9ec5f4'] : ['#e3eefc', '#9ec5f4', '#3987e5', '#184f95'] },
        },
        calendar: {
          range: [d.from, d.to], top: 26, left: 34, right: 8, bottom: 4, cellSize: ['auto', 'auto'],
          splitLine: { show: false }, itemStyle: { borderColor: t.surface, borderWidth: 3, color: t.surface3 },
          yearLabel: { show: false },
          dayLabel: { firstDay: 1, nameMap: ['D', 'L', 'M', 'X', 'J', 'V', 'S'], color: t.ink3, fontFamily: t.font, fontSize: 11 },
          monthLabel: { nameMap: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'], color: t.ink3, fontFamily: t.font, fontSize: 11 },
        },
        series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: d.daily.map((x) => [x.date, x.total, x.n]), itemStyle: { borderRadius: 3 } }],
      }));
    }

    // Día de la semana
    mountChart($('#c-wd', ctx.el), (t) => ({
      grid: grid({ top: 8 }),
      tooltip: { ...tipBox(t), trigger: 'item', formatter: (p) => tipHTML(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'][p.dataIndex], [{ color: t.series[0], value: money(p.value), label: 'de media', box: true }]) },
      xAxis: catAxis(t, ['L', 'M', 'X', 'J', 'V', 'S', 'D']),
      yAxis: valAxis(t, { splitNumber: 3 }),
      series: [{ type: 'bar', data: d.weekday.map((w) => w.avg), barMaxWidth: 26, itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] } }],
    }));

    // Año contra año
    const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const curY = Number(today().slice(0, 4));
    const lastIdx = d.yoy.year === curY ? Number(today().slice(5, 7)) : 12;
    mountChart($('#c-yoy', ctx.el), (t) => ({
      grid: grid({ top: 10 }),
      tooltip: {
        ...tipBox(t), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: t.axis } },
        formatter: (ps) => tipHTML(MONTHS[ps[0].dataIndex], ps.filter((p) => p.value != null).map((p) => ({ color: p.color, value: money(p.value, { decimals: 0 }), label: p.seriesName }))),
      },
      xAxis: catAxis(t, MONTHS, { boundaryGap: false }),
      yAxis: valAxis(t, { splitNumber: 3 }),
      series: [
        { name: String(d.yoy.year - 1), type: 'line', data: d.yoy.previous, showSymbol: false, symbol: 'circle', symbolSize: 7, lineStyle: { width: 2, color: t.muted }, itemStyle: { color: t.muted } },
        {
          name: String(d.yoy.year), type: 'line', data: d.yoy.current.map((v, i) => (i < lastIdx ? v : null)), showSymbol: false, symbol: 'circle', symbolSize: 8,
          lineStyle: { width: 2.5, color: t.series[0] }, itemStyle: { color: t.series[0], borderColor: t.surface, borderWidth: 2 }, areaStyle: { color: t.series[0], opacity: 0.08 },
        },
      ],
    }));
  }

  on(ctx.el, 'click', '[data-preset]', (e, b) => {
    preset = b.dataset.preset;
    [from, to] = presetRange(preset);
    history.replaceState(null, '', `#/analisis?p=${preset}`);
    load();
  });
  on(ctx.el, 'click', '[data-act=custom]', () => {
    const s = sheet({
      title: 'Elegir periodo',
      size: 'narrow',
      body: html`<form class="form" id="an-r"><div class="grid-2 keep">
        <div class="field"><label for="an-f">Desde</label><input class="input" type="date" id="an-f" value="${from}"></div>
        <div class="field"><label for="an-t">Hasta</label><input class="input" type="date" id="an-t" value="${to}"></div></div></form>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" form="an-r">Aplicar</button>`,
    });
    $('#an-r', s.el).addEventListener('submit', (e) => {
      e.preventDefault();
      from = $('#an-f', s.el).value;
      to = $('#an-t', s.el).value;
      preset = 'custom';
      s.close();
      load();
    });
  });
  on(ctx.el, 'click', '[data-table]', (e, b) => {
    const k = b.dataset.table;
    if (tables.has(k)) tables.delete(k);
    else tables.add(k);
    draw();
  });
  on(ctx.el, 'click', '[data-stack] [data-v]', (e, b) => {
    stackPct = b.dataset.v === '1';
    draw();
  });
  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
}

