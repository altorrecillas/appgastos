// Reglas de categorías: sugerir, ver, ajustar a mano y aplicar a lo que está sin categoría.
import express from 'express';
import { all, one, run, tx } from '../db.js';
import { bad, idParam, notFound, v, validate } from '../util.js';
import { changed } from '../events.js';
import { categorizer, forgetHistory, keyOf, normalizePattern } from '../categorize.js';
import { ensureRef } from './household.js';

const r = express.Router();

const SELECT = `
  SELECT r.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
    FROM category_rules r JOIN categories c ON c.id = r.category_id`;

r.get('/', (req, res) => {
  res.json(all(`${SELECT} WHERE r.household_id = ? ORDER BY r.source = 'manual' DESC, r.hits DESC, r.pattern`, req.hid));
});

// Sugerencias para varios textos a la vez (importar del banco, ticket, formulario).
r.post('/categorize', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 5000) : [];
  const guess = categorizer(req.hid);
  res.json(items.map((it) => {
    const text = String(it?.text || '').slice(0, 300);
    return { key: keyOf(text), ...(guess(text, it?.kind === 'income' ? 'income' : 'expense') || { category_id: null }) };
  }));
});

const spec = {
  pattern: [v.str({ required: true, max: 60 }), 'Texto'],
  kind: [v.oneOf(['expense', 'income'], { required: true }), 'Tipo'],
  category_id: [v.int({ required: true }), 'Categoría'],
};

function checkCategory(hid, kind, categoryId) {
  ensureRef('categories', categoryId, hid, 'Categoría');
  if (one('SELECT kind FROM categories WHERE id = ?', categoryId).kind !== kind) {
    throw bad(kind === 'expense' ? 'Esa categoría es de ingresos' : 'Esa categoría es de gastos');
  }
}

r.post('/', (req, res) => {
  const d = validate(req.body, spec);
  const pattern = normalizePattern(d.pattern);
  if (!pattern) throw bad('Escribe una palabra del comercio o del concepto (por ejemplo, MERCADONA)');
  checkCategory(req.hid, d.kind, d.category_id);
  run(
    `INSERT INTO category_rules (household_id, kind, pattern, category_id, source) VALUES (?, ?, ?, ?, 'manual')
     ON CONFLICT (household_id, kind, pattern) DO UPDATE SET category_id = excluded.category_id, source = 'manual', updated_at = datetime('now')`,
    req.hid, d.kind, pattern, d.category_id,
  );
  forgetHistory(req.hid);
  changed(req, 'rules', 'create');
  res.status(201).json(one(`${SELECT} WHERE r.household_id = ? AND r.kind = ? AND r.pattern = ?`, req.hid, d.kind, pattern));
});

r.patch('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const cur = one('SELECT * FROM category_rules WHERE id = ? AND household_id = ?', id, req.hid);
  if (!cur) throw notFound('Regla');
  const d = validate(req.body, { category_id: spec.category_id }, { partial: true });
  if (d.category_id) checkCategory(req.hid, cur.kind, d.category_id);
  run(`UPDATE category_rules SET category_id = ?, source = 'manual', updated_at = datetime('now') WHERE id = ?`, d.category_id ?? cur.category_id, id);
  forgetHistory(req.hid);
  changed(req, 'rules', 'update', id);
  res.json(one(`${SELECT} WHERE r.id = ?`, id));
});

r.delete('/:id', (req, res) => {
  const id = idParam(req.params.id);
  if (!run('DELETE FROM category_rules WHERE id = ? AND household_id = ?', id, req.hid).changes) throw notFound('Regla');
  forgetHistory(req.hid);
  changed(req, 'rules', 'delete', id);
  res.json({ ok: true });
});

// Pone categoría a los movimientos que no la tienen (con dry=1 solo cuenta cuántos y cuáles).
r.post('/apply', (req, res) => {
  const guess = categorizer(req.hid);
  const rows = all(
    `SELECT id, kind, description, merchant FROM transactions WHERE household_id = ? AND category_id IS NULL AND estimate = 0 ORDER BY date DESC LIMIT 5000`,
    req.hid,
  );
  const found = [];
  for (const t of rows) {
    const g = guess(`${t.merchant} ${t.description}`, t.kind);
    if (g && g.confidence >= 0.7) found.push({ id: t.id, category_id: g.category_id });
  }
  if (!req.body?.dry && found.length) {
    tx(() => found.forEach((f) => run(`UPDATE transactions SET category_id = ?, updated_at = datetime('now') WHERE id = ?`, f.category_id, f.id)))();
    changed(req, 'transactions', 'update', null, `${req.user.display_name} ha puesto categoría a ${found.length} movimientos`);
  }
  res.json({ uncategorized: rows.length, matched: found.length, applied: req.body?.dry ? 0 : found.length });
});

export default r;
