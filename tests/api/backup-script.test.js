// Copia diaria (scripts/backup.js): la base de datos entera cada vez y cada adjunto una sola vez. Un adjunto borrado
// se guarda mientras alguna copia de la base de datos lo use, y cualquier copia se restaura completa en otro servidor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, startServer } from '../lib/server.js';
import { Client, PASSWORD, newUser, sleep } from '../lib/client.js';

const H = '/api/h/1';
const KEEP = 3;
let srv;
let srv2;
let ana;
let dest;
let restoreDir;
const photos = {}; // nombre → { id, data, stored }

// Cada copia lleva la hora con segundos: se espera un poco para que no coincidan dos.
async function backup() {
  await sleep(1100);
  return execFileSync(process.execPath, ['scripts/backup.js', dest, String(KEEP)], { cwd: APP, env: { ...process.env, DATA_DIR: srv.dataDir }, encoding: 'utf8' });
}
const copies = () => fs.readdirSync(dest).filter((f) => f.endsWith('.db')).sort();
const mirrored = () => fs.readdirSync(path.join(dest, 'adjuntos')).sort();
async function upload(name) {
  const data = crypto.randomBytes(20000 + Math.floor(Math.random() * 5000));
  const r = await ana.req('POST', `${H}/attachments`, undefined, { raw: data, headers: { 'Content-Type': 'image/jpeg', 'X-Filename': `${name}.jpg` } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const before = new Set(mirroredOrEmpty());
  const stored = fs.readdirSync(path.join(srv.dataDir, 'uploads')).find((f) => !before.has(f) && fs.readFileSync(path.join(srv.dataDir, 'uploads', f)).equals(data));
  photos[name] = { id: r.data.id, data, stored };
}
const mirroredOrEmpty = () => (fs.existsSync(path.join(dest, 'adjuntos')) ? mirrored() : []);

before(async () => {
  dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gastosbyath-copias-'));
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  await ana.ok('POST', `${H}/demo`);
});
after(async () => {
  await srv?.stop();
  await srv2?.stop();
  for (const d of [dest, restoreDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test('primera copia: la base de datos y todos los adjuntos', async () => {
  await upload('ticket-1');
  await upload('ticket-2');
  const out = await backup();
  assert.match(out, /Adjuntos: 2 nuevos/);
  assert.equal(copies().length, 1);
  assert.deepEqual(mirrored(), [photos['ticket-1'].stored, photos['ticket-2'].stored].sort());
  for (const p of Object.values(photos)) assert.ok(fs.readFileSync(path.join(dest, 'adjuntos', p.stored)).equals(p.data));
  assert.deepEqual(fs.readdirSync(dest).filter((f) => /-(wal|shm)$/.test(f)), [], 'cada copia es un solo archivo');
});

test('las siguientes solo copian lo nuevo y no tocan lo que ya estaba', async () => {
  const ino = fs.statSync(path.join(dest, 'adjuntos', photos['ticket-1'].stored)).ino;
  assert.match(await backup(), /Adjuntos: 0 nuevos \(0 MB\), 2 ya estaban/);
  await upload('ticket-3');
  assert.match(await backup(), /Adjuntos: 1 nuevos .*, 2 ya estaban/);
  assert.equal(fs.statSync(path.join(dest, 'adjuntos', photos['ticket-1'].stored)).ino, ino, 'no se ha vuelto a copiar');
  assert.equal(copies().length, 3);
});

test('un adjunto copiado a medias se vuelve a copiar', async () => {
  const p = photos['ticket-3'];
  fs.truncateSync(path.join(dest, 'adjuntos', p.stored), 100);
  assert.match(await backup(), /Adjuntos: 1 nuevos/);
  assert.ok(fs.readFileSync(path.join(dest, 'adjuntos', p.stored)).equals(p.data));
});

test('un adjunto borrado sigue en la copia hasta que ninguna copia de la base de datos lo usa', async () => {
  const gone = photos['ticket-1'];
  await ana.ok('DELETE', `${H}/attachments/${gone.id}`);
  // Las 3 copias guardadas aún tienen el adjunto: se queda.
  for (let i = 0; i < KEEP - 1; i++) {
    await backup();
    assert.ok(mirrored().includes(gone.stored), `vuelta ${i + 1}: aún lo usa alguna copia`);
  }
  // Ya todas las copias son de después de borrarlo: se retira.
  assert.match(await backup(), /1 retirados porque ya no los usa ninguna copia/);
  assert.ok(!mirrored().includes(gone.stored));
  assert.ok(mirrored().includes(photos['ticket-2'].stored));
  assert.equal(copies().length, KEEP, `se guardan las ${KEEP} últimas`);
});

test('las copias antiguas (todos los adjuntos en .tar.gz) se borran cuando ya no queda su copia de la base de datos', async () => {
  const newest = copies().at(-1).replace(/^gastosbyath-|\.db$/g, '');
  fs.writeFileSync(path.join(dest, 'adjuntos-2026-01-01-03-30.tar.gz'), 'viejo');
  fs.writeFileSync(path.join(dest, `adjuntos-${newest}.tar.gz`), 'reciente');
  await backup();
  const tars = fs.readdirSync(dest).filter((f) => f.endsWith('.tar.gz'));
  assert.deepEqual(tars, [`adjuntos-${newest}.tar.gz`]);
});

test('una copia se restaura completa en un servidor nuevo', async () => {
  restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gastosbyath-restaurada-'));
  fs.copyFileSync(path.join(dest, copies().at(-1)), path.join(restoreDir, 'gastosbyath.db'));
  fs.cpSync(path.join(dest, 'adjuntos'), path.join(restoreDir, 'uploads'), { recursive: true });
  srv2 = await startServer({ env: { DATA_DIR: restoreDir } });
  const back = new Client(srv2.base, 'ana');
  assert.equal((await back.post('/api/auth/login', { username: 'ana', password: PASSWORD })).status, 200);
  const count = async (c) => (await c.ok('GET', `${H}/transactions?from=1990-01-01&to=2100-12-31&limit=1`)).total;
  const n = await count(ana);
  assert.ok(n > 100, `con un año de datos de ejemplo (${n})`);
  assert.equal(await count(back), n, 'los mismos movimientos');
  for (const name of ['ticket-2', 'ticket-3']) {
    const r = await back.get(`${H}/attachments/${photos[name].id}`);
    assert.equal(r.status, 200);
    assert.ok(r.data.equals(photos[name].data), `${name} igual que el original`);
  }
  assert.equal((await back.get(`${H}/attachments/${photos['ticket-1'].id}`)).status, 404, 'el borrado sigue borrado');
});

test('los servidores no han registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
  assert.deepEqual(srv2.errors(), []);
});
