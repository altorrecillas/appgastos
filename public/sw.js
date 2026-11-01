// Service worker: la interfaz se abre al instante y funciona sin conexión.
// Los datos (API) van siempre a la red; si no hay, se muestran los últimos que se vieron en este dispositivo.
const VERSION = 'gastosbyath-v18';
const API_CACHE = 'gastosbyath-api';
const VENDOR_CACHE = 'gastosbyath-vendor-1'; // cambiar el número al actualizar las librerías de /vendor
const SHELL = [
  '/', '/index.html', '/css/app.css', '/js/theme.js', '/js/app.js', '/js/api.js', '/js/ui.js', '/js/store.js', '/js/charts.js',
  '/js/forms.js', '/js/brand.js', '/js/offline.js', '/js/bankimport.js', '/js/receipt.js', '/js/ocr.js', '/js/views/dashboard.js', '/js/views/transactions.js', '/js/views/recurring.js', '/js/views/bills.js',
  '/js/views/shopping.js', '/js/views/pets.js', '/js/views/goals.js', '/js/views/budgets.js', '/js/views/analytics.js',
  '/js/views/settings.js', '/js/views/auth.js', '/js/views/reminders.js', '/js/views/prices.js', '/js/views/products.js', '/js/views/pricehistory.js', '/js/views/notes.js', '/js/markdown.js', '/vendor/marked.esm.js', '/vendor/purify.es.js', '/js/gestures.js', '/js/views/power.js', '/js/views/ha.js', '/js/views/recap.js', '/js/insights.js', '/js/setup.js', '/js/tint.js', '/js/prefs.js', '/js/photo.js', '/js/views/simple.js', '/js/actions.js', '/js/push.js', '/icons/sprite.svg?v=5', '/icons/logo.svg', '/vendor/echarts.min.js',
  '/fonts/bricolage-grotesque-latin-standard-normal.woff2', '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (!OFFLINE_API(url.pathname)) return;
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            copy.blob().then((body) => {
              const headers = new Headers(copy.headers);
              headers.set('x-cached-at', String(Date.now()));
              caches.open(API_CACHE).then((c) => c.put(e.request, new Response(body, { status: 200, headers })));
            });
          }
          return res;
        })
        .catch(() => caches.open(API_CACHE).then((c) => c.match(e.request)).then((r) => r || Response.error())),
    );
    return;
  }
  // Librerías grandes (gráficos, hojas de cálculo, lector de tickets): se guardan la primera vez que se usan.
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VENDOR_CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })),
    );
    return;
  }
  // Red primero (para recibir siempre la última versión), caché si no hay conexión.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});

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
