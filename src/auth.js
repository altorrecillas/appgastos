// Autenticación: contraseñas con scrypt, sesiones opacas en SQLite y cookie httpOnly.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { one, run } from './db.js';
import { HttpError } from './util.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const COOKIE = 'gastosbyath_sid';
// La app se llamaba «Cuartos»: las sesiones abiertas con la cookie antigua siguen valiendo y se pasan a la nueva.
const LEGACY_COOKIE = 'cuartos_sid';
const SESSION_DAYS_REMEMBER = 60;
const SESSION_HOURS_SHORT = 12;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(key, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isSecure = (req) => req.secure || req.get('x-forwarded-proto') === 'https';

export function createSession(req, res, userId, remember) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ms = remember ? SESSION_DAYS_REMEMBER * 864e5 : SESSION_HOURS_SHORT * 36e5;
  const expires = new Date(Date.now() + ms);
  run(
    `INSERT INTO sessions (id, user_id, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, datetime('now'), ?, ?)`,
    sha256(token), userId, expires.toISOString(), (req.get('user-agent') || '').slice(0, 300), req.ip,
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(req),
    path: '/',
    ...(remember ? { expires } : {}),
  });
  run(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, userId);
}

const sessionToken = (req) => {
  const c = parseCookies(req.headers.cookie);
  return c[COOKIE] || c[LEGACY_COOKIE] || null;
};

export function destroySession(req, res) {
  const token = sessionToken(req);
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.clearCookie(LEGACY_COOKIE, { path: '/' });
}

// Carga req.user si hay una sesión válida. Renueva la caducidad de forma deslizante.
export function loadUser(req, res, next) {
  const token = sessionToken(req);
  if (!token) return next();
  const sid = sha256(token);
  const row = one(
    `SELECT s.id AS sid, s.expires_at, s.last_seen_at, s.created_at AS s_created, u.id, u.username, u.display_name,
            u.email, u.color, u.is_admin, u.settings, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    sid,
  );
  if (!row) return next();
  if (new Date(row.expires_at) < new Date()) {
    run('DELETE FROM sessions WHERE id = ?', sid);
    return next();
  }
  // Como mucho una escritura por hora y sesión.
  if (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at + 'Z') > 36e5) {
    run(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`, sid);
  }
  if (!parseCookies(req.headers.cookie)[COOKIE]) {
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/', expires: new Date(row.expires_at) });
    res.clearCookie(LEGACY_COOKIE, { path: '/' });
  }
  req.sessionId = sid;
  req.user = {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    email: row.email,
    color: row.color,
    is_admin: !!row.is_admin,
    settings: safeJson(row.settings),
    created_at: row.created_at,
  };
  next();
}

export const safeJson = (s) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Inicia sesión para continuar'));
  next();
}

// Protección CSRF: las escrituras deben llevar una cabecera propia que un formulario
// de otro origen no puede enviar sin una petición CORS previa (que no permitimos).
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // «cuartos»: pestañas abiertas con la versión anterior de la app hasta que se recarguen.
  if (!['gastosbyath', 'cuartos'].includes(req.get('x-requested-with'))) return next(new HttpError(403, 'Petición rechazada'));
  next();
}

// Limitador sencillo de intentos de inicio de sesión (en memoria).
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILS = 8;

export function checkLoginRate(key) {
  const a = attempts.get(key);
  if (a && a.count >= MAX_FAILS && Date.now() - a.first < WINDOW) {
    const mins = Math.ceil((WINDOW - (Date.now() - a.first)) / 60000);
    throw new HttpError(429, `Demasiados intentos. Vuelve a probar en ${mins} min.`);
  }
}
export function recordLoginFail(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}
export const clearLoginFails = (key) => attempts.delete(key);

setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (now - a.first > WINDOW) attempts.delete(k);
  run(`DELETE FROM sessions WHERE expires_at < ?`, new Date().toISOString());
}, 30 * 60 * 1000).unref();
