// Movimientos: gastos e ingresos del hogar.
import express from 'express';
import { all, db, insert, normText, one, run, tx, update } from '../db.js';
import { METHODS, bad, formatEuros, idParam, notFound, v, validate } from '../util.js';
import { changed } from '../events.js';
import { ensureRef } from './household.js';
import { releaseEstimates } from '../power.js';
import { keyOf, learn } from '../categorize.js';

const r = express.Router();
const ESTIMATE_MSG = 'Es el consumo de luz estimado de ese día: se cambia desde «Consumo de luz», añadiendo o quitando usos.';

export const txSpec = {
  kind: [v.oneOf(['expense', 'income'], { required: true }), 'Tipo'],
  amount: [v.cents({ required: true, positive: true }), 'Importe'],
  date: [v.date({ required: true }), 'Fecha'],
  description: [v.str({ max: 120 }), 'Descripción'],
  merchant: [v.str({ max: 80 }), 'Comercio'],
  category_id: [v.int(), 'Categoría'],
  person_id: [v.int(), 'Persona'],
  pet_id: [v.int(), 'Mascota'],
  method: [v.oneOf(METHODS), 'Forma de pago'],
  notes: [v.str({ max: 1000 }), 'Notas'],
  attachment_id: [v.int(), 'Adjunto'],
};

export function checkTxRefs(data, hid) {
  ensureRef('categories', data.category_id, hid, 'Categoría');
  ensureRef('people', data.person_id, hid, 'Persona');
  ensureRef('pets', data.pet_id, hid, 'Mascota');
  ensureRef('attachments', data.attachment_id, hid, 'Adjunto');
  if (data.category_id && data.kind) {
    const c = one('SELECT kind FROM categories WHERE id = ?', data.category_id);
    if (c.kind !== data.kind) throw bad(data.kind === 'expense' ? 'Esa categoría es de ingresos' : 'Esa categoría es de gastos');
  }
}

// Crea un movimiento (lo usan también pagos fijos, facturas, compra y mascotas).
export function createTransaction(req, data) {
  return insert('transactions', { ...data, household_id: req.hid, created_by: req.user.id });
}

export const TX_SELECT = `
  SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
         p.name AS person_name, p.emoji AS person_emoji, p.color AS person_color, p.photo_id AS person_photo,
         pt.name AS pet_name, pt.species AS pet_species,
         u.display_name AS created_by_name,
         a.name AS attachment_name, a.mime AS attachment_mime
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN people p ON p.id = t.person_id
    LEFT JOIN pets pt ON pt.id = t.pet_id
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN attachments a ON a.id = t.attachment_id`;

function buildFilters(q, hid) {
  const where = ['t.household_id = ?'];
  const params = [hid];
  const add = (sql, ...p) => {
    where.push(sql);
    params.push(...p);
  };
  if (q.from) add('t.date >= ?', String(q.from));
  if (q.to) add('t.date <= ?', String(q.to));
  if (q.kind === 'expense' || q.kind === 'income') add('t.kind = ?', q.kind);
  const ids = (s) => String(s).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (q.category) {
    const list = String(q.category) === 'none' ? [] : ids(q.category);
    if (String(q.category) === 'none') add('t.category_id IS NULL');
    else if (list.length) add(`t.category_id IN (${list.map(() => '?').join(',')})`, ...list);
  }
  if (q.person) {
    const list = ids(q.person);
    if (list.length) add(`t.person_id IN (${list.map(() => '?').join(',')})`, ...list);
  }
  if (q.pet) {
    if (q.pet === 'any') add('t.pet_id IS NOT NULL');
    else {
      const list = ids(q.pet);
      if (list.length) add(`t.pet_id IN (${list.map(() => '?').join(',')})`, ...list);
    }
  }
  if (q.method && METHODS.includes(q.method)) add('t.method = ?', q.method);
  // Importes en euros, con punto o con coma decimal («50,5»).
  const euros = (s) => Math.round(Number(String(s).replace(',', '.')) * 100);
  if (q.min && Number.isFinite(euros(q.min))) add('t.amount >= ?', euros(q.min));
  if (q.max && Number.isFinite(euros(q.max))) add('t.amount <= ?', euros(q.max));
  if (q.q) {
    // Sin distinguir mayúsculas ni acentos, en la descripción, el comercio, las notas o la categoría.
    const like = `%${normText(String(q.q).trim()).replace(/[%_]/g, '')}%`;
    add(`norm(t.description || char(1) || t.merchant || char(1) || COALESCE(t.notes, '') || char(1) || COALESCE(c.name, '')) LIKE ?`, like);
  }
  if (q.source === 'recurring') add('t.recurring_id IS NOT NULL');
  if (q.source === 'bills') add('t.bill_id IS NOT NULL');
  if (q.source === 'shopping') add('t.list_id IS NOT NULL');
  return { where: where.join(' AND '), params };
}

