// Home Assistant: lee el consumo real de enchufes inteligentes y lo convierte en usos de electrodomésticos.
// Solo lectura: GastosbyATH consulta la API REST de Home Assistant con un token de larga duración.
import { all, insert, one, run, tx } from './db.js';
import { safeJson } from './auth.js';
import { decrypt } from './secret.js';
import { addDays, today } from './util.js';
import { dayPrices, ensurePrices, powerSettings, syncPowerDay } from './power.js';
import { emit } from './events.js';

export const HA_DEFAULTS = {
  url: '', token_enc: null, enabled: true, interval: 15, backfill: 7,
  last_sync: null, last_ok: null, last_error: null, version: null, location: null,
};

export function haConfig(hid) {
  const row = one('SELECT ha FROM households WHERE id = ?', hid);
  return { ...HA_DEFAULTS, ...safeJson(row?.ha) };
}
export const saveHaConfig = (hid, cfg) => run('UPDATE households SET ha = ? WHERE id = ?', JSON.stringify(cfg), hid);
export const isConfigured = (cfg) => !!(cfg.url && cfg.token_enc);

export function publicConfig(cfg) {
  const token = cfg.token_enc ? decrypt(cfg.token_enc) : null;
  const { token_enc, ...rest } = cfg;
  return { ...rest, configured: isConfigured(cfg), token_hint: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : null, token_ok: !!token };
}

export class HaError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function explainNetwork(e) {
  const code = e?.cause?.code || e?.code || e?.name || '';
  if (e?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(code)) {
    return 'Home Assistant no responde (se agotó el tiempo de espera). ¿Está encendido? Si usas Tailscale, comprueba que este servidor está conectado.';
  }
  if (code === 'ECONNREFUSED') return 'Conexión rechazada: la dirección existe pero no hay nada escuchando en ese puerto. Home Assistant suele usar el 8123.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'No se encuentra ese nombre de equipo. Prueba con la IP, por ejemplo http://192.168.1.20:8123.';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) {
    return 'El certificado HTTPS de Home Assistant no es válido para este servidor. Usa http://IP:8123 dentro de casa o la dirección https de Tailscale.';
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Este servidor no tiene ruta hasta Home Assistant (¿está en otra red?).';
  return `No se puede conectar con Home Assistant${code ? ` (${code})` : ''}.`;
}

export function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new HaError('Escribe la dirección de Home Assistant');
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new HaError('La dirección no es válida. Ejemplo: http://192.168.1.20:8123');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HaError('La dirección debe empezar por http:// o https://');
  return `${url.origin}${url.pathname.replace(/\/+(api\/?)?$/, '').replace(/\/+$/, '')}`;
}

export async function haFetch(url, token, path, { timeout = 15000 } = {}) {
  let res;
  try {
    res = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new HaError(explainNetwork(e));
  }
  if (res.status === 401 || res.status === 403) {
    throw new HaError('Home Assistant ha rechazado el token. Crea uno nuevo en tu perfil de Home Assistant (Seguridad → Tokens de acceso de larga duración).', 401);
  }
  if (res.status === 404) throw new HaError('No se encuentra la API en esa dirección. Comprueba la URL y el puerto (normalmente 8123).', 404);
  if (!res.ok) throw new HaError(`Home Assistant ha respondido con un error ${res.status}.`, res.status);
  try {
    return await res.json();
  } catch {
    throw new HaError('La respuesta no parece de Home Assistant. Revisa la dirección.');
  }
}

export async function testConnection(url, token) {
  const ping = await haFetch(url, token, '/api/');
  if (!ping || typeof ping.message !== 'string') throw new HaError('La respuesta no parece de Home Assistant. Revisa la dirección.');
  const conf = await haFetch(url, token, '/api/config');
  return { version: conf.version || null, location: conf.location_name || null, time_zone: conf.time_zone || null };
}

const credentials = (cfg) => {
  const token = decrypt(cfg.token_enc);
  if (!cfg.url || !token) throw new HaError('Home Assistant no está configurado.');
  return { url: cfg.url, token };
};

// ---------- Sensores ----------
const ENERGY_UNITS = { Wh: 0.001, kWh: 1, MWh: 1000 };
const POWER_UNITS = { W: 0.001, kW: 1 };
const isEnergy = (s) => s.entity_id.startsWith('sensor.') && (s.attributes?.device_class === 'energy' || s.attributes?.unit_of_measurement in ENERGY_UNITS);
const isPower = (s) => s.entity_id.startsWith('sensor.') && (s.attributes?.device_class === 'power' || s.attributes?.unit_of_measurement in POWER_UNITS)
  && (s.attributes?.unit_of_measurement in POWER_UNITS);

