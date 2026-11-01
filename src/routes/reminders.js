// Recordatorios propios: pagos puntuales y fechas importantes (ITV, renovar el seguro, cumpleaños…).
import express from 'express';
import { all, insert, one, run, tx, update } from '../db.js';
import { METHODS, bad, formatEuros, idParam, nextOccurrence, notFound, today, v, validate } from '../util.js';
import { changed } from '../events.js';
import { ensureRef } from './household.js';
import { createTransaction } from './transactions.js';

const r = express.Router();
export const REPEATS = ['none', 'weekly', 'monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual'];

const spec = {
  title: [v.str({ required: true, max: 80 }), 'Título'],
  kind: [v.oneOf(['payment', 'date'], { required: true }), 'Tipo'],
  date: [v.date({ required: true }), 'Fecha'],
  amount: [v.cents(), 'Importe'],
  category_id: [v.int(), 'Categoría'],
  person_id: [v.int(), 'Persona'],
  repeat: [v.oneOf(REPEATS, { required: true }), 'Repetición'],
  remind_days: [v.int({ min: 0, max: 90 }), 'Días de antelación'],
  remind_time: [v.str({ max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }), 'Hora del aviso'],
  notes: [v.str({ max: 1000 }), 'Notas'],
};
// Sin hora (vacío), el aviso sale a la hora de los avisos del día.
const cleanTime = (d) => {
  if (d.remind_time === '') d.remind_time = null;
  return d;
};

const SELECT = `
  SELECT m.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color, p.name AS person_name, p.emoji AS person_emoji,
         u.display_name AS created_by_name
    FROM reminders m
    LEFT JOIN categories c ON c.id = m.category_id
    LEFT JOIN people p ON p.id = m.person_id
    LEFT JOIN users u ON u.id = m.created_by`;

// Fechas de un recordatorio dentro de [from, to] (los repetitivos se expanden).
export function reminderDates(rem, from, to, max = 60) {
  if (rem.done_at) return [];
  if (rem.repeat === 'none') return rem.date >= from && rem.date <= to ? [rem.date] : [];
  const out = [];
  let d = rem.date;
  for (let i = 0; i < max && d <= to; i++) {
    if (d >= from) out.push(d);
    d = nextOccurrence(rem.repeat, d, rem.date);
  }
  return out;
}

export const activeReminders = (hid) => all(`${SELECT} WHERE m.household_id = ? AND m.done_at IS NULL ORDER BY m.date`, hid);

function checkRefs(d, hid) {
  ensureRef('categories', d.category_id, hid, 'Categoría');
  ensureRef('people', d.person_id, hid, 'Persona');
}

r.get('/', (req, res) => {
  const active = activeReminders(req.hid);
  const done = all(`${SELECT} WHERE m.household_id = ? AND m.done_at IS NOT NULL ORDER BY m.done_at DESC LIMIT 30`, req.hid);
  res.json({ active, done });
});

r.post('/', (req, res) => {
  const data = cleanTime(validate(req.body, spec));
  checkRefs(data, req.hid);
  if (data.kind === 'date') data.amount = null;
  const id = insert('reminders', { ...data, household_id: req.hid, created_by: req.user.id });
  changed(req, 'reminders', 'create', id, `${req.user.display_name} ha creado el recordatorio «${data.title}»`);
  res.status(201).json(one(`${SELECT} WHERE m.id = ?`, id));
});

r.patch('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const data = cleanTime(validate(req.body, spec, { partial: true }));
  checkRefs(data, req.hid);
  if (!update('reminders', id, req.hid, data) && Object.keys(data).length) throw notFound('Recordatorio');
  changed(req, 'reminders', 'update', id);
  res.json(one(`${SELECT} WHERE m.id = ?`, id));
});

r.delete('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const m = one('SELECT title FROM reminders WHERE id = ? AND household_id = ?', id, req.hid);
  if (!m) throw notFound('Recordatorio');
  run('DELETE FROM reminders WHERE id = ?', id);
  changed(req, 'reminders', 'delete', id, `${req.user.display_name} ha borrado el recordatorio «${m.title}»`);
  res.json({ ok: true });
});

// Marcar como hecho. Si se repite, pasa a la siguiente fecha. Opcionalmente anota el pago.
r.post('/:id/done', (req, res) => {
  const id = idParam(req.params.id);
  const m = one('SELECT * FROM reminders WHERE id = ? AND household_id = ?', id, req.hid);
  if (!m) throw notFound('Recordatorio');
  const body = validate(req.body || {}, {
    amount: [v.cents(), 'Importe'],
    date: [v.date(), 'Fecha'],
    method: [v.oneOf(METHODS), 'Forma de pago'],
    category_id: [v.int(), 'Categoría'],
  });
  ensureRef('categories', body.category_id, req.hid, 'Categoría');
  const register = !!req.body?.register;
  const amount = body.amount ?? m.amount;
  if (register && !(amount > 0)) throw bad('Indica el importe para anotar el pago');
  tx(() => {
    if (register) {
      createTransaction(req, {
        kind: 'expense', amount, date: body.date || today(), description: m.title, category_id: body.category_id ?? m.category_id,
        person_id: m.person_id, method: body.method || null,
      });
    }
    if (m.repeat === 'none') run(`UPDATE reminders SET done_at = datetime('now') WHERE id = ?`, id);
    else run('UPDATE reminders SET date = ? WHERE id = ?', nextOccurrence(m.repeat, m.date, m.date), id);
  })();
  const extra = register ? ` y ha anotado ${formatEuros(amount, req.household.currency)}` : '';
  changed(req, 'reminders', 'done', id, `${req.user.display_name} ha marcado «${m.title}» como hecho${extra}`);
  res.json({ ...one(`${SELECT} WHERE m.id = ?`, id), previous_date: m.date });
});

r.post('/:id/undo', (req, res) => {
  const id = idParam(req.params.id);
  if (!run('UPDATE reminders SET done_at = NULL WHERE id = ? AND household_id = ?', id, req.hid).changes) throw notFound('Recordatorio');
  changed(req, 'reminders', 'update', id);
  res.json(one(`${SELECT} WHERE m.id = ?`, id));
});

export default r;
