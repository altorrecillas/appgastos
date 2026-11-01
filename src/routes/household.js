// Hogar compartido: datos generales, miembros, invitaciones, personas, categorías y actividad.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR, all, insert, one, run, tx, update } from '../db.js';
import { HttpError, bad, forbidden, idParam, notFound, v, validate } from '../util.js';
import { changed, emit, subscribe } from '../events.js';
import { householdsOf, newInviteCode } from './auth.js';
import { seedHousehold } from '../seed.js';
import { loadDemo } from '../demo.js';

export const RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 };
export const ROLE_NAMES = { owner: 'propietario', admin: 'administrador', editor: 'editor', viewer: 'lector' };

// Comprueba que el usuario pertenece al hogar de la URL y carga su rol.
export function householdAccess(req, _res, next) {
  const hid = idParam(req.params.hid);
  const m = one(
    `SELECT m.role, h.id, h.name, h.icon, h.color, h.currency, h.monthly_budget, h.tint, h.setup_done, h.income_check, h.created_at
       FROM memberships m JOIN households h ON h.id = m.household_id
      WHERE m.household_id = ? AND m.user_id = ?`,
    hid, req.user.id,
  );
  if (!m) return next(notFound('Hogar'));
  req.hid = hid;
  req.role = m.role;
  req.household = m;
  const readOnly = ['GET', 'HEAD'].includes(req.method);
  const leaving = req.method === 'DELETE' && req.path === `/members/${req.user.id}`;
  // Las notas deciden por su cuenta: un lector puede escribir sus notas privadas (no las del hogar).
  const notes = req.path === '/notes' || req.path.startsWith('/notes/');
  if (!readOnly && m.role === 'viewer' && !leaving && !notes) return next(forbidden('Tu rol en este hogar es de solo lectura'));
  next();
}

export const atLeast = (role) => (req, _res, next) => (RANK[req.role] >= RANK[role] ? next() : next(forbidden()));

// Valida que un id referenciado pertenezca al mismo hogar.
export function ensureRef(table, id, hid, label) {
  if (id === null || id === undefined) return;
  if (!one(`SELECT 1 FROM ${table} WHERE id = ? AND household_id = ?`, id, hid)) throw bad(`${label} no válido`);
}

const r = express.Router();

// Preguntar cada mes el importe de las nóminas que cambian: activado salvo que se quite, a partir del día 1.
export function incomeCheck(household) {
  let c = {};
  try {
    c = JSON.parse(household?.income_check || '{}');
  } catch { /* valores por defecto */ }
  return { enabled: c.enabled !== false, day: Number.isInteger(c.day) && c.day >= 1 && c.day <= 28 ? c.day : 1 };
}

function householdPayload(req) {
  const hid = req.hid;
  const isAdmin = RANK[req.role] >= RANK.admin;
  return {
    household: { ...req.household, income_check: incomeCheck(req.household), role: req.role },
    members: all(
      `SELECT u.id, u.username, u.display_name, u.color, m.role, m.joined_at, COALESCE(json_extract(u.settings, '$.simple'), 0) AS simple,
              (SELECT photo_id FROM people p WHERE p.household_id = m.household_id AND p.user_id = u.id) AS photo_id
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, m.joined_at`,
      hid,
    ),
    people: all('SELECT * FROM people WHERE household_id = ? ORDER BY archived, sort, id', hid),
    categories: all('SELECT * FROM categories WHERE household_id = ? ORDER BY kind, archived, sort, id', hid),
    pets: all(
      `SELECT id, name, species, color, photo_id, archived, birth_date FROM pets WHERE household_id = ? ORDER BY archived, name`,
      hid,
    ),
    invitations: isAdmin
      ? all(
        `SELECT i.id, i.role, i.code, i.status, i.expires_at, i.max_uses, i.uses, i.created_at, u.username, u.display_name
           FROM invitations i LEFT JOIN users u ON u.id = i.user_id
          WHERE i.household_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
        hid,
      ).filter((i) => !i.code || !i.expires_at || new Date(i.expires_at) > new Date())
      : [],
  };
}

r.get('/', (req, res) => res.json(householdPayload(req)));

r.patch('/', atLeast('admin'), (req, res) => {
  const data = validate(req.body, {
    name: [v.str({ required: true, max: 60 }), 'Nombre'],
    icon: [v.emoji(), 'Icono'],
    color: [v.color(), 'Color'],
    currency: [v.oneOf(['EUR', 'USD', 'GBP', 'MXN', 'ARS', 'COP', 'CLP', 'CHF'], { required: true }), 'Moneda'],
    monthly_budget: [v.cents(), 'Presupuesto mensual'],
    tint: [v.bool(), 'Color en toda la aplicación'],
  }, { partial: true });
  const cols = Object.keys(data);
  if (cols.length) run(`UPDATE households SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => data[c]), req.hid);
  Object.assign(req.household, data);
  changed(req, 'household', 'update', req.hid, `${req.user.display_name} ha cambiado los ajustes del hogar`);
  res.json(householdPayload(req));
});

