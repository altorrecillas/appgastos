// En el móvil: un recordatorio para el mismo día a la hora que se elija (con los atajos o escribiéndola), y la lista
// enseña esa hora.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { SKIP, api, launch, openApp, show } from '../lib/browser.js';

describe('recordatorios con hora', { skip: SKIP }, () => {
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

  test('el mismo día a las 18:00, y se ve en la lista', async () => {
    const p = a.page;
    await show(p, srv.base, 'recordatorios?new=1');
    await p.waitForSelector('#remf');
    await p.fill('#rm-t', 'Recoger a Hugo');
    await p.click('dialog[open] [data-pick=remind_days] [data-v="0"]');
    assert.equal(await p.inputValue('#rm-h'), '09:00', 'por defecto, a las 9');
    await p.click('dialog[open] [data-hour="18:00"]');
    assert.equal(await p.inputValue('#rm-h'), '18:00');
    assert.equal(await p.getAttribute('dialog[open] [data-hour="18:00"]', 'aria-pressed'), 'true');
    await p.click('dialog[open] [data-act=save]');
    await p.locator('.toast', { hasText: 'Te avisaremos ese mismo día a las 18:00' }).waitFor();
    const { active } = await api(p, '/api/h/1/reminders');
    assert.deepEqual(active.map((m) => [m.title, m.remind_days, m.remind_time]), [['Recoger a Hugo', 0, '18:00']]);
    await p.locator('.rowi', { hasText: 'Recoger a Hugo' }).filter({ hasText: '18:00' }).waitFor();
  });

  test('cualquier otra hora, escribiéndola', async () => {
    const p = a.page;
    const id = (await api(p, '/api/h/1/reminders')).active[0].id;
    await p.click(`[data-menu="${id}"]`);
    await p.click('.menu[role=menu] button:has-text("Editar")');
    await p.waitForSelector('#rm-h');
    assert.equal(await p.inputValue('#rm-h'), '18:00', 'abre con su hora');
    await p.fill('#rm-h', '07:45');
    assert.equal(await p.$$eval('dialog[open] [data-hour][aria-pressed=true]', (x) => x.length), 0, 'ningún atajo marcado');
    await p.click('dialog[open] [data-act=save]');
    await p.waitForSelector('dialog[open]', { state: 'detached' });
    assert.equal((await api(p, '/api/h/1/reminders')).active[0].remind_time, '07:45');
  });

  test('sin errores en la página ni en el servidor', () => {
    assert.deepEqual(a.errors, []);
    assert.deepEqual(srv.errors(), []);
  });
});
