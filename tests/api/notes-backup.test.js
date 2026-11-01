// Copia de seguridad de las notas: contenido del .zip, privacidad, restaurar tras perderlo todo, no duplicar,
// notas cambiadas, lectora, copia con contraseña (AES-256), importación de Markdown (Joplin) y archivos dañados.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../lib/server.js';
import { join, newUser } from '../lib/client.js';
import { createZip, readZip } from '../../src/zip.js';

const H = '/api/h/1/notes';
const SEVENZIP = ['/usr/bin/7z', '/usr/bin/7za', '/usr/bin/7zz'].find((p) => fs.existsSync(p));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);
const PW = 'la bici roja de 2026';
const names = (zip, opts) => readZip(zip, opts).map((e) => e.name);
const file = (zip, name, opts) => readZip(zip, opts).find((e) => e.name === name)?.data;

let one;
let two;
let ana;
let beto;
let backup;
const ids = {};

before(async () => {
  one = await startServer();
  ana = await newUser(one.base, 'ana', 'Ana');
  beto = await newUser(one.base, 'beto', 'Beto');
  await join(ana, beto, 'editor');
  const meta = await ana.ok('GET', `${H}/meta`);
  const shared = meta.books.find((b) => !b.private);
  const mine = meta.books.find((b) => b.private);
  const rec = await ana.ok('POST', `${H}/books`, { name: 'Recetas', icon: '🍳', private: false });
  const post = await ana.ok('POST', `${H}/books`, { name: 'Postres', parent_id: rec.id, private: false });
  const imgS = (await ana.req('POST', `${H}/images`, undefined, { raw: JPG, headers: { 'Content-Type': 'image/jpeg' } })).data;
  const imgP = (await ana.req('POST', `${H}/images?private=1`, undefined, { raw: PNG, headers: { 'Content-Type': 'image/png' } })).data;
  for (const [k, n] of Object.entries({
    wifi: { book_id: shared.id, title: 'Wifi: contraseñas / casa', body: `Red **CasaATH**\n\n![router](/api/h/1/attachments/${imgS.id})`, tags: ['casa', 'wifi'], pinned: true },
    flan: { book_id: post.id, title: 'Flan de huevo', body: '- [x] huevos\n- [ ] leche\n- [ ] azúcar', tags: ['recetas'] },
    itv: { book_id: shared.id, title: 'Pedir cita ITV', is_todo: true, due_at: '2026-11-03T10:30', body: 'Llamar por la mañana' },
    regalo: { book_id: mine.id, title: 'Regalo para Beto', body: `Bici\n![ref](/api/h/1/attachments/${imgP.id})`, tags: ['secreto'] },
    regalo2: { book_id: mine.id, title: 'Regalo para Beto', body: 'Mismo título, otra nota', is_todo: true, done: true },
  })) ids[k] = (await ana.ok('POST', H, n)).id;
  const old = await ana.ok('POST', H, { book_id: shared.id, title: 'Borrador viejo' });
  await ana.ok('POST', `${H}/${old.id}/trash`);
  await beto.ok('POST', H, { title: 'Diario de Beto', body: 'privado de Beto' });
});
after(async () => {
  await one?.stop();
  await two?.stop();
});

