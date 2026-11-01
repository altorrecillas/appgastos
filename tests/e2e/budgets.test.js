// En el inicio, un límite de Restaurantes no se convierte en el presupuesto de todo el mes: la cabecera enseña ese
// límite con lo gastado en restaurantes (150 € de 200 €) y no «superado» por la compra o el alquiler. Con presupuesto
// total del hogar, la cabecera compara con todo, como siempre.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { SKIP, launch, openApp, show, text } from '../lib/browser.js';

const H = '/api/h/1';
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

describe('presupuestos en el inicio', { skip: SKIP }, () => {
  let srv;
  let browser;
  let a;
  let ana;
  before(async () => {
    srv = await startServer();
    ana = await newUser(srv.base, 'ana', 'Ana');
    const { categories } = await ana.ok('GET', H);
    const cat = (n) => categories.find((c) => c.name === n).id;
    await ana.ok('PATCH', `${H}/categories/${cat('Restaurantes')}`, { budget: 20000 });
    for (const [name, amount] of [['Restaurantes', 15000], ['Supermercado', 50000], ['Vivienda', 59000]]) {
      await ana.ok('POST', `${H}/transactions`, { kind: 'expense', amount, date: today, description: name, category_id: cat(name) });
    }
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana');
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  test('la cabecera enseña el límite de Restaurantes con lo suyo, sin dar el mes por superado', async () => {
    const p = a.page;
    await show(p, srv.base, 'inicio');
    const hero = await text(p, '.hero');
    assert.match(hero, /Límite por categoría/);
    assert.match(hero, /Restaurantes 150 € de 200 €/);
    assert.match(hero, /Quedan 50 €/);
    assert.doesNotMatch(hero, /Superado|por encima del presupuesto|Presupuesto 200/);
    assert.equal(await p.$('.hero-legend :text("Presupuesto")'), null, 'el gráfico no pinta un presupuesto de 200 € para todo');
    assert.equal(await p.getAttribute('.hl-row', 'href'), `#/movimientos?cat=${(await ana.ok('GET', H)).categories.find((c) => c.name === 'Restaurantes').id}&month=${today.slice(0, 7)}`);
  });

  test('Presupuestos lo explica: lo de Restaurantes, y que el resto no cuenta para ningún límite', async () => {
    const p = a.page;
    await show(p, srv.base, 'presupuestos');
    const head = await text(p, '.panel');
    assert.match(head, /Sin límite total/);
    assert.match(head, /En Restaurantes lleváis 150 € de 200 €\./);
    assert.match(head, /Los otros 1\.090 € no cuentan para ningún límite/);
    assert.doesNotMatch(head, /Os habéis pasado/);
    // Una categoría sin límite no sale en rojo como si se hubiera pasado.
    assert.equal(await p.$$eval('.budget-row .edit.neg', (els) => els.length), 0);
  });

  test('con presupuesto total del hogar, la cabecera compara con todo el gasto', async () => {
    const p = a.page;
    await ana.ok('PATCH', H, { monthly_budget: 250000 });
    await show(p, srv.base, 'inicio');
    await p.reload();
    await p.locator('.hero-budget', { hasText: 'Presupuesto 2.500 €' }).waitFor();
    assert.match(await text(p, '.hero-budget'), /Quedan 1\.260 €/);
    assert.equal(await p.$('.hero-limits'), null);
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors(), []);
  });
});