// Raíz común para emparejar el sensor de energía y el de potencia de un mismo enchufe.
const SUFFIX = /_(energy|energia|consumo|consumption|total|total_energy|today|this_month|power|potencia|current_power|current_consumption|watts?|electric_consumption_w|electric_consumed_kwh|kwh|w)$/;
function stem(id) {
  let s = id.replace(/^sensor\./, '');
  for (let i = 0; i < 3; i++) s = s.replace(SUFFIX, '');
  return s;
}

export async function discoverSensors(cfg) {
  const { url, token } = credentials(cfg);
  const states = await haFetch(url, token, '/api/states', { timeout: 20000 });
  const view = (s) => ({
    entity_id: s.entity_id, name: s.attributes?.friendly_name || s.entity_id, state: s.state, value: Number(s.state),
    unit: s.attributes?.unit_of_measurement || '', device_class: s.attributes?.device_class || '', state_class: s.attributes?.state_class || '',
    last_changed: s.last_changed, available: !['unavailable', 'unknown', ''].includes(String(s.state)),
  });
  const energy = states.filter(isEnergy).map(view);
  const power = states.filter(isPower).map(view);
  for (const e of energy) {
    const st = stem(e.entity_id);
    const match = power.find((p) => stem(p.entity_id) === st)
      || power.find((p) => stem(p.entity_id).startsWith(st) || st.startsWith(stem(p.entity_id)));
    if (match) {
      e.power_entity = match.entity_id;
      e.power_value = match.value;
      e.power_unit = match.unit;
      match.paired = true;
    }
  }
  return { energy, power, units: Object.fromEntries([...energy, ...power].map((x) => [x.entity_id, x.unit])) };
}

// ---------- Cálculo a partir del historial ----------
// Lecturas numéricas ordenadas. Con gaps, «unavailable»/«unknown» se conservan como corte (v = null):
// mientras el enchufe no informa no se supone que siga consumiendo lo último leído.
const toSamples = (list, unitFactor, { gaps = false } = {}) => (list || [])
  .map((s) => {
    const n = Number(s.state);
    return { t: Date.parse(s.last_changed || s.last_updated), v: s.state !== '' && Number.isFinite(n) ? n * unitFactor : null };
  })
  .filter((s) => Number.isFinite(s.t) && (s.v !== null || gaps))
  .sort((a, b) => a.t - b.t);

// Contador de energía → tramos con su consumo. Se tienen en cuenta los reinicios del contador y se ignoran saltos imposibles.
export function energyIntervals(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    let dv = b.v - a.v;
    if (dv < 0) dv = b.v < a.v * 0.5 ? b.v : 0; // reinicio del contador o ruido de redondeo
    if (dv > (dt / 36e5) * 12 + 0.05) dv = 0; // más de 12 kW sostenidos en un enchufe: lectura errónea
    out.push({ t0: a.t, t1: b.t, kwh: dv });
  }
  return out;
}

// Potencia (kW) → energía, manteniendo cada lectura hasta la siguiente.
export function powerIntervals(samples, endMs) {
  const out = [];
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const t1 = i + 1 < samples.length ? samples[i + 1].t : endMs;
    if (t1 <= a.t || a.v === null) continue;
    const kw = Math.max(0, Math.min(a.v, 12));
    out.push({ t0: a.t, t1, kwh: kw * ((t1 - a.t) / 36e5) });
  }
  return out;
}

// Reparte cada tramo entre las horas locales que abarca.
export function hourly(intervals, fromMs, toMs) {
  const hours = new Array(24).fill(0);
  for (const it of intervals) {
    const a = Math.max(it.t0, fromMs);
    const b = Math.min(it.t1, toMs);
    if (b <= a || !it.kwh) continue;
    let t = a;
    while (t < b) {
      const d = new Date(t);
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      const end = Math.min(next, b);
      hours[d.getHours()] += it.kwh * ((end - t) / (it.t1 - it.t0));
      t = end;
    }
  }
  return hours;
}