test('la copia: archivos, carpetas, front matter, imágenes y fecha de la última copia', async () => {
  assert.equal((await ana.ok('GET', `${H}/meta`)).last_backup, null);
  const r = await ana.get(`${H}/backup.zip`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition'), /notas-.*\.zip/);
  backup = r.data;
  const list = names(backup);
  assert.ok(list.includes('LEEME.txt') && list.includes('notas.json'));
  const man = JSON.parse(file(backup, 'notas.json'));
  const titles = man.notes.map((n) => n.title);
  for (const t of ['Wifi: contraseñas / casa', 'Flan de huevo', 'Pedir cita ITV', 'Regalo para Beto']) assert.ok(titles.includes(t), t);
  assert.ok(!titles.includes('Diario de Beto'), 'nunca las privadas de otra persona');
  assert.ok(!titles.includes('Borrador viejo'), 'sin la papelera');
  for (const p of ['Del hogar/Recetas/Postres/Flan de huevo.md', 'Solo para ti/Mis notas/Regalo para Beto.md', 'Solo para ti/Mis notas/Regalo para Beto (2).md', 'Del hogar/Notas de casa/Wifi contraseñas casa.md']) {
    assert.ok(list.includes(p), p);
  }
  const wifi = file(backup, 'Del hogar/Notas de casa/Wifi contraseñas casa.md').toString();
  assert.ok(wifi.startsWith('---\ntitle: "Wifi: contraseñas / casa"\ncreated: '));
  assert.ok(wifi.includes('\ntags:\n  - "casa"\n  - "wifi"\n') && wifi.includes('pinned: true'));
  const m = wifi.match(/!\[router\]\(([^)]+)\)/);
  assert.ok(m && m[1].startsWith('../../_recursos/'));
  assert.ok(list.includes(path.posix.normalize(path.posix.join('Del hogar/Notas de casa', m[1]))), 'la imagen está en el .zip');
  const itv = file(backup, 'Del hogar/Notas de casa/Pedir cita ITV.md').toString();
  assert.ok(itv.includes('completed?: no') && itv.includes('due: 2026-11-03T10:30:00'));
  assert.ok(list.some((n) => n.endsWith('.png')), 'las imágenes privadas propias van dentro');
  assert.ok((await ana.ok('GET', `${H}/meta`)).last_backup);
});

test('qué incluir: la de Beto no lleva lo privado de Ana; «solo privadas» sin imágenes', async () => {
  const tb = JSON.parse(file((await beto.get(`${H}/backup.zip`)).data, 'notas.json')).notes.map((n) => n.title);
  assert.ok(tb.includes('Diario de Beto') && tb.includes('Wifi: contraseñas / casa') && !tb.includes('Regalo para Beto'));
  const zp = (await ana.get(`${H}/backup.zip?scope=private&images=0`)).data;
  assert.deepEqual([...new Set(JSON.parse(file(zp, 'notas.json')).notes.map((n) => n.title))], ['Regalo para Beto']);
  assert.ok(!names(zp).some((n) => n.startsWith('_recursos')));
});

test('restaurar sobre lo mismo no duplica; una nota cambiada entra como «(restaurada)»', async () => {
  const same = await ana.req('POST', `${H}/restore`, undefined, { raw: backup, headers: { 'Content-Type': 'application/zip' } });
  assert.equal(same.status, 200);
  assert.deepEqual([same.data.notes, same.data.same, same.data.images], [0, 5, 0]);
  await ana.ok('PATCH', `${H}/${ids.flan}`, { body: '- [x] huevos\n- [x] leche (cambiada después)' });
  const r = (await ana.req('POST', `${H}/restore`, undefined, { raw: backup, headers: { 'Content-Type': 'application/zip' } })).data;
  assert.deepEqual([r.notes, r.renamed], [1, 1]);
  const flanes = (await ana.ok('GET', `${H}?q=flan`)).map((n) => n.title).sort();
  assert.deepEqual(flanes, ['Flan de huevo', 'Flan de huevo (restaurada)']);
});

