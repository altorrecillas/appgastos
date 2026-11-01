// Productos de la compra: cada uno con su foto, su sección del súper, cómo se vende y lo que cuesta en cada supermercado.
import { del, get, hurl, patch, post, upload } from '../api.js';
import {
  $, addDays, confirmDialog, fmtDate, fmtDateFull, html, icon, money, num, on, openMenu, pct, plural, sheet, today, toast, toastError, withBusy, focusLater, skeletonPage,
} from '../ui.js';
import { can } from '../store.js';
import { bindPickers, chipPicker, notifyChange, readForm, showFormError } from '../forms.js';
import { axisLabel, grid, mountChart, tipBox, tipHTML } from '../charts.js';
import { cropPhoto, pickImage } from '../photo.js';
import { compareLabel, isPerBase, openPriceForm, priceLabel } from './prices.js';

// Color de cada sección del súper (tiñe su cabecera y las iniciales de sus productos).
const SECTION_COLORS = {
  fruta: '#3b9b4f', carne: '#cf4a3f', lacteos: '#3f7fd0', panaderia: '#c98a2b', despensa: '#a8742f', bebidas: '#2f8fb0',
  congelados: '#3aa0c8', limpieza: '#7a5bd0', higiene: '#c45a9a', mascotas: '#8a6a4a', bebe: '#d9708f', otros: '#8a8f98',
};
const UNIT_NAMES = { ud: 'unidad', kg: 'kg', g: 'g', l: 'litro', ml: 'ml', pack: 'paquete' };
const UNIT_SUFFIX = { kg: '/kg', l: '/l' };
const baseOf = (u) => (u === 'g' ? 'kg' : u === 'ml' ? 'l' : u);

// Cuánto ha subido en un año: precio normal de ahora frente al de hace un año, en las mismas tiendas.
function yearChange(p) {
  const cut = addDays(today(), -365);
  const floor = addDays(cut, -183);
  const regular = p.history.filter((h) => !h.offer && baseOf(h.unit) === p.base_unit);
  const items = [];
  for (const st of new Set(regular.map((h) => h.store))) {
    const obs = regular.filter((h) => h.store === st);
    const now = obs.at(-1);
    const then = obs.filter((h) => h.date <= cut && h.date >= floor).at(-1);
    if (now && then && now.date > cut) items.push({ from: then.unit_price, to: now.unit_price });
  }
  if (!items.length) return null;
  const g = Math.exp(items.reduce((s, x) => s + Math.log(x.to / x.from), 0) / items.length);
  const avg = (k) => Math.round(items.reduce((s, x) => s + x[k], 0) / items.length);
  return { change: g - 1, from: avg('from'), to: avg('to'), stores: items.length };
}
const SORTS = { times: 'Más comprados', name: 'De la A a la Z', noprice: 'Primero sin precio' };
let SECTIONS = [];
let sortPref = 'times';

const secOf = (id) => SECTIONS.find((s) => s.id === id) || SECTIONS.find((s) => s.id === 'otros') || { id: 'otros', name: 'Otros', icon: '📦' };
const secColor = (id) => SECTION_COLORS[id] || SECTION_COLORS.otros;

// Foto del producto o su inicial sobre el color de su sección.
export function productThumb(p, cls = '') {
  if (p.photo_id) return html`<span class="pthumb ${cls}" style="--sc:${secColor(p.section)}"><img src="${hurl(`/attachments/${p.photo_id}`)}" alt="" loading="lazy"></span>`;
  return html`<span class="pthumb ${cls}" style="--sc:${secColor(p.section)}" aria-hidden="true">${(p.name || '?').trim().charAt(0).toUpperCase()}</span>`;
}

// Cómo se vende, dicho en cristiano.
const formatText = (p) => {
  if (!p.unit) return '';
  if (isPerBase({ qty: p.unit_qty, unit: p.unit })) return p.unit === 'kg' ? 'Se vende al peso' : 'Se vende a granel';
  if (p.unit === 'ud' && p.unit_qty === 1) return 'Se vende por unidades';
  if (p.unit === 'pack' && p.unit_qty === 1) return 'Se vende en paquete';
  return `Formato de ${num(p.unit_qty, 3)} ${p.unit === 'ud' ? (p.unit_qty === 1 ? 'unidad' : 'unidades') : p.unit === 'pack' ? 'paquetes' : p.unit}`;
};

