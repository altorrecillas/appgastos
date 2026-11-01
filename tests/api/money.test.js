// Cuadre de importes con un año de datos de ejemplo: todo lo que enseña la app suma exactamente los movimientos.
// Y los flujos que mueven dinero (anotar, editar, borrar, pagos fijos, facturas, ahorro) dejan cada céntimo en su sitio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';

let srv;
let ana;
const H = '/api/h/1';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = ymd(new Date());
const monthOf = (d) => d.slice(0, 7);
const shift = (m, k) => {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + mo - 1 + k;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
const lastDay = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return `${m}-${pad(new Date(y, mo, 0).getDate())}`;
};

// Todos los movimientos de un periodo, página a página, sumados por tipo de forma independiente.
async function sums(from, to) {
  const out = { expense: 0, income: 0, n: 0, listed: null };
  for (let offset = 0; ; offset += 1000) {
    const r = await ana.ok('GET', `${H}/transactions?from=${from}&to=${to}&limit=1000&offset=${offset}`);
    if (!out.listed) out.listed = { expense: r.expense, income: r.income, total: r.total };
    for (const t of r.items) {
      assert.ok(Number.isInteger(t.amount) && t.amount > 0, `importe en céntimos enteros: ${t.amount}`);
      out[t.kind] += t.amount;
      out.n++;
    }
    if (r.items.length < 1000) break;
  }
  return out;
}

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  await ana.ok('POST', `${H}/demo`);
  await ana.ok('GET', `${H}/stats/dashboard`); // procesa los pagos automáticos pendientes antes de cuadrar
});
after(() => srv?.stop());

test('cada mes del último año: inicio, categorías, días, tendencia y lista cuadran con los movimientos', async () => {
  const cm = monthOf(TODAY);
  for (let k = 0; k < 12; k++) {
    const m = shift(cm, -k);
    const s = await sums(`${m}-01`, lastDay(m));
    const d = await ana.ok('GET', `${H}/stats/dashboard?month=${m}`);
    assert.equal(d.totals.expense, s.expense, `${m}: gastos del inicio`);
    assert.equal(d.totals.income, s.income, `${m}: ingresos del inicio`);
    assert.equal(s.listed.expense, s.expense, `${m}: total de la lista de movimientos`);
    assert.equal(s.listed.income, s.income, `${m}: ingresos de la lista`);
    assert.equal(s.listed.total, s.n, `${m}: número de movimientos`);
    assert.equal(d.byCategory.reduce((a, c) => a + c.total, 0), s.expense, `${m}: las categorías suman el gasto`);
    assert.equal(d.daily.reduce((a, x) => a + x, 0), s.expense, `${m}: los días suman el gasto`);
    const tr = d.trend.find((x) => x.month === m);
    assert.deepEqual([tr.expense, tr.income], [s.expense, s.income], `${m}: tendencia`);
    if (k > 0) assert.ok(s.expense > 0, `${m}: el ejemplo tiene gastos`);
  }
});

test('el resumen de cada mes cuadra', async () => {
  const cm = monthOf(TODAY);
  for (let k = 0; k < 6; k++) {
    const m = shift(cm, -k);
    const s = await sums(`${m}-01`, lastDay(m));
    const r = await ana.ok('GET', `${H}/stats/recap?month=${m}`);
    assert.deepEqual([r.totals.expense, r.totals.income], [s.expense, s.income], `resumen de ${m}`);
    assert.ok(r.categories.every((c) => c.total <= s.expense));
  }
});

test('el análisis de un año cuadra (totales, meses y categorías)', async () => {
  const from = `${shift(monthOf(TODAY), -11)}-01`;
  const to = lastDay(monthOf(TODAY));
  const s = await sums(from, to);
  const a = await ana.ok('GET', `${H}/stats/analytics?from=${from}&to=${to}`);
  assert.deepEqual([a.totals.expense, a.totals.income], [s.expense, s.income]);
  assert.equal(a.byCategory.reduce((x, c) => x + c.total, 0), s.expense, 'las categorías suman el gasto');
  assert.equal(a.monthly.reduce((x, mo) => x + mo.expense, 0), s.expense, 'los meses suman el gasto');
  assert.equal(a.incomeByCategory.reduce((x, c) => x + c.total, 0), s.income, 'los ingresos por categoría suman');
});

