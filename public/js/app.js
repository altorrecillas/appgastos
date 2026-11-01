// Arranque, estructura de la aplicación, navegación y sincronización en tiempo real.
import { api, get, net, onUnauthorized } from './api.js';
import { discard, onQueueChange, pending as pendingOps, retry, scheduleFlush, setOwner } from './offline.js';
import { $, $$, debounce, html, icon, money, on, openMenu, promptDialog, raw, relDay, sheet, toast, toastError, closeMenu, focusLater, confirmDialog, withBusy } from './ui.js';
import { can, loadHouse, pickHousehold, pref, setSession, store } from './store.js';
import { disposeCharts, rethemeCharts } from './charts.js';
import { notifyChange, openTxForm, pickTicket } from './forms.js';
import { quickShopping } from './actions.js';
import { haptic } from './gestures.js';
import { LOGO, LOGO_ON_BLUE, NAME, SPOKEN, TAGLINE, WORDMARK } from './brand.js';
import { applyTint, reapplyTint } from './tint.js';
import { avatar } from './photo.js';
import { applyPrefs, isSimple } from './prefs.js';

const ROUTES = {
  inicio: { load: () => import('./views/dashboard.js'), title: 'Inicio' },
  movimientos: { load: () => import('./views/transactions.js'), title: 'Movimientos' },
  compra: { load: () => import('./views/shopping.js'), title: 'Lista de la compra' },
  precios: { load: () => import('./views/prices.js'), title: 'Comparar precios' },
  productos: { load: () => import('./views/products.js'), title: 'Productos' },
  fijos: { load: () => import('./views/recurring.js'), title: 'Pagos fijos y plazos' },
  facturas: { load: () => import('./views/bills.js'), title: 'Facturas' },
  recordatorios: { load: () => import('./views/reminders.js'), title: 'Recordatorios' },
  notas: { load: () => import('./views/notes.js'), title: 'Notas' },
  luz: { load: () => import('./views/power.js'), title: 'Consumo de luz' },
  enchufes: { load: () => import('./views/ha.js'), title: 'Home Assistant' },
  resumen: { load: () => import('./views/recap.js'), title: 'Resumen del mes' },
  presupuestos: { load: () => import('./views/budgets.js'), title: 'Presupuestos' },
  mascotas: { load: () => import('./views/pets.js'), title: 'Mascotas' },
  ahorro: { load: () => import('./views/goals.js'), title: 'Ahorro' },
  analisis: { load: () => import('./views/analytics.js'), title: 'Análisis' },
  ajustes: { load: () => import('./views/settings.js'), title: 'Ajustes' },
};
const NAV = [
  ['inicio', 'Inicio', 'house'],
  ['movimientos', 'Movimientos', 'list-ordered'],
  ['compra', 'Lista de la compra', 'shopping-cart'],
  ['productos', 'Productos', 'package'],
  ['precios', 'Comparar precios', 'store'],
  'sep',
  ['fijos', 'Pagos fijos y plazos', 'repeat'],
  ['facturas', 'Facturas', 'receipt'],
  ['luz', 'Consumo de luz', 'zap'],
  ['enchufes', 'Home Assistant', 'house-plug'],
  ['recordatorios', 'Recordatorios', 'calendar-check'],
  ['notas', 'Notas', 'notebook-pen'],
  ['presupuestos', 'Presupuestos', 'gauge'],
  'sep',
  ['mascotas', 'Mascotas', 'paw-print'],
  ['ahorro', 'Ahorro', 'piggy-bank'],
  ['analisis', 'Análisis', 'chart-pie'],
];


const appEl = document.getElementById('app');
let viewEl = null;
let current = { name: null, cleanups: [], refresh: null, token: 0 };

// ---------- Tema ----------
const media = window.matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(choice = pref('gastosbyath.theme') || 'auto') {
  const dark = choice === 'dark' || (choice === 'auto' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name=theme-color]')?.setAttribute('content', dark ? '#0a0f1d' : '#1d3aa5');
  reapplyTint();
  rethemeCharts();
}
export function setTheme(choice) {
  pref('gastosbyath.theme', choice);
  applyTheme(choice);
}
media.addEventListener?.('change', () => applyTheme());

// ---------- Arranque ----------
async function boot() {
  applyTheme();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // En cuanto el service worker controla la página se guarda lo necesario para abrirla sin conexión.
    navigator.serviceWorker.addEventListener('controllerchange', warmOfflineCache);
  }
  onUnauthorized(() => {
    if (store.me) {
      store.me = null;
      showAuth('Tu sesión ha caducado. Vuelve a entrar.');
    }
  });
  try {
    setSession(await api('/auth/me'));
    await enterApp();
  } catch (e) {
    if (e.status === 401) showAuth();
    else showFatal(e);
  }
}

async function showAuth(notice) {
  closeEvents();
  applyTint(null);
  const mod = await import('./views/auth.js');
  mod.render(appEl, {
    notice,
    onLogin: async (payload) => {
      setSession(payload);
      await enterApp();
    },
  });
}

function showFatal(e) {
  appEl.innerHTML = String(html`<div class="boot"><div class="empty">
    <div class="art">📡</div><h3>No se puede conectar con ${NAME}</h3><p>${e.message}</p>
    <div class="row"><button class="btn primary">Reintentar</button></div></div></div>`);
  $('button', appEl).onclick = () => location.reload();
}

export async function enterApp(preferredHid) {
  pickHousehold(preferredHid);
  if (!store.hid) return showNoHousehold();
  try {
    await loadHouse();
  } catch (e) {
    if (e.status === 404) {
      pref('gastosbyath.hid', null);
      setSession(await api('/auth/me'));
      return enterApp();
    }
    throw e;
  }
  applyPrefs(store.me.settings);
  renderShell();
  setOwner(store.me.id);
  scheduleFlush(1500);
  setTimeout(warmOfflineCache, 2500);
  connectEvents();
  if (!location.hash || location.hash === '#' || location.hash === '#/') history.replaceState(null, '', '#/inicio');
  await route();
  if (store.invitations.length) showInvitations();
}

