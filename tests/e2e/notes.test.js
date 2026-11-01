// Notas en el navegador: una nota nueva es privada (nadie más la ve ni la encuentra), las del hogar llegan
// a los demás al momento, y la copia con contraseña se descarga cifrada y se restaura en un servidor nuevo.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.js';
import { join, newUser } from '../lib/client.js';
import { DESKTOP, SKIP, api, launch, openApp, show } from '../lib/browser.js';

const PRIVATE = 'Regalo sorpresa para Beto';
const SHARED = 'Ferretería: tacos del 8';
const PASSWORD = 'la bici roja de 2026';

describe('notas en el navegador', { skip: SKIP }, () => {
  let srv;
  let srv2;
  let browser;
  let a;
  let b;
  let tmp;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gastosbyath-notas-'));
    srv = await startServer();
    const ana = await newUser(srv.base, 'ana', 'Ana');
    const beto = await newUser(srv.base, 'beto', 'Beto');
    await join(ana, beto, 'editor');
    browser = await launch();
    a = await openApp(browser, srv.base, 'ana', DESKTOP);
    b = await openApp(browser, srv.base, 'beto', DESKTOP);
    for (const x of [a, b]) await show(x.page, srv.base, 'notas');
  });
  after(async () => {
    await browser?.close();
    await srv?.stop();
    await srv2?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Escribe una nota nueva y espera a que se guarde (la dirección pasa a #/notas/<id>).
  async function write(page, title, body) {
    const before = await page.evaluate(() => location.hash);
    await page.click('#page-actions [data-act=new-note]');
    await page.fill('[data-title]', title);
    await page.fill('[data-body]', body);
    await page.waitForFunction((h) => /#\/notas\/\d+$/.test(location.hash) && location.hash !== h, before);
    await page.locator('.ne', { hasText: 'Guardado' }).waitFor();
  }

  test('una nota nueva es privada: Beto no la ve ni la encuentra', async () => {
    await write(a.page, PRIVATE, 'Una bici roja, talla M.');
    assert.ok(await a.page.$('.ne-book.priv'), 'va a un cuaderno privado');
    await b.page.fill('[data-q]', 'bici');
    await b.page.locator('.nl-empty', { hasText: 'Nada coincide' }).waitFor();
    await b.page.fill('[data-q]', '');
    assert.equal(await b.page.locator('.nl-item', { hasText: PRIVATE }).count(), 0);
  });

  test('una nota en «Notas de casa» le sale a Beto al momento', async () => {
    const meta = await api(a.page, '/api/h/1/notes/meta');
    const house = meta.books.find((x) => !x.private);
    await a.page.click(`.nb-pane [data-book="${house.id}"]`);
    await write(a.page, SHARED, 'Y una broca de 8 para pared.');
    assert.equal(await a.page.$('.ne-book.priv'), null);
    await b.page.locator('.nl-item', { hasText: SHARED }).waitFor({ timeout: 8000 });
    assert.equal(await b.page.locator('.nl-item', { hasText: PRIVATE }).count(), 0);
  });

  let file;
  test('la copia con contraseña se descarga cifrada', async () => {
    const p = a.page;
    await p.click('.nb-pane [data-act=backup]');
    await p.click('dialog[open] label.switch:has([data-protect])');
    await p.fill('dialog[open] [data-p1]', PASSWORD);
    await p.fill('dialog[open] [data-p2]', PASSWORD);
    assert.equal((await p.textContent('dialog[open] [data-dltext]')).trim(), 'Descargar copia protegida (.zip)');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('dialog[open] [data-act=download]')]);
    file = path.join(tmp, dl.suggestedFilename());
    await dl.saveAs(file);
    assert.match(file, /\.zip$/);
    const buf = fs.readFileSync(file);
    assert.ok(buf.includes(Buffer.from([0x01, 0x99, 0x07, 0x00])), 'lleva cifrado AES');
    for (const s of ['Regalo', 'bici roja', 'Ferreter', 'tacos']) assert.ok(!buf.includes(Buffer.from(s)), `«${s}» no va a la vista`);
    await p.keyboard.press('Escape');
  });

  test('se restaura en un servidor nuevo, pidiendo la contraseña (y otra vez si es la mala)', async () => {
    srv2 = await startServer();
    await newUser(srv2.base, 'ana', 'Ana');
    const x = await openApp(browser, srv2.base, 'ana', DESKTOP);
    const p = x.page;
    await show(p, srv2.base, 'notas');
    await p.click('.nb-pane [data-act=backup]');
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('dialog[open] [data-act=restore-file]')]);
    await chooser.setFiles(file);
    await p.fill('#pf-v', 'esta no es la buena');
    await p.click('dialog[open] button[form=pf]');
    await p.locator('dialog[open]', { hasText: 'Esa no es la contraseña' }).waitFor();
    await p.fill('#pf-v', PASSWORD);
    await p.click('dialog[open] button[form=pf]');
    await p.locator('[data-result]', { hasText: 'Restauradas 2 notas' }).waitFor({ timeout: 10000 });
    await p.keyboard.press('Escape');
    for (const t of [PRIVATE, SHARED]) await p.locator('.nl-item', { hasText: t }).waitFor();
    const list = await api(p, '/api/h/1/notes');
    const byTitle = Object.fromEntries(list.map((n) => [n.title, n.private]));
    assert.deepEqual([byTitle[PRIVATE], byTitle[SHARED]], [true, false], 'cada nota sigue siendo de quien era');
    assert.deepEqual(x.errors, []);
    assert.deepEqual(srv2.errors(), []);
  });

  test('sin errores en las páginas ni en el servidor', () => {
    assert.deepEqual([...a.errors, ...b.errors], []);
    assert.deepEqual(srv.errors(), []);
  });
});
