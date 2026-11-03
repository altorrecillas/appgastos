// Utilidades de interfaz: plantillas seguras, formato, hojas modales, avisos y menús.

// ---------- Plantillas con escape automático ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s ?? ''));
const renderVal = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderVal).join('');
  return esc(v);
};
// Dentro de aria-pressed="…", aria-checked="…"… un sí/no se escribe «true»/«false» (vacío no lo entiende un lector de
// pantalla); en el resto, false no pinta nada (para poder escribir ${cond && …}).
const ARIA = /aria-[a-z]+="$/;
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    out += (typeof v === 'boolean' && ARIA.test(strings[i]) ? String(v) : renderVal(v)) + strings[i + 1];
  }
  return new Raw(out);
}
export const icon = (name, cls = '') =>
  raw(`<svg class="icon ${cls}" aria-hidden="true"><use href="/icons/sprite.svg?v=5#i-${name}"/></svg>`);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function setHTML(el, content) {
  el.innerHTML = String(content);
  return el;
}
export function h2el(content) {
  const t = document.createElement('template');
  t.innerHTML = String(content).trim();
  return t.content.firstElementChild;
}
// Delegación de eventos: on(root, 'click', '[data-act]', (e, el) => …)
export function on(root, type, selector, fn, opts) {
  const handler = (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) fn(e, el);
  };
  root.addEventListener(type, handler, opts);
  return () => root.removeEventListener(type, handler, opts);
}

// ---------- Dinero ----------
let currency = 'EUR';
const fmtCache = new Map();
export const setCurrency = (c) => (currency = c || 'EUR');
export const getCurrency = () => currency;
function nf(opts) {
  const key = currency + JSON.stringify(opts);
  if (!fmtCache.has(key)) {
    try {
      fmtCache.set(key, new Intl.NumberFormat('es-ES', { style: 'currency', currency, useGrouping: 'always', ...opts }));
    } catch {
      fmtCache.set(key, new Intl.NumberFormat('es-ES', { style: 'currency', currency, ...opts }));
    }
  }
  return fmtCache.get(key);
}
export const money = (cents, { sign = false, decimals = 2 } = {}) => {
  const v = (cents || 0) / 100;
  const s = nf({ minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(v));
  if (v < 0) return `−${s}`;
  return sign && v > 0 ? `+${s}` : s;
};
export const money0 = (cents) => money(Math.round((cents || 0) / 100) * 100, { decimals: 0 });
export function moneyParts(cents) {
  const parts = nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).formatToParts(Math.abs(cents || 0) / 100);
  let int = '';
  let dec = '';
  let sym = '';
  let symBefore = false;
  let seenNumber = false;
  for (const p of parts) {
    if (p.type === 'currency') {
      sym = p.value;
      symBefore = !seenNumber;
    } else if (p.type === 'integer' || p.type === 'group') {
      int += p.value;
      seenNumber = true;
    } else if (p.type === 'decimal' || p.type === 'fraction') dec += p.value;
  }
  return { int: (cents < 0 ? '−' : '') + int, dec, sym, symBefore };
}
export function compactMoney(cents) {
  const v = (cents || 0) / 100;
  if (Math.abs(v) < 1000) return `${Math.round(v)}\u00a0${symbol()}`;
  return `${new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 }).format(v)}\u00a0${symbol()}`;
}
export const symbol = () => nf({}).formatToParts(0).find((p) => p.type === 'currency')?.value || '€';
export const pct = (x, digits = 0) => `${(x * 100).toLocaleString('es-ES', { maximumFractionDigits: digits })} %`;
export const num = (x, digits = 1) => Number(x).toLocaleString('es-ES', { maximumFractionDigits: digits });

