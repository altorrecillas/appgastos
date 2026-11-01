// Metas de ahorro ("huchas"): objetivo, fecha límite y aportaciones.
import express from 'express';
import { all, insert, one, run, update } from '../db.js';
import { bad, formatEuros, idParam, notFound, today, v, validate } from '../util.js';
import { changed } from '../events.js';

const r = express.Router();

const spec = {
  name: [v.str({ required: true, max: 60 }), 'Nombre'],
  icon: [v.emoji(), 'Icono'],
  color: [v.color(), 'Color'],
  target: [v.cents({ required: true, positive: true }), 'Objetivo'],
  deadline: [v.date(), 'Fecha objetivo'],
  notes: [v.str({ max: 1000 }), 'Notas'],
  archived: [v.bool(), 'Archivada'],
};

const SELECT = `
  SELECT g.*, (SELECT COALESCE(SUM(amount), 0) FROM goal_moves m WHERE m.goal_id = g.id) AS saved,
         (SELECT MAX(date) FROM goal_moves m WHERE m.goal_id = g.id) AS last_move
    FROM goals g`;

r.get('/', (req, res) => {
  const goals = all(`${SELECT} WHERE g.household_id = ? ORDER BY g.archived, g.deadline IS NULL, g.deadline, g.id`, req.hid);
  const moves = all(
    `SELECT m.*, u.display_name AS created_by_name FROM goal_moves m LEFT JOIN users u ON u.id = m.created_by
      WHERE m.household_id = ? ORDER BY m.date DESC, m.id DESC`,
    req.hid,
  );
  res.json(goals.map((g) => ({ ...g, moves: moves.filter((m) => m.goal_id === g.id) })));
});

r.post('/', (req, res) => {
  const data = validate(req.body, spec);
  const id = insert('goals', { ...data, household_id: req.hid });
  const initial = Number(req.body.initial) || 0;
  if (initial > 0) insert('goal_moves', { goal_id: id, household_id: req.hid, amount: Math.round(initial), date: today(), note: 'Saldo inicial', created_by: req.user.id });
  changed(req, 'goals', 'create', id, `${req.user.display_name} ha creado la meta ${data.name}`);
  res.status(201).json(one(`${SELECT} WHERE g.id = ?`, id));
});

r.patch('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const data = validate(req.body, spec, { partial: true });
  if (!update('goals', id, req.hid, data) && Object.keys(data).length) throw notFound('Meta');
  changed(req, 'goals', 'update', id);
  res.json(one(`${SELECT} WHERE g.id = ?`, id));
});

r.delete('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const g = one('SELECT name FROM goals WHERE id = ? AND household_id = ?', id, req.hid);
  if (!g) throw notFound('Meta');
  run('DELETE FROM goals WHERE id = ?', id);
  changed(req, 'goals', 'delete', id, `${req.user.display_name} ha borrado la meta ${g.name}`);
  res.json({ ok: true });
});

r.post('/:id/moves', (req, res) => {
  const id = idParam(req.params.id);
  const g = one('SELECT name FROM goals WHERE id = ? AND household_id = ?', id, req.hid);
  if (!g) throw notFound('Meta');
  const data = validate(req.body, {
    amount: [v.cents({ required: true, allowNegative: true }), 'Importe'],
    date: [v.date(), 'Fecha'],
    note: [v.str({ max: 120 }), 'Nota'],
  });
  if (!data.amount) throw bad('El importe no puede ser cero');
  insert('goal_moves', { ...data, date: data.date || today(), goal_id: id, household_id: req.hid, created_by: req.user.id });
  const verb = data.amount > 0 ? 'ha apartado' : 'ha retirado';
  changed(req, 'goals', 'move', id, `${req.user.display_name} ${verb} ${formatEuros(Math.abs(data.amount), req.household.currency)} en ${g.name}`);
  res.status(201).json(one(`${SELECT} WHERE g.id = ?`, id));
});

r.delete('/:id/moves/:mid', (req, res) => {
  const id = idParam(req.params.id);
  const n = run('DELETE FROM goal_moves WHERE id = ? AND goal_id = ? AND household_id = ?', idParam(req.params.mid), id, req.hid).changes;
  if (!n) throw notFound('Aportación');
  changed(req, 'goals', 'move', id);
  res.json({ ok: true });
});

export default r;
