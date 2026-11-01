// Mascotas: la comida se anota como el resto de cuidados y su coste queda como gasto de esa mascota (en «Mascotas» y sin
// poner la veterinaria como comercio); lo de la clínica sí lleva la veterinaria. Y la tabla rehecha no pierde nada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';

const H = '/api/h/1';
let srv;
let ana;
let luna;

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  luna = await ana.ok('POST', `${H}/pets`, { name: 'Luna', species: 'dog', vet: 'Clínica San Antón', food: 'Pienso Advance Medium Adult, 2 tomas' });
});
after(() => srv?.stop());

const txOf = (title) => {
  const db = new Database(srv.db, { readonly: true });
  const t = db.prepare(`SELECT t.*, c.name AS category FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.description = ?`).get(`Luna: ${title}`);
  db.close();
  return t;
};

test('la comida se anota con su gasto: de Luna, en «Mascotas» y sin la veterinaria como comercio', async () => {
  const r = await ana.post(`${H}/pets/${luna.id}/events`, { type: 'food', title: 'Pienso', date: '2026-10-30', cost: 4599, method: 'card', next_date: '2026-11-29' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const t = txOf('Pienso');
  assert.deepEqual([t.amount, t.pet_id, t.category, t.merchant, t.method], [4599, luna.id, 'Mascotas', '', 'card']);
  const pet = await ana.ok('GET', `${H}/pets/${luna.id}`);
  assert.ok(pet.events.some((e) => e.type === 'food' && e.next_date === '2026-11-29'), 'con aviso para volver a comprar');
});

test('sin título, la comida se llama «Comida»; lo del veterinario lleva la clínica como comercio', async () => {
  await ana.ok('POST', `${H}/pets/${luna.id}/events`, { type: 'food', date: '2026-10-31', cost: 899 });
  assert.equal(txOf('Comida').amount, 899);
  await ana.ok('POST', `${H}/pets/${luna.id}/events`, { type: 'vet', title: 'Consulta', date: '2026-10-31', cost: 3500 });
  assert.equal(txOf('Consulta').merchant, 'Clínica San Antón');
  assert.equal((await ana.post(`${H}/pets/${luna.id}/events`, { type: 'pizza', date: '2026-10-31' })).status, 400);
});

test('la tabla de cuidados rehecha acepta la comida y sigue enlazada con sus gastos', async () => {
  const db = new Database(srv.db, { readonly: true });
  assert.match(db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'pet_events'`).get().sql, /'food'/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_pet_events'`).get());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_events WHERE transaction_id IS NOT NULL').get().n, 3);
  db.close();
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
