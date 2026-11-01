// Comparador de precios: lo que cuesta cada producto habitual en cada supermercado.
import express from 'express';
import { all, insert, one, run } from '../db.js';
import { formatEuros, idParam, notFound, today, v, validate } from '../util.js';
import { changed } from '../events.js';
import { productId } from '../catalog.js';
import { priceHistory } from '../pricehistory.js';
import { ensureIpc, ipcData } from '../ipc.js';

const r = express.Router();

// Unidades admitidas y su conversión a la unidad base para comparar (€/kg, €/l, €/ud).
export const UNITS = { ud: ['ud', 1], kg: ['kg', 1], g: ['kg', 0.001], l: ['l', 1], ml: ['l', 0.001], pack: ['pack', 1] };
const base = (unit) => UNITS[unit] || UNITS.ud;
export const unitPrice = (p) => p.price / (p.qty * base(p.unit)[1]);
const norm = (s) => String(s || '').trim().toLowerCase();

// Último precio de cada producto en cada tienda (más un resumen de evolución).
export function latestByProduct(hid, productIds = null) {
  const rows = all(
    `SELECT p.*, c.name AS product, c.section, c.times FROM prices p JOIN shopping_catalog c ON c.id = p.product_id
      WHERE p.household_id = ? ORDER BY p.date, p.id`,
    hid,
  );
  const map = new Map();
  for (const row of rows) {
    if (productIds && !productIds.has(row.product_id)) continue;
    let prod = map.get(row.product_id);
    if (!prod) {
      prod = { id: row.product_id, name: row.product, section: row.section, times: row.times, entries: 0, stores: {}, first: {}, regular: {}, last: null };
      map.set(row.product_id, prod);
    }
    prod.entries++;
    const key = row.store;
    // Para la evolución del precio solo cuentan los precios normales (sin ofertas).
    if (!row.offer) {
      if (!prod.first[key]) prod.first[key] = row;
      prod.regular[key] = row;
    }
    prod.stores[key] = row;
    prod.last = row;
  }
  for (const prod of map.values()) {
    // Se compara en la unidad que usan más tiendas (en empate, la del último precio anotado):
    // así un precio suelto «por unidad» no saca de la comparación por kilo a las demás.
    const count = {};
    for (const x of Object.values(prod.stores)) count[base(x.unit)[0]] = (count[base(x.unit)[0]] || 0) + 1;
    const lastBase = base(prod.last.unit)[0];
    const refBase = Object.keys(count).reduce((a, b) => (count[b] > count[a] ? b : a), lastBase);
    const comparable = Object.values(prod.stores).filter((x) => base(x.unit)[0] === refBase);
    const ups = comparable.map((x) => ({ store: x.store, up: unitPrice(x) }));
    ups.sort((a, b) => a.up - b.up);
    prod.base_unit = refBase;
    prod.best = ups[0] || null;
    prod.worst = ups.at(-1) || null;
    prod.spread = ups.length > 1 ? (prod.worst.up - prod.best.up) / prod.worst.up : 0;
    // Variación desde el primer precio anotado en cada tienda.
    const changes = Object.keys(prod.regular)
      .filter((s) => prod.first[s].id !== prod.regular[s].id && base(prod.first[s].unit)[0] === base(prod.regular[s].unit)[0])
      .map((s) => unitPrice(prod.regular[s]) / unitPrice(prod.first[s]) - 1);
    prod.change = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
    prod.stores = Object.fromEntries(Object.entries(prod.stores).map(([s, x]) => [s, {
      id: x.id, price: x.price, qty: x.qty, unit: x.unit, date: x.date, offer: x.offer, unit_price: unitPrice(x),
    }]));
    delete prod.first;
    delete prod.regular;
    delete prod.last;
  }
  return [...map.values()];
}

