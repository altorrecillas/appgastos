// El inicio a gusto de cada persona: qué bloques se ven y en qué orden. Se guarda en sus ajustes, así que la sigue en
// todos sus dispositivos, y el inicio de los demás de la casa no cambia.
import { api } from './api.js';
import { $, $$, html, icon, on, toast, toastError, withBusy } from './ui.js';
import { setSession, store } from './store.js';
import { NAME } from './brand.js';
import { enableDragSort } from './gestures.js';

// En el orden de siempre. «wide»: a todo el ancho; el resto, en el ordenador, en su columna (main, la ancha, o side).
export const BLOCKS = [
  { id: 'hero', name: 'Resumen del mes', desc: 'Lo gastado, el presupuesto y el gráfico del mes', icon: 'chart-line', wide: true },
  { id: 'quick', name: 'Atajos', desc: 'Ticket, ingreso y la compra (solo en el móvil)', icon: 'grid-2x2', wide: true },
  { id: 'insights', name: 'Para que lo sepas', desc: 'Avisos de lo que se sale de lo normal', icon: 'sparkles', wide: true },
  { id: 'stats', name: 'Cifras del mes', desc: 'Ingresos, balance, fijos, plazos y facturas', icon: 'gauge', wide: true },
  { id: 'categories', name: 'En qué se va el dinero', desc: 'El gasto por categorías y sus límites', icon: 'chart-pie', col: 'main' },
  { id: 'trend', name: 'Últimos 12 meses', desc: 'Gastos e ingresos mes a mes', icon: 'chart-column', col: 'main' },
  { id: 'recent', name: 'Últimos movimientos', desc: 'Lo último que se ha anotado', icon: 'list-ordered', col: 'main' },
  { id: 'power', name: 'Luz ahora', desc: 'Precio de la luz y la factura en curso', icon: 'zap', col: 'side' },
  { id: 'upcoming', name: 'Próximos 30 días', desc: 'Recibos, facturas y avisos que vienen', icon: 'calendar-check', col: 'side' },
  { id: 'installments', name: 'Compras a plazos', desc: 'Lo que queda por pagar a plazos', icon: 'credit-card', col: 'side' },
  { id: 'lists', name: 'Lista de la compra', desc: 'Lo que falta por comprar', icon: 'shopping-cart', col: 'side' },
  { id: 'goals', name: 'Ahorro', desc: 'Cómo van las metas de ahorro', icon: 'piggy-bank', col: 'side' },
  { id: 'activity', name: 'Actividad en casa', desc: 'Lo último que ha hecho cada persona', icon: 'activity', col: 'side' },
];
const IDS = BLOCKS.map((b) => b.id);
export const blockOf = (id) => BLOCKS.find((b) => b.id === id);

// El orden guardado; los bloques que traiga una versión nueva entran en su sitio de siempre (detrás del que les
// precede en el orden de siempre) y lo que ya no existe se ignora.
export function homeLayout(saved = store.me?.settings?.home) {
  const order = (Array.isArray(saved?.order) ? saved.order : []).filter((id, i, a) => IDS.includes(id) && a.indexOf(id) === i);
  IDS.forEach((id, i) => {
    if (order.includes(id)) return;
    const before = IDS.slice(0, i).reverse().find((x) => order.includes(x));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
  });
  return { order, hidden: new Set((Array.isArray(saved?.hidden) ? saved.hidden : []).filter((id) => IDS.includes(id))) };
}