// Agrupa los tramos con potencia por encima del umbral en ciclos de uso (une pausas cortas).
export function detectCycles(intervals, { threshold_w = 15, min_kwh = 0.05, gap_min = 15 } = {}, nowMs = Date.now()) {
  const active = intervals.filter((it) => it.kwh > 0 && (it.kwh / ((it.t1 - it.t0) / 36e5)) * 1000 >= threshold_w);
  const cycles = [];
  for (const it of active) {
    const last = cycles.at(-1);
    if (last && it.t0 - last.end <= gap_min * 60000) last.end = Math.max(last.end, it.t1);
    else cycles.push({ start: it.t0, end: it.t1 });
  }
  for (const c of cycles) {
    c.kwh = intervals.reduce((s, it) => {
      const ov = Math.min(it.t1, c.end) - Math.max(it.t0, c.start);
      return ov > 0 ? s + it.kwh * (ov / (it.t1 - it.t0)) : s;
    }, 0);
    c.running = c.end >= nowMs - gap_min * 60000;
  }
  return cycles.filter((c) => c.kwh >= min_kwh || c.running);
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const dayBounds = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  const from = new Date(y, m - 1, d).getTime();
  return { from, to: Math.min(new Date(y, m - 1, d + 1).getTime(), Date.now()) };
};

async function fetchHistory(url, token, entities, fromMs, toMs) {
  const q = `?end_time=${encodeURIComponent(new Date(toMs).toISOString())}&filter_entity_id=${entities.map(encodeURIComponent).join(',')}`
    + '&minimal_response&no_attributes&significant_changes_only=0';
  const data = await haFetch(url, token, `/api/history/period/${encodeURIComponent(new Date(fromMs).toISOString())}${q}`, { timeout: 30000 });
  const byEntity = {};
  for (const list of data || []) {
    const id = list?.[0]?.entity_id;
    if (id) byEntity[id] = list;
  }
  return byEntity;
}

// Tramos de un enlace en un día a partir del historial.
// - alloc: para repartir los kWh (contador de energía si lo hay; si no, potencia integrada).
// - detect: para saber cuándo empieza y acaba cada uso (la potencia es más exacta en el tiempo).
function linkIntervals(link, hist, units, toMs) {
  const power = link.power_entity
    ? powerIntervals(toSamples(hist[link.power_entity], POWER_UNITS[units[link.power_entity]] ?? 0.001, { gaps: true }).filter((x) => x.t <= toMs), toMs)
    : null;
  const energy = link.energy_entity ? energyIntervals(toSamples(hist[link.energy_entity], ENERGY_UNITS[units[link.energy_entity]] ?? 1)) : null;
  if (!power) {
    // Solo contador: en reposo apenas informa, así que el consumo de un tramo largo se asume al final
    // (es cuando el aparato arranca y el contador vuelve a moverse).
    const shifted = (energy || []).map((it) => (it.kwh > 0 && it.t1 - it.t0 > 5 * MIN_MS ? { ...it, t0: it.t1 - 5 * MIN_MS } : it));
    return { alloc: link.mode === 'cycles' ? shifted : energy || [], detect: shifted };
  }
  if (!energy) return { alloc: power, detect: power };
  const alloc = fuseIntervals(energy, power);
  // Hoy: lo que la potencia ya ve pero el contador aún no ha anotado (un uso que acaba de empezar).
  // En días cerrados no se añade: ese tramo lo recoge el contador al día siguiente.
  if (toMs >= Date.now() - 60000) {
    const last = energy.length ? energy.at(-1).t1 : -Infinity;
    for (const p of power) {
      if (p.t1 <= last) continue;
      alloc.push(p.t0 >= last ? p : { t0: last, t1: p.t1, kwh: p.kwh * ((p.t1 - last) / (p.t1 - p.t0)) });
    }
  }
  return { alloc, detect: power };
}

// Reparte los kWh de cada tramo del contador según la curva de potencia de ese tramo:
// el total sale del contador (más exacto) y el momento, de la potencia (más frecuente).
export function fuseIntervals(energy, power) {
  if (!power.length) return energy;
  const out = [];
  let j = 0;
  for (const e of energy) {
    while (j < power.length && power[j].t1 <= e.t0) j++;
    const parts = [];
    for (let k = j; k < power.length && power[k].t0 < e.t1; k++) {
      const p = power[k];
      const a = Math.max(p.t0, e.t0);
      const b = Math.min(p.t1, e.t1);
      if (b > a) parts.push({ t0: a, t1: b, kwh: p.kwh * ((b - a) / (p.t1 - p.t0)) });
    }
    const sum = parts.reduce((acc, p) => acc + p.kwh, 0);
    if (e.kwh > 0 && sum > 0) for (const p of parts) out.push({ ...p, kwh: p.kwh * (e.kwh / sum) });
    else out.push(e);
  }
  return out;
}
const MIN_MS = 60000;

