// Notas: privacidad entre miembros (ni un administrador ve las privadas de otro), permisos por rol,
// búsqueda sin tildes, conflictos al editar a la vez, imágenes privadas, tareas, papelera, cuadernos,
// avisos en tiempo real solo para su dueño y exportar/importar sin filtrar notas ajenas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { join, newUser, sleep } from '../lib/client.js';

let srv;
let ana; // dueña
let beto; // administrador
let lucia; // lectora
const H = '/api/h/1/notes';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const s = {}; // lo que se comparte entre pasos

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  beto = await newUser(srv.base, 'beto', 'Beto');
  lucia = await newUser(srv.base, 'lucia', 'Lucía');
  await join(ana, beto, 'admin');
  await join(ana, lucia, 'viewer');
  const meta = await ana.ok('GET', `${H}/meta`);
  s.shared = meta.books.find((b) => !b.private);
  s.mine = meta.books.find((b) => b.private);
});
after(() => srv?.stop());

test('cada persona tiene su cuaderno privado y el del hogar es común', async () => {
  const mb = await beto.ok('GET', `${H}/meta`);
  assert.ok(mb.books.some((b) => b.id === s.shared.id));
  assert.ok(!mb.books.some((b) => b.id === s.mine.id), 'Beto no ve el cuaderno privado de Ana');
});

test('una nota privada no existe para nadie más (tampoco para un administrador)', async () => {
  s.n1 = await ana.ok('POST', H, { book_id: s.shared.id, title: 'Wifi de casa', body: 'Contraseña: **pepito123**', tags: ['casa', 'Wifi'] });
  s.n2 = await ana.ok('POST', H, { title: 'Regalo para Beto', body: 'Una bici - [ ] mirar tallas', tags: ['secreto'] });
  const n2 = await ana.ok('GET', `${H}/${s.n2.id}`);
  assert.equal(n2.private, true);
  assert.equal(n2.book_id, s.mine.id);
  const list = await beto.ok('GET', H);
  assert.ok(list.some((n) => n.id === s.n1.id) && !list.some((n) => n.id === s.n2.id));
  assert.equal((await beto.get(`${H}/${s.n2.id}`)).status, 404);
  assert.equal((await beto.patch(`${H}/${s.n2.id}`, { title: 'hackeada' })).status, 404);
  assert.equal((await beto.post(`${H}/${s.n2.id}/trash`)).status, 404);
  assert.deepEqual(await beto.ok('GET', `${H}?q=bici`), []);
  const tags = (await beto.ok('GET', `${H}/meta`)).tags.map((t) => t.tag);
  assert.ok(!tags.includes('secreto'), 'las etiquetas privadas no se cuelan');
});

test('búsqueda: sin tildes, por prefijo, por etiqueta y a prueba de comillas', async () => {
  const r = await ana.ok('GET', `${H}?q=contrasena`);
  assert.deepEqual(r.map((n) => n.id), [s.n1.id]);
  assert.ok(r[0].hit.includes('\u0001'), 'fragmento resaltado');
  assert.deepEqual((await ana.ok('GET', `${H}?q=pepi`)).map((n) => n.id), [s.n1.id]);
  assert.deepEqual((await ana.ok('GET', `${H}?tag=wifi`)).map((n) => n.id), [s.n1.id]);
  assert.equal((await ana.get(`${H}?q=%22raro`)).status, 200);
});

test('lectora: lee lo del hogar y escribe solo sus notas privadas', async () => {
  const list = await lucia.ok('GET', H);
  const n1 = list.find((n) => n.id === s.n1.id);
  assert.ok(n1 && !n1.can_edit);
  assert.equal((await lucia.patch(`${H}/${s.n1.id}`, { title: 'cambio' })).status, 403);
  assert.equal((await lucia.post(H, { book_id: s.shared.id, title: 'intento' })).status, 403);
  assert.equal((await lucia.post(H, { title: 'Mi diario', body: 'hoy…' })).status, 201);
  assert.equal((await lucia.post('/api/h/1/transactions', { kind: 'expense', amount: 100 })).status, 403, 'el resto sigue en solo lectura');
  assert.equal((await lucia.post(`${H}/books`, { name: 'Del hogar 2', private: false })).status, 403);
});

