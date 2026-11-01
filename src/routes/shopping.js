// Listas de la compra compartidas, con secciones del súper y sugerencias de lo que más se compra.
import express from 'express';
import { all, insert, one, run, tx, update } from '../db.js';
import { METHODS, bad, formatEuros, idParam, notFound, today, v, validate } from '../util.js';
import { changed } from '../events.js';
import { ensureRef } from './household.js';
import { createTransaction } from './transactions.js';
import { SECTIONS, guessSection, remember } from '../catalog.js';
import { priceHints, recordListPrice, recordPrice } from './prices.js';

const r = express.Router();

const listSummary = (hid, where = '1 = 1', ...params) => all(
  `SELECT l.*, u.display_name AS created_by_name,
          (SELECT COUNT(*) FROM shopping_items i WHERE i.list_id = l.id) AS items,
          (SELECT COUNT(*) FROM shopping_items i WHERE i.list_id = l.id AND i.checked = 1) AS checked,
          (SELECT COALESCE(SUM(price), 0) FROM shopping_items i WHERE i.list_id = l.id) AS estimate,
          (SELECT COUNT(*) FROM transactions t WHERE t.list_id = l.id) AS purchases,
          (SELECT COALESCE(SUM(amount), 0) FROM transactions t WHERE t.list_id = l.id) AS spent
     FROM shopping_lists l LEFT JOIN users u ON u.id = l.created_by
    WHERE l.household_id = ? AND ${where}
    ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END, l.created_at DESC`,
  hid, ...params,
);

function listDetail(hid, id) {
  const list = listSummary(hid, 'l.id = ?', id)[0];
  if (!list) throw notFound('Lista');
  list.items = all(
    `SELECT i.*, u.display_name AS checked_by_name, c.id AS product_id, c.photo_id FROM shopping_items i
      LEFT JOIN users u ON u.id = i.checked_by
      LEFT JOIN shopping_catalog c ON c.household_id = i.household_id AND c.name = i.name
      WHERE i.list_id = ? ORDER BY i.checked, i.sort, i.id`,
    id,
  );
  list.hints = priceHints(hid, list.items.map((i) => i.name), list.store);
  list.purchases_list = all(
    `SELECT id, date, amount, merchant FROM transactions WHERE list_id = ? AND household_id = ? ORDER BY date DESC LIMIT 10`, id, hid,
  );
  return list;
}

r.get('/sections', (_req, res) => res.json(SECTIONS));

r.get('/lists', (req, res) => res.json(listSummary(req.hid)));

r.post('/lists', (req, res) => {
  const data = validate(req.body, {
    name: [v.str({ required: true, max: 60 }), 'Nombre'],
    icon: [v.emoji(), 'Icono'],
    store: [v.str({ max: 60 }), 'Tienda'],
  });
  const id = insert('shopping_lists', { ...data, household_id: req.hid, created_by: req.user.id });
  changed(req, 'shopping', 'create', id, `${req.user.display_name} ha creado la lista ${data.name}`);
  res.status(201).json(listDetail(req.hid, id));
});

r.get('/lists/:id', (req, res) => res.json(listDetail(req.hid, idParam(req.params.id))));

r.patch('/lists/:id', (req, res) => {
  const id = idParam(req.params.id);
  const data = validate(req.body, {
    name: [v.str({ required: true, max: 60 }), 'Nombre'],
    icon: [v.emoji(), 'Icono'],
    store: [v.str({ max: 60 }), 'Tienda'],
    status: [v.oneOf(['active', 'done'], { required: true }), 'Estado'],
  }, { partial: true });
  if (data.status === 'done') data.completed_at = new Date().toISOString();
  if (data.status === 'active') data.completed_at = null;
  if (!update('shopping_lists', id, req.hid, data)) throw notFound('Lista');
  changed(req, 'shopping', 'update', id);
  res.json(listDetail(req.hid, id));
});

