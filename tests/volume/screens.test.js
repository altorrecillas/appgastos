// Las pantallas con muchos datos (6 años, ~50.000 movimientos): las cifras que se ven cuadran con la base de datos,
// los importes enormes caben, cargar más y buscar funcionan, y ninguna pantalla tarda demasiado ni da errores.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { bigHousehold, snapshot } from '../lib/bigdata.js';
import { DESKTOP, SKIP, launch, openApp, show, text } from '../lib/browser.js';

const YEARS = Number(process.env.VOLUME_YEARS || 6);
const pad = (n) => String(n).padStart(2, '0');
const cents = (s) => Number(String(s).replace(/[^\d-]/g, ''));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

describe('pantallas con muchos datos', { skip: SKIP }, () => {
  let srv;
  let big;
  let S;
  let browser;
  let m;
  let d;
  const timings = [];
  const sumOf = (fn) => S.tx.filter(fn).reduce((s, t) => s + t.amount, 0);
  const monthExpense = (mm) => sumOf((t) => t.kind === 'expense' && t.date.startsWith(mm));
  // Tiempo hasta que la pantalla está dibujada (sin el medio segundo fijo que espera show() tras navegar).
  async function timedShow(page, route, label) {
    const t0 = performance.now();
    await show(page, srv.base, route);
    timings.push([label, Math.max(0, Math.round(performance.now() - t0 - 500))]);
  }
  // Ningún importe se sale de su caja (en móvil, lo más justo).
  const overflowing = (page) => page.$$eval('.hero-amount, .stat .value, .rh-amount, .rc-big, .amount, .pp-price b',
    (els) => els.filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim()));

  before(async () => {
    srv = await startServer();
    big = await bigHousehold(srv, { years: YEARS });
    await big.ana.ok('GET', '/api/h/1/stats/dashboard');
    S = snapshot(srv.db);
    browser = await launch();
    m = await openApp(browser, srv.base, 'ana');
    d = await openApp(browser, srv.base, 'ana', DESKTOP);
  });
  after(async () => {
    console.log(`\nPantallas con ${S?.tx.length} movimientos:\n${timings.map(([l, ms]) => `  ${String(ms).padStart(6)} ms  ${l}`).join('\n')}`);
    await browser?.close();
    await srv?.stop();
  });

  test('Inicio: el gasto del mes cuadra, también el mes de los importes enormes, y cabe', async () => {
    const cm = big.today.slice(0, 7);
    const huge = `${Number(big.today.slice(0, 4)) - 1}-06`;
    for (const [page, label] of [[m.page, 'móvil'], [d.page, 'escritorio']]) {
      for (const mm of [cm, huge]) {
        await timedShow(page, `inicio?month=${mm}`, `Inicio ${mm} (${label})`);
        await page.waitForTimeout(1300); // el importe «cuenta» hasta su valor
        assert.equal(cents(await page.getAttribute('.hero-amount', 'aria-label')), monthExpense(mm), `${label} ${mm}`);
        assert.equal(cents(await text(page, '.hero-amount')), monthExpense(mm), `${label} ${mm}: lo que se lee`);
        assert.deepEqual(await overflowing(page), [], `${label} ${mm}: nada se sale`);
      }
    }
  });

  test('Movimientos de todo el histórico: totales, «Cargar más» y búsqueda sin acentos', async () => {
    const p = m.page;
    await timedShow(p, 'movimientos?period=all', 'Movimientos: todo (móvil)');
    const exp = sumOf((t) => t.kind === 'expense');
    const inc = sumOf((t) => t.kind === 'income');
    const stats = await p.$$eval('.stat', (els) => Object.fromEntries(els.map((e) => [e.querySelector('.label')?.textContent.trim(), e.querySelector('.value')?.textContent.trim()])));
    assert.equal(cents(stats.Gastos), exp);
    assert.equal(cents(stats.Ingresos), inc);
    assert.equal(stats.Movimientos.replace(/\D/g, ''), String(S.tx.length));
    const rows = () => p.$$eval('[data-tx]', (x) => x.length);
    const before = await rows();
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      await p.click('[data-act=load-more]');
      assert.equal(await p.$('dialog[open]'), null, '«Cargar más» no abre el menú «Más»');
      await p.waitForFunction((n) => document.querySelectorAll('[data-tx]').length > n, before + i * 150);
      timings.push([`Cargar 150 más (vez ${i + 1})`, Math.round(performance.now() - t0)]);
    }
    assert.equal(await rows(), before + 300);
    assert.deepEqual(await overflowing(p), []);
    // Tras cargar más, cada día sale una vez, con sus filas y su total (también el que quedó partido entre páginas).
    const loaded = [...S.tx].sort((x, y) => y.date.localeCompare(x.date) || y.id - x.id).slice(0, before + 300);
    const days = new Map();
    for (const t of loaded) {
      const g = days.get(t.date) || { n: 0, exp: 0, inc: 0 };
      g.n++;
      g[t.kind === 'expense' ? 'exp' : 'inc'] += t.amount;
      days.set(t.date, g);
    }
    const got = await p.$$eval('[data-list] > .day-group', (els) => els.map((e) => {
      const t = e.querySelector('.day-head .t').textContent.replace(/\u00a0/g, ' ');
      const num = (re) => Number((t.match(re)?.[1] || '0').replace(/\D/g, ''));
      return [e.dataset.day, e.querySelectorAll('[data-tx]').length, num(/−\s*([\d.,]+)/), num(/\+\s*([\d.,]+)/)];
    }));
    assert.equal(new Set(got.map((g) => g[0])).size, got.length, 'cada día una sola vez');
    assert.deepEqual(got, [...days].map(([date, g]) => [date, g.n, g.exp, g.inc]), 'filas y totales de cada día');
    await timedShow(p, 'movimientos?period=all&q=nandu', 'Movimientos: buscar «nandu»');
    const cats = new Map(S.categories.map((c) => [c.id, c.name]));
    const want = S.tx.filter((t) => [t.description, t.merchant, t.notes, cats.get(t.category_id)].some((f) => norm(f).includes('nandu'))).length;
    const found = await p.$$eval('.stat', (els) => els.find((e) => e.querySelector('.label')?.textContent.trim() === 'Movimientos')?.querySelector('.value')?.textContent);
    assert.equal(found.replace(/\D/g, ''), String(want));
  });

  test('Análisis del año pasado (con el ingreso de 250.000 €) y de los últimos 12 meses', async () => {
    const y = Number(big.today.slice(0, 4)) - 1;
    for (const [page, label] of [[m.page, 'móvil'], [d.page, 'escritorio']]) {
      await timedShow(page, 'analisis?p=lastyear', `Análisis año pasado (${label})`);
      await page.waitForSelector('.stat .value');
      const st = await page.$$eval('.stat', (els) => Object.fromEntries(els.map((e) => [e.querySelector('.label')?.textContent.trim(), e.querySelector('.value')?.textContent.trim()])));
      const round = (c) => Math.round(c / 100);
      assert.equal(cents(st.Gastos), round(sumOf((t) => t.kind === 'expense' && t.date.startsWith(`${y}-`))), `${label}: gastos`);
      assert.equal(cents(st.Ingresos), round(sumOf((t) => t.kind === 'income' && t.date.startsWith(`${y}-`))), `${label}: ingresos`);
      assert.deepEqual(await overflowing(page), [], `${label}: nada se sale`);
      await timedShow(page, 'analisis?p=12m', `Análisis 12 meses (${label})`);
      await page.waitForSelector('.chart canvas, .chart svg');
    }
  });

  test('Resumen del mes pasado', async () => {
    const [y, mo] = big.today.split('-').map(Number);
    const prev = mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`;
    await timedShow(m.page, `resumen?m=${prev}`, 'Resumen (móvil)');
    assert.equal(cents(await text(m.page, '.rh-amount')), monthExpense(prev));
    assert.deepEqual(await overflowing(m.page), []);
  });

  test('El resto de pantallas cargan con todo esto, rápido y sin salirse', async () => {
    for (const [route, label] of [['notas', 'Notas (400)'], ['productos', 'Productos (300)'], ['precios', 'Precios'], ['precios?tab=historico', 'Histórico de precios'],
      ['compra', 'Lista de la compra (120)'], ['fijos', 'Pagos fijos'], ['fijos?tab=calendario', 'Calendario'], ['facturas', 'Facturas'], ['ahorro', 'Metas'],
      ['presupuestos', 'Presupuestos'], ['mascotas', 'Mascotas']]) {
      for (const [page, dev] of [[m.page, 'móvil'], [d.page, 'escritorio']]) {
        await timedShow(page, route, `${label} (${dev})`);
        assert.deepEqual(await overflowing(page), [], `${label} (${dev}): nada se sale`);
      }
    }
    const slow = timings.filter(([, ms]) => ms > 4000);
    assert.deepEqual(slow, [], 'ninguna pantalla tarda más de 4 s (en este equipo, con 10 veces los datos de una casa normal)');
  });

  test('sin errores en las páginas ni en el servidor', () => {
    assert.deepEqual([...m.errors, ...d.errors], []);
    assert.deepEqual(srv.errors(), []);
  });
});