// «Personalizar el inicio»: la lista de bloques para ordenarlos (arrastrando por el asa o con las flechas) y apagar
// los que no se quieran ver. Nada se guarda hasta «Guardar».
// has(id): si ahora mismo tiene algo que enseñar (la luz, los plazos… solo salen cuando hay datos).
export function editHome(ctx, { has, done }) {
  let { order, hidden } = homeLayout();
  ctx.el.innerHTML = '<div class="home-edit"></div>';
  const root = ctx.el.firstElementChild;
  // En el móvil no caben título y botones: el título va en la página.
  ctx.setHeader('', '', html`
    <button class="btn ghost" data-he="cancel">Cancelar</button>
    <button class="btn primary" data-he="save">${icon('check')}Guardar</button>`);
  document.title = `Personaliza tu inicio · ${NAME}`;

  const row = (id) => {
    const b = blockOf(id);
    const off = hidden.has(id);
    const i = order.indexOf(id);
    return html`<div class="he-row ${off ? 'off' : ''}" data-block="${id}">
      <span data-grip role="img" aria-label="Arrastrar ${b.name}">${icon('grip-vertical')}</span>
      <span class="he-ico">${icon(b.icon)}</span>
      <span class="he-txt"><b>${b.name}</b><small>${off ? 'Oculto en tu inicio' : has(id) ? b.desc : `${b.desc}. Sale cuando hay algo que enseñar`}</small></span>
      <span class="he-move">
        <button type="button" class="btn ghost sm icon-only" data-move="-1" aria-label="Subir ${b.name}" ${i === 0 ? 'disabled' : ''}>${icon('chevron-up', 'sm')}</button>
        <button type="button" class="btn ghost sm icon-only" data-move="1" aria-label="Bajar ${b.name}" ${i === order.length - 1 ? 'disabled' : ''}>${icon('chevron-down', 'sm')}</button>
      </span>
      <label class="switch"><input type="checkbox" data-show ${off ? '' : 'checked'} aria-label="Enseñar ${b.name}"><span class="track"></span></label>
    </div>`;
  };
  const paint = () => {
    root.innerHTML = String(html`
      <h2 class="he-title">Personaliza tu inicio</h2>
      <p class="he-intro">Arrastra cada bloque por ${icon('grip-vertical', 'sm')} o usa las flechas para cambiar el orden, y apaga lo que no quieras ver.
        Lo que ocultes no se borra: solo deja de salir en tu inicio.</p>
      <div class="he-list" data-drop>${order.map(row)}</div>
      <div class="he-foot"><button type="button" class="btn ghost" data-he="reset">${icon('rotate-ccw')}Volver al orden de siempre</button></div>`);
  };
  paint();

  enableDragSort(root, {
    item: '.he-row',
    onDrop: () => {
      order = $$('.he-row', root).map((r) => r.dataset.block);
      paint();
    },
  });
  on(root, 'click', '[data-move]', (e, b) => {
    const id = b.closest('[data-block]').dataset.block;
    const dir = Number(b.dataset.move);
    const i = order.indexOf(id);
    const j = Math.max(0, Math.min(order.length - 1, i + dir));
    if (i === j) return;
    [order[i], order[j]] = [order[j], order[i]];
    paint();
    // El foco sigue en la misma flecha (o en la otra si ya llegó al tope), para seguir moviéndolo con el teclado.
    const moved = $(`[data-block="${id}"]`, root);
    moved.classList.add('moved');
    ($(`[data-move="${dir}"]:not([disabled])`, moved) || $('[data-move]:not([disabled])', moved))?.focus();
  });
  on(root, 'change', '[data-show]', (e, c) => {
    const id = c.closest('[data-block]').dataset.block;
    if (c.checked) hidden.delete(id);
    else hidden.add(id);
    paint();
    $(`[data-block="${id}"] [data-show]`, root)?.focus();
  });

  const close = () => {
    offHeader();
    done();
  };
  const act = (what, b) => {
    if (what === 'cancel') return close();
    if (what === 'reset') {
      ({ order, hidden } = homeLayout(null));
      return paint();
    }
    if (what !== 'save') return;
    // Si queda como siempre se guarda «nada»: así le llegan los cambios del orden de siempre en versiones nuevas.
    const asDefault = !hidden.size && order.every((id, i) => id === IDS[i]);
    withBusy(b, async () => {
      try {
        setSession(await api('/auth/me', { method: 'PATCH', body: { settings: { home: asDefault ? null : { order, hidden: [...hidden] } } } }));
        toast(asDefault ? 'Tu inicio vuelve a estar como siempre' : 'Tu inicio queda a tu gusto');
        close();
      } catch (err) {
        toastError(err);
      }
    });
  };
  const offHeader = on(document.getElementById('page-actions'), 'click', '[data-he]', (e, b) => act(b.dataset.he, b));
  ctx.onCleanup(offHeader);
  on(root, 'click', '[data-he]', (e, b) => act(b.dataset.he, b));
}
