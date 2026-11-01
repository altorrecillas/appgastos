// Registro, inicio de sesión, perfil e invitaciones del usuario.
import express from 'express';
import crypto from 'node:crypto';
import { all, insert, one, run, tx } from '../db.js';
import {
  checkLoginRate, clearLoginFails, createSession, destroySession, hashPassword, recordLoginFail,
  requireAuth, safeJson, verifyPassword,
} from '../auth.js';
import { HttpError, bad, idParam, notFound, v, validate } from '../util.js';
import { addPersonForUser, seedHousehold } from '../seed.js';
import { emit } from '../events.js';

const r = express.Router();
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== 'false';
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

// Hogares del usuario con su rol y cifras rápidas para el selector.
export function householdsOf(userId) {
  return all(
    `SELECT h.id, h.name, h.icon, h.color, h.currency, h.monthly_budget, m.role,
            (SELECT COUNT(*) FROM memberships m2 WHERE m2.household_id = h.id) AS members
       FROM memberships m JOIN households h ON h.id = m.household_id
      WHERE m.user_id = ? ORDER BY h.created_at`,
    userId,
  );
}

function pendingInvitations(userId) {
  return all(
    `SELECT i.id, i.role, i.created_at, h.name AS household_name, h.icon AS household_icon,
            u.display_name AS invited_by_name
       FROM invitations i JOIN households h ON h.id = i.household_id
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.user_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
    userId,
  );
}

const sessionPayload = (user) => ({
  user,
  households: householdsOf(user.id),
  invitations: pendingInvitations(user.id),
});

r.get('/config', (_req, res) => {
  const users = one('SELECT COUNT(*) AS n FROM users').n;
  res.json({ allowRegistration: ALLOW_REGISTRATION || users === 0, firstRun: users === 0 });
});

r.post('/register', async (req, res) => {
  const users = one('SELECT COUNT(*) AS n FROM users').n;
  if (!ALLOW_REGISTRATION && users > 0) throw new HttpError(403, 'El registro está desactivado en este servidor');
  const data = validate(req.body, {
    username: [v.str({ required: true, max: 32 }), 'Usuario'],
    display_name: [v.str({ required: true, max: 40 }), 'Nombre'],
    email: [v.str({ max: 120 }), 'Email'],
    password: [v.str({ required: true, min: 8, max: 200 }), 'Contraseña'],
    color: [v.color(), 'Color'],
    household_name: [v.str({ max: 60 }), 'Nombre del hogar'],
  });
  if (!USERNAME_RE.test(data.username)) throw bad('El usuario solo puede tener letras, números, punto, guion y guion bajo (3-32)');
  if (one('SELECT id FROM users WHERE username = ?', data.username)) throw bad('Ese nombre de usuario ya existe');
  const hash = await hashPassword(data.password);
  const user = tx(() => {
    const id = insert('users', {
      username: data.username,
      display_name: data.display_name,
      email: data.email || null,
      password_hash: hash,
      color: data.color || '#2347C5',
      is_admin: users === 0 ? 1 : 0,
    });
    const u = { id, display_name: data.display_name, color: data.color || '#2347C5' };
    // Todo usuario nuevo arranca con su propio hogar listo para usar.
    const hid = insert('households', { name: data.household_name || `Casa de ${data.display_name}`, created_by: id });
    insert('memberships', { household_id: hid, user_id: id, role: 'owner' });
    seedHousehold(hid, u);
    return u;
  })();
  createSession(req, res, user.id, true);
  res.status(201).json(sessionPayload(userById(user.id)));
});

function userById(id) {
  const u = one('SELECT id, username, display_name, email, color, is_admin, settings, created_at FROM users WHERE id = ?', id);
  return { ...u, is_admin: !!u.is_admin, settings: safeJson(u.settings) };
}

r.post('/login', async (req, res) => {
  const { username, password, remember } = req.body || {};
  if (!username || !password) throw bad('Escribe tu usuario y contraseña');
  const key = `${req.ip}|${String(username).toLowerCase()}`;
  checkLoginRate(key);
  const row = one('SELECT id, password_hash FROM users WHERE username = ?', String(username).trim());
  // Hacemos el hash aunque el usuario no exista para no revelar qué usuarios hay.
  const ok = row
    ? await verifyPassword(String(password), row.password_hash)
    : (await hashPassword(String(password)), false);
  if (!ok) {
    recordLoginFail(key);
    throw new HttpError(401, 'Usuario o contraseña incorrectos');
  }
  clearLoginFails(key);
  createSession(req, res, row.id, remember !== false);
  res.json(sessionPayload(userById(row.id)));
});

r.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

r.get('/me', requireAuth, (req, res) => {
  res.json(sessionPayload(req.user));
});

r.patch('/me', requireAuth, (req, res) => {
  const data = validate(req.body, {
    display_name: [v.str({ required: true, max: 40 }), 'Nombre'],
    email: [v.str({ max: 120 }), 'Email'],
    color: [v.color(), 'Color'],
  }, { partial: true });
  if (req.body.settings && typeof req.body.settings === 'object') {
    const merged = { ...req.user.settings, ...req.body.settings };
    const json = JSON.stringify(merged);
    if (json.length > 4000) throw bad('Preferencias demasiado grandes');
    data.settings = json;
  }
  const cols = Object.keys(data);
  if (cols.length) {
    run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => data[c]), req.user.id);
    if (data.display_name || data.color) {
      // Mantiene sincronizada la "persona" vinculada en cada hogar.
      const p = {};
      if (data.display_name) p.name = data.display_name;
      if (data.color) p.color = data.color;
      const pc = Object.keys(p);
      run(`UPDATE people SET ${pc.map((c) => `${c} = ?`).join(', ')} WHERE user_id = ?`, ...pc.map((c) => p[c]), req.user.id);
    }
  }
  res.json(sessionPayload(userById(req.user.id)));
});

r.post('/password', requireAuth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 8) throw bad('La nueva contraseña debe tener al menos 8 caracteres');
  const row = one('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!(await verifyPassword(String(current || ''), row.password_hash))) throw bad('La contraseña actual no es correcta');
  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(String(next)), req.user.id);
  // Cierra el resto de sesiones abiertas.
  run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user.id, req.sessionId);
  res.json({ ok: true });
});

r.get('/sessions', requireAuth, (req, res) => {
  const rows = all(
    `SELECT id, created_at, last_seen_at, user_agent, ip, expires_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC`,
    req.user.id,
  );
  res.json(rows.map((s) => ({ ...s, id: s.id.slice(0, 12), current: s.id === req.sessionId })));
});

r.post('/sessions/close-others', requireAuth, (req, res) => {
  const n = run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user.id, req.sessionId).changes;
  res.json({ closed: n });
});

r.delete('/me', requireAuth, async (req, res) => {
  const row = one('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!(await verifyPassword(String(req.body?.password || ''), row.password_hash))) throw bad('Contraseña incorrecta');
  tx(() => {
    // Los hogares en los que es el único propietario se borran; en el resto se transfiere la propiedad.
    for (const h of all(`SELECT household_id FROM memberships WHERE user_id = ? AND role = 'owner'`, req.user.id)) {
      const heir = one(
        `SELECT user_id FROM memberships WHERE household_id = ? AND user_id != ?
          ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, joined_at LIMIT 1`,
        h.household_id, req.user.id,
      );
      if (heir) run(`UPDATE memberships SET role = 'owner' WHERE household_id = ? AND user_id = ?`, h.household_id, heir.user_id);
      else run('DELETE FROM households WHERE id = ?', h.household_id);
    }
    run('DELETE FROM users WHERE id = ?', req.user.id);
  })();
  destroySession(req, res);
  res.json({ ok: true });
});

// ----- Invitaciones recibidas -----

r.post('/invitations/:id/:action', requireAuth, (req, res) => {
  const id = idParam(req.params.id);
  const inv = one(`SELECT * FROM invitations WHERE id = ? AND user_id = ? AND status = 'pending'`, id, req.user.id);
  if (!inv) throw notFound('Invitación');
  if (req.params.action === 'accept') {
    tx(() => {
      run(`UPDATE invitations SET status = 'accepted' WHERE id = ?`, id);
      run(`INSERT OR IGNORE INTO memberships (household_id, user_id, role) VALUES (?, ?, ?)`, inv.household_id, req.user.id, inv.role);
      addPersonForUser(inv.household_id, req.user);
      insert('activity', {
        household_id: inv.household_id, user_id: req.user.id, action: 'join', entity: 'members', summary: `${req.user.display_name} se ha unido al hogar`,
      });
    })();
    emit(inv.household_id, { entity: 'members', action: 'join', by: req.user.id, byName: req.user.display_name });
  } else if (req.params.action === 'decline') {
    run(`UPDATE invitations SET status = 'declined' WHERE id = ?`, id);
  } else throw notFound();
  res.json(sessionPayload(req.user));
});

// Unirse con un código de invitación.
r.post('/join', requireAuth, (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) throw bad('Escribe el código de invitación');
  const inv = one(`SELECT * FROM invitations WHERE code = ? AND status = 'pending'`, code);
  if (!inv || (inv.expires_at && new Date(inv.expires_at) < new Date()) || (inv.max_uses && inv.uses >= inv.max_uses)) {
    throw bad('El código no existe o ha caducado');
  }
  if (one('SELECT 1 FROM memberships WHERE household_id = ? AND user_id = ?', inv.household_id, req.user.id)) {
    throw bad('Ya formas parte de ese hogar');
  }
  tx(() => {
    run('UPDATE invitations SET uses = uses + 1 WHERE id = ?', inv.id);
    insert('memberships', { household_id: inv.household_id, user_id: req.user.id, role: inv.role });
    addPersonForUser(inv.household_id, req.user);
    insert('activity', {
      household_id: inv.household_id, user_id: req.user.id, action: 'join', entity: 'members', summary: `${req.user.display_name} se ha unido al hogar con un código`,
    });
  })();
  emit(inv.household_id, { entity: 'members', action: 'join', by: req.user.id, byName: req.user.display_name });
  res.json({ ...sessionPayload(req.user), joined: inv.household_id });
});

export const newInviteCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
};

export default r;
