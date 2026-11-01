// Notas al estilo de Joplin: cuadernos (del hogar o privados), notas en Markdown, etiquetas, tareas y papelera.
// Una nota privada solo existe para quien la escribe: todas las consultas filtran por owner_id.
import express from 'express';
import { all, insert, one, run, tx } from '../db.js';
import { bad, forbidden, idParam, notFound, v, validate } from '../util.js';
import { changed, changedPrivate } from '../events.js';
import { RANK } from './household.js';
import { rawUpload, saveUpload } from './attachments.js';
import { buildBackup, lastBackup, markBackup, restoreBackup } from '../notesbackup.js';
import { today } from '../util.js';

const r = express.Router();

const MINE = '(owner_id IS NULL OR owner_id = ?)';
const isEditor = (req) => RANK[req.role] >= RANK.editor;
// Puede escribir en un cuaderno: el suyo privado, o uno del hogar si su rol se lo permite.
const canWrite = (req, book) => (book.owner_id === null ? isEditor(req) : book.owner_id === req.user.id);
const notify = (req, privateNote, action, id) => (privateNote ? changedPrivate(req, 'notes', action, id) : changed(req, 'notes', action, id));

function getBook(req, id) {
  const b = one(`SELECT * FROM note_books WHERE id = ? AND household_id = ? AND ${MINE}`, id, req.hid, req.user.id);
  if (!b) throw notFound('Cuaderno');
  return b;
}
function getNote(req, id) {
  const n = one(`SELECT * FROM notes WHERE id = ? AND household_id = ? AND ${MINE}`, id, req.hid, req.user.id);
  if (!n) throw notFound('Nota');
  return n;
}

// Cada hogar tiene un cuaderno común y cada persona uno privado desde el primer momento.
function ensureDefaults(req) {
  if (!one('SELECT 1 FROM note_books WHERE household_id = ? AND owner_id IS NULL', req.hid)) {
    insert('note_books', { household_id: req.hid, owner_id: null, name: 'Notas de casa', icon: '🏠', sort: 0 });
  }
  if (!one('SELECT 1 FROM note_books WHERE household_id = ? AND owner_id = ?', req.hid, req.user.id)) {
    insert('note_books', { household_id: req.hid, owner_id: req.user.id, name: 'Mis notas', icon: '📓', sort: 0 });
  }
}

