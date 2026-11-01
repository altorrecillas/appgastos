// Lista de la compra, comparador de precios (también por kilo), histórico e inflación propia, y fichas de producto.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';

let srv;
let ana;
const H = '/api/h/1';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => ymd(new Date(Date.now() - n * 864e5));
const TODAY = ymd(new Date());
const product = async (name) => (await ana.ok('GET', `${H}/prices`)).products.find((p) => p.name === name);

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
});
after(() => srv?.stop());

test('añadir varios productos de golpe, con cantidad', async () => {
  const list = await ana.ok('POST', `${H}/shopping/lists`, { name: 'Semana', store: 'Mercadona' });
  const r = await ana.ok('POST', `${H}/shopping/lists/${list.id}/items`, { name: 'Leche, pan, 2 kg naranjas' });
  const names = r.items.map((i) => `${i.name}|${i.qty}`).sort();
  assert.deepEqual(names, ['Leche|', 'Naranjas|2 kg', 'Pan|']);
});

test('precio por kilo y bandejas: se comparan por kilo y un precio suelto «por unidad» no rompe la comparación', async () => {
  await ana.ok('POST', `${H}/prices/bulk`, { items: [
    { product: 'Salmón', store: 'Mercadona', price: 1495, qty: 1, unit: 'kg', date: TODAY },
    { product: 'Salmón', store: 'Lidl', price: 1299, qty: 1, unit: 'kg', date: TODAY },
    { product: 'Salmón', store: 'Carrefour', price: 549, qty: 400, unit: 'g', date: TODAY },
    { product: 'Salmón', store: 'Dia', price: 600, qty: 1, unit: 'ud', date: TODAY },
  ] });
  const p = await product('Salmón');
  assert.equal(p.base_unit, 'kg');
  assert.equal(p.best.store, 'Lidl');
  assert.equal(p.worst.store, 'Mercadona');
  assert.equal(Math.round(p.stores.Carrefour.unit_price), 1373, '5,49 € los 400 g = 13,73 €/kg');
});

test('terminar la compra: anota el gasto y guarda los precios con el peso de la lista', async () => {
  const list = await ana.ok('POST', `${H}/shopping/lists`, { name: 'Pescadería', store: 'Alcampo' });
  await ana.ok('POST', `${H}/prices/bulk`, { items: [{ product: 'Merluza', store: 'Lidl', price: 1199, qty: 1, unit: 'kg', date: daysAgo(10) }] });
  const r = await ana.ok('POST', `${H}/shopping/lists/${list.id}/items`, { name: 'Pechuga de pollo, Merluza, Yogures' });
  const id = (n) => r.items.find((i) => i.name === n).id;
  await ana.ok('PATCH', `${H}/shopping/items/${id('Pechuga de pollo')}`, { name: 'Pechuga de pollo', qty: '1,2 kg', price: 840, checked: true });
  await ana.ok('PATCH', `${H}/shopping/items/${id('Merluza')}`, { name: 'Merluza', price: 900, checked: true }); // al peso, sin peso
  await ana.ok('PATCH', `${H}/shopping/items/${id('Yogures')}`, { name: 'Yogures', qty: '2', price: 320, checked: true });
  const done = await ana.ok('POST', `${H}/shopping/lists/${list.id}/complete`, { amount: 2060, merchant: 'Alcampo', save_prices: true, date: TODAY });
  assert.ok(!done.items.some((i) => i.checked), 'lo comprado sale de la lista');
  const tx = (await ana.ok('GET', `${H}/transactions?from=${TODAY}&to=${TODAY}`)).items.find((t) => t.list_id === list.id);
  assert.equal(tx.amount, 2060);
  const pollo = (await product('Pechuga de pollo')).stores.Alcampo;
  assert.deepEqual([pollo.qty, pollo.unit, Math.round(pollo.unit_price)], [1.2, 'kg', 700], '8,40 € por 1,2 kg = 7 €/kg');
  assert.equal((await product('Merluza')).stores.Alcampo, undefined, 'sin peso no se sabe el precio por kilo');
  const yog = (await product('Yogures')).stores.Alcampo;
  assert.deepEqual([yog.qty, Math.round(yog.unit_price)], [2, 160], '2 unidades por 3,20 € = 1,60 € cada una');
});

