// Productos y precios en el navegador: un producto «al peso», sus precios por kilo, una bandeja de 500 g
// que se compara por kilo con los demás, la ficha que marca el más barato y el histórico de precios.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { SKIP, api, launch, openApp, show } from '../lib/browser.js';

const NAME = 'Lomo de cerdo';

describe('productos y precios en el navegador', { skip: SKIP }, () => {
  let srv;
  let browser;
  let a;
  before(async () => {
    srv = await startServer();
    await newUser(srv.base, 'ana', 'Ana');
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana');
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  const product = async () => (await api(a.page, '/api/h/1/prices')).products.find((p) => p.name === NAME);
  const closed = () => a.page.waitForSelector('dialog[open]', { state: 'detached' });

  test('un producto nuevo «al peso» desde Productos', async () => {
    const p = a.page;
    await show(p, srv.base, 'productos');
    await p.click('#page-actions [data-act=new-product]');
    await p.fill('#pf-n', NAME);
    await p.click('dialog[open] [data-sold] [data-v=kg]');
    assert.equal(await p.isVisible('dialog[open] [data-pack]'), false, 'al peso no pide cantidad ni formato');
    await p.click('dialog[open] [data-act=save]');
    await p.locator('dialog[open] .prod-detail').waitFor();
    await p.keyboard.press('Escape');
    await closed();
    const { products } = await api(p, '/api/h/1/products');
    const lomo = products.find((x) => x.name === NAME);
    assert.deepEqual([lomo.unit, lomo.unit_qty], ['kg', 1]);
  });

  test('al anotar su precio, el formulario se pone solo «al peso» y guarda €/kg', async () => {
    const p = a.page;
    await show(p, srv.base, 'precios?new=1');
    await p.fill('#pr-p', NAME);
    await p.press('#pr-p', 'Enter');
    assert.equal(await p.getAttribute('[data-sold] [data-v=kg]', 'aria-pressed'), 'true');
    for (const st of ['Mercadona', 'Lidl']) await p.click(`[data-addstore="${st}"]`);
    assert.match(await p.getAttribute('[data-row=Mercadona] [data-price]', 'aria-label'), /kilo/);
    await p.fill('[data-row=Mercadona] [data-price]', '7,49');
    await p.fill('[data-row=Lidl] [data-price]', '6,99');
    await p.click('dialog[open] [data-act=save]');
    await closed();
    const lomo = await product();
    assert.deepEqual([lomo.base_unit, lomo.stores.Mercadona.price, lomo.stores.Mercadona.unit, lomo.best.store], ['kg', 749, 'kg', 'Lidl']);
  });

  test('una bandeja de 500 g se compara por kilo con los demás', async () => {
    const p = a.page;
    await show(p, srv.base, 'inicio');
    await show(p, srv.base, 'precios?new=1');
    await p.fill('#pr-p', NAME);
    await p.press('#pr-p', 'Enter');
    await p.click('[data-sold] [data-v=pack]');
    await p.fill('#pr-q', '500');
    await p.selectOption('#pr-u', 'g');
    await p.click('[data-addstore="Carrefour"]');
    await p.fill('[data-row=Carrefour] [data-price]', '3,25');
    assert.equal((await p.textContent('[data-row=Carrefour] [data-up]')).replace(/\s/g, ' '), 'Sale a 6,50 € por kg');
    await p.click('dialog[open] [data-act=save]');
    await closed();
    const lomo = await product();
    assert.deepEqual([lomo.best.store, Math.round(lomo.stores.Carrefour.unit_price)], ['Carrefour', 650]);
  });

  test('la ficha del producto marca el más barato por kilo', async () => {
    const p = a.page;
    await show(p, srv.base, 'productos');
    await p.click(`.prod-row:has-text("${NAME}")`);
    const best = p.locator('dialog[open] .pp-row.best');
    await best.waitFor();
    const t = (await best.textContent()).replace(/\s+/g, ' ');
    assert.match(t, /Carrefour/);
    assert.match(t, /6,50 €\/kg/);
    await p.keyboard.press('Escape');
    await closed();
  });

  test('el histórico de precios carga (también sin conexión con el INE)', async () => {
    await show(a.page, srv.base, 'precios?tab=historico');
    assert.equal(await a.page.getAttribute('[data-tab=historico]', 'aria-selected'), 'true');
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors().filter((l) => !/INE|IPC/i.test(l)), []);
  });
});