r.delete('/lists/:id', (req, res) => {
  const id = idParam(req.params.id);
  const l = one('SELECT name FROM shopping_lists WHERE id = ? AND household_id = ?', id, req.hid);
  if (!l) throw notFound('Lista');
  run('DELETE FROM shopping_lists WHERE id = ?', id);
  changed(req, 'shopping', 'delete', id, `${req.user.display_name} ha borrado la lista ${l.name}`);
  res.json({ ok: true });
});

// Añade uno o varios productos (texto con saltos de línea o comas → varios).
r.post('/lists/:id/items', (req, res) => {
  const id = idParam(req.params.id);
  if (!one('SELECT 1 FROM shopping_lists WHERE id = ? AND household_id = ?', id, req.hid)) throw notFound('Lista');
  // Lo añadido sin conexión llega con un identificador: si ya se recibió, no se repite.
  const cid = typeof req.body?.client_id === 'string' && /^[\w-]{8,64}$/.test(req.body.client_id) ? req.body.client_id : null;
  if (cid && one('SELECT 1 FROM shopping_items WHERE household_id = ? AND client_id = ?', req.hid, `${cid}:0`)) {
    return res.json({ added: [], duplicate: true, ...listDetail(req.hid, id) });
  }
  const raw = String(req.body?.name || '').trim();
  if (!raw) throw bad('Escribe qué hay que comprar');
  const names = raw.split(/\n|,|;/).map((s) => s.trim()).filter(Boolean).slice(0, 100);
  const extra = validate(req.body, {
    qty: [v.str({ max: 30 }), 'Cantidad'],
    price: [v.cents(), 'Precio'],
    section: [v.str({ max: 20 }), 'Sección'],
  });
  let sort = one('SELECT COALESCE(MAX(sort), 0) AS n FROM shopping_items WHERE list_id = ?', id).n;
  const added = tx(() => names.map((n, i) => {
    // Permite "2 leche" o "leche x2" como cantidad rápida.
    let name = n.slice(0, 80);
    let qty = extra.qty || '';
    const m1 = name.match(/^(\d+[.,]?\d*\s*(?:kg|g|l|ml|uds?|paquetes?|botellas?|latas?)?)\s+(.+)$/i);
    const m2 = name.match(/^(.+?)\s+x\s*(\d+)$/i);
    if (!qty && m1) [, qty, name] = m1;
    else if (!qty && m2) [, name, qty] = m2;
    const known = one('SELECT section, last_price FROM shopping_catalog WHERE household_id = ? AND name = ?', req.hid, name);
    const section = extra.section || known?.section || guessSection(name);
    const price = extra.price ?? null;
    remember(req.hid, name, section, price);
    return insert('shopping_items', {
      list_id: id, household_id: req.hid, name: name.charAt(0).toUpperCase() + name.slice(1), qty, price, section,
      sort: ++sort, created_by: req.user.id, client_id: cid ? `${cid}:${i}` : null,
    });
  }))();
  const what = names.length === 1 ? names[0] : `${names.length} productos`;
  changed(req, 'shopping', 'items', id, `${req.user.display_name} ha añadido ${what} a la compra`);
  res.status(201).json({ added, ...listDetail(req.hid, id) });
});