const SORTS = {
  date_desc: 't.date DESC, t.id DESC',
  date_asc: 't.date ASC, t.id ASC',
  amount_desc: 't.amount DESC, t.date DESC, t.id DESC',
  amount_asc: 't.amount ASC, t.date DESC, t.id DESC',
};

r.get('/', (req, res) => {
  const { where, params } = buildFilters(req.query, req.hid);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const order = SORTS[req.query.sort] || SORTS.date_desc;
  const items = all(`${TX_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  const totals = one(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount END), 0) AS expense,
            COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount END), 0) AS income
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE ${where}`,
    ...params,
  );
  res.json({ items, ...totals, limit, offset });
});

r.get('/suggest', (req, res) => {
  const q = normText(String(req.query.q || '').trim()).replace(/[%_]/g, '');
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const rows = all(
    `SELECT merchant, description, category_id, kind, amount, date, method FROM transactions
      WHERE household_id = ? AND (norm(merchant) LIKE ? OR norm(description) LIKE ?) ORDER BY date DESC, id DESC LIMIT 300`,
    req.hid, like, like,
  );
  const map = new Map();
  for (const row of rows) {
    const key = `${normText(row.merchant)}|${normText(row.description)}`;
    const e = map.get(key);
    if (e) e.count++;
    else map.set(key, { ...row, count: 1 });
  }
  res.json([...map.values()].sort((a, b) => b.count - a.count).slice(0, 8));
});

// Los movimientos que más se repiten (para rellenar el formulario con un toque).
r.get('/frequent', (req, res) => {
  const kind = req.query.kind === 'income' ? 'income' : 'expense';
  const rows = all(
    `SELECT t.description, t.merchant, t.category_id, t.method, t.person_id, t.amount, t.date, c.icon AS category_icon, c.name AS category_name
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ? AND t.kind = ? AND t.date >= date('now', 'localtime', '-120 days') AND t.recurring_id IS NULL AND t.bill_id IS NULL
        AND t.description != ''
      ORDER BY t.date DESC, t.id DESC LIMIT 1500`,
    req.hid, kind,
  );
  const map = new Map();
  for (const row of rows) {
    const key = `${row.description.toLowerCase()}|${row.category_id}`;
    const e = map.get(key);
    if (e) e.count++;
    else map.set(key, { ...row, kind, count: 1 });
  }
  res.json([...map.values()].filter((x) => x.count >= 2).sort((a, b) => b.count - a.count).slice(0, 8));
});

// Acciones sobre varios movimientos a la vez: borrar o cambiar categoría, persona o forma de pago.
r.post('/bulk', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 2000) : [];
  if (!ids.length) throw bad('No hay movimientos seleccionados');
  // Los consumos de luz estimados no se tocan desde aquí.
  const rows = all(`SELECT * FROM transactions WHERE household_id = ? AND estimate = 0 AND id IN (${ids.map(() => '?').join(',')})`, req.hid, ...ids);
  if (req.body.action === 'delete') {
    tx(() => {
      for (const t of rows) {
        run('DELETE FROM transactions WHERE id = ?', t.id);
        if (t.bill_id) {
          run(`UPDATE bills SET status = 'pending', paid_date = NULL WHERE id = ? AND household_id = ?`, t.bill_id, req.hid);
          releaseEstimates(req.hid, t.bill_id);
        }
      }
    })();
    changed(req, 'transactions', 'delete', null, `${req.user.display_name} ha borrado ${rows.length} movimientos`);
    return res.json({ count: rows.length, deleted: rows });
  }
  if (req.body.action === 'update') {
    const data = validate(req.body.data || {}, {
      category_id: [txSpec.category_id[0], 'Categoría'], person_id: [txSpec.person_id[0], 'Persona'], method: [txSpec.method[0], 'Forma de pago'],
    }, { partial: true });
    if (!Object.keys(data).length) throw bad('Nada que cambiar');
    let skipped = 0;
    tx(() => {
      for (const t of rows) {
        try {
          checkTxRefs({ ...t, ...data }, req.hid);
        } catch {
          skipped++;
          continue;
        }
        update('transactions', t.id, req.hid, data, { touch: true });
        if (data.category_id && data.category_id !== t.category_id) learnFrom(req, { ...t, ...data }, { correction: true });
      }
    })();
    changed(req, 'transactions', 'update', null, `${req.user.display_name} ha cambiado ${rows.length - skipped} movimientos`);
    return res.json({ count: rows.length - skipped, skipped });
  }
  throw bad('Acción no válida');
});

