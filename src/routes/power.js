// Consumo de luz: precio por horas, electrodomésticos, usos anotados y previsión de la factura.
import express from 'express';
import { all, insert, one, run, update } from '../db.js';
import { addDays, bad, daysInMonth, formatEuros, idParam, notFound, parseYmd, today, v, validate } from '../util.js';
import { changed } from '../events.js';
import { ensureRef } from './household.js';
import {
  dayPrices, ensurePrices, period2TD, powerCategory, powerSettings, syncBaseDays, syncPowerDay, usageCost,
} from '../power.js';

const r = express.Router();
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const kwhOf = (watts, minutes) => (watts * minutes) / 60 / 1000;
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);

// ---------- Ajustes de la tarifa ----------
r.get('/settings', (req, res) => res.json({ ...powerSettings(req.hid), category_id: powerCategory(req.hid) }));

r.patch('/settings', (req, res) => {
  const cur = powerSettings(req.hid);
  const d = validate(req.body, {
    tariff: [v.oneOf(['pvpc', 'fixed', 'periods'], { required: true }), 'Tarifa'],
    price: [v.num({ min: 0, max: 2 }), 'Precio por kWh'],
    taxes: [v.bool(), 'Impuestos'],
    vat: [v.num({ min: 0, max: 30 }), 'IVA'],
    base_kwh: [v.num({ min: 0, max: 100 }), 'Consumo base diario'],
    category_id: [v.int(), 'Categoría'],
  }, { partial: true });
  ensureRef('categories', d.category_id, req.hid, 'Categoría');
  const next = { ...cur, ...d, taxes: d.taxes === undefined ? cur.taxes : !!d.taxes };
  if (req.body.periods && typeof req.body.periods === 'object') {
    for (const k of ['punta', 'llano', 'valle']) {
      const n = Number(req.body.periods[k]);
      if (req.body.periods[k] !== undefined && (!Number.isFinite(n) || n < 0 || n > 2)) throw bad(`Precio ${k} no válido`);
      if (req.body.periods[k] !== undefined) next.periods[k] = n;
    }
  }
  if (next.base_kwh > 0 && !cur.since) next.since = today();
  if (!(next.base_kwh > 0)) next.since = null;
  run('UPDATE households SET power = ? WHERE id = ?', JSON.stringify(next), req.hid);
  // Los días aún no facturados se recalculan con la nueva configuración.
  const open = all('SELECT DISTINCT date FROM transactions WHERE household_id = ? AND estimate = 1 AND bill_id IS NULL', req.hid);
  for (const x of open) syncPowerDay(req.hid, x.date, req.user.id);
  for (const x of all('SELECT DISTINCT date FROM power_usages WHERE household_id = ? AND date >= ?', req.hid, addDays(today(), -62))) syncPowerDay(req.hid, x.date, req.user.id);
  syncBaseDays(req.hid);
  changed(req, 'power', 'settings', null, `${req.user.display_name} ha cambiado la tarifa de la luz`);
  res.json({ ...powerSettings(req.hid), category_id: powerCategory(req.hid) });
});

// ---------- Precios por horas ----------
async function pricesFor(hid, date) {
  const s = powerSettings(hid);
  let available = true;
  if (s.tariff === 'pvpc') available = await ensurePrices(date);
  const { prices, source } = dayPrices(hid, date, s);
  const order = prices.map((p, h) => ({ h, p })).sort((a, b) => a.p - b.p);
  return {
    date, prices, source, available, tariff: s.tariff,
    periods: s.tariff === 'periods' ? prices.map((_, h) => period2TD(date, h)) : null,
    min: order[0], max: order.at(-1), avg: prices.reduce((a, b) => a + b, 0) / prices.length,
  };
}

r.get('/prices', async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  const out = { today: await pricesFor(req.hid, date) };
  // Los precios de mañana se publican hacia las 20:30.
  const tomorrow = addDays(date, 1);
  if (date === today()) {
    const s = powerSettings(req.hid);
    if (s.tariff !== 'pvpc' || new Date().getHours() >= 20 || one('SELECT COUNT(*) AS n FROM power_prices WHERE date = ?', tomorrow).n >= 23) {
      const t = await pricesFor(req.hid, tomorrow);
      if (t.source !== 'estimate') out.tomorrow = t;
    }
  }
  res.json(out);
});

