// Copia de seguridad de las notas: un .zip que se entiende sin la app (Markdown con «front matter», como Joplin)
// y que la app restaura tal cual (notas.json: cuadernos, privacidad, etiquetas, tareas, fechas e imágenes).
// Solo lleva lo que la persona puede ver: las notas del hogar y sus propias notas privadas.
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR, all, insert, one, run, tx } from './db.js';
import { safeJson } from './auth.js';
import { MIME_EXT, storeAttachment } from './routes/attachments.js';
import { createZip, readZip } from './zip.js';

export const FORMAT = 'gastosbyath-notes';
const ATT = /\/api\/h\/\d+\/attachments\/(\d+)/g;
const TOP = { shared: 'Del hogar', private: 'Solo para ti' };
const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' };

// Nombre de archivo válido en Windows, macOS y Linux.
const safeName = (s, max = 80) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, max) || 'Sin título';
const iso = (s) => (s ? (s.includes('T') ? s : `${s.replace(' ', 'T')}Z`) : null);
const yaml = (s) => JSON.stringify(String(s)); // cadena entre comillas dobles: YAML válido

function visibleWhere(scope, alias = '') {
  const o = `${alias}owner_id`;
  if (scope === 'private') return `${o} = ?`;
  if (scope === 'shared') return `${o} IS NULL`;
  return `(${o} IS NULL OR ${o} = ?)`;
}

