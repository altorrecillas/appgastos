// El inicio a gusto de cada persona: se ordenan los bloques (con las flechas o arrastrando por el asa) y se ocultan
// los que no se quieren ver; queda guardado para esa persona (en todos sus dispositivos) y el de los demás no cambia.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { join, newUser } from '../lib/client.js';
import { DESKTOP, SKIP, launch, openApp, show } from '../lib/browser.js';

const H = '/api/h/1';
const DEFAULT = ['hero', 'quick', 'insights', 'stats', 'categories', 'trend', 'recent', 'power', 'upcoming', 'installments', 'lists', 'goals', 'activity'];

describe('personalizar el inicio', { skip: SKIP }, () => {
  let srv;
  let browser;
  let a;
  let p;
  let ana;
  let luis;
  // Los bloques del inicio, en el orden en que se ven.
  const shown = (page = p) => page.$$eval('.dash [data-home]', (els) => els.map((e) => e.dataset.home));
  const rows = () => p.$$eval('.he-row', (els) => els.map((e) => e.dataset.block));
  const openEditor = async () => {
    await p.click('[data-act=customize]');
    await p.waitForSelector('.he-row');
  };
  const save = async () => {
    await p.click('#page-actions [data-he=save]');
    await p.waitForSelector('.dash [data-home]');
  };

  before(async () => {
    srv = await startServer();
    ana = await newUser(srv.base, 'ana', 'Ana');
    await ana.ok('POST', `${H}/demo`);
    luis = await newUser(srv.base, 'luis', 'Luis');
    await join(ana, luis, 'editor');
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana');
    p = a.page;
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  test('sin tocar nada, el inicio de siempre', async () => {
    await show(p, srv.base, 'inicio');
    assert.deepEqual(await shown(), DEFAULT);
  });

  test('con las flechas: «Lista de la compra» arriba del todo; «Cifras del mes» oculto', async () => {
    await openEditor();
    assert.deepEqual(await rows(), DEFAULT);
    for (let i = 0; i < 10; i++) await p.click('[data-block=lists] [data-move="-1"]');
    assert.equal((await rows())[0], 'lists');
    assert.equal(await p.getAttribute('[data-block=lists] [data-move="-1"]', 'disabled'), '', 'arriba del todo ya no sube');
    await p.click('[data-block=stats] .switch');
    assert.match(await p.textContent('[data-block=stats] small'), /Oculto en tu inicio/);
    await save();
    await p.locator('.toast', { hasText: 'Tu inicio queda a tu gusto' }).waitFor();
    const order = await shown();
    assert.equal(order[0], 'lists');
    assert.ok(!order.includes('stats') && !(await p.$('.stat-strip')), 'sin las cifras del mes');
  });

  test('arrastrando por el asa: «Últimos 12 meses» encima del resumen', async () => {
    await openEditor();
    const grip = await p.locator('[data-block=trend] [data-grip]').boundingBox();
    const target = await p.locator('[data-block=hero]').boundingBox();
    await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await p.mouse.down();
    for (let k = 1; k <= 12; k++) await p.mouse.move(grip.x + grip.width / 2, grip.y + (target.y + 5 - grip.y) * (k / 12));
    await p.mouse.up();
    const r = await rows();
    assert.ok(r.indexOf('trend') < r.indexOf('hero'), r.join());
    await save();
    const order = await shown();
    assert.ok(order.indexOf('trend') < order.indexOf('hero'), order.join());
  });

  test('queda guardado para Ana (también al volver a entrar) y Luis sigue con el de siempre', async () => {
    const { home } = (await ana.ok('GET', '/api/auth/me')).user.settings;
    assert.equal(home.order[0], 'lists');
    assert.deepEqual(home.hidden, ['stats']);
    await p.reload();
    await p.waitForSelector('.dash [data-home]');
    assert.equal((await shown())[0], 'lists');
    const l = await openApp(browser, srv.base, 'luis');
    await show(l.page, srv.base, 'inicio');
    assert.deepEqual(await shown(l.page), DEFAULT);
    assert.deepEqual(l.errors, []);
    await l.ctx.close();
  });

  test('«Cancelar» no cambia nada', async () => {
    const before = await shown();
    await openEditor();
    await p.click('[data-block=hero] .switch');
    await p.click('#page-actions [data-he=cancel]');
    await p.waitForSelector('.dash [data-home]');
    assert.deepEqual(await shown(), before);
  });

  test('en el ordenador, cada panel en su columna y en el orden elegido dentro de ella', async () => {
    await ana.ok('PATCH', '/api/auth/me', { settings: { home: { order: ['hero', 'upcoming', 'recent', 'categories', 'activity'], hidden: [] } } });
    const d = await openApp(browser, srv.base, 'ana', { ...DESKTOP });
    await show(d.page, srv.base, 'inicio');
    const cols = await d.page.$$eval('.dash .cols-main > .stack', (els) => els.map((c) => [...c.querySelectorAll('[data-home]')].map((x) => x.dataset.home)));
    // «upcoming» va antes, pero es de la columna estrecha; los nuevos bloques que no estaban guardados entran en su sitio.
    assert.deepEqual(cols[0].slice(0, 3), ['recent', 'categories', 'trend']);
    assert.deepEqual(cols[1].slice(0, 1), ['upcoming']);
    assert.ok(cols[1].includes('activity'));
    assert.deepEqual(d.errors, []);
    await d.ctx.close();
  });

  test('«Volver al orden de siempre» y guardar deja el inicio como siempre', async () => {
    await show(p, srv.base, 'inicio');
    await p.reload();
    await p.waitForSelector('.dash [data-home]');
    await openEditor();
    await p.click('[data-he=reset]');
    assert.deepEqual(await rows(), DEFAULT);
    await save();
    await p.locator('.toast', { hasText: 'Tu inicio vuelve a estar como siempre' }).waitFor();
    assert.deepEqual(await shown(), DEFAULT);
    assert.equal((await ana.ok('GET', '/api/auth/me')).user.settings.home, null);
  });

  test('desde el menú «Más» → «Personalizar el inicio»', async () => {
    await show(p, srv.base, 'movimientos');
    await p.click('.tabbar [data-act=more]');
    await p.click('dialog[open] a:has-text("Personalizar el inicio")');
    await p.waitForSelector('.he-row');
    assert.equal(await p.evaluate(() => location.hash), '#/inicio');
    await p.click('#page-actions [data-he=cancel]');
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors(), []);
  });
});
