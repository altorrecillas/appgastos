// Alta y baja de dispositivos para recibir notificaciones push.
import express from 'express';
import { all, one, run } from '../db.js';
import { bad } from '../util.js';
import { publicKey, sendToUser } from '../push.js';

const r = express.Router();

r.get('/key', (req, res) => {
  res.json({ publicKey, devices: one('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', req.user.id).n });
});

r.post('/subscribe', (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !/^https:\/\//.test(endpoint) || !keys?.p256dh || !keys?.auth) throw bad('Suscripción no válida');
  run(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    req.user.id, String(endpoint).slice(0, 1000), String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 200),
    (req.get('user-agent') || '').slice(0, 300),
  );
  res.json({ ok: true });
});

r.post('/unsubscribe', (req, res) => {
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(req.body?.endpoint || ''), req.user.id);
  res.json({ ok: true });
});

r.post('/test', async (req, res) => {
  const sent = await sendToUser(req.user.id, {
    title: 'GastosbyATH', body: '¡Listo! Aquí te llegarán los recordatorios de pagos y fechas.', url: '/#/recordatorios',
  });
  if (!sent) throw bad('No hay ningún dispositivo activado para notificaciones');
  res.json({ sent, devices: all('SELECT id FROM push_subscriptions WHERE user_id = ?', req.user.id).length });
});

export default r;
