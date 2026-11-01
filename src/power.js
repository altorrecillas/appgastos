// Consumo eléctrico: precio regulado por horas (PVPC de Red Eléctrica), coste de cada uso
// de un electrodoméstico y gasto diario estimado que luego queda dentro de la factura de la luz.
import { all, insert, one, run, tx } from './db.js';
import { safeJson } from './auth.js';
import { addDays, formatEuros, parseYmd, today } from './util.js';

// Impuesto especial sobre la electricidad.
export const IEE = 0.0511269632;
export const DEFAULT_POWER = {
  tariff: 'pvpc', // pvpc | fixed | periods
  price: 0.15, // €/kWh sin impuestos (tarifa fija)
  periods: { punta: 0.22, llano: 0.15, valle: 0.09 },
  taxes: true,
  vat: 21,
  base_kwh: 0, // consumo diario que no se anota (nevera, router, stand-by…)
  since: null,
  category_id: null,
};

export function powerSettings(hid) {
  const row = one('SELECT power FROM households WHERE id = ?', hid);
  const s = { ...DEFAULT_POWER, ...safeJson(row?.power) };
  s.periods = { ...DEFAULT_POWER.periods, ...(s.periods || {}) };
  return s;
}

// ---------- Precios PVPC ----------
const failed = new Map();
export async function ensurePrices(date) {
  if (one('SELECT COUNT(*) AS n FROM power_prices WHERE date = ?', date).n >= 23) return true;
  if (Date.now() - (failed.get(date) || 0) < 20 * 60 * 1000) return false;
  try {
    const url = `https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=${date}T00:00&end_date=${date}T23:59&time_trunc=hour`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`REE ${res.status}`);
    const data = await res.json();
    const pvpc = (data.included || []).find((x) => x.id === '1001' || x.type === 'PVPC');
    const byHour = new Map();
    for (const v of pvpc?.attributes?.values || []) {
      if (!String(v.datetime).startsWith(date)) continue;
      const h = Number(v.datetime.slice(11, 13));
      byHour.set(h, [...(byHour.get(h) || []), v.value / 1000]);
    }
    if (byHour.size < 23) throw new Error('Datos incompletos');
    tx(() => {
      for (const [h, arr] of byHour) {
        run('INSERT OR REPLACE INTO power_prices (date, hour, price) VALUES (?, ?, ?)', date, h, arr.reduce((a, b) => a + b, 0) / arr.length);
      }
    })();
    repriceDate(date);
    return true;
  } catch {
    failed.set(date, Date.now());
    return false;
  }
}

// Tramo horario de la tarifa 2.0TD: fines de semana y de 0 a 8 h, valle; 10–14 y 18–22, punta; resto, llano.
export function period2TD(date, hour) {
  const wd = parseYmd(date).getDay();
  if (wd === 0 || wd === 6 || hour < 8) return 'valle';
  if ((hour >= 10 && hour < 14) || (hour >= 18 && hour < 22)) return 'punta';
  return 'llano';
}

const withTaxes = (p, s) => (s.taxes ? p * (1 + IEE) * (1 + (Number(s.vat) || 0) / 100) : p);

// 24 precios €/kWh (con impuestos si así está configurado) para un día.
export function dayPrices(hid, date, s = powerSettings(hid)) {
  let raw;
  let source;
  if (s.tariff === 'fixed') {
    raw = Array(24).fill(Number(s.price) || 0);
    source = 'fixed';
  } else if (s.tariff === 'periods') {
    raw = Array.from({ length: 24 }, (_, h) => Number(s.periods[period2TD(date, h)]) || 0);
    source = 'periods';
  } else {
    const rows = all('SELECT hour, price FROM power_prices WHERE date = ? ORDER BY hour', date);
    if (rows.length >= 20) {
      const avg = rows.reduce((a, r) => a + r.price, 0) / rows.length;
      raw = Array.from({ length: 24 }, (_, h) => rows.find((r) => r.hour === h)?.price ?? avg);
      source = 'pvpc';
    } else {
      // Sin datos de ese día: media de los últimos días conocidos (o el precio fijo configurado).
      const recent = all('SELECT hour, AVG(price) AS price FROM power_prices WHERE date >= ? GROUP BY hour', addDays(date, -10));
      raw = recent.length >= 20
        ? Array.from({ length: 24 }, (_, h) => recent.find((r) => r.hour === h)?.price ?? recent[0].price)
        : Array(24).fill(Number(s.price) || DEFAULT_POWER.price);
      source = 'estimate';
    }
  }
  return { prices: raw.map((p) => withTaxes(p, s)), source };
}