// Pistas para la lista de la compra: dónde es más barato cada producto y cuánto cuesta en la tienda de la lista.
export function priceHints(hid, names, store) {
  if (!names.length) return {};
  const ids = new Map(all('SELECT id, name FROM shopping_catalog WHERE household_id = ?', hid).map((c) => [norm(c.name), c.id]));
  const wanted = new Set(names.map((n) => ids.get(norm(n))).filter(Boolean));
  if (!wanted.size) return {};
  const out = {};
  for (const p of latestByProduct(hid, wanted)) {
    const here = Object.entries(p.stores).find(([s]) => norm(s) === norm(store));
    const best = p.best ? { store: p.best.store, ...p.stores[p.best.store] } : null;
    out[norm(p.name)] = { best, here: here ? { store: here[0], ...here[1] } : null, stores: Object.keys(p.stores).length, base_unit: p.base_unit };
  }
  return out;
}

// Guarda un precio (lo usan también la lista de la compra y "terminar compra").
export function recordPrice(req, { name, store, price, qty = 1, unit = 'ud', date, offer = 0, note = '' }) {
  if (!name || !store || !(price > 0)) return null;
  const pid = productId(req.hid, name);
  const d = date || today();
  // Un único precio por producto, tienda y día: el último manda.
  run('DELETE FROM prices WHERE household_id = ? AND product_id = ? AND store = ? AND date = ?', req.hid, pid, store.trim(), d);
  return insert('prices', {
    household_id: req.hid, product_id: pid, store: store.trim().slice(0, 60), price, qty, unit, date: d, offer: offer ? 1 : 0, note, created_by: req.user.id,
  });
}

// Cantidad escrita en la lista de la compra («800 g», «1,5 kg», «2», «x3», «6 bricks») → { n, unit }.
// unit es null cuando solo hay un número de piezas o paquetes.
const QTY_UNITS = { kg: ['kg', 1], kilo: ['kg', 1], kilos: ['kg', 1], g: ['g', 1], gr: ['g', 1], grs: ['g', 1], gramo: ['g', 1], gramos: ['g', 1],
  l: ['l', 1], litro: ['l', 1], litros: ['l', 1], ml: ['ml', 1], cl: ['ml', 10] };
export function parseQty(text) {
  const t = String(text || '').trim().toLowerCase().replace(/^x\s*/, '');
  if (!t) return { n: 1, unit: null };
  if (/^(medio|1\/2)\s*(kg|kilo)$/.test(t)) return { n: 0.5, unit: 'kg' };
  if (/^(cuarto|1\/4)\s*(de\s*)?(kg|kilo)$/.test(t)) return { n: 0.25, unit: 'kg' };
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*([a-z]*)\.?\b/);
  if (!m) return { n: 1, unit: null };
  const n = Number(m[1].replace(',', '.'));
  if (!(n > 0)) return { n: 1, unit: null };
  const u = QTY_UNITS[m[2]];
  return u ? { n: n * u[1], unit: u[0] } : { n, unit: null };
}

// Precio de una línea de la lista de la compra (el importe es el de la línea entera: «800 g», «2»…).
export function recordListPrice(req, { name, store, price, qtyText, date }) {
  const q = parseQty(qtyText);
  if (q.unit) return recordPrice(req, { name, store, price, qty: q.n, unit: q.unit, date });
  // Formato: el del último precio anotado o, si no hay, el de la ficha del producto.
  const last = one(
    `SELECT p.qty, p.unit FROM prices p JOIN shopping_catalog c ON c.id = p.product_id
      WHERE p.household_id = ? AND c.name = ? ORDER BY p.date DESC, p.id DESC LIMIT 1`,
    req.hid, String(name).trim(),
  ) || one('SELECT unit_qty AS qty, unit FROM shopping_catalog WHERE household_id = ? AND name = ? AND unit IS NOT NULL', req.hid, String(name).trim());
  // Algo que se vende al peso sin decir cuánto pesaba: no se puede saber el precio por kilo.
  if (last && last.qty === 1 && ['kg', 'l'].includes(last.unit)) return null;
  return recordPrice(req, { name, store, price, qty: q.n * (last?.qty || 1), unit: last?.unit || 'ud', date });
}

