// Service worker: la app se abre al momento aunque no haya conexión o el servidor tarde en contestar.
// - La interfaz (página, estilos, módulos, iconos) sale de lo guardado al instalar esta versión. Cada versión nueva trae
//   un service worker nuevo (el servidor pone aquí la versión y la lista), que vuelve a guardarla entera de una vez.
// - Los datos (API) van a la red; si no contesta en unos segundos se enseñan los últimos que se vieron en este
//   dispositivo, y en cuanto llega la respuesta se avisa a la app para que se ponga al día.
const VERSION = 'gastosbyath-dev'; // el servidor pone aquí la versión de la app (package.json) al servirlo
const API_CACHE = 'gastosbyath-api';
const VENDOR_CACHE = 'gastosbyath-vendor-1'; // cambiar el número al actualizar las librerías de /vendor
const SHELL = ['/', '/index.html']; // el servidor pone aquí todo lo que hace falta para abrir la app (server.js)

const SLOW_MS = 2500; // con datos guardados, no se espera más a la red
const GIVE_UP_MS = 15000; // sin nada guardado (o para ponerse al día por detrás), como mucho
const QUIET_MS = 30000; // tras un corte, lo guardado sale al momento durante este rato (o hasta que el servidor conteste)

self.addEventListener('install', (e) => {
  // «reload»: lo que se guarda viene del servidor, no de la caché del navegador (salvo lo que nunca cambia).
  const req = (u) => new Request(u, { cache: /^\/(vendor|fonts)\//.test(u) ? 'default' : 'reload' });
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map(req))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![VERSION, API_CACHE, VENDOR_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Datos que se pueden consultar sin conexión (no el tiempo real, los adjuntos ni las descargas).
const OFFLINE_API = (p) => p.startsWith('/api/') && !/\/(events|attachments\/|export|backup|ha\/live|auth\/sessions)/.test(p);
const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
const wait = (ms) => new Promise((r) => setTimeout(r, ms, null));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/api/health') return e.respondWith(health(e.request));
  if (url.pathname.startsWith('/api/')) {
    if (OFFLINE_API(url.pathname)) e.respondWith(data(e));
    return;
  }
  e.respondWith(shell(e.request, url));
});

// ---------- Interfaz: primero lo guardado ----------
async function shell(req, url) {
  const vendor = url.pathname.startsWith('/vendor/');
  // Cualquier dirección de la app (/, /movimientos…) es la misma página.
  const page = req.mode === 'navigate' && !/\.\w+$/.test(url.pathname);
  const mine = await caches.open(VERSION);
  const hit = (await mine.match(page ? '/index.html' : req)) || (vendor && (await caches.match(req)));
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && !page) {
      const copy = res.clone();
      caches.open(vendor ? VENDOR_CACHE : VERSION).then((c) => c.put(req, copy));
    }
    return res;
  } catch {
    return (page && (await caches.match('/index.html'))) || Response.error();
  }
}

// ---------- Datos: la red, con un límite de espera ----------
let quietUntil = 0; // mientras, el servidor no contesta: lo guardado sale sin esperar
let quietReason = 'offline';
const quiet = (reason) => {
  quietUntil = Date.now() + QUIET_MS;
  quietReason = reason;
};

// La app pregunta esto mientras enseña datos guardados: si contesta, todo vuelve a ir a la red.
function health(req) {
  return fetch(req, { signal: timeout(6000) }).then((res) => {
    if (res.ok) quietUntil = 0;
    return res;
  });
}

// Si tailscale serve u otro proxy contesta que el servidor no está (502-504 sin JSON), es como no tener conexión.
const proxyDown = (res) => [502, 503, 504].includes(res.status) && !(res.headers.get('content-type') || '').includes('json');

function fromNetwork(req) {
  return fetch(req, { signal: timeout(GIVE_UP_MS) }).then((res) => {
    if (proxyDown(res)) throw new Error('El servidor no está');
    quietUntil = 0;
    if (res.ok) {
      const copy = res.clone();
      copy.blob().then((body) => {
        const headers = new Headers(copy.headers);
        headers.set('x-cached-at', String(Date.now()));
        return caches.open(API_CACHE).then((c) => c.put(req, new Response(body, { status: 200, headers })));
      }).catch(() => {});
    }
    return res;
  });
}

async function fromCache(req, reason) {
  const hit = await (await caches.open(API_CACHE)).match(req);
  if (!hit) return null;
  const headers = new Headers(hit.headers);
  headers.set('x-cache-reason', reason);
  return new Response(hit.body, { status: 200, headers });
}

// Sin conexión y sin nada guardado de esto (una pantalla que nunca se abrió en este dispositivo).
const unavailable = () => new Response(JSON.stringify({ error: 'No hay conexión con el servidor y esto aún no se había abierto en este dispositivo.' }), {
  status: 503, headers: { 'content-type': 'application/json', 'x-offline': '1' },
});

// Ha llegado lo nuevo de algo que se enseñó guardado: la app se pone al día.
const fresh = () => self.clients.matchAll({ type: 'window' }).then((list) => list.forEach((c) => c.postMessage({ type: 'api-fresh' })));

async function data(e) {
  const req = e.request;
  if (Date.now() < quietUntil) return (await fromCache(req, quietReason)) || unavailable();
  let settled = false;
  const network = fromNetwork(req).finally(() => (settled = true));
  network.catch(() => {}); // si se enseña lo guardado, que la red falle después da igual
  let res;
  try {
    res = await Promise.race([network, wait(SLOW_MS)]);
  } catch {
    quiet('offline');
    return (await fromCache(req, 'offline')) || unavailable();
  }
  if (res) return res;
  // Tarda: lo guardado ahora y, cuando llegue, lo nuevo.
  const hit = await fromCache(req, 'slow');
  if (hit) {
    if (!settled) quiet('slow');
    e.waitUntil(network.then(fresh, () => {}));
    return hit;
  }
  return network.catch(() => {
    quiet('offline');
    return unavailable();
  });
}

self.addEventListener('message', (e) => {
  if (e.data === 'clear-data') e.waitUntil(caches.delete(API_CACHE));
});

// Notificaciones push: recordatorios de pagos y fechas aunque la app esté cerrada.
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: 'GastosbyATH', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(self.registration.showNotification(data.title || 'GastosbyATH', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-64.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/#/inicio' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin)) {
          c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