// ---------- Electrodomésticos ----------
const applianceSpec = {
  name: [v.str({ required: true, max: 40 }), 'Nombre'],
  icon: [v.emoji(), 'Icono'],
  watts: [v.int({ required: true, min: 1, max: 50000 }), 'Potencia'],
  minutes: [v.int({ min: 1, max: 1440 }), 'Duración habitual'],
  kwh_per_use: [v.num({ min: 0, max: 200 }), 'Consumo por uso'],
  archived: [v.bool(), 'Archivado'],
};

r.get('/appliances', (req, res) => {
  res.json(all(
    `SELECT a.*, (SELECT COUNT(*) FROM power_usages u WHERE u.appliance_id = a.id AND u.superseded_by IS NULL) AS uses,
            (SELECT COUNT(*) FROM ha_links h WHERE h.appliance_id = a.id AND h.enabled = 1) AS ha_linked,
            (SELECT MAX(date) FROM power_usages u WHERE u.appliance_id = a.id) AS last_used
       FROM appliances a WHERE a.household_id = ? ORDER BY a.archived, a.sort, a.id`,
    req.hid,
  ));
});

r.post('/appliances', (req, res) => {
  const d = validate(req.body, applianceSpec);
  const sort = one('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM appliances WHERE household_id = ?', req.hid).n;
  const id = insert('appliances', { ...d, household_id: req.hid, sort });
  changed(req, 'power', 'appliance', id);
  res.status(201).json(one('SELECT * FROM appliances WHERE id = ?', id));
});

r.patch('/appliances/:id', (req, res) => {
  const id = idParam(req.params.id);
  const d = validate(req.body, applianceSpec, { partial: true });
  if (!update('appliances', id, req.hid, d) && Object.keys(d).length) throw notFound('Electrodoméstico');
  changed(req, 'power', 'appliance', id);
  res.json(one('SELECT * FROM appliances WHERE id = ?', id));
});

r.delete('/appliances/:id', (req, res) => {
  const id = idParam(req.params.id);
  if (!run('DELETE FROM appliances WHERE id = ? AND household_id = ?', id, req.hid).changes) throw notFound('Electrodoméstico');
  changed(req, 'power', 'appliance', id);
  res.json({ ok: true });
});

// ---------- Usos anotados ----------
r.get('/usages', (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : addDays(today(), -31);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today();
  res.json(all(
    `SELECT u.*, COALESCE(a.icon, l.icon) AS icon, t.bill_id AS billed FROM power_usages u LEFT JOIN appliances a ON a.id = u.appliance_id
       LEFT JOIN ha_links l ON l.id = u.link_id
       LEFT JOIN transactions t ON t.household_id = u.household_id AND t.estimate = 1 AND t.date = u.date
      WHERE u.household_id = ? AND u.date BETWEEN ? AND ? ORDER BY u.date DESC, u.start_time DESC, u.id DESC`,
    req.hid, from, to,
  ));
});

r.post('/usages', async (req, res) => {
  const d = validate(req.body, {
    appliance_id: [v.int(), 'Electrodoméstico'],
    name: [v.str({ max: 40 }), 'Nombre'],
    date: [v.date({ required: true }), 'Fecha'],
    start_time: [v.str({ max: 5, pattern: TIME_RE }), 'Hora de inicio'],
    minutes: [v.int({ min: 1, max: 1440 }), 'Duración'],
    kwh: [v.num({ min: 0.001, max: 1000 }), 'Consumo'],
    watts: [v.int({ min: 1, max: 50000 }), 'Potencia'],
    uses: [v.int({ min: 1, max: 50 }), 'Veces'],
    note: [v.str({ max: 120 }), 'Nota'],
  });
  if (d.date > addDays(today(), 1)) throw bad('No se pueden anotar consumos futuros');
  const appl = d.appliance_id ? one('SELECT * FROM appliances WHERE id = ? AND household_id = ?', d.appliance_id, req.hid) : null;
  if (d.appliance_id && !appl) throw bad('Electrodoméstico no válido');
  const name = appl?.name || d.name;
  if (!name) throw bad('Indica qué has encendido');
  const uses = d.uses || 1;
  let minutes = d.minutes ?? (appl ? appl.minutes * uses : null);
  let kwh = d.kwh;
  if (!kwh) {
    if (appl?.kwh_per_use && d.minutes == null) kwh = appl.kwh_per_use * uses;
    else {
      const watts = d.watts || appl?.watts;
      if (!watts || !minutes) throw bad('Indica la duración o el consumo en kWh');
      kwh = kwhOf(watts, minutes);
    }
  }
  if (minutes != null && minutes > 1440) minutes = 1440;
  const s = powerSettings(req.hid);
  if (s.tariff === 'pvpc') await ensurePrices(d.date);
  const { prices } = dayPrices(req.hid, d.date, s);
  const { cost, avg } = usageCost(prices, d.start_time || null, minutes, kwh);
  const id = insert('power_usages', {
    household_id: req.hid, appliance_id: appl?.id ?? null, name, date: d.date, start_time: d.start_time || null, minutes,
    kwh: Math.round(kwh * 1000) / 1000, cost, price_avg: avg, note: d.note || '', created_by: req.user.id,
  });
  const day = syncPowerDay(req.hid, d.date, req.user.id);
  changed(req, 'power', 'usage', id, `${req.user.display_name} ha anotado ${name}: ${formatEuros(cost, req.household.currency)} de luz`);
  res.status(201).json({ usage: one('SELECT * FROM power_usages WHERE id = ?', id), day, billed: !!day?.bill_id });
});