export function buildBackup(req, { scope = 'all', images = true, password = null } = {}) {
  const hid = req.hid;
  const me = req.user.id;
  const args = scope === 'shared' ? [] : [me];
  const books = all(
    `SELECT id, parent_id, name, icon, sort, owner_id IS NOT NULL AS private FROM note_books
      WHERE household_id = ? AND ${visibleWhere(scope)} ORDER BY owner_id IS NOT NULL, sort, norm(name)`,
    hid, ...args,
  );
  const ids = new Set(books.map((b) => b.id));
  const notes = all(
    `SELECT id, book_id, title, body, pinned, is_todo, done_at, due_at, created_at, updated_at FROM notes
      WHERE household_id = ? AND deleted_at IS NULL AND ${visibleWhere(scope)} ORDER BY id`,
    hid, ...args,
  ).filter((n) => ids.has(n.book_id));
  const tags = new Map();
  for (const t of all(
    `SELECT t.note_id, t.tag FROM note_tags t JOIN notes n ON n.id = t.note_id
      WHERE n.household_id = ? AND n.deleted_at IS NULL AND ${visibleWhere(scope, 'n.')} ORDER BY t.tag`,
    hid, ...args,
  )) {
    if (!tags.has(t.note_id)) tags.set(t.note_id, []);
    tags.get(t.note_id).push(t.tag);
  }

  // Imágenes usadas en las notas (solo las que esta persona puede abrir).
  const resources = new Map();
  if (images) {
    for (const n of notes) {
      for (const m of n.body.matchAll(ATT)) {
        const id = Number(m[1]);
        if (resources.has(id)) continue;
        const a = one('SELECT * FROM attachments WHERE id = ? AND household_id = ? AND (owner_id IS NULL OR owner_id = ?)', id, hid, me);
        if (!a) continue;
        const file = path.join(UPLOAD_DIR, a.stored_name);
        if (!fs.existsSync(file)) continue;
        const ext = MIME_EXT[a.mime] || '';
        const base = safeName(a.name.replace(/\.\w+$/, ''), 40).replace(/\s+/g, '-');
        resources.set(id, { id, name: a.name, mime: a.mime, file: `_recursos/${id}-${base}${ext}`, data: fs.readFileSync(file) });
      }
    }
  }

  // Carpetas: «Del hogar» o «Solo para ti» y, dentro, un cuaderno por carpeta (con sus subcuadernos).
  const byId = new Map(books.map((b) => [b.id, b]));
  const dirOf = new Map();
  const usedDirs = new Map();
  const unique = (parent, name, set) => {
    let n = name;
    for (let i = 2; set.get(parent)?.has(n.toLowerCase()); i++) n = `${name} (${i})`;
    if (!set.has(parent)) set.set(parent, new Set());
    set.get(parent).add(n.toLowerCase());
    return n;
  };
  const dir = (b) => {
    if (dirOf.has(b.id)) return dirOf.get(b.id);
    const parent = b.parent_id && byId.has(b.parent_id) ? dir(byId.get(b.parent_id)) : (b.private ? TOP.private : TOP.shared);
    const d = `${parent}/${unique(parent, safeName(b.name, 60), usedDirs)}`;
    dirOf.set(b.id, d);
    return d;
  };
  const usedFiles = new Map();
  const entries = [];
  for (const n of notes) {
    const folder = dir(byId.get(n.book_id));
    const file = `${folder}/${unique(folder, safeName(n.title), usedFiles)}.md`;
    const up = '../'.repeat(file.split('/').length - 1);
    const body = n.body.replace(ATT, (m, id) => (resources.has(Number(id)) ? `${up}${resources.get(Number(id)).file}` : m));
    const fm = ['---', `title: ${yaml(n.title || 'Sin título')}`, `created: ${iso(n.created_at)}`, `updated: ${iso(n.updated_at)}`];
    const t = tags.get(n.id) || [];
    if (t.length) fm.push('tags:', ...t.map((x) => `  - ${yaml(x)}`));
    if (n.is_todo) fm.push(`completed?: ${n.done_at ? 'yes' : 'no'}`);
    if (n.due_at) fm.push(`due: ${n.due_at.length > 10 ? `${n.due_at}:00` : n.due_at}`);
    if (n.pinned) fm.push('pinned: true');
    fm.push('---', '');
    entries.push({ name: file, data: `${fm.join('\n')}\n${body}\n`, date: new Date(iso(n.updated_at)) });
  }
  for (const r of resources.values()) entries.push({ name: r.file, data: r.data });

  const manifest = {
    format: FORMAT, version: 1, exported_at: new Date().toISOString(), household: req.household.name, exported_by: req.user.display_name, scope,
    books, notes: notes.map((n) => ({ ...n, tags: tags.get(n.id) || [] })),
    resources: [...resources.values()].map(({ data, ...r }) => r),
  };
  const priv = notes.filter((n) => byId.get(n.book_id).private).length;
  const readme = [
    `Copia de seguridad de las notas de «${req.household.name}»`,
    `Hecha por ${req.user.display_name} el ${new Date().toLocaleString('es-ES', { timeZone: process.env.TZ || 'Europe/Madrid' })}.`,
    '',
    `${notes.length} notas (${notes.length - priv} del hogar y ${priv} privadas), ${books.length} cuadernos y ${resources.size} imágenes.`,
    '',
    'Cómo restaurarla: en GastosbyATH, Notas → Copia de seguridad → Restaurar, y elige este .zip tal cual.',
    'Lo que ya esté en la app no se duplica.',
    '',
    'Sin la app: cada nota es un archivo .md (Markdown) que se abre con cualquier editor de texto.',
    'Las carpetas son los cuadernos y las imágenes están en «_recursos».',
    'También se puede importar en Joplin: Archivo → Importar → «MD - Markdown + Front Matter (Directorio)»,',
    'después de descomprimir el .zip.',
    '',
    'notas.json tiene todo lo necesario para restaurarla exactamente (cuadernos, privacidad, etiquetas y tareas).',
    'Guárdala en un sitio seguro: las notas privadas van dentro sin cifrar.',
  ].join('\n');
  const zip = createZip([{ name: 'LEEME.txt', data: readme }, { name: 'notas.json', data: JSON.stringify(manifest, null, 1) }, ...entries]);
  if (!password) return { zip, count: notes.length };
  // Con contraseña, la copia entera va dentro de un único archivo cifrado (AES-256): así ni los títulos
  // ni los nombres de los cuadernos se ven sin la contraseña. Fuera solo queda un LEEME sin datos.
  const outer = [
    'Copia de seguridad de notas de GastosbyATH, protegida con contraseña (cifrado AES-256).',
    `Hecha el ${new Date().toLocaleDateString('es-ES', { timeZone: process.env.TZ || 'Europe/Madrid' })}.`,
    '',
    'Para restaurarla: en GastosbyATH, Notas → Copia de seguridad → Restaurar; la app pedirá la contraseña.',
    '',
    'Para abrirla sin la app: «notas.zip» se abre con la contraseña usando 7-Zip (Windows y Linux),',
    'Keka o The Unarchiver (Mac) o ZArchiver (Android). El explorador de Windows y la utilidad de',
    'archivos del Mac no admiten este cifrado. Dentro está la copia normal, con las notas en Markdown.',
    '',
    'Sin la contraseña no hay forma de abrirla.',
  ].join('\n');
  return { zip: createZip([{ name: 'LEEME.txt', data: outer }, { name: 'notas.zip', data: zip, password }]), count: notes.length };
}

