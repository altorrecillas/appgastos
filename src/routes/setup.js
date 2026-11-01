// Asistente de primer uso: deja la casa lista de una vez (ingresos, pagos fijos, presupuesto y familia).
import express from 'express';
import { all, insert, one, run, tx } from '../db.js';
import { FREQUENCIES, METHODS, addDays, bad, today, v, validate } from '../util.js';
import { changed } from '../events.js';
import { atLeast } from './household.js';
import { processDue } from './recurring.js';

const r = express.Router();
const pad = (n) => String(n).padStart(2, '0');

// Próxima fecha (hoy incluido) con ese día del mes; en meses más cortos, el último día.
function nextDay(day) {
  const t = new Date(`${today()}T12:00`);
  for (let k = 0; k < 2; k++) {
    const y = t.getFullYear();
    const m = t.getMonth() + k;
    const last = new Date(y, m + 1, 0).getDate();
    const d = new Date(y, m, Math.min(day, last), 12);
    const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (s >= today()) return s;
  }
  return addDays(today(), 30);
}

const itemSpec = {
  name: [v.str({ required: true, max: 60 }), 'Nombre'],
  amount: [v.cents({ required: true, positive: true }), 'Importe'],
  category: [v.str({ max: 60 }), 'Categoría'],
  frequency: [v.oneOf(FREQUENCIES), 'Frecuencia'],
  day: [v.int({ min: 1, max: 31 }), 'Día'],
  next_date: [v.date(), 'Próximo pago'],
  variable: [v.bool(), 'Importe variable'],
  method: [v.oneOf(METHODS), 'Forma de pago'],
  person_id: [v.int(), 'Persona'],
};

r.post('/', atLeast('admin'), (req, res) => {
  const body = req.body || {};
  const house = validate(body.house || {}, {
    name: [v.str({ max: 60 }), 'Nombre del hogar'], icon: [v.emoji(), 'Icono'], color: [v.color(), 'Color'],
  }, { partial: true });
  const items = [
    ...(Array.isArray(body.incomes) ? body.incomes.slice(0, 20) : []).map((x) => ({ ...validate(x, itemSpec), kind: 'income' })),
    ...(Array.isArray(body.fixed) ? body.fixed.slice(0, 60) : []).map((x) => ({ ...validate(x, itemSpec), kind: 'expense' })),
  ];
  const people = (Array.isArray(body.people) ? body.people.slice(0, 12) : [])
    .map((p) => validate(p, { name: [v.str({ required: true, max: 40 }), 'Nombre'], emoji: [v.emoji(), 'Emoji'] }));
  const budget = body.budget === null || body.budget === undefined ? undefined : validate({ b: body.budget }, { b: [v.cents(), 'Presupuesto'] }).b;
  const cats = all('SELECT id, kind, name FROM categories WHERE household_id = ? AND archived = 0', req.hid);
  const catId = (kind, name) => cats.find((c) => c.kind === kind && c.name.toLowerCase() === String(name || '').toLowerCase())?.id ?? null;
  for (const it of items) {
    if (it.person_id && !one('SELECT 1 FROM people WHERE id = ? AND household_id = ?', it.person_id, req.hid)) throw bad('Persona no válida');
  }
  const created = tx(() => {
    if (house.name) run('UPDATE households SET name = ? WHERE id = ?', house.name, req.hid);
    if (house.icon) run('UPDATE households SET icon = ? WHERE id = ?', house.icon, req.hid);
    if (house.color) run('UPDATE households SET color = ? WHERE id = ?', house.color, req.hid);
    for (const p of people) {
      if (one('SELECT 1 FROM people WHERE household_id = ? AND ulower(name) = ulower(?)', req.hid, p.name)) continue;
      const sort = one('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM people WHERE household_id = ?', req.hid).n;
      insert('people', { household_id: req.hid, name: p.name, emoji: p.emoji || '🙂', sort });
    }
    const ids = items.map((it) => {
      const frequency = it.frequency || 'monthly';
      const start = it.next_date || nextDay(it.day || 1);
      return insert('recurring', {
        household_id: req.hid, kind: it.kind, plan: 'fixed', name: it.name, amount: it.amount, variable: it.variable || 0,
        category_id: catId(it.kind, it.category), person_id: it.person_id ?? null, method: it.method || (it.kind === 'income' ? 'transfer' : 'direct_debit'),
        frequency, start_date: start, next_date: start, auto: 1, remind_days: it.kind === 'income' ? 0 : 3, active: 1, created_by: req.user.id,
      });
    });
    if (budget !== undefined) run('UPDATE households SET monthly_budget = ? WHERE id = ?', budget, req.hid);
    run('UPDATE households SET setup_done = 1 WHERE id = ?', req.hid);
    return ids.length;
  })();
  processDue(req.hid);
  changed(req, 'household', 'setup', req.hid, `${req.user.display_name} ha preparado la casa: ${created} pagos e ingresos fijos`);
  res.json({ created, people: people.length });
});

r.post('/skip', atLeast('admin'), (req, res) => {
  run('UPDATE households SET setup_done = 1 WHERE id = ?', req.hid);
  res.json({ ok: true });
});

export default r;
