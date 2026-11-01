// Adjuntos (tickets, facturas en PDF, fotos de mascotas) guardados en disco.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR, insert, one, run } from '../db.js';
import { bad, idParam, notFound } from '../util.js';

const r = express.Router();

const ALLOWED = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'application/pdf': '.pdf',
};
const MAX = 15 * 1024 * 1024;

// Guarda un archivo en disco y lo registra. Con owner (imágenes de una nota privada) solo su dueño podrá abrirlo.
export const MIME_EXT = ALLOWED;
export function storeAttachment(hid, uid, { name, mime, data, owner = null }) {
  if (!ALLOWED[mime]) throw bad('Solo se admiten imágenes (JPG, PNG, WEBP, GIF, HEIC) y PDF');
  if (!Buffer.isBuffer(data) || !data.length) throw bad('El archivo está vacío');
  if (data.length > MAX) throw bad('El archivo es demasiado grande');
  const clean = String(name || 'archivo').replace(/[\\/\0\r\n"]/g, '_').slice(0, 120);
  const stored = `${hid}-${crypto.randomBytes(12).toString('hex')}${ALLOWED[mime]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), data);
  const id = insert('attachments', {
    household_id: hid, name: clean, mime, size: data.length, stored_name: stored, created_by: uid, owner_id: owner,
  });
  return { id, name: clean, mime, size: data.length };
}

export const rawUpload = express.raw({ type: Object.keys(ALLOWED), limit: MAX });
export function saveUpload(req, { owner = null } = {}) {
  let name = 'archivo';
  try {
    name = decodeURIComponent(req.get('x-filename') || 'archivo');
  } catch { /* nombre por defecto */ }
  const mime = (req.get('content-type') || '').split(';')[0].trim();
  return storeAttachment(req.hid, req.user.id, { name, mime, data: req.body, owner });
}

r.post('/', rawUpload, (req, res) => res.status(201).json(saveUpload(req)));

// Un adjunto privado no existe para nadie más que su dueño.
const visible = (req, id) => one(
  'SELECT * FROM attachments WHERE id = ? AND household_id = ? AND (owner_id IS NULL OR owner_id = ?)', id, req.hid, req.user.id,
);

r.get('/:id', (req, res) => {
  const a = visible(req, idParam(req.params.id));
  if (!a) throw notFound('Archivo');
  const file = path.join(UPLOAD_DIR, a.stored_name);
  if (!fs.existsSync(file)) throw notFound('Archivo');
  res.set('Content-Type', a.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  fs.createReadStream(file).pipe(res);
});

r.delete('/:id', (req, res) => {
  const a = visible(req, idParam(req.params.id));
  if (!a) throw notFound('Archivo');
  run('DELETE FROM attachments WHERE id = ?', a.id);
  fs.rm(path.join(UPLOAD_DIR, a.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

export default r;
