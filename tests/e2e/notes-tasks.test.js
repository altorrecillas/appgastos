// Notas y tareas en el móvil: el interruptor Notas | Tareas marca en azul lo elegido y cambia la lista; las tareas
// salen por cuándo tocan, se apuntan sin abrir el editor y las hechas quedan plegadas al final. El «+» de abajo
// crea una nota o una tarea (no un gasto) mientras se está en Notas.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { DESKTOP, SKIP, api, launch, openApp, show } from '../lib/browser.js';

const H = '/api/h/1/notes';
const madrid = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const inDays = (n) => madrid(new Date(Date.now() + n * 864e5));

describe('notas y tareas', { skip: SKIP }, () => {
  let srv;
  let browser;
  let a;
  let p;
  let shared;
  const pressed = () => p.$$eval('.nl-kind [data-kind]', (bs) => bs.map((b) => [b.dataset.kind, b.getAttribute('aria-pressed')]));
  const items = () => p.$$eval('.nl-list .nl-item .nl-title', (els) => els.map((e) => e.textContent.trim()));

  before(async () => {
    srv = await startServer();
    const ana = await newUser(srv.base, 'ana', 'Ana');
    const meta = await ana.ok('GET', `${H}/meta`);
    shared = meta.books.find((b) => !b.private);
    const mine = meta.books.find((b) => b.private);
    await ana.ok('POST', H, { book_id: shared.id, title: 'Wifi de casa', body: 'CasaATH-5G' });
    await ana.ok('POST', H, { book_id: shared.id, title: 'Cambiar el filtro', is_todo: true, due_at: inDays(-2) });
    await ana.ok('POST', H, { book_id: mine.id, title: 'Tender la ropa', is_todo: true, due_at: inDays(0) });
    await ana.ok('POST', H, { book_id: shared.id, title: 'Pedir cita ITV', is_todo: true, due_at: inDays(3) });
    await ana.ok('POST', H, { book_id: mine.id, title: 'Renovar el DNI', is_todo: true, due_at: inDays(40) });
    await ana.ok('POST', H, { book_id: shared.id, title: 'Llamar al banco', is_todo: true });
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana');
    p = a.page;
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  test('en Notas: «Notas» en azul, solo notas, y el «+» de abajo es «Nueva nota»', async () => {
    await show(p, srv.base, 'notas');
    assert.deepEqual(await pressed(), [['notes', 'true'], ['todo', 'false']]);
    assert.deepEqual(await items(), ['Wifi de casa']);
    const [on, off] = await p.$$eval('.nl-kind [data-kind]', (bs) => bs.map((b) => getComputedStyle(b).backgroundColor));
    assert.notEqual(on, off, 'lo elegido se distingue (azul)');
    assert.equal(await p.getAttribute('.tabbar [data-act=add]', 'aria-label'), 'Nueva nota');
    assert.equal(await p.isVisible('#page-actions [data-act=new-note]'), false, 'arriba ya no hay botones que parezcan pestañas');
    await p.click('.tabbar [data-act=add]');
    await p.waitForSelector('[data-title]');
    assert.equal(await p.getAttribute('[data-title]', 'placeholder'), 'Título');
    assert.equal(await p.$('.ne-todo'), null, 'es una nota, no una tarea');
    await p.click('[data-act=back]');
    await p.waitForSelector('.nl-kind');
  });

  test('en Tareas: «Tareas» en azul y por cuándo tocan', async () => {
    await p.click('[data-kind=todo]');
    await p.waitForFunction(() => document.querySelector('[data-kind=todo]')?.getAttribute('aria-pressed') === 'true');
    assert.deepEqual(await pressed(), [['notes', 'false'], ['todo', 'true']]);
    const groups = await p.$$eval('.nl-group', (gs) => gs.map((g) => [g.querySelector('.nl-gh')?.firstChild.textContent.trim(),
      ...[...g.querySelectorAll('.nl-title')].map((t) => t.textContent.trim())]));
    assert.deepEqual(groups, [
      ['Vencidas', 'Cambiar el filtro'], ['Hoy', 'Tender la ropa'], ['Próximos 7 días', 'Pedir cita ITV'],
      ['Más adelante', 'Renovar el DNI'], ['Sin fecha', 'Llamar al banco'],
    ]);
    assert.equal(await p.getAttribute('.tabbar [data-act=add]', 'aria-label'), 'Nueva tarea');
  });

  test('se apunta una tarea sin abrir el editor y la casilla queda lista para otra', async () => {
    await p.fill('[data-quick] input', 'Comprar bombillas');
    await p.press('[data-quick] input', 'Enter');
    await p.locator('.nl-group', { hasText: 'Comprar bombillas' }).waitFor();
    assert.equal(await p.evaluate(() => !!document.activeElement?.closest('[data-quick]')), true);
    assert.equal(await p.inputValue('[data-quick] input'), '');
    const t = (await api(p, `${H}?view=todo`)).find((n) => n.title === 'Comprar bombillas');
    assert.ok(t && t.is_todo && !t.done_at);
  });

  test('marcada como hecha, baja a «Hechas» (plegadas) y se puede desmarcar', async () => {
    await p.click('.nl-item:has-text("Llamar al banco") [data-done]');
    await p.locator('.nl-done-toggle', { hasText: 'Hechas' }).waitFor();
    await p.waitForFunction(() => ![...document.querySelectorAll('.nl-group:not(.done) .nl-title')].some((t) => t.textContent.includes('Llamar al banco')));
    assert.equal(await p.getAttribute('.nl-done-toggle', 'aria-expanded'), 'false');
    await p.click('.nl-done-toggle');
    await p.locator('.nl-group.done', { hasText: 'Llamar al banco' }).waitFor();
    await p.click('.nl-group.done .nl-item:has-text("Llamar al banco") [data-done]');
    await p.waitForFunction(() => [...document.querySelectorAll('.nl-group:not(.done) .nl-title')].some((t) => t.textContent.includes('Llamar al banco')));
  });

  test('el «+» en Tareas abre una tarea nueva («Tarea nueva»)', async () => {
    await p.click('.tabbar [data-act=add]');
    await p.waitForSelector('.ne-todo');
    assert.equal(await p.getAttribute('[data-title]', 'placeholder'), 'Qué hay que hacer');
    assert.match(await p.textContent('.ne-foot'), /Tarea nueva/);
    assert.match(await p.textContent('[data-act=back]'), /Tareas/);
    await p.click('[data-act=back]');
    await p.waitForSelector('.nl-kind');
  });

  test('un cuaderno, dentro de Tareas: solo sus tareas', async () => {
    await p.click(`.nl-chips [data-book="${shared.id}"]`);
    await p.waitForFunction(() => document.querySelector('.nl-head h2')?.textContent.includes('Notas de casa'));
    assert.deepEqual(await pressed(), [['notes', 'false'], ['todo', 'true']], 'sigue en Tareas');
    assert.deepEqual((await items()).sort(), ['Cambiar el filtro', 'Llamar al banco', 'Pedir cita ITV']);
    await p.click('.nl-chips [data-allbooks]');
    await p.waitForFunction(() => !document.querySelector('.nl-head h2'));
  });

  test('fuera de Notas, el «+» vuelve a ser «Anotar gasto»', async () => {
    await show(p, srv.base, 'movimientos');
    assert.equal(await p.getAttribute('.tabbar [data-act=add]', 'aria-label'), 'Anotar gasto');
    await p.click('.tabbar [data-act=add]');
    await p.locator('dialog[open] h2', { hasText: 'Anotar movimiento' }).waitFor();
    await p.keyboard.press('Escape');
  });

  test('en el ordenador, al pasar a Tareas se abre una tarea (no se queda la nota abierta)', async () => {
    const d = await openApp(browser, srv.base, 'ana', { ...DESKTOP });
    await show(d.page, srv.base, 'notas');
    await d.page.click('[data-kind=notes]');
    await d.page.click('.nl-item:has-text("Wifi de casa") [data-note]');
    await d.page.waitForSelector('.ne-title');
    await d.page.click('[data-kind=todo]');
    await d.page.waitForSelector('.ne-todo');
    assert.equal(await d.page.$eval('.nl-item.on .nl-title', (e) => e.textContent.trim()), 'Cambiar el filtro');
    assert.deepEqual(d.errors, []);
    await d.ctx.close();
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors(), []);
  });
});
