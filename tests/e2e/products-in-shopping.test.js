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

  // Nada de la barra se sale de la pantalla ni corta el nombre de la lista.
  const switcherOk = (p) => p.evaluate(() => [...document.querySelectorAll('.shop-switch .ss-half')].every((e) => {
    const r = e.getBoundingClientRect();
    const n = e.querySelector('.ss-name');
    return r.left >= 0 && r.right <= innerWidth && n.scrollHeight <= n.clientHeight + 1;
  }));

  test('en el móvil, la lista abierta y «Productos» van juntos en una barra que no se corta', async () => {
    const p = a.page;
    await show(p, srv.base, 'compra');
    assert.ok(await p.isVisible('.shop-switch'));
    assert.ok(await switcherOk(p));
    const listId = await p.evaluate(() => location.hash.match(/compra\/(\d+)/)?.[1] || null);
    await p.click('.ss-prod');
    await p.waitForSelector('.prod-pane');
    assert.match(await p.evaluate(() => location.hash), /^#\/productos/);
    assert.equal(await p.getAttribute('.tabbar [data-nav=compra]', 'aria-current'), 'page', 'la pestaña Compra sigue marcada');
    assert.equal(await p.getAttribute('.ss-prod', 'aria-current'), 'true');
    // Y se vuelve a la misma lista desde la barra.
    await p.click('.ss-list');
    await p.waitForSelector('.list-head');
    if (listId) assert.equal(await p.evaluate(() => location.hash), `#/compra/${listId}`);
  });

  test('con muchas listas de nombres largos nada se corta, y se cambia de lista desde la hoja', async () => {
    const p = a.page;
    for (const name of ['Barbacoa del sábado en casa de los abuelos', 'Farmacia', 'Material escolar de septiembre', 'Ferretería']) {
      await ana.ok('POST', `${H}/shopping/lists`, { name });
    }
    const lists = (await api(p, `${H}/shopping/lists`)).filter((l) => l.status === 'active');
    for (const w of [360, 390, 430]) {
      await p.setViewportSize({ width: w, height: 800 });
      for (const l of lists) {
        await show(p, srv.base, `compra/${l.id}`);
        assert.ok(await switcherOk(p), `${w} px, «${l.name}»`);
      }
    }
    await p.setViewportSize({ width: 390, height: 844 });
    await show(p, srv.base, 'compra');
    assert.equal((await p.textContent('.ss-chev')).trim(), String(lists.length), 'cuántas listas hay');
    await p.click('[data-act=pick-list]');
    await p.waitForSelector('dialog[open] .lpk-row');
    assert.equal(await p.$$eval('dialog[open] .lpk-row', (x) => x.length), lists.length);
    const farmacia = lists.find((l) => l.name === 'Farmacia');
    await p.click(`dialog[open] [data-pick-list="${farmacia.id}"]`);
    await p.waitForFunction((id) => location.hash === `#/compra/${id}`, farmacia.id);
    await p.waitForFunction(() => document.querySelector('.ss-name')?.textContent.trim() === 'Farmacia');
    // Desde la hoja también se crea una lista nueva.
    await p.click('[data-act=pick-list]');
    await p.click('dialog[open] [data-act=lp-new]');
    await p.waitForSelector('dialog[open] #lf-n');
    await p.keyboard.press('Escape');
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