const spec = {
  product: [v.str({ required: true, max: 80 }), 'Producto'],
  store: [v.str({ required: true, max: 60 }), 'Supermercado'],
  price: [v.cents({ required: true, positive: true }), 'Precio'],
  qty: [v.num({ min: 0.001, max: 100000 }), 'Cantidad'],
  unit: [v.oneOf(Object.keys(UNITS)), 'Unidad'],
  date: [v.date(), 'Fecha'],
  offer: [v.bool(), 'Oferta'],
  note: [v.str({ max: 120 }), 'Nota'],
};

// Supermercados con precios, de más a menos usado (este orden fija el color de cada uno).
export const storeList = (hid) => all(
  `SELECT store, COUNT(*) AS n, COUNT(DISTINCT product_id) AS products, MAX(date) AS last FROM prices WHERE household_id = ?
    GROUP BY lower(store) ORDER BY products DESC, n DESC, last DESC, store`,
  hid,
);

r.get('/', (req, res) => {
  const products = latestByProduct(req.hid).sort((a, b) => b.times - a.times || b.entries - a.entries);
  const stores = storeList(req.hid);
  const catalog = all('SELECT id, name, section, times, unit, unit_qty, photo_id FROM shopping_catalog WHERE household_id = ? ORDER BY times DESC, name LIMIT 300', req.hid);
  res.json({ products, stores, catalog });
});

// Histórico e inflación: el índice de precios del hogar frente al IPC oficial.
r.get('/history', async (req, res) => {
  const h = priceHistory(req.hid, { a: req.query.a, b: req.query.b });
  const ipc = await ensureIpc();
  const from = h.since || `${Number(today().slice(0, 4)) - 2}${today().slice(4, 7)}`;
  res.json({ ...h, ipc: ipc ? ipcData(from) : null });
});

r.get('/product/:id', (req, res) => {
  const id = idParam(req.params.id);
  const p = one('SELECT id, name, section, times FROM shopping_catalog WHERE id = ? AND household_id = ?', id, req.hid);
  if (!p) throw notFound('Producto');
  const history = all(
    `SELECT p.*, u.display_name AS created_by_name FROM prices p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.household_id = ? AND p.product_id = ? ORDER BY p.date, p.id`,
    req.hid, id,
  ).map((x) => ({ ...x, unit_price: unitPrice(x) }));
  res.json({ ...p, history });
});

r.post('/', (req, res) => {
  const data = validate(req.body, spec);
  const id = recordPrice(req, { name: data.product, store: data.store, price: data.price, qty: data.qty || 1, unit: data.unit || 'ud', date: data.date, offer: data.offer, note: data.note });
  changed(req, 'prices', 'create', id, `${req.user.display_name} ha anotado ${data.product} a ${formatEuros(data.price, req.household.currency)} en ${data.store}`);
  res.status(201).json({ id });
});

// Varios precios a la vez (por ejemplo, al terminar una compra).
r.post('/bulk', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [];
  let n = 0;
  for (const it of items) {
    const d = validate(it, spec);
    if (recordPrice(req, { name: d.product, store: d.store, price: d.price, qty: d.qty || 1, unit: d.unit || 'ud', date: d.date, offer: d.offer, note: d.note })) n++;
  }
  if (n) changed(req, 'prices', 'bulk', null, `${req.user.display_name} ha guardado ${n} precios`);
  res.json({ saved: n });
});

r.delete('/:id', (req, res) => {
  const n = run('DELETE FROM prices WHERE id = ? AND household_id = ?', idParam(req.params.id), req.hid).changes;
  if (!n) throw notFound('Precio');
  changed(req, 'prices', 'delete');
  res.json({ ok: true });
});