// Coste de un consumo repartido por las horas en que ocurre. Sin hora de inicio se usa la media del día.
export function usageCost(prices, startTime, minutes, kwh) {
  if (!kwh) return { cost: 0, avg: 0 };
  if (!startTime || !minutes) {
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return { cost: Math.round(kwh * avg * 100), avg };
  }
  const [h, m] = startTime.split(':').map(Number);
  let t = h * 60 + (m || 0);
  let left = minutes;
  let euros = 0;
  while (left > 0) {
    const inHour = Math.min(60 - (t % 60), left);
    euros += (kwh * inHour / minutes) * prices[Math.floor(t / 60) % 24];
    t += inHour;
    left -= inHour;
  }
  return { cost: Math.round(euros * 100), avg: euros / kwh };
}

export function powerCategory(hid, s = powerSettings(hid)) {
  if (s.category_id && one('SELECT 1 FROM categories WHERE id = ? AND household_id = ?', s.category_id, hid)) return s.category_id;
  return one(
    `SELECT id FROM categories WHERE household_id = ? AND kind = 'expense' AND archived = 0
      ORDER BY CASE WHEN lower(name) LIKE '%luz%' THEN 0 WHEN lower(name) LIKE '%suministro%' THEN 1 ELSE 2 END, sort LIMIT 1`,
    hid,
  )?.id ?? null;
}

