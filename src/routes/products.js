// Productos de la compra: la ficha de cada uno (foto, sección del súper, cómo se vende) con sus precios en cada supermercado.
import express from 'express';
import { all, insert, one, run, tx, update } from '../db.js';
import { bad, idParam, notFound, v, validate } from '../util.js';
import { changed } from '../events.js';
import { SECTIONS, guessSection } from '../catalog.js';
import { UNITS, latestByProduct, storeList, unitPrice } from './prices.js';
import { checkPhoto, dropOldPhoto } from './household.js';

const r = express.Router();

const spec = {
  name: [v.str({ required: true, max: 80 }), 'Nombre'],
  section: [v.oneOf(SECTIONS.map((s) => s.id)), 'Sección'],
  unit: [v.oneOf(Object.keys(UNITS)), 'Formato'],
  unit_qty: [v.num({ min: 0.001, max: 100000 }), 'Cantidad'],
  note: [v.str({ max: 120 }), 'Marca o detalle'],
  photo_id: [v.int(), 'Foto'],
};

const COLS = 'c.id, c.name, c.section, c.photo_id, c.unit, c.unit_qty, c.note, c.times, c.last_at, c.last_price';
// Cuántas veces está pendiente en las listas activas.
const IN_LIST = `(SELECT COUNT(*) FROM shopping_items i JOIN shopping_lists l ON l.id = i.list_id
  WHERE i.household_id = c.household_id AND i.name = c.name COLLATE NOCASE AND i.checked = 0 AND l.status = 'active') AS in_list`;

// Resumen de precios de un producto: el más barato, en cuántas tiendas y cómo se compara (kg, l, ud…).
const priceSummary = (p) => (p ? {
  base_unit: p.base_unit,
  best: p.best ? { store: p.best.store, ...p.stores[p.best.store] } : null,
  stores: Object.keys(p.stores).length,
  spread: p.spread,
  change: p.change,
} : { base_unit: null, best: null, stores: 0, spread: 0, change: null });

// Formato: los dos datos van juntos (sin formato, se deduce de los precios anotados).
function cleanFormat(data) {
  if (!('unit' in data) && !('unit_qty' in data)) return;
  if (!data.unit) {
    data.unit = null;
    data.unit_qty = null;
  } else if (!(data.unit_qty > 0)) data.unit_qty = 1;
}

r.get('/', (req, res) => {
  const rows = all(`SELECT ${COLS}, ${IN_LIST} FROM shopping_catalog c WHERE c.household_id = ? ORDER BY c.name`, req.hid);
  const prices = new Map(latestByProduct(req.hid).map((p) => [p.id, p]));
  res.json({
    sections: SECTIONS, stores: storeList(req.hid).map((x) => x.store),
    products: rows.map((c) => ({ ...c, ...priceSummary(prices.get(c.id)) })),
  });
});

// Para el botón «Productos» de la compra: cuántos hay y cuántos tienen algún precio.
r.get('/summary', (req, res) => {
  res.json(one(
    `SELECT COUNT(*) AS count, COALESCE(SUM(EXISTS (SELECT 1 FROM prices p WHERE p.product_id = c.id)), 0) AS priced
       FROM shopping_catalog c WHERE c.household_id = ?`,
    req.hid,
  ));
});

r.get('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const c = one(`SELECT ${COLS}, ${IN_LIST} FROM shopping_catalog c WHERE c.id = ? AND c.household_id = ?`, id, req.hid);
  if (!c) throw notFound('Producto');
  const p = latestByProduct(req.hid, new Set([id]))[0];
  const stores = p ? Object.entries(p.stores).map(([store, x]) => ({ store, ...x })) : [];
  // Primero las tiendas comparables, de más barata a más cara; luego las que tienen otro formato.
  stores.sort((a, b) => (UNITS[a.unit][0] === p.base_unit ? 0 : 1) - (UNITS[b.unit][0] === p.base_unit ? 0 : 1) || a.unit_price - b.unit_price);
  const history = all(
    `SELECT p.*, u.display_name AS created_by_name FROM prices p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.household_id = ? AND p.product_id = ? ORDER BY p.date, p.id`,
    req.hid, id,
  ).map((x) => ({ ...x, unit_price: unitPrice(x) }));
  const lists = all(
    `SELECT l.id, l.name, l.icon, i.id AS item_id, i.qty FROM shopping_items i JOIN shopping_lists l ON l.id = i.list_id
      WHERE i.household_id = ? AND i.name = ? COLLATE NOCASE AND i.checked = 0 AND l.status = 'active' ORDER BY l.id`,
    req.hid, c.name,
  );
  res.json({ ...c, ...priceSummary(p), prices: stores, history, lists, store_order: storeList(req.hid).map((x) => x.store) });
});