// Anota cuándo hizo cada persona su última copia de las notas de este hogar (se ve en todos sus dispositivos).
export function markBackup(req) {
  const s = safeJson(one('SELECT settings FROM users WHERE id = ?', req.user.id)?.settings);
  s.notes_backup = { ...(s.notes_backup || {}), [req.hid]: new Date().toISOString() };
  run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(s), req.user.id);
}
export const lastBackup = (req) => safeJson(one('SELECT settings FROM users WHERE id = ?', req.user.id)?.settings).notes_backup?.[req.hid] || null;

// ---------- Restaurar ----------
const normBody = (b) => String(b || '').replace(ATT, '/attachments/x').trim();

function findBook(hid, { priv, me, name, parent }) {
  return one(
    `SELECT id FROM note_books WHERE household_id = ? AND ${priv ? 'owner_id = ?' : 'owner_id IS NULL'} AND name = ? AND parent_id IS ?`,
    hid, ...(priv ? [me] : []), name, parent,
  )?.id;
}

// Front matter sencillo (el que escribe esta app y el de Joplin): claves, listas de etiquetas y cadenas entre comillas.
function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let listKey = null;
  const val = (v) => {
    const t = v.trim();
    if (/^".*"$/.test(t)) {
      try {
        return JSON.parse(t);
      } catch { /* sigue */ }
    }
    return t.replace(/^'(.*)'$/, '$1');
  };
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      meta[listKey].push(val(item[1]));
      continue;
    }
    const kv = line.match(/^([\w?]+):\s*(.*)$/);
    if (!kv) continue;
    listKey = null;
    if (kv[2] === '') {
      listKey = kv[1];
      meta[listKey] = [];
    } else if (/^\[.*\]$/.test(kv[2].trim())) meta[kv[1]] = kv[2].trim().slice(1, -1).split(',').map(val).filter(Boolean);
    else meta[kv[1]] = val(kv[2]);
  }
  return { meta, body: text.slice(m[0].length) };
}
const toSqlTime = (v) => {
  const d = v ? new Date(String(v).replace(' ', 'T')) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().replace('T', ' ').replace('Z', '') : null;
};

export function restoreBackup(req, buf, { canShare, password = null }) {
  let entries = readZip(buf, { password });
  // Copia protegida (o un .zip que solo envuelve otra copia): se abre el .zip de dentro.
  const inner = entries.filter((e) => /\.zip$/i.test(e.name));
  if (inner.length === 1 && !entries.some((e) => /(^|\/)notas\.json$/.test(e.name) || /\.(md|markdown)$/i.test(e.name))) {
    entries = readZip(inner[0].data, { password });
  }
  const manifest = entries.find((e) => /(^|\/)notas\.json$/.test(e.name) && e.name.split('/').length <= 2);
  let data = null;
  if (manifest) {
    try {
      data = JSON.parse(manifest.data.toString('utf8'));
    } catch {
      data = null;
    }
  }
  if (data && data.format === FORMAT) return restoreManifest(req, entries, data, manifest.name.replace(/notas\.json$/, ''), { canShare });
  return restoreMarkdown(req, entries, { canShare });
}

