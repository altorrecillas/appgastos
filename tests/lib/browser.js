// Navegador para las pruebas de pantalla (Chromium del sistema con playwright-core, sin descargar navegadores).
import fs from 'node:fs';
import { PASSWORD } from './client.js';

export const CHROMIUM = process.env.CHROMIUM_PATH
  || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((p) => fs.existsSync(p));
// Motivo para saltarse las pruebas de pantalla si falta el navegador o la librería.
export const SKIP = await (async () => {
  if (!CHROMIUM) return 'No hay Chromium (instálalo o indica CHROMIUM_PATH)';
  try {
    await import('playwright-core');
    return false;
  } catch {
    return 'Falta playwright-core (npm install)';
  }
})();

export const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
export const DESKTOP = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };

export async function launch() {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
}

// Abre la app con una cuenta ya creada. Devuelve la página y los errores de la página que vayan saliendo.
export async function openApp(browser, base, username, { hid = 1, password = PASSWORD, ...opts } = {}) {
  const ctx = await browser.newContext({ locale: 'es-ES', timezoneId: 'Europe/Madrid', acceptDownloads: true, ...MOBILE, ...opts });
  await ctx.addInitScript((h) => {
    try {
      localStorage.setItem('gastosbyath.hid', String(h));
    } catch { /* nada */ }
  }, hid);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|40[0-9]/.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('#a-user');
  await page.fill('#a-user', username);
  await page.fill('#a-pw', password);
  await page.click('#auth-form button[type=submit]');
  await page.waitForSelector('#page-title');
  await page.waitForTimeout(700);
  // El asistente de primer uso se cierra para que no tape la pantalla.
  await page.waitForSelector('.setup .su-foot [data-close]', { timeout: 1500 }).then(() => page.click('.setup .su-foot [data-close]')).catch(() => {});
  return { page, ctx, errors };
}

// Texto visible de un elemento con espacios normales (los importes llevan espacios duros).
export const text = async (page, sel) => (await page.textContent(sel)).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// Va a una sección y espera a que termine de cargar; falla si la sección enseña su error de carga.
export async function show(page, base, route) {
  await page.goto(`${base}/#/${route}`);
  await page.waitForTimeout(500);
  await page.waitForFunction(() => {
    const v = document.querySelector('#view');
    return v && !v.querySelector('.sk-page') && v.textContent.trim().length > 20;
  }, null, { timeout: 10000 });
  if (await page.$('.empty h3:has-text("No se ha podido cargar")')) throw new Error(`${route}: ${await page.textContent('.empty p')}`);
}

// Llama a la API desde la página (con su sesión).
export const api = (page, path, method = 'GET', body) => page.evaluate(async ([p, m, b]) => {
  const r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gastosbyath' }, body: b ? JSON.stringify(b) : undefined });
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}, [path, method, body]);