// Nóminas que cambian: si se pregunta cada mes su importe y desde qué día.
r.patch('/income-check', atLeast('admin'), (req, res) => {
  const d = validate(req.body, { enabled: [v.bool(), 'Preguntar cada mes'], day: [v.int({ min: 1, max: 28 }), 'Día'] }, { partial: true });
  const cur = incomeCheck(req.household);
  const next = { enabled: d.enabled === undefined ? cur.enabled : !!d.enabled, day: d.day ?? cur.day };
  req.household.income_check = JSON.stringify(next);
  run('UPDATE households SET income_check = ? WHERE id = ?', req.household.income_check, req.hid);
  changed(req, 'household', 'update', req.hid, `${req.user.display_name} ha cambiado cuándo se preguntan las nóminas`);
  res.json(householdPayload(req));
});

r.delete('/', atLeast('owner'), (req, res) => {
  if (String(req.body?.confirm || '').trim() !== req.household.name) throw bad('Escribe el nombre exacto del hogar para confirmar');
  run('DELETE FROM households WHERE id = ?', req.hid);
  emit(req.hid, { entity: 'household', action: 'delete', by: req.user.id });
  res.json({ households: householdsOf(req.user.id) });
});

// Carga datos de ejemplo para explorar la aplicación.
r.post('/demo', atLeast('admin'), (req, res) => {
  const count = one('SELECT COUNT(*) AS n FROM transactions WHERE household_id = ?', req.hid).n;
  if (count > 0 && !req.body?.force) throw bad('El hogar ya tiene movimientos. Crea un hogar vacío para los datos de ejemplo.');
  tx(() => loadDemo(req.hid, req.user))();
  changed(req, 'household', 'demo', req.hid, `${req.user.display_name} ha cargado datos de ejemplo`);
  res.json(householdPayload(req));
});

// ----- Miembros -----

r.patch('/members/:uid', atLeast('admin'), (req, res) => {
  const uid = idParam(req.params.uid);
  const role = req.body?.role;
  if (!['admin', 'editor', 'viewer'].includes(role)) throw bad('Rol no válido');
  const m = one('SELECT role FROM memberships WHERE household_id = ? AND user_id = ?', req.hid, uid);
  if (!m) throw notFound('Miembro');
  if (m.role === 'owner') throw forbidden('El propietario no puede cambiar de rol. Transfiere antes la propiedad.');
  if (req.role !== 'owner' && m.role === 'admin' && uid !== req.user.id) throw forbidden('Solo el propietario puede cambiar a otro administrador');
  run('UPDATE memberships SET role = ? WHERE household_id = ? AND user_id = ?', role, req.hid, uid);
  changed(req, 'members', 'update', uid, '');
  res.json(householdPayload(req));
});