// Texto de vista previa: el Markdown sin marcas.
function snippet(body) {
  return String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼 ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '☐ ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

const cleanTags = (tags) => [...new Set((Array.isArray(tags) ? tags : [])
  .map((t) => String(t).trim().replace(/^#/, '').replace(/\s+/g, ' ').slice(0, 30))
  .filter(Boolean).map((t) => t.toLowerCase()))].slice(0, 20);
function setTags(noteId, tags) {
  run('DELETE FROM note_tags WHERE note_id = ?', noteId);
  for (const t of cleanTags(tags)) run('INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)', noteId, t);
}
const tagsOf = (ids) => {
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  for (const t of all(`SELECT note_id, tag FROM note_tags WHERE note_id IN (${ids.map(() => '?').join(',')}) ORDER BY tag`, ...ids)) map.get(t.note_id)?.push(t.tag);
  return map;
};

// Al pasar una nota privada al hogar, sus imágenes privadas pasan a verse también.
function shareImages(req, body) {
  for (const m of String(body).matchAll(/\/attachments\/(\d+)/g)) {
    run('UPDATE attachments SET owner_id = NULL WHERE id = ? AND household_id = ? AND owner_id = ?', Number(m[1]), req.hid, req.user.id);
  }
}

const DUE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
// Con milésimas: dos guardados en el mismo segundo no deben parecer la misma versión.
const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
const noteSpec = {
  book_id: [v.int(), 'Cuaderno'],
  title: [v.str({ max: 200 }), 'Título'],
  body: [v.str({ max: 200000 }), 'Texto'],
  pinned: [v.bool(), 'Fijada'],
  is_todo: [v.bool(), 'Tarea'],
  done: [v.bool(), 'Hecha'],
  due_at: [v.str({ max: 16, pattern: DUE }), 'Fecha'],
};

// ---------- Cuadernos, etiquetas y recuentos ----------
r.get('/meta', (req, res) => {
  ensureDefaults(req);
  const me = req.user.id;
  const books = all(
    `SELECT b.id, b.name, b.icon, b.parent_id, b.sort, b.owner_id IS NOT NULL AS private,
        (SELECT COUNT(*) FROM notes n WHERE n.book_id = b.id AND n.deleted_at IS NULL) AS n
       FROM note_books b WHERE b.household_id = ? AND ${MINE.replace(/owner_id/g, 'b.owner_id')}
      ORDER BY b.owner_id IS NOT NULL, b.sort, norm(b.name)`,
    req.hid, me,
  );
  const tags = all(
    `SELECT t.tag, COUNT(*) AS n FROM note_tags t JOIN notes n ON n.id = t.note_id
      WHERE n.household_id = ? AND ${MINE.replace(/owner_id/g, 'n.owner_id')} AND n.deleted_at IS NULL GROUP BY t.tag ORDER BY t.tag`,
    req.hid, me,
  );
  const c = one(
    `SELECT SUM(deleted_at IS NULL) AS total, SUM(deleted_at IS NULL AND is_todo = 1 AND done_at IS NULL) AS todo,
        SUM(deleted_at IS NOT NULL) AS trash, SUM(deleted_at IS NULL AND owner_id IS NOT NULL) AS private
       FROM notes WHERE household_id = ? AND ${MINE}`,
    req.hid, me,
  );
  res.json({
    books, tags, counts: { total: c.total || 0, todo: c.todo || 0, trash: c.trash || 0, private: c.private || 0 },
    can_share: isEditor(req), last_backup: lastBackup(req),
  });
});

// ---------- Copia de seguridad ----------
// Un .zip con las notas del hogar y las privadas de quien la pide (nunca las privadas de otras personas).
function sendBackup(req, res, { scope, images, password }) {
  const { zip } = buildBackup(req, { scope: ['all', 'private', 'shared'].includes(scope) ? scope : 'all', images, password });
  markBackup(req);
  const name = `notas-${req.household.name}-${today()}${password ? '-protegida' : ''}`.replace(/[^\p{L}\p{N}-]+/gu, '_');
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}.zip"; filename*=UTF-8''${encodeURIComponent(name)}.zip`);
  res.send(zip);
}
r.get('/backup.zip', (req, res) => sendBackup(req, res, { scope: req.query.scope, images: req.query.images !== '0' }));
// Con contraseña se pide por POST: la contraseña no debe ir en la dirección (quedaría en historiales y registros).
r.post('/backup.zip', (req, res) => {
  const d = validate(req.body, {
    scope: [v.oneOf(['all', 'private', 'shared']), 'Qué incluir'],
    images: [v.bool(), 'Imágenes'],
    password: [v.str({ max: 200 }), 'Contraseña'],
  });
  if (!req.body.password || String(req.body.password).length < 10) throw bad('La contraseña tiene que tener al menos 10 caracteres');
  // Se usa tal cual (sin recortar espacios): es la que habrá que escribir para abrirla.
  sendBackup(req, res, { scope: d.scope || 'all', images: d.images !== 0, password: String(req.body.password) });
});

// Restaurar una copia (o un .zip de archivos .md, como los que exporta Joplin). No duplica lo que ya está.
// La contraseña de una copia protegida llega en una cabecera (codificada), nunca en la dirección.
r.post('/restore', express.raw({ type: () => true, limit: '300mb' }), (req, res) => {
  let password = null;
  try {
    password = req.get('x-backup-password') ? decodeURIComponent(req.get('x-backup-password')) : null;
  } catch {
    throw bad('La contraseña no es válida');
  }
  const out = restoreBackup(req, req.body, { canShare: isEditor(req), password });
  if (out.shared) changed(req, 'notes', 'restore');
  if (out.private) changedPrivate(req, 'notes', 'restore');
  res.json(out);
});

const bookSpec = {
  name: [v.str({ required: true, max: 60 }), 'Nombre'],
  icon: [v.emoji(), 'Icono'],
  parent_id: [v.int(), 'Dentro de'],
  private: [v.bool(), 'Privado'],
};

r.post('/books', (req, res) => {
  const d = validate(req.body, bookSpec);
  const priv = d.private !== 0;
  if (!priv && !isEditor(req)) throw forbidden('Tu rol solo permite cuadernos privados');
  if (d.parent_id) {
    const parent = getBook(req, d.parent_id);
    // Un subcuaderno vive en el mismo sitio que su cuaderno (del hogar o privado).
    if ((parent.owner_id !== null) !== priv) throw bad('El subcuaderno tiene que ser igual de privado que su cuaderno');
  }
  const id = insert('note_books', { household_id: req.hid, owner_id: priv ? req.user.id : null, parent_id: d.parent_id ?? null, name: d.name, icon: d.icon || (priv ? '📓' : '📒') });
  notify(req, priv, 'book', id);
  res.status(201).json({ id });
});

r.patch('/books/:id', (req, res) => {
  const b = getBook(req, idParam(req.params.id));
  if (!canWrite(req, b)) throw forbidden();
  const d = validate(req.body, { name: bookSpec.name, icon: bookSpec.icon, parent_id: bookSpec.parent_id }, { partial: true });
  if (d.parent_id) {
    const parent = getBook(req, d.parent_id);
    if (parent.owner_id !== b.owner_id) throw bad('Solo se puede mover dentro de un cuaderno igual de privado');
    // Sin ciclos: el nuevo padre no puede estar dentro de este cuaderno.
    for (let p = parent; p; p = p.parent_id ? one('SELECT * FROM note_books WHERE id = ?', p.parent_id) : null) {
      if (p.id === b.id) throw bad('Un cuaderno no puede ir dentro de sí mismo');
    }
  }
  const sets = Object.keys(d);
  if (sets.length) run(`UPDATE note_books SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...sets.map((k) => d[k] ?? null), b.id);
  notify(req, b.owner_id !== null, 'book', b.id);
  res.json({ id: b.id });
});

// Borrar un cuaderno: sus notas (y las de sus subcuadernos) van a la papelera, guardadas en otro cuaderno del mismo sitio.
r.delete('/books/:id', (req, res) => {
  const b = getBook(req, idParam(req.params.id));
  if (!canWrite(req, b)) throw forbidden();
  const ids = [b.id];
  for (let i = 0; i < ids.length; i++) ids.push(...all('SELECT id FROM note_books WHERE parent_id = ?', ids[i]).map((x) => x.id));
  const same = b.owner_id === null ? 'owner_id IS NULL' : 'owner_id = ?';
  const args = b.owner_id === null ? [] : [b.owner_id];
  tx(() => {
    let fallback = one(`SELECT id FROM note_books WHERE household_id = ? AND ${same} AND id NOT IN (${ids.join(',')}) ORDER BY parent_id IS NOT NULL, sort, id`, req.hid, ...args)?.id;
    if (!fallback) fallback = insert('note_books', { household_id: req.hid, owner_id: b.owner_id, name: b.owner_id === null ? 'Notas de casa' : 'Mis notas', icon: b.owner_id === null ? '🏠' : '📓' });
    run(`UPDATE notes SET book_id = ?, deleted_at = COALESCE(deleted_at, datetime('now')) WHERE book_id IN (${ids.join(',')})`, fallback);
    run('DELETE FROM note_books WHERE id = ?', b.id);
  })();
  notify(req, b.owner_id !== null, 'book', b.id);
  res.json({ ok: true });
});

// ---------- Notas ----------
r.get('/', (req, res) => {
  ensureDefaults(req);
  const me = req.user.id;
  const where = ['n.household_id = ?', MINE.replace(/owner_id/g, 'n.owner_id')];
  const args = [req.hid, me];
  const view = String(req.query.view || 'all');
  where.push(view === 'trash' ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL');
  if (view === 'todo') where.push('n.is_todo = 1');
  if (view === 'private') where.push('n.owner_id IS NOT NULL');
  if (req.query.book) {
    where.push('n.book_id = ?');
    args.push(Number(req.query.book));
  }
  if (req.query.tag) {
    where.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND t.tag = ?)');
    args.push(String(req.query.tag));
  }
  let join = '';
  let snip = 'NULL';
  const joinArgs = [];
  const q = String(req.query.q || '').trim();
  const terms = q.split(/\s+/).map((w) => w.replace(/"/g, '')).filter(Boolean).slice(0, 8);
  if (terms.length) {
    // Cada palabra, como prefijo; las comillas del usuario no rompen la consulta. También vale una etiqueta.
    join = `LEFT JOIN (SELECT rowid AS fid, snippet(notes_fts, 1, char(1), char(2), '…', 14) AS hit FROM notes_fts WHERE notes_fts MATCH ?) f ON f.fid = n.id`;
    joinArgs.push(terms.map((w) => `"${w}"*`).join(' '));
    where.push('(f.fid IS NOT NULL OR EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND t.tag LIKE ?))');
    args.push(`${terms[0]}%`);
    snip = 'f.hit';
  }
  const order = {
    updated: 'n.updated_at DESC',
    created: 'n.created_at DESC',
    title: 'norm(n.title)',
  }[req.query.sort] || 'n.updated_at DESC';
  const todoOrder = view === 'todo' ? 'n.done_at IS NOT NULL, n.due_at IS NULL, n.due_at,' : '';
  const rows = all(
    `SELECT n.id, n.book_id, n.title, n.body, n.pinned, n.is_todo, n.done_at, n.due_at, n.created_at, n.updated_at, n.deleted_at,
        n.owner_id IS NOT NULL AS private, n.owner_id, u.display_name AS updated_by_name, ${snip} AS hit
       FROM notes n ${join} LEFT JOIN users u ON u.id = n.updated_by
      WHERE ${where.join(' AND ')}
      ORDER BY ${view === 'trash' ? 'n.deleted_at DESC' : `n.pinned DESC, ${todoOrder} ${order}`} LIMIT 500`,
    ...joinArgs, ...args,
  );
  const tags = tagsOf(rows.map((x) => x.id));
  const books = new Map(all(`SELECT id, owner_id FROM note_books WHERE household_id = ? AND ${MINE}`, req.hid, me).map((b) => [b.id, b]));
  res.json(rows.map(({ body, owner_id: owner, ...x }) => ({
    ...x, private: owner !== null, snippet: snippet(body), tags: tags.get(x.id), can_edit: canWrite(req, books.get(x.book_id) || { owner_id: owner }),
  })));
});

r.get('/:id', (req, res) => {
  const n = getNote(req, idParam(req.params.id));
  const book = one('SELECT * FROM note_books WHERE id = ?', n.book_id);
  const names = one('SELECT (SELECT display_name FROM users WHERE id = ?) AS created, (SELECT display_name FROM users WHERE id = ?) AS updated', n.created_by, n.updated_by);
  const { owner_id: owner, ...rest } = n;
  res.json({
    ...rest, private: owner !== null, tags: tagsOf([n.id]).get(n.id), can_edit: canWrite(req, book),
    created_by_name: names.created, updated_by_name: names.updated,
  });
});

r.post('/', (req, res) => {
  ensureDefaults(req);
  const d = validate(req.body, noteSpec);
  const book = d.book_id ? getBook(req, d.book_id)
    : one('SELECT * FROM note_books WHERE household_id = ? AND owner_id = ? ORDER BY parent_id IS NOT NULL, sort, id', req.hid, req.user.id);
  if (!canWrite(req, book)) throw forbidden('Tu rol solo permite escribir notas privadas');
  const id = tx(() => {
    const nid = insert('notes', {
      household_id: req.hid, book_id: book.id, owner_id: book.owner_id, title: d.title || '', body: d.body || '', pinned: d.pinned || 0,
      is_todo: d.is_todo || 0, done_at: d.done ? new Date().toISOString() : null, due_at: d.due_at || null, created_by: req.user.id, updated_by: req.user.id,
    });
    run(`UPDATE notes SET updated_at = ${NOW_MS} WHERE id = ?`, nid);
    setTags(nid, req.body.tags);
    return nid;
  })();
  notify(req, book.owner_id !== null, 'create', id);
  res.status(201).json(one('SELECT id, updated_at FROM notes WHERE id = ?', id));
});

r.patch('/:id', (req, res) => {
  const n = getNote(req, idParam(req.params.id));
  const book = one('SELECT * FROM note_books WHERE id = ?', n.book_id);
  if (!canWrite(req, book)) throw forbidden();
  // Otra persona (u otro dispositivo) la ha cambiado desde que se abrió: no se pisa su trabajo.
  if (req.body.base && req.body.base !== n.updated_at && !req.body.force) {
    const cur = one('SELECT n.title, n.body, n.updated_at, u.display_name AS by FROM notes n LEFT JOIN users u ON u.id = n.updated_by WHERE n.id = ?', n.id);
    return res.status(409).json({ error: `${cur.by || 'Alguien'} ha cambiado esta nota mientras la editabas`, conflict: cur });
  }
  const d = validate(req.body, noteSpec, { partial: true });
  const data = {};
  for (const k of ['title', 'body', 'pinned', 'is_todo', 'due_at']) if (k in d) data[k] = d[k] ?? null;
  if ('title' in data && data.title === null) data.title = '';
  if ('body' in data && data.body === null) data.body = '';
  if ('due_at' in data && !data.due_at) data.due_at = null;
  if ('done' in d) data.done_at = d.done ? (n.done_at || new Date().toISOString()) : null;
  let target = book;
  if (d.book_id && d.book_id !== n.book_id) {
    target = getBook(req, d.book_id);
    if (!canWrite(req, target)) throw forbidden('No puedes escribir en ese cuaderno');
    data.book_id = target.id;
    data.owner_id = target.owner_id;
  }
  tx(() => {
    const keys = Object.keys(data);
    run(
      `UPDATE notes SET ${[...keys.map((k) => `${k} = ?`), `updated_at = ${NOW_MS}`, 'updated_by = ?'].join(', ')} WHERE id = ?`,
      ...keys.map((k) => data[k]), req.user.id, n.id,
    );
    if ('tags' in req.body) setTags(n.id, req.body.tags);
    if (book.owner_id !== null && target.owner_id === null) shareImages(req, data.body ?? n.body);
  })();
  // Si pasa de privada a compartida (o al revés), se avisa en los dos ámbitos.
  if (book.owner_id !== target.owner_id) notify(req, book.owner_id !== null, 'update', n.id);
  notify(req, target.owner_id !== null, 'update', n.id);
  res.json(one('SELECT id, updated_at FROM notes WHERE id = ?', n.id));
});

r.post('/:id/trash', (req, res) => {
  const n = getNote(req, idParam(req.params.id));
  if (!canWrite(req, one('SELECT * FROM note_books WHERE id = ?', n.book_id))) throw forbidden();
  run("UPDATE notes SET deleted_at = datetime('now') WHERE id = ?", n.id);
  notify(req, n.owner_id !== null, 'trash', n.id);
  res.json({ ok: true });
});
r.post('/:id/restore', (req, res) => {
  const n = getNote(req, idParam(req.params.id));
  if (!canWrite(req, one('SELECT * FROM note_books WHERE id = ?', n.book_id))) throw forbidden();
  run('UPDATE notes SET deleted_at = NULL WHERE id = ?', n.id);
  notify(req, n.owner_id !== null, 'restore', n.id);
  res.json({ ok: true });
});
// Vaciar la papelera (solo lo que cada uno puede borrar).
r.delete('/trash', (req, res) => {
  const rows = all(`SELECT n.id, n.owner_id, b.owner_id AS bo FROM notes n JOIN note_books b ON b.id = n.book_id
    WHERE n.household_id = ? AND n.deleted_at IS NOT NULL AND ${MINE.replace(/owner_id/g, 'n.owner_id')}`, req.hid, req.user.id);
  const mine = rows.filter((x) => canWrite(req, { owner_id: x.bo }));
  tx(() => mine.forEach((x) => run('DELETE FROM notes WHERE id = ?', x.id)))();
  if (mine.some((x) => x.owner_id === null)) changed(req, 'notes', 'purge');
  if (mine.some((x) => x.owner_id !== null)) changedPrivate(req, 'notes', 'purge');
  res.json({ deleted: mine.length });
});
r.delete('/:id', (req, res) => {
  const n = getNote(req, idParam(req.params.id));
  if (!canWrite(req, one('SELECT * FROM note_books WHERE id = ?', n.book_id))) throw forbidden();
  if (!n.deleted_at) throw bad('Primero hay que mandarla a la papelera');
  run('DELETE FROM notes WHERE id = ?', n.id);
  notify(req, n.owner_id !== null, 'delete', n.id);
  res.json({ ok: true });
});

// Imágenes pegadas o adjuntadas en una nota: privadas si la nota lo es.
r.post('/images', rawUpload, (req, res) => {
  const priv = req.query.private === '1';
  if (!priv && !isEditor(req)) throw forbidden('Tu rol solo permite notas privadas');
  res.status(201).json(saveUpload(req, { owner: priv ? req.user.id : null }));
});

// Lo que está en la papelera más de 30 días se borra solo.
export function purgeOldNotes() {
  run("DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days')");
}

export default r;
