// Copia de seguridad del hogar en JSON (exportar e importar con reasignación de ids).
import express from 'express';
import { all, insert, one, run, tx } from '../db.js';
import { bad } from '../util.js';
import { changed } from '../events.js';
import { atLeast } from './household.js';

const r = express.Router();
const FORMAT = 'gastosbyath-backup';
const FORMATS = [FORMAT, 'cuartos-backup']; // también las copias hechas cuando la app se llamaba «Cuartos»

r.get('/export.json', (req, res) => {
  const hid = req.hid;
  const q = (table, extra = '') => all(`SELECT * FROM ${table} WHERE household_id = ? ${extra}`, hid);
  const data = {
    format: FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    household: one('SELECT name, icon, color, currency, monthly_budget, power, income_check FROM households WHERE id = ?', hid),
    people: q('people'),
    categories: q('categories'),
    pets: q('pets'),
    pet_events: q('pet_events'),
    recurring: q('recurring'),
    bills: q('bills'),
    shopping_lists: q('shopping_lists'),
    shopping_items: q('shopping_items'),
    shopping_catalog: q('shopping_catalog'),
    goals: q('goals'),
    goal_moves: q('goal_moves'),
    transactions: q('transactions', 'ORDER BY date, id'),
    reminders: q('reminders'),
    prices: q('prices'),
    appliances: q('appliances'),
    power_usages: q('power_usages'),
    ha_links: q('ha_links'),
    category_rules: q('category_rules'),
    // Notas: las del hogar y solo las privadas de quien exporta (las de los demás no salen de la app).
    note_books: all(
      'SELECT id, parent_id, name, icon, sort, owner_id IS NOT NULL AS private FROM note_books WHERE household_id = ? AND (owner_id IS NULL OR owner_id = ?)',
      hid, req.user.id,
    ),
    notes: all(
      `SELECT id, book_id, title, body, pinned, is_todo, done_at, due_at, created_at, updated_at, deleted_at FROM notes
        WHERE household_id = ? AND (owner_id IS NULL OR owner_id = ?)`,
      hid, req.user.id,
    ),
    note_tags: all(
      'SELECT t.note_id, t.tag FROM note_tags t JOIN notes n ON n.id = t.note_id WHERE n.household_id = ? AND (n.owner_id IS NULL OR n.owner_id = ?)',
      hid, req.user.id,
    ),
  };
  res.set('Content-Disposition', `attachment; filename="gastosbyath-${req.household.name.replace(/[^\w-]+/g, '_')}-${data.exported_at.slice(0, 10)}.json"`);
  res.json(data);
});

// Copia una fila quitando columnas de sistema y reasignando referencias.
function clone(row, drop, remap) {
  const out = {};
  for (const [k, val] of Object.entries(row)) {
    if (drop.includes(k)) continue;
    if (remap[k]) out[k] = val == null ? null : remap[k].get(val) ?? null;
    else out[k] = val;
  }
  return out;
}