r.delete('/members/:uid', (req, res) => {
  const uid = idParam(req.params.uid);
  const m = one(
    'SELECT m.role, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? AND m.user_id = ?',
    req.hid, uid,
  );
  if (!m) throw notFound('Miembro');
  const self = uid === req.user.id;
  if (!self && RANK[req.role] < RANK.admin) throw forbidden();
  if (m.role === 'owner') throw forbidden(self ? 'Transfiere la propiedad del hogar antes de salir' : 'No se puede expulsar al propietario');
  if (!self && req.role === 'admin' && m.role === 'admin') throw forbidden('Solo el propietario puede expulsar a un administrador');
  run('DELETE FROM memberships WHERE household_id = ? AND user_id = ?', req.hid, uid);
  run('UPDATE people SET user_id = NULL WHERE household_id = ? AND user_id = ?', req.hid, uid);
  changed(req, 'members', 'remove', uid, self ? `${m.display_name} ha salido del hogar` : `${req.user.display_name} ha quitado a ${m.display_name} del hogar`);
  res.json(self ? { left: true, households: householdsOf(req.user.id) } : householdPayload(req));
});

r.post('/transfer', atLeast('owner'), (req, res) => {
  const uid = idParam(req.body?.user_id);
  if (uid === req.user.id) throw bad('Ya eres el propietario');
  if (!one('SELECT 1 FROM memberships WHERE household_id = ? AND user_id = ?', req.hid, uid)) throw notFound('Miembro');
  tx(() => {
    run(`UPDATE memberships SET role = 'owner' WHERE household_id = ? AND user_id = ?`, req.hid, uid);
    run(`UPDATE memberships SET role = 'admin' WHERE household_id = ? AND user_id = ?`, req.hid, req.user.id);
  })();
  req.role = 'admin';
  changed(req, 'members', 'transfer', uid, `${req.user.display_name} ha transferido la propiedad del hogar`);
  res.json(householdPayload(req));
});

// ----- Invitaciones -----

r.post('/invitations', atLeast('admin'), (req, res) => {
  const username = String(req.body?.username || '').trim();
  const role = req.body?.role || 'editor';
  if (!['admin', 'editor', 'viewer'].includes(role)) throw bad('Rol no válido');
  if (role === 'admin' && req.role !== 'owner') throw forbidden('Solo el propietario puede invitar administradores');
  const user = one('SELECT id, display_name FROM users WHERE username = ?', username);
  if (!user) throw bad(`No existe ningún usuario «${username}». Pídele que se registre o comparte un código de invitación.`);
  if (one('SELECT 1 FROM memberships WHERE household_id = ? AND user_id = ?', req.hid, user.id)) throw bad(`${user.display_name} ya forma parte del hogar`);
  if (one(`SELECT 1 FROM invitations WHERE household_id = ? AND user_id = ? AND status = 'pending'`, req.hid, user.id)) {
    throw bad(`${user.display_name} ya tiene una invitación pendiente`);
  }
  insert('invitations', { household_id: req.hid, user_id: user.id, role, invited_by: req.user.id });
  changed(req, 'members', 'invite', user.id, `${req.user.display_name} ha invitado a ${user.display_name}`);
  res.status(201).json(householdPayload(req));
});

r.post('/invite-codes', atLeast('admin'), (req, res) => {
  const role = req.body?.role || 'editor';
  if (!['editor', 'viewer'].includes(role)) throw bad('Rol no válido para un código');
  const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 90);
  const maxUses = Math.min(Math.max(Number(req.body?.max_uses) || 1, 1), 20);
  const code = newInviteCode();
  insert('invitations', {
    household_id: req.hid, code, role, invited_by: req.user.id, max_uses: maxUses,
    expires_at: new Date(Date.now() + days * 864e5).toISOString(),
  });
  res.status(201).json({ code, ...householdPayload(req) });
});

r.delete('/invitations/:id', atLeast('admin'), (req, res) => {
  const id = idParam(req.params.id);
  const n = run(`UPDATE invitations SET status = 'cancelled' WHERE id = ? AND household_id = ? AND status = 'pending'`, id, req.hid).changes;
  if (!n) throw notFound('Invitación');
  res.json(householdPayload(req));
});

// ----- Personas de la familia -----

const personSpec = {
  name: [v.str({ required: true, max: 40 }), 'Nombre'],
  emoji: [v.emoji(), 'Icono'],
  color: [v.color(), 'Color'],
  archived: [v.bool(), 'Archivada'],
  photo_id: [v.int(), 'Foto'],
};