// Convierte lo que escribe la persona en céntimos. Admite "12,50", "1.234,5", "12.5", "1,234.56" y sumas "12+3,40".
// Lo que no es un número claro (por ejemplo "2.5.0") devuelve NaN en lugar de adivinar.
function normNumber(n) {
  const commas = (n.match(/,/g) || []).length;
  const dots = (n.match(/\./g) || []).length;
  if (!commas && !dots) return n;
  if (commas && dots) {
    const dec = n.lastIndexOf(',') > n.lastIndexOf('.') ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    const i = n.lastIndexOf(dec);
    const int = n.slice(0, i);
    const frac = n.slice(i + 1);
    if (frac.includes(thou) || (n.split(dec).length > 2)) return null;
    const groups = new RegExp(`^\\d{1,3}(\\${thou}\\d{3})+$`);
    if (!groups.test(int)) return null;
    return `${int.split(thou).join('')}.${frac}`;
  }
  const sep = commas ? ',' : '.';
  const count = commas || dots;
  const groups = new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`);
  if (count > 1) return groups.test(n) ? n.split(sep).join('') : null;
  const [int, frac] = n.split(sep);
  // "1.234" es mil doscientos treinta y cuatro (uso español); "0.125" o "12.5" son decimales.
  if (sep === '.' && frac.length === 3 && int !== '' && int !== '0' && /^\d{1,3}$/.test(int)) return `${int}${frac}`;
  return `${int || '0'}.${frac}`;
}
export function parseAmount(input) {
  if (input === null || input === undefined) return NaN;
  const s = String(input).replace(/[€$£\s\u00a0]/g, '').replace(/−/g, '-');
  if (!s || !/^[-+]?[\d.,]+([+-][\d.,]+)*$/.test(s)) return NaN;
  let total = 0;
  for (const t of s.match(/[+-]?[^+-]+/g) || []) {
    const neg = t.startsWith('-');
    if (!/\d/.test(t)) return NaN;
    const n = normNumber(t.replace(/^[+-]/, ''));
    if (n === null || !/^\d*\.?\d*$/.test(n) || n === '.') return NaN;
    const v = Number(n);
    if (!Number.isFinite(v)) return NaN;
    total += neg ? -v : v;
  }
  return Math.round(total * 100);
}
export const amountStr = (cents) => (cents === null || cents === undefined || cents === '' ? '' : (cents / 100).toFixed(2).replace('.', ','));

// ---------- Fechas ----------
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export const parseDate = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
export const addDays = (s, n) => {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
export const thisMonth = () => today().slice(0, 7);
export const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
export const monthStart = (ym) => `${ym}-01`;
export const monthEnd = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${pad(new Date(y, m, 0).getDate())}`;
};
const DF = (opts) => new Intl.DateTimeFormat('es-ES', opts);
const dfShort = DF({ day: 'numeric', month: 'short' });
const dfShortY = DF({ day: 'numeric', month: 'short', year: 'numeric' });
const dfLong = DF({ weekday: 'long', day: 'numeric', month: 'long' });
const dfMonth = DF({ month: 'long', year: 'numeric' });
const dfMonthOnly = DF({ month: 'long' });
const dfMonthShort = DF({ month: 'short' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const fmtDate = (s) => {
  if (!s) return '';
  const d = parseDate(s);
  return (d.getFullYear() === new Date().getFullYear() ? dfShort : dfShortY).format(d).replace('.', '');
};
export const fmtDateFull = (s) => (s ? dfShortY.format(parseDate(s)).replace('.', '') : '');
export const fmtDateLong = (s) => cap(dfLong.format(parseDate(s)));
export const monthLabel = (ym, { year = true } = {}) => {
  const d = parseDate(`${ym}-01`);
  const curY = new Date().getFullYear();
  return cap((year && d.getFullYear() !== curY ? dfMonth : dfMonthOnly).format(d));
};
export const monthLabelFull = (ym) => cap(dfMonth.format(parseDate(`${ym}-01`)));
export const monthShort = (ym) => dfMonthShort.format(parseDate(`${ym}-01`)).replace('.', '');
export function relDay(s) {
  if (!s) return '';
  const n = daysBetween(today(), s);
  if (n === 0) return 'Hoy';
  if (n === 1) return 'Mañana';
  if (n === -1) return 'Ayer';
  if (n > 1 && n < 7) return `En ${n} días`;
  if (n < -1 && n > -31) return `Hace ${-n} días`;
  return fmtDate(s);
}
export function timeAgo(sqlUtc) {
  if (!sqlUtc) return '';
  const t = Date.parse(sqlUtc.includes('T') ? sqlUtc : `${sqlUtc.replace(' ', 'T')}Z`);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'ahora mismo';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) return `hace ${Math.round(s / 86400)} d`;
  return fmtDate(ymd(new Date(t)));
}
export function ageText(birth) {
  if (!birth) return '';
  const b = parseDate(birth);
  const n = new Date();
  let months = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth());
  if (n.getDate() < b.getDate()) months--;
  if (months < 1) return 'Menos de un mes';
  if (months < 12) return `${months} ${months === 1 ? 'mes' : 'meses'}`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return `${y} ${y === 1 ? 'año' : 'años'}${m ? ` y ${m} ${m === 1 ? 'mes' : 'meses'}` : ''}`;
}

