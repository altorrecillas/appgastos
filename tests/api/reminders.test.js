// Recordatorios con hora: se guarda la hora del aviso, se cambia, y una hora imposible se rechaza.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';

const H = '/api/h/1';
let srv;
let ana;

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
});
after(() => srv?.stop());

const find = async (id) => (await ana.ok('GET', `${H}/reminders`)).active.find((m) => m.id === id);

test('el aviso se guarda con su hora, y se puede cambiar o quitar', async () => {
  const r = await ana.post(`${H}/reminders`, { kind: 'date', title: 'Recoger a Hugo', date: '2030-05-10', repeat: 'none', remind_days: 0, remind_time: '18:30' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.id;
  assert.deepEqual([(await find(id)).remind_days, (await find(id)).remind_time], [0, '18:30']);
  await ana.ok('PATCH', `${H}/reminders/${id}`, { remind_time: '07:05' });
  assert.equal((await find(id)).remind_time, '07:05');
  await ana.ok('PATCH', `${H}/reminders/${id}`, { remind_time: '' });
  assert.equal((await find(id)).remind_time, null, 'sin hora, a la de los avisos del día');
});

test('una hora imposible se rechaza', async () => {
  for (const remind_time of ['25:00', '18:60', '9:00', 'tarde']) {
    const r = await ana.post(`${H}/reminders`, { kind: 'date', title: 'X', date: '2030-05-10', repeat: 'none', remind_days: 0, remind_time });
    assert.equal(r.status, 400, remind_time);
  }
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
