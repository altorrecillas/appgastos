// Home Assistant: consumo real de los enchufes inteligentes, sumado solo a «Consumo de luz».
import { del, get, patch, post, put } from '../api.js';
import {
  $, $$, addDays, debounce, fmtDateLong, focusLater, html, icon, money, num, on, relDay, sheet, timeAgo, today, toast, toastError, withBusy, skeletonPage,
} from '../ui.js';
import { can } from '../store.js';
import { bindPickers, notifyChange, readForm, showFormError } from '../forms.js';
import { axisLabel, grid, mountChart, tipBox, tipHTML } from '../charts.js';
import { PRESETS } from './power.js';
import { NAME } from '../brand.js';

const LIVE_MS = 20000;
const kwhTxt = (k, d = 2) => `${num(k, d)} kWh`;
const wattsTxt = (w) => (w === null || w === undefined ? '—' : w >= 1000 ? `${num(w / 1000, 2)} kW` : `${num(w, w < 10 ? 1 : 0)} W`);
const fmtMin = (m) => (!m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const mins = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};
const plain = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const dayName = (d) => (d === today() ? 'Hoy' : d === addDays(today(), -1) ? 'Ayer' : fmtDateLong(d));
const color = (i) => (i >= 0 && i < 8 ? `var(--chart-${i + 1})` : 'var(--chart-muted)');

// ---------- Sugerencias a partir del nombre del sensor ----------
const ICON_WORDS = [
  ['nevera', '🧊'], ['frigo', '🧊'], ['congelador', '🧊'], ['router', '📶'], ['wifi', '📶'], ['acuario', '🐠'], ['deshumidificador', '💧'],
  ['estufa', '🔥'], ['radiador', '🔥'], ['impresora', '🖨️'], ['consola', '🎮'], ['playstation', '🎮'], ['xbox', '🎮'], ['patinete', '🛴'],
  ['cargador', '🔋'], ['tele', '📺'], ['tv', '📺'], ['ordenador', '💻'], ['pc', '💻'], ['servidor', '🖥️'], ['nas', '🖥️'], ['lampara', '💡'],
  ['ventilador', '🌬️'], ['termo', '🚿'], ['lavadora', '🧺'], ['lavavajillas', '🍽️'], ['secadora', '🌀'], ['horno', '♨️'],
  ['microondas', '📡'], ['cafetera', '☕'], ['aire', '❄️'], ['bomba', '♻️'], ['coche', '🚗'], ['freidora', '🍟'], ['plancha', '👔'],
];
const PLUG_ICONS = ['🔌', '🧺', '🍽️', '🌀', '♨️', '🧊', '📺', '💻', '📶', '❄️', '🔥', '🚿', '☕', '🍟', '🎮', '💡', '🚗', '🐠', '🖨️', '🔋', '🌬️', '💧'];
const ALWAYS_ON = /nevera|frigo|congelador|router|wifi|acuario|servidor|nas\b|camara|alarma/;

export function guessName(friendly) {
  const s = String(friendly || '')
    .replace(/\b(enchufe|enchufe inteligente|smart ?plug|plug|socket|toma|energ[ií]a|energy|consumo|consumption|potencia|power|total|today|hoy|kwh|w)\b/gi, ' ')
    .replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const n = s || 'Enchufe';
  return n.charAt(0).toUpperCase() + n.slice(1);
}
function guessIcon(name) {
  const n = plain(name);
  const w = ICON_WORDS.find(([k]) => new RegExp(`\\b${k}`).test(n));
  if (w) return w[1];
  return PRESETS.find((p) => n.includes(plain(p[0]).split(' ')[0]))?.[1] || '🔌';
}
const guessMode = (name) => (ALWAYS_ON.test(plain(name)) ? 'continuous' : 'cycles');

