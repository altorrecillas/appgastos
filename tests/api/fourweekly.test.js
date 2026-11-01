// Pagos «cada 4 semanas» (como cobra Basic-Fit) y la categoría «Gimnasio y deporte»: fechas, equivalente al mes,
// meses con dos cobros, la categoría en su sitio, los gimnasios reconocidos solos y la tabla rehecha sin perder enlaces.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';

const H = '/api/h/1';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
};
let srv;
let ana;
let gym;

before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');
});
after(() => srv?.stop());

const gymCat = async () => (await ana.ok('GET', H)).categories.find((c) => c.name === 'Gimnasio y deporte');

test('un hogar nuevo trae «Gimnasio y deporte», justo después de «Ocio y suscripciones»', async () => {
  const cats = (await ana.ok('GET', H)).categories.filter((c) => c.kind === 'expense').sort((a, b) => a.sort - b.sort).map((c) => c.name);
  const i = cats.indexOf('Gimnasio y deporte');
  assert.ok(i > 0, cats.join(', '));
  assert.equal(cats[i - 1], 'Ocio y suscripciones');
  assert.equal((await gymCat()).icon, '🏋️');
});

test('cada 4 semanas: avanza 28 días al pagar y al mes equivale a 13 cobros al año', async () => {
  const start = ymd(new Date());
  gym = await ana.ok('POST', `${H}/recurring`, {
    kind: 'expense', name: 'Gimnasio', provider: 'Basic-Fit', amount: 3499, frequency: 'fourweekly', start_date: start, auto: false, category_id: (await gymCat()).id,
  });
  assert.equal(gym.frequency, 'fourweekly');
  assert.equal(gym.monthly, Math.round((3499 * 365) / 12 / 28), 'unos 38 € al mes, no 34,99');
  const p1 = await ana.ok('POST', `${H}/recurring/${gym.id}/pay`);
  assert.equal(p1.next_date, plusDays(start, 28));
  const p2 = await ana.ok('POST', `${H}/recurring/${gym.id}/pay`);
  assert.equal(p2.next_date, plusDays(start, 56));
  assert.equal((await ana.post(`${H}/recurring`, { kind: 'expense', name: 'X', amount: 100, frequency: 'cada4', start_date: start })).status, 400);
});

test('un mes con dos cobros los cuenta los dos en el calendario', async () => {
  // Empieza el día 1 de un mes de 31 días: cobra el 1 y el 29.
  const now = new Date();
  const y = now.getFullYear() + 1;
  const m = 3; // marzo
  const rec = await ana.ok('POST', `${H}/recurring`, {
    kind: 'expense', name: 'Gimnasio de Beto', amount: 2999, frequency: 'fourweekly', start_date: `${y}-${pad(m)}-01`, auto: false,
  });
  const cal = await ana.ok('GET', `${H}/stats/calendar?month=${y}-${pad(m)}`);
  const days = cal.events.filter((e) => e.ref === rec.id).map((e) => e.date).sort();
  assert.deepEqual(days, [`${y}-03-01`, `${y}-03-29`]);
});

test('Basic-Fit y otros gimnasios se ponen solos en «Gimnasio y deporte»', async () => {
  const id = (await gymCat()).id;
  const r = await ana.ok('POST', `${H}/rules/categorize`, { items: [
    { text: 'BASIC-FIT SPAIN SAU', kind: 'expense' }, { text: 'Recibo VivaGym Madrid', kind: 'expense' }, { text: 'GO FIT Vallehermoso', kind: 'expense' },
  ] });
  assert.deepEqual(r.map((x) => x.category_id), [id, id, id]);
});

test('la tabla de pagos fijos rehecha: acepta las 4 semanas y sigue enlazada con los movimientos', async () => {
  const db = new Database(srv.db, { readonly: true });
  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'recurring'`).get().sql;
  assert.match(sql, /'fourweekly'/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_recurring_h'`).get(), 'con su índice');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE recurring_id = ?').get(gym.id).n, 2);
  db.close();
  // Las claves ajenas siguen activas: al borrar el pago, sus movimientos se quedan pero sin enlace.
  await ana.ok('DELETE', `${H}/recurring/${gym.id}`);
  const db2 = new Database(srv.db, { readonly: true });
  assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE description = 'Gimnasio' AND recurring_id IS NULL`).get().n, 2);
  db2.close();
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