function showNoHousehold() {
  closeEvents();
  // Contenedor propio: sus escuchadores desaparecen al entrar en la app.
  appEl.innerHTML = '<div id="nohouse"></div>';
  const root = appEl.firstElementChild;
  root.innerHTML = String(html`<div class="auth"><div class="auth-art"><a class="brand" href="#" aria-label="${SPOKEN}">${LOGO_ON_BLUE}${WORDMARK}</a>
    <div class="auth-claim">Un hogar para empezar.</div><div></div></div>
    <div class="auth-side"><div class="auth-card">
      <div><h1>No formas parte de ningún hogar</h1><p class="lead">Crea el tuyo o únete al de tu familia con un código de invitación.</p></div>
      <button class="btn primary lg" data-nh="new">${icon('house-plus')}Crear un hogar</button>
      <button class="btn lg" data-nh="join">${icon('key-round')}Unirme con un código</button>
      ${store.invitations.length ? html`<button class="btn soft lg" data-nh="invites">${icon('mail')}Ver invitaciones (${store.invitations.length})</button>` : ''}
      <button class="btn ghost" data-nh="logout">${icon('log-out')}Cerrar sesión</button>
    </div></div></div>`);
  on(root, 'click', '[data-nh=new]', () => newHousehold());
  on(root, 'click', '[data-nh=join]', () => joinWithCode());
  on(root, 'click', '[data-nh=invites]', () => showInvitations());
  on(root, 'click', '[data-nh=logout]', () => logout());
}

// ---------- Estructura ----------
function renderShell() {
  const h = store.house.household;
  appEl.innerHTML = String(html`
  <div class="app">
    <aside class="sidebar" aria-label="Navegación principal">
      <a class="brand" href="#/inicio" aria-label="${SPOKEN}: inicio">${LOGO}${WORDMARK}</a>
      <button class="house-switch" data-act="houses" data-menu-anchor aria-haspopup="menu">
        <span class="house-icon" style="background:color-mix(in srgb, ${h.color} 16%, var(--surface))"><span class="emoji">${h.icon}</span></span>
        <span class="grow" style="min-width:0"><span class="name ellipsis" style="display:block">${h.name}</span>
          <span class="role">${roleText(h.role)}</span></span>
        ${icon('chevron-down', 'sm')}
      </button>
      ${can('edit') ? html`<button class="quick-add" data-act="add">${icon('plus')}Anotar gasto<kbd>N</kbd></button>
        <button class="btn soft block" data-act="add-income" style="margin:-2px 0 8px">${icon('arrow-down-right')}Anotar ingreso<kbd class="desktop-only" style="font:inherit;font-size:calc(12px * var(--fs));opacity:.6;border:1px solid currentColor;border-radius:5px;padding:0 5px">I</kbd></button>`
        : html`<div style="height:10px"></div>`}
      <nav class="nav">${navLinks()}</nav>
      ${isSimple() ? html`<button class="btn soft block simple-exit" data-act="full-view">${icon('layers')}Ver la app completa</button>` : ''}
      <div class="sidebar-foot">
        <nav class="nav"><a href="#/ajustes" data-nav="ajustes">${icon('settings')}Ajustes</a></nav>
        <button class="me" data-act="me" data-menu-anchor aria-haspopup="menu">
          <span data-me-ava>${meAvatar()}</span>
          <span class="grow" style="min-width:0"><span class="ellipsis" style="display:block;font-weight:600">${store.me.display_name}</span>
          <span class="tiny muted">@${store.me.username}</span></span>${icon('ellipsis', 'sm')}
        </button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn mobile-only" data-act="houses" data-menu-anchor aria-label="Cambiar de hogar"><span class="emoji" style="font-size:calc(20px * var(--fs))">${h.icon}</span></button>
        <div class="grow" style="min-width:0"><h1 id="page-title" class="ellipsis"></h1><div class="sub ellipsis" id="page-sub"></div></div>
        <div class="topbar-actions">
          <span id="page-actions" class="row" style="gap:8px"></span>
          <button class="net-pill" data-act="netinfo" hidden></button>
          <button class="icon-btn desktop-only" data-act="palette" aria-label="Buscar (Ctrl+K)" title="Buscar (Ctrl+K)">${icon('search')}</button>
          <button class="icon-btn" data-act="alerts" data-menu-anchor aria-label="Avisos">${icon('bell')}<span class="dot hidden" id="alert-dot"></span></button>
        </div>
      </header>
      <main id="view" class="content" tabindex="-1"></main>
    </div>
    <nav class="tabbar" aria-label="Navegación">
      <a href="#/inicio" data-nav="inicio">${icon('house')}Inicio</a>
      <a href="#/movimientos" data-nav="movimientos">${icon('list-ordered')}Movimientos</a>
      ${can('edit') ? html`<button class="fab-wrap" data-act="add" aria-label="Anotar gasto"><span class="fab">${icon('plus')}</span></button>` : html`<a href="#/analisis" data-nav="analisis">${icon('chart-pie')}Análisis</a>`}
      <a href="#/compra" data-nav="compra">${icon('shopping-cart')}Compra</a>
      <button data-act="more">${icon('menu')}Más</button>
    </nav>
  </div>`);
  viewEl = $('#view');
  bindShell();
  refreshAlerts();
}

