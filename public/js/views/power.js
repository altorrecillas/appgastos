// Consumo de luz: precio por horas, electrodomésticos, usos y previsión de la factura.
import { del, get, patch, post } from '../api.js';
import {
  $, confirmDialog, fmtDate, fmtDateLong, focusLater, html, icon, money, num, on, pct, sheet, today, toast, toastError,
  withBusy, skeletonPage,
} from '../ui.js';
import { can, categories } from '../store.js';
import { bindDateQuick, bindPickers, chipPicker, dateQuick, emojiPicker, notifyChange, readForm, showFormError } from '../forms.js';
import { axisLabel, grid, mountChart, tipBox, tipHTML } from '../charts.js';
import { haptic } from '../gestures.js';

export const PRESETS = [
  ['Lavadora', '🧺', 2000, 90, 0.9], ['Lavavajillas', '🍽️', 1800, 120, 1.05], ['Secadora', '🌀', 2500, 60, null], ['Horno', '♨️', 2200, 45, null],
  ['Vitrocerámica', '🍳', 1800, 30, null], ['Microondas', '📡', 900, 5, null], ['Termo eléctrico', '🚿', 1500, 90, null],
  ['Aire acondicionado', '❄️', 1200, 120, null], ['Calefactor', '🔥', 2000, 60, null], ['Plancha', '👔', 2200, 30, null],
  ['Freidora de aire', '🍟', 1500, 20, null], ['Cafetera', '☕', 1000, 5, null], ['Televisión', '📺', 100, 180, null],
  ['Ordenador', '💻', 150, 240, null], ['Coche eléctrico', '🚗', 7400, 180, null], ['Bomba de calor', '♻️', 1500, 120, null],
];
const DURATIONS = [[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 h'], [90, '1 h 30'], [120, '2 h'], [180, '3 h']];
const fmtMin = (m) => (!m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const kwhTxt = (k) => `${num(k, 2)} kWh`;
const kwhPrice = (p) => `${money(p * 100, { decimals: 3 })}/kWh`;
const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;

// Coste (en céntimos) de un consumo repartido por horas, igual que en el servidor.
export function costAt(prices, startMin, minutes, kwh) {
  let t = startMin;
  let left = minutes;
  let euros = 0;
  while (left > 0) {
    const inHour = Math.min(60 - (t % 60), left);
    euros += ((kwh * inHour) / minutes) * prices[Math.floor(t / 60) % 24];
    t += inHour;
    left -= inHour;
  }
  return Math.round(euros * 100);
}

// Mejor hora en punto para empezar entre ahora y el final de los precios conocidos (hoy y, si está, mañana).
function bestStart(px, minutes, kwh) {
  const now = new Date();
  const fromH = now.getHours() + (now.getMinutes() > 0 ? 1 : 0);
  const days = [{ date: px.today.date, prices: px.today.prices }];
  if (px.tomorrow) days.push({ date: px.tomorrow.date, prices: px.tomorrow.prices });
  const series = days.flatMap((d) => d.prices);
  let best = null;
  for (let h = fromH; h + Math.ceil(minutes / 60) <= series.length; h++) {
    const c = costAt(series, h * 60, minutes, kwh);
    if (!best || c < best.cost) best = { h, cost: c, day: h >= 24 ? 'mañana' : 'hoy' };
  }
  return best;
}

export default async function powerView(ctx) {
  let px = null;
  let sum = null;
  let appliances = [];
  let usages = [];
  let day = 'today';
  let allDays = false;

  ctx.setHeader('Consumo de luz', 'Precio por horas y gasto estimado de la factura', html`
    <button class="btn ghost" data-act="tariff">${icon('settings')}<span class="desktop-only">Tarifa</span></button>
    ${can('edit') ? html`<button class="btn primary" data-act="use">${icon('plus')}<span class="desktop-only">Anotar uso</span></button>` : ''}`);

  async function load() {
    try {
      [px, sum, appliances, usages] = await Promise.all([get('/power/prices'), get('/power/summary'), get('/power/appliances'), get('/power/usages')]);
      if (ctx.isCurrent()) draw();
    } catch (e) {
      toastError(e);
    }
  }

  const levelOf = (prices, p) => {
    const sorted = [...prices].sort((a, b) => a - b);
    if (p <= sorted[7]) return 'cheap';
    if (p >= sorted[16]) return 'dear';
    return 'mid';
  };
  const LEVEL = { cheap: ['Barata', 'paid'], mid: ['Media', 'pending'], dear: ['Cara', 'overdue'] };

  function draw() {
    const P = day === 'tomorrow' && px.tomorrow ? px.tomorrow : px.today;
    const nowH = new Date().getHours();
    const isToday = P.date === today();
    const cur = P.prices[nowH];
    const lvl = levelOf(P.prices, isToday ? cur : P.avg);
    const top = appliances.filter((a) => !a.archived).sort((a, b) => b.uses - a.uses)[0];
    const sourceTxt = { pvpc: 'Precio regulado (PVPC) de Red Eléctrica', fixed: 'Tu tarifa de precio fijo', periods: 'Tu tarifa por tramos (punta, llano y valle)', estimate: 'Estimado: aún no hay precios publicados de este día' }[P.source];
    ctx.el.innerHTML = String(html`<div class="stack" style="gap:18px">
      <section class="panel">
        <div class="panel-head"><h2>Precio de la luz</h2>
          ${px.tomorrow ? html`<div class="actions segmented" data-day><button data-v="today" aria-pressed="${day === 'today'}">Hoy</button><button data-v="tomorrow" aria-pressed="${day === 'tomorrow'}">Mañana</button></div>` : ''}</div>
        <div class="power-top">
          <div class="stack" style="gap:6px">
            <div class="small muted">${isToday ? `Ahora (${hh(nowH)}–${hh(nowH + 1)})` : `Media de ${fmtDateLong(P.date).toLowerCase()}`}</div>
            <div class="row" style="gap:10px;align-items:baseline"><span class="power-now">${money((isToday ? cur : P.avg) * 100, { decimals: 3 })}</span><span class="muted">/kWh</span>
              <span class="pill ${LEVEL[lvl][1]}">${LEVEL[lvl][0]}</span></div>
            <div class="small ink-2">Más barata: <b>${hh(P.min.h)}</b> (${kwhPrice(P.min.p)}) · Más cara: <b>${hh(P.max.h)}</b> (${kwhPrice(P.max.p)})</div>
            <div class="tiny muted">${sourceTxt}${sum.settings.taxes ? `, con IVA del ${sum.settings.vat} % e impuesto eléctrico` : ', sin impuestos'}. No incluye el término de potencia.</div>
          </div>
          ${top ? (() => {
            const kwh = top.kwh_per_use || (top.watts * top.minutes) / 60000;
            const best = bestStart(px, top.minutes, kwh);
            const nowCost = costAt(px.today.prices, nowH * 60 + new Date().getMinutes(), top.minutes, kwh);
            if (!best) return '';
            const same = nowCost - best.cost < 2;
            return html`<div class="power-tip">${icon('sparkles', 'sm')}<span>${same
              ? html`<b>${top.icon} ${top.name}</b> (${fmtMin(top.minutes)}): ahora es buen momento, ${money(nowCost)}.`
              : html`Mejor momento para <b>${top.icon} ${top.name}</b> (${fmtMin(top.minutes)}): ${best.day} a las <b>${hh(best.h)}</b>, ${money(best.cost)}.
                Ahora costaría ${money(nowCost)} (${money(nowCost - best.cost)} más).`}</span></div>`;
          })() : ''}
        </div>
        <div class="chart-legend" style="margin-top:12px"><span><i style="--c:#0b7a5c"></i>Barata</span><span><i style="--c:#d39a00"></i>Media</span><span><i style="--c:#c62f3d"></i>Cara</span></div>
        <div class="chart short" id="pw-chart" role="img" aria-label="Precio de la luz por horas"></div>
      </section>

      ${estimatePanel()}

      <section class="panel"><div class="panel-head"><h2>Electrodomésticos</h2><span class="sub">toca uno para anotar que lo has usado</span>
        <div class="actions"><a class="btn ghost sm" href="#/enchufes" aria-label="Enchufes de Home Assistant">${icon('house-plug', 'sm')}<span class="desktop-only">Enchufes</span></a>
          ${can('edit') ? html`<button class="btn ghost sm" data-act="add-appliance" aria-label="Añadir electrodoméstico">${icon('plus', 'sm')}<span class="desktop-only">Añadir</span></button>` : ''}</div></div>
        ${appliances.filter((a) => !a.archived).length ? html`<div class="appl-grid">${appliances.filter((a) => !a.archived).map((a) => {
          const kwh = a.kwh_per_use || (a.watts * a.minutes) / 60000;
          const nowCost = costAt(px.today.prices, nowH * 60, a.minutes, kwh);
          return html`<button class="appl" data-appl="${a.id}">
            <span class="emoji">${a.icon}</span><b>${a.name}</b>
            <span class="tiny muted">${num(a.watts / 1000, 1)} kW · ${fmtMin(a.minutes)}</span>
            ${a.ha_linked ? html`<span class="ha-tag">${icon('plug')}Lo mide Home Assistant</span>` : html`<span class="tiny">${money(nowCost)} ahora</span>`}
            ${can('edit') ? html`<span class="appl-edit" data-edit-appl="${a.id}" role="button" aria-label="Editar ${a.name}">${icon('pencil', 'sm')}</span>` : ''}
          </button>`;
        })}</div>`
        : html`<div class="empty" style="padding:22px"><div class="art">🔌</div><p>Añade los electrodomésticos que más gastan (lavadora, horno, secadora…) y anota cuándo los usas.</p>
          ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="add-appliance">${icon('plus')}Añadir electrodoméstico</button></div>` : ''}</div>`}
      </section>

      <section class="panel"><div class="panel-head"><h2>Usos anotados</h2><span class="sub">últimos 31 días</span></div>
        ${usagesList()}
      </section>
    </div>`);
    drawChart(P);
  }

  function estimatePanel() {
    const s = sum;
    const ratio = s.predicted ? Math.min(s.estimated / s.predicted, 1) : null;
    return html`<section class="panel" style="border-color:var(--cobalt-line)">
      <div class="panel-head"><h2>Factura de la luz en curso</h2><span class="sub">desde el ${fmtDate(s.from)} (${s.days} ${s.days === 1 ? 'día' : 'días'})</span></div>
      <div class="power-est">
        <div><div class="small muted">Estimado hasta hoy</div><div class="big">${money(s.estimated)}</div>
          <div class="tiny muted">${kwhTxt(s.kwh)}${s.usages ? `, ${s.usages} usos` : ''}${s.settings.base_kwh ? ` + base ${num(s.settings.base_kwh, 1)} kWh/día` : ''}</div></div>
        <div><div class="small muted">A este ritmo, en ${s.periodDays} días</div><div class="big">${money(s.projected)}</div><div class="tiny muted">de lo que se puede medir</div></div>
        <div><div class="small muted">Previsión de la factura</div>
          <div class="big">${s.predicted ? money(s.predicted, { decimals: 0 }) : s.avgBill ? `≈ ${money(s.avgBill, { decimals: 0 })}` : '—'}</div>
          <div class="tiny muted">${s.predicted ? `lo anotado suele ser el ${pct(s.coverage)} de tus facturas` : s.avgBill ? 'media de tus últimas facturas' : 'registra tus facturas de la luz para afinarla'}</div></div>
      </div>
      ${ratio !== null ? html`<div class="meter thick" style="--c:var(--cobalt);margin-top:14px"><div class="fill" style="width:${ratio * 100}%"></div></div>` : ''}
      <p class="small ink-2" style="margin-top:12px">${icon('info', 'sm')} Cada día se suma a tus gastos como «Consumo de luz (estimado)». Cuando registres la factura de la luz, lo estimado
        en su periodo queda dentro de ella y solo se añade la diferencia (luces, stand-by, potencia…), así que no se cuenta dos veces.</p>
    </section>`;
  }

  function usagesList() {
    if (!usages.length) return html`<p class="small muted">Todavía no has anotado ningún uso. Toca un electrodoméstico para empezar.</p>`;
    const days = [];
    for (const u of usages) {
      let d = days.at(-1);
      if (!d || d.date !== u.date) days.push((d = { date: u.date, items: [], total: 0 }));
      d.items.push(u);
      if (!u.superseded_by) d.total += u.cost;
    }
    const shown = allDays ? days : days.slice(0, 7);
    return html`${shown.map((d) => html`<div class="day-head" style="position:static;padding:12px 0 4px"><span class="d">${d.date === today() ? 'Hoy' : fmtDateLong(d.date)}</span><span class="t">${money(d.total)}</span></div>
      <div class="rows">${d.items.map((u) => {
        const ha = u.source === 'ha';
        const when = ha ? (u.start_time ? (u.running ? `desde las ${u.start_time}` : `de ${u.start_time} a ${u.end_time}`) : u.running ? 'en lo que va de día' : 'todo el día')
          : u.start_time ? `a las ${u.start_time}` : 'sin hora';
        return html`<div class="rowi dense">
        <span class="cat-dot sm"><span class="emoji">${u.icon || '🔌'}</span></span>
        <span class="main-txt"><span class="title">${u.name}</span>
          <span class="meta">${[when, ha && !u.start_time ? '' : fmtMin(u.minutes), kwhTxt(u.kwh), u.price_avg ? kwhPrice(u.price_avg) : ''].filter(Boolean).join(' · ')}</span></span>
        ${u.superseded_by ? html`<span class="pill plain" title="Home Assistant midió este aparato ese día: cuenta lo medido, no lo anotado">Sustituido por lo medido</span>`
          : u.billed ? html`<span class="pill paid">En factura</span>` : ha ? html`<a class="pill info" href="#/enchufes" title="Medido por Home Assistant">${icon(u.running ? 'activity' : 'plug')}${u.running ? 'En marcha' : 'Medido'}</a>` : ''}
        <span class="amount ${u.superseded_by ? 'void' : ''}">${money(u.cost)}</span>
        ${can('edit') && !u.billed && !ha ? html`<button class="btn ghost sm icon-only" data-del-use="${u.id}" aria-label="Quitar">${icon('x', 'sm')}</button>` : ''}
      </div>`;
      })}</div>`)}
      ${days.length > 7 ? html`<div class="row" style="justify-content:center;margin-top:12px"><button class="btn sm" data-act="all-days">${allDays ? 'Ver solo los últimos 7 días' : `Ver los ${days.length} días`}</button></div>` : ''}`;
  }

  function drawChart(P) {
    const nowH = new Date().getHours();
    const isToday = P.date === today();
    mountChart($('#pw-chart', ctx.el), (t) => ({
      animationDuration: 500,
      grid: grid({ top: 8 }),
      tooltip: {
        ...tipBox(t), trigger: 'item',
        formatter: (p) => tipHTML(`${hh(p.dataIndex)}–${hh(p.dataIndex + 1)}${P.periods ? ` · ${P.periods[p.dataIndex]}` : ''}`, [{ color: p.color, value: kwhPrice(p.value), label: '', box: true }]),
      },
      xAxis: { type: 'category', data: P.prices.map((_, h) => h), axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false },
        axisLabel: axisLabel(t, { interval: (i) => i % 3 === 0, formatter: (v) => `${v} h` }) },
      yAxis: { type: 'value', splitNumber: 3, splitLine: { lineStyle: { color: t.grid } }, axisLabel: axisLabel(t, { formatter: (v) => `${num(v, 2)} €` }) },
      series: [{
        type: 'bar', barMaxWidth: 18,
        data: P.prices.map((p, h) => {
          const l = levelOf(P.prices, p);
          return {
            value: p,
            itemStyle: {
              color: l === 'cheap' ? '#0b7a5c' : l === 'mid' ? '#d39a00' : '#c62f3d', borderRadius: [4, 4, 0, 0],
              opacity: isToday && h < nowH ? 0.35 : 1, borderColor: isToday && h === nowH ? t.ink : 'transparent', borderWidth: isToday && h === nowH ? 2 : 0,
            },
          };
        }),
      }],
    }));
  }

  // ---------- Anotar un uso ----------
  async function useSheet(appl = null) {
    if (!can('edit')) return;
    const now = new Date();
    const d = {
      mode: appl?.kwh_per_use ? 'kwh' : 'time',
      minutes: appl?.minutes || 60,
      kwh: appl?.kwh_per_use || null,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    };
    const s = sheet({
      title: appl ? `${appl.icon} ${appl.name}` : 'Anotar uso de la luz',
      body: html`<form class="form" id="uf" autocomplete="off">
        ${appl?.ha_linked ? html`<div class="ha-alert info">${icon('plug', 'sm')}<span>Home Assistant ya mide ${appl.name} y anota cada uso solo.
          Si lo anotas también aquí, ese uso se contará dos veces.</span></div>` : ''}
        ${!appl ? html`<div class="grid-2 keep">
          <div class="field"><label for="uf-n">¿Qué has encendido?</label><input class="input" id="uf-n" name="name" maxlength="40" placeholder="Estufa, deshumidificador…"></div>
          <div class="field"><label for="uf-w">Potencia</label><div class="input-group"><input class="input" id="uf-w" name="watts" inputmode="numeric" placeholder="1000" style="padding-left:13px"><span class="suffix">W</span></div></div></div>
          ${appliances.length ? html`<div class="chips">${appliances.filter((a) => !a.archived).map((a) => html`<button type="button" class="chip sm" data-pickappl="${a.id}">${a.icon} ${a.name}</button>`)}</div>` : ''}` : ''}
        <div class="segmented block" data-mode><button type="button" data-v="time" aria-pressed="${d.mode === 'time'}">Por tiempo</button>
          <button type="button" data-v="kwh" aria-pressed="${d.mode === 'kwh'}">Por consumo (kWh)</button></div>
        ${dateQuick('date', today(), { label: 'Día' })}
        <div class="field"><label for="uf-t">Hora de inicio</label><div class="row" style="gap:8px">
          <input class="input" type="time" id="uf-t" name="start_time" value="${d.time}" style="width:140px">
          <button type="button" class="btn sm" data-now>Ahora</button><button type="button" class="btn sm ghost" data-best hidden></button></div></div>
        <div class="field"><label data-dur-label>Duración</label>
          <div class="chips" data-dur>${DURATIONS.map(([m, l]) => html`<button type="button" class="chip sm" data-m="${m}" aria-pressed="${m === d.minutes}">${l}</button>`)}</div>
          <div class="input-group" style="max-width:180px;margin-top:6px"><input class="input" name="minutes" inputmode="numeric" value="${d.minutes}" style="padding-left:13px" aria-label="Minutos"><span class="suffix">min</span></div></div>
        <div class="field" data-kwh-only><label for="uf-k">Consumo</label>
          <div class="input-group" style="max-width:200px"><input class="input" id="uf-k" name="kwh" inputmode="decimal" value="${d.kwh ? String(d.kwh).replace('.', ',') : ''}" style="padding-left:13px" placeholder="0,9"><span class="suffix">kWh</span></div>
          <span class="hint">${appl?.kwh_per_use ? `Consumo por uso de ${appl.name}: ${num(appl.kwh_per_use, 2)} kWh. ` : ''}Lo indica la etiqueta energética, el contador o la app del aparato.</span></div>
        <div class="power-preview" data-preview></div>
      </form>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">${icon('zap')}Anotar</button>`,
    });
    const f = $('#uf', s.el);
    bindDateQuick(f);
    let current = appl;
    const mode = () => f.querySelector('[data-mode] [aria-pressed=true]').dataset.v;
    const values = () => {
      const v = readForm(f);
      const minutes = Number(v.minutes) || 0;
      const watts = current ? current.watts : Number(v.watts) || 0;
      const kwh = mode() === 'kwh' ? Number(String(v.kwh).replace(',', '.')) || 0 : (watts * minutes) / 60000;
      const [h, m] = (v.start_time || '00:00').split(':').map(Number);
      return { v, minutes: minutes || current?.minutes || 60, kwh, start: h * 60 + (m || 0) };
    };
    const update = () => {
      const m = mode();
      f.querySelector('[data-kwh-only]').hidden = m !== 'kwh';
      f.querySelector('[data-dur-label]').textContent = m === 'kwh' ? 'Duración (para repartir el coste por horas)' : 'Duración';
      const { v, minutes, kwh, start } = values();
      const prices = v.date === today() ? px.today.prices : px.tomorrow && v.date === px.tomorrow.date ? px.tomorrow.prices : null;
      const box = $('[data-preview]', f);
      const best = $('[data-best]', f);
      if (!(kwh > 0)) {
        box.innerHTML = String(html`<span class="muted small">Indica la duración${current ? '' : ' y la potencia'} o el consumo para ver lo que cuesta.</span>`);
        best.hidden = true;
        return;
      }
      if (!prices) {
        box.innerHTML = String(html`<b>${kwhTxt(kwh)}</b> <span class="muted small">El coste se calcula con el precio de ese día al guardar.</span>`);
        best.hidden = true;
        return;
      }
      const cost = costAt(prices, start, minutes, kwh);
      box.innerHTML = String(html`<div class="row between wrap"><span><b style="font-size:calc(22px * var(--fs))">${money(cost)}</b> <span class="muted small">por ${kwhTxt(kwh)}</span></span>
        <span class="small muted">${kwhPrice(cost / 100 / kwh)} de media</span></div>`);
      const b = v.date === today() ? bestStart(px, minutes, kwh) : null;
      if (b && b.cost < cost * 0.9 && b.day === 'hoy') {
        best.hidden = false;
        best.dataset.h = b.h;
        best.textContent = `Más barato a las ${hh(b.h)}: ${money(b.cost)}`;
      } else best.hidden = true;
    };
    on(f, 'click', '[data-mode] [data-v]', (e, b) => {
      f.querySelectorAll('[data-mode] [data-v]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      update();
    });
    on(f, 'click', '[data-dur] [data-m]', (e, b) => {
      f.querySelectorAll('[data-dur] [data-m]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      f.elements.minutes.value = b.dataset.m;
      update();
    });
    on(f, 'click', '[data-now]', () => {
      const n = new Date();
      $('#uf-t', f).value = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
      update();
    });
    on(f, 'click', '[data-best]', (e, b) => {
      $('#uf-t', f).value = hh(Number(b.dataset.h));
      update();
    });
    on(f, 'click', '[data-pickappl]', (e, b) => {
      current = appliances.find((a) => a.id === Number(b.dataset.pickappl));
      f.querySelectorAll('[data-pickappl]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      f.elements.minutes.value = current.minutes;
      if (current.kwh_per_use) {
        $('#uf-k', f).value = String(current.kwh_per_use).replace('.', ',');
        f.querySelector('[data-mode] [data-v=kwh]').click();
      } else f.querySelector('[data-mode] [data-v=time]').click();
      update();
    });
    on(f, 'input', 'input', update);
    on(f, 'change', 'input', update);
    on(s.el, 'click', '[data-act=save]', (e, btn) => withBusy(btn, async () => {
      const { v, minutes, kwh } = values();
      if (!current && !v.name?.trim()) return showFormError(f, 'Indica qué has encendido o elige un electrodoméstico');
      if (!(kwh > 0)) return showFormError(f, mode() === 'kwh' ? 'Escribe el consumo en kWh' : 'Indica la duración y la potencia');
      try {
        const r = await post('/power/usages', {
          appliance_id: current?.id ?? null, name: current ? undefined : v.name.trim(), date: v.date, start_time: v.start_time || null,
          minutes, kwh: mode() === 'kwh' || !current ? kwh : undefined, watts: current ? undefined : Number(v.watts) || undefined,
        });
        notifyChange('power');
        haptic(12);
        toast(`${current?.name || v.name}: ${money(r.usage.cost)} sumados al consumo de luz de ${v.date === today() ? 'hoy' : fmtDate(v.date)}${r.billed ? ' (ese día ya está en una factura)' : ''}`);
        s.close(true);
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    update();
    if (!appl) focusLater($('#uf-n', f), 120);
  }

  // ---------- Electrodomésticos ----------
  function applianceForm(a = null, preset = null) {
    const d = a || (preset ? { name: preset[0], icon: preset[1], watts: preset[2], minutes: preset[3], kwh_per_use: preset[4] } : { name: '', icon: '🔌', watts: 1000, minutes: 60, kwh_per_use: null });
    const s = sheet({
      title: a ? `Editar ${a.name}` : 'Añadir electrodoméstico',
      body: html`<form class="form" id="af" autocomplete="off">
        ${!a ? html`<div class="field"><span class="label">Elige uno o crea el tuyo</span><div class="chips">${PRESETS.map((p, i) => html`<button type="button" class="chip sm" data-preset="${i}">${p[1]} ${p[0]}</button>`)}</div></div>` : ''}
        <div class="field"><label for="af-n">Nombre</label><input class="input" id="af-n" name="name" value="${d.name}" maxlength="40" required></div>
        <div class="grid-3">
          <div class="field"><label for="af-w">Potencia</label><div class="input-group"><input class="input" id="af-w" name="watts" inputmode="numeric" value="${d.watts}" style="padding-left:13px"><span class="suffix">W</span></div></div>
          <div class="field"><label for="af-m">Uso habitual</label><div class="input-group"><input class="input" id="af-m" name="minutes" inputmode="numeric" value="${d.minutes}" style="padding-left:13px"><span class="suffix">min</span></div></div>
          <div class="field"><label for="af-k">Consumo por uso <span class="muted">(opcional)</span></label><div class="input-group"><input class="input" id="af-k" name="kwh_per_use" inputmode="decimal" value="${d.kwh_per_use ? String(d.kwh_per_use).replace('.', ',') : ''}" style="padding-left:13px" placeholder="0,9"><span class="suffix">kWh</span></div></div>
        </div>
        <p class="small muted">La potencia viene en la placa del aparato. Si sabes cuánto gasta cada uso (etiqueta energética: kWh por ciclo), es más exacto: la lavadora o el lavavajillas no están a plena potencia todo el ciclo.</p>
        <div class="field"><label>Icono</label>${emojiPicker('icon', d.icon, ['🔌', '🧺', '🍽️', '🌀', '♨️', '🍳', '📡', '🚿', '❄️', '🔥', '👔', '🍟', '☕', '📺', '💻', '🚗', '♻️', '💡', '🧊', '🎮'])}</div>
      </form>`,
      foot: html`${a ? html`<button class="btn danger icon-only" data-act="del" aria-label="Borrar">${icon('trash-2')}</button>` : ''}<span class="spacer"></span>
        <button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const f = $('#af', s.el);
    bindPickers(f);
    on(f, 'click', '[data-preset]', (e, b) => {
      const p = PRESETS[Number(b.dataset.preset)];
      f.elements.name.value = p[0];
      f.elements.watts.value = p[2];
      f.elements.minutes.value = p[3];
      f.elements.kwh_per_use.value = p[4] ? String(p[4]).replace('.', ',') : '';
      const ib = f.querySelector(`[data-pick=icon] [data-v="${p[1]}"]`);
      if (ib) ib.click();
    });
    on(s.el, 'click', '[data-act=save]', (e, btn) => withBusy(btn, async () => {
      const v = readForm(f);
      const payload = {
        name: v.name.trim(), icon: v.icon, watts: Number(v.watts), minutes: Number(v.minutes) || 60,
        kwh_per_use: v.kwh_per_use ? Number(String(v.kwh_per_use).replace(',', '.')) : null,
      };
      if (!payload.name) return showFormError(f, 'Escribe el nombre');
      if (!(payload.watts > 0)) return showFormError(f, 'Indica la potencia en vatios');
      try {
        if (a) await patch(`/power/appliances/${a.id}`, payload);
        else await post('/power/appliances', payload);
        notifyChange('power');
        s.close(true);
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=del]', async () => {
      if (!(await confirmDialog({ title: `¿Borrar ${a.name}?`, text: 'Los usos ya anotados se conservan.', confirm: 'Borrar', danger: true }))) return;
      await del(`/power/appliances/${a.id}`).catch(toastError);
      notifyChange('power');
      s.close();
    });
  }

  // ---------- Tarifa ----------
  function tariffSheet() {
    const st = sum.settings;
    const cats = categories('expense');
    const s = sheet({
      title: 'Tarifa de la luz',
      body: html`<form class="form" id="tf">
        <div class="field"><label>¿Qué tarifa tienes?</label>${chipPicker('tariff', [
          { value: 'pvpc', label: 'Precio regulado (PVPC)' }, { value: 'fixed', label: 'Precio fijo' }, { value: 'periods', label: 'Por tramos' },
        ], st.tariff, { optional: false })}</div>
        <div data-fixed class="field" style="max-width:240px"><label for="tf-p">Precio del kWh (sin impuestos)</label>
          <div class="input-group"><input class="input" id="tf-p" name="price" inputmode="decimal" value="${String(st.price).replace('.', ',')}" style="padding-left:13px"><span class="suffix">€/kWh</span></div></div>
        <div data-periods class="grid-3">${['punta', 'llano', 'valle'].map((k) => html`<div class="field"><label>${k[0].toUpperCase() + k.slice(1)}</label>
          <div class="input-group"><input class="input" name="p_${k}" inputmode="decimal" value="${String(st.periods[k]).replace('.', ',')}" style="padding-left:13px"><span class="suffix">€/kWh</span></div></div>`)}</div>
        <p data-periods class="small muted">Tramos de la tarifa 2.0TD: punta de 10 a 14 h y de 18 a 22 h; llano de 8 a 10, de 14 a 18 y de 22 a 24 h; valle de 0 a 8 h y todo el fin de semana.</p>
        <p data-pvpc class="small muted">El precio de cada hora se descarga cada día de Red Eléctrica (el de mañana, a partir de las 20:30).</p>
        <label class="switch"><input type="checkbox" name="taxes" ${st.taxes ? 'checked' : ''}><span class="track"></span><span class="txt">Sumar impuestos<small>Impuesto eléctrico (5,11 %) e IVA.</small></span></label>
        <div class="field" style="max-width:160px"><label for="tf-v">IVA</label><div class="input-group"><input class="input" id="tf-v" name="vat" inputmode="decimal" value="${st.vat}" style="padding-left:13px"><span class="suffix">%</span></div></div>
        <div class="field" style="max-width:280px"><label for="tf-b">Consumo base diario</label>
          <div class="input-group"><input class="input" id="tf-b" name="base_kwh" inputmode="decimal" value="${String(st.base_kwh || '').replace('.', ',')}" placeholder="0" style="padding-left:13px"><span class="suffix">kWh/día</span></div>
          <span class="hint">Lo que gasta la casa sin que lo anotes: nevera, router, stand-by… (suele rondar 2–3 kWh al día). Se suma cada día.</span></div>
        <div class="field"><label for="tf-c">Categoría del gasto</label><select class="select" id="tf-c" name="category_id">${cats.map((c) => html`<option value="${c.id}" ${c.id === st.category_id ? 'selected' : ''}>${c.icon} ${c.name}</option>`)}</select></div>
      </form>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button>${can('admin') || can('edit') ? html`<button class="btn primary" data-act="save">Guardar</button>` : ''}`,
    });
    const f = $('#tf', s.el);
    const sync = () => {
      const t = readForm(f).tariff;
      f.querySelectorAll('[data-fixed]').forEach((x) => (x.hidden = t !== 'fixed'));
      f.querySelectorAll('[data-periods]').forEach((x) => (x.hidden = t !== 'periods'));
      f.querySelectorAll('[data-pvpc]').forEach((x) => (x.hidden = t !== 'pvpc'));
    };
    bindPickers(f, sync);
    sync();
    const dec = (x) => Number(String(x ?? '').replace(',', '.'));
    on(s.el, 'click', '[data-act=save]', (e, btn) => withBusy(btn, async () => {
      const v = readForm(f);
      try {
        await patch('/power/settings', {
          tariff: v.tariff, price: dec(v.price) || 0, taxes: v.taxes, vat: dec(v.vat) || 0, base_kwh: dec(v.base_kwh) || 0,
          category_id: Number(v.category_id) || null, periods: { punta: dec(v.p_punta), llano: dec(v.p_llano), valle: dec(v.p_valle) },
        });
        notifyChange('power');
        toast('Tarifa guardada. Los días sin facturar se han recalculado.');
        s.close();
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
  }

  // ---------- Eventos ----------
  const headerEl = document.getElementById('page-actions');
  ctx.onCleanup(on(headerEl, 'click', '[data-act]', (e, b) => {
    if (b.dataset.act === 'use') useSheet();
    if (b.dataset.act === 'tariff') tariffSheet();
  }));
  on(ctx.el, 'click', '[data-day] [data-v]', (e, b) => {
    day = b.dataset.v;
    draw();
  });
  on(ctx.el, 'click', '[data-appl]', (e, b) => {
    if (e.target.closest('[data-edit-appl]')) return;
    useSheet(appliances.find((a) => a.id === Number(b.dataset.appl)));
  });
  on(ctx.el, 'click', '[data-edit-appl]', (e, b) => {
    e.stopPropagation();
    applianceForm(appliances.find((a) => a.id === Number(b.dataset.editAppl)));
  });
  on(ctx.el, 'click', '[data-act=add-appliance]', () => applianceForm());
  on(ctx.el, 'click', '[data-act=all-days]', () => {
    allDays = !allDays;
    draw();
  });
  on(ctx.el, 'click', '[data-del-use]', async (e, b) => {
    try {
      const r = await del(`/power/usages/${b.dataset.delUse}`);
      notifyChange('power');
      toast(`${r.deleted.name} quitado`, { iconName: 'trash-2' });
    } catch (err) {
      toastError(err);
    }
  });

  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
  if (ctx.query.new) {
    history.replaceState(null, '', '#/luz');
    useSheet();
  }
}