test('editar a la vez: el segundo recibe un aviso y puede elegir', async () => {
  const base = (await ana.ok('GET', `${H}/${s.n1.id}`)).updated_at;
  assert.equal((await beto.patch(`${H}/${s.n1.id}`, { body: 'Contraseña nueva', base })).status, 200);
  const c = await ana.patch(`${H}/${s.n1.id}`, { body: 'Contraseña de Ana', base });
  assert.equal(c.status, 409);
  assert.equal(c.data.conflict.body, 'Contraseña nueva');
  assert.match(c.data.error, /Beto/);
  const forced = await ana.patch(`${H}/${s.n1.id}`, { body: 'Contraseña de Ana', base, force: true });
  assert.equal(forced.status, 200);
  assert.equal((await ana.patch(`${H}/${s.n1.id}`, { body: 'otra vez', base: forced.data.updated_at })).status, 200, 'guardados seguidos');
});

test('imágenes privadas: solo las abre su dueña, y se comparten al pasar la nota al hogar', async () => {
  const up = await ana.req('POST', `${H}/images?private=1`, undefined, { raw: PNG, headers: { 'Content-Type': 'image/png', 'X-Filename': 'foto.png' } });
  assert.equal(up.status, 201);
  const att = `/api/h/1/attachments/${up.data.id}`;
  assert.equal((await beto.get(att)).status, 404);
  assert.equal((await ana.get(att)).status, 200);
  const n3 = await ana.ok('POST', H, { title: 'Plano del salón', body: `![plano](${att})` });
  await ana.ok('PATCH', `${H}/${n3.id}`, { book_id: s.shared.id });
  assert.equal((await beto.get(att)).status, 200);
  assert.equal((await ana.req('POST', `${H}/images`, undefined, { raw: PNG, headers: { 'Content-Type': 'image/png' } })).status, 201);
  assert.equal((await lucia.req('POST', `${H}/images`, undefined, { raw: PNG, headers: { 'Content-Type': 'image/png' } })).status, 403, 'una lectora no sube imágenes al hogar');
  const priv = await lucia.req('POST', `${H}/images?private=1`, undefined, { raw: PNG, headers: { 'Content-Type': 'image/png' } });
  assert.equal(priv.status, 201);
  assert.equal((await ana.patch('/api/h/1/people/1', { photo_id: priv.data.id })).status, 400, 'una imagen privada no sirve de foto');
});

test('tareas: orden por fecha, hechas y fechas no válidas', async () => {
  const t1 = await ana.ok('POST', H, { book_id: s.shared.id, title: 'Pedir cita ITV', is_todo: true, due_at: '2026-11-03' });
  const t2 = await ana.ok('POST', H, { book_id: s.shared.id, title: 'Llamar al fontanero', is_todo: true, due_at: '2026-10-28T10:30' });
  assert.deepEqual((await ana.ok('GET', `${H}?view=todo`)).slice(0, 2).map((n) => n.id), [t2.id, t1.id]);
  await ana.ok('PATCH', `${H}/${t2.id}`, { done: true });
  assert.equal((await ana.ok('GET', `${H}/meta`)).counts.todo, 1);
  assert.equal((await ana.patch(`${H}/${t1.id}`, { due_at: 'mañana' })).status, 400);
});