async function addToList(p, anchor) {
  const lists = (await get('/shopping/lists')).filter((l) => l.status === 'active');
  if (!lists.length) return toast('Crea primero una lista en «Lista de la compra»', { type: 'err' });
  const add = async (l) => {
    await post(`/shopping/lists/${l.id}/items`, { name: p.name });
    notifyChange('shopping');
    toast(`${p.name}: añadido a «${l.name}»`, { iconName: 'shopping-cart' });
  };
  if (lists.length === 1) return add(lists[0]);
  return new Promise((resolve) => openMenu(anchor, lists.map((l) => ({ label: `${l.icon}  ${l.name}`, onClick: () => add(l).then(resolve, (e) => (toastError(e), resolve())) }))));
}

export default async function productsView(ctx) {
  let data = null;
  let q = '';
  let sec = ctx.query.seccion || '';

  ctx.setHeader('Productos', 'Lo que compráis, ordenado por secciones del súper', html`
    <a class="btn ghost desktop-only" href="#/precios">${icon('store')}Comparar precios</a>
    ${can('edit') ? html`<button class="btn primary" data-act="new-product">${icon('plus')}<span class="desktop-only">Añadir producto</span></button>` : ''}`);

  async function load() {
    try {
      data = await get('/products');
      SECTIONS = data.sections;
      if (ctx.isCurrent()) draw();
    } catch (e) {
      toastError(e);
    }
  }

  // Lo más útil de un vistazo: dónde es más barato (y en cuántos súper hay precio).
  const priceLine = (p) => (p.best
    ? html`<span class="pl-best">Desde <b class="best">${compareLabel(p.best, p.base_unit).main}</b> en ${p.best.store}</span>${p.stores > 1 ? html`<i class="sep"></i><span class="pl-n">${p.stores} súper</span>` : ''}`
    : html`<span class="faint">Sin precios</span>`);

  const row = (p) => html`<div class="prod-row" data-prod="${p.id}">
    <button type="button" class="prod-open" data-open="${p.id}">${productThumb(p)}
      <span class="prod-txt"><span class="prod-l1"><b>${p.name}</b>${p.note ? html`<span class="nt">${p.note}</span>` : ''}</span><small>${priceLine(p)}</small></span></button>
    ${p.in_list ? html`<span class="prod-inlist" title="Está en la lista de la compra" aria-label="En la lista">${icon('check', 'sm')}<span>En la lista</span></span>`
      : can('edit') ? html`<button type="button" class="btn ghost sm icon-only" data-tolist="${p.id}" aria-label="Añadir ${p.name} a la lista">${icon('list-plus')}</button>` : ''}
  </div>`;

  function draw() {
    if (!data.products.length) {
      ctx.el.innerHTML = String(html`<div class="empty"><div class="art">🧺</div><h3>Vuestros productos, bien ordenados</h3>
        <p>Aquí aparecen solos los productos que añadís a la lista de la compra. También podéis crearlos con su foto, la sección del súper y lo que cuestan en cada supermercado.</p>
        ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="new-product">${icon('plus')}Añadir un producto</button>
          <a class="btn" href="#/compra">${icon('shopping-cart')}Ir a la lista de la compra</a></div>` : ''}</div>`);
      return;
    }
    const qn = q.trim().toLowerCase();
    const all = data.products.filter((p) => !qn || p.name.toLowerCase().includes(qn) || p.note.toLowerCase().includes(qn));
    const shown = all.filter((p) => !sec || (p.section || 'otros') === sec);
    const cmp = {
      times: (a, b) => b.times - a.times || a.name.localeCompare(b.name, 'es'),
      name: (a, b) => a.name.localeCompare(b.name, 'es'),
      noprice: (a, b) => (a.best ? 1 : 0) - (b.best ? 1 : 0) || b.times - a.times || a.name.localeCompare(b.name, 'es'),
    }[sortPref];
    const groups = SECTIONS.map((s) => ({ s, items: shown.filter((p) => (SECTIONS.some((x) => x.id === p.section) ? p.section : 'otros') === s.id).sort(cmp) }))
      .filter((g) => g.items.length);
    const count = (id) => all.filter((p) => (p.section || 'otros') === id).length;
    const noPrice = data.products.filter((p) => !p.best).length;
    const photos = data.products.filter((p) => p.photo_id).length;
    ctx.el.innerHTML = String(html`
      <div class="prod-stats">
        <span><b>${data.products.length}</b> productos</span>
        <span><b>${data.products.length - noPrice}</b> con precio</span>
        <span><b>${photos}</b> con foto</span>
      </div>
      <div class="prod-tools">
        <div class="input-group">${icon('search')}<input class="input" type="search" placeholder="Buscar producto o marca…" value="${q}" data-q aria-label="Buscar producto"></div>
        <button type="button" class="btn sm" data-act="sort" aria-label="Ordenar: ${SORTS[sortPref]}">${icon('arrow-down-up', 'sm')}<span>${SORTS[sortPref]}</span></button>
      </div>
      <div class="chips scroll prod-secs" role="toolbar" aria-label="Secciones">
        <button type="button" class="chip" data-sec="" aria-pressed="${!sec}">Todo<span class="n">${all.length}</span></button>
        ${SECTIONS.filter((s) => count(s.id)).map((s) => html`<button type="button" class="chip" data-sec="${s.id}" aria-pressed="${sec === s.id}" style="--sc:${secColor(s.id)}">
          <span class="emoji">${s.icon}</span>${s.name}<span class="n">${count(s.id)}</span></button>`)}
      </div>
      ${groups.length ? html`<div class="prod-groups">${groups.map((g) => html`<section class="prod-group" style="--sc:${secColor(g.s.id)}">
          <header class="prod-aisle"><span class="emoji">${g.s.icon}</span><h2>${g.s.name}</h2><span class="n">${g.items.length}</span></header>
          <div class="prod-list">${g.items.map(row)}</div></section>`)}</div>`
        : html`<div class="empty"><div class="art">🔍</div><h3>No hay ningún producto así</h3>
          <p>Prueba con otra palabra${sec ? ' o mira en todas las secciones' : ''}.</p>
          ${can('edit') && q.trim() ? html`<div class="row"><button class="btn primary" data-act="new-product" data-name="${q.trim()}">${icon('plus')}Añadir «${q.trim()}»</button></div>` : ''}</div>`}`);
  }

  on(ctx.el, 'input', '[data-q]', (e, input) => {
    q = input.value;
    const pos = input.selectionStart;
    draw();
    const again = $('[data-q]', ctx.el);
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  on(ctx.el, 'click', '[data-sec]', (e, b) => {
    sec = b.dataset.sec;
    draw();
  });
  on(ctx.el, 'click', '[data-act=sort]', (e, b) => openMenu(b, Object.entries(SORTS).map(([k, label]) => ({
    label, checked: sortPref === k, onClick: () => {
      sortPref = k;
      draw();
    },
  })), { align: 'end' }));
  on(ctx.el, 'click', '[data-open]', (e, b) => openProduct(Number(b.dataset.open)).then(load));
  on(ctx.el, 'click', '[data-tolist]', (e, b) => {
    const p = data.products.find((x) => x.id === Number(b.dataset.tolist));
    withBusy(b, () => addToList(p, b).then(load).catch(toastError));
  });
  const create = async (name = '') => {
    const id = await productForm({ name });
    if (!id) return;
    await load();
    openProduct(id).then(load);
  };
  on(ctx.el, 'click', '[data-act=new-product]', (e, b) => create(b.dataset.name || ''));
  ctx.onCleanup(on(document.getElementById('page-actions'), 'click', '[data-act=new-product]', () => create()));
  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
  if (ctx.query.id) {
    history.replaceState(null, '', '#/productos');
    openProduct(Number(ctx.query.id)).then(load);
  } else if (ctx.query.new) {
    history.replaceState(null, '', '#/productos');
    create(ctx.query.name || '');
  }
}

// ======================================================================
// Ficha del producto
// ======================================================================
export async function openProduct(id) {
  let p;
  try {
    p = await get(`/products/${id}`);
    if (!SECTIONS.length) SECTIONS = await get('/shopping/sections');
  } catch (e) {
    return toastError(e);
  }
  const edit = can('edit');
  const s = sheet({
    title: p.name,
    size: 'wide',
    className: 'prod-sheet',
    body: '',
    foot: edit ? html`<button class="btn ghost icon-only" data-act="more" aria-label="Más opciones">${icon('ellipsis')}</button><span class="spacer"></span>
      <button class="btn" data-act="edit">${icon('pencil')}Editar</button>
      <button class="btn primary" data-act="price">${icon('tag')}Anotar precios</button>` : '',
  });
  const storeIdx = (st) => Math.max(0, p.store_order.findIndex((x) => x.toLowerCase() === st.toLowerCase())) % 8;
  const storeColor = (st) => `var(--chart-${storeIdx(st) + 1})`;
  let changed = false;

  const reload = async () => {
    changed = true;
    try {
      p = await get(`/products/${id}`);
    } catch {
      return s.close(true);
    }
    $('.sheet-head h2', s.el).textContent = p.name;
    draw();
  };

  function draw() {
    const sc = secOf(p.section);
    const comparable = p.prices.filter((x) => (x.unit === 'g' ? 'kg' : x.unit === 'ml' ? 'l' : x.unit) === p.base_unit);
    const best = comparable[0];
    // «al peso» debajo de cada precio solo aporta si hay también bandejas o paquetes.
    const allLoose = p.prices.every((x) => isPerBase(x));
    const yoy = yearChange(p);
    const facts = [formatText(p), p.times ? `Comprado ${plural(p.times, 'vez', 'veces')}` : ''].filter(Boolean);
    s.body.innerHTML = String(html`<div class="prod-detail">
      <div class="prod-hero">
        <div class="prod-photo">${productThumb(p, 'xl')}
          ${edit ? html`<button type="button" class="prod-cam" data-act="photo" aria-label="${p.photo_id ? 'Cambiar la foto' : 'Poner una foto'}">${icon('camera', 'sm')}</button>` : ''}</div>
        <div class="prod-id">
          <span class="prod-sec" style="--sc:${secColor(sc.id)}"><span class="emoji">${sc.icon}</span>${sc.name}</span>
          ${p.note ? html`<p class="prod-note">${p.note}</p>` : ''}
          ${facts.length ? html`<p class="small muted">${facts.join(' · ')}</p>` : ''}
          ${p.lists.length ? html`<p class="prod-onlist">${icon('check', 'sm')}En «${p.lists.map((l) => l.name).join('», «')}»${p.lists[0].qty ? ` · ${p.lists[0].qty}` : ''}</p>`
            : edit ? html`<button type="button" class="btn sm" data-act="tolist">${icon('list-plus', 'sm')}Añadir a la lista</button>` : ''}
        </div>
      </div>

      <section class="prod-block">
        <div class="prod-bhead"><h3>Precio en cada súper</h3>${best && comparable.length > 1 ? html`<span class="small muted">${p.base_unit === 'kg' ? 'comparado por kilo' : p.base_unit === 'l' ? 'comparado por litro' : 'último precio'}</span>` : ''}</div>
        ${p.prices.length ? html`<div class="pp-list">${p.prices.map((x) => {
          const l = compareLabel(x, p.base_unit);
          const isComp = comparable.includes(x);
          const isBest = isComp && comparable.length > 1 && x === best;
          const diff = isComp && best && x !== best && best.unit_price > 0 ? x.unit_price / best.unit_price - 1 : 0;
          return html`<button type="button" class="pp-row ${isBest ? 'best' : ''}" data-store="${x.store}" ${edit ? '' : 'disabled'}>
            <i class="dot" style="background:${storeColor(x.store)}"></i>
            <span class="pp-main"><b>${x.store}</b><small>${fmtDate(x.date)}${x.offer ? ' · en oferta' : ''}${isComp ? '' : ' · otro formato'}</small></span>
            ${isBest ? html`<span class="pill paid">El más barato</span>` : diff >= 0.005 ? html`<span class="pp-diff">+${pct(diff)}</span>` : ''}
            <span class="pp-price"><b>${l.main}</b>${l.sub && !allLoose ? html`<small>${l.sub}</small>` : ''}</span>
          </button>`;
        })}</div>` : html`<p class="prod-empty">${icon('tag', 'sm')}Todavía no hay precios. Anota lo que cuesta en cada súper y verás dónde sale más barato.</p>`}
        ${yoy ? html`<p class="prod-yoy ${yoy.change > 0.0005 ? 'up' : yoy.change < -0.0005 ? 'down' : ''}">${icon(yoy.change < 0 ? 'trending-down' : 'trending-up', 'sm')}
          <span>En un año, <b>${yoy.change > 0 ? '+' : yoy.change < 0 ? '−' : ''}${pct(Math.abs(yoy.change), 1)}</b>: de ${money(yoy.from)}${UNIT_SUFFIX[p.base_unit] || ''}
          a ${money(yoy.to)}${UNIT_SUFFIX[p.base_unit] || ''}${yoy.stores > 1 ? ` (${yoy.stores} súper)` : ''}.</span></p>` : ''}
      </section>

      ${new Set(p.history.map((h) => h.date)).size > 1 ? html`<section class="prod-block"><div class="prod-bhead"><h3>Cómo ha cambiado el precio</h3>
          ${p.change !== null && Math.abs(p.change) >= 0.01 ? html`<span class="small ${p.change > 0 ? 'neg' : 'pos'}">${p.change > 0 ? '▲' : '▼'} ${pct(Math.abs(p.change))} desde el primero</span>` : ''}</div>
        <div class="chart short" data-chart role="img" aria-label="Evolución del precio por supermercado"></div>
        <details class="prod-hist"><summary>Todos los precios anotados (${p.history.length})</summary>
          <div class="rows inset">${p.history.slice().reverse().map((h) => {
            const l = priceLabel(h, p.base_unit);
            return html`<div class="rowi"><i class="dot" style="background:${storeColor(h.store)}"></i>
              <span class="main-txt"><span class="title">${h.store}${h.offer ? ' · oferta' : ''}</span>
                <span class="meta">${fmtDateFull(h.date)}${l.qty ? ` · ${l.qty}` : ''}${h.created_by_name ? ` · ${h.created_by_name}` : ''}</span></span>
              <span class="side"><span class="amount">${l.main}</span>${l.unit ? html`<span class="tiny muted">${l.unit}</span>` : ''}</span>
              ${edit ? html`<button class="btn ghost sm icon-only" data-delprice="${h.id}" aria-label="Borrar este precio">${icon('x', 'sm')}</button>` : ''}</div>`;
          })}</div></details></section>` : ''}
    </div>`);
    const el = $('[data-chart]', s.body);
    if (el) {
      const stores = [...new Set(p.history.map((h) => h.store))];
      const suffix = ['kg', 'l'].includes(p.base_unit) ? `/${p.base_unit}` : '';
      const same = (h) => (h.unit === 'g' ? 'kg' : h.unit === 'ml' ? 'l' : h.unit) === p.base_unit;
      mountChart(el, (t) => ({
        grid: grid({ top: 12, right: 18 }),
        tooltip: { ...tipBox(t), trigger: 'item', formatter: (x) => tipHTML(fmtDateFull(x.value[0]), [{ color: x.color, value: `${money(x.value[1])}${suffix}`, label: x.seriesName }]) },
        xAxis: {
          type: 'time', splitNumber: 4, axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false }, splitLine: { show: false },
          // Medio día de margen a cada lado para que no se corten los puntos de los extremos.
          min: (v) => v.min - 432e5, max: (v) => v.max + 432e5,
          axisLabel: axisLabel(t, { hideOverlap: true, formatter: (v) => new Date(v).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }).replace('.', '') }),
        },
        yAxis: { type: 'value', scale: true, splitNumber: 4, splitLine: { lineStyle: { color: t.grid } }, axisLabel: axisLabel(t, { formatter: (v) => money(v) }) },
        series: stores.map((st) => {
          const color = t.series[storeIdx(st)];
          return {
            name: st, type: 'line', connectNulls: true, symbol: 'circle', symbolSize: 8, showSymbol: true,
            lineStyle: { width: 2, color }, itemStyle: { color, borderColor: t.surface, borderWidth: 2 },
            data: p.history.filter((x) => x.store === st && same(x)).map((x) => [x.date, Math.round(x.unit_price)]),
          };
        }),
      }));
    }
  }

  const setPhoto = (btn, camera) => pickImage({ camera }).then(async (file) => {
    const cropped = file && (await cropPhoto(file, { square: true }));
    if (!cropped) return;
    await withBusy(btn, async () => {
      const a = await upload(cropped);
      await patch(`/products/${id}`, { photo_id: a.id });
      notifyChange('products');
      await reload();
    });
  }).catch(toastError);
  on(s.el, 'click', '[data-act=photo]', (e, b) => {
    const items = [
      { label: 'Hacer una foto', icon: 'camera', onClick: () => setPhoto(b, true) },
      { label: 'Elegir de la galería', icon: 'image', onClick: () => setPhoto(b, false) },
    ];
    if (p.photo_id) items.push('sep', { label: 'Quitar la foto', icon: 'trash-2', danger: true, onClick: () => patch(`/products/${id}`, { photo_id: null }).then(reload).catch(toastError) });
    openMenu(b, items);
  });
  on(s.el, 'click', '[data-act=tolist]', (e, b) => withBusy(b, () => addToList(p, b).then(reload).catch(toastError)));
  on(s.el, 'click', '[data-store]', async (e, b) => {
    await openPriceForm({ product: p.name, store: b.dataset.store });
    reload();
  });
  on(s.el, 'click', '[data-act=price]', async () => {
    await openPriceForm({ product: p.name });
    reload();
  });
  on(s.el, 'click', '[data-act=edit]', async () => {
    if (await productForm(p)) reload();
  });
  on(s.el, 'click', '[data-delprice]', async (e, b) => {
    if (!(await confirmDialog({ title: '¿Borrar este precio?', confirm: 'Borrar', danger: true }))) return;
    try {
      await del(`/prices/${b.dataset.delprice}`);
      notifyChange('prices');
      reload();
    } catch (err) {
      toastError(err);
    }
  });
  on(s.el, 'click', '[data-act=more]', (e, b) => openMenu(b, [
    { label: 'Unir con otro producto…', icon: 'copy-plus', onClick: () => mergeInto(p).then((to) => to && s.close(true)) },
    'sep',
    { label: 'Borrar el producto', icon: 'trash-2', danger: true, onClick: async () => {
      const n = p.history.length;
      const ok = await confirmDialog({
        title: `¿Borrar «${p.name}»?`,
        text: n ? `Se borran también sus ${plural(n, 'precio anotado', 'precios anotados')}. Las listas de la compra no cambian.` : 'Las listas de la compra no cambian.',
        confirm: 'Borrar', danger: true,
      });
      if (!ok) return;
      try {
        await del(`/products/${id}`);
        notifyChange('products');
        toast(`${p.name}: borrado`);
        s.close(true);
      } catch (err) {
        toastError(err);
      }
    } },
  ], { align: 'start' }));
  draw();
  const r = await s.done;
  return r || changed;
}

// Unir dos productos que son el mismo: los precios y las listas pasan al elegido.
async function mergeInto(p) {
  const { products } = await get('/products');
  const others = products.filter((x) => x.id !== p.id);
  if (!others.length) return toast('No hay otros productos con los que unirlo', { type: 'err' });
  const s = sheet({
    title: `Unir «${p.name}» con…`,
    size: 'narrow',
    body: html`<p class="small muted" style="margin-bottom:10px">Sus precios y las listas de la compra pasan al producto que elijas y «${p.name}» desaparece.</p>
      <div class="input-group" style="margin-bottom:10px">${icon('search')}<input class="input" type="search" data-mq placeholder="Buscar producto…" aria-label="Buscar producto"></div>
      <div class="prod-pick" data-mlist></div>`,
  });
  const drawList = (qq = '') => {
    const n = qq.trim().toLowerCase();
    const list = others.filter((x) => !n || x.name.toLowerCase().includes(n)).slice(0, 60);
    $('[data-mlist]', s.el).innerHTML = String(html`${list.map((x) => html`<button type="button" class="prod-open" data-into="${x.id}">${productThumb(x, 'sm')}
      <span class="prod-txt"><b>${x.name}</b><small>${secOf(x.section).name}${x.best ? ` · ${plural(x.stores, 'súper', 'súper')} con precio` : ''}</small></span></button>`)}`);
  };
  drawList();
  on(s.el, 'input', '[data-mq]', (e, i) => drawList(i.value));
  focusLater($('[data-mq]', s.el), 150);
  on(s.el, 'click', '[data-into]', async (e, b) => {
    const to = others.find((x) => x.id === Number(b.dataset.into));
    const ok = await confirmDialog({ title: `¿Unir «${p.name}» con «${to.name}»?`, text: 'Queda solo «' + to.name + '», con todos los precios de los dos.', confirm: 'Unir' });
    if (!ok) return;
    try {
      await post(`/products/${p.id}/merge`, { into: to.id });
      notifyChange('products');
      toast(`Unido: ahora todo está en «${to.name}»`);
      s.close(to.id);
    } catch (err) {
      toastError(err);
    }
  });
  return s.done;
}

// ======================================================================
// Crear o editar un producto
// ======================================================================
export async function productForm(p = {}) {
  if (!can('edit')) return null;
  if (!SECTIONS.length) SECTIONS = await get('/shopping/sections').catch(() => []);
  const editing = !!p.id;
  let photoId = p.photo_id || null;
  const perKg = p.unit === 'kg' && p.unit_qty === 1;
  let sold = perKg ? 'kg' : 'pack';
  const s = sheet({
    title: editing ? 'Editar producto' : 'Nuevo producto',
    size: 'narrow',
    body: html`<form class="form" id="pf" autocomplete="off">
      <div class="prod-form-top">
        <div class="prod-photo" data-ph>${productThumb({ ...p, name: p.name || '?', photo_id: photoId }, 'lg')}</div>
        <div class="stack" style="gap:6px">
          <button type="button" class="btn sm" data-photo="camera">${icon('camera', 'sm')}Hacer foto</button>
          <button type="button" class="btn sm" data-photo="pick">${icon('image', 'sm')}Elegir foto</button>
          <button type="button" class="btn ghost sm" data-photo="remove" ${photoId ? '' : 'hidden'}>${icon('trash-2', 'sm')}Quitar</button>
        </div>
      </div>
      <div class="field"><label for="pf-n">Nombre</label><input class="input" id="pf-n" name="name" value="${p.name || ''}" maxlength="80" required placeholder="Salmón fresco, leche semidesnatada…"></div>
      <div class="field"><label for="pf-b">Marca o detalle <span class="muted">(opcional)</span></label>
        <input class="input" id="pf-b" name="note" value="${p.note || ''}" maxlength="120" placeholder="Hacendado, sin lactosa, bandeja familiar…"></div>
      <div class="field"><span class="label">Sección del súper</span>${chipPicker('section', SECTIONS.map((x) => ({ value: x.id, label: x.name, emoji: x.icon })), p.section || '', { optional: true })}
        <span class="hint" data-sec-hint>${editing ? '' : 'Si no eliges, se adivina por el nombre.'}</span></div>
      <div class="field"><span class="label">¿Cómo se vende?</span>
        <div class="segmented block sold" data-sold>
          <button type="button" data-v="pack" aria-pressed="${sold === 'pack'}">${icon('package', 'sm')}Por unidad o paquete</button>
          <button type="button" data-v="kg" aria-pressed="${sold === 'kg'}">${icon('weight', 'sm')}Al peso (€/kg)</button>
        </div></div>
      <div class="row" style="gap:10px;align-items:flex-end" data-pack ${sold === 'kg' ? 'hidden' : ''}>
        <div class="field" style="width:96px"><label for="pf-q">Cantidad</label><input class="input" id="pf-q" name="unit_qty" inputmode="decimal" value="${!perKg && p.unit_qty ? String(p.unit_qty).replace('.', ',') : ''}" placeholder="1"></div>
        <div class="field" style="width:150px"><label for="pf-u">Formato</label><select class="select" id="pf-u" name="unit">
          <option value="">Sin indicar</option>
          ${Object.entries(UNIT_NAMES).map(([k, n]) => html`<option value="${k}" ${!perKg && p.unit === k ? 'selected' : ''}>${n}</option>`)}</select></div>
      </div>
      <p class="hint" data-kg ${sold === 'kg' ? '' : 'hidden'}>Carne, pescado, fruta… Sus precios se anotan por kilo y se comparan por kilo entre supermercados.</p>
    </form>`,
    foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">${editing ? 'Guardar' : 'Crear producto'}</button>`,
  });
  const f = $('#pf', s.el);
  bindPickers(f);
  const paint = () => {
    $('[data-ph]', f).innerHTML = String(productThumb({ ...p, name: $('#pf-n', f).value || '?', section: $('input[name=section]', f).value || p.section, photo_id: photoId }, 'lg'));
    $('[data-photo=remove]', f).hidden = !photoId;
  };
  on(f, 'input', '#pf-n', paint);
  on(f, 'click', '[data-pick] [data-v]', () => setTimeout(paint));
  on(f, 'click', '[data-sold] button', (e, b) => {
    sold = b.dataset.v;
    f.querySelectorAll('[data-sold] button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('[data-pack]', f).hidden = sold === 'kg';
    $('[data-kg]', f).hidden = sold !== 'kg';
  });
  on(f, 'click', '[data-photo]', async (e, b) => {
    if (b.dataset.photo === 'remove') {
      photoId = null;
      return paint();
    }
    try {
      const file = await pickImage({ camera: b.dataset.photo === 'camera' });
      if (!file) return;
      const cropped = await cropPhoto(file, { square: true });
      if (!cropped) return;
      await withBusy(b, async () => {
        photoId = (await upload(cropped)).id;
        paint();
      });
    } catch (err) {
      toastError(err);
    }
  });
  on(s.el, 'click', '[data-act=save]', (e, btn) => withBusy(btn, async () => {
    const v = readForm(f);
    if (!v.name.trim()) return showFormError(f, 'Escribe el nombre del producto');
    const qty = Number(String(v.unit_qty || '').replace(',', '.'));
    if (sold === 'pack' && v.unit_qty && !(qty > 0)) return showFormError(f, 'La cantidad no es válida');
    const body = {
      name: v.name.trim(), note: v.note.trim(), section: v.section || null, photo_id: photoId,
      unit: sold === 'kg' ? 'kg' : v.unit || null, unit_qty: sold === 'kg' ? 1 : v.unit ? qty || 1 : null,
    };
    try {
      let id = p.id;
      if (editing) await patch(`/products/${p.id}`, body);
      else id = (await post('/products', body)).id;
      notifyChange('products');
      toast(editing ? `${body.name}: guardado` : `${body.name}: creado`);
      s.close(id);
    } catch (err) {
      showFormError(f, err.message);
    }
  }));
  focusLater($('#pf-n', f), 120);
  return s.done;
}

// Para otras pantallas: abrir la ficha de un producto por su nombre (la lista de la compra, por ejemplo).
export async function openProductByName(name) {
  const { products } = await get('/products');
  const p = products.find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase());
  if (p) return openProduct(p.id);
  const id = await productForm({ name });
  return id ? openProduct(id) : null;
}