// La foto tiene que ser una imagen de este hogar; la anterior se borra si nadie más la usa.
export function checkPhoto(hid, photoId) {
  if (photoId === null || photoId === undefined) return;
  const a = one('SELECT mime FROM attachments WHERE id = ? AND household_id = ? AND owner_id IS NULL', photoId, hid);
  if (!a || !a.mime.startsWith('image/')) throw bad('La foto no es válida');
}
export function dropOldPhoto(hid, oldId, newId) {
  if (!oldId || oldId === newId) return;
  const used = one(
    `SELECT 1 FROM transactions WHERE attachment_id = ? UNION SELECT 1 FROM bills WHERE attachment_id = ?
     UNION SELECT 1 FROM pets WHERE photo_id = ? UNION SELECT 1 FROM people WHERE photo_id = ?
     UNION SELECT 1 FROM shopping_catalog WHERE photo_id = ?`,
    oldId, oldId, oldId, oldId, oldId,
  );
  if (used) return;
  const a = one('SELECT stored_name FROM attachments WHERE id = ? AND household_id = ?', oldId, hid);
  if (!a) return;
  run('DELETE FROM attachments WHERE id = ?', oldId);
  fs.rm(path.join(UPLOAD_DIR, a.stored_name), { force: true }, () => {});
}

r.post('/people', (req, res) => {
  const data = validate(req.body, personSpec);
  checkPhoto(req.hid, data.photo_id);
  const sort = one('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM people WHERE household_id = ?', req.hid).n;
  const id = insert('people', { household_id: req.hid, sort, ...data });
  changed(req, 'people', 'create', id, `${req.user.display_name} ha añadido a ${data.name} a la familia`);
  res.status(201).json(householdPayload(req));
});

r.patch('/people/:id', (req, res) => {
  const id = idParam(req.params.id);
  const cur = one('SELECT photo_id FROM people WHERE id = ? AND household_id = ?', id, req.hid);
  if (!cur) throw notFound('Persona');
  const data = validate(req.body, personSpec, { partial: true });
  checkPhoto(req.hid, data.photo_id);
  update('people', id, req.hid, data);
  if ('photo_id' in data) dropOldPhoto(req.hid, cur.photo_id, data.photo_id);
  changed(req, 'people', 'update', id);
  res.json(householdPayload(req));
});

r.delete('/people/:id', (req, res) => {
  const id = idParam(req.params.id);
  const p = one('SELECT name, user_id FROM people WHERE id = ? AND household_id = ?', id, req.hid);
  if (!p) throw notFound('Persona');
  if (p.user_id && one('SELECT 1 FROM memberships WHERE household_id = ? AND user_id = ?', req.hid, p.user_id)) {
    throw bad('Esta persona es un miembro con cuenta. Archívala en lugar de borrarla.');
  }
  run('DELETE FROM people WHERE id = ? AND household_id = ?', id, req.hid);
  changed(req, 'people', 'delete', id, `${req.user.display_name} ha quitado a ${p.name}`);
  res.json(householdPayload(req));
});

// Vista sencilla o letra grande para otro miembro (por ejemplo, los abuelos). Solo cambia cómo ve la app.
r.patch('/members/:uid/prefs', atLeast('admin'), (req, res) => {
  const uid = idParam(req.params.uid);
  if (!one('SELECT 1 FROM memberships WHERE household_id = ? AND user_id = ?', req.hid, uid)) throw notFound('Miembro');
  const d = validate(req.body, {
    simple: [v.bool(), 'Vista sencilla'],
    text: [v.oneOf(['normal', 'large', 'xlarge']), 'Tamaño del texto'],
  }, { partial: true });
  const cur = one('SELECT settings FROM users WHERE id = ?', uid);
  let settings = {};
  try {
    settings = JSON.parse(cur.settings || '{}');
  } catch { /* preferencias dañadas: se empieza de cero */ }
  if ('simple' in d) settings.simple = !!d.simple;
  if (d.text) settings.text = d.text;
  run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(settings), uid);
  // Las preferencias son de la persona, no del hogar: se avisa en todos sus hogares (puede tener otro abierto).
  for (const m of all('SELECT household_id FROM memberships WHERE user_id = ?', uid)) emit(m.household_id, { entity: 'prefs', action: 'update', id: uid, by: req.user.id });
  res.json({ ok: true, settings });
});