r.post('/import.json', atLeast('admin'), (req, res) => {
  const d = req.body;
  if (!d || !FORMATS.includes(d.format)) throw bad('El archivo no es una copia de seguridad de GastosbyATH');
  const hid = req.hid;
  const uid = req.user.id;
  const SYS = ['id', 'household_id', 'created_by', 'checked_by'];
  const counts = {};
  tx(() => {
    const maps = { cat: new Map(), person: new Map(), pet: new Map(), rec: new Map(), bill: new Map(), list: new Map(), goal: new Map(), tx: new Map() };
    // Categorías y personas: se reutilizan las que ya existen con el mismo nombre.
    for (const c of d.categories || []) {
      const existing = one('SELECT id FROM categories WHERE household_id = ? AND kind = ? AND ulower(name) = ulower(?)', hid, c.kind, c.name);
      maps.cat.set(c.id, existing ? existing.id : insert('categories', { ...clone(c, SYS, {}), household_id: hid }));
    }
    for (const p of d.people || []) {
      const existing = one('SELECT id FROM people WHERE household_id = ? AND ulower(name) = ulower(?)', hid, p.name);
      maps.person.set(p.id, existing ? existing.id : insert('people', { ...clone(p, [...SYS, 'user_id', 'photo_id'], {}), household_id: hid }));
    }
    for (const p of d.pets || []) {
      const existing = one('SELECT id FROM pets WHERE household_id = ? AND ulower(name) = ulower(?)', hid, p.name);
      maps.pet.set(p.id, existing ? existing.id : insert('pets', { ...clone(p, [...SYS, 'photo_id'], {}), household_id: hid }));
    }
    const refs = { category_id: maps.cat, person_id: maps.person, pet_id: maps.pet };
    for (const x of d.recurring || []) maps.rec.set(x.id, insert('recurring', { ...clone(x, SYS, refs), household_id: hid, created_by: uid }));
    for (const x of d.bills || []) {
      maps.bill.set(x.id, insert('bills', { ...clone(x, [...SYS, 'attachment_id'], { ...refs, recurring_id: maps.rec }), household_id: hid, created_by: uid }));
    }
    for (const x of d.shopping_lists || []) maps.list.set(x.id, insert('shopping_lists', { ...clone(x, SYS, {}), household_id: hid, created_by: uid }));
    for (const x of d.shopping_items || []) {
      if (!maps.list.has(x.list_id)) continue;
      insert('shopping_items', { ...clone(x, [...SYS, 'client_id'], { list_id: maps.list }), household_id: hid, created_by: uid });
    }
    const catMap = new Map();
    for (const x of d.shopping_catalog || []) {
      run('INSERT OR IGNORE INTO shopping_catalog (household_id, name, section, last_price, times, unit, unit_qty, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        hid, x.name, x.section || '', x.last_price ?? null, x.times || 1, x.unit ?? null, x.unit_qty ?? null, x.note || '');
      catMap.set(x.id, one('SELECT id FROM shopping_catalog WHERE household_id = ? AND name = ?', hid, x.name).id);
    }
    for (const x of d.prices || []) {
      if (!catMap.has(x.product_id)) continue;
      insert('prices', { ...clone(x, SYS, { product_id: catMap }), household_id: hid, created_by: uid });
    }
    for (const x of d.goals || []) maps.goal.set(x.id, insert('goals', { ...clone(x, SYS, {}), household_id: hid }));
    for (const x of d.goal_moves || []) {
      if (!maps.goal.has(x.goal_id)) continue;
      insert('goal_moves', { ...clone(x, SYS, { goal_id: maps.goal }), household_id: hid, created_by: uid });
    }
    for (const x of d.transactions || []) {
      maps.tx.set(x.id, insert('transactions', {
        ...clone(x, [...SYS, 'attachment_id', 'client_id'], { ...refs, recurring_id: maps.rec, bill_id: maps.bill, list_id: maps.list }),
        household_id: hid, created_by: uid,
      }));
    }
    for (const x of d.pet_events || []) {
      if (!maps.pet.has(x.pet_id)) continue;
      insert('pet_events', { ...clone(x, SYS, { pet_id: maps.pet, transaction_id: maps.tx }), household_id: hid, created_by: uid });
    }
    // Consumo de luz: electrodomésticos, usos y ajustes de la tarifa (si el hogar aún no tiene).
    const applMap = new Map();
    for (const x of d.appliances || []) applMap.set(x.id, insert('appliances', { ...clone(x, SYS, {}), household_id: hid }));
    const linkMap = new Map();
    for (const x of d.ha_links || []) {
      // Los enchufes llegan pausados: hay que conectar Home Assistant en el hogar nuevo.
      linkMap.set(x.id, insert('ha_links', { ...clone(x, [...SYS, 'backfilled', 'last_value', 'last_seen'], { appliance_id: applMap }), household_id: hid, enabled: 0 }));
    }
    for (const x of d.power_usages || []) {
      insert('power_usages', { ...clone(x, SYS, { appliance_id: applMap, link_id: linkMap, superseded_by: linkMap }), household_id: hid, created_by: uid });
    }
    if (d.household?.power && one('SELECT power FROM households WHERE id = ?', hid).power === '{}') {
      run('UPDATE households SET power = ? WHERE id = ?', d.household.power, hid);
    }
    if (d.household?.income_check && one('SELECT income_check FROM households WHERE id = ?', hid).income_check === '{}') {
      run('UPDATE households SET income_check = ? WHERE id = ?', d.household.income_check, hid);
    }
    // Reglas de categorías: las del hogar mandan si ya tenía una para el mismo comercio.
    for (const x of d.category_rules || []) {
      if (!maps.cat.has(x.category_id)) continue;
      run('INSERT OR IGNORE INTO category_rules (household_id, kind, pattern, category_id, source, hits) VALUES (?, ?, ?, ?, ?, ?)',
        hid, x.kind, x.pattern, maps.cat.get(x.category_id), x.source === 'manual' ? 'manual' : 'learned', x.hits || 1);
    }
    for (const x of d.reminders || []) {
      insert('reminders', { ...clone(x, SYS, { category_id: maps.cat, person_id: maps.person }), household_id: hid, created_by: uid });
    }
    // Notas: las privadas de la copia pasan a ser privadas de quien la importa.
    const bookMap = new Map();
    const pendingBooks = [...(d.note_books || [])];
    for (let guard = 0; pendingBooks.length && guard < 50; guard++) {
      for (const x of [...pendingBooks]) {
        if (x.parent_id && !bookMap.has(x.parent_id) && pendingBooks.some((y) => y.id === x.parent_id)) continue;
        bookMap.set(x.id, insert('note_books', {
          household_id: hid, owner_id: x.private ? uid : null, parent_id: x.parent_id ? bookMap.get(x.parent_id) ?? null : null,
          name: String(x.name || 'Cuaderno').slice(0, 60), icon: x.icon || '📒', sort: x.sort || 0,
        }));
        pendingBooks.splice(pendingBooks.indexOf(x), 1);
      }
    }
    const noteMap = new Map();
    for (const x of d.notes || []) {
      if (!bookMap.has(x.book_id)) continue;
      const book = one('SELECT owner_id FROM note_books WHERE id = ?', bookMap.get(x.book_id));
      noteMap.set(x.id, insert('notes', {
        ...clone(x, ['id', 'book_id', 'household_id', 'owner_id', 'created_by', 'updated_by'], {}),
        household_id: hid, book_id: bookMap.get(x.book_id), owner_id: book.owner_id, created_by: uid, updated_by: uid,
      }));
    }
    for (const x of d.note_tags || []) {
      if (noteMap.has(x.note_id)) run('INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)', noteMap.get(x.note_id), String(x.tag).slice(0, 30));
    }
    for (const k of ['reminders', 'categories', 'people', 'pets', 'recurring', 'bills', 'shopping_lists', 'goals', 'transactions', 'notes']) counts[k] = (d[k] || []).length;
  }).immediate();
  changed(req, 'household', 'import', hid, `${req.user.display_name} ha importado una copia de seguridad (${counts.transactions} movimientos)`);
  res.json({ ok: true, counts });
});

export default r;
