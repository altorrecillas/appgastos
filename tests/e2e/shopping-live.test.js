// La lista de la compra en directo entre varias personas: lo que una añade o mete en el carro le aparece
// a la otra sin recargar, y quien solo puede ver no puede tocar nada.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { join, newUser } from '../lib/client.js';
import { DESKTOP, SKIP, launch, openApp, show } from '../lib/browser.js';

describe('lista de la compra en directo', { skip: SKIP }, () => {
  let srv;
  let browser;
  let a;
  let b;
  let l;
  before(async () => {
    srv = await startServer();
    const ana = await newUser(srv.base, 'ana', 'Ana');
    const beto = await newUser(srv.base, 'beto', 'Beto');
    const lucia = await newUser(srv.base, 'lucia', 'Lucía');
    await join(ana, beto, 'editor');
    await join(ana, lucia, 'viewer');
    const list = await ana.ok('POST', '/api/h/1/shopping/lists', { name: 'Semana', store: 'Mercadona' });
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana');
    b = await openApp(browser, srv.base, 'beto', DESKTOP);
    l = await openApp(browser, srv.base, 'lucia');
    for (const x of [a, b, l]) await show(x.page, srv.base, `compra/${list.id}`);
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  const item = (x, name, done = false) => x.page.locator(done ? '.item.done' : '.item:not(.done)', { hasText: name }).waitFor({ timeout: 8000 });

  test('lo que Ana añade desde el móvil le sale a Beto sin recargar', async () => {
    await a.page.fill('.add-item input[name=name]', 'Leche, pan, 2 kg naranjas');
    await a.page.press('.add-item input[name=name]', 'Enter');
    await item(a, 'Naranjas');
    for (const name of ['Leche', 'Pan', 'Naranjas']) await item(b, name);
    assert.match(await b.page.locator('.item', { hasText: 'Naranjas' }).textContent(), /2 kg/);
  });

  test('Beto mete el pan en el carro y Ana lo ve al momento', async () => {
    await b.page.click('[data-check][aria-label="Marcar como comprado: Pan"]');
    await item(a, 'Pan', true);
    await a.page.locator('.cart-bar', { hasText: '1 producto' }).waitFor();
  });

  test('Lucía (solo lectura) lo ve todo pero no puede añadir ni marcar', async () => {
    await item(l, 'Leche');
    await item(l, 'Pan', true);
    assert.equal(await l.page.$('.add-item'), null);
    assert.equal(await l.page.isDisabled('[data-check][aria-label="Marcar como comprado: Leche"]'), true);
  });

  test('sin errores en las páginas ni en el servidor', () => {
    assert.deepEqual([...a.errors, ...b.errors, ...l.errors], []);
    assert.deepEqual(srv.errors(), []);
  });
});
