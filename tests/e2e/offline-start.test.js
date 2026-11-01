// La app se abre aunque el servidor no conteste: si tarda (la conexión se queda colgada, como con Tailscale sin ruta)
// o no está (conexión cortada), enseña lo último que se vio en el dispositivo y, en cuanto vuelve, se pone al día sola.
// Entre el navegador y el servidor hay un «cable» que se corta a voluntad (tests/lib/proxy.js).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { startProxy } from '../lib/proxy.js';
import { SKIP, launch, openApp, show } from '../lib/browser.js';

const H = '/api/h/1';
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

describe('arrancar sin conexión', { skip: SKIP }, () => {
  let srv;
  let proxy;
  let browser;
  let a;
  let ana;
  let p;
  const spent = async (description, amount) => {
    const { categories } = await ana.ok('GET', H);
    const category_id = categories.find((c) => c.kind === 'expense').id;
    await ana.ok('POST', `${H}/transactions`, { kind: 'expense', amount, date: today, description, category_id });
  };
  // La app está abierta y con datos (no el esqueleto de carga).
  const ready = () => p.waitForFunction(() => {
    const v = document.querySelector('#view');
    return document.querySelector('#page-title') && v && !v.querySelector('.sk-page') && v.textContent.trim().length > 20;
  }, null, { timeout: 15000 });
  const pill = () => p.locator('[data-act=netinfo]');

  before(async () => {
    srv = await startServer();
    ana = await newUser(srv.base, 'ana', 'Ana');
    await spent('Churros del domingo', 650);
    proxy = await startProxy(srv.base);
    browser = await launch();
    a = await openApp(browser, proxy.base, 'ana');
    p = a.page;
    // El service worker se instala y, desde entonces, guarda lo que se ve.
    await p.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20000 });
    await show(p, proxy.base, 'movimientos');
    await show(p, proxy.base, 'inicio');
    await p.waitForTimeout(800);
  });
  after(async () => {
    await browser?.close();
    await proxy?.close();
    await srv?.stop();
  });

  test('el servidor no contesta: se abre en segundos con lo guardado', async () => {
    proxy.set('hang');
    const t0 = Date.now();
    await p.reload();
    await ready();
    const ms = Date.now() - t0;
    assert.ok(ms < 7000, `ha tardado ${ms} ms`);
    await pill().filter({ hasText: 'Conexión lenta' }).waitFor();
  });

  test('sin conexión, lo ya visto se abre al momento', async () => {
    const t0 = Date.now();
    await p.goto(`${proxy.base}/#/movimientos`);
    await p.locator('#view', { hasText: 'Churros del domingo' }).waitFor({ timeout: 5000 });
    assert.ok(Date.now() - t0 < 2500, `ha tardado ${Date.now() - t0} ms`);
  });

  test('al volver la conexión se pone al día sola, sin recargar', async () => {
    await spent('Bizcocho de la abuela', 1290); // lo apunta otra persona mientras tanto
    proxy.set('up');
    await p.locator('#view', { hasText: 'Bizcocho de la abuela' }).waitFor({ timeout: 25000 });
    await pill().waitFor({ state: 'hidden' });
  });

  test('servidor apagado (la conexión se corta): se abre al momento', async () => {
    proxy.set('down');
    const t0 = Date.now();
    await p.reload();
    await ready();
    assert.ok(Date.now() - t0 < 4000, `ha tardado ${Date.now() - t0} ms`);
    await p.locator('#view', { hasText: 'Bizcocho de la abuela' }).waitFor();
    await pill().filter({ hasText: 'Sin conexión' }).waitFor();
  });

  test('una sección que nunca se abrió lo explica y se carga sola al volver la conexión', async () => {
    await p.goto(`${proxy.base}/#/mascotas`);
    await p.locator('#view .empty h3', { hasText: 'Sin conexión con el servidor' }).waitFor();
    proxy.set('up');
    await p.locator('#view .empty h3', { hasText: 'Añade a los animales de la casa' }).waitFor({ timeout: 20000 });
    await pill().waitFor({ state: 'hidden' });
  });

  test('sin nada guardado en el dispositivo, espera y se abre sola al volver', async () => {
    await show(p, proxy.base, 'movimientos');
    await p.evaluate(() => caches.delete('gastosbyath-api'));
    proxy.set('down');
    await p.reload();
    await p.locator('.boot h3', { hasText: 'Esperando a la conexión' }).waitFor({ timeout: 10000 });
    proxy.set('up');
    await ready();
    await p.locator('#view', { hasText: 'Bizcocho de la abuela' }).waitFor();
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors(), []);
  });
});