r.post('/', (req, res) => {
  const data = validate(req.body, spec);
  cleanFormat(data);
  if (one('SELECT 1 FROM shopping_catalog WHERE household_id = ? AND name = ?', req.hid, data.name)) {
    throw bad(`Ya hay un producto que se llama «${data.name}»`);
  }
  checkPhoto(req.hid, data.photo_id);
  const id = insert('shopping_catalog', {
    household_id: req.hid, ...data, section: data.section || guessSection(data.name), note: data.note || '', times: 0,
  });
  changed(req, 'products', 'create', id, `${req.user.display_name} ha añadido el producto ${data.name}`);
  res.status(201).json({ id });
});

r.patch('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const cur = one('SELECT * FROM shopping_catalog WHERE id = ? AND household_id = ?', id, req.hid);
  if (!cur) throw notFound('Producto');
  const data = validate(req.body, spec, { partial: true });
  cleanFormat(data);
  if ('section' in data && !data.section) delete data.section;
  if ('note' in data && data.note === null) data.note = '';
  checkPhoto(req.hid, data.photo_id);
  const renamed = data.name && data.name !== cur.name;
  if (renamed) {
    const other = one('SELECT id FROM shopping_catalog WHERE household_id = ? AND name = ? AND id <> ?', req.hid, data.name, id);
    if (other) throw bad(`Ya hay un producto que se llama «${data.name}». Si es el mismo, usa «Unir con otro producto».`);
  }
  tx(() => {
    update('shopping_catalog', id, req.hid, data);
    // Las listas siguen al producto: nombre nuevo y sección nueva en lo que falta por comprar.
    if (renamed) run('UPDATE shopping_items SET name = ? WHERE household_id = ? AND name = ? COLLATE NOCASE', data.name, req.hid, cur.name);
    if (data.section && data.section !== cur.section) {
      run('UPDATE shopping_items SET section = ? WHERE household_id = ? AND name = ? COLLATE NOCASE AND checked = 0', data.section, req.hid, data.name || cur.name);
    }
  })();
  if ('photo_id' in data) dropOldPhoto(req.hid, cur.photo_id, data.photo_id);
  changed(req, 'products', 'update', id);
  if (renamed || data.section) changed(req, 'shopping', 'item', null);
  res.json({ id });
});

// Dos productos que son el mismo («Leche» y «Leche entera»): los precios y las listas pasan al que se queda.
r.post('/:id/merge', (req, res) => {
  const id = idParam(req.params.id);
  const into = idParam(req.body?.into);
  if (id === into) throw bad('Elige otro producto');
  const from = one('SELECT * FROM shopping_catalog WHERE id = ? AND household_id = ?', id, req.hid);
  const to = one('SELECT * FROM shopping_catalog WHERE id = ? AND household_id = ?', into, req.hid);
  if (!from || !to) throw notFound('Producto');
  tx(() => {
    run('UPDATE prices SET product_id = ? WHERE product_id = ? AND household_id = ?', into, id, req.hid);
    run('UPDATE shopping_items SET name = ? WHERE household_id = ? AND name = ? COLLATE NOCASE', to.name, req.hid, from.name);
    run(
      `UPDATE shopping_catalog SET times = times + ?, photo_id = COALESCE(photo_id, ?), unit = COALESCE(unit, ?), unit_qty = COALESCE(unit_qty, ?),
         note = CASE WHEN note = '' THEN ? ELSE note END, last_at = MAX(last_at, ?) WHERE id = ?`,
      from.times, from.photo_id, from.unit, from.unit_qty, from.note, from.last_at, into,
    );
    run('DELETE FROM shopping_catalog WHERE id = ?', id);
  })();
  if (from.photo_id && to.photo_id) dropOldPhoto(req.hid, from.photo_id, null);
  changed(req, 'products', 'merge', into, `${req.user.display_name} ha unido ${from.name} con ${to.name}`);
  res.json({ id: into });
});

r.delete('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const cur = one('SELECT * FROM shopping_catalog WHERE id = ? AND household_id = ?', id, req.hid);
  if (!cur) throw notFound('Producto');
  run('DELETE FROM shopping_catalog WHERE id = ?', id);
  dropOldPhoto(req.hid, cur.photo_id, null);
  changed(req, 'products', 'delete', id, `${req.user.display_name} ha borrado el producto ${cur.name}`);
  res.json({ ok: true });
});

export default r;
