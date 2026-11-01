// Cliente de la API: JSON, cabecera anti-CSRF y errores con mensaje legible.

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let unauthorizedHandler = () => {};
export const onUnauthorized = (fn) => (unauthorizedHandler = fn);

// Estado de la conexión: sin red, o mostrando datos guardados en el dispositivo (los sirve el service worker).
// «slow»: el servidor tarda en contestar (no es que no haya red); se enseña lo guardado mientras.
export const net = { offline: false, cachedAt: null, slow: false };
function setNet(offline, cachedAt = null, slow = false) {
  if (net.offline === offline && net.cachedAt === cachedAt && net.slow === slow) return;
  Object.assign(net, { offline, cachedAt, slow });
  window.dispatchEvent(new CustomEvent('gastosbyath:net', { detail: { ...net } }));
}
// El servidor vuelve a contestar (lo comprueba la app mientras enseña lo guardado).
export const markOnline = () => setNet(false);
const OFFLINE_MSG = 'No hay conexión con el servidor. Comprueba la red o Tailscale.';
// Sin conexión y sin nada guardado: se avisa para que la sección que lo pedía, si aún no enseña nada, lo explique en
// grande (app.js); entonces el error se marca «quiet» y no sale además como aviso suelto.
function unavailable(message) {
  const err = new ApiError(0, message);
  window.dispatchEvent(new CustomEvent('gastosbyath:unavailable', { detail: err }));
  return err;
}

let currentHid = null;
export const setApiHousehold = (hid) => (currentHid = hid);

export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'gastosbyath', ...headers }, credentials: 'same-origin', signal };
  if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    setNet(true, net.cachedAt, net.slow);
    throw unavailable(OFFLINE_MSG);
  }
  // Sin conexión y sin nada guardado de esto: como un fallo de red.
  if (res.headers.get('x-offline')) {
    setNet(true, net.cachedAt, net.slow);
    throw unavailable((await res.json().catch(() => null))?.error || OFFLINE_MSG);
  }
  const cachedAt = res.headers.get('x-cached-at');
  if (cachedAt) setNet(true, Number(cachedAt), res.headers.get('x-cache-reason') === 'slow');
  else setNet(false);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (res.status === 401 && !path.startsWith('/auth/login')) unauthorizedHandler();
  if (!res.ok) throw new ApiError(res.status, data?.error || `Error ${res.status}`, data);
  return data;
}

// Atajo para rutas del hogar activo: hapi('/transactions') → /api/h/7/transactions
export const hapi = (path, opts) => api(`/h/${currentHid}${path}`, opts);
export const hurl = (path) => `/api/h/${currentHid}${path}`;
export const get = (path) => hapi(path);
export const post = (path, body) => hapi(path, { method: 'POST', body: body ?? {} });
export const patch = (path, body) => hapi(path, { method: 'PATCH', body });
export const put = (path, body) => hapi(path, { method: 'PUT', body });
export const del = (path, body) => hapi(path, { method: 'DELETE', body });

// Imagen de una nota: privada (solo la ve quien la sube) si la nota lo es.
export async function uploadNoteImage(file, priv) {
  return hapi(`/notes/images${priv ? '?private=1' : ''}`, {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'imagen') },
  });
}

export async function upload(file) {
  return hapi('/attachments', {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'archivo') },
  });
}