test('dónde sale más barata la compra (cesta)', async () => {
  await ana.ok('POST', `${H}/prices/bulk`, { items: [
    { product: 'Aceite', store: 'Mercadona', price: 895, qty: 1, unit: 'l', date: TODAY },
    { product: 'Aceite', store: 'Lidl', price: 849, qty: 1, unit: 'l', date: TODAY },
    { product: 'Café', store: 'Mercadona', price: 295, qty: 250, unit: 'g', date: TODAY },
    { product: 'Café', store: 'Lidl', price: 279, qty: 250, unit: 'g', date: TODAY },
  ] });
  const b = await ana.ok('GET', `${H}/prices/basket`);
  assert.equal(b.cheapest, 'Lidl');
});

test('histórico: la subida en un año es la media de cada producto en su tienda (sin ofertas)', async () => {
  await ana.ok('POST', `${H}/prices/bulk`, { items: [
    { product: 'Huevos', store: 'Eroski', price: 200, qty: 1, unit: 'pack', date: daysAgo(372) },
    { product: 'Huevos', store: 'Eroski', price: 220, qty: 1, unit: 'pack', date: daysAgo(2) },
    { product: 'Arroz', store: 'Eroski', price: 150, qty: 1, unit: 'kg', date: daysAgo(372) },
    { product: 'Arroz', store: 'Eroski', price: 135, qty: 1, unit: 'kg', date: daysAgo(2) },
    { product: 'Pasta', store: 'Eroski', price: 100, qty: 500, unit: 'g', date: daysAgo(372) },
    { product: 'Pasta', store: 'Eroski', price: 105, qty: 500, unit: 'g', date: daysAgo(2) },
    // Una oferta no es inflación: no cuenta.
    { product: 'Pasta', store: 'Eroski', price: 50, qty: 500, unit: 'g', date: daysAgo(1), offer: true },
  ] });
  const h = await ana.ok('GET', `${H}/prices/history`);
  const eroski = h.stores.find((s) => s.store === 'Eroski');
  const expected = Math.cbrt(1.1 * 0.9 * 1.05) - 1;
  assert.ok(Math.abs(eroski.yoy - expected) < 0.0005, `${eroski.yoy} ≈ ${expected}`);
  const byName = Object.fromEntries(h.products.map((p) => [p.name, p.change]));
  assert.ok(Math.abs(byName.Huevos - 0.1) < 0.0005 && Math.abs(byName.Arroz + 0.1) < 0.0005, JSON.stringify(byName));
  assert.ok(h.years.length >= 2 && h.compare && h.compare.n >= 3);
});

test('fichas de producto: crear, renombrar (también en la lista), unir duplicados y borrar', async () => {
  const list = await ana.ok('POST', `${H}/shopping/lists`, { name: 'Fichas' });
  const created = await ana.ok('POST', `${H}/products`, { name: 'Salmón fresco', section: 'carne', unit: 'kg', unit_qty: 1, note: 'Noruego' });
  assert.equal((await ana.post(`${H}/products`, { name: 'salmón FRESCO' })).status, 400, 'no se repite el nombre');
  await ana.ok('POST', `${H}/shopping/lists/${list.id}/items`, { name: 'Salmón fresco' });
  await ana.ok('PATCH', `${H}/products/${created.id}`, { name: 'Salmón noruego' });
  const items = (await ana.ok('GET', `${H}/shopping/lists/${list.id}`)).items.map((i) => i.name);
  assert.ok(items.includes('Salmón noruego'), items.join());
  // Duplicado con un precio: al unirlo, el precio pasa al que se queda.
  await ana.ok('POST', `${H}/prices/bulk`, { items: [{ product: 'Salmon', store: 'Dia', price: 1399, qty: 1, unit: 'kg', date: TODAY }] });
  const all = (await ana.ok('GET', `${H}/products`)).products;
  const dup = all.find((p) => p.name === 'Salmon');
  await ana.ok('POST', `${H}/products/${dup.id}/merge`, { into: created.id });
  const merged = await ana.ok('GET', `${H}/products/${created.id}`);
  assert.ok(merged.prices.some((x) => x.store === 'Dia'));
  assert.equal((await ana.get(`${H}/products/${dup.id}`)).status, 404);
  await ana.ok('DELETE', `${H}/products/${created.id}`);
  assert.equal((await ana.get(`${H}/products/${created.id}`)).status, 404);
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