r.get('/export.csv', (req, res) => {
  const { where, params } = buildFilters(req.query, req.hid);
  // Solo las columnas del archivo y como listas (no objetos), y se envía a trozos: con decenas de miles de movimientos
  // es varias veces más rápido y no hace falta tener todo el archivo en memoria.
  const rows = db.prepare(
    `SELECT t.date, t.kind, t.amount, c.name, t.description, t.merchant, p.name, pt.name, t.method, t.notes
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN people p ON p.id = t.person_id
       LEFT JOIN pets pt ON pt.id = t.pet_id
      WHERE ${where} ORDER BY t.date DESC, t.id DESC`,
  ).raw();
  const METHOD_NAMES = { card: 'Tarjeta', cash: 'Efectivo', transfer: 'Transferencia', direct_debit: 'Domiciliación', bizum: 'Bizum', other: 'Otro' };
  const esc = (s) => {
    const str = String(s ?? '');
    return /[";\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  // Un texto que empieza por =, +, - o @ se abriría como fórmula en una hoja de cálculo: se le antepone un apóstrofo.
  const text = (s) => esc(/^[=+\-@\t\r]/.test(String(s ?? '')) ? `'${s}` : s);
  const head = ['Fecha', 'Tipo', 'Importe', 'Categoría', 'Descripción', 'Comercio', 'Persona', 'Mascota', 'Forma de pago', 'Notas'];
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="movimientos-${new Date().toISOString().slice(0, 10)}.csv"`);
  let out = `\uFEFF${head.join(';')}`;
  let n = 0;
  for (const [date, kind, amount, category, description, merchant, person, pet, method, notes] of rows.iterate(...params)) {
    out += `\r\n${[
      date, kind === 'expense' ? 'Gasto' : 'Ingreso', ((kind === 'expense' ? -amount : amount) / 100).toFixed(2).replace('.', ','),
      text(category), text(description), text(merchant), text(person), text(pet), METHOD_NAMES[method] || '', text(notes),
    ].join(';')}`;
    if (++n % 2000 === 0) {
      res.write(out);
      out = '';
    }
  }
  res.end(out);
});

r.get('/:id', (req, res) => {
  const t = one(`${TX_SELECT} WHERE t.id = ? AND t.household_id = ?`, idParam(req.params.id), req.hid);
  if (!t) throw notFound('Movimiento');
  res.json(t);
});

const describe = (d) => d.description || d.merchant || 'un movimiento';
// Lo que se anota a mano enseña qué categoría lleva cada comercio.
const learnFrom = (req, d, opts) => learn(req.hid, d.kind, `${d.merchant || ''} ${d.description || ''}`, d.category_id, opts);
// Identificador que pone el móvil a lo anotado sin conexión: si llega dos veces, no se duplica.
const clientId = (body) => (typeof body?.client_id === 'string' && /^[\w-]{8,64}$/.test(body.client_id) ? body.client_id : null);

r.post('/', (req, res) => {
  const cid = clientId(req.body);
  if (cid) {
    const dup = one('SELECT id FROM transactions WHERE household_id = ? AND client_id = ?', req.hid, cid);
    if (dup) return res.json({ ...one(`${TX_SELECT} WHERE t.id = ?`, dup.id), duplicate: true });
  }
  const data = validate(req.body, txSpec);
  checkTxRefs(data, req.hid);
  const id = createTransaction(req, { ...data, client_id: cid });
  learnFrom(req, data);
  const verb = data.kind === 'expense' ? 'ha anotado un gasto de' : 'ha anotado un ingreso de';
  changed(req, 'transactions', 'create', id, `${req.user.display_name} ${verb} ${formatEuros(data.amount, req.household.currency)}: ${describe(data)}`);
  res.status(201).json(one(`${TX_SELECT} WHERE t.id = ?`, id));
});

r.patch('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const current = one('SELECT * FROM transactions WHERE id = ? AND household_id = ?', id, req.hid);
  if (!current) throw notFound('Movimiento');
  if (current.estimate) throw bad(ESTIMATE_MSG);
  const data = validate(req.body, txSpec, { partial: true });
  checkTxRefs({ ...current, ...data }, req.hid);
  update('transactions', id, req.hid, data, { touch: true });
  // Cambiar la categoría es una corrección: la próxima vez ya sale bien.
  if (data.category_id && data.category_id !== current.category_id) learnFrom(req, { ...current, ...data }, { correction: true });
  changed(req, 'transactions', 'update', id, `${req.user.display_name} ha editado ${describe({ ...current, ...data })}`);
  res.json(one(`${TX_SELECT} WHERE t.id = ?`, id));
});

r.delete('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const t = one('SELECT * FROM transactions WHERE id = ? AND household_id = ?', id, req.hid);
  if (!t) throw notFound('Movimiento');
  if (t.estimate) throw bad(ESTIMATE_MSG);
  tx(() => {
    run('DELETE FROM transactions WHERE id = ?', id);
    // Si venía de una factura, la factura vuelve a quedar pendiente (y libera los consumos estimados).
    if (t.bill_id) {
      run(`UPDATE bills SET status = 'pending', paid_date = NULL WHERE id = ? AND household_id = ?`, t.bill_id, req.hid);
      releaseEstimates(req.hid, t.bill_id);
    }
  })();
  changed(req, 'transactions', 'delete', id, `${req.user.display_name} ha borrado ${describe(t)} (${formatEuros(t.amount, req.household.currency)})`);
  res.json({ ok: true, deleted: t });
});

// Importación masiva (CSV ya interpretado en el navegador).
r.post('/import', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw bad('No hay filas para importar');
  if (rows.length > 5000) throw bad('Máximo 5000 filas por importación');
  const clean = rows.map((row, i) => {
    try {
      const d = validate(row, txSpec);
      checkTxRefs(d, req.hid);
      return d;
    } catch (e) {
      throw bad(`Fila ${i + 1}: ${e.message}`);
    }
  });
  tx(() => clean.forEach((d) => {
    createTransaction(req, d);
    if (d.category_id) learnFrom(req, d);
  }))();
  changed(req, 'transactions', 'import', null, `${req.user.display_name} ha importado ${clean.length} movimientos`);
  res.json({ imported: clean.length });
});

// Antes de importar: qué filas ya están anotadas. «exact»: mismo día, importe y comercio;
// «possible»: mismo importe a ±3 días (por ejemplo, un recibo que ya anotó un pago fijo).
// Cada movimiento anotado solo «cubre» una fila (dos cafés iguales el mismo día son dos).
r.post('/import/check', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 5000) : [];
  const dates = rows.map((x) => String(x?.date || '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!dates.length) return res.json([]);
  const existing = all(
    `SELECT id, kind, amount, date, description, merchant FROM transactions
      WHERE household_id = ? AND date BETWEEN date(?, '-3 days') AND date(?, '+3 days')`,
    req.hid, dates[0], dates.at(-1),
  ).map((t) => ({ ...t, key: keyOf(`${t.merchant} ${t.description}`), used: false }));
  const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
  const out = rows.map(() => null);
  // Primero las coincidencias exactas, luego las aproximadas.
  rows.forEach((row, i) => {
    const key = keyOf(row.description);
    const hit = existing.find((t) => !t.used && t.kind === row.kind && t.amount === row.amount && t.date === row.date
      && (!key || !t.key || t.key === key || t.description.toLowerCase() === String(row.description || '').toLowerCase()));
    if (hit) {
      hit.used = true;
      out[i] = { status: 'exact', id: hit.id };
    }
  });
  rows.forEach((row, i) => {
    if (out[i]) return;
    const hit = existing.find((t) => !t.used && t.kind === row.kind && t.amount === row.amount && dayDiff(t.date, row.date) <= 3);
    if (hit) {
      hit.used = true;
      out[i] = { status: 'possible', id: hit.id, date: hit.date, description: hit.description || hit.merchant };
    }
  });
  res.json(out);
});

export default r;
