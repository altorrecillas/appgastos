// Home Assistant (contra uno simulado): conexión solo para administradores, el token nunca sale del servidor
// y se guarda cifrado, sensores, y que lo medido se cuente bien (usos, horas y gasto estimado de cada día).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { startServer } from '../lib/server.js';
import { join, newUser } from '../lib/client.js';
import { TOKEN, expectedKwh, startFakeHA } from '../lib/fakeha.js';

let srv;
let ha;
let ana;
let beto;
let lucia;
const H = '/api/h/1';
const pad = (n) => String(n).padStart(2, '0');
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const db = () => new Database(srv.db, { readonly: true, fileMustExist: true });

before(async () => {
  ha = await startFakeHA();
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  beto = await newUser(srv.base, 'beto', 'Beto');
  lucia = await newUser(srv.base, 'lucia', 'Lucía');
  await join(ana, beto, 'editor');
  await join(ana, lucia, 'viewer');
  // Precio fijo y sin impuestos: el coste se puede calcular a mano.
  await ana.ok('PATCH', `${H}/power/settings`, { tariff: 'fixed', price: 0.2, taxes: false });
});
after(async () => {
  await srv?.stop();
  await ha?.stop();
});

test('solo un administrador conecta Home Assistant', async () => {
  assert.equal((await beto.put(`${H}/ha/connection`, { url: ha.url, token: TOKEN })).status, 403);
  assert.equal((await lucia.put(`${H}/ha/connection`, { url: ha.url, token: TOKEN })).status, 403);
});

test('un token malo se explica', async () => {
  const r = await ana.put(`${H}/ha/connection`, { url: ha.url, token: 'token-equivocado-0123456789abcdef' });
  assert.ok(r.status >= 400);
  assert.match(r.data.error, /rechazado el token/);
});

test('conectar: el token se guarda cifrado y nunca vuelve al navegador', async () => {
  const r = await ana.put(`${H}/ha/connection`, { url: `${ha.url}/`, token: TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(!JSON.stringify(r.data).includes(TOKEN));
  assert.equal(r.data.token_ok, true);
  assert.match(r.data.token_hint, /^toke…cdef$/);
  for (const c of [ana, beto, lucia]) {
    const s = await c.get(`${H}/ha/status`);
    assert.ok(!JSON.stringify(s.data).includes(TOKEN), 'el estado no lleva el token');
    assert.equal(s.data.token_enc, undefined);
  }
  const raw = db().prepare('SELECT ha FROM households WHERE id = 1').get().ha;
  assert.ok(!raw.includes(TOKEN), 'en la base de datos va cifrado');
  assert.ok(JSON.parse(raw).token_enc);
});

test('sensores: enchufes con energía y potencia emparejadas; la temperatura no cuenta', async () => {
  const r = await ana.ok('GET', `${H}/ha/sensors`);
  const energy = r.energy || r;
  const lav = energy.find((e) => e.entity_id === 'sensor.lavadora_energy');
  assert.equal(lav.power_entity, 'sensor.lavadora_power');
  assert.ok(!JSON.stringify(r).includes('salon_temperatura'));
});

test('lo medido se cuenta bien: usos, horas y gasto estimado de cada día', async () => {
  const lav = await ana.post(`${H}/ha/links`, { name: 'Lavadora', icon: '🧺', energy_entity: 'sensor.lavadora_energy', power_entity: 'sensor.lavadora_power', mode: 'cycles' });
  assert.equal(lav.status, 201, JSON.stringify(lav.data));
  const nev = await ana.post(`${H}/ha/links`, { name: 'Nevera', icon: '🧊', energy_entity: 'sensor.nevera_energy', power_entity: 'sensor.nevera_power', mode: 'continuous' });
  assert.equal(nev.status, 201, JSON.stringify(nev.data));
  const sync = await ana.post(`${H}/ha/sync`);
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  const d = db();
  for (let back = 1; back <= 5; back++) {
    const date = daysAgo(back);
    const uses = (id) => d.prepare("SELECT * FROM power_usages WHERE link_id = ? AND date = ? AND source = 'ha' ORDER BY start_time").all(id, date);
    const l = uses(lav.data.link.id);
    assert.equal(l.length, 1, `${date}: un lavado`);
    assert.deepEqual([l[0].start_time, l[0].end_time], ['10:00', '10:30'], `${date}: hora del lavado`);
    assert.ok(Math.abs(l[0].kwh - 1) < 0.01, `${date}: 1 kWh (${l[0].kwh})`);
    assert.equal(l[0].cost, 20, `${date}: 1 kWh a 0,20 €`);
    const n = uses(nev.data.link.id);
    const want = expectedKwh('nevera', date);
    assert.equal(n.length, 1, `${date}: la nevera es un uso al día`);
    assert.equal(n[0].start_time, null);
    assert.ok(Math.abs(n[0].kwh - want) < 0.02, `${date}: nevera ${n[0].kwh} ≈ ${want}`);
    const hourly = d.prepare('SELECT SUM(kwh) AS k FROM ha_hourly WHERE link_id = ? AND date = ?').get(nev.data.link.id, date).k;
    assert.ok(Math.abs(hourly - want) < 0.02, `${date}: horas de la nevera ${hourly} ≈ ${want}`);
    const est = d.prepare('SELECT amount FROM transactions WHERE estimate = 1 AND date = ?').all(date);
    assert.equal(est.length, 1, `${date}: un gasto estimado`);
    assert.equal(est[0].amount, l[0].cost + n[0].cost, `${date}: el gasto estimado es la suma de lo medido`);
  }
  d.close();
});

test('una lectora ve el estado pero no puede sincronizar ni desconectar', async () => {
  assert.equal((await lucia.get(`${H}/ha/status`)).status, 200);
  assert.equal((await lucia.post(`${H}/ha/sync`)).status, 403);
  assert.equal((await lucia.del(`${H}/ha/connection`)).status, 403);
});

test('desconectar borra el token', async () => {
  await ana.ok('DELETE', `${H}/ha/connection`);
  const s = await ana.ok('GET', `${H}/ha/status`);
  assert.equal(s.token_ok, false);
  assert.ok(!db().prepare('SELECT ha FROM households WHERE id = 1').get().ha.includes('token_enc"'));
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