const roleText = (r) => ({ owner: 'Propietario', admin: 'Administrador', editor: 'Editor', viewer: 'Solo lectura' })[r] || r;
// En vista sencilla solo se ve lo esencial (lo demás sigue a un toque en «Vista completa»).
const SIMPLE_NAV = ['inicio', 'compra', 'movimientos'];
const navItems = () => (isSimple() ? NAV.filter((n) => n !== 'sep' && SIMPLE_NAV.includes(n[0])) : NAV);
const navLinks = () => navItems().map((n) => (n === 'sep' ? html`<div class="nav-sep"></div>` : html`<a href="#/${n[0]}" data-nav="${n[0]}">${icon(n[2])}${n[1]}</a>`));

let shellBound = false;
function bindShell() {
  if (shellBound) return;
  shellBound = true;
  // Toque: anotar gasto. Mantener pulsado: menú con todo lo que se puede añadir.
  let pressTimer = null;
  let longPressed = false;
  appEl.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-act=add]');
    if (!b) return;
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      haptic(25);
      // El menú aparece bajo el dedo: se ignora el clic que llega al soltar.
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, true), 900);
      quickMenu();
    }, 450);
  });
  const stopPress = () => clearTimeout(pressTimer);
  appEl.addEventListener('pointerup', stopPress);
  appEl.addEventListener('pointercancel', stopPress);
  appEl.addEventListener('pointerleave', stopPress, true);
  appEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-act=add]')) e.preventDefault();
  });
  on(appEl, 'click', '[data-act=add]', () => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    openTxForm();
  });
  on(appEl, 'click', '[data-act=quick]', () => quickMenu());
  on(appEl, 'click', '[data-act=add-income]', () => openTxForm({ kind: 'income' }));
  on(appEl, 'click', '[data-act=houses]', (e, b) => housesMenu(b));
  on(appEl, 'click', '[data-act=me]', (e, b) => meMenu(b));
  on(appEl, 'click', '[data-act=more]', () => moreSheet());
  on(appEl, 'click', '[data-act=palette]', () => palette());
  on(appEl, 'click', '[data-act=alerts]', (e, b) => alertsMenu(b));
  on(appEl, 'click', '[data-act=netinfo]', () => netSheet());
  on(appEl, 'click', '[data-act=full-view]', () => savePrefs({ simple: false }));
  paintNet();
}

export function quickMenu() {
  if (!can('edit')) return;
  const opts = [
    ['expense', 'Gasto', 'arrow-up-right', 'var(--cobalt)', 'var(--cobalt-soft)'],
    ['ticket', 'Foto del ticket', 'camera', 'var(--cobalt)', 'var(--cobalt-soft)'],
    ['income', 'Ingreso', 'arrow-down-right', 'var(--pine)', 'var(--pine-soft)'],
    ['shop', 'A la compra', 'shopping-cart', '#0e9aa7', 'color-mix(in srgb, #0e9aa7 14%, var(--surface))'],
    ['reminder', 'Recordatorio', 'calendar-check', 'var(--saffron-ink)', 'var(--saffron-soft)'],
    ['price', 'Precio de un producto', 'tag', '#6250d6', 'color-mix(in srgb, #6250d6 14%, var(--surface))'],
    ['bill', 'Factura', 'receipt', '#6250d6', 'color-mix(in srgb, #6250d6 14%, var(--surface))'],
    ['fixed', 'Pago fijo', 'repeat', 'var(--cobalt)', 'var(--cobalt-soft)'],
    ['plan', 'Compra a plazos', 'calendar-clock', 'var(--saffron-ink)', 'var(--saffron-soft)'],
    ['goal', 'Ahorro', 'piggy-bank', 'var(--pine)', 'var(--pine-soft)'],
    ['power', 'Uso de la luz', 'zap', '#b97800', 'var(--saffron-soft)'],
  ];
  const s = sheet({
    title: '¿Qué quieres añadir?',
    body: html`<div class="quick-grid">${opts.map(([k, l, ic, c, soft]) => html`<button type="button" data-q="${k}" style="--c:${c};--c-soft:${soft}">
      <span class="qi">${icon(ic)}</span>${l}</button>`)}</div>`,
  });
  on(s.el, 'click', '[data-q]', (e, b) => {
    s.close();
    haptic(10);
    const go = {
      expense: () => openTxForm(), income: () => openTxForm({ kind: 'income' }), shop: () => quickShopping(),
      ticket: () => pickTicket().then((file) => file && openTxForm({ ticket: file })),
      reminder: () => navigate('#/recordatorios?new=1'), price: () => navigate('#/precios?new=1'), bill: () => navigate('#/facturas?new=1'),
      fixed: () => navigate('#/fijos?new=1'), plan: () => navigate('#/fijos?tab=plazos&new=1'), goal: () => navigate('#/ahorro?new=1'),
      power: () => navigate('#/luz?new=1'),
    }[b.dataset.q];
    go?.();
  });
}

function housesMenu(anchor) {
  const items = [{ cap: 'Tus hogares' }];
  for (const h of store.households) {
    items.push({ label: `${h.icon}  ${h.name}`, checked: h.id === store.hid, onClick: () => switchHousehold(h.id) });
  }
  items.push('sep');
  items.push({ label: 'Crear otro hogar…', icon: 'house-plus', onClick: () => newHousehold() });
  items.push({ label: 'Unirme con un código…', icon: 'key-round', onClick: () => joinWithCode() });
  if (can('admin')) items.push({ label: 'Invitar a alguien…', icon: 'user-plus', onClick: () => navigate('#/ajustes/miembros') });
  if (store.invitations.length) items.push({ label: `Invitaciones pendientes (${store.invitations.length})`, icon: 'mail', onClick: () => showInvitations() });
  openMenu(anchor, items);
}