r.patch('/items/:iid', (req, res) => {
  const iid = idParam(req.params.iid);
  const item = one('SELECT * FROM shopping_items WHERE id = ? AND household_id = ?', iid, req.hid);
  if (!item) throw notFound('Producto');
  const data = validate(req.body, {
    name: [v.str({ required: true, max: 80 }), 'Nombre'],
    qty: [v.str({ max: 30 }), 'Cantidad'],
    price: [v.cents(), 'Precio'],
    section: [v.str({ max: 20 }), 'Sección'],
    checked: [v.bool(), 'Comprado'],
  }, { partial: true });
  if ('checked' in data) {
    data.checked_by = data.checked ? req.user.id : null;
    data.checked_at = data.checked ? new Date().toISOString() : null;
  }
  update('shopping_items', iid, req.hid, data);
  // Guardar el precio en el comparador (tienda de la lista o la indicada).
  if (req.body.save_price && data.price > 0) {
    const store = String(req.body.price_store || one('SELECT store FROM shopping_lists WHERE id = ?', item.list_id)?.store || '').trim();
    if (store && Number(req.body.price_qty) > 0 && ['ud', 'kg', 'g', 'l', 'ml', 'pack'].includes(req.body.price_unit)) {
      recordPrice(req, { name: data.name || item.name, store, price: data.price, qty: Number(req.body.price_qty), unit: req.body.price_unit });
    } else if (store) {
      recordListPrice(req, { name: data.name || item.name, store, price: data.price, qtyText: data.qty ?? item.qty });
    }
  }
  if (data.section || data.price !== undefined) {
    run(
      `UPDATE shopping_catalog SET section = COALESCE(?, section), last_price = COALESCE(?, last_price) WHERE household_id = ? AND name = ?`,
      data.section || null, data.price ?? null, req.hid, data.name || item.name,
    );
  }
  changed(req, 'shopping', 'item', item.list_id);
  res.json(listDetail(req.hid, item.list_id));
});

r.delete('/items/:iid', (req, res) => {
  const iid = idParam(req.params.iid);
  const item = one('SELECT list_id FROM shopping_items WHERE id = ? AND household_id = ?', iid, req.hid);
  if (!item) throw notFound('Producto');
  run('DELETE FROM shopping_items WHERE id = ?', iid);
  changed(req, 'shopping', 'item', item.list_id);
  res.json(listDetail(req.hid, item.list_id));
});

// Varios productos a la vez: marcar, desmarcar, mover a otra lista o quitar.
r.post('/items/bulk', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500) : [];
  if (!ids.length) throw bad('No hay productos seleccionados');
  const items = all(`SELECT * FROM shopping_items WHERE household_id = ? AND id IN (${ids.map(() => '?').join(',')})`, req.hid, ...ids);
  if (!items.length) throw notFound('Productos');
  const lists = new Set(items.map((i) => i.list_id));
  const action = req.body.action;
  tx(() => {
    for (const it of items) {
      if (action === 'delete') run('DELETE FROM shopping_items WHERE id = ?', it.id);
      else if (action === 'check') run(`UPDATE shopping_items SET checked = 1, checked_by = ?, checked_at = ? WHERE id = ?`, req.user.id, new Date().toISOString(), it.id);
      else if (action === 'uncheck') run('UPDATE shopping_items SET checked = 0, checked_by = NULL, checked_at = NULL WHERE id = ?', it.id);
      else if (action === 'move') {
        const target = Number(req.body.list_id);
        if (!one('SELECT 1 FROM shopping_lists WHERE id = ? AND household_id = ?', target, req.hid)) throw bad('Lista de destino no válida');
        run('UPDATE shopping_items SET list_id = ? WHERE id = ?', target, it.id);
        lists.add(target);
      } else throw bad('Acción no válida');
    }
  })();
  for (const l of lists) changed(req, 'shopping', 'item', l);
  if (action === 'move') {
    const target = one('SELECT name FROM shopping_lists WHERE id = ?', Number(req.body.list_id));
    changed(req, 'shopping', 'move', null, `${req.user.display_name} ha movido ${items.length} productos a ${target.name}`);
  }
  res.json(listDetail(req.hid, items[0].list_id));
});