// Cesta: cuánto costaría la compra habitual (o una lista) en cada supermercado.
r.get('/basket', (req, res) => {
  const hid = req.hid;
  let names = null;
  if (req.query.list) {
    const list = one('SELECT id FROM shopping_lists WHERE id = ? AND household_id = ?', Number(req.query.list), hid);
    if (!list) throw notFound('Lista');
    names = all('SELECT name FROM shopping_items WHERE list_id = ?', list.id).map((x) => norm(x.name));
  }
  let products = latestByProduct(hid);
  if (names) products = products.filter((p) => names.includes(norm(p.name)));
  else products = products.sort((a, b) => b.times - a.times).slice(0, 30);
  if (!products.length) return res.json({ products: 0, stores: [] });

  // Precio de "una compra" del producto en cada tienda, tomando como referencia la última cantidad anotada.
  const refQty = (p) => {
    const anyEntry = Object.values(p.stores).filter((x) => base(x.unit)[0] === p.base_unit).sort((a, b) => b.date.localeCompare(a.date))[0];
    return anyEntry.qty * base(anyEntry.unit)[1];
  };
  const storeNames = new Map();
  for (const p of products) for (const s of Object.keys(p.stores)) storeNames.set(norm(s), s);
  const priceAt = (p, store) => {
    const e = Object.entries(p.stores).find(([s, x]) => norm(s) === norm(store) && base(x.unit)[0] === p.base_unit);
    return e ? Math.round(e[1].unit_price * refQty(p)) : null;
  };
  let stores = [...storeNames.values()].map((s) => {
    const prices = products.map((p) => priceAt(p, s));
    return { store: s, covered: prices.filter((x) => x !== null).length, total: prices.reduce((a, b) => a + (b || 0), 0) };
  }).sort((a, b) => b.covered - a.covered);
  // Comparación justa: solo los productos que tienen precio en todas las tiendas comparadas.
  const compare = stores.filter((s) => s.covered >= Math.max(1, Math.ceil(products.length * 0.4))).slice(0, 5);
  const common = compare.length >= 2 ? products.filter((p) => compare.every((s) => priceAt(p, s.store) !== null)) : [];
  for (const s of stores) s.common_total = compare.includes(s) ? common.reduce((a, p) => a + priceAt(p, s.store), 0) : null;
  // Compra repartida: cada producto en la tienda donde es más barato.
  let split = 0;
  const assignment = {};
  for (const p of common) {
    let best = null;
    for (const s of compare) {
      const v = priceAt(p, s.store);
      if (best === null || v < best.v) best = { v, store: s.store };
    }
    split += best.v;
    assignment[best.store] = (assignment[best.store] || 0) + 1;
  }
  const ranked = compare.filter((s) => common.length).sort((a, b) => a.common_total - b.common_total);
  const cheapest = ranked[0] || null;
  // Tienda habitual: la que más aparece en los gastos de súper de los últimos 90 días.
  const merchants = all(
    `SELECT lower(merchant) AS m, COUNT(*) AS n FROM transactions
      WHERE household_id = ? AND kind = 'expense' AND date >= date('now', 'localtime', '-90 days') AND merchant != '' GROUP BY lower(merchant) ORDER BY n DESC`,
    hid,
  );
  const usual = merchants.map((m) => compare.find((s) => norm(s.store) === m.m)).find(Boolean) || ranked.at(-1) || null;
  // Gasto medio mensual en supermercado (últimos 3 meses completos).
  const superCat = one(
    `SELECT id FROM categories WHERE household_id = ? AND kind = 'expense' AND (lower(name) LIKE '%super%' OR lower(name) LIKE '%aliment%') ORDER BY sort LIMIT 1`, hid,
  );
  const monthly = superCat ? Math.round(one(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE household_id = ? AND kind = 'expense' AND category_id = ?
        AND date >= date('now', 'localtime', 'start of month', '-3 months') AND date < date('now', 'localtime', 'start of month')`,
    hid, superCat.id,
  ).s / 3) : 0;
  const savingPct = usual && cheapest && usual.common_total ? 1 - cheapest.common_total / usual.common_total : 0;
  const splitPct = usual && usual.common_total ? 1 - split / usual.common_total : 0;
  res.json({
    products: products.length, common: common.length, stores, compared: compare.map((s) => s.store), cheapest: cheapest?.store || null,
    usual: usual?.store || null, saving_pct: savingPct, split_total: split, split_pct: splitPct, split_assignment: assignment,
    monthly_super: monthly, monthly_saving: Math.round(monthly * Math.max(savingPct, 0)), monthly_saving_split: Math.round(monthly * Math.max(splitPct, 0)),
    items: common.map((p) => ({ id: p.id, name: p.name, prices: Object.fromEntries(compare.map((s) => [s.store, priceAt(p, s.store)])) })),
  });
});

export default r;
