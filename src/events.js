// Sincronización en tiempo real entre miembros de un hogar (Server-Sent Events)
// y registro de actividad.
import { insert } from './db.js';

const channels = new Map(); // household_id -> Set<res>

export function subscribe(hid, req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 4000\n\n');
  let set = channels.get(hid);
  if (!set) channels.set(hid, (set = new Set()));
  res.uid = req.user.id; // para avisar solo a su dueño de los cambios privados
  set.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size) channels.delete(hid);
  });
}

export function emit(hid, payload, { to = null } = {}) {
  const set = channels.get(hid);
  if (!set) return;
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) if (to === null || res.uid === to) res.write(msg);
}

// Notifica un cambio a todos los miembros conectados y, si hay resumen, lo guarda en la actividad.
export function changed(req, entity, action, id = null, summary = '') {
  const hid = req.hid;
  if (summary) {
    insert('activity', { household_id: hid, user_id: req.user.id, action, entity, entity_id: id, summary });
  }
  emit(hid, { entity, action, id, by: req.user.id, byName: req.user.display_name, summary });
}

// Cambio en algo privado (una nota privada): solo se entera su dueño (en sus otros dispositivos) y no queda en la actividad.
export function changedPrivate(req, entity, action, id = null) {
  emit(req.hid, { entity, action, id, by: req.user.id }, { to: req.user.id });
}