// Nuevo orden de los productos (y sección, si se ha arrastrado a otra).
r.post('/lists/:id/reorder', (req, res) => {
  const id = idParam(req.params.id);
  if (!one('SELECT 1 FROM shopping_lists WHERE id = ? AND household_id = ?', id, req.hid)) throw notFound('Lista');
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  const moved = req.body?.moved;
  tx(() => {
    ids.forEach((iid, i) => run('UPDATE shopping_items SET sort = ? WHERE id = ? AND list_id = ?', i, iid, id));
    if (moved?.id && typeof moved.section === 'string' && moved.section.length <= 20) {
      const item = one('SELECT name FROM shopping_items WHERE id = ? AND list_id = ?', Number(moved.id), id);
      if (item) {
        run('UPDATE shopping_items SET section = ? WHERE id = ?', moved.section, Number(moved.id));
        run('UPDATE shopping_catalog SET section = ? WHERE household_id = ? AND name = ?', moved.section, req.hid, item.name);
      }
    }
  })();
  changed(req, 'shopping', 'item', id);
  res.json(listDetail(req.hid, id));
});

r.post('/lists/:id/clear-checked', (req, res) => {
  const id = idParam(req.params.id);
  run('DELETE FROM shopping_items WHERE list_id = ? AND household_id = ? AND checked = 1', id, req.hid);
  changed(req, 'shopping', 'item', id);
  res.json(listDetail(req.hid, id));
});

// Termina la compra: anota el gasto y quita de la lista lo que ya está en el carro.
r.post('/lists/:id/complete', (req, res) => {
  const id = idParam(req.params.id);
  const list = one('SELECT * FROM shopping_lists WHERE id = ? AND household_id = ?', id, req.hid);
  if (!list) throw notFound('Lista');
  const data = validate(req.body, {
    amount: [v.cents({ required: true, positive: true }), 'Importe del ticket'],
    date: [v.date(), 'Fecha'],
    category_id: [v.int(), 'Categoría'],
    person_id: [v.int(), 'Persona'],
    method: [v.oneOf(METHODS), 'Forma de pago'],
    merchant: [v.str({ max: 80 }), 'Tienda'],
    attachment_id: [v.int(), 'Ticket'],
  });
  ensureRef('categories', data.category_id, req.hid, 'Categoría');
  ensureRef('people', data.person_id, req.hid, 'Persona');
  ensureRef('attachments', data.attachment_id, req.hid, 'Ticket');
  const archive = !!req.body.archive;
  tx(() => {
    const bought = all('SELECT name FROM shopping_items WHERE list_id = ? AND checked = 1', id);
    createTransaction(req, {
      kind: 'expense', amount: data.amount, date: data.date || today(), description: list.name,
      merchant: data.merchant || list.store || '', category_id: data.category_id, person_id: data.person_id,
      method: data.method, list_id: id, attachment_id: data.attachment_id,
      notes: bought.length ? `Comprado: ${bought.map((b) => b.name).join(', ')}`.slice(0, 1000) : '',
    });
    // Los precios de lo que estaba en el carro pasan al comparador.
    const store = (data.merchant || list.store || '').trim();
    if (req.body.save_prices && store) {
      for (const it of all('SELECT name, qty, price FROM shopping_items WHERE list_id = ? AND checked = 1 AND price > 0', id)) {
        recordListPrice(req, { name: it.name, store, price: it.price, qtyText: it.qty, date: data.date || today() });
      }
    }
    run('DELETE FROM shopping_items WHERE list_id = ? AND checked = 1', id);
    if (archive) run(`UPDATE shopping_lists SET status = 'done', completed_at = datetime('now') WHERE id = ?`, id);
  })();
  changed(req, 'shopping', 'complete', id, `${req.user.display_name} ha hecho la compra de ${list.name} (${formatEuros(data.amount, req.household.currency)})`);
  res.json(listDetail(req.hid, id));
});

// Lo que más se compra en casa y no está ya en la lista.
r.get('/suggestions', (req, res) => {
  const listId = Number(req.query.list) || 0;
  res.json(all(
    `SELECT name, section, last_price, times FROM shopping_catalog c
      WHERE c.household_id = ? AND NOT EXISTS (
        SELECT 1 FROM shopping_items i WHERE i.list_id = ? AND i.name = c.name COLLATE NOCASE)
      ORDER BY times DESC, last_at DESC LIMIT 24`,
    req.hid, listId,
  ));
});

export default r;