function restoreManifest(req, entries, d, prefix, { canShare }) {
  const hid = req.hid;
  const me = req.user.id;
  const files = new Map(entries.map((e) => [e.name, e.data]));
  const out = { notes: 0, books: 0, images: 0, same: 0, renamed: 0, skipped_shared: 0, shared: 0, private: 0 };
  tx(() => {
    // Cuadernos: los padres antes que los hijos; si ya existe uno igual, se aprovecha.
    const bookMap = new Map();
    const skip = new Set();
    const pending = [...(d.books || [])];
    for (let guard = 0; pending.length && guard < 60; guard++) {
      for (const b of [...pending]) {
        if (b.parent_id && pending.some((x) => x.id === b.parent_id)) continue;
        pending.splice(pending.indexOf(b), 1);
        const priv = !!b.private;
        if ((!priv && !canShare) || (b.parent_id && skip.has(b.parent_id))) {
          skip.add(b.id);
          continue;
        }
        const name = String(b.name || 'Cuaderno').slice(0, 60);
        const parent = b.parent_id ? bookMap.get(b.parent_id)?.id ?? null : null;
        let id = findBook(hid, { priv, me, name, parent });
        if (!id) {
          id = insert('note_books', { household_id: hid, owner_id: priv ? me : null, parent_id: parent, name, icon: b.icon || (priv ? '📓' : '📒'), sort: b.sort || 0 });
          out.books++;
        }
        bookMap.set(b.id, { id, priv });
      }
    }
    // Primero se decide qué notas entran (sin duplicar) y después se suben solo las imágenes que hacen falta.
    const todo = [];
    for (const n of d.notes || []) {
      const book = bookMap.get(n.book_id);
      if (!book) {
        out.skipped_shared++;
        continue;
      }
      let title = String(n.title || '').slice(0, 200);
      // Puede haber varias con el mismo título y la misma hora: basta con que una sea igual.
      const twins = all('SELECT body FROM notes WHERE household_id = ? AND book_id = ? AND title = ? AND created_at = ? AND deleted_at IS NULL', hid, book.id, title, n.created_at);
      if (twins.some((t) => normBody(t.body) === normBody(n.body))) {
        out.same++;
        continue;
      }
      if (twins.length) {
        title = `${title} (restaurada)`.slice(0, 200);
        out.renamed++;
      }
      todo.push({ n, book, title });
    }
    const usedBy = new Map(); // imagen → ¿la usa alguna nota del hogar?
    for (const { n, book } of todo) for (const m of String(n.body).matchAll(ATT)) usedBy.set(Number(m[1]), (usedBy.get(Number(m[1])) || false) || !book.priv);
    const resMap = new Map();
    for (const r of d.resources || []) {
      if (!usedBy.has(r.id)) continue;
      const data = files.get(prefix + r.file);
      if (!data || !MIME_EXT[r.mime]) continue;
      const a = storeAttachment(hid, me, { name: r.name, mime: r.mime, data, owner: usedBy.get(r.id) ? null : me });
      resMap.set(r.id, a.id);
      out.images++;
    }
    for (const { n, book, title } of todo) {
      const body = String(n.body || '').replace(ATT, (m, id) => (resMap.has(Number(id)) ? `/api/h/${hid}/attachments/${resMap.get(Number(id))}` : m));
      const id = insert('notes', {
        household_id: hid, book_id: book.id, owner_id: book.priv ? me : null, title, body, pinned: n.pinned ? 1 : 0, is_todo: n.is_todo ? 1 : 0,
        done_at: n.done_at || null, due_at: n.due_at || null, created_by: me, updated_by: me,
        created_at: n.created_at || undefined, updated_at: n.updated_at || undefined,
      });
      for (const t of (n.tags || []).slice(0, 20)) run('INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)', id, String(t).toLowerCase().slice(0, 30));
      out.notes++;
      out[book.priv ? 'private' : 'shared']++;
    }
  })();
  return out;
}

