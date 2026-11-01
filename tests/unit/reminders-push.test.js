// Cuándo sale el aviso de cada recordatorio: a la hora elegida (ni un minuto antes), o a la de los avisos del día si no
// tiene; el día de antelación, el mismo día y el siguiente si sigue pendiente; los hechos, nunca.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let remindersDue;
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);
const keys = (now) => remindersDue(now).map((r) => r.key.replace(/^1:/, '')).sort();
const titles = (now) => remindersDue(now).map((r) => r.payload.title).sort();

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gastosbyath-avisos-'));
  delete process.env.PUSH_HOUR;
  const { run } = await import('../../src/db.js');
  ({ remindersDue } = await import('../../src/push.js'));
  run(`INSERT INTO households (id, name) VALUES (1, 'Casa')`);
  const add = (id, title, date, days, time, done = null) => run(
    `INSERT INTO reminders (id, household_id, title, kind, date, remind_days, remind_time, done_at) VALUES (?, 1, ?, 'date', ?, ?, ?, ?)`,
    id, title, date, days, time, done,
  );
  add(1, 'Recoger a Hugo', '2030-05-10', 0, '18:00'); // el mismo día, a las 18:00
  add(2, 'Pagar la ITV', '2030-05-10', 1, null); // un día antes, a la hora de siempre
  add(3, 'Pastilla', '2030-05-10', 0, '07:30'); // antes de las 9: también
  add(4, 'Ya hecho', '2030-05-10', 0, '10:00', '2030-05-01 10:00:00');
});

test('a la hora elegida y no un minuto antes', () => {
  assert.deepEqual(keys(at(2030, 5, 10, 17, 59)), ['rem2:2030-05-10', 'rem3:2030-05-10']);
  assert.deepEqual(keys(at(2030, 5, 10, 18, 0)), ['rem1:2030-05-10', 'rem2:2030-05-10', 'rem3:2030-05-10']);
  assert.ok(titles(at(2030, 5, 10, 18, 0)).includes('Hoy a las 18:00: Recoger a Hugo'));
});

test('sin hora, a la de los avisos del día (las 9:00); con hora temprana, a su hora', () => {
  assert.deepEqual(keys(at(2030, 5, 10, 7, 29)), []);
  assert.deepEqual(keys(at(2030, 5, 10, 7, 30)), ['rem3:2030-05-10']);
  assert.deepEqual(keys(at(2030, 5, 10, 8, 59)), ['rem3:2030-05-10']);
  assert.deepEqual(keys(at(2030, 5, 10, 9, 0)), ['rem2:2030-05-10', 'rem3:2030-05-10']);
});

test('el día de antelación, el mismo día y el siguiente si sigue pendiente; nada más', () => {
  assert.deepEqual(keys(at(2030, 5, 9, 20, 0)), ['rem2:2030-05-09'], 'un día antes, solo el que avisa con antelación');
  assert.ok(titles(at(2030, 5, 9, 20, 0))[0].startsWith('Mañana: Pagar la ITV'));
  assert.deepEqual(keys(at(2030, 5, 11, 20, 0)), ['rem1:2030-05-11', 'rem2:2030-05-11', 'rem3:2030-05-11']);
  assert.ok(titles(at(2030, 5, 11, 20, 0)).every((t) => t.startsWith('Pendiente: ')));
  assert.deepEqual(keys(at(2030, 5, 8, 20, 0)), [], 'dos días antes, nada');
  assert.deepEqual(keys(at(2030, 5, 12, 20, 0)), [], 'dos días después, nada');
});