test('cuadernos y papelera', async () => {
  const bk = await ana.ok('POST', `${H}/books`, { name: 'Recetas', icon: '🍳', private: false });
  const sub = await ana.ok('POST', `${H}/books`, { name: 'Postres', parent_id: bk.id, private: false });
  assert.equal((await ana.post(`${H}/books`, { name: 'Mezcla', parent_id: bk.id, private: true })).status, 400);
  assert.equal((await ana.patch(`${H}/books/${bk.id}`, { parent_id: sub.id })).status, 400, 'sin ciclos');
  const r1 = await ana.ok('POST', H, { book_id: sub.id, title: 'Flan' });
  await ana.ok('DELETE', `${H}/books/${bk.id}`);
  assert.ok((await ana.ok('GET', `${H}?view=trash`)).some((n) => n.id === r1.id), 'sus notas van a la papelera');
  await ana.ok('POST', `${H}/${r1.id}/restore`);
  const back = await ana.ok('GET', `${H}/${r1.id}`);
  assert.equal(back.deleted_at, null);
  assert.equal(back.private, false);
  assert.equal((await ana.del(`${H}/${r1.id}`)).status, 400, 'primero a la papelera');
  await ana.ok('POST', `${H}/${r1.id}/trash`);
  await ana.ok('POST', `${H}/${s.n2.id}/trash`);
  const emptied = await beto.ok('DELETE', `${H}/trash`);
  assert.equal(emptied.deleted, 1, 'Beto solo vacía lo del hogar');
  assert.ok((await ana.ok('GET', `${H}/${s.n2.id}`)).deleted_at, 'la privada de Ana sigue en su papelera');
});

// Escucha los avisos en tiempo real de una persona durante un rato.
async function listen(client, ms) {
  const events = [];
  const ctrl = new AbortController();
  const res = await fetch(`${srv.base}/api/h/1/events`, { headers: { Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (line) events.push(JSON.parse(line.slice(5)));
        }
      }
    } catch { /* cortado a propósito */ }
  })();
  return { events, stop: async () => { await sleep(ms); ctrl.abort(); await pump; } };
}

test('tiempo real: los cambios privados solo le llegan a su dueña y no dejan títulos', async () => {
  const la = await listen(ana, 1200);
  const lb = await listen(beto, 1200);
  await sleep(300);
  const p = await ana.ok('POST', H, { title: 'Privada en vivo' });
  const sh = await ana.ok('POST', H, { book_id: s.shared.id, title: 'Del hogar en vivo' });
  await Promise.all([la.stop(), lb.stop()]);
  const idsB = lb.events.filter((e) => e.entity === 'notes').map((e) => e.id);
  const idsA = la.events.filter((e) => e.entity === 'notes').map((e) => e.id);
  assert.ok(idsB.includes(sh.id), 'Beto se entera de la del hogar');
  assert.ok(!idsB.includes(p.id), 'Beto no se entera de la privada');
  assert.ok(idsA.includes(p.id) && idsA.includes(sh.id), 'Ana, en sus otros dispositivos, de las dos');
  assert.ok(!lb.events.some((e) => e.entity === 'notes' && e.summary), 'sin títulos en la actividad');
});

test('exportar el hogar: cada cual se lleva lo del hogar y solo sus notas privadas', async () => {
  const ea = await ana.ok('GET', '/api/h/1/data/export.json');
  const eb = await beto.ok('GET', '/api/h/1/data/export.json');
  const ta = ea.notes.map((n) => n.title);
  const tb = eb.notes.map((n) => n.title);
  assert.ok(ta.includes('Regalo para Beto'));
  assert.ok(!tb.includes('Regalo para Beto') && tb.includes('Wifi de casa'));
  assert.ok(![...ta, ...tb].includes('Mi diario'), 'tampoco el diario de Lucía');
  assert.ok(ea.notes.every((n) => !('owner_id' in n)) && ea.note_books.every((b) => !('owner_id' in b)));
  // Importar en el hogar propio de Beto: las notas llegan y Ana no puede entrar ahí.
  const own = (await beto.ok('GET', '/api/auth/me')).households.find((h) => h.id !== 1).id;
  const imp = await beto.ok('POST', `/api/h/${own}/data/import.json`, eb);
  assert.equal(imp.counts.notes, eb.notes.length);
  assert.equal((await beto.ok('GET', `/api/h/${own}/notes?q=wifi`)).length, 1);
  assert.equal((await ana.get(`/api/h/${own}/notes`)).status, 404);
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