const fmtMinutes = (m) => (!m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

// Rehace el movimiento «Consumo de luz (estimado)» de un día con los usos anotados y el consumo base.
// Si ese día ya está incluido en una factura de la luz, no se toca.
export function syncPowerDay(hid, date, userId = null) {
  const s = powerSettings(hid);
  const existing = one('SELECT * FROM transactions WHERE household_id = ? AND estimate = 1 AND date = ?', hid, date);
  if (existing?.bill_id) return existing;
  const usages = all('SELECT * FROM power_usages WHERE household_id = ? AND date = ? AND superseded_by IS NULL ORDER BY start_time, id', hid, date);
  let total = usages.reduce((a, u) => a + u.cost, 0);
  const lines = usages.map((u) => `${u.name}${u.start_time ? ` a las ${u.start_time}` : ''}${u.minutes ? `, ${fmtMinutes(u.minutes)}` : ''} (${String(Math.round(u.kwh * 100) / 100).replace('.', ',')} kWh): ${formatEuros(u.cost)}`);
  if (s.base_kwh > 0 && s.since && date >= s.since && date <= today()) {
    const { prices } = dayPrices(hid, date, s);
    const base = Math.round(s.base_kwh * (prices.reduce((a, b) => a + b, 0) / 24) * 100);
    total += base;
    lines.push(`Consumo base (nevera, router…) ${String(s.base_kwh).replace('.', ',')} kWh: ${formatEuros(base)}`);
  }
  if (!total) {
    if (existing) run('DELETE FROM transactions WHERE id = ?', existing.id);
    return null;
  }
  const data = { amount: total, notes: lines.join('\n').slice(0, 1000), category_id: powerCategory(hid, s) };
  if (existing) {
    run(`UPDATE transactions SET amount = ?, notes = ?, category_id = ?, updated_at = datetime('now') WHERE id = ?`, data.amount, data.notes, data.category_id, existing.id);
    return { ...existing, ...data };
  }
  const id = insert('transactions', {
    household_id: hid, kind: 'expense', date, description: 'Consumo de luz (estimado)', method: 'direct_debit', estimate: 1, created_by: userId, ...data,
  });
  return one('SELECT * FROM transactions WHERE id = ?', id);
}

// Uso medido por Home Assistant: su coste se reparte según el consumo real de cada hora.
function measuredCost(u, prices) {
  const rows = all('SELECT hour, kwh FROM ha_hourly WHERE link_id = ? AND date = ?', u.link_id, u.date);
  const hourOf = (t) => Number(t.slice(0, 2));
  const from = u.start_time ? hourOf(u.start_time) : 0;
  let to = 23;
  if (u.end_time && u.end_time !== '00:00') to = hourOf(u.end_time) - (u.end_time.endsWith(':00') ? 1 : 0);
  const sel = rows.filter((r) => r.hour >= from && r.hour <= Math.max(from, to));
  const total = sel.reduce((a, r) => a + r.kwh, 0);
  if (!(total > 0) || !u.kwh) return null;
  const euros = sel.reduce((a, r) => a + (r.kwh / total) * u.kwh * prices[r.hour], 0);
  return { cost: Math.round(euros * 100), avg: euros / u.kwh };
}

// Cuando llegan los precios reales de un día, los usos anotados antes con un precio aproximado
// (y aún no incluidos en una factura) se recalculan.
function repriceDate(date) {
  const rows = all(
    `SELECT u.* FROM power_usages u
      WHERE u.date = ? AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.household_id = u.household_id AND t.estimate = 1 AND t.date = u.date AND t.bill_id IS NOT NULL)`,
    date,
  );
  const touched = new Set();
  for (const u of rows) {
    const s = powerSettings(u.household_id);
    if (s.tariff !== 'pvpc') continue;
    const { prices } = dayPrices(u.household_id, date, s);
    const { cost, avg } = (u.source === 'ha' && u.link_id && measuredCost(u, prices)) || usageCost(prices, u.start_time, u.minutes, u.kwh);
    if (cost !== u.cost) run('UPDATE power_usages SET cost = ?, price_avg = ? WHERE id = ?', cost, avg, u.id);
    touched.add(u.household_id);
  }
  for (const l of all('SELECT DISTINCT l.id, l.household_id FROM ha_hourly h JOIN ha_links l ON l.id = h.link_id WHERE h.date = ?', date)) {
    const s = powerSettings(l.household_id);
    if (s.tariff !== 'pvpc') continue;
    const { prices } = dayPrices(l.household_id, date, s);
    for (const h of all('SELECT hour, kwh FROM ha_hourly WHERE link_id = ? AND date = ?', l.id, date)) {
      run('UPDATE ha_hourly SET cost = ? WHERE link_id = ? AND date = ? AND hour = ?', Math.round(h.kwh * prices[h.hour] * 10000) / 100, l.id, date, h.hour);
    }
  }
  for (const hid of all('SELECT DISTINCT household_id AS h FROM transactions WHERE estimate = 1 AND date = ? AND bill_id IS NULL', date).map((x) => x.h)) touched.add(hid);
  for (const hid of touched) syncPowerDay(hid, date);
}

// Rellena el consumo base de los días transcurridos (lo llama el planificador).
export function syncBaseDays(hid) {
  const s = powerSettings(hid);
  if (!(s.base_kwh > 0) || !s.since) return;
  const from = s.since > addDays(today(), -62) ? s.since : addDays(today(), -62);
  for (let d = from; d <= today(); d = addDays(d, 1)) {
    if (!one('SELECT 1 FROM transactions WHERE household_id = ? AND estimate = 1 AND date = ?', hid, d)) syncPowerDay(hid, d);
  }
}

// Periodo que cubre una factura de la luz para descontar lo ya estimado.
export function billPeriod(hid, bill) {
  const to = bill.period_end || bill.issue_date || bill.due_date || today();
  let from = bill.period_start;
  if (!from) {
    const prev = one(
      `SELECT MAX(COALESCE(period_end, issue_date, due_date)) AS d FROM bills WHERE household_id = ? AND power = 1 AND id != ? AND COALESCE(period_end, issue_date, due_date) < ?`,
      hid, bill.id || 0, to,
    )?.d;
    from = prev ? addDays(prev, 1) : addDays(to, -31);
  }
  return { from, to };
}

export const pendingEstimates = (hid, from, to) => one(
  `SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM transactions
    WHERE household_id = ? AND estimate = 1 AND bill_id IS NULL AND date BETWEEN ? AND ?`,
  hid, from, to,
);

// Al pagar la factura de la luz, los estimados del periodo pasan a formar parte de ella.
// Devuelve lo que queda por anotar (factura − estimados). Si lo estimado supera la factura, se ajusta a la baja.
export function absorbEstimates(hid, bill) {
  const { from, to } = billPeriod(hid, bill);
  const ests = all(
    `SELECT id, amount FROM transactions WHERE household_id = ? AND estimate = 1 AND bill_id IS NULL AND date BETWEEN ? AND ? ORDER BY date`,
    hid, from, to,
  );
  const sum = ests.reduce((a, e) => a + e.amount, 0);
  if (sum <= bill.amount) {
    for (const e of ests) run('UPDATE transactions SET bill_id = ? WHERE id = ?', bill.id, e.id);
    return { estimated: sum, rest: bill.amount - sum, days: ests.length, from, to };
  }
  let acc = 0;
  ests.forEach((e, i) => {
    const amt = i === ests.length - 1 ? bill.amount - acc : Math.round((e.amount * bill.amount) / sum);
    acc += amt;
    run('UPDATE transactions SET amount = ?, bill_id = ? WHERE id = ?', amt, bill.id, e.id);
  });
  return { estimated: sum, rest: 0, days: ests.length, from, to, scaled: true };
}

// Deshace lo anterior (factura desmarcada, editada o borrada): los días vuelven a su estimación.
export function releaseEstimates(hid, billId) {
  const days = all('SELECT date FROM transactions WHERE household_id = ? AND estimate = 1 AND bill_id = ?', hid, billId);
  run('UPDATE transactions SET bill_id = NULL WHERE household_id = ? AND estimate = 1 AND bill_id = ?', hid, billId);
  for (const d of days) syncPowerDay(hid, d.date);
}

export const isPowerBillGuess = (b) => /luz|electric|eléctric/i.test(`${b.concept} ${b.supplier}`) || (b.unit === 'kWh' && !/gas/i.test(`${b.concept} ${b.supplier}`));
