// Barra de la sección Compra: las listas y, siempre a mano, «Productos» (el inventario de lo que soléis comprar,
// con sus fotos y su precio en cada súper). La usan la lista de la compra y la vista de productos.
import { html, icon, plural } from './ui.js';

const listLink = (l, current) => html`<a href="#/compra/${l.id}" data-list="${l.id}" aria-current="${l.id === current}">
  <span class="ln-emoji emoji">${l.icon}</span><span class="grow" style="min-width:0"><span class="ln-name ellipsis" style="display:block">${l.name}</span>
  <span class="ln-meta">${l.status === 'done' ? 'Terminada' : l.items - l.checked ? `${l.items - l.checked} por comprar` : 'Nada pendiente'}</span></span></a>`;

// current: el id de la lista abierta, o «productos». done: listas terminadas que se enseñan (en escritorio).
export function shopNav({ lists = [], current = null, summary = null, done = null } = {}) {
  const active = lists.filter((l) => l.status === 'active');
  const meta = summary?.count ? plural(summary.count, 'producto', 'productos') : 'Inventario y precios';
  return html`<div class="shop-nav">
    <nav class="list-nav" aria-label="Listas">
      ${active.map((l) => listLink(l, current))}
      ${done ? html`<button type="button" class="desktop-only ln-done" data-act="toggle-done">${icon(done.open ? 'chevron-up' : 'chevron-down', 'sm')}Terminadas (${done.lists.length})</button>
        ${done.open ? done.lists.map((l) => listLink(l, current)) : ''}` : ''}
    </nav>
    <a class="ln-products" href="#/productos" aria-current="${current === 'productos'}">
      <span class="lnp-ico">${icon('package')}</span><span class="lnp-txt"><span class="ln-name">Productos</span><span class="ln-meta">${meta}</span></span></a>
  </div>`;
}
