// Sin cobertura: lo que se anota se guarda en el propio dispositivo (IndexedDB) y se envía solo
// en cuanto vuelve la conexión. Cada envío lleva un identificador para que repetirlo no duplique nada.
import { api } from './api.js';

const DB_NAME = 'gastosbyath-offline';
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('queue', mode);
    const r = fn(t.objectStore('queue'));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

// Quién está usando la app (cada envío pertenece a una persona y a un hogar).
let owner = null;
export const setOwner = (userId) => {
  owner = userId;
  changed();
};

const listeners = new Set();
export const onQueueChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
let cache = [];
async function changed() {
  try {
    cache = owner ? (await store('readonly', (s) => s.getAll())).filter((op) => op.user === owner) : [];
  } catch {
    cache = [];
  }
  listeners.forEach((fn) => fn(cache));
}
export const pending = (hid = null) => cache.filter((op) => !hid || op.hid === hid);

// op: { hid, kind, method, path, body, file?, label, amount? }
export async function enqueue(op) {
  await store('readwrite', (s) => s.add({ ...op, user: owner, created: Date.now(), error: null }));
  await changed();
  scheduleFlush(15000);
}
export async function discard(id) {
  await store('readwrite', (s) => s.delete(id));
  await changed();
}
async function save(op) {
  await store('readwrite', (s) => s.put(op));
}

let flushing = null;
// Envía la cola en orden. Si no hay red se para y se reintenta luego; si el servidor rechaza algo
// (por ejemplo, una categoría que ya no existe) se queda apartado con el motivo para revisarlo.
export function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    for (const op of pending()) {
      if (op.error) continue;
      try {
        const body = { ...op.body };
        if (op.file) {
          const a = await api(`/h/${op.hid}/attachments`, {
            method: 'POST', body: op.file,
            headers: { 'Content-Type': op.file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(op.file.name || 'ticket.jpg') },
          });
          body.attachment_id = a.id;
          // El adjunto ya está subido: si lo siguiente falla no se vuelve a subir.
          await save({ ...op, file: null, body });
        }
        await api(`/h/${op.hid}${op.path}`, { method: op.method, body });
        await store('readwrite', (s) => s.delete(op.id));
        sent++;
      } catch (e) {
        if (e.status === 0 || e.status >= 500) break;
        await save({ ...op, error: e.message || 'No se ha podido guardar' });
      }
    }
    await changed();
    if (sent) window.dispatchEvent(new CustomEvent('gastosbyath:synced', { detail: { sent } }));
    if (pending().some((op) => !op.error)) scheduleFlush(30000);
    return sent;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// «Reintentar ahora»: también lo que el servidor rechazó antes (quizá ya se pueda).
export async function retry() {
  for (const op of pending()) if (op.error) await save({ ...op, error: null });
  await changed();
  return flush();
}

let timer = null;
export function scheduleFlush(ms = 1000) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (navigator.onLine !== false && owner) flush().catch(() => {});
  }, ms);
}

window.addEventListener('online', () => scheduleFlush(500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pending().length) scheduleFlush(800);
});

// ¿El fallo es por falta de conexión (y por tanto se puede dejar en la cola)?
export const isOffline = (e) => e?.status === 0;
