// En el móvil, la página de una mascota cabe en la pantalla (nada se sale por el lado): la ficha y la evolución del peso
// se abren con «Ficha y peso», y el peso se escribe en «Editar ficha» (ya no hay botón de «Anotar peso»).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { SKIP, api, launch, openApp, show } from '../lib/browser.js';

const H = '/api/h/1';
const weightsOf = (pet) => pet.events.filter((e) => e.weight != null);

describe('ficha y peso de las mascotas', { skip: SKIP }, () => {
  let srv;
  let browser;
  let a;
  let luna;
  before(async () => {
    srv = await startServer();
    const ana = await newUser(srv.base, 'ana', 'Ana');
    await ana.ok('POST', `${H}/demo`);
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana', { viewport: { width: 360, height: 760 } });
    luna = (await api(a.page, `${H}/pets`)).find((x) => x.name === 'Luna');
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  test('a 360 px nada se sale por el lado; solo quedan las pestañas de salud y gastos', async () => {
    const p = a.page;
    await show(p, srv.base, `mascotas/${luna.id}`);
    assert.deepEqual(await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [360, 360]);
    const off = await p.$$eval('.pet-hero *', (els) => els.filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.textContent.trim()));
    assert.deepEqual(off, []);
    assert.deepEqual(await p.$$eval('[role=tab]', (els) => els.map((e) => e.dataset.tab)), ['salud', 'gastos']);
    assert.equal(await p.$('[data-act=weight]'), null, 'sin «Anotar peso»');
  });

  test('«Ficha y peso» abre la ficha y, al lado, la evolución del peso', async () => {
    const p = a.page;
    await p.click('[data-act=card]');
    await p.locator('dialog[open] dt', { hasText: 'Microchip' }).waitFor();
    assert.match(await p.textContent('dialog[open] .kv'), /Pienso Advance Medium Adult/);
    await p.click('dialog[open] [data-card-view] [data-v=peso]');
    await p.waitForSelector('dialog[open] #wchart svg');
    const pet = await api(p, `${H}/pets/${luna.id}`);
    assert.equal(await p.$$eval('dialog[open] [data-wev]', (b) => b.length), weightsOf(pet).length);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), 360);
  });

  test('en «Editar ficha» se escribe el peso: queda en su evolución con fecha de hoy', async () => {
    const p = a.page;
    const before = weightsOf(await api(p, `${H}/pets/${luna.id}`)).length;
    await p.click('dialog[open] [data-act=edit]');
    await p.waitForSelector('#ptf');
    await p.waitForFunction(() => document.activeElement?.id === 'pt-w');
    assert.equal(await p.inputValue('#pt-w'), '29,9', 'con el último peso');
    await p.fill('#pt-w', '30,4');
    await p.click('dialog[open] [data-act=save]');
    await p.locator('.toast', { hasText: 'Peso de hoy: 30,4 kg' }).waitFor();
    let pet = await api(p, `${H}/pets/${luna.id}`);
    assert.equal(pet.weight, 30.4);
    assert.equal(weightsOf(pet).length, before + 1);
    await p.locator('.pet-hero .pill', { hasText: '30,4 kg' }).waitFor();
    // Guardar otra cosa de la ficha no añade otro peso.
    await p.click('.pet-actions [data-act=edit]');
    await p.waitForSelector('#ptf');
    await p.fill('#pt-i', 'Santévet Premium');
    await p.click('dialog[open] [data-act=save]');
    await p.waitForSelector('dialog[open]', { state: 'detached' });
    pet = await api(p, `${H}/pets/${luna.id}`);
    assert.deepEqual([pet.insurance, weightsOf(pet).length], ['Santévet Premium', before + 1]);
  });

  test('un peso mal escrito se corrige desde la lista', async () => {
    const p = a.page;
    await show(p, srv.base, `mascotas/${luna.id}?tab=peso`);
    await p.waitForSelector('dialog[open] #wchart');
    assert.equal(await p.getAttribute('dialog[open] [data-card-view] [data-v=peso]', 'aria-pressed'), 'true', 'el enlace antiguo abre el peso');
    await p.click('dialog[open] [data-wev] >> nth=0');
    await p.waitForSelector('#ev-w');
    assert.equal(await p.$('dialog[open] [data-pick=type]'), null, 'sin elegir tipo: es un peso');
    await p.fill('#ev-w', '30,1');
    await p.click('dialog[open] [data-act=save]');
    await p.waitForSelector('dialog[open]', { state: 'detached' });
    assert.equal((await api(p, `${H}/pets/${luna.id}`)).weight, 30.1);
  });

  test('«Anotar» es para los cuidados: ya no ofrece el peso', async () => {
    const p = a.page;
    await p.click('#page-actions [data-act=event]');
    await p.waitForSelector('#evf');
    const types = await p.$$eval('dialog[open] [data-pick=type] [data-v]', (els) => els.map((e) => e.dataset.v));
    assert.ok(types.includes('food') && types.includes('vaccine'));
    assert.ok(!types.includes('weight'), types.join());
    await p.click('dialog[open] [data-close]');
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors(), []);
  });
});