test('desastre: restaurar en un servidor nuevo y vacío', async () => {
  two = await startServer();
  const a2 = await newUser(two.base, 'ana', 'Ana');
  const r = (await a2.req('POST', `${H}/restore`, undefined, { raw: backup, headers: { 'Content-Type': 'application/zip' } })).data;
  assert.deepEqual([r.notes, r.images, r.private, r.shared], [5, 2, 2, 3]);
  const m2 = await a2.ok('GET', `${H}/meta`);
  const book = (n) => m2.books.find((b) => b.name === n);
  assert.ok(book('Recetas') && book('Postres') && book('Notas de casa') && book('Mis notas'));
  assert.equal(book('Postres').parent_id, book('Recetas').id, 'subcuaderno en su sitio');
  assert.equal(m2.books.filter((b) => b.name === 'Notas de casa').length, 1, 'sin cuadernos repetidos');
  const all2 = await a2.ok('GET', H);
  const wifi = all2.find((n) => n.title.startsWith('Wifi'));
  assert.equal(wifi.pinned, 1);
  assert.deepEqual([...wifi.tags].sort(), ['casa', 'wifi']);
  const wfull = await a2.ok('GET', `${H}/${wifi.id}`);
  const man = JSON.parse(file(backup, 'notas.json'));
  assert.equal(wfull.created_at, man.notes.find((n) => n.title.startsWith('Wifi')).created_at, 'fechas originales');
  const att = wfull.body.match(/\/api\/h\/1\/attachments\/\d+/)[0];
  const img = await a2.get(att);
  assert.equal(img.status, 200);
  assert.ok(img.data.equals(JPG), 'la imagen es la misma');
  const itv = all2.find((n) => n.title === 'Pedir cita ITV');
  assert.deepEqual([itv.is_todo, itv.due_at, itv.done_at], [1, '2026-11-03T10:30', null]);
  const reg = all2.filter((n) => n.title === 'Regalo para Beto');
  assert.equal(reg.length, 2);
  assert.ok(reg.every((n) => n.private));
  assert.ok(reg.some((n) => n.is_todo && n.done_at), 'la tarea hecha sigue hecha');
  // En el servidor nuevo, otra persona no ve lo privado restaurado (ni su imagen).
  const b2 = await newUser(two.base, 'beto', 'Beto');
  await join(a2, b2, 'editor');
  const lb = await b2.ok('GET', H);
  assert.ok(!lb.some((n) => n.title === 'Regalo para Beto') && lb.some((n) => n.title.startsWith('Wifi')));
  for (const n of reg) {
    const body = (await a2.ok('GET', `${H}/${n.id}`)).body;
    const pi = body.match(/\/api\/h\/1\/attachments\/\d+/);
    if (pi) assert.equal((await b2.get(pi[0])).status, 404);
  }
  // Una lectora restaura solo lo privado (como suyo).
  const l2 = await newUser(two.base, 'lucia', 'Lucía');
  await join(a2, l2, 'viewer');
  const rl = (await l2.req('POST', `${H}/restore`, undefined, { raw: backup, headers: { 'Content-Type': 'application/zip' } })).data;
  assert.deepEqual([rl.shared, rl.private, rl.skipped_shared], [0, 2, 3]);
});

test('copia con contraseña: AES-256, sin títulos a la vista, y se restaura con la buena', async () => {
  const short = await ana.post(`${H}/backup.zip`, { scope: 'all', images: true, password: 'corta' });
  assert.equal(short.status, 400);
  const r = await ana.post(`${H}/backup.zip`, { scope: 'all', images: true, password: PW });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /protegida/);
  const enc = r.data;
  assert.throws(() => readZip(enc), (e) => e.extra?.code === 'password_required');
  assert.deepEqual(names(enc, { password: PW }), ['LEEME.txt', 'notas.zip']);
  assert.ok(!file(enc, 'LEEME.txt', { password: PW }).toString().includes('Wifi'), 'el LEEME de fuera no lleva datos');
  const inner = file(enc, 'notas.zip', { password: PW });
  assert.ok(names(inner).includes('notas.json'));
  const send = (pw) => ana.req('POST', `${H}/restore`, undefined, { raw: enc, headers: { 'Content-Type': 'application/zip', ...(pw ? { 'X-Backup-Password': encodeURIComponent(pw) } : {}) } });
  assert.equal((await send()).data.code, 'password_required');
  assert.equal((await send('no es esta')).data.code, 'wrong_password');
  const ok = await send(PW);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.notes, 0, 'con la buena, y sin duplicar nada');
});