r.delete('/usages/:id', (req, res) => {
  const id = idParam(req.params.id);
  const u = one('SELECT * FROM power_usages WHERE id = ? AND household_id = ?', id, req.hid);
  if (!u) throw notFound('Uso');
  run('DELETE FROM power_usages WHERE id = ?', id);
  syncPowerDay(req.hid, u.date, req.user.id);
  changed(req, 'power', 'usage', id);
  res.json({ ok: true, deleted: u });
});

// ---------- Previsión de la factura ----------
r.get('/summary', (req, res) => {
  syncBaseDays(req.hid);
  res.json(powerSummary(req.hid));
});

// Estimado de la luz desde la última factura, a qué ritmo va y la previsión de la próxima.
export function powerSummary(hid) {
  const s = powerSettings(hid);
  const t = today();
  const bills = all(
    `SELECT b.*, (SELECT COALESCE(SUM(amount), 0) FROM transactions x WHERE x.bill_id = b.id AND x.estimate = 1) AS absorbed,
            (SELECT COUNT(*) FROM transactions x WHERE x.bill_id = b.id AND x.estimate = 1) AS absorbed_days
       FROM bills b WHERE b.household_id = ? AND b.power = 1 ORDER BY COALESCE(b.period_end, b.issue_date, b.due_date) DESC LIMIT 6`,
    hid,
  );
  const lastEnd = bills.map((b) => b.period_end || b.issue_date || b.due_date).filter((d) => d && d < t).sort().at(-1);
  const from = lastEnd ? addDays(lastEnd, 1) : `${t.slice(0, 7)}-01`;
  const est = one(
    `SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM transactions WHERE household_id = ? AND estimate = 1 AND bill_id IS NULL AND date BETWEEN ? AND ?`,
    hid, from, t,
  );
  const usage = one('SELECT COALESCE(SUM(kwh), 0) AS kwh, COUNT(*) AS n FROM power_usages WHERE household_id = ? AND date BETWEEN ? AND ? AND superseded_by IS NULL', hid, from, t);
  const days = daysBetween(from, t) + 1;
  const baseDays = s.base_kwh > 0 && s.since ? Math.max(0, daysBetween(s.since > from ? s.since : from, t) + 1) : 0;
  const lengths = bills.filter((b) => b.period_start && b.period_end).map((b) => daysBetween(b.period_start, b.period_end) + 1);
  const periodDays = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : daysInMonth(Number(t.slice(0, 4)), Number(t.slice(5, 7)));
  const projected = Math.round((est.s / days) * periodDays);
  // Qué parte de cada factura suele estar cubierta por lo que se anota (el resto: luces, stand-by…).
  const covered = bills.filter((b) => b.status === 'paid' && b.absorbed > 0 && b.absorbed_days >= 7).slice(0, 3);
  const coverage = covered.length ? covered.reduce((a, b) => a + b.absorbed / b.amount, 0) / covered.length : null;
  const recentBills = bills.filter((b) => b.amount > 0).slice(0, 3);
  const avgBill = recentBills.length ? Math.round(recentBills.reduce((a, b) => a + b.amount, 0) / recentBills.length) : null;
  return {
    from, to: t, days, periodDays, estimated: est.s, estimatedDays: est.n, kwh: Math.round((usage.kwh + baseDays * s.base_kwh) * 10) / 10,
    usages: usage.n, projected, coverage, predicted: coverage ? Math.round(projected / Math.max(coverage, 0.05)) : null, avgBill,
    bills: bills.map((b) => ({ id: b.id, supplier: b.supplier, amount: b.amount, status: b.status, period_start: b.period_start, period_end: b.period_end, absorbed: b.absorbed })),
    settings: { ...s, category_id: powerCategory(hid, s) },
  };
}

export default r;