export default async function haView(ctx) {
  let status = null;
  let links = [];
  let order = [];
  let hourly = { today: [], yesterday: [] };
  let uses = [];
  let appliances = [];
  let sensors = null;
  let live = new Map();
  let chartDay = 'today';
  let allUses = false;
  let query = '';
  const admin = can('admin');

  const header = () => {
    if (!ctx.isCurrent()) return;
    ctx.setHeader('Home Assistant', status?.configured ? `Consumo real de tus enchufes${status.location ? ` en ${status.location}` : ''}` : 'Mide el consumo real con tus enchufes inteligentes',
      status?.configured ? html`
        ${admin ? html`<button class="btn ghost" data-act="settings" aria-label="Ajustes de Home Assistant">${icon('settings')}<span class="desktop-only">Ajustes</span></button>` : ''}
        ${can('edit') ? html`<button class="btn primary" data-act="sync">${icon('refresh-cw')}<span class="desktop-only">Sincronizar</span></button>` : ''}` : '');
  };

  async function load() {
    try {
      status = await get('/ha/status');
      if (status.configured) {
        const y = addDays(today(), -1);
        const [l, ht, hy, u, a] = await Promise.all([
          get('/ha/links'), get(`/ha/hourly?date=${today()}`), get(`/ha/hourly?date=${y}`), get(`/power/usages?from=${addDays(today(), -6)}`), get('/power/appliances'),
        ]);
        links = l;
        order = [...links].sort((p, q) => p.id - q.id).map((x) => x.id);
        hourly = { today: ht, yesterday: hy };
        uses = u.filter((x) => x.source === 'ha');
        appliances = a;
      }
      if (!ctx.isCurrent()) return;
      header();
      // No se repinta mientras se escribe en un campo de la pantalla.
      const typing = document.activeElement?.matches?.('input, textarea, select') && ctx.el.contains(document.activeElement);
      if (!typing) draw();
      if (status.configured) {
        refreshLive();
        loadSensors();
      }
    } catch (e) {
      toastError(e);
    }
  }

  async function loadSensors() {
    try {
      sensors = await get('/ha/sensors');
    } catch (e) {
      sensors = { error: e.message };
    }
    const box = $('[data-discover]', ctx.el);
    if (box && ctx.isCurrent()) box.innerHTML = String(discoverBody());
  }

  // ---------- Pintado ----------
  function draw() {
    if (!status.configured) {
      ctx.el.innerHTML = String(onboarding());
      bindConnectForm($('#ha-connect', ctx.el), { focus: true });
      return;
    }
    ctx.el.innerHTML = String(html`<div class="stack" style="gap:18px">
      ${statusPanel()}
      ${board()}
      ${links.length ? chartPanel() : ''}
      ${links.length ? usesPanel() : ''}
      <section class="panel"><div class="panel-head"><h2>Enchufes en Home Assistant</h2><span class="sub">sensores de energía y potencia encontrados</span>
        <div class="actions"><button class="btn ghost sm" data-act="rescan">${icon('scan-search', 'sm')}Buscar otra vez</button></div></div>
        <div data-discover>${discoverBody()}</div>
      </section>
      ${logPanel()}
    </div>`);
    paintLive();
    if (links.length) drawChart();
  }

  function statusPanel() {
    const err = status.last_error;
    const paused = !status.enabled;
    const state = err ? 'err' : paused ? 'off' : 'on';
    return html`<section class="panel ha-status">
      <span class="ha-led ${state}" aria-hidden="true"></span>
      <div class="grow" style="min-width:0">
        <div class="ha-status-title">${err ? 'No se ha podido leer Home Assistant' : paused ? 'Sincronización en pausa' : `Conectado${status.location ? ` a ${status.location}` : ''}`}</div>
        <div class="small muted ellipsis">${[status.version ? `Home Assistant ${status.version}` : 'Home Assistant', status.url].join(' · ')}</div>
      </div>
      <div class="ha-status-meta small">
        ${status.last_ok ? html`<span>${icon('clock', 'sm')}Última lectura&nbsp;<span data-ago>${timeAgo(status.last_ok)}</span></span>` : html`<span class="muted">Sin lecturas todavía</span>`}
        <span class="muted">${paused ? 'Automática desactivada' : `Cada ${status.interval} min`}</span>
      </div>
      ${err ? html`<div class="ha-alert">${icon('triangle-alert', 'sm')}<span>${err}</span>
        ${admin ? html`<button class="btn sm" data-act="settings">Revisar conexión</button>` : ''}</div>` : ''}
      ${paused && !err && admin ? html`<div class="ha-alert info">${icon('info', 'sm')}<span>${NAME} no leerá los enchufes hasta que la reanudes. Puedes sincronizar a mano cuando quieras.</span>
        <button class="btn sm" data-act="resume">Reanudar</button></div>` : ''}
    </section>`;
  }

  // El cuadro: un módulo por enchufe con su lectura en directo.
  function board() {
    const tk = links.reduce((a, l) => a + l.today_kwh, 0);
    const tc = links.reduce((a, l) => a + l.today_cost, 0);
    const wk = links.reduce((a, l) => a + l.week_kwh, 0);
    const wc = links.reduce((a, l) => a + l.week_cost, 0);
    if (!links.length) {
      return html`<section class="ha-board empty-board">
        <div class="ha-board-head"><div><div class="ha-kicker">Ahora mismo</div><div class="ha-total">— W</div></div></div>
        <p class="ha-board-empty">${icon('plug', 'sm')} Todavía no has enlazado ningún enchufe. Elige uno de la lista de abajo:
          ${NAME} detectará cada vez que se usa y lo sumará al consumo de luz.</p>
      </section>`;
    }
    return html`<section class="ha-board" aria-label="Enchufes enlazados">
      <div class="ha-board-head">
        <div><div class="ha-kicker">Ahora mismo</div><div class="ha-total" data-total>—</div>
          <div class="ha-kicker" data-total-sub>&nbsp;</div></div>
        <dl class="ha-sums">
          <div><dt>Hoy</dt><dd>${kwhTxt(tk)}</dd><dd class="m">${money(tc)}</dd></div>
          <div><dt>Últimos 7 días</dt><dd>${kwhTxt(wk, 1)}</dd><dd class="m">${money(wc)}</dd></div>
        </dl>
      </div>
      <div class="ha-rail">${links.map((l) => module(l))}</div>
    </section>`;
  }

  function module(l) {
    const i = order.indexOf(l.id);
    const last = l.last_usage;
    const lastTxt = !last ? 'Sin usos todavía'
      : last.running ? (last.start_time ? `En marcha desde ${last.start_time}` : 'Midiendo hoy')
        : l.mode === 'continuous' ? `${relDay(last.date)}: ${kwhTxt(last.kwh)}`
          : `Último: ${relDay(last.date).toLowerCase()}${last.start_time ? `, ${last.start_time}` : ''}`;
    return html`<button class="ha-mod ${l.enabled ? '' : 'disabled'}" data-mod="${l.id}" style="--c:${color(i)}" aria-label="${l.name}: ver y ajustar">
      <span class="ha-mod-top"><span class="ha-dot" data-led></span><span class="emoji">${l.icon}</span>
        <span class="ha-mode">${l.mode === 'continuous' ? 'Todo el día' : 'Por usos'}</span></span>
      <span class="ha-mod-name ellipsis">${l.name}</span>
      <span class="ha-mod-w" data-w>${l.power_entity ? '…' : '—'}</span>
      <span class="ha-mod-sub">Hoy ${kwhTxt(l.today_kwh)} · ${money(l.today_cost)}</span>
      <span class="ha-mod-state" data-state>${l.enabled ? lastTxt : 'Desactivado'}</span>
    </button>`;
  }

  function paintLive() {
    let total = 0;
    let measured = 0;
    let on = 0;
    for (const l of links) {
      const el = $(`[data-mod="${l.id}"]`, ctx.el);
      if (!el) continue;
      const x = live.get(l.id);
      const led = $('[data-led]', el);
      const w = $('[data-w]', el);
      if (!l.enabled) {
        led.dataset.s = 'off';
        continue;
      }
      if (!x) continue;
      if (!x.available) {
        led.dataset.s = 'err';
        w.textContent = 'Sin señal';
        $('[data-state]', el).textContent = x.error || 'Home Assistant no tiene lectura de este enchufe';
        continue;
      }
      if (x.watts === null) {
        led.dataset.s = 'idle';
        w.textContent = l.power_entity ? '—' : 'Solo contador';
        continue;
      }
      led.dataset.s = x.on ? 'on' : 'idle';
      w.textContent = wattsTxt(x.watts);
      total += x.watts;
      measured++;
      if (x.on) on++;
    }
    const t = $('[data-total]', ctx.el);
    if (t && measured) {
      t.textContent = wattsTxt(total);
      $('[data-total-sub]', ctx.el).textContent = on ? `${on} ${on === 1 ? 'aparato encendido' : 'aparatos encendidos'}` : 'Todo en reposo';
    }
  }

  // Cada pocos segundos: potencia en directo y estado de la conexión (los datos llegan por tiempo real cuando cambian).
  async function refreshLive() {
    if (!status?.configured || document.hidden || !ctx.isCurrent()) return;
    try {
      const [arr, st] = await Promise.all([links.some((l) => l.enabled) ? get('/ha/live') : [], get('/ha/status')]);
      if (!ctx.isCurrent()) return;
      live = new Map(arr.map((x) => [x.link_id, x]));
      paintLive();
      if (!st.configured) return load();
      const moved = ['last_ok', 'last_error', 'enabled', 'interval'].some((k) => st[k] !== status[k]);
      status = st;
      const panel = $('.ha-status', ctx.el);
      if (panel && moved) panel.outerHTML = String(statusPanel());
      else if (panel && st.last_ok) $('[data-ago]', panel).textContent = timeAgo(st.last_ok);
    } catch {
      // Conexión intermitente: se vuelve a intentar en la siguiente vuelta.
    }
  }
  const timer = setInterval(refreshLive, LIVE_MS);
  ctx.onCleanup(() => clearInterval(timer));

  // ---------- Consumo por horas ----------
  function chartPanel() {
    const rows = hourly[chartDay];
    const kwh = rows.reduce((a, r) => a + r.kwh, 0);
    const cost = rows.reduce((a, r) => a + r.cost, 0);
    return html`<section class="panel">
      <div class="panel-head"><h2>Consumo por horas</h2><span class="sub">${kwhTxt(kwh)} · ${money(Math.round(cost))}</span>
        <div class="actions segmented" data-chart-day><button data-v="today" aria-pressed="${chartDay === 'today'}">Hoy</button>
          <button data-v="yesterday" aria-pressed="${chartDay === 'yesterday'}">Ayer</button></div></div>
      <div class="chart-legend">${links.map((l) => html`<span><i style="--c:${color(order.indexOf(l.id))}"></i>${l.icon} ${l.name}</span>`)}</div>
      <div class="chart short" id="ha-chart" role="img" aria-label="Consumo por horas de cada enchufe"></div>
      ${rows.length ? '' : html`<p class="small muted" style="margin-top:8px">Sin consumo medido ${chartDay === 'today' ? 'hoy' : 'ayer'} todavía.</p>`}
    </section>`;
  }

  function drawChart() {
    const rows = hourly[chartDay];
    const byLink = new Map(links.map((l) => [l.id, new Array(24).fill(0)]));
    const costs = new Array(24).fill(0);
    for (const r of rows) {
      byLink.get(r.link_id)?.splice(r.hour, 1, r.kwh);
      costs[r.hour] += r.cost;
    }
    const nowH = new Date().getHours();
    mountChart($('#ha-chart', ctx.el), (t) => ({
      animationDuration: 400,
      grid: grid({ top: 10 }),
      tooltip: {
        ...tipBox(t), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.dark ? 'rgba(255,255,255,.05)' : 'rgba(17,26,48,.05)' } },
        formatter: (ps) => {
          const h = ps[0].dataIndex;
          const items = ps.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
          const total = items.reduce((a, p) => a + p.value, 0);
          return tipHTML(`${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00 · ${kwhTxt(total)} · ${money(Math.round(costs[h]))}`,
            items.length ? items.map((p) => ({ color: p.color, value: kwhTxt(p.value, 3), label: p.seriesName, box: true })) : [{ value: 'Sin consumo', label: '' }]);
        },
      },
      xAxis: { type: 'category', data: costs.map((_, h) => h), axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false },
        axisLabel: axisLabel(t, { interval: (i) => i % 3 === 0, formatter: (v) => `${v} h` }) },
      yAxis: { type: 'value', splitNumber: 3, splitLine: { lineStyle: { color: t.grid } }, axisLabel: axisLabel(t, { formatter: (v) => `${num(v, 2)}` }),
        name: 'kWh', nameTextStyle: { color: t.ink3, fontFamily: t.font, fontSize: 11, align: 'left' } },
      series: links.map((l) => {
        const i = order.indexOf(l.id);
        return {
          name: `${l.icon} ${l.name}`, type: 'bar', stack: 'kwh', barMaxWidth: 18,
          itemStyle: { color: i < 8 ? t.series[i] : t.muted, borderColor: t.surface, borderWidth: 1, borderRadius: 2 },
          data: byLink.get(l.id).map((v, h) => ({ value: v, itemStyle: chartDay === 'today' && h > nowH ? { opacity: 0.3 } : undefined })),
        };
      }),
    }));
  }

  // ---------- Usos detectados ----------
  function usesPanel() {
    const days = [];
    for (const u of uses) {
      let d = days.at(-1);
      if (!d || d.date !== u.date) days.push((d = { date: u.date, items: [], total: 0, kwh: 0 }));
      d.items.push(u);
      d.total += u.cost;
      d.kwh += u.kwh;
    }
    const shown = allUses ? days : days.slice(0, 3);
    return html`<section class="panel" data-uses><div class="panel-head"><h2>Usos detectados</h2><span class="sub">últimos 7 días, ya sumados a Consumo de luz</span>
      <div class="actions"><a class="btn ghost sm" href="#/luz">${icon('zap', 'sm')}Consumo de luz</a></div></div>
      ${days.length ? shown.map((d) => html`<div class="day-head" style="position:static;padding:12px 0 4px"><span class="d">${dayName(d.date)}</span>
          <span class="t">${kwhTxt(d.kwh)} · ${money(d.total)}</span></div>
        <div class="rows">${d.items.map((u) => {
          const l = links.find((x) => x.id === u.link_id);
          const when = u.start_time ? (u.running ? `Desde las ${u.start_time}` : `${u.start_time}–${u.end_time}`) : u.running ? 'Hasta ahora' : 'Todo el día';
          return html`<div class="rowi ha-use" style="--c:${color(order.indexOf(u.link_id))}">
            <span class="cat-dot sm"><span class="emoji">${u.icon || l?.icon || '🔌'}</span></span>
            <span class="main-txt"><span class="title">${u.name}</span>
              <span class="meta">${[when, u.start_time ? fmtMin(u.minutes) : '', kwhTxt(u.kwh), u.price_avg ? `${money(u.price_avg * 100, { decimals: 3 })}/kWh` : ''].filter(Boolean).join(' · ')}</span></span>
            ${u.running ? html`<span class="pill info">${icon('activity')}En marcha</span>` : u.billed ? html`<span class="pill paid">En factura</span>` : ''}
            <span class="amount">${money(u.cost)}</span>
          </div>`;
        })}</div>`)
        : html`<p class="small muted">Aún no se ha detectado ningún uso. Cuando enciendas un aparato enlazado aparecerá aquí en la siguiente lectura.</p>`}
      ${days.length > 3 ? html`<div class="row" style="justify-content:center;margin-top:12px"><button class="btn sm" data-act="all-uses">${allUses ? 'Ver solo los últimos 3 días' : `Ver los ${days.length} días`}</button></div>` : ''}
    </section>`;
  }

  // ---------- Sensores encontrados ----------
  function candidates() {
    if (!sensors || sensors.error) return [];
    const used = new Set(links.flatMap((l) => [l.energy_entity, l.power_entity]).filter(Boolean));
    const out = sensors.energy.map((e) => ({
      key: e.entity_id, name: e.name, energy_entity: e.entity_id, power_entity: e.power_entity || '', energy: e, power: sensors.power.find((p) => p.entity_id === e.power_entity),
    }));
    for (const p of sensors.power.filter((x) => !x.paired)) out.push({ key: p.entity_id, name: p.name, energy_entity: '', power_entity: p.entity_id, power: p });
    return out.map((c) => ({ ...c, linked: used.has(c.energy_entity) || used.has(c.power_entity) }));
  }

  function discoverBody() {
    if (!sensors) return html`<div class="skeleton" style="height:120px"></div>`;
    if (sensors.error) return html`<div class="ha-alert">${icon('wifi-off', 'sm')}<span>${sensors.error}</span></div>`;
    const all = candidates();
    const free = all.filter((c) => !c.linked);
    const q = plain(query);
    const shown = free.filter((c) => !q || plain(`${c.name} ${c.energy_entity} ${c.power_entity}`).includes(q));
    if (!all.length) {
      return html`<div class="empty" style="padding:18px"><div class="art">🔌</div><h3>No hay enchufes con medición</h3>
        <p>Home Assistant no tiene sensores de energía (kWh) ni de potencia (W). Añade la integración de tus enchufes (Shelly, Tasmota, TP-Link, Zigbee…) y vuelve a buscar.</p></div>`;
    }
    return html`${free.length > 6 ? html`<div class="input-group" style="margin-bottom:10px">${icon('search')}
        <input class="input" type="search" data-q value="${query}" placeholder="Buscar por nombre o entidad" aria-label="Buscar enchufes"></div>` : ''}
      ${shown.length ? html`<div class="rows">${shown.map((c) => html`<div class="rowi">
        <span class="cat-dot sm"><span class="emoji">${guessIcon(guessName(c.name))}</span></span>
        <span class="main-txt"><span class="title">${c.name}</span>
          <span class="meta">${[c.energy ? `${num(c.energy.value, 3)} ${c.energy.unit} acumulados` : 'Sin contador de energía',
            c.power ? `${num(c.power.value, 1)} ${c.power.unit} ahora` : 'sin potencia'].join(' · ')}</span>
          <span class="tiny muted ellipsis">${[c.energy_entity, c.power_entity].filter(Boolean).join(' + ')}</span></span>
        ${(c.energy && !c.energy.available) || (c.power && !c.power.available) ? html`<span class="pill overdue">No disponible</span>` : ''}
        ${can('edit') ? html`<button class="btn sm" data-link-cand="${c.key}">${icon('plug', 'sm')}Enlazar</button>` : ''}
      </div>`)}</div>`
        : html`<p class="small muted">${free.length ? 'Ningún enchufe coincide con la búsqueda.' : 'Todos los enchufes con medición ya están enlazados.'}</p>`}
      ${all.length - free.length ? html`<p class="tiny muted" style="margin-top:10px">${all.length - free.length} ${all.length - free.length === 1 ? 'enchufe ya enlazado' : 'enchufes ya enlazados'} (arriba, en el cuadro).</p>` : ''}`;
  }

  function logPanel() {
    if (!status.log.length) return '';
    return html`<details class="panel ha-log"><summary><h2>Historial de lecturas</h2><span class="sub">${status.log.length} últimas</span>${icon('chevron-down', 'sm')}</summary>
      <div class="rows" style="margin-top:8px">${status.log.map((x) => html`<div class="rowi">
        <span class="ha-led ${x.ok ? 'on' : 'err'} sm" aria-label="${x.ok ? 'Correcta' : 'Error'}"></span>
        <span class="main-txt"><span class="title">${x.ok ? x.message : 'Error'}</span>
          <span class="meta">${x.ok ? [`${x.cycles} ${x.cycles === 1 ? 'uso' : 'usos'}`, kwhTxt(x.kwh)].join(' · ') : x.message}</span></span>
        <span class="small muted" style="text-align:right">${timeAgo(x.at)}<br><span class="tiny">${num(x.ms / 1000, 1)} s</span></span>
      </div>`)}</div>
    </details>`;
  }

  // ---------- Primera conexión ----------
  function onboarding() {
    if (!admin) {
      return html`<div class="empty"><div class="art">🏠</div><h3>Home Assistant no está conectado</h3>
        <p>Si tenéis enchufes inteligentes en Home Assistant, ${NAME} puede leer lo que consume cada aparato y sumarlo solo a la luz.
        Pide a un administrador del hogar que lo conecte desde esta pantalla.</p></div>`;
    }
    return html`<div class="ha-onboard">
      <section class="panel ha-intro">
        <div class="ha-intro-art" aria-hidden="true"><span>🔌</span><span class="arrow">${icon('arrow-left-right')}</span><span>🏠</span></div>
        <h2>Consumo real, sin anotar nada</h2>
        <p>${NAME} lee de Home Assistant lo que gastan tus enchufes inteligentes, detecta cada vez que usas la lavadora, el horno o la secadora
          y suma su coste exacto, hora a hora, al consumo de luz. La nevera o el router se miden todo el día.</p>
        <ul class="ha-points">
          <li>${icon('lock', 'sm')}<span>Solo lectura: ${NAME} nunca enciende ni apaga nada.</span></li>
          <li>${icon('shield-check', 'sm')}<span>El token se guarda cifrado en este servidor y nunca se envía al navegador.</span></li>
          <li>${icon('receipt', 'sm')}<span>Cuando registres la factura de la luz, lo medido queda dentro de ella: nada se cuenta dos veces.</span></li>
        </ul>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Conectar Home Assistant</h2></div>
        <form class="form" id="ha-connect" autocomplete="off">
          <ol class="ha-steps">
            <li><div class="field"><label for="ha-url">Dirección de Home Assistant</label>
              <input class="input" id="ha-url" name="url" placeholder="http://192.168.1.20:8123" inputmode="url" autocapitalize="off" spellcheck="false" required>
              <span class="hint">Tal como la ve el servidor de ${NAME}: la IP de casa con el puerto 8123 o su nombre en Tailscale.</span></div></li>
            <li><div class="field"><label for="ha-token">Token de acceso de larga duración</label>
              <input class="input" id="ha-token" name="token" type="password" autocomplete="new-password" placeholder="Pega aquí el token" required>
              <details class="ha-help"><summary>${icon('info', 'sm')}Cómo se crea el token</summary>
                <ol><li>En Home Assistant, abre tu perfil (tu nombre, abajo a la izquierda).</li>
                  <li>Ve a la pestaña <b>Seguridad</b> y baja hasta <b>Tokens de acceso de larga duración</b>.</li>
                  <li>Pulsa <b>Crear token</b>, llámalo «${NAME}» y cópialo: solo se muestra una vez.</li></ol>
                <p>Mejor aún: crea en Home Assistant un usuario sin permisos de administrador solo para ${NAME} y genera el token con él.</p></details></div></li>
            <li><div class="field"><span class="label">Prueba la conexión y guárdala</span>
              <div class="ha-test" data-test-result hidden></div>
              <div class="row wrap" style="gap:8px"><button type="button" class="btn" data-act="test">${icon('radio')}Probar conexión</button>
                <button type="submit" class="btn primary" data-act="connect">${icon('plug-zap')}Conectar</button></div></div></li>
          </ol>
        </form>
      </section>
    </div>`;
  }

  // Formulario de conexión (primera vez y en Ajustes).
  function bindConnectForm(f, { after, focus = false } = {}) {
    if (!f) return;
    const result = $('[data-test-result]', f);
    const show = (ok, text) => {
      result.hidden = false;
      result.className = `ha-test ${ok ? 'ok' : 'bad'}`;
      result.innerHTML = String(html`${icon(ok ? 'circle-check' : 'circle-alert', 'sm')}<span>${text}</span>`);
    };
    on(f, 'click', '[data-act=test]', (e, btn) => withBusy(btn, async () => {
      const v = readForm(f);
      showFormError(f, null);
      try {
        const r = await post('/ha/connection/test', { url: v.url, token: v.token });
        show(true, `Conecta con ${r.location || 'Home Assistant'}${r.version ? ` (versión ${r.version})` : ''} en ${num(r.ms, 0)} ms.`);
      } catch (err) {
        show(false, err.message);
      }
    }));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = $('[data-act=connect]', f);
      withBusy(btn, async () => {
        const v = readForm(f);
        if (!v.url?.trim()) return showFormError(f, 'Escribe la dirección de Home Assistant');
        try {
          const r = await put('/ha/connection', { url: v.url, token: v.token });
          toast(`Conectado a ${r.location || 'Home Assistant'}. Elige los enchufes que quieres medir.`);
          document.activeElement?.blur();
          notifyChange('ha');
          after?.();
        } catch (err) {
          show(false, err.message);
        }
      });
    });
    if (focus) focusLater($('[name=url]', f), 150);
  }

  // ---------- Ajustes ----------
  function settingsSheet() {
    const s = sheet({
      title: 'Ajustes de Home Assistant',
      body: html`<div class="stack" style="gap:20px">
        <form class="form" id="ha-sets">
          <label class="switch"><input type="checkbox" name="enabled" ${status.enabled ? 'checked' : ''}><span class="track"></span>
            <span class="txt">Leer los enchufes automáticamente<small>Si lo desactivas, solo se leen al pulsar «Sincronizar».</small></span></label>
          <div class="field"><span class="label">Cada cuánto</span><div class="segmented" data-interval>
            ${[5, 15, 30, 60].map((m) => html`<button type="button" data-v="${m}" aria-pressed="${status.interval === m}">${m === 60 ? '1 h' : `${m} min`}</button>`)}</div>
            <span class="hint">Los usos se detectan con el historial de Home Assistant, así que no se pierde nada aunque leas cada hora.</span></div>
          <div class="field"><span class="label">Al enlazar un enchufe, recuperar</span><div class="segmented" data-backfill>
            ${[1, 3, 7, 10].map((n) => html`<button type="button" data-v="${n}" aria-pressed="${status.backfill === n}">${n} ${n === 1 ? 'día' : 'días'}</button>`)}</div>
            <span class="hint">Home Assistant guarda unos 10 días de historial por defecto. Los días que ya estén en una factura no se tocan.</span></div>
        </form>
        <form class="form" id="ha-conn" autocomplete="off">
          <h3 class="ha-sub">Conexión</h3>
          <div class="field"><label for="hs-url">Dirección</label>
            <input class="input" id="hs-url" name="url" value="${status.url}" inputmode="url" autocapitalize="off" spellcheck="false"></div>
          <div class="field"><label for="hs-token">Token</label>
            <input class="input" id="hs-token" name="token" type="password" autocomplete="new-password" placeholder="${status.token_hint ? `Guardado (${status.token_hint}). Déjalo vacío para mantenerlo.` : 'Pega el token'}">
            ${status.token_ok ? '' : html`<span class="hint" style="color:var(--granada)">No se puede leer el token guardado (¿ha cambiado la clave del servidor?). Pega uno nuevo.</span>`}</div>
          <div class="ha-test" data-test-result hidden></div>
          <div class="row wrap" style="gap:8px"><button type="button" class="btn" data-act="test">${icon('radio')}Probar</button>
            <button type="submit" class="btn" data-act="connect">${icon('check')}Guardar conexión</button></div>
        </form>
        <div class="ha-danger"><div class="grow"><b>Desconectar Home Assistant</b>
          <div class="small muted">Se borra el token y se dejan de leer los enchufes. Lo ya medido se conserva.</div></div>
          <button class="btn danger" data-act="disconnect">${icon('unplug')}Desconectar</button></div>
      </div>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cerrar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const f = $('#ha-sets', s.el);
    const pick = (sel) => (e, b) => $$(`${sel} [data-v]`, f).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    on(f, 'click', '[data-interval] [data-v]', pick('[data-interval]'));
    on(f, 'click', '[data-backfill] [data-v]', pick('[data-backfill]'));
    bindConnectForm($('#ha-conn', s.el), { after: () => s.close() });
    on(s.el, 'click', '[data-act=save]', (e, btn) => withBusy(btn, async () => {
      try {
        await patch('/ha/settings', {
          enabled: $('[name=enabled]', f).checked,
          interval: Number($('[data-interval] [aria-pressed=true]', f)?.dataset.v || status.interval),
          backfill: Number($('[data-backfill] [aria-pressed=true]', f)?.dataset.v || status.backfill),
        });
        notifyChange('ha');
        toast('Ajustes guardados');
        s.close();
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=disconnect]', async () => {
      const ok = await new Promise((resolve) => {
        const c = sheet({
          title: '¿Desconectar Home Assistant?', size: 'narrow',
          body: html`<p class="ink-2">${NAME} dejará de leer los enchufes y borrará el token guardado. Los usos ya medidos se conservan en Consumo de luz.</p>`,
          foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn danger" data-yes>Desconectar</button>`,
          onClose: (r) => resolve(!!r),
        });
        on(c.el, 'click', '[data-yes]', () => c.close(true));
      });
      if (!ok) return;
      try {
        await del('/ha/connection');
        toast('Home Assistant desconectado', { iconName: 'unplug' });
        s.close();
        notifyChange('ha');
      } catch (err) {
        toastError(err);
      }
    });
  }

  // ---------- Enlazar o ajustar un enchufe ----------
  function linkSheet({ link = null, cand = null } = {}) {
    const editing = !!link;
    const name0 = link?.name || guessName(cand?.name);
    const match = !link && appliances.find((a) => !a.archived && (plain(a.name) === plain(name0) || plain(name0).includes(plain(a.name)) || plain(a.name).includes(plain(name0))));
    const d = {
      name: name0, icon: link?.icon || match?.icon || guessIcon(name0),
      energy_entity: link ? link.energy_entity || '' : cand?.energy_entity || '', power_entity: link ? link.power_entity || '' : cand?.power_entity || '',
      mode: link?.mode || guessMode(name0), threshold_w: link?.threshold_w ?? 15, min_kwh: link?.min_kwh ?? 0.05, gap_min: link?.gap_min ?? 15,
      appliance: link ? (link.appliance_id ? String(link.appliance_id) : 'none') : match ? String(match.id) : 'new',
    };
    const energyOpts = sensors?.energy || [];
    const powerOpts = sensors?.power || [];
    const opt = (list, cur, none) => html`<option value="">${none}</option>${list.map((x) => html`<option value="${x.entity_id}" ${x.entity_id === cur ? 'selected' : ''}>${x.name} (${num(x.value, 2)} ${x.unit})</option>`)}
      ${cur && !list.some((x) => x.entity_id === cur) ? html`<option value="${cur}" selected>${cur}</option>` : ''}`;
    let preview = null;
    const s = sheet({
      title: editing ? `${link.icon} ${link.name}` : 'Enlazar enchufe',
      size: 'wide',
      body: html`<form class="form" id="lf" autocomplete="off">
        <div class="grid-2 keep">
          <div class="field"><label for="lf-n">Nombre</label><input class="input" id="lf-n" name="name" value="${d.name}" maxlength="40" required></div>
          <div class="field"><label for="lf-a">Electrodoméstico en Consumo de luz</label>
            <select class="select" id="lf-a" name="appliance">
              <option value="new" ${d.appliance === 'new' ? 'selected' : ''} data-new>Crear «${d.name}» con lo medido</option>
              ${appliances.filter((a) => !a.archived).map((a) => html`<option value="${a.id}" ${String(a.id) === d.appliance ? 'selected' : ''}>${a.icon} ${a.name}${a.ha_linked && a.id !== link?.appliance_id ? ' (ya medido)' : ''}</option>`)}
              <option value="none" ${d.appliance === 'none' ? 'selected' : ''}>Ninguno: solo medir</option>
            </select></div>
        </div>
        <div class="field"><span class="label">Icono</span>
          <div class="emoji-pick ha-icons" data-pick="icon">${[...new Set([d.icon, ...PLUG_ICONS])].map((e) => html`<button type="button" data-v="${e}" aria-pressed="${e === d.icon}">${e}</button>`)}</div>
          <input type="hidden" name="icon" value="${d.icon}"></div>
        <div class="field"><span class="label">¿Cómo se usa?</span>
          <div class="segmented block" data-mode><button type="button" data-v="cycles" aria-pressed="${d.mode === 'cycles'}">${icon('timer', 'sm')}Cada vez que se enciende</button>
            <button type="button" data-v="continuous" aria-pressed="${d.mode === 'continuous'}">${icon('activity', 'sm')}Todo el día</button></div>
          <span class="hint" data-mode-hint></span></div>
        <div class="ha-link-grid">
          <div class="ha-preview" data-preview aria-live="polite"></div>
          <div class="stack" style="gap:14px">
            <div class="ha-tune" data-cycles>
              <div class="field"><label for="lf-t">Encendido a partir de</label>
                <div class="row wrap" style="gap:8px"><div class="chips" data-chips="threshold_w">${[5, 15, 50, 200].map((w) => html`<button type="button" class="chip sm" data-v="${w}" aria-pressed="${d.threshold_w === w}">${w} W</button>`)}</div>
                  <div class="input-group" style="width:96px"><input class="input" id="lf-t" name="threshold_w" inputmode="decimal" value="${num(d.threshold_w, 1)}" style="padding-left:13px"><span class="suffix">W</span></div></div>
                <span class="hint">Por debajo, el aparato está en reposo (stand-by).</span></div>
              <div class="field"><label for="lf-g">Pausas dentro de un mismo uso</label>
                <div class="row wrap" style="gap:8px"><div class="chips" data-chips="gap_min">${[5, 15, 30, 60].map((m) => html`<button type="button" class="chip sm" data-v="${m}" aria-pressed="${d.gap_min === m}">${m} min</button>`)}</div>
                  <div class="input-group" style="width:96px"><input class="input" id="lf-g" name="gap_min" inputmode="numeric" value="${d.gap_min}" style="padding-left:13px"><span class="suffix">min</span></div></div>
                <span class="hint">La lavadora se para mientras remoja: una pausa más corta sigue siendo el mismo lavado.</span></div>
              <div class="field" style="max-width:200px"><label for="lf-m">Uso mínimo</label>
                <div class="input-group"><input class="input" id="lf-m" name="min_kwh" inputmode="decimal" value="${num(d.min_kwh, 3)}" style="padding-left:13px"><span class="suffix">kWh</span></div>
                <span class="hint">Ignora encendidos muy cortos.</span></div>
            </div>
            <details class="ha-help"${editing ? '' : ' open'}><summary>${icon('sliders-horizontal', 'sm')}Sensores de Home Assistant</summary>
              <div class="stack" style="gap:10px;margin-top:10px">
                <div class="field"><label for="lf-e">Energía (contador kWh)</label><select class="select" id="lf-e" name="energy_entity">${opt(energyOpts, d.energy_entity, 'Sin contador')}</select></div>
                <div class="field"><label for="lf-p">Potencia (W)</label><select class="select" id="lf-p" name="power_entity">${opt(powerOpts, d.power_entity, 'Sin potencia')}</select></div>
              </div>
              <p class="hint" style="margin-top:6px">Con los dos es lo más exacto: el total sale del contador y la hora de cada uso, de la potencia.</p>
            </details>
            ${editing ? html`<label class="switch"><input type="checkbox" name="enabled" ${link.enabled ? 'checked' : ''}><span class="track"></span>
              <span class="txt">Medir este enchufe<small>Si lo desactivas, se dejan de añadir usos nuevos.</small></span></label>` : ''}
          </div>
        </div>
      </form>`,
      foot: html`${editing ? html`<button class="btn danger icon-only" data-act="unlink" aria-label="Quitar enchufe">${icon('trash-2')}</button>` : ''}<span class="spacer"></span>
        <button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">${icon(editing ? 'check' : 'plug-zap')}${editing ? 'Guardar' : 'Enlazar'}</button>`,
    });
    const f = $('#lf', s.el);
    bindPickers(f);
    const mode = () => $('[data-mode] [aria-pressed=true]', f).dataset.v;
    const dec = (x) => Number(String(x ?? '').replace(',', '.'));
    const values = () => {
      const v = readForm(f);
      return {
        name: v.name.trim(), icon: v.icon, mode: mode(), energy_entity: v.energy_entity || null, power_entity: v.power_entity || null,
        threshold_w: dec(v.threshold_w) || 15, gap_min: Math.round(dec(v.gap_min)) || 0, min_kwh: dec(v.min_kwh) || 0,
        appliance: v.appliance, enabled: editing ? v.enabled : undefined,
      };
    };
    const syncMode = () => {
      const m = mode();
      $('[data-cycles]', f).hidden = m !== 'cycles';
      $('[data-mode-hint]', f).textContent = m === 'cycles'
        ? 'Para aparatos que enciendes y apagas: lavadora, horno, secadora, termo… Cada uso aparece con su hora y su coste.'
        : 'Para lo que está siempre enchufado: nevera, router, acuario… Se suma el consumo del día entero.';
    };
    on(f, 'click', '[data-mode] [data-v]', (e, b) => {
      $$('[data-mode] [data-v]', f).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      syncMode();
      runPreview();
    });
    on(f, 'click', '[data-chips] [data-v]', (e, b) => {
      const g = b.closest('[data-chips]');
      $$('[data-v]', g).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      f.elements[g.dataset.chips].value = b.dataset.v;
      runPreview();
    });
    on(f, 'input', '[name=threshold_w], [name=gap_min]', (e, inp) => {
      $$(`[data-chips="${inp.name}"] [data-v]`, f).forEach((x) => x.setAttribute('aria-pressed', String(dec(x.dataset.v) === dec(inp.value))));
    });
    on(f, 'input', '[name=threshold_w], [name=gap_min], [name=min_kwh]', () => runPreview());
    on(f, 'change', 'select[name$=_entity]', () => runPreview());
    on(f, 'input', '[name=name]', () => {
      const o = $('option[data-new]', f);
      o.textContent = `Crear «${f.elements.name.value.trim() || 'enchufe'}» con lo medido`;
    });

    // Vista previa: lo que se habría detectado los últimos días con estos ajustes.
    const box = $('[data-preview]', f);
    let seq = 0;
    const runPreview = debounce(async () => {
      const v = values();
      if (!v.energy_entity && !v.power_entity) {
        box.innerHTML = String(html`<p class="small muted">Elige al menos un sensor para ver lo que se detectaría.</p>`);
        return;
      }
      const mine = ++seq;
      box.classList.add('loading');
      try {
        const r = await post('/ha/links/preview', { ...v, name: v.name || 'Enchufe', appliance: undefined, enabled: undefined, days: 3 });
        if (mine !== seq) return;
        preview = r;
        box.innerHTML = String(previewHTML(r, v.mode));
      } catch (err) {
        if (mine === seq) box.innerHTML = String(html`<div class="ha-alert">${icon('circle-alert', 'sm')}<span>${err.message}</span></div>`);
      } finally {
        if (mine === seq) box.classList.remove('loading');
      }
    }, 450);

    on(s.el, 'click', '[data-act=save]', (e, btn) => withBusy(btn, async () => {
      const v = values();
      if (!v.name) return showFormError(f, 'Escribe un nombre');
      if (!v.energy_entity && !v.power_entity) return showFormError(f, 'Elige el sensor de energía o el de potencia');
      const payload = {
        name: v.name, icon: v.icon, mode: v.mode, energy_entity: v.energy_entity, power_entity: v.power_entity,
        threshold_w: v.threshold_w, gap_min: v.gap_min, min_kwh: v.min_kwh,
        appliance_id: /^\d+$/.test(v.appliance) ? Number(v.appliance) : null, create_appliance: v.appliance === 'new',
        ...(editing ? { enabled: v.enabled } : {}), ...measuredProfile(preview, v.mode),
      };
      try {
        if (editing) {
          await patch(`/ha/links/${link.id}`, payload);
          toast(`${v.name}: ajustes guardados. Se recalculan los últimos días.`);
        } else {
          const r = await post('/ha/links', payload);
          toast(r.sync?.error ? `${v.name} enlazado, pero la primera lectura ha fallado: ${r.sync.error}`
            : r.sync?.pending ? `${v.name} enlazado. Leyendo los últimos días…` : `${v.name} enlazado: recuperados los últimos días`);
        }
        notifyChange('power');
        s.close(true);
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=unlink]', () => unlinkSheet(link, () => s.close()));
    syncMode();
    runPreview();
    if (!editing) focusLater($('#lf-n', f), 120, { select: true });
  }

  // Potencia, duración y consumo habituales según lo detectado (para crear el electrodoméstico).
  function measuredProfile(days, mode) {
    const list = (days || []).flatMap((d) => d.usages).filter((u) => !u.running && u.kwh > 0);
    if (mode === 'continuous') {
      const full = (days || []).filter((d) => d.date !== today() && d.total > 0);
      if (!full.length) return {};
      const avg = full.reduce((a, d) => a + d.total, 0) / full.length;
      return { watts: Math.max(1, Math.round((avg / 24) * 1000)), minutes: 1440, kwh_per_use: avg };
    }
    if (!list.length) return {};
    const kwh = list.reduce((a, u) => a + u.kwh, 0) / list.length;
    const minutes = Math.round(list.reduce((a, u) => a + u.minutes, 0) / list.length);
    return { watts: Math.max(1, Math.round((kwh / (minutes / 60)) * 1000)), minutes: Math.max(1, minutes), kwh_per_use: kwh };
  }

  function previewHTML(days, mode) {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    return html`<div class="ha-preview-head"><b>Lo que se habría detectado</b><span class="small muted">con estos ajustes, en los últimos ${days.length} días</span></div>
      ${days.map((d) => {
        const max = Math.max(...d.hours, 0.0001);
        const isToday = d.date === today();
        return html`<div class="ha-pday">
          <div class="ha-pday-head"><b>${dayName(d.date)}</b><span class="small">${kwhTxt(d.total)} · ${money(d.cost)}</span></div>
          <div class="ha-track">
            <div class="bars">${d.hours.map((k, h) => html`<i style="height:${k > 0 ? Math.max(5, (k / max) * 100) : 0}%" class="${isToday && h * 60 > nowMin ? 'future' : ''}" title="${String(h).padStart(2, '0')}:00 · ${kwhTxt(k, 3)}"></i>`)}</div>
            ${mode === 'cycles' ? d.usages.filter((u) => u.start_time).map((u) => {
              const a = mins(u.start_time);
              const b = u.end_time === '00:00' || mins(u.end_time) < a ? 1440 : mins(u.end_time);
              return html`<span class="seg ${u.running ? 'running' : ''}" style="left:${(a / 1440) * 100}%;width:${Math.max(0.8, ((b - a) / 1440) * 100)}%" title="${u.start_time}–${u.end_time} · ${kwhTxt(u.kwh)}"></span>`;
            }) : ''}
            ${isToday ? html`<span class="now" style="left:${(nowMin / 1440) * 100}%"></span>` : ''}
          </div>
          <div class="ha-axis"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
          <div class="ha-pday-uses small">${mode === 'continuous'
            ? (d.usages.length ? html`<span>Se sumarían <b>${kwhTxt(d.usages[0].kwh)}</b> (${money(d.usages[0].cost)})${isToday ? ' hasta ahora' : ''}</span>` : html`<span class="muted">Sin consumo</span>`)
            : d.usages.length ? d.usages.map((u) => html`<span class="ha-chip">${u.start_time}–${u.running ? 'ahora' : u.end_time} · ${fmtMin(u.minutes)} · <b>${kwhTxt(u.kwh)}</b> · ${money(u.cost)}</span>`)
              : html`<span class="muted">Ningún uso${d.total > 0 ? ` (${kwhTxt(d.total)} en reposo, no se suma)` : ''}</span>`}</div>
        </div>`;
      })}
      ${mode === 'cycles' ? (() => {
        const all = days.flatMap((d) => d.usages);
        const standby = days.reduce((a, d) => a + d.total, 0) - all.reduce((a, u) => a + u.kwh, 0);
        return standby > 0.05 ? html`<p class="hint">En reposo gasta unos ${kwhTxt(standby / days.length)} al día que no se suman como uso; los recoge la factura.</p>` : '';
      })() : ''}`;
  }

  function unlinkSheet(link, done) {
    const s = sheet({
      title: `¿Quitar ${link.name}?`, size: 'narrow',
      body: html`<p class="ink-2">${NAME} dejará de leer este enchufe. ¿Qué hacemos con lo que ya se ha medido?</p>
        <div class="stack" style="gap:8px;margin-top:12px">
          <button class="btn block" data-keep>${icon('archive')}Conservarlo en Consumo de luz</button>
          <button class="btn danger block" data-purge>${icon('trash-2')}Borrarlo (salvo días ya facturados)</button></div>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button>`,
    });
    const go = (purge) => async () => {
      try {
        await del(`/ha/links/${link.id}${purge ? '?purge=1' : ''}`);
        toast(`${link.name} quitado`, { iconName: 'unplug' });
        s.close();
        done?.();
        notifyChange('power');
      } catch (err) {
        toastError(err);
      }
    };
    on(s.el, 'click', '[data-keep]', go(false));
    on(s.el, 'click', '[data-purge]', go(true));
  }

  async function syncNow(btn) {
    await withBusy(btn, async () => {
      try {
        const r = await post('/ha/sync');
        if (r.busy) return toast('Ya se está leyendo Home Assistant. Espera unos segundos.');
        toast(r.days ? `Leído: ${kwhTxt(r.kwh)} y ${r.usages} ${r.usages === 1 ? 'uso' : 'usos'} en ${r.days} ${r.days === 1 ? 'día' : 'días'}` : 'Leído. No hay enchufes enlazados.', { iconName: 'refresh-cw' });
        notifyChange('power');
      } catch (err) {
        toastError(err);
        load();
      }
    });
  }

  // ---------- Eventos ----------
  ctx.onCleanup(on(document.getElementById('page-actions'), 'click', '[data-act]', (e, b) => {
    if (b.dataset.act === 'settings') settingsSheet();
    if (b.dataset.act === 'sync') syncNow(b);
  }));
  on(ctx.el, 'click', '[data-act=settings]', () => settingsSheet());
  on(ctx.el, 'click', '[data-act=resume]', async () => {
    await patch('/ha/settings', { enabled: true }).catch(toastError);
    notifyChange('ha');
  });
  on(ctx.el, 'click', '[data-act=rescan]', (e, b) => withBusy(b, async () => {
    sensors = null;
    $('[data-discover]', ctx.el).innerHTML = String(discoverBody());
    await loadSensors();
  }));
  on(ctx.el, 'click', '[data-chart-day] [data-v]', (e, b) => {
    chartDay = b.dataset.v;
    const panel = b.closest('section');
    panel.outerHTML = String(chartPanel());
    drawChart();
  });
  on(ctx.el, 'click', '[data-act=all-uses]', (e, b) => {
    allUses = !allUses;
    b.closest('[data-uses]').outerHTML = String(usesPanel());
  });
  on(ctx.el, 'click', '[data-mod]', (e, b) => {
    const l = links.find((x) => x.id === Number(b.dataset.mod));
    if (l && can('edit')) linkSheet({ link: l });
  });
  on(ctx.el, 'click', '[data-link-cand]', (e, b) => {
    const c = candidates().find((x) => x.key === b.dataset.linkCand);
    if (c) linkSheet({ cand: c });
  });
  on(ctx.el, 'input', '[data-q]', debounce((e) => {
    query = e.target.value;
    const box = $('[data-discover]', ctx.el);
    box.innerHTML = String(discoverBody());
    const inp = $('[data-q]', box);
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }, 150));
  const onVisible = () => document.visibilityState === 'visible' && refreshLive();
  document.addEventListener('visibilitychange', onVisible);
  ctx.onCleanup(() => document.removeEventListener('visibilitychange', onVisible));

  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
}