test('la copia protegida se abre con 7-Zip', { skip: !SEVENZIP && 'No está 7-Zip instalado' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gastosbyath-7z-'));
  try {
    const f = path.join(dir, 'copia.zip');
    fs.writeFileSync(f, (await ana.post(`${H}/backup.zip`, { password: PW })).data);
    assert.match(execFileSync(SEVENZIP, ['l', '-slt', `-p${PW}`, f]).toString(), /AES-256/);
    assert.throws(() => execFileSync(SEVENZIP, ['t', '-pmala', f], { stdio: 'pipe' }));
    execFileSync(SEVENZIP, ['x', `-p${PW}`, `-o${dir}/x`, '-y', f], { stdio: 'pipe' });
    assert.ok(names(fs.readFileSync(path.join(dir, 'x', 'notas.zip'))).includes('notas.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('importar un .zip de Markdown (como una exportación de Joplin)', async () => {
  const a2 = await newUser(two.base, 'carla', 'Carla');
  const joplin = createZip([
    { name: 'Viajes/Roma 2027.md', data: '---\ntitle: Roma 2027\ncreated: 2025-03-01 10:00:00Z\nupdated: 2025-03-02 11:00:00Z\ntags:\n  - viajes\n  - italia\n---\n\nVisitar el **Coliseo**\n\n![mapa](../_resources/mapa%20roma.png)\n' },
    { name: 'Viajes/Maleta.md', data: '# Lista de la maleta\n\n- [ ] cargador\n- [ ] pasaporte\n' },
    { name: 'Del hogar/Compras/Ferretería.md', data: '---\ntitle: "Ferretería: tornillos"\ncompleted?: no\ndue: 2027-01-10 00:00:00Z\n---\nTornillos de 4 mm' },
    { name: '_resources/mapa roma.png', data: PNG },
    { name: '__MACOSX/Viajes/._Roma 2027.md', data: 'basura de macOS' },
  ]);
  const own = (await a2.ok('GET', '/api/auth/me')).households[0].id;
  const P = `/api/h/${own}/notes`;
  const send = () => a2.req('POST', `${P}/restore`, undefined, { raw: joplin, headers: { 'Content-Type': 'application/zip' } });
  const r = (await send()).data;
  assert.deepEqual([r.notes, r.images, r.shared, r.private], [3, 1, 1, 2]);
  const roma = (await a2.ok('GET', `${P}?q=roma`))[0];
  assert.equal(roma.title, 'Roma 2027');
  assert.deepEqual([...roma.tags].sort(), ['italia', 'viajes']);
  const rf = await a2.ok('GET', `${P}/${roma.id}`);
  assert.match(rf.body, new RegExp(`!\\[mapa\\]\\(/api/h/${own}/attachments/\\d+\\)`));
  assert.ok(rf.created_at.startsWith('2025-03-01 10:00:00'));
  assert.equal((await a2.ok('GET', `${P}?q=maleta`))[0].title, 'Lista de la maleta');
  const fe = (await a2.ok('GET', `${P}?q=tornillos`))[0];
  assert.deepEqual([fe.is_todo, fe.due_at, fe.private], [1, '2027-01-10', false]);
  const again = (await send()).data;
  assert.deepEqual([again.notes, again.same, again.images], [0, 3, 0], 'otra vez: nada duplicado, tampoco las imágenes');
});

test('archivos que no valen', async () => {
  const send = (raw) => ana.req('POST', `${H}/restore`, undefined, { raw, headers: { 'Content-Type': 'application/zip' } });
  let r = await send(Buffer.from('esto no es un zip'));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /zip/);
  assert.equal((await send(backup.subarray(0, backup.length / 2))).status, 400);
  r = await send(createZip([{ name: 'foto.jpg', data: JPG }]));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no hay notas/);
});

test('los servidores no han registrado errores', () => {
  assert.deepEqual(one.errors(), []);
  assert.deepEqual(two.errors(), []);
});