export const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const plural = (n, one, many) => `${n.toLocaleString('es-ES')} ${n === 1 ? one : many}`;

// ---------- Hojas modales ----------
let sheetCount = 0;
// Esqueleto de carga con la forma de una pantalla (un bloque arriba y unas filas), en vez de un rectángulo gris.
export const skeletonPage = (rows = 5) => `<div class="sk-page" aria-busy="true" aria-label="Cargando">
  <div class="skeleton sk-hero"></div>
  <div class="sk-card">${'<div class="sk-row"><span class="skeleton sk-dot"></span><span class="sk-lines"><span class="skeleton sk-l1"></span><span class="skeleton sk-l2"></span></span><span class="skeleton sk-amt"></span></div>'.repeat(rows)}</div></div>`;

export function sheet({ title, body = '', foot = '', size = '', onMount, onClose, dismissable = true, className = '' }) {
  const id = `sheet-${++sheetCount}`;
  const dlg = document.createElement('dialog');
  dlg.className = `sheet ${className}`;
  dlg.setAttribute('aria-labelledby', `${id}-t`);
  dlg.innerHTML = String(html`
    <div class="sheet-card ${size}">
      <div class="sheet-grip"></div>
      ${title !== null ? html`<div class="sheet-head"><h2 id="${id}-t">${title}</h2>
        <button class="btn ghost icon-only sm" data-close aria-label="Cerrar">${icon('x')}</button></div>` : ''}
      <div class="sheet-body">${body}</div>
      ${foot ? html`<div class="sheet-foot">${foot}</div>` : ''}
    </div>`);
  document.body.append(dlg);
  let resolve;
  const done = new Promise((r) => (resolve = r));
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    dlg.close();
    dlg.remove();
    onClose?.(result);
    resolve(result);
  };
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dismissable) close();
  });
  dlg.addEventListener('mousedown', (e) => {
    if (e.target === dlg && dismissable) dlg.dataset.down = '1';
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && dlg.dataset.down === '1' && dismissable) close();
    dlg.dataset.down = '';
    if (e.target.closest('[data-close]')) close();
  });
  dlg.showModal();
  if (window.matchMedia('(max-width: 640px)').matches && dismissable) enableSheetDrag(dlg, close);
  const api = { el: dlg, body: dlg.querySelector('.sheet-body'), foot: dlg.querySelector('.sheet-foot'), close, done };
  onMount?.(api);
  return api;
}

// Hoja inferior que se cierra deslizando hacia abajo desde la cabecera.
function enableSheetDrag(dlg, close) {
  const card = dlg.querySelector('.sheet-card');
  const handle = [dlg.querySelector('.sheet-grip'), dlg.querySelector('.sheet-head')].filter(Boolean);
  let s = null;
  handle.forEach((h) => h.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button')) return;
    s = { y: e.clientY, id: e.pointerId, t: Date.now() };
    h.setPointerCapture(e.pointerId);
  }));
  handle.forEach((h) => h.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dy = Math.max(0, e.clientY - s.y);
    card.style.transition = 'none';
    card.style.transform = `translateY(${dy}px)`;
  }));
  const end = (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dy = Math.max(0, e.clientY - s.y);
    const fast = dy > 40 && Date.now() - s.t < 250;
    card.style.transition = 'transform .25s cubic-bezier(.2,.8,.2,1)';
    if (dy > 110 || fast) {
      card.style.transform = 'translateY(100%)';
      setTimeout(() => close(), 200);
    } else card.style.transform = '';
    s = null;
  };
  handle.forEach((h) => {
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  });
}

