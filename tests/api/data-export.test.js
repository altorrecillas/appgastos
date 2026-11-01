// Copia completa del hogar (JSON): no se lleva secretos ni notas privadas de otros, solo la importa un administrador,
// y al importarla en un servidor nuevo todo cuadra al céntimo (movimientos, precios, notas).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { join, newUser } from '../lib/client.js';

let srv;
let srv2;
let ana;
let beto;
let lucia;
let copy;
const H = '/api/h/1';

// Total de gastos e ingresos de toda la historia, según la propia lista de movimientos.
const totals = async (c) => {
  const r = await c.ok('GET', `${H}/transactions?from=1990-01-01&to=2100-12-31&limit=1`);
  return { expense: r.expense, income: r.income };
};
const privateBook = async (c) => (await c.ok('GET', `${H}/notes/meta`)).books.find((b) => b.private).id;
const sharedBook = async (c) => (await c.ok('GET', `${H}/notes/meta`)).books.find((b) => !b.private).id;
// Precio por kilo, litro o unidad de cada producto en cada tienda, para comparar dos servidores.
const priceMap = async (c) => {
  const out = {};
  for (const p of (await c.ok('GET', `${H}/prices`)).products) {
    for (const [st, x] of Object.entries(p.stores)) out[`${p.name}|${st}`] = Math.round(x.unit_price);
  }
  return out;
};

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  beto = await newUser(srv.base, 'beto', 'Beto');
  lucia = await newUser(srv.base, 'lucia', 'Lucía');
  await join(ana, beto, 'editor');
  await join(ana, lucia, 'viewer');
  await ana.ok('POST', `${H}/demo`);
  await ana.ok('POST', `${H}/notes`, { book_id: await privateBook(ana), title: 'Secreto de Ana', body: 'La clave del trastero' });
  await beto.ok('POST', `${H}/notes`, { book_id: await privateBook(beto), title: 'Secreto de Beto', body: 'El regalo de Ana' });
  await ana.ok('POST', `${H}/notes`, { book_id: await sharedBook(ana), title: 'Turnos de limpieza', body: 'Lunes: Beto' });
});
after(async () => {
  await srv?.stop();
  await srv2?.stop();
});

test('la copia lleva lo del hogar y tus notas privadas, nunca las de otros ni contraseñas', async () => {
  const r = await ana.get(`${H}/data/export.json`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="gastosbyath-.*\.json"/);
  copy = r.data;
  const raw = JSON.stringify(copy);
  assert.equal(copy.format, 'gastosbyath-backup');
  assert.ok(copy.transactions.length > 100, 'con un año de datos de ejemplo');
  assert.ok(raw.includes('Secreto de Ana') && raw.includes('Turnos de limpieza'));
  assert.ok(!raw.includes('Secreto de Beto') && !raw.includes('El regalo de Ana'), 'las privadas de Beto no salen');
  for (const s of ['password', 'token', 'secret', 'session']) assert.ok(!new RegExp(`"[a-z_]*${s}[a-z_]*":`, 'i').test(raw), `sin campos «${s}»`);
  const beto1 = JSON.stringify((await beto.ok('GET', `${H}/data/export.json`)).notes);
  assert.ok(beto1.includes('Secreto de Beto') && !beto1.includes('Secreto de Ana'), 'y al revés');
});

test('solo un administrador puede importar una copia', async () => {
  assert.equal((await beto.post(`${H}/data/import.json`, copy)).status, 403);
  assert.equal((await lucia.post(`${H}/data/import.json`, copy)).status, 403);
});

test('un archivo que no es una copia se rechaza con un mensaje claro', async () => {
  const r = await ana.post(`${H}/data/import.json`, { hola: 'mundo' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no es una copia de seguridad/);
});

test('restaurada en un servidor nuevo, todo cuadra al céntimo', async () => {
  srv2 = await startServer();
  const nueva = await newUser(srv2.base, 'ana', 'Ana');
  const r = await nueva.post(`${H}/data/import.json`, copy);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.counts.transactions, copy.transactions.length);
  assert.deepEqual(await totals(nueva), await totals(ana), 'gastos e ingresos de toda la historia');
  const dates = copy.transactions.map((t) => t.date).sort();
  const months = (c) => c.ok('GET', `${H}/stats/analytics?from=${dates[0]}&to=${dates.at(-1)}`).then((a) => a.monthly);
  assert.deepEqual(await months(nueva), await months(ana), 'mes a mes');
  assert.deepEqual(await priceMap(nueva), await priceMap(ana), 'precios de cada producto en cada tienda');
  const notes = Object.fromEntries((await nueva.ok('GET', `${H}/notes`)).map((n) => [n.title, n.private]));
  assert.equal(notes['Secreto de Ana'], true, 'su nota privada sigue siendo privada');
  assert.equal(notes['Turnos de limpieza'], false);
  assert.equal(notes['Secreto de Beto'], undefined);
});

test('también se importan las copias de cuando la app se llamaba «Cuartos»', async () => {
  const c = await newUser(srv2.base, 'carla', 'Carla');
  const hid = (await c.ok('GET', '/api/auth/me')).households[0].id;
  const r = await c.post(`/api/h/${hid}/data/import.json`, { ...copy, format: 'cuartos-backup' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test('los servidores no han registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
  assert.deepEqual(srv2.errors(), []);
});
