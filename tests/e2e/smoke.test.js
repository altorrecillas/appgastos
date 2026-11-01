// Prueba de humo en el navegador: con datos de ejemplo, todas las secciones cargan sin errores en móvil y en escritorio,
// y los flujos del día a día funcionan (anotar un gasto, atajos del inicio, menú «Más», notas en escritorio).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { DESKTOP, SKIP, api, launch, openApp, show } from '../lib/browser.js';

const ROUTES = ['inicio', 'movimientos', 'compra', 'productos', 'precios', 'precios?tab=historico', 'fijos', 'fijos?tab=plazos', 'fijos?tab=calendario',
  'facturas', 'luz', 'enchufes', 'recordatorios', 'notas', 'presupuestos', 'mascotas', 'ahorro', 'analisis', 'resumen', 'ajustes', 'ajustes/datos'];

describe('humo', { skip: SKIP }, () => {
  let srv;
  let browser;
  let m;
  let d;
  before(async () => {
    srv = await startServer();
    const ana = await newUser(srv.base, 'ana', 'Ana');
    await ana.ok('POST', '/api/h/1/demo');
    browser = await launch();
    m = await openApp(browser, srv.base, 'ana');
    d = await openApp(browser, srv.base, 'ana', DESKTOP);
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  for (const [label, get] of [['móvil', () => m], ['escritorio', () => d]]) {
    test(`${label}: todas las secciones cargan`, async (t) => {
      for (const r of ROUTES) await t.test(r, () => show(get().page, srv.base, r));
    });
  }

  test('anotar un gasto: el importe va arriba, con los botones del ticket, y se guarda', async () => {
    const p = m.page;
    await show(p, srv.base, 'inicio');
    await p.tap('.fab-wrap');
    await p.waitForSelector('#txf .amount-stage input');
    const order = await p.$$eval('#txf > *', (els) => els.slice(0, 4).map((e) => e.className || e.tagName).join(' | '));
    assert.match(order, /segmented.*\|.*amount-stage/, `el importe no va arriba: ${order}`);
    assert.ok(await p.$('#txf .ticket-btn[data-camera]'), 'botón de la cámara');
    assert.ok(await p.$('#txf .ticket-pick[data-act=scan]'), 'botón de elegir el ticket');
    await p.fill('#f-amount', '12,34');
    await p.fill('#f-desc', 'Prueba de humo');
    await p.tap('[data-pick=category_id] .cat-opt >> nth=1');
    await p.tap('dialog[open] [data-act=save]');
    await p.waitForSelector('dialog[open]', { state: 'detached' });
    const tx = await api(p, '/api/h/1/transactions?q=Prueba%20de%20humo');
    assert.ok(tx.items.some((x) => x.amount === 1234 && x.kind === 'expense'), JSON.stringify(tx.items).slice(0, 200));
  });

  test('el importe del inicio cuenta hasta su valor exacto', async () => {
    const p = m.page;
    await show(p, srv.base, 'movimientos');
    await show(p, srv.base, 'inicio');
    await p.waitForTimeout(1300);
    const shown = (await p.textContent('.hero-amount')).replace(/\D/g, '');
    const label = (await p.getAttribute('.hero-amount', 'aria-label')).replace(/\D/g, '');
    assert.equal(shown, label);
  });

  test('atajos del inicio: cuatro y abren lo suyo', async () => {
    const p = m.page;
    assert.equal(await p.$$eval('.quick-tiles .qa-tile', (x) => x.length), 4);
    await p.tap('.quick-tiles [data-qa=income]');
    await p.waitForSelector('#txf .amount-stage.income');
    await p.keyboard.press('Escape');
    await p.waitForSelector('dialog[open]', { state: 'detached' });
    await p.tap('.quick-tiles [data-act=quick]');
    await p.waitForSelector('dialog[open]');
    await p.keyboard.press('Escape');
    await p.waitForSelector('dialog[open]', { state: 'detached' });
  });

  test('«Más»: secciones agrupadas, sin repetir la barra, y marca la sección abierta', async () => {
    const p = m.page;
    await show(p, srv.base, 'facturas');
    assert.equal(await p.getAttribute('.tabbar [data-act=more]', 'aria-current'), 'page');
    await p.tap('.tabbar [data-act=more]');
    await p.waitForSelector('.more-group');
    const links = await p.$$eval('dialog[open] a.more-tile', (a) => a.map((x) => x.getAttribute('href')));
    assert.ok(!links.includes('#/inicio') && !links.includes('#/compra'), 'no repite lo que ya está en la barra');
    assert.ok(links.includes('#/notas') && links.includes('#/resumen') && links.includes('#/productos'), links.join());
    assert.equal(await p.getAttribute('dialog[open] a.more-tile[href="#/facturas"]', 'aria-current'), 'page');
    await p.tap('dialog[open] a.more-tile[href="#/notas"]');
    await p.waitForFunction(() => document.querySelector('#page-title')?.textContent.trim() === 'Notas');
    await p.waitForSelector('dialog[open]', { state: 'detached' });
  });

  test('«Cargar más» en Movimientos carga más filas y no abre el menú «Más»', async () => {
    const p = m.page;
    await show(p, srv.base, 'movimientos?period=all');
    const before = await p.$$eval('[data-tx]', (x) => x.length);
    await p.click('[data-act=load-more]');
    await p.waitForFunction((n) => document.querySelectorAll('[data-tx]').length > n, before);
    await p.waitForTimeout(300);
    assert.equal(await p.$('dialog[open]'), null);
  });

  test('escritorio: Notas abre la primera nota y no salen los atajos del móvil', async () => {
    const p = d.page;
    await p.goto(`${srv.base}/#/notas`);
    await p.waitForSelector('.notes.wide .ne [data-title]');
    await p.waitForFunction(() => /#\/notas\/\d+/.test(location.hash));
    await show(p, srv.base, 'inicio');
    assert.equal(await p.isVisible('.quick-tiles'), false);
  });

  test('sin errores en las páginas ni en el servidor', () => {
    assert.deepEqual([...m.errors, ...d.errors], []);
    assert.deepEqual(srv.errors(), []);
  });
});
