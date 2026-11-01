// Barra de la sección Compra: las listas y, siempre a mano, «Productos» (el inventario de lo que soléis comprar,
// con sus fotos y su precio en cada súper). La usan la lista de la compra y la vista de productos.
// En escritorio es la columna de la izquierda; en el móvil, un interruptor de dos mitades (la lista abierta | Productos)
// que no se corta por muchas listas que haya: tocando la lista se eligen las demás en una hoja.
import { html, icon, plural, sheet, $ } from './ui.js';

const pendingOf = (l) => l.items - l.checked;
const metaOf = (l) => (l.status === 'done' ? 'Terminada' : pendingOf(l) ? `${pendingOf(l)} por comprar` : 'Nada pendiente');

const listLink = (l, current) => html`<a href="#/compra/${l.id}" data-list="${l.id}" aria-current="${l.id === current}">
  <span class="ln-emoji emoji">${l.icon}</span><span class="grow" style="min-width:0"><span class="ln-name ellipsis" style="display:block">${l.name}</span>
  <span class="ln-meta">${metaOf(l)}</span></span></a>`;

// La última lista abierta en este dispositivo (para volver a ella desde Productos).
const LAST = 'gastosbyath.compra.lista';
export function rememberList(id) {
  try {
    if (id) localStorage.setItem(LAST, String(id));
  } catch { /* sin almacenamiento */ }
}
export function lastList(lists) {
  let id = null;
  try {
    id = Number(localStorage.getItem(LAST));
  } catch { /* sin almacenamiento */ }
  const active = lists.filter((l) => l.status === 'active');
  return lists.find((l) => l.id === id && l.status === 'active') || active[0] || lists[0] || null;
}

// current: el id de la lista abierta, o «productos». done: listas terminadas que se enseñan (en escritorio).
export function shopNav({ lists = [], current = null, summary = null, done = null } = {}) {
  const active = lists.filter((l) => l.status === 'active');
  const products = current === 'productos';
  const meta = summary?.count ? plural(summary.count, 'producto', 'productos') : 'Inventario y precios';
  const cur = products ? lastList(lists) : lists.find((l) => l.id === current);
  const curMeta = cur ? metaOf(cur) : '';
  return html`<div class="shop-nav">
    <nav class="list-nav" aria-label="Listas">
      ${active.map((l) => listLink(l, current))}
      ${done ? html`<button type="button" class="desktop-only ln-done" data-act="toggle-done">${icon(done.open ? 'chevron-up' : 'chevron-down', 'sm')}Terminadas (${done.lists.length})</button>
        ${done.open ? done.lists.map((l) => listLink(l, current)) : ''}` : ''}
    </nav>
    <a class="ln-products" href="#/productos" aria-current="${products}">
      <span class="lnp-ico">${icon('package')}</span><span class="lnp-txt"><span class="ln-name">Productos</span><span class="ln-meta">${meta}</span></span></a>
    <div class="shop-switch" role="group" aria-label="Listas y productos">
      ${cur ? (products
        ? html`<a class="ss-half ss-list" href="#/compra/${cur.id}" aria-current="false">
            <span class="ss-emoji emoji">${cur.icon}</span><span class="ss-txt"><span class="ss-name">${cur.name}</span><span class="ss-meta">${curMeta}</span></span></a>`
        : html`<button type="button" class="ss-half ss-list" data-act="pick-list" aria-current="true" aria-haspopup="dialog"
            aria-label="${cur.name}, ${curMeta}. Cambiar de lista${active.length > 1 ? ` (${active.length} listas)` : ''}">
            <span class="ss-emoji emoji">${cur.icon}</span><span class="ss-txt"><span class="ss-name">${cur.name}</span><span class="ss-meta">${curMeta}</span></span>
            <span class="ss-chev">${active.length > 1 ? html`<b>${active.length}</b>` : ''}${icon('chevron-down', 'sm')}</span></button>`)
        : html`<a class="ss-half ss-list" href="#/compra" aria-current="false"><span class="ss-emoji">${icon('shopping-cart')}</span>
            <span class="ss-txt"><span class="ss-name">Listas</span><span class="ss-meta">Crear una lista</span></span></a>`}
      <a class="ss-half ss-prod" href="#/productos" aria-current="${products}" aria-label="Productos: ${meta}">
        <span class="ss-emoji ss-pico">${icon('package')}</span><span class="ss-name">Productos</span></a>
    </div>
  </div>`;
}

// Hoja con todas las listas para cambiar de una a otra en el móvil (y crear una nueva).
export function openListPicker({ lists, current, canEdit, onPick, onNew }) {
  const active = lists.filter((l) => l.status === 'active');
  const finished = lists.filter((l) => l.status === 'done');
  const row = (l) => html`<button type="button" class="lpk-row" data-pick-list="${l.id}" aria-current="${l.id === current}">
    <span class="lpk-emoji emoji">${l.icon}</span>
    <span class="lpk-txt"><b>${l.name}</b><small>${[l.store, metaOf(l)].filter(Boolean).join(' · ')}</small></span>
    ${l.id === current ? html`<span class="lpk-on">${icon('check', 'sm')}</span>` : l.status === 'active' && pendingOf(l) ? html`<span class="lpk-n">${pendingOf(l)}</span>` : ''}
  </button>`;
  const s = sheet({
    title: 'Tus listas',
    size: 'narrow',
    body: html`<div class="lpk">
      <div class="lpk-list">${active.map(row)}</div>
      ${finished.length ? html`<details class="lpk-done"><summary>Terminadas (${finished.length})</summary><div class="lpk-list">${finished.map(row)}</div></details>` : ''}
    </div>`,
    foot: canEdit ? html`<button type="button" class="btn primary block" data-act="lp-new">${icon('plus')}Nueva lista</button>` : '',
  });
  s.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick-list]');
    if (b) {
      s.close();
      onPick(Number(b.dataset.pickList));
    } else if (e.target.closest('[data-act=lp-new]')) {
      s.close();
      onNew();
    }
  });
  setTimeout(() => $('.lpk-row[aria-current="true"]', s.el)?.scrollIntoView({ block: 'nearest' }), 50);
  return s;
}