// Resultado de un día para un enlace: consumo por horas y usos (ciclos o total diario) con su coste.
export function computeDay(hid, link, { alloc, detect }, date) {
  const intervals = alloc;
  const { from, to } = dayBounds(date);
  const s = powerSettings(hid);
  const { prices } = dayPrices(hid, date, s);
  const hours = hourly(intervals, from, to);
  const hourCost = hours.map((k, h) => k * prices[h]);
  const total = hours.reduce((a, b) => a + b, 0);
  const usages = [];
  if (link.mode === 'continuous') {
    if (total >= 0.001) {
      usages.push({
        start_time: null, end_time: null, minutes: Math.round((to - from) / 60000), kwh: total,
        cost: Math.round(hourCost.reduce((a, b) => a + b, 0) * 100), running: date === today() ? 1 : 0,
      });
    }
  } else {
    for (const c of detectCycles(detect, link, Date.now())) {
      const cs = Math.max(c.start, from);
      const ce = Math.min(c.end, to);
      if (ce <= cs) continue;
      const ch = hourly(intervals.map((it) => ({ ...it })), cs, ce);
      const kwh = ch.reduce((a, b) => a + b, 0);
      usages.push({
        start_time: hhmm(cs), end_time: hhmm(ce), minutes: Math.max(1, Math.round((ce - cs) / 60000)), kwh,
        cost: Math.round(ch.reduce((a, k, h) => a + k * prices[h], 0) * 100), running: c.running && date === today() ? 1 : 0,
      });
    }
  }
  return { hours, hourCost, total, usages };
}

const dayBilled = (hid, date) => !!one('SELECT 1 FROM transactions WHERE household_id = ? AND estimate = 1 AND date = ? AND bill_id IS NOT NULL', hid, date);

// Guarda el resultado de un día. Devuelve false si no ha cambiado nada (no se reescribe ni se avisa).
function writeDay(hid, link, date, result, userId) {
  const name = (link.appliance_id && one('SELECT name FROM appliances WHERE id = ?', link.appliance_id)?.name) || link.name;
  const hours = result.hours.map((k, h) => ({ hour: h, kwh: Math.round(k * 10000) / 10000, cost: Math.round(result.hourCost[h] * 10000) / 100 })).filter((x) => x.kwh > 0.0005);
  const usages = result.usages.map((u) => ({
    appliance_id: link.appliance_id, name, start_time: u.start_time, end_time: u.end_time, minutes: u.minutes,
    kwh: Math.round(u.kwh * 1000) / 1000, cost: u.cost, running: u.running,
  }));
  const before = JSON.stringify([
    all(`SELECT appliance_id, name, start_time, end_time, minutes, kwh, cost, running FROM power_usages WHERE household_id = ? AND link_id = ? AND date = ? AND source = 'ha' ORDER BY id`, hid, link.id, date),
    all('SELECT hour, kwh, cost FROM ha_hourly WHERE link_id = ? AND date = ? ORDER BY hour', link.id, date),
  ]);
  if (before === JSON.stringify([usages, hours])) return false;
  tx(() => {
    run(`DELETE FROM power_usages WHERE household_id = ? AND link_id = ? AND date = ? AND source = 'ha'`, hid, link.id, date);
    run('DELETE FROM ha_hourly WHERE link_id = ? AND date = ?', link.id, date);
    for (const x of hours) run('INSERT INTO ha_hourly (link_id, date, hour, kwh, cost) VALUES (?, ?, ?, ?, ?)', link.id, date, x.hour, x.kwh, x.cost);
    for (const u of usages) {
      insert('power_usages', {
        household_id: hid, date, ...u, price_avg: u.kwh ? u.cost / 100 / u.kwh : null, source: 'ha', link_id: link.id,
        note: link.mode === 'continuous' ? 'Medido durante el día' : '', created_by: userId,
      });
    }
  })();
  syncPowerDay(hid, date, userId);
  return true;
}

