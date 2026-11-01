// Histórico de precios e inflación: cuánto ha subido lo que compráis frente al IPC oficial, por años, súper y producto.
import { get } from '../api.js';
import { html, icon, money, monthLabelFull, monthShort, num, on, toastError } from '../ui.js';
import { axisLabel, grid, mountChart, tipBox, tipHTML } from '../charts.js';

const UNIT = { kg: '/kg', l: '/l', ud: '', pack: '' };
// «+4,2 %» con signo y un decimal (la inflación se lee en décimas).
const pctS = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
const tone = (x) => (x > 0.0005 ? 'neg' : x < -0.0005 ? 'pos' : 'muted');
const monthLong = (m) => monthLabelFull(m).toLowerCase();
const ipcAt = (series, month) => series?.find((x) => x.month === month) || null;

export async function historyTab(el, { onOpenProduct } = {}) {
  let h;
  let a = null;
  let b = null;
  const load = async () => {
    try {
      h = await get(`/prices/history${a && b ? `?a=${a}&b=${b}` : ''}`);
      draw();
    } catch (e) {
      toastError(e);
    }
  };

  function draw() {
    const ipc = h.ipc;
    const food = ipc?.food?.at(-1);
    const general = ipc?.general?.at(-1);
    if (h.empty || !h.latest) {
      el.innerHTML = String(html`<div class="empty"><div class="art">📈</div><h3>Aún falta histórico</h3>
        <p>Cuando tengáis precios anotados de hace un año, aquí veréis cuánto ha subido vuestra compra, súper a súper y producto a producto,
        comparado con el IPC oficial.</p>
        ${food ? html`<p class="small">Mientras tanto: según el INE, los alimentos han subido un <b>${pctS(food.yoy / 100)}</b> en un año y el IPC general un
          <b>${pctS(general.yoy / 100)}</b> (${monthLong(food.month)}).</p>` : ''}</div>`);
      return;
    }
    const own = h.latest.yoy;
    // Comparación justa: el IPC del mismo mes (o el último publicado, que suele ir un mes por detrás).
    const fAt = ipcAt(ipc?.food, h.latest.month) || food;
    const gAt = ipcAt(ipc?.general, h.latest.month) || general;
    const bars = [
      { label: 'Vuestra compra', value: own, cls: 'own' },
      ...(fAt ? [{ label: 'Alimentos en España', value: fAt.yoy / 100, cls: 'food', note: monthShort(fAt.month) }] : []),
      ...(gAt ? [{ label: 'IPC general', value: gAt.yoy / 100, cls: 'gen', note: monthShort(gAt.month) }] : []),
    ];
    const maxAbs = Math.max(...bars.map((x) => Math.abs(x.value)), 0.01);
    const verdict = fAt ? (own < fAt.yoy / 100 - 0.002 ? 'Vuestra compra sube menos que los alimentos en España.'
      : own > fAt.yoy / 100 + 0.002 ? 'Vuestra compra sube más que los alimentos en España.' : 'Vuestra compra sube como los alimentos en España.') : '';
    const up = h.products.filter((p) => p.change > 0.005).slice(0, 5);
    const down = h.products.filter((p) => p.change < -0.005).reverse().slice(0, 5);
    const cmp = h.compare;
    // Escala común con margen: un 1,2 % frente a un 1,7 % no debe parecer el doble.
    const storeScale = Math.max(...h.stores.map((x) => Math.abs(x.yoy)), ...bars.map((x) => Math.abs(x.value)), 0.05);
    el.innerHTML = String(html`
      <section class="panel infl-hero">
        <div class="infl-main">
          <span class="small muted">Lo que compráis, en un año</span>
          <b class="infl-big ${tone(own)}">${pctS(own)}</b>
          <p class="ink-2">${monthLabelFull(h.latest.month)} frente a ${monthLong(`${Number(h.latest.month.slice(0, 4)) - 1}${h.latest.month.slice(4)}`)},
            con ${h.latest.n} precios comparables. ${verdict}</p>
          ${h.cumulative !== null && h.months.length > 13 ? html`<p class="small muted">Desde ${monthLong(h.since)}: ${pctS(h.cumulative)}.
            Lo que entonces costaba 100 € hoy cuesta ${money(Math.round(10000 * (1 + h.cumulative)))}.</p>` : ''}
        </div>
        <div class="infl-bars" role="img" aria-label="Inflación de vuestra compra frente al IPC">
          ${bars.map((x) => html`<div class="ib-row ${x.cls}"><span class="ib-l">${x.label}${x.note ? html`<small>${x.note}</small>` : ''}</span>
            <span class="ib-track"><i style="width:${(Math.abs(x.value) / maxAbs) * 100}%" class="${x.value < 0 ? 'neg' : ''}"></i></span>
            <b class="ib-v">${pctS(x.value)}</b></div>`)}
          ${ipc ? html`<p class="tiny muted">IPC: Instituto Nacional de Estadística (INE), variación anual.</p>` : html`<p class="tiny muted">Sin conexión con el INE: el IPC oficial aparecerá cuando haya internet.</p>`}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Cómo han ido los precios</h2><span class="sub">índice: ${monthLong(h.since)} = 100</span></div>
        <div class="chart-legend"><span><i class="line" style="--c:var(--cobalt)"></i>Vuestra compra</span>
          ${ipc?.food?.length ? html`<span><i class="line" style="--c:var(--saffron)"></i>Alimentos (IPC)</span>` : ''}
          ${ipc?.general?.length ? html`<span><i class="line dashed" style="--c:var(--chart-muted)"></i>IPC general</span>` : ''}</div>
        <div class="chart" data-ichart role="img" aria-label="Evolución del índice de precios de vuestra compra y del IPC"></div>
      </section>

      ${up.length || down.length ? html`<div class="grid cols-2 infl-movers">
        <section class="panel"><div class="panel-head"><h2>Lo que más ha subido</h2><span class="sub">en un año</span></div>
          ${up.length ? html`<div class="rows">${up.map((p) => moverRow(p))}</div>` : html`<p class="small muted">Nada ha subido.</p>`}</section>
        <section class="panel"><div class="panel-head"><h2>Lo que ha bajado</h2><span class="sub">en un año</span></div>
          ${down.length ? html`<div class="rows">${down.map((p) => moverRow(p))}</div>` : html`<p class="small muted">Nada ha bajado de precio.</p>`}</section>
      </div>` : ''}

      ${h.stores.length ? html`<section class="panel">
        <div class="panel-head"><h2>Por supermercado</h2><span class="sub">subida en un año de lo que compráis en cada uno</span></div>
        <div class="infl-stores">${h.stores.map((s) => html`<div class="is-row"><span class="is-n">${s.store}<small>${s.n} productos</small></span>
          <span class="is-track"><i class="${s.yoy < 0 ? 'neg' : ''}" style="width:${(Math.abs(s.yoy) / storeScale) * 100}%"></i></span>
          <b class="${tone(s.yoy)}">${pctS(s.yoy)}</b></div>`)}</div></section>` : ''}

      ${cmp ? html`<section class="panel">
        <div class="panel-head"><h2>Un año frente a otro</h2><span class="sub">precio medio anotado, en los mismos súper</span></div>
        <div class="infl-years">
          <div class="chips" data-ya>${h.years.filter((y) => y < cmp.b).map((y) => html`<button type="button" class="chip sm" data-y="${y}" aria-pressed="${y === cmp.a}">${y}</button>`)}</div>
          ${icon('chevron-right', 'sm')}
          <div class="chips" data-yb>${h.years.filter((y) => y > cmp.a).map((y) => html`<button type="button" class="chip sm" data-y="${y}" aria-pressed="${y === cmp.b}">${y}</button>`)}</div>
        </div>
        ${cmp.total !== null ? html`<p class="infl-ysum">De ${cmp.a} a ${cmp.b}, vuestra compra ha subido <b class="${tone(cmp.total)}">${pctS(cmp.total)}</b>
          <span class="muted">(${cmp.n} productos)</span>${(() => {
            const fy = yearIpc(ipc?.food, cmp.a, cmp.b);
            return fy !== null ? html`<span class="muted">. Alimentos en España: ${pctS(fy)}.</span>` : '';
          })()}</p>` : ''}
        ${cmp.products.length ? html`<div class="infl-table">
          <div class="it-head"><span>Producto</span><span>${cmp.a}</span><span>${cmp.b}</span><span>Cambio</span></div>
          ${cmp.products.map((p) => html`<button type="button" class="it-row" data-hprod="${p.id}">
            <span class="it-n">${p.name}</span><span class="it-v">${money(p.a)}${UNIT[p.base_unit] || ''}</span>
            <span class="it-v">${money(p.b)}${UNIT[p.base_unit] || ''}</span><b class="${tone(p.change)}">${pctS(p.change)}</b>
            <span class="it-ab">${money(p.a)}${UNIT[p.base_unit] || ''} → ${money(p.b)}${UNIT[p.base_unit] || ''}</span></button>`)}
        </div>` : html`<p class="small muted">No hay productos con precio en los dos años.</p>`}
      </section>` : ''}

      <details class="infl-how"><summary>${icon('info', 'sm')}¿Cómo se calcula?</summary>
        <p>Se compara cada producto consigo mismo y en el mismo supermercado (y por kilo o litro cuando se vende así), para que cambiar de tienda o de
        tamaño no parezca inflación. Las ofertas no cuentan y un precio vale hasta que se anota otro, como mucho seis meses. Lo que más compráis pesa más.
        Cuantos más precios anotéis, más fino sale.</p>
        <p>El IPC es el índice oficial del INE: «Alimentos y bebidas no alcohólicas» y el general, con su variación anual. Solo se descargan esas cifras públicas;
        vuestros datos no salen de casa.</p></details>`);
    drawChart();
  }

  const moverRow = (p) => html`<button type="button" class="rowi" data-hprod="${p.id}">
    <span class="main-txt"><span class="title">${p.name}</span>
      <span class="meta">${money(p.from)}${UNIT[p.base_unit] || ''} → ${money(p.to)}${UNIT[p.base_unit] || ''}${p.stores > 1 ? ` · ${p.stores} súper` : ''}</span></span>
    <b class="amount ${tone(p.change)}">${pctS(p.change)}</b></button>`;

  // Variación del IPC entre dos años: media anual de un año frente a la del otro.
  const yearIpc = (series, ya, yb) => {
    if (!series?.length) return null;
    const avg = (y) => {
      const v = series.filter((x) => x.month.startsWith(`${y}-`));
      return v.length ? v.reduce((s, x) => s + x.idx, 0) / v.length : null;
    };
    const va = avg(ya);
    const vb = avg(yb);
    return va && vb ? vb / va - 1 : null;
  };

  function drawChart() {
    const box = el.querySelector('[data-ichart]');
    if (!box) return;
    const months = h.months;
    // El IPC se reescala para que valga 100 en el mismo mes que el índice del hogar.
    const rebased = (series) => {
      if (!series?.length) return null;
      const by = new Map(series.map((x) => [x.month, x.idx]));
      const base = by.get(months[0]);
      return base ? months.map((m) => (by.has(m) ? Math.round((by.get(m) / base) * 1000) / 10 : null)) : null;
    };
    const food = rebased(h.ipc?.food);
    const general = rebased(h.ipc?.general);
    const label = (m) => `${monthShort(m)} ${m.slice(2, 4)}`;
    mountChart(box, (t) => {
      const series = [
        { name: 'Vuestra compra', color: t.cobalt, data: h.index.map((x) => Math.round(x * 10) / 10), width: 2.5 },
        ...(food ? [{ name: 'Alimentos (IPC)', color: t.saffron, data: food, width: 2 }] : []),
        ...(general ? [{ name: 'IPC general', color: t.muted, data: general, width: 2, dashed: true }] : []),
      ];
      return {
        grid: grid({ top: 14, right: 44 }),
        tooltip: {
          ...tipBox(t), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: t.axis } },
          formatter: (ps) => tipHTML(monthLabelFull(months[ps[0].dataIndex]), ps.filter((p) => p.value !== null && p.value !== undefined)
            .map((p) => ({ color: p.color, value: num(p.value, 1), label: p.seriesName }))),
        },
        xAxis: {
          type: 'category', data: months.map(label), boundaryGap: false, axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false },
          axisLabel: axisLabel(t, { hideOverlap: true, interval: (i) => i % 6 === 0 || i === months.length - 1 }),
        },
        yAxis: { type: 'value', scale: true, splitNumber: 4, splitLine: { lineStyle: { color: t.grid } }, axisLabel: axisLabel(t, { formatter: (v) => num(v, 0) }) },
        series: series.map((s) => ({
          name: s.name, type: 'line', data: s.data, showSymbol: false, connectNulls: true, smooth: 0.15, color: s.color,
          lineStyle: { width: s.width, color: s.color, type: s.dashed ? [5, 4] : 'solid' },
          // Solo la línea del hogar lleva su valor al final (las demás se leen en la leyenda y al tocar).
          endLabel: { show: s.name === 'Vuestra compra', color: t.cobalt, fontFamily: t.font, fontSize: 12, fontWeight: 700, formatter: (p) => num(p.value, 1) },
        })),
      };
    });
  }

  on(el, 'click', '[data-ya] [data-y]', (e, btn) => {
    a = btn.dataset.y;
    b = h.compare.b;
    load();
  });
  on(el, 'click', '[data-yb] [data-y]', (e, btn) => {
    b = btn.dataset.y;
    a = h.compare.a;
    load();
  });
  on(el, 'click', '[data-hprod]', (e, btn) => onOpenProduct?.(Number(btn.dataset.hprod)));
  el.innerHTML = '<div class="skeleton" style="height:420px"></div>';
  await load();
  return { reload: load };
}
