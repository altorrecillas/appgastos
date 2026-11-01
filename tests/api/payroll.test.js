// Nóminas que cambian cada mes: a partir del día elegido se pregunta el importe de cada nómina (una por persona),
// con la anterior como referencia; lo contestado es lo que usa la previsión, y se configura en Ajustes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { join, newUser } from '../lib/client.js';

let srv;
let ana;
let beto;
let lucia;
let anaPay;
let betoPay;
const H = '/api/h/1';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const TODAY = ymd(now);
const DAY = now.getDate();
const MONTH_END = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
const PREV_END = ymd(new Date(now.getFullYear(), now.getMonth(), 0));
const dash = () => ana.ok('GET', `${H}/stats/dashboard`);
const questions = async () => (await dash()).income_questions;

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  beto = await newUser(srv.base, 'beto', 'Beto');
  lucia = await newUser(srv.base, 'lucia', 'Lucía');
  await join(ana, beto, 'editor');
  await join(ana, lucia, 'viewer');
  const people = (await ana.ok('GET', H)).people;
  const anaId = people.find((p) => p.name === 'Ana')?.id ?? null;
  const betoId = (await ana.ok('POST', `${H}/people`, { name: 'Beto' })).people?.find((p) => p.name === 'Beto')?.id
    ?? (await ana.ok('GET', H)).people.find((p) => p.name === 'Beto').id;
  // La de Ana se cobra a fin de mes y el mes pasado fue de 1.750 €; la de Beto es nueva (prevista 1.500 €).
  anaPay = await ana.ok('POST', `${H}/recurring`, {
    kind: 'income', name: 'Nómina', amount: 180000, variable: true, frequency: 'monthly', start_date: PREV_END, auto: false, person_id: anaId,
  });
  await ana.ok('POST', `${H}/recurring/${anaPay.id}/pay`, { amount: 175000, date: PREV_END });
  betoPay = await ana.ok('POST', `${H}/recurring`, {
    kind: 'income', name: 'Nómina', amount: 150000, variable: true, frequency: 'monthly', start_date: MONTH_END, auto: false, person_id: betoId,
  });
  // Un ingreso fijo que no cambia no se pregunta.
  await ana.ok('POST', `${H}/recurring`, { kind: 'income', name: 'Alquiler del garaje', amount: 6000, frequency: 'monthly', start_date: MONTH_END, auto: false });
});
after(() => srv?.stop());

test('por defecto se pregunta desde el día 1, una vez por cada nómina que cambia (una por persona)', async () => {
  assert.deepEqual((await ana.ok('GET', H)).household.income_check, { enabled: true, day: 1 });
  const qs = await questions();
  assert.equal(qs.length, 2, JSON.stringify(qs));
  const a = qs.find((q) => q.id === anaPay.id);
  const b = qs.find((q) => q.id === betoPay.id);
  assert.deepEqual([a.person_name, a.previous, a.amount], ['Ana', { amount: 175000, date: PREV_END }, 175000], 'la referencia es lo último cobrado');
  assert.deepEqual([b.person_name, b.previous, b.amount], ['Beto', null, 150000], 'sin cobros aún, la prevista');
  assert.equal(a.month, TODAY.slice(0, 7));
});

test('lo que se contesta es el importe del mes: la previsión lo usa y deja de preguntarse', async () => {
  const before = (await dash()).forecast.expectedIncome;
  await ana.ok('POST', `${H}/recurring/${anaPay.id}/month-amount`, { amount: 190000 });
  const after = (await dash()).forecast.expectedIncome;
  assert.equal(after - before, 190000 - 175000);
  assert.deepEqual((await questions()).map((q) => q.id), [betoPay.id]);
  // Beto, editor, confirma la suya «igual».
  await beto.ok('POST', `${H}/recurring/${betoPay.id}/month-amount`, { amount: 150000 });
  assert.deepEqual(await questions(), []);
});

test('quien solo puede ver no contesta; no se confirma un gasto ni un importe vacío', async () => {
  assert.equal((await lucia.post(`${H}/recurring/${anaPay.id}/month-amount`, { amount: 100 })).status, 403);
  const gasto = await ana.ok('POST', `${H}/recurring`, { kind: 'expense', name: 'Luz', amount: 6000, variable: true, frequency: 'monthly', start_date: MONTH_END });
  assert.equal((await ana.post(`${H}/recurring/${gasto.id}/month-amount`, { amount: 5000 })).status, 400);
  assert.equal((await ana.post(`${H}/recurring/${anaPay.id}/month-amount`, {})).status, 400);
});

test('al cobrarla, lo cobrado pasa a ser la referencia del mes siguiente', async () => {
  const paid = await ana.ok('POST', `${H}/recurring/${anaPay.id}/pay`, { amount: 192345 });
  assert.equal(paid.amount, 192345);
  assert.ok(paid.next_date > MONTH_END, 'la de este mes ya está cobrada');
});

test('en Ajustes: solo un administrador lo activa o lo cambia de día; apagado no pregunta', async () => {
  assert.equal((await beto.patch(`${H}/income-check`, { enabled: false })).status, 403);
  const extra = await ana.ok('POST', `${H}/recurring`, {
    kind: 'income', name: 'Pensión', amount: 90000, variable: true, frequency: 'monthly', start_date: MONTH_END, auto: false,
  });
  assert.deepEqual((await questions()).map((q) => q.id), [extra.id]);
  const off = await ana.ok('PATCH', `${H}/income-check`, { enabled: false });
  assert.deepEqual(off.household.income_check, { enabled: false, day: 1 });
  assert.deepEqual(await questions(), []);
  // Desde el día 28: hoy solo se pregunta si ya es 28 o más.
  await ana.ok('PATCH', `${H}/income-check`, { enabled: true, day: 28 });
  assert.equal((await questions()).length, DAY >= 28 ? 1 : 0);
  assert.equal((await ana.patch(`${H}/income-check`, { day: 31 })).status, 400, 'como mucho el 28 (todos los meses lo tienen)');
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