// Lo anotado a mano de ese aparato antes de enlazar el enchufe queda sustituido por lo medido:
// no se borra, pero deja de sumarse (si no, los días recuperados contarían dos veces).
function supersedeManual(hid, link, date, measuredKwh) {
  const now = all('SELECT id FROM power_usages WHERE household_id = ? AND date = ? AND superseded_by = ?', hid, date, link.id).map((x) => x.id);
  const want = link.appliance_id && measuredKwh > 0.001
    ? all(
      `SELECT id FROM power_usages WHERE household_id = ? AND date = ? AND appliance_id = ? AND source != 'ha' AND created_at < ?
          AND (superseded_by IS NULL OR superseded_by = ?)`,
      hid, date, link.appliance_id, link.created_at, link.id,
    ).map((x) => x.id)
    : [];
  if (now.length === want.length && now.every((id) => want.includes(id))) return false;
  tx(() => {
    for (const id of now) if (!want.includes(id)) run('UPDATE power_usages SET superseded_by = NULL WHERE id = ?', id);
    for (const id of want) run('UPDATE power_usages SET superseded_by = ? WHERE id = ?', link.id, id);
  })();
  return true;
}

const syncing = new Set();

// Sincroniza un hogar: recalcula hoy y ayer (y los días pendientes de los enchufes nuevos).
export async function syncHousehold(hid, { force = false, userId = null } = {}) {
  const cfg = haConfig(hid);
  if (!isConfigured(cfg) || (!cfg.enabled && !force)) return null;
  if (syncing.has(hid)) return { busy: true };
  syncing.add(hid);
  const started = Date.now();
  let usages = 0;
  let kwh = 0;
  let changes = 0;
  try {
    const { url, token } = credentials(cfg);
    const links = all('SELECT * FROM ha_links WHERE household_id = ? AND enabled = 1', hid);
    if (!links.length) {
      Object.assign(cfg, { last_sync: new Date().toISOString(), last_ok: new Date().toISOString(), last_error: null });
      return { usages: 0, kwh: 0 };
    }
    const states = await haFetch(url, token, '/api/states', { timeout: 20000 });
    const units = {};
    const current = {};
    for (const s of states) {
      units[s.entity_id] = s.attributes?.unit_of_measurement || '';
      current[s.entity_id] = s;
    }
    const t = today();
    const plan = new Map(); // fecha → enlaces
    for (const l of links) {
      const back = Math.min(Math.max(Number(cfg.backfill) || 7, 1), 10);
      const days = l.backfilled ? [addDays(t, -1), t] : Array.from({ length: back }, (_, i) => addDays(t, i - back + 1));
      for (const d of days) {
        if (!plan.has(d)) plan.set(d, []);
        plan.get(d).push(l);
      }
    }
    for (const [date, ls] of [...plan.entries()].sort()) {
      const targets = ls.filter((l) => !dayBilled(hid, date));
      if (!targets.length) continue;
      // Precio real de ese día antes de calcular (si la tarifa es PVPC y aún no estaba descargado).
      if (powerSettings(hid).tariff === 'pvpc') await ensurePrices(date);
      const { from, to } = dayBounds(date);
      const entities = [...new Set(targets.flatMap((l) => [l.energy_entity, l.power_entity]).filter(Boolean))];
      const hist = await fetchHistory(url, token, entities, from, to);
      for (const l of targets) {
        const result = computeDay(hid, l, linkIntervals(l, hist, units, to), date);
        const replaced = supersedeManual(hid, l, date, result.total);
        const wrote = writeDay(hid, l, date, result, userId);
        if (replaced && !wrote) syncPowerDay(hid, date, userId);
        if (replaced || wrote) changes++;
        usages += result.usages.length;
        kwh += result.total;
      }
    }
    for (const l of links) {
      const cur = current[l.energy_entity || l.power_entity];
      run(`UPDATE ha_links SET backfilled = 1, last_value = ?, last_seen = ? WHERE id = ?`,
        cur && Number.isFinite(Number(cur.state)) ? Number(cur.state) : null, cur?.last_changed || null, l.id);
    }
    Object.assign(cfg, { last_sync: new Date().toISOString(), last_ok: new Date().toISOString(), last_error: null });
    insert('ha_sync_log', { household_id: hid, ok: 1, message: `${links.length} ${links.length === 1 ? 'enchufe' : 'enchufes'}, ${plan.size} ${plan.size === 1 ? 'día' : 'días'}`, cycles: usages, kwh: Math.round(kwh * 1000) / 1000, ms: Date.now() - started });
    if (changes) emit(hid, { entity: 'power', action: 'ha-sync', by: null });
    return { usages, kwh, days: plan.size, changes };
  } catch (e) {
    Object.assign(cfg, { last_sync: new Date().toISOString(), last_error: e.message });
    insert('ha_sync_log', { household_id: hid, ok: 0, message: e.message.slice(0, 300), ms: Date.now() - started });
    if (force) throw e;
    return { error: e.message };
  } finally {
    // Se relee por si mientras tanto se cambió la configuración.
    const fresh = haConfig(hid);
    if (fresh.url === cfg.url) saveHaConfig(hid, { ...fresh, last_sync: cfg.last_sync, last_ok: cfg.last_ok, last_error: cfg.last_error });
    run(`DELETE FROM ha_sync_log WHERE household_id = ? AND id NOT IN (SELECT id FROM ha_sync_log WHERE household_id = ? ORDER BY id DESC LIMIT 30)`, hid, hid);
    syncing.delete(hid);
  }
}