test('la exportación CSV suma lo mismo', async () => {
  const m = shift(monthOf(TODAY), -1);
  const s = await sums(`${m}-01`, lastDay(m));
  const r = await ana.get(`${H}/transactions/export.csv?from=${m}-01&to=${lastDay(m)}`);
  const lines = r.data.toString('utf8').replace(/^﻿/, '').split('\r\n').slice(1).filter(Boolean);
  let expense = 0;
  let income = 0;
  for (const l of lines) {
    const cols = l.split(';');
    const cents = Math.round(Number(cols[2].replace(',', '.')) * 100);
    if (cols[1] === 'Gasto') expense -= cents;
    else income += cents;
  }
  assert.equal(lines.length, s.n);
  assert.deepEqual([expense, income], [s.expense, s.income]);
});

test('anotar, editar y borrar mueven el total exactamente', async () => {
  const m = monthOf(TODAY);
  const before0 = (await ana.ok('GET', `${H}/stats/dashboard?month=${m}`)).totals.expense;
  const t = await ana.ok('POST', `${H}/transactions`, { kind: 'expense', amount: 1234, date: TODAY, description: 'Prueba' });
  assert.equal((await ana.ok('GET', `${H}/stats/dashboard?month=${m}`)).totals.expense, before0 + 1234);
  await ana.ok('PATCH', `${H}/transactions/${t.id}`, { amount: 2001 });
  assert.equal((await ana.ok('GET', `${H}/stats/dashboard?month=${m}`)).totals.expense, before0 + 2001);
  await ana.ok('DELETE', `${H}/transactions/${t.id}`);
  assert.equal((await ana.ok('GET', `${H}/stats/dashboard?month=${m}`)).totals.expense, before0);
});

test('pago fijo: pagar anota el importe y pasa al mes siguiente; saltar no anota nada', async () => {
  const rec = await ana.ok('POST', `${H}/recurring`, { kind: 'expense', name: 'Gimnasio de prueba', amount: 3499, frequency: 'monthly', start_date: TODAY, auto: false });
  const id = rec.id ?? rec.item?.id;
  const n0 = (await sums(TODAY, TODAY)).n;
  const paid = await ana.ok('POST', `${H}/recurring/${id}/pay`);
  const t = await ana.ok('GET', `${H}/transactions/${paid.transaction_id}`);
  assert.equal(t.amount, 3499);
  assert.equal(t.recurring_id, id);
  assert.equal(paid.next_date, shift(monthOf(TODAY), 1) + TODAY.slice(7), 'pasa al mes siguiente');
  const skipped = await ana.ok('POST', `${H}/recurring/${id}/skip`);
  assert.equal(skipped.next_date, shift(monthOf(TODAY), 2) + TODAY.slice(7));
  assert.equal((await sums(TODAY, TODAY)).n, n0 + 1, 'saltar no anota nada');
});

test('factura: pagarla anota el gasto y marcarla pendiente lo quita', async () => {
  const b = await ana.ok('POST', `${H}/bills`, { supplier: 'Aguas de prueba', amount: 9850, issue_date: TODAY, due_date: TODAY });
  const id = b.id ?? b.item?.id;
  const s0 = await sums(TODAY, TODAY);
  const paid = await ana.ok('POST', `${H}/bills/${id}/pay`, { date: TODAY });
  assert.equal(paid.status, 'paid');
  const s1 = await sums(TODAY, TODAY);
  assert.equal(s1.expense, s0.expense + 9850);
  await ana.ok('POST', `${H}/bills/${id}/unpay`);
  assert.equal((await sums(TODAY, TODAY)).expense, s0.expense);
  assert.equal((await ana.post(`${H}/bills/${id}/pay`, {})).status, 200);
  assert.equal((await ana.post(`${H}/bills/${id}/pay`, {})).status, 400, 'no se paga dos veces');
});

test('ahorro: lo apartado y retirado se refleja al céntimo', async () => {
  const g = await ana.ok('POST', `${H}/goals`, { name: 'Meta de prueba', target: 100000 });
  const id = g.id;
  await ana.ok('POST', `${H}/goals/${id}/moves`, { amount: 12550, date: TODAY });
  await ana.ok('POST', `${H}/goals/${id}/moves`, { amount: -3025, date: TODAY });
  assert.equal((await ana.post(`${H}/goals/${id}/moves`, { amount: 0, date: TODAY })).status, 400);
  const goal = (await ana.ok('GET', `${H}/goals`)).find((x) => x.id === id);
  assert.equal(goal.moves.reduce((a, mv) => a + mv.amount, 0), 9525);
  if ('saved' in goal) assert.equal(goal.saved, 9525);
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