function meMenu(anchor) {
  const t = pref('gastosbyath.theme') || 'auto';
  openMenu(anchor, [
    { label: 'Mi cuenta', icon: 'user', onClick: () => navigate('#/ajustes/cuenta') },
    { cap: 'Apariencia' },
    { label: 'Automática', icon: 'sun-moon', checked: t === 'auto', onClick: () => setTheme('auto') },
    { label: 'Clara', icon: 'sun', checked: t === 'light', onClick: () => setTheme('light') },
    { label: 'Oscura', icon: 'moon', checked: t === 'dark', onClick: () => setTheme('dark') },
    'sep',
    { label: 'Cerrar sesión', icon: 'log-out', danger: true, onClick: () => logout() },
  ], { align: 'start' });
}

// Secciones de «Más», agrupadas (lo que ya está en la barra de abajo no se repite).
const MORE_GROUPS = [
  ['La compra', 'var(--pine)', ['productos', 'precios']],
  ['Pagos y casa', 'var(--cobalt)', ['fijos', 'facturas', 'presupuestos', 'luz', 'enchufes', 'recordatorios']],
  ['Familia y organización', 'var(--chart-7)', ['notas', 'mascotas', 'ahorro', 'analisis', 'resumen']],
];
const EXTRA_NAV = { resumen: ['resumen', 'Resumen del mes', 'sparkles'] };
const TAB_ROUTES = () => ['inicio', 'movimientos', 'compra', ...(can('edit') ? [] : ['analisis'])];

