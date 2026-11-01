// En el navegador: desde los gastos de una mascota se anota la comida (con lo que pone su ficha como primera sugerencia)
// y queda en sus gastos; y en el móvil la página no se amplía al pellizcar ni con doble toque.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { SKIP, api, launch, openApp, show } from '../lib/browser.js';

const H = '/api/h/1';

describe('comida de las mascotas y zoom en el móvil', { skip: SKIP }, () => {
  let srv;
  let browser;
  let a;
  before(async () => {
    srv = await startServer();
    const ana = await newUser(srv.base, 'ana', 'Ana');
    await ana.ok('POST', `${H}/demo`);
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana');
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  test('en los gastos de Luna, «Anotar gasto» abre la comida y queda como gasto suyo', async () => {
    const p = a.page;
    const luna = (await api(p, `${H}/pets`)).find((x) => x.name === 'Luna');
    await show(p, srv.base, `mascotas/${luna.id}`);
    await p.click('[data-tab=gastos]');
    await p.click('[data-act=expense]');
    await p.waitForSelector('#evf');
    assert.equal(await p.getAttribute('dialog[open] [data-pick=type] [data-v=food]', 'aria-pressed'), 'true', 'empieza en «Comida»');
    const first = (await p.textContent('dialog[open] [data-title] >> nth=0')).trim();
    assert.equal(first, 'Pienso Advance Medium Adult', 'la de su ficha, la primera');
    await p.click('dialog[open] [data-title] >> nth=0');
    await p.fill('#ev-c', '45,99');
    await p.click('dialog[open] [data-act=save]');
    await p.waitForSelector('dialog[open]', { state: 'detached' });
    const tx = await api(p, `${H}/transactions?pet=${luna.id}&period=all&q=Pienso%20Advance&limit=5`);
    assert.ok(tx.items.some((t) => t.amount === 4599 && t.pet_id === luna.id && t.category_name === 'Mascotas'), JSON.stringify(tx.items).slice(0, 300));
    await p.locator('.rowi', { hasText: 'Pienso Advance Medium Adult' }).first().waitFor();
  });

  test('en el móvil no se amplía al pellizcar ni con doble toque (se desplaza, nada más)', async () => {
    const p = a.page;
    assert.match(await p.getAttribute('meta[name=viewport]', 'content'), /maximum-scale=1, user-scalable=no/);
    assert.equal(await p.evaluate(() => getComputedStyle(document.documentElement).touchAction), 'pan-x pan-y');
    // El recorte de fotos sigue pudiendo usar dos dedos: maneja él mismo los toques.
    assert.ok((await p.evaluate(() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
      .some((r) => r.selectorText === '.crop canvas' && r.style.touchAction === 'none'))));
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors(), []);
  });
});