// Un .zip de archivos .md sin notas.json (por ejemplo, una exportación de Joplin «Markdown + Front Matter»).
function restoreMarkdown(req, entries, { canShare }) {
  const hid = req.hid;
  const me = req.user.id;
  const files = new Map(entries.map((e) => [e.name, e.data]));
  const md = entries.filter((e) => /\.(md|markdown)$/i.test(e.name) && !e.name.split('/').some((p) => p.startsWith('.') || p === '__MACOSX'));
  if (!md.length) {
    const e = new Error('En el .zip no hay notas: hace falta una copia de GastosbyATH o archivos .md');
    e.status = 400;
    throw e;
  }
  // Si todo va dentro de una única carpeta raíz, esa carpeta no cuenta como cuaderno.
  const roots = new Set(md.map((e) => (e.name.includes('/') ? e.name.split('/')[0] : '')));
  const strip = roots.size === 1 && !roots.has('') && ![TOP.shared, TOP.private].includes([...roots][0]) ? `${[...roots][0]}/` : '';
  const out = { notes: 0, books: 0, images: 0, same: 0, renamed: 0, skipped_shared: 0, shared: 0, private: 0 };
  tx(() => {
    const defaultBook = one('SELECT id FROM note_books WHERE household_id = ? AND owner_id = ? ORDER BY parent_id IS NOT NULL, sort, id', hid, me)?.id
      ?? insert('note_books', { household_id: hid, owner_id: me, name: 'Mis notas', icon: '📓' });
    const bookFor = new Map();
    const ensure = (folders, priv) => {
      const key = `${priv}|${folders.join('/')}`;
      if (!folders.length) return priv ? defaultBook : null;
      if (bookFor.has(key)) return bookFor.get(key);
      const parent = folders.length > 1 ? ensure(folders.slice(0, -1), priv) : null;
      const name = folders.at(-1).slice(0, 60);
      let id = findBook(hid, { priv, me, name, parent });
      if (!id) {
        id = insert('note_books', { household_id: hid, owner_id: priv ? me : null, parent_id: parent, name, icon: priv ? '📓' : '📒' });
        out.books++;
      }
      bookFor.set(key, id);
      return id;
    };
    const resMap = new Map();
    for (const e of md) {
      const rel = e.name.slice(strip.length);
      const parts = rel.split('/');
      let folders = parts.slice(0, -1).filter((p) => p !== '_resources' && p !== '_recursos');
      let priv = true;
      if (folders[0] === TOP.shared) {
        if (!canShare) {
          out.skipped_shared++;
          continue;
        }
        priv = false;
        folders = folders.slice(1);
      } else if (folders[0] === TOP.private) folders = folders.slice(1);
      const bookId = ensure(folders, priv) ?? defaultBook;
      const text = e.data.toString('utf8').replace(/^﻿/, '');
      const { meta, body: rawBody } = frontMatter(text);
      let body = rawBody;
      let title = typeof meta.title === 'string' && meta.title ? meta.title : '';
      if (!title) {
        const h = body.match(/^#\s+(.+)\r?\n+/);
        if (h) {
          title = h[1].trim();
          body = body.slice(h[0].length);
        } else title = parts.at(-1).replace(/\.(md|markdown)$/i, '');
      }
      title = title.slice(0, 200);
      const created = toSqlTime(meta.created);
      // Imágenes con ruta relativa a la nota: se suben a la app y el enlace pasa a apuntar a ellas.
      const dirOfNote = e.name.split('/').slice(0, -1);
      const LINK = /(!?\[[^\]]*\]\()(<?)([^)\s>]+)(>?)((?:\s+"[^"]*")?\))/g;
      const resolve = (target) => {
        if (/^[a-z]+:/i.test(target) || target.startsWith('/') || target.startsWith('#')) return null;
        let decoded;
        try {
          decoded = decodeURIComponent(target);
        } catch {
          decoded = target;
        }
        const stack = [...dirOfNote];
        for (const seg of decoded.split('/')) {
          if (seg === '..') stack.pop();
          else if (seg && seg !== '.') stack.push(seg);
        }
        const full = stack.join('/');
        const ext = (full.split('.').pop() || '').toLowerCase();
        return files.has(full) && EXT_MIME[ext] ? { full, mime: EXT_MIME[ext] } : null;
      };
      // Para saber si la nota ya está, las imágenes cuentan igual estén donde estén.
      const probe = body.replace(LINK, (m, open, lt, target, gt, close) => (resolve(target) ? `${open}/api/h/0/attachments/0${close}` : m));
      const twins = all(
        `SELECT body FROM notes WHERE household_id = ? AND book_id = ? AND title = ? AND deleted_at IS NULL ${created ? 'AND created_at = ?' : ''}`,
        hid, bookId, title, ...(created ? [created] : []),
      );
      if (twins.some((t) => normBody(t.body) === normBody(probe))) {
        out.same++;
        continue;
      }
      if (twins.length) {
        title = `${title} (restaurada)`.slice(0, 200);
        out.renamed++;
      }
      body = body.replace(LINK, (m, open, lt, target, gt, close) => {
        const r = resolve(target);
        if (!r) return m;
        const key = `${r.full}|${priv}`;
        if (!resMap.has(key)) {
          resMap.set(key, storeAttachment(hid, me, { name: r.full.split('/').pop(), mime: r.mime, data: files.get(r.full), owner: priv ? me : null }).id);
          out.images++;
        }
        return `${open}/api/h/${hid}/attachments/${resMap.get(key)}${close}`;
      });
      const done = String(meta['completed?'] || '').toLowerCase();
      const due = toSqlTime(meta.due);
      const id = insert('notes', {
        household_id: hid, book_id: bookId, owner_id: priv ? me : null, title, body: body.replace(/\s+$/, ''),
        pinned: meta.pinned === 'true' ? 1 : 0, is_todo: done === 'yes' || done === 'no' ? 1 : 0, done_at: done === 'yes' ? new Date().toISOString() : null,
        due_at: due ? (due.slice(11, 16) === '00:00' ? due.slice(0, 10) : `${due.slice(0, 10)}T${due.slice(11, 16)}`) : null,
        created_by: me, updated_by: me, created_at: created || undefined, updated_at: toSqlTime(meta.updated) || undefined,
      });
      const tags = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === 'string' ? meta.tags.split(',') : [];
      for (const t of tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)) run('INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)', id, t.toLowerCase().slice(0, 30));
      out.notes++;
      out[priv ? 'private' : 'shared']++;
    }
  })();
  return out;
}
