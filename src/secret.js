// Cifrado de secretos (como el token de Home Assistant) con una clave propia del servidor.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const KEY_FILE = path.join(DATA_DIR, 'secret.key');
let key;
try {
  key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('clave no válida');
} catch {
  key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('base64'), { mode: 0o600 });
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob || !String(blob).startsWith('v1:')) return null;
  try {
    const raw = Buffer.from(String(blob).slice(3), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
