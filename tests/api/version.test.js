// Versión de la app: sale de package.json, la llevan la página y el service worker (así los móviles se actualizan),
// las novedades de CHANGELOG.md empiezan por ella, y «npm run subir-version» la sube bien.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, startServer } from '../lib/server.js';

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const VERSION = pkg.version.replace(/\.0$/, '');
let srv;

before(async () => {
  srv = await startServer();
});
after(() => srv?.stop());

test('el servidor, la página y el service worker llevan la versión de package.json', async () => {
  assert.deepEqual(await (await fetch(`${srv.base}/api/health`)).json(), { ok: true, version: VERSION });
  for (const p of ['/', '/index.html', '/movimientos']) {
    assert.match(await (await fetch(srv.base + p)).text(), new RegExp(`<meta name="app-version" content="${VERSION}">`), p);
  }
  const sw = await fetch(`${srv.base}/sw.js`);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(await sw.text(), new RegExp(`const VERSION = 'gastosbyath-${VERSION.replace(/\./g, '\\.')}';`));
});

test('el service worker guarda todo lo que hace falta para abrir la app sin conexión, y todo existe', async () => {
  const sw = await (await fetch(`${srv.base}/sw.js`)).text();
  const shell = JSON.parse(sw.match(/const SHELL = (\[[^\]]*\]);/)[1]);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const modules = walk(path.join(APP, 'public', 'js')).filter((f) => f.endsWith('.js')).map((f) => f.slice(path.join(APP, 'public').length).split(path.sep).join('/'));
  assert.ok(modules.length > 30);
  for (const m of modules) assert.ok(shell.includes(m), `falta ${m}`);
  const sprite = fs.readFileSync(path.join(APP, 'public', 'js', 'ui.js'), 'utf8').match(/\/icons\/sprite\.svg\?v=\d+/)[0];
  assert.ok(shell.includes(sprite), 'el sprite con la versión que usa ui.js');
  // Si uno solo fallara, el service worker no se instalaría.
  for (const u of shell) assert.equal((await fetch(srv.base + u)).status, 200, u);
});

test('las novedades empiezan por la versión actual (al subirla, hay que contar qué cambia)', async () => {
  const log = await (await fetch(`${srv.base}/api/changelog`)).json();
  assert.equal(log.version, VERSION);
  assert.equal(log.versions[0].version, VERSION, 'CHANGELOG.md tiene un apartado para esta versión');
  assert.ok(log.versions[0].items.length && !log.versions[0].items.includes('…'), 'con sus novedades escritas');
  assert.match(log.versions[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('«npm run subir-version»: mejora, arreglo y versión concreta (en una copia)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gastosbyath-version-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['package.json', 'package-lock.json', 'CHANGELOG.md', 'scripts/version.js']) fs.copyFileSync(path.join(APP, f), path.join(dir, f));
    const run = (...a) => execFileSync(process.execPath, ['scripts/version.js', ...a], { cwd: dir, encoding: 'utf8' });
    const version = () => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    const [maj, min] = pkg.version.split('.').map(Number);

    run('Una novedad', 'Otra novedad');
    assert.equal(version(), `${maj}.${min + 1}.0`);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    assert.deepEqual([lock.version, lock.packages[''].version], [version(), version()]);
    const log = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    assert.match(log, new RegExp(`## ${maj}\\.${min + 1} — \\d{4}-\\d{2}-\\d{2}\\n\\n- Una novedad\\n- Otra novedad\\n\\n## ${VERSION.replace(/\./g, '\\.')} `), 'encima de la anterior');

    run('arreglo', 'Un arreglo');
    assert.equal(version(), `${maj}.${min + 1}.1`);
    run('9.0');
    assert.equal(version(), '9.0.0');
    assert.match(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), /## 9\.0 — .*\n\n- …\n/, 'sin novedades deja «…» para escribirlas');
    const back = spawnSync(process.execPath, ['scripts/version.js', '1.0'], { cwd: dir, encoding: 'utf8' });
    assert.equal(back.status, 1, 'no deja bajar de versión');
    assert.equal(version(), '9.0.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