function moreSheet() {
  const t = pref('gastosbyath.theme') || 'auto';
  const h = store.house.household;
  const here = parseHash().name;
  const navOf = (k) => NAV.find((n) => n !== 'sep' && n[0] === k) || EXTRA_NAV[k];
  const groups = MORE_GROUPS.map(([label, color, keys]) => [label, color, keys.filter((k) => !TAB_ROUTES().includes(k)).map(navOf).filter(Boolean)]);
  const s = sheet({
    title: 'Más',
    className: 'more-sheet',
    body: html`<div class="stack" style="gap:20px">
      <div class="more-me">
        <span class="more-ava">${meAvatar()}</span>
        <span class="grow" style="min-width:0"><b class="ellipsis" style="display:block">${store.me.display_name}</b>
          <span class="ellipsis" style="display:block"><span class="emoji">${h.icon}</span> ${h.name} · ${roleText(h.role)}</span></span>
        <button type="button" class="btn sm" data-act="sw-house" data-menu-anchor>${icon('arrow-left-right', 'sm')}Hogar</button>
      </div>
      ${groups.map(([label, color, items]) => html`<section class="more-group" style="--gc:${color}">
        <h3>${label}</h3>
        <div class="more-grid">${items.map((n) => html`<a class="cat-opt more-tile" href="#/${n[0]}" data-close aria-current="${n[0] === here ? 'page' : 'false'}">
          <span class="mt-ico">${icon(n[2])}</span><span>${n[1]}</span></a>`)}</div>
      </section>`)}
      <a class="more-row" href="#/ajustes" data-close>${icon('settings')}<span class="grow">Ajustes<small>Hogar, familia, categorías, avisos y copias</small></span>${icon('chevron-right', 'sm')}</a>
      <section class="more-group"><h3>Cómo se ve</h3>
        <div class="field"><label>Apariencia</label><div class="segmented block" data-theme-pick>
          <button data-v="auto" aria-pressed="${t === 'auto'}">Automática</button><button data-v="light" aria-pressed="${t === 'light'}">Clara</button>
          <button data-v="dark" aria-pressed="${t === 'dark'}">Oscura</button></div></div>
        ${prefsControls()}
      </section>
      <button type="button" class="btn ghost danger block" data-act="logout">${icon('log-out')}Cerrar sesión</button>
      <div class="brand-foot">${LOGO}${WORDMARK}<span>${TAGLINE}</span></div>
    </div>`,
  });
  on(s.el, 'click', '[data-theme-pick] [data-v]', (e, b) => {
    setTheme(b.dataset.v);
    $$('[data-theme-pick] [data-v]', s.el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
  on(s.el, 'click', '[data-act=sw-house]', (e, b) => housesMenu(b));
  on(s.el, 'click', '[data-act=logout]', () => {
    s.close();
    logout();
  });
  bindPrefsControls(s.el, () => s.close());
}

// ---------- Vista sencilla y tamaño del texto ----------
export function prefsControls() {
  const st = store.me.settings || {};
  return html`<div class="field"><label>Tamaño del texto</label><div class="segmented block" data-text-pick>
      ${[['normal', 'Normal'], ['large', 'Grande'], ['xlarge', 'Muy grande']].map(([v, l]) => html`<button type="button" data-v="${v}" aria-pressed="${(st.text || 'normal') === v}">${l}</button>`)}</div></div>
    <label class="switch"><input type="checkbox" data-simple-pick ${st.simple ? 'checked' : ''}><span class="track"></span>
      <span class="txt">Vista sencilla<small>Botones grandes y solo lo esencial: anotar, la compra y lo que llevamos gastado.</small></span></label>`;
}
export function bindPrefsControls(root, after) {
  on(root, 'click', '[data-text-pick] [data-v]', (e, b) => {
    $$('[data-text-pick] [data-v]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    savePrefs({ text: b.dataset.v });
  });
  on(root, 'change', '[data-simple-pick]', (e, c) => {
    after?.();
    savePrefs({ simple: c.checked });
  });
}
async function savePrefs(patch) {
  store.me.settings = { ...(store.me.settings || {}), ...patch };
  applyPrefs(store.me.settings);
  if ('simple' in patch) {
    renderShell();
    await route();
  }
  try {
    setSession(await api('/auth/me', { method: 'PATCH', body: { settings: patch } }));
  } catch (e) {
    toastError(e);
  }
}

export async function switchHousehold(hid) {
  closeMenu();
  if (hid === store.hid) return;
  pref('gastosbyath.hid', String(hid));
  await enterApp(hid);
  toast(`Ahora estás en ${store.house.household.icon} ${store.house.household.name}`);
}

export async function newHousehold() {
  const name = await promptDialog({ title: 'Crear un hogar', label: 'Nombre', placeholder: 'Casa de la playa, piso de Madrid…', confirm: 'Crear hogar' });
  if (!name?.trim()) return;
  try {
    const r = await api('/households', { method: 'POST', body: { name: name.trim() } });
    store.households = r.households;
    await enterApp(r.id);
    toast('Hogar creado. Ya puedes anotar gastos e invitar a tu familia.');
  } catch (e) {
    toastError(e);
  }
}

export async function joinWithCode() {
  const code = await promptDialog({
    title: 'Unirme a un hogar', label: 'Código de invitación', placeholder: 'Ej.: K7M2QX9A', confirm: 'Unirme',
    hint: 'Pídeselo a quien administra el hogar (Ajustes → Miembros).',
  });
  if (!code?.trim()) return;
  try {
    const r = await api('/auth/join', { method: 'POST', body: { code } });
    setSession(r);
    await enterApp(r.joined);
    toast('¡Bienvenido al hogar!');
  } catch (e) {
    toastError(e);
  }
}

function showInvitations() {
  if (!store.invitations.length) return;
  const s = sheet({
    title: 'Te han invitado',
    size: 'narrow',
    body: html`<div class="rows inset">${store.invitations.map((i) => html`<div class="rowi">
      <span class="cat-dot"><span class="emoji">${i.household_icon}</span></span>
      <span class="main-txt"><span class="title">${i.household_name}</span>
        <span class="meta">${i.invited_by_name || 'Alguien'} te invita como ${roleText(i.role).toLowerCase()}</span></span>
      <span class="row" style="gap:6px"><button class="btn sm" data-dec="${i.id}">Rechazar</button><button class="btn sm primary" data-acc="${i.id}">Aceptar</button></span>
    </div>`)}</div>`,
  });
  const act = async (id, action) => {
    try {
      const r = await api(`/auth/invitations/${id}/${action}`, { method: 'POST', body: {} });
      setSession(r);
      s.close();
      if (action === 'accept') {
        const inv = r.households.at(-1);
        await enterApp(inv?.id);
        toast('Te has unido al hogar');
      } else if (!store.hid) showNoHousehold();
      else refreshAlerts();
    } catch (e) {
      toastError(e);
    }
  };
  on(s.el, 'click', '[data-acc]', (e, b) => act(b.dataset.acc, 'accept'));
  on(s.el, 'click', '[data-dec]', (e, b) => act(b.dataset.dec, 'decline'));
}

export async function logout() {
  const waiting = pendingOps().length;
  if (waiting && !(await confirmDialog({
    title: '¿Cerrar sesión sin enviar lo pendiente?',
    text: `Hay ${waiting === 1 ? 'una cosa anotada' : `${waiting} cosas anotadas`} sin conexión que aún no han llegado al servidor. Si cierras la sesión ahora se perderán.`,
    confirm: 'Cerrar sesión igualmente', danger: true,
  }))) return;
  for (const op of pendingOps()) await discard(op.id).catch(() => {});
  // Los datos guardados para verlos sin conexión no se quedan en el dispositivo.
  window.caches?.delete('gastosbyath-api').catch(() => {});
  setOwner(null);
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } catch { /* da igual */ }
  store.me = null;
  store.house = null;
  closeEvents();
  history.replaceState(null, '', '#/');
  showAuth();
}

// Tu avatar en la barra lateral: tu foto en este hogar o tus iniciales.
function meAvatar() {
  const mine = store.house?.people.find((p) => p.user_id === store.me?.id);
  return avatar({ photo_id: mine?.photo_id, display_name: store.me.display_name, color: store.me.color });
}
window.addEventListener('gastosbyath:changed', (e) => {
  if (['people', 'household'].includes(e.detail?.entity)) {
    const el = document.querySelector('[data-me-ava]');
    if (el) el.innerHTML = String(meAvatar());
  }
});

// ---------- Conexión y cola sin conexión ----------
function warmOfflineCache() {
  if (!store.me || !navigator.serviceWorker?.controller) return;
  const urls = ['/auth/me', ...(store.hid ? [`/h/${store.hid}`, `/h/${store.hid}/shopping/lists`, `/h/${store.hid}/shopping/sections`] : [])];
  urls.forEach((u) => api(u).catch(() => {}));
}
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
function paintNet() {
  const pill = document.querySelector('[data-act=netinfo]');
  if (!pill) return;
  const ops = pendingOps(store.hid);
  const failed = ops.filter((op) => op.error).length;
  let state = null;
  let label = '';
  if (failed) [state, label] = ['err', `${failed} sin enviar`];
  else if (net.offline) [state, label] = ['off', ops.length ? `Sin conexión · ${ops.length}` : 'Sin conexión'];
  else if (ops.length) [state, label] = ['sync', `Enviando ${ops.length}…`];
  pill.hidden = !state;
  if (!state) return;
  pill.dataset.state = state;
  pill.title = net.offline && net.cachedAt ? `Mostrando lo guardado a las ${fmtTime(net.cachedAt)}` : label;
  pill.innerHTML = String(html`${icon(state === 'sync' ? 'refresh-cw' : 'cloud-off', 'sm')}<span>${label}</span>`);
}
window.addEventListener('gastosbyath:net', (e) => {
  paintNet();
  // Vuelve la red: se envía lo pendiente y se recargan los datos (lo que se veía era lo guardado).
  if (!e.detail.offline) {
    scheduleFlush(300);
    refreshCurrent({ entity: 'online' });
  }
});
onQueueChange(() => paintNet());
window.addEventListener('gastosbyath:synced', (e) => {
  const n = e.detail.sent;
  toast(`Enviado lo anotado sin conexión (${n})`, { iconName: 'check-check' });
  refreshCurrent({ entity: 'sync' });
});

function netSheet() {
  const draw = () => {
    const ops = pendingOps(store.hid);
    return html`<div class="stack" style="gap:14px">
      <div class="net-state ${net.offline ? 'off' : 'on'}">${icon(net.offline ? 'cloud-off' : 'wifi')}
        <div><b>${net.offline ? 'Sin conexión' : 'Conectado'}</b>
          <span class="small muted">${net.offline
            ? (net.cachedAt ? `Ves lo que se cargó por última vez a las ${fmtTime(net.cachedAt)}. ` : '') + 'Puedes seguir anotando gastos y usando la lista de la compra: se envía solo al volver la cobertura.'
            : ops.length ? 'Enviando lo que se anotó sin conexión…' : 'Todo está al día.'}</span></div></div>
      ${ops.length ? html`<div class="rows">${ops.map((op) => html`<div class="rowi">
        <span class="cat-dot sm" style="--c:${op.error ? 'var(--granada)' : 'var(--saffron)'}">${icon(op.kind === 'tx' ? (op.file ? 'camera' : 'receipt') : 'shopping-cart', 'sm')}</span>
        <span class="main-txt"><span class="title">${op.label}</span>
          <span class="meta">${op.error ? html`<span style="color:var(--granada)">${op.error}</span>` : `Anotado a las ${fmtTime(op.created)}`}</span></span>
        ${op.amount ? html`<span class="amount">${money(op.amount)}</span>` : ''}
        <button class="btn ghost sm icon-only" data-discard="${op.id}" aria-label="Descartar">${icon('trash-2', 'sm')}</button></div>`)}</div>`
        : html`<p class="small muted">No hay nada pendiente de enviar.</p>`}
    </div>`;
  };
  const s = sheet({
    title: 'Conexión',
    size: 'narrow',
    body: draw(),
    foot: html`<span class="spacer"></span><button class="btn" data-close>Cerrar</button>
      ${pendingOps(store.hid).length ? html`<button class="btn primary" data-act="retry">${icon('refresh-cw')}Reintentar ahora</button>` : ''}`,
  });
  const repaint = () => s.el.isConnected && (s.el.querySelector('.sheet-body').innerHTML = String(draw()));
  const off = onQueueChange(repaint);
  s.done.then(off);
  on(s.el, 'click', '[data-discard]', async (e, b) => {
    if (!(await confirmDialog({ title: '¿Descartar?', text: 'No se enviará y se perderá.', confirm: 'Descartar', danger: true }))) return;
    await discard(Number(b.dataset.discard));
    refreshCurrent({ entity: 'sync' });
  });
  on(s.el, 'click', '[data-act=retry]', (e, b) => withBusy(b, async () => {
    const sent = await retry();
    if (!sent && net.offline) toast('Sigue sin haber conexión', { iconName: 'cloud-off' });
  }));
}

// ---------- Avisos ----------
let lastAlerts = null;
async function refreshAlerts() {
  try {
    const [alerts, insights] = await Promise.all([get('/stats/alerts'), get('/stats/insights').catch(() => [])]);
    lastAlerts = { ...alerts, insights };
    const dot = $('#alert-dot');
    const n = lastAlerts.count + store.invitations.length + insights.filter((x) => x.tone === 'warn').length;
    if (dot) {
      dot.textContent = n > 9 ? '9+' : String(n);
      dot.classList.toggle('hidden', !n);
    }
  } catch { /* sin avisos */ }
}
const refreshAlertsSoon = debounce(refreshAlerts, 800);
window.addEventListener('gastosbyath:alerts', () => refreshAlertsSoon());

function alertsMenu(anchor) {
  const a = lastAlerts || { items: [], over: [] };
  const typeIcon = { recurring: 'repeat', installment: 'calendar-clock', bill: 'receipt', pet: 'paw-print', reminder: 'calendar-check' };
  const link = (it) => (it.type === 'bill' ? '#/facturas' : it.type === 'pet' ? `#/mascotas/${it.id}` : it.type === 'installment' ? '#/fijos?tab=plazos' : it.type === 'reminder' ? '#/recordatorios' : '#/fijos');
  const rows = [
    ...(a.insights || []).filter((x) => x.tone !== 'good').map((x) => html`<a class="notif-item" href="${x.url || '#/inicio'}">
      <span class="in-ico sm ${x.tone}">${icon(x.icon || 'info', 'sm')}</span>
      <span class="grow" style="min-width:0"><b>${x.title}</b><br><span class="small muted">${x.text}</span></span></a>`),
    ...store.invitations.map((i) => html`<button class="notif-item" data-inv style="width:100%;border:0;background:none;text-align:left">
      <span class="cat-dot sm"><span class="emoji">${i.household_icon}</span></span>
      <span class="grow"><b>Invitación a ${i.household_name}</b><br><span class="small muted">De ${i.invited_by_name || 'alguien'}</span></span></button>`),
    ...a.over.map((c) => html`<a class="notif-item" href="#/presupuestos">
      <span class="cat-dot sm"><span class="emoji">${c.icon}</span></span>
      <span class="grow"><b>${c.name}</b> ha superado su presupuesto<br><span class="small neg">${money(c.total)} de ${money(c.budget)}</span></span></a>`),
    ...a.items.map((it) => html`<a class="notif-item" href="${link(it)}">
      <span class="tl-item" style="padding:0"><span class="ico ${it.type}">${icon(typeIcon[it.type] || 'clock')}</span></span>
      <span class="grow" style="min-width:0"><span class="ellipsis" style="display:block;font-weight:580">${it.title}</span>
        <span class="small ${it.overdue ? 'neg' : 'muted'}">${it.overdue ? 'Vencido' : relDay(it.date)}${it.date ? ` · ${new Date(it.date + 'T12:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}` : ''}</span></span>
      ${it.amount ? html`<span class="small num" style="font-weight:650">${money(it.amount)}</span>` : ''}</a>`),
  ];
  const menu = openMenu(anchor, [{
    html: String(html`<div><div class="notif-head">Avisos<span class="spacer"></span><span class="small muted">vencidos y próximos días</span></div>
      <div class="notif-body">${rows.length ? rows : html`<div class="empty" style="padding:24px"><div class="art">🌤️</div><p>Todo en orden. No hay nada vencido ni pagos en los próximos días.</p></div>`}</div></div>`),
  }], { className: 'notif', align: 'end' });
  on(menu, 'click', 'a', () => closeMenu());
  on(menu, 'click', '[data-inv]', () => {
    closeMenu();
    showInvitations();
  });
}

// ---------- Paleta de comandos (Ctrl+K) ----------
function palette() {
  const actions = [
    ...(can('edit') ? [
      { label: 'Anotar gasto', icon: 'plus', k: 'N', run: () => openTxForm() },
      { label: 'Anotar ingreso', icon: 'arrow-down-right', k: 'I', run: () => openTxForm({ kind: 'income' }) },
      { label: 'Nueva compra a plazos', icon: 'calendar-clock', run: () => navigate('#/fijos?tab=plazos&new=1') },
      { label: 'Nuevo pago fijo', icon: 'repeat', run: () => navigate('#/fijos?new=1') },
      { label: 'Registrar factura', icon: 'receipt', run: () => navigate('#/facturas?new=1') },
      { label: 'Nuevo recordatorio', icon: 'calendar-check', run: () => navigate('#/recordatorios?new=1') },
      { label: 'Añadir a la lista de la compra', icon: 'shopping-cart', run: () => quickShopping() },
      { label: 'Anotar precio de un producto', icon: 'tag', run: () => navigate('#/precios?new=1') },
      { label: 'Nueva nota', icon: 'notebook-pen', run: () => navigate('#/notas/nueva') },
      { label: 'Anotar uso de la luz', icon: 'zap', run: () => navigate('#/luz?new=1') },
      { label: 'Resumen del mes', icon: 'sparkles', run: () => navigate('#/resumen') },
    ] : []),
    ...NAV.filter((n) => n !== 'sep').map((n) => ({ label: `Ir a ${n[1]}`, icon: n[2], run: () => navigate(`#/${n[0]}`) })),
    { label: 'Ir a Ajustes', icon: 'settings', run: () => navigate('#/ajustes') },
    { label: 'Cambiar tema claro / oscuro', icon: 'sun-moon', run: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
  ];
  let results = [];
  let sel = 0;
  const s = sheet({
    title: null,
    className: 'pal',
    body: html`<div class="pal-input">${icon('search')}<input placeholder="Busca movimientos o escribe una acción…" aria-label="Buscar" data-q></div>
      <div class="pal-list" data-list></div>`,
  });
  s.el.querySelector('.sheet-card').classList.add('palette');
  s.body.style.padding = '0';
  const input = $('[data-q]', s.el);
  const list = $('[data-list]', s.el);
  const draw = (txs = []) => {
    const q = input.value.trim().toLowerCase();
    const acts = actions.filter((a) => !q || a.label.toLowerCase().includes(q)).slice(0, 8);
    results = [...acts.map((a) => ({ ...a, type: 'act' })), ...txs.map((t) => ({ type: 'tx', t }))];
    sel = Math.min(sel, Math.max(results.length - 1, 0));
    list.innerHTML = String(html`${acts.length ? html`<div class="pal-cap">Acciones</div>` : ''}
      ${acts.map((a, i) => html`<button data-i="${i}" aria-selected="${i === sel}">${icon(a.icon)}${a.label}${a.k ? html`<span class="k">${a.k}</span>` : ''}</button>`)}
      ${txs.length ? html`<div class="pal-cap">Movimientos</div>` : ''}
      ${txs.map((t, j) => html`<button data-i="${acts.length + j}" aria-selected="${acts.length + j === sel}"><span class="emoji">${t.category_icon || '❔'}</span>
        <span class="grow ellipsis">${t.description || t.merchant}</span><span class="k">${new Date(t.date + 'T12:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: '2-digit' })} · ${money(t.amount)}</span></button>`)}
      ${!results.length ? html`<div class="empty" style="padding:28px"><p>Nada coincide con «${input.value}».</p></div>` : ''}`);
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return draw();
    try {
      const r = await get(`/transactions?q=${encodeURIComponent(q)}&limit=8`);
      draw(r.items);
    } catch {
      draw();
    }
  }, 200);
  const run = (i) => {
    const r = results[i];
    if (!r) return;
    s.close();
    if (r.type === 'act') r.run();
    else openTxForm({ tx: r.t });
  };
  input.addEventListener('input', () => {
    sel = 0;
    draw();
    search();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(results.length, 1);
      $$('[data-i]', list).forEach((b) => b.setAttribute('aria-selected', String(Number(b.dataset.i) === sel)));
      $(`[data-i="${sel}"]`, list)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(sel);
    }
  });
  on(list, 'click', '[data-i]', (e, b) => run(Number(b.dataset.i)));
  draw();
  focusLater(input, 30);
}

// ---------- Navegación ----------
export function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
    route();
  } else if (location.hash === hash) route();
  else location.hash = hash;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'inicio', params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function setHeader(title, sub = '', actions = '') {
  $('#page-title').textContent = title;
  // En el móvil los títulos largos bajan de tamaño en vez de cortarse.
  $('#page-title').dataset.len = title.length > 20 ? 'xl' : title.length > 13 ? 'long' : '';
  $('#page-sub').textContent = sub;
  $('#page-actions').innerHTML = String(actions);
  document.title = `${title} · ${NAME}`;
}

async function route() {
  if (!store.me || !store.house || !viewEl) return;
  closeMenu();
  let { name, params, query } = parseHash();
  if (name === 'nuevo') {
    history.replaceState(null, '', '#/inicio');
    name = 'inicio';
    // Desde el atajo «Foto del ticket» del icono de la app (la cámara solo se puede abrir tras un toque).
    setTimeout(() => openTxForm({ focusTicket: !!query.ticket }), 200);
  }
  if (!ROUTES[name]) name = 'inicio';
  // Al navegar (también con el botón Atrás) se cierran las hojas abiertas.
  document.querySelectorAll('dialog.sheet[open]').forEach((d) => d.dispatchEvent(new Event('cancel')));
  const token = ++current.token;
  current.cleanups.forEach((fn) => {
    try {
      fn();
    } catch { /* nada */ }
  });
  disposeCharts(viewEl);
  current = { name, cleanups: [], refresh: null, token };
  $$('[data-nav]').forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // En el móvil, «Más» queda marcado cuando la sección abierta está dentro de él.
  const more = $('.tabbar [data-act=more]');
  if (more) {
    if (TAB_ROUTES().includes(name)) more.removeAttribute('aria-current');
    else more.setAttribute('aria-current', 'page');
  }
  const r = ROUTES[name];
  setHeader(r.title);
  viewEl.className = 'content';
  viewEl.innerHTML = '';
  // Cada vista recibe un contenedor nuevo: sus escuchadores de eventos desaparecen con él.
  const host = document.createElement('div');
  host.className = 'view-host';
  viewEl.append(host);
  try {
    const mod = await r.load();
    if (token !== current.token) return;
    const ctx = {
      el: host,
      params,
      query,
      setHeader,
      navigate,
      onCleanup: (fn) => current.cleanups.push(fn),
      setRefresh: (fn) => (current.refresh = fn),
      isCurrent: () => token === current.token,
    };
    await mod.default(ctx);
  } catch (e) {
    if (token !== current.token) return;
    console.error(e);
    host.innerHTML = String(html`<div class="empty"><div class="art">🧯</div><h3>No se ha podido cargar esta sección</h3>
      <p>${e.message}</p><div class="row"><button class="btn primary" data-retry>Reintentar</button></div></div>`);
    $('[data-retry]', host).onclick = () => route();
  }
  if (window.scrollY > 0 && !query.keepScroll) window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);
// La cabecera se separa del contenido (línea y sombra suaves) en cuanto la página se desplaza.
let scrolledTop = false;
window.addEventListener('scroll', () => {
  const now = window.scrollY > 4;
  if (now === scrolledTop) return;
  scrolledTop = now;
  document.querySelector('.topbar')?.classList.toggle('scrolled', now);
}, { passive: true });

// Cambios hechos desde esta pestaña → refresca la vista y los avisos.
const refreshCurrent = debounce((detail) => {
  current.refresh?.(detail);
  refreshAlertsSoon();
}, 120);
window.addEventListener('gastosbyath:changed', (e) => refreshCurrent(e.detail));

// ---------- Tiempo real (SSE) ----------
let es = null;
function closeEvents() {
  es?.close();
  es = null;
}
function connectEvents() {
  closeEvents();
  if (!store.hid || !window.EventSource) return;
  es = new EventSource(`/api/h/${store.hid}/events`);
  // Al (re)conectar se comprueba si alguien cambió cómo ves la app mientras no había conexión.
  es.onopen = () => syncPrefs();
  es.onmessage = async (m) => {
    let evt;
    try {
      evt = JSON.parse(m.data);
    } catch {
      return;
    }
    if (evt.by === store.me?.id) return;
    if (evt.entity === 'household' && evt.action === 'delete') {
      toast('Este hogar ha sido eliminado', { type: 'err' });
      setSession(await api('/auth/me'));
      return enterApp();
    }
    if (evt.entity === 'members' && evt.action === 'remove' && evt.id === store.me.id) {
      setSession(await api('/auth/me'));
      return enterApp();
    }
    // Un administrador ha cambiado cómo ves la app (vista sencilla o letra grande).
    if (evt.entity === 'prefs' && evt.id === store.me.id) {
      setSession(await api('/auth/me'));
      applyPrefs(store.me.settings);
      renderShell();
      return route();
    }
    if (['categories', 'people', 'members', 'household', 'pets'].includes(evt.entity)) {
      await loadHouse().catch(() => {});
    }
    if (evt.summary && evt.by) toast(evt.summary, { type: 'live', timeout: 5000 });
    refreshCurrent(evt);
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.me && store.house) {
    if (!es || es.readyState === 2) connectEvents();
    refreshCurrent({ entity: 'visibility' });
    syncPrefs();
  }
});
// Al volver a la app se comprueba si alguien ha cambiado cómo la ves (por si no llegó el aviso en directo).
async function syncPrefs() {
  try {
    const before = JSON.stringify([!!store.me.settings?.simple, store.me.settings?.text || 'normal']);
    const payload = await api('/auth/me');
    const after = JSON.stringify([!!payload.user.settings?.simple, payload.user.settings?.text || 'normal']);
    if (before === after) return;
    setSession(payload);
    applyPrefs(store.me.settings);
    renderShell();
    route();
  } catch { /* sin conexión: se mira la próxima vez */ }
}

// ---------- Atajos de teclado ----------
document.addEventListener('keydown', (e) => {
  if (!store.house || document.querySelector('dialog[open]')) return;
  const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    palette();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'n' && can('edit')) {
    e.preventDefault();
    openTxForm();
  } else if (e.key === 'i' && can('edit')) {
    e.preventDefault();
    openTxForm({ kind: 'income' });
  } else if (e.key === '/') {
    e.preventDefault();
    palette();
  }
});

export { notifyChange, refreshAlerts };
boot();
