// Presupuestos en el inicio: el presupuesto total es solo el del hogar (para todo el gasto); un límite de categoría
// («Restaurantes: 200 €») cuenta solo lo de su categoría y no se convierte en el presupuesto de todo el mes.
// Y la previsión de cierre no se dispara los primeros días del mes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';

const H = '/api/h/1';
let srv;
let ana;
let cat;
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const month = today.slice(0, 7);
const dayNow = Number(today.slice(8));
const prevMonth = (() => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();
const spend = (name, amount, date = today) => ana.ok('POST', `${H}/transactions`, { kind: 'expense', amount, date, description: name, category_id: cat(name) });
const dash = () => ana.ok('GET', `${H}/stats/dashboard?month=${month}`);

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  const { categories } = await ana.ok('GET', H);
  cat = (n) => categories.find((c) => c.name === n).id;
});
after(() => srv?.stop());

test('sin meses anteriores, la primera semana la previsión va marcada como poco fiable', async () => {
  await spend('Supermercado', 50000);
  assert.equal((await dash()).forecast.rough, dayNow < 7);
});

test('con solo un límite de Restaurantes, no hay presupuesto total: el límite va aparte con lo suyo', async () => {
  await ana.ok('PATCH', `${H}/categories/${cat('Restaurantes')}`, { budget: 20000 });
  await spend('Restaurantes', 15000);
  await spend('Vivienda', 59000);
  const d = await dash();
  assert.equal(d.budgetTotal, null, 'no se suma el límite de una categoría como presupuesto de todo');
  assert.equal(d.totals.expense, 124000);
  assert.deepEqual(d.budgets.map((b) => [b.name, b.budget, b.total]), [['Restaurantes', 20000, 15000]]);
});

test('el presupuesto total del hogar sí cubre todo el gasto', async () => {
  await ana.ok('PATCH', H, { monthly_budget: 250000 });
  const d = await dash();
  assert.equal(d.budgetTotal, 250000);
  assert.equal(d.budgets.length, 1, 'y el límite de Restaurantes sigue a su aire');
  await ana.ok('PATCH', H, { monthly_budget: null });
  assert.equal((await dash()).budgetTotal, null);
});

test('la previsión mezcla, hasta el día 15, el ritmo del mes con lo que se suele gastar al día', async () => {
  await spend('Supermercado', 93000, `${prevMonth}-10`); // el mes pasado, 930 € del día a día
  const d = await dash();
  const prevDays = new Date(Number(prevMonth.slice(0, 4)), Number(prevMonth.slice(5)), 0).getDate();
  const histRate = 93000 / prevDays;
  const w = Math.min(1, dayNow / 15);
  const rate = w * (124000 / dayNow) + (1 - w) * histRate;
  assert.equal(d.forecast.variableRest, Math.round(rate * (d.days - dayNow)));
  assert.equal(d.forecast.rough, false);
  assert.equal(d.forecast.total, d.totals.expense + d.forecast.scheduled + d.forecast.variableRest);
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
