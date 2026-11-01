// GastosbyATH — servidor de la aplicación de gastos del hogar.
import express from 'express';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, db } from './src/db.js';
import { csrfGuard, loadUser, requireAuth } from './src/auth.js';
import { HttpError } from './src/util.js';
import authRoutes from './src/routes/auth.js';
import householdRoutes, { householdAccess, householdsRouter } from './src/routes/household.js';
import transactionRoutes from './src/routes/transactions.js';
import recurringRoutes, { processDue } from './src/routes/recurring.js';
import billRoutes from './src/routes/bills.js';
import shoppingRoutes from './src/routes/shopping.js';
import petRoutes from './src/routes/pets.js';
import goalRoutes from './src/routes/goals.js';
import attachmentRoutes from './src/routes/attachments.js';
import statsRoutes from './src/routes/stats.js';
import dataRoutes from './src/routes/data.js';
import reminderRoutes from './src/routes/reminders.js';
import priceRoutes from './src/routes/prices.js';
import powerRoutes from './src/routes/power.js';
import haRoutes from './src/routes/ha.js';
import rulesRoutes from './src/routes/rules.js';
import productRoutes from './src/routes/products.js';
import notesRoutes, { purgeOldNotes } from './src/routes/notes.js';
import setupRoutes from './src/routes/setup.js';
import { haScheduler } from './src/ha.js';
import { ensurePrices, powerSettings, syncBaseDays } from './src/power.js';
import { addDays, today } from './src/util.js';
import { VERSION, changelog } from './src/version.js';
import pushRoutes from './src/routes/push.js';
import { pushDigest } from './src/push.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
// Detrás de `tailscale serve` o de un proxy inverso en la misma máquina.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Content-Security-Policy':
      // wasm-unsafe-eval: el lector de tickets (Tesseract) es WebAssembly y se ejecuta en el propio dispositivo.
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
      "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  next();
});

// El flujo de eventos en tiempo real no debe comprimirse (se quedaría en el búfer).
app.use(compression({ filter: (req, res) => !req.path.endsWith('/events') && compression.filter(req, res) }));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const limit = req.path.endsWith('/import.json') ? '60mb' : '2mb';
  express.json({ limit })(req, res, next);
});
app.use('/api', loadUser, csrfGuard);

app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION }));
app.get('/api/changelog', (_req, res) => res.json({ version: VERSION, versions: changelog() }));
app.use('/api/auth', authRoutes);
app.use('/api/households', requireAuth, householdsRouter);
app.use('/api/push', requireAuth, pushRoutes);

const h = express.Router({ mergeParams: true });
h.use('/transactions', transactionRoutes);
h.use('/recurring', recurringRoutes);
h.use('/bills', billRoutes);
h.use('/shopping', shoppingRoutes);
h.use('/pets', petRoutes);
h.use('/goals', goalRoutes);
h.use('/attachments', attachmentRoutes);
h.use('/stats', statsRoutes);
h.use('/data', dataRoutes);
h.use('/reminders', reminderRoutes);
h.use('/prices', priceRoutes);
h.use('/power', powerRoutes);
h.use('/ha', haRoutes);
h.use('/rules', rulesRoutes);
h.use('/products', productRoutes);
h.use('/notes', notesRoutes);
h.use('/setup', setupRoutes);
h.use('/', householdRoutes);
app.use('/api/h/:hid', requireAuth, householdAccess, h);

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Ruta no encontrada')));

const PUBLIC = path.join(ROOT, 'public');
// La página y el service worker llevan la versión de la app: al subirla, el móvil instala el service worker nuevo
// (cambia su contenido) y la app compara su versión con la del servidor para avisar de que hay una nueva.
const versioned = (file, find, put) => fs.readFileSync(path.join(PUBLIC, file), 'utf8').replace(find, put);
const sendIndex = (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(versioned('index.html', '</head>', `  <meta name="app-version" content="${VERSION}">\n</head>`));
};
app.get(['/', '/index.html'], sendIndex);
app.get('/sw.js', (_req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
  res.type('js').send(versioned('sw.js', /const VERSION = '[^']*';/, `const VERSION = 'gastosbyath-${VERSION}';`));
});

// Archivos estáticos: los recursos con versión en la URL se cachean mucho tiempo.
app.use(express.static(PUBLIC, {
  index: false,
  setHeaders(res, file) {
    if (/[\\/](vendor|fonts|icons)[\\/]/.test(file)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    else res.set('Cache-Control', 'no-cache');
  },
}));
// Aplicación de una sola página: cualquier otra ruta devuelve index.html.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  sendIndex(req, res);
});

// Errores → JSON con un mensaje entendible.
app.use((err, req, res, _next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message;
  if (err.type === 'entity.too.large') message = 'El archivo o los datos enviados son demasiado grandes';
  else if (err.type === 'entity.parse.failed') message = 'Los datos enviados no son JSON válido';
  else if (err.code && String(err.code).startsWith('SQLITE_CONSTRAINT')) {
    status = 400;
    message = 'Algún dato no es válido o está repetido';
  } else if (!(err instanceof HttpError) && status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    message = 'Ha fallado algo en el servidor. Inténtalo de nuevo.';
  }
  res.status(status).json({ error: message, ...(err.extra || {}) });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`GastosbyATH escuchando en http://${HOST}:${PORT}`);
});

// Pagos automáticos: se revisan al arrancar y cada hora.
function runScheduler() {
  let pvpc = false;
  for (const { id } of all('SELECT id FROM households')) {
    try {
      processDue(id);
      syncBaseDays(id);
      if (powerSettings(id).tariff === 'pvpc') pvpc = true;
    } catch (e) {
      console.error('Error procesando pagos automáticos del hogar', id, e);
    }
  }
  try {
    purgeOldNotes();
  } catch (e) {
    console.error('Error vaciando la papelera de notas', e);
  }
  // Precios de la luz de hoy y, a partir de las 20:30, de mañana.
  if (pvpc) {
    ensurePrices(today()).catch(() => {});
    if (new Date().getHours() >= 20) ensurePrices(addDays(today(), 1)).catch(() => {});
  }
}
runScheduler();
setInterval(runScheduler, 60 * 60 * 1000).unref();

// Notificaciones push: se revisan cada 15 minutos (cada aviso se envía una vez al día).
const digest = () => pushDigest().catch((e) => console.error('Error enviando notificaciones', e));

// Home Assistant: cada minuto se mira qué hogares toca sincronizar según su intervalo.
setTimeout(() => haScheduler().catch(() => {}), 15 * 1000).unref();
setInterval(() => haScheduler().catch((e) => console.error('Error sincronizando Home Assistant', e)), 60 * 1000).unref();
setTimeout(digest, 20 * 1000).unref();
setInterval(digest, 15 * 60 * 1000).unref();

function shutdown() {
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