export function confirmDialog({ title = '¿Seguro?', text = '', confirm = 'Aceptar', cancel = 'Cancelar', danger = false } = {}) {
  const s = sheet({
    title,
    size: 'narrow',
    body: html`<p class="ink-2">${text}</p>`,
    foot: html`<span class="spacer"></span><button class="btn" data-close>${cancel}</button>
      <button class="btn ${danger ? 'danger solid' : 'primary'}" data-ok>${confirm}</button>`,
    onMount: (s) => {
      s.el.querySelector('[data-ok]').addEventListener('click', () => s.close(true));
      focusLater(s.el.querySelector('[data-ok]'), 30);
    },
  });
  return s.done.then((r) => r === true);
}

export function promptDialog({ title, label = '', value = '', placeholder = '', confirm = 'Guardar', type = 'text', hint = '' }) {
  const s = sheet({
    title,
    size: 'narrow',
    body: html`<form class="form" id="pf"><div class="field"><label for="pf-v">${label}</label>
      <input class="input" id="pf-v" type="${type}" value="${value}" placeholder="${placeholder}" autocomplete="off">
      ${hint ? html`<span class="hint">${hint}</span>` : ''}</div></form>`,
    foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button>
      <button class="btn primary" form="pf" type="submit">${confirm}</button>`,
    onMount: (s) => {
      const input = s.el.querySelector('#pf-v');
      focusLater(input, 30, { select: true });
      s.el.querySelector('#pf').addEventListener('submit', (e) => {
        e.preventDefault();
        s.close(input.value);
      });
    },
  });
  return s.done;
}

// ---------- Avisos ----------
let toastHost;
export function toast(message, { type = 'ok', action, timeout = 4200, iconName } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  const ic = iconName || (type === 'err' ? 'circle-alert' : type === 'live' ? 'users' : 'circle-check');
  const el = h2el(html`<div class="toast ${type}">${icon(ic)}<span class="t">${message}</span>
    ${action ? html`<button type="button">${action.label}</button>` : ''}</div>`);
  const remove = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  if (action) {
    el.querySelector('button').addEventListener('click', () => {
      action.fn();
      remove();
    });
  }
  toastHost.append(el);
  while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
  setTimeout(remove, action ? Math.max(timeout, 6500) : timeout);
}
export const toastError = (e) => (e?.quiet ? null : toast(e?.message || String(e), { type: 'err', timeout: 6000 }));

// ---------- Menú emergente ----------
let openMenuEl = null;
export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}
export function openMenu(anchor, items, { className = '', align = 'start' } = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = `menu ${className}`;
  menu.setAttribute('role', 'menu');
  items.forEach((it) => {
    if (it === 'sep') return menu.append(document.createElement('hr'));
    if (it.cap) {
      const c = document.createElement('div');
      c.className = 'cap';
      c.textContent = it.cap;
      return menu.append(c);
    }
    if (it.html) return menu.append(h2el(it.html));
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', it.checked !== undefined ? 'menuitemradio' : 'menuitem');
    if (it.checked !== undefined) b.setAttribute('aria-checked', String(!!it.checked));
    if (it.danger) b.className = 'danger';
    b.innerHTML = String(html`${it.icon ? icon(it.icon) : ''}<span class="grow ellipsis">${it.label}</span>`);
    b.addEventListener('click', () => {
      closeMenu();
      it.onClick?.();
    });
    menu.append(b);
  });
  // Dentro de una hoja abierta el menú va en la propia hoja: si no, quedaría debajo de ella.
  (anchor.closest('dialog[open]') || document.body).append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === 'end' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openMenuEl = menu;
  menu.querySelector('button')?.focus({ preventScroll: true });
  return menu;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('[data-menu-anchor]')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('resize', closeMenu);

// ---------- Varios ----------
// Pone el foco un poco después de abrir una hoja, salvo que la persona ya esté escribiendo en otro campo.
export function focusLater(el, ms = 60, { select = false } = {}) {
  if (!el) return;
  setTimeout(() => {
    const a = document.activeElement;
    const typing = a && a !== el && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest('dialog, form');
    if (typing || !el.isConnected) return;
    el.focus({ preventScroll: false });
    if (select && el.select) el.select();
  }, ms);
}
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
export async function withBusy(btn, fn) {
  if (!btn) return fn();
  btn.classList.add('loading');
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}
export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}
export const FREQ_NAMES = {
  weekly: 'Semanal', biweekly: 'Quincenal', fourweekly: 'Cada 4 semanas', monthly: 'Mensual', bimonthly: 'Bimestral', quarterly: 'Trimestral',
  fourmonthly: 'Cuatrimestral', semiannual: 'Semestral', annual: 'Anual',
};
export const FREQ_EVERY = {
  weekly: 'cada semana', biweekly: 'cada dos semanas', fourweekly: 'cada cuatro semanas', monthly: 'cada mes', bimonthly: 'cada dos meses', quarterly: 'cada tres meses',
  fourmonthly: 'cada cuatro meses', semiannual: 'cada seis meses', annual: 'cada año',
};
export const METHOD_NAMES = { card: 'Tarjeta', cash: 'Efectivo', transfer: 'Transferencia', direct_debit: 'Domiciliación', bizum: 'Bizum', other: 'Otro' };
export const METHOD_ICONS = { card: 'credit-card', cash: 'banknote', transfer: 'landmark', direct_debit: 'repeat', bizum: 'smartphone', other: 'wallet' };
export const SPECIES = {
  dog: { name: 'Perro', emoji: '🐕' }, cat: { name: 'Gato', emoji: '🐈' }, bird: { name: 'Pájaro', emoji: '🦜' }, fish: { name: 'Pez', emoji: '🐠' },
  rabbit: { name: 'Conejo', emoji: '🐇' }, rodent: { name: 'Roedor', emoji: '🐹' }, reptile: { name: 'Reptil', emoji: '🦎' },
  horse: { name: 'Caballo', emoji: '🐎' }, other: { name: 'Otro', emoji: '🐾' },
};
export const PET_EVENTS = {
  vaccine: { name: 'Vacuna', emoji: '💉' }, deworming: { name: 'Desparasitación', emoji: '🪱' }, vet: { name: 'Veterinario', emoji: '🩺' },
  food: { name: 'Comida', emoji: '🦴' }, grooming: { name: 'Peluquería', emoji: '✂️' }, medication: { name: 'Medicación', emoji: '💊' }, weight: { name: 'Peso', emoji: '⚖️' },
  other: { name: 'Otro', emoji: '📝' },
};
export const ROLE_NAMES = { owner: 'Propietario', admin: 'Administrador', editor: 'Editor', viewer: 'Solo lectura' };
export const COLORS = [
  '#2347C5', '#2A78D6', '#0E9AA7', '#1BAF7A', '#008300', '#7FA81E', '#EDA100', '#EB6834',
  '#C2410C', '#E34948', '#E87BA4', '#B5487A', '#9333EA', '#6250D6', '#8C6D46', '#5B6B82', '#6B7280',
];
export const EMOJIS = [...new Set(('🏠 🛒 💡 📶 🚗 🩺 🎓 🐾 🍽️ 🎬 👕 🛡️ 🧾 🔧 🎁 📦 💼 🧰 🏦 ✨ ☕ 🍺 🍕 🥦 🥩 🧴 💊 🏋️ ⚽ 🎮 📚 ✈️ 🏖️ 🚆 🚌 ⛽ 🅿️ 🧸 👶 💇 💄 📱 💻 🖥️ 🎵 📺 🎟️ 🏥 🦷 👓 🧹 🧺 🔌 💧 🔥 🌳 🌸 🎂 💍 💸 💳 🪙 📈 🏡 🛋️ 🛏️ 🚿 🧯 🐶 🐱 🐴 🐠 🦜 🎨 🎤 🧗 🚲 🛵 🏍️ 🚕 ⚡ 🪴 🧑‍🍳 🍼 🎒 ✏️ 🚑 💉 🧾 🗂️ ⛪ 🙏 ❤️ 🤝 🎯 🛟 🏖️ 💻 🚘').split(' '))];
