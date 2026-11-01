// Cuentas, sesiones y permisos: cada hogar es privado y cada rol puede lo que le toca.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { Client, PASSWORD, join, newUser } from '../lib/client.js';

let srv;
let ana;
let beto;
let lucia;
let intruso;
before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  beto = await newUser(srv.base, 'beto', 'Beto');
  lucia = await newUser(srv.base, 'lucia', 'Lucía');
  intruso = await newUser(srv.base, 'intruso', 'Intruso');
  await join(ana, beto, 'editor');
  await join(ana, lucia, 'viewer');
});
after(() => srv?.stop());

test('registro, sesión, cierre de sesión y contraseña incorrecta', async () => {
  const c = new Client(srv.base);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'ana', password: 'no-es-esta' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'ana', password: PASSWORD })).status, 200);
  const me = await c.get('/api/auth/me');
  assert.equal(me.data.user.username, 'ana');
  assert.equal(me.data.user.password_hash, undefined, 'el hash de la contraseña no sale nunca');
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('sin la cabecera anti-CSRF no se puede escribir', async () => {
  const r = await ana.post('/api/h/1/transactions', { kind: 'expense', amount: 100 }, { csrf: false });
  assert.equal(r.status, 403);
});

test('un hogar ajeno no existe para quien no es miembro', async () => {
  for (const path of ['/api/h/1', '/api/h/1/transactions', '/api/h/1/notes', '/api/h/1/stats/dashboard', '/api/h/1/data/export.json']) {
    assert.equal((await intruso.get(path)).status, 404, path);
  }
  assert.equal((await intruso.post('/api/h/1/transactions', { kind: 'expense', amount: 100 })).status, 404);
});

test('lector: lee, pero no puede cambiar nada del hogar', async () => {
  assert.equal((await lucia.get('/api/h/1/transactions')).status, 200);
  for (const [m, path, body] of [
    ['POST', '/api/h/1/transactions', { kind: 'expense', amount: 100 }],
    ['POST', '/api/h/1/shopping/lists', { name: 'Mía' }],
    ['POST', '/api/h/1/recurring', { name: 'X', amount: 100, frequency: 'monthly', kind: 'expense', next_date: '2026-11-01' }],
    ['PATCH', '/api/h/1', { name: 'Hackeado' }],
  ]) assert.equal((await lucia.req(m, path, body)).status, 403, `${m} ${path}`);
});

test('editor: anota, pero no administra el hogar', async () => {
  assert.equal((await beto.post('/api/h/1/transactions', { kind: 'expense', amount: 1234, date: '2026-10-01' })).status, 201);
  assert.equal((await beto.patch('/api/h/1', { name: 'Otro nombre' })).status, 403);
  assert.equal((await beto.post('/api/h/1/invitations', { username: 'intruso', role: 'admin' })).status, 403);
});

test('importes: solo céntimos enteros y con sentido', async () => {
  for (const amount of [12.5, -100, 0, 'abc', 1e13]) {
    const r = await ana.post('/api/h/1/transactions', { kind: 'expense', amount, date: '2026-10-01' });
    assert.equal(r.status, 400, `importe ${amount}`);
  }
  const bad = await ana.post('/api/h/1/transactions', { kind: 'expense', amount: 100, date: '2026-02-30' });
  assert.equal(bad.status, 400, 'una fecha que no existe');
});

test('los datos de otro hogar no se pueden enlazar (ids ajenos)', async () => {
  // Una categoría del hogar del intruso no vale en el hogar 1.
  const own = (await intruso.ok('GET', '/api/auth/me')).households[0].id;
  const theirs = (await intruso.ok('GET', `/api/h/${own}`)).categories[0].id;
  const r = await ana.post('/api/h/1/transactions', { kind: 'expense', amount: 100, date: '2026-10-01', category_id: theirs });
  assert.equal(r.status, 400);
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
