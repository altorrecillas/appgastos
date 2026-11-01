// Productos dentro de la Compra: el botón está al lado de las listas (a la vista en el móvil), se va y se vuelve sin
// salir de la sección, y el inventario se filtra, se busca sin acentos, se ve en cuadrícula y añade a la lista con «+».
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { SKIP, api, launch, openApp, show } from '../lib/browser.js';

const H = '/api/h/1';

describe('productos en la compra', { skip: SKIP }, () => {
  let srv;
  let browser;
  let a;
  let ana;
  before(async () => {
    srv = await startServer();
    ana = await newUser(srv.base, 'ana', 'Ana');
    await ana.ok('POST', `${H}/demo`);
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana');
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  test('en la Compra, «Productos» está al lado de las listas y se ve sin desplazar', async () => {
    const p = a.page;
    await show(p, srv.base, 'compra');
    const box = await p.locator('.ln-products').boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `dentro de la pantalla: ${JSON.stringify(box)}`);
    assert.match(await p.textContent('.ln-products'), /Productos\s*\d+ productos/);
    await p.click('.ln-products');
    await p.waitForSelector('.prod-pane');
    assert.match(await p.evaluate(() => location.hash), /^#\/productos/);
    assert.equal(await p.getAttribute('.tabbar [data-nav=compra]', 'aria-current'), 'page', 'la pestaña Compra sigue marcada');
    assert.equal(await p.getAttribute('.ln-products', 'aria-current'), 'true');
    // Y se vuelve a una lista desde la misma barra.
    const first = await p.getAttribute('.list-nav [data-list] >> nth=0', 'data-list');
    await p.click('.list-nav [data-list] >> nth=0');
    await p.waitForSelector('.list-head');
    assert.equal(await p.evaluate(() => location.hash), `#/compra/${first}`);
  });

  test('filtros rápidos: los que están en la lista y los que no tienen precio', async () => {
    const p = a.page;
    await show(p, srv.base, 'productos');
    const { products } = await api(p, `${H}/products`);
    const inList = products.filter((x) => x.in_list).length;
    const noPrice = products.filter((x) => !x.best).length;
    await p.click('[data-quick=inlist]');
    assert.equal(await p.$$eval('.prod-row', (x) => x.length), inList);
    assert.equal(await p.$$eval('.prod-act.in', (x) => x.length), inList, 'todos con su marca de «en la lista»');
    await p.click('[data-quick=noprice]');
    assert.equal(await p.$$eval('.prod-row', (x) => x.length), noPrice);
    assert.ok((await p.$$eval('.prod-row', (x) => x.map((r) => r.textContent))).every((t) => t.includes('Sin precios')));
    await p.click('[data-quick=""]');
    assert.equal(await p.$$eval('.prod-row', (x) => x.length), products.length);
  });

  test('«+» añade el producto a la lista que se elija y queda marcado', async () => {
    const p = a.page;
    const { products } = await api(p, `${H}/products`);
    const target = products.find((x) => !x.in_list);
    await p.click(`[data-tolist="${target.id}"]`);
    // Con varias listas activas, se elige a cuál.
    const menu = await p.waitForSelector('.menu[role=menu] button', { timeout: 2000 }).catch(() => null);
    if (menu) await menu.click();
    await p.waitForSelector(`.prod-row[data-prod="${target.id}"] .prod-act.in`);
    const lists = await api(p, `${H}/shopping/lists`);
    const names = (await Promise.all(lists.filter((l) => l.status === 'active').map((l) => api(p, `${H}/shopping/lists/${l.id}`))))
      .flatMap((l) => l.items.filter((i) => !i.checked).map((i) => i.name));
    assert.ok(names.includes(target.name), `${target.name} está en una lista`);
  });

  test('buscar no distingue acentos, y la cuadrícula se recuerda', async () => {
    const p = a.page;
    await p.fill('[data-q]', 'platano');
    assert.deepEqual(await p.$$eval('.prod-row .prod-l1 b', (x) => x.map((e) => e.textContent)), ['Plátanos']);
    await p.fill('[data-q]', '');
    await p.click('[data-view=grid]');
    const total = (await api(p, `${H}/products`)).products.length;
    assert.equal(await p.$$eval('.prod-card', (x) => x.length), total);
    await show(p, srv.base, 'compra');
    await show(p, srv.base, 'productos');
    assert.equal(await p.$$eval('.prod-card', (x) => x.length), total, 'sigue en cuadrícula al volver');
    await p.click('[data-view=list]');
    await p.waitForSelector('.prod-row');
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors(), []);
  });
});