// ----- Categorías -----

const categorySpec = {
  kind: [v.oneOf(['expense', 'income'], { required: true }), 'Tipo'],
  name: [v.str({ required: true, max: 40 }), 'Nombre'],
  icon: [v.emoji(), 'Icono'],
  color: [v.color(), 'Color'],
  budget: [v.cents(), 'Presupuesto'],
  archived: [v.bool(), 'Archivada'],
};

r.post('/categories', (req, res) => {
  const data = validate(req.body, categorySpec);
  const sort = one('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM categories WHERE household_id = ? AND kind = ?', req.hid, data.kind).n;
  const id = insert('categories', { household_id: req.hid, sort, ...data });
  changed(req, 'categories', 'create', id, `${req.user.display_name} ha creado la categoría ${data.icon || ''} ${data.name}`);
  res.status(201).json({ id, ...householdPayload(req) });
});

r.patch('/categories/:id', (req, res) => {
  const id = idParam(req.params.id);
  const data = validate(req.body, categorySpec, { partial: true });
  delete data.kind;
  if (!update('categories', id, req.hid, data) && Object.keys(data).length) throw notFound('Categoría');
  changed(req, 'categories', 'update', id);
  res.json(householdPayload(req));
});

r.post('/categories/reorder', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  tx(() => ids.forEach((id, i) => run('UPDATE categories SET sort = ? WHERE id = ? AND household_id = ?', i, id, req.hid)))();
  changed(req, 'categories', 'update');
  res.json(householdPayload(req));
});

r.delete('/categories/:id', (req, res) => {
  const id = idParam(req.params.id);
  const cat = one('SELECT * FROM categories WHERE id = ? AND household_id = ?', id, req.hid);
  if (!cat) throw notFound('Categoría');
  const moveTo = req.body?.move_to ? Number(req.body.move_to) : null;
  if (moveTo) {
    const target = one('SELECT kind FROM categories WHERE id = ? AND household_id = ?', moveTo, req.hid);
    if (!target || target.kind !== cat.kind || moveTo === id) throw bad('Categoría de destino no válida');
  }
  tx(() => {
    for (const t of ['transactions', 'recurring', 'bills']) {
      run(`UPDATE ${t} SET category_id = ? WHERE category_id = ? AND household_id = ?`, moveTo, id, req.hid);
    }
    run('DELETE FROM categories WHERE id = ? AND household_id = ?', id, req.hid);
  })();
  changed(req, 'categories', 'delete', id, `${req.user.display_name} ha borrado la categoría ${cat.name}`);
  res.json(householdPayload(req));
});

// ----- Actividad y tiempo real -----

r.get('/activity', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  res.json(all(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.summary, a.created_at, u.display_name AS user_name, u.color AS user_color
       FROM activity a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.household_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT ?`,
    req.hid, before, limit,
  ));
});

r.get('/events', (req, res) => subscribe(req.hid, req, res));

export default r;

// Router de primer nivel para crear hogares.
export const householdsRouter = express.Router();
householdsRouter.post('/', (req, res) => {
  const data = validate(req.body, {
    name: [v.str({ required: true, max: 60 }), 'Nombre'],
    icon: [v.emoji(), 'Icono'],
    color: [v.color(), 'Color'],
    currency: [v.oneOf(['EUR', 'USD', 'GBP', 'MXN', 'ARS', 'COP', 'CLP', 'CHF']), 'Moneda'],
  });
  if (!data.currency) delete data.currency;
  const count = one('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?', req.user.id).n;
  if (count >= 20) throw new HttpError(400, 'Has alcanzado el máximo de hogares');
  const hid = tx(() => {
    const id = insert('households', { ...data, created_by: req.user.id });
    insert('memberships', { household_id: id, user_id: req.user.id, role: 'owner' });
    seedHousehold(id, req.user);
    return id;
  })();
  res.status(201).json({ id: hid, households: householdsOf(req.user.id) });
});