// Vista previa de la detección con unos ajustes, sin guardar nada.
export async function previewLink(hid, link, days = 3) {
  const cfg = haConfig(hid);
  const { url, token } = credentials(cfg);
  const states = await haFetch(url, token, '/api/states', { timeout: 20000 });
  const units = Object.fromEntries(states.map((s) => [s.entity_id, s.attributes?.unit_of_measurement || '']));
  const dates = Array.from({ length: days }, (_, i) => addDays(today(), i - days + 1));
  // La vista previa no espera más de unos segundos a Red Eléctrica: si tarda, se usa el precio estimado.
  if (powerSettings(hid).tariff === 'pvpc') {
    await Promise.race([Promise.all(dates.map((d) => ensurePrices(d))), new Promise((r) => setTimeout(r, 4000))]);
  }
  const out = [];
  for (const date of dates) {
    const { from, to } = dayBounds(date);
    const hist = await fetchHistory(url, token, [link.energy_entity, link.power_entity].filter(Boolean), from, to);
    const r = computeDay(hid, link, linkIntervals(link, hist, units, to), date);
    out.push({
      date, total: r.total, cost: Math.round(r.hourCost.reduce((a, b) => a + b, 0) * 100), usages: r.usages,
      hours: r.hours.map((k) => Math.round(k * 10000) / 10000),
    });
  }
  return out;
}

// Potencia en este momento de los enchufes enlazados.
export async function livePower(hid) {
  const cfg = haConfig(hid);
  const { url, token } = credentials(cfg);
  const links = all('SELECT * FROM ha_links WHERE household_id = ? AND enabled = 1', hid);
  const ids = [...new Set(links.flatMap((l) => [l.power_entity, l.energy_entity]).filter(Boolean))];
  const states = {};
  await Promise.all(ids.map(async (id) => {
    try {
      states[id] = await haFetch(url, token, `/api/states/${encodeURIComponent(id)}`, { timeout: 8000 });
    } catch (e) {
      states[id] = { error: e.message };
    }
  }));
  return links.map((l) => {
    const p = l.power_entity ? states[l.power_entity] : null;
    const unit = p?.attributes?.unit_of_measurement;
    const raw = p ? Number(p.state) : NaN;
    const watts = Number.isFinite(raw) ? (unit === 'kW' ? raw * 1000 : raw) : null;
    const e = l.energy_entity ? states[l.energy_entity] : null;
    return {
      link_id: l.id, watts, on: watts !== null ? watts >= l.threshold_w : null,
      available: p ? !p.error && !['unavailable', 'unknown'].includes(p.state) : e ? !e.error && !['unavailable', 'unknown'].includes(e.state) : false,
      energy: e && Number.isFinite(Number(e.state)) ? Number(e.state) : null, energy_unit: e?.attributes?.unit_of_measurement || null,
      updated: p?.last_changed || e?.last_changed || null, error: p?.error || e?.error || null,
    };
  });
}

// Sincronización periódica de todos los hogares según su intervalo.
export async function haScheduler() {
  for (const { id } of all(`SELECT id FROM households WHERE ha != '{}'`)) {
    const cfg = haConfig(id);
    if (!isConfigured(cfg) || !cfg.enabled) continue;
    const due = !cfg.last_sync || Date.now() - Date.parse(cfg.last_sync) >= (Number(cfg.interval) || 15) * 60000 - 30000;
    if (due) await syncHousehold(id).catch(() => {});
  }
}
