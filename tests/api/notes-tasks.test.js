// Notas y tareas por separado: «Notas» no trae tareas y «Tareas» no trae notas (también dentro de un cuaderno),
// las pendientes van primero, y el resumen cuenta notas, tareas pendientes y hechas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';

const H = '/api/h/1/notes';
let srv;
let ana;
let shared;
let mine;
const titles = (rows) => rows.map((n) => n.title).sort();

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
  const meta = await ana.ok('GET', `${H}/meta`);
  shared = meta.books.find((b) => !b.private);
  mine = meta.books.find((b) => b.private);
  await ana.ok('POST', H, { book_id: shared.id, title: 'Wifi de casa', body: 'CasaATH-5G' });
  await ana.ok('POST', H, { book_id: mine.id, title: 'Ideas de regalos' });
  await ana.ok('POST', H, { book_id: shared.id, title: 'Pedir cita ITV', is_todo: true, due_at: '2030-05-10' });
  await ana.ok('POST', H, { book_id: mine.id, title: 'Llamar al banco', is_todo: true });
  await ana.ok('POST', H, { book_id: shared.id, title: 'Comprar bombillas', is_todo: true, done: true });
});
after(() => srv?.stop());

test('«notes» solo trae notas y «todo» solo tareas, con las pendientes primero', async () => {
  assert.deepEqual(titles(await ana.ok('GET', `${H}?view=notes`)), ['Ideas de regalos', 'Wifi de casa']);
  const todo = await ana.ok('GET', `${H}?view=todo`);
  assert.deepEqual(titles(todo), ['Comprar bombillas', 'Llamar al banco', 'Pedir cita ITV']);
  assert.equal(todo.at(-1).title, 'Comprar bombillas', 'la hecha, al final');
  assert.equal((await ana.ok('GET', H)).length, 5, 'sin vista, todo junto (como antes)');
});

test('dentro de un cuaderno, también por separado', async () => {
  assert.deepEqual(titles(await ana.ok('GET', `${H}?view=notes&book=${shared.id}`)), ['Wifi de casa']);
  assert.deepEqual(titles(await ana.ok('GET', `${H}?view=todo&book=${shared.id}`)), ['Comprar bombillas', 'Pedir cita ITV']);
  assert.deepEqual(titles(await ana.ok('GET', `${H}?view=todo&book=${mine.id}`)), ['Llamar al banco']);
});

test('el resumen cuenta notas, tareas pendientes y hechas', async () => {
  const { counts } = await ana.ok('GET', `${H}/meta`);
  assert.deepEqual([counts.total, counts.notes, counts.todo, counts.done], [5, 2, 2, 1]);
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
