// En el navegador: la tarjeta «¿la nómina de este mes es igual?» (varias personas, «Igual», «Es diferente», «Más tarde»),
// sus ajustes, la versión de la app con sus novedades y el aviso de que hay una versión nueva.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { SKIP, api, launch, openApp, show, text } from '../lib/browser.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version.replace(/\.0$/, '');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const MONTH_END = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
const PREV_END = ymd(new Date(now.getFullYear(), now.getMonth(), 0));
const H = '/api/h/1';

describe('nóminas que cambian y versión de la app', { skip: SKIP }, () => {
  let srv;
  let browser;
  let a;
  let ids;
  before(async () => {
    srv = await startServer();
    const ana = await newUser(srv.base, 'ana', 'Ana');
    const beto = (await ana.ok('POST', `${H}/people`, { name: 'Beto' })).people.find((p) => p.name === 'Beto');
    const anaPay = await ana.ok('POST', `${H}/recurring`, { kind: 'income', name: 'Nómina', amount: 180000, variable: true, frequency: 'monthly', start_date: PREV_END, auto: false });
    await ana.ok('POST', `${H}/recurring/${anaPay.id}/pay`, { amount: 175000, date: PREV_END });
    const betoPay = await ana.ok('POST', `${H}/recurring`, {
      kind: 'income', name: 'Nómina', amount: 150000, variable: true, frequency: 'monthly', start_date: MONTH_END, auto: false, person_id: beto.id,
    });
    ids = { ana: anaPay.id, beto: betoPay.id };
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana');
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
  });

  test('el Inicio pregunta por cada nómina; «Más tarde» la esconde hasta mañana', async () => {
    const p = a.page;
    await show(p, srv.base, 'inicio');
    await p.waitForSelector('.pay-ask');
    assert.equal(await p.$$eval('.pay-ask .pa-item', (x) => x.length), 2);
    assert.match(await text(p, '.pay-ask'), /Nómina de Beto/);
    assert.match(await text(p, '.pay-ask'), /La anterior: 1\.750,00 €/);
    await p.click('[data-act=ask-later]');
    assert.equal(await p.$('.pay-ask'), null);
    await show(p, srv.base, 'movimientos');
    await show(p, srv.base, 'inicio');
    assert.equal(await p.$('.pay-ask'), null, 'hoy ya no sale');
    await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gastosbyath.nominas.')).forEach((k) => localStorage.removeItem(k)));
    await show(p, srv.base, 'movimientos');
    await show(p, srv.base, 'inicio');
    await p.waitForSelector('.pay-ask');
  });

  test('«Es diferente» guarda la cantidad nueva y «Igual», la de siempre', async () => {
    const p = a.page;
    await p.click(`[data-diff="${ids.ana}"]`);
    await p.fill(`[data-diffform="${ids.ana}"] input`, '1.912,40');
    await p.click(`[data-diffform="${ids.ana}"] button[type=submit]`);
    await p.waitForFunction(() => document.querySelectorAll('.pay-ask .pa-item').length === 1);
    await p.click(`[data-same="${ids.beto}"]`);
    await p.waitForSelector('.pay-ask', { state: 'detached' });
    const rows = await api(p, `${H}/recurring`);
    assert.deepEqual([rows.find((r) => r.id === ids.ana).amount, rows.find((r) => r.id === ids.beto).amount], [191240, 150000]);
  });

  test('Ajustes → Hogar: preguntar o no y qué nóminas', async () => {
    const p = a.page;
    await show(p, srv.base, 'ajustes/hogar');
    await p.waitForSelector('[data-ic-enabled]');
    assert.equal(await p.$$eval('[data-variable]', (x) => x.length), 2);
    await p.click('label.switch:has([data-ic-enabled])');
    await p.waitForFunction(() => document.querySelector('[data-ic-day]')?.disabled);
    assert.equal((await api(p, H)).household.income_check.enabled, false);
  });

  test('Ajustes → Aplicación y el menú «Más» enseñan la versión y sus novedades', async () => {
    const p = a.page;
    await show(p, srv.base, 'ajustes/app');
    assert.equal(await text(p, '.settings-section .panel-head .sub'), `GastosbyATH ${VERSION}`);
    assert.match(await text(p, '.changelog article:first-child h3'), new RegExp(`^${VERSION.replace('.', '\\.')} la que usas`));
    assert.ok(await p.$('text=Instalar la app'));
    await p.tap('.tabbar [data-act=more]');
    assert.equal(await text(p, 'dialog[open] .bf-ver'), `Versión ${VERSION}`);
    await p.keyboard.press('Escape');
  });

  test('si el servidor tiene otra versión, avisa para actualizar', async () => {
    const p = a.page;
    await p.route('**/api/health', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, version: '99.1' }) }));
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.locator('.toast', { hasText: 'Hay una versión nueva de GastosbyATH: la 99.1' }).waitFor();
    await p.unroute('**/api/health');
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors(), []);
  });
});
