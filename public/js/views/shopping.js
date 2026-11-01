// Lista de la compra compartida en tiempo real.
import { del, get, hurl, patch, post } from '../api.js';
import {
  $, amountStr, confirmDialog, html, icon, money, on, openMenu, parseAmount, plural, sheet, timeAgo, today, toast,
  toastError, withBusy, focusLater, skeletonPage,
} from '../ui.js';
import { can, categories, myPersonId, people, store } from '../store.js';
import {
  amountField, attachmentField, bindAmount, bindAttachment, bindDateQuick, bindPickers, catPicker, chipPicker, dateQuick, emojiPicker,
  intOrNull, methodOptions, notifyChange, personOptions, readForm, showFormError,
} from '../forms.js';
import { enableDragSort, enableSwipe, gestureHint, haptic, swipeRow } from '../gestures.js';
import { compareLabel, openListPrices, weightOf } from './prices.js';
import { openProduct, openProductByName } from './products.js';
import { enqueue, isOffline, newId, pending as pendingOps } from '../offline.js';

let SECTIONS = null;
let offlineToastAt = 0;
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

export default async function shoppingView(ctx) {
  let lists = [];
  let list = null;
  let listId = Number(ctx.params[0]) || null;
  let sugs = [];
  let showDone = false;
  let prevItems = new Map();
  let selecting = false;
  const selected = new Set();

  ctx.setHeader('Lista de la compra', '', html`<a class="btn ghost desktop-only" href="#/productos">${icon('package')}Productos</a>
    <a class="btn ghost desktop-only" href="#/precios">${icon('store')}Comparar precios</a>
    ${can('edit') ? html`<button class="btn" data-act="new-list">${icon('plus')}<span class="desktop-only">Nueva lista</span></button>` : ''}`);
  if (!SECTIONS) SECTIONS = await get('/shopping/sections').catch(() => []);
  const secInfo = (id) => SECTIONS.find((s) => s.id === id) || { id: 'otros', name: 'Otros', icon: '📦' };

  async function load({ quiet = false } = {}) {
    try {
      lists = await get('/shopping/lists');
      const active = lists.filter((l) => l.status === 'active');
      if (!listId || !lists.some((l) => l.id === listId)) listId = (active[0] || lists[0])?.id || null;
      if (listId) {
        [list, sugs] = await Promise.all([get(`/shopping/lists/${listId}`), get(`/shopping/suggestions?list=${listId}`).catch(() => [])]);
        overlayPending();
      } else list = null;
      if (!ctx.isCurrent()) return;
      draw(quiet);
    } catch (e) {
      toastError(e);
    }
  }

  function draw(highlight = false) {
    const active = lists.filter((l) => l.status === 'active');
    const done = lists.filter((l) => l.status === 'done');
    const changed = new Set();
    if (highlight && list) {
      for (const it of list.items) {
        const before = prevItems.get(it.id);
        if (!before || before.checked !== it.checked || before.name !== it.name || before.qty !== it.qty) changed.add(it.id);
      }
    }
    prevItems = new Map((list?.items || []).map((it) => [it.id, { checked: it.checked, name: it.name, qty: it.qty }]));
    if (!lists.length) {
      ctx.el.innerHTML = String(html`<div class="empty"><div class="art">🛒</div><h3>Sin listas de la compra</h3>
        <p>Crea una lista y compártela con tu familia: lo que añada o tache cada uno aparece al momento en los demás móviles.</p>
        ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="new-list">${icon('plus')}Crear lista</button></div>` : ''}</div>`);
      return;
    }
    const pending = list ? list.items.filter((i) => !i.checked) : [];
    const inCart = list ? list.items.filter((i) => i.checked) : [];
    const bySection = new Map();
    for (const it of pending) {
      const k = it.section || 'otros';
      if (!bySection.has(k)) bySection.set(k, []);
      bySection.get(k).push(it);
    }
    const order = SECTIONS.map((s) => s.id).filter((id) => bySection.has(id)).concat([...bySection.keys()].filter((k) => !SECTIONS.some((s) => s.id === k)));
    const cartEstimate = inCart.reduce((s, i) => s + (i.price || 0), 0);

    ctx.el.innerHTML = String(html`<div class="shop-layout ${selecting ? 'selecting' : ''}">
      <nav class="list-nav" aria-label="Listas">
        ${active.map((l) => listBtn(l))}
        ${done.length ? html`<button class="desktop-only" data-act="toggle-done" style="font-size:calc(13px * var(--fs));color:var(--ink-3)">${icon(showDone ? 'chevron-up' : 'chevron-down', 'sm')}Terminadas (${done.length})</button>
          ${showDone ? done.map((l) => listBtn(l)) : ''}` : ''}
      </nav>
      <div>${list ? html`
        <div class="row list-head" style="margin-bottom:14px;align-items:flex-start">
          <span class="emoji lh-ico">${list.icon}</span>
          <div class="grow" style="min-width:0"><h2 class="lh-name">${list.name}</h2>
            <div class="small muted">${[list.store, pending.length ? `${pending.length} por comprar` : 'Nada por comprar',
              list.purchases ? `${plural(list.purchases, 'compra hecha', 'compras hechas')} (${money(list.spent, { decimals: 0 })})` : ''].filter(Boolean).join(' · ')}</div></div>
          ${can('edit') && list.items.length ? html`<button class="btn sm" data-act="list-prices" aria-label="Precios por supermercado">${icon('tag', 'sm')}<span class="lh-lbl">Precios</span></button>` : ''}
          ${can('edit') ? html`<button class="btn ghost sm icon-only" data-act="list-menu" data-menu-anchor aria-label="Opciones de la lista">${icon('ellipsis-vertical')}</button>` : ''}
        </div>
        ${list.status === 'done' ? html`<div class="form-error" style="background:var(--surface-3);color:var(--ink-2);margin-bottom:12px">${icon('archive', 'sm')}
          <span>Lista terminada. <button class="btn ghost sm" data-act="reopen">Volver a usarla</button></span></div>` : ''}
        ${can('edit') ? html`<form class="add-item" data-add>
          <input class="input" name="name" placeholder="${matchMedia('(max-width: 640px)').matches ? 'Añadir: leche, pan…' : 'Añadir… (varios separados por comas)'}" autocomplete="off" enterkeyhint="send" aria-label="Añadir producto">
          ${Speech ? html`<button class="btn icon-only mic" type="button" data-act="voice" aria-label="Dictar por voz">${icon('mic')}</button>` : ''}
          <button class="btn primary" type="submit" aria-label="Añadir">${icon('plus')}</button></form>
          ${sugs.length ? html`<div class="sugs" aria-label="Sugerencias">${sugs.slice(0, 14).map((s) => html`<button class="chip" data-sug="${s.name}">${icon('plus')}${s.name}</button>`)}</div>` : ''}` : ''}
        ${pending.length ? order.map((k) => {
          const sec = secInfo(k);
          const items = bySection.get(k);
          return html`<div class="sec-head"><span class="emoji">${sec.icon}</span>${sec.name}<span class="c">${items.length}</span></div>
            <div class="items" data-drop data-section="${k}">${items.map((it) => itemRow(it, changed.has(it.id)))}</div>`;
        }) : html`<div class="empty" style="padding:36px 10px"><div class="art">${inCart.length ? '🧺' : '✨'}</div>
          <p>${inCart.length ? 'Todo está en el carro. Cuando pagues, pulsa «Terminar compra».' : 'La lista está vacía. Escribe arriba lo que haga falta.'}</p></div>`}
        ${inCart.length ? html`<div class="sec-head">${icon('shopping-cart', 'sm')}En el carro<span class="c">${inCart.length}</span>
          ${can('edit') ? html`<button class="btn ghost sm" data-act="clear" style="margin-left:auto">Quitar del todo</button>` : ''}</div>
          <div class="items">${inCart.map((it) => itemRow(it, changed.has(it.id)))}</div>` : ''}
        ${selecting ? html`<div class="selbar"><span class="t">${plural(selected.size, 'seleccionado', 'seleccionados')}</span>
          <button class="btn sm" data-bulk="check">${icon('check', 'sm')}Al carro</button>
          ${lists.filter((l) => l.status === 'active' && l.id !== listId).length ? html`<button class="btn sm" data-bulk="move" data-menu-anchor>${icon('arrow-left-right', 'sm')}Mover</button>` : ''}
          <button class="btn sm danger" data-bulk="delete">${icon('trash-2', 'sm')}Quitar</button>
          <button class="btn sm icon-only" data-bulk="cancel" aria-label="Terminar selección">${icon('x', 'sm')}</button></div>`
          : inCart.length && can('edit') ? html`<div class="cart-bar"><span class="t"><b>${plural(inCart.length, 'producto', 'productos')}</b> en el carro${cartEstimate ? ` · aprox. ${money(cartEstimate)}` : ''}</span>
          <button class="btn" data-act="complete">${icon('check')}Terminar compra</button></div>` : ''}
        ${list.purchases_list?.length ? html`<div class="section-title"><h2>Compras anteriores</h2></div>
          <div class="panel flush"><div class="rows" style="margin:0">${list.purchases_list.map((p) => html`<div class="rowi" style="padding:12px 18px">
            <span class="main-txt"><span class="title">${p.merchant || list.name}</span><span class="meta">${new Date(p.date + 'T12:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}</span></span>
            <span class="amount">${money(p.amount)}</span></div>`)}</div></div>` : ''}
      ` : ''}</div>
    </div>`);
  }

  const listBtn = (l) => html`<button data-list="${l.id}" aria-current="${l.id === listId}">
    <span class="ln-emoji emoji">${l.icon}</span><span class="grow" style="min-width:0"><span class="ln-name ellipsis" style="display:block">${l.name}</span>
    <span class="ln-meta">${l.status === 'done' ? 'Terminada' : l.items - l.checked ? `${l.items - l.checked} por comprar` : 'Nada pendiente'}</span></span></button>`;

  // Pista de precio: dónde es más barato y cuánto cuesta en la tienda de la lista.
  const hintFor = (it) => {
    const h = list?.hints?.[it.name.toLowerCase()];
    if (!h || it.checked) return '';
    // Lo que se vende al peso se compara por kilo; lo demás, por el precio del paquete.
    const say = (x) => compareLabel(x, h.base_unit).main;
    const cheaperElsewhere = h.best && h.here && h.best.store !== h.here.store && h.best.unit_price < h.here.unit_price * 0.97;
    if (cheaperElsewhere) return html`<small class="pos">Más barato en ${h.best.store}: ${say(h.best)} (aquí ${say(h.here)})</small>`;
    if (h.here) return html`<small>${say(h.here)} en ${h.here.store}${h.stores > 1 && h.best?.store === h.here.store ? ' · el más barato' : ''}</small>`;
    if (h.best) return html`<small>${say(h.best)} en ${h.best.store}</small>`;
    return '';
  };

  // Tocar la fila la tacha; mantener pulsado selecciona; deslizar → edita y ← quita; el asa permite moverla.
  const itemRow = (it, flash) => {
    const inner = html`<div class="item ${it.checked ? 'done' : ''} ${flash ? 'flash' : ''}" data-item="${it.id}" aria-selected="${selected.has(it.id)}">
      <span class="selbox"></span>
      <button class="check" data-check="${it.id}" aria-label="${it.checked ? 'Desmarcar' : 'Marcar como comprado'}: ${it.name}" ${can('edit') ? '' : 'disabled'}>
        <span>${icon('check')}</span></button>
      ${it.photo_id ? html`<span class="item-ph" aria-hidden="true"><img src="${hurl(`/attachments/${it.photo_id}`)}" alt="" loading="lazy"></span>` : ''}
      <button class="nm" data-check="${it.id}" style="border:0;background:none;text-align:left;padding:8px 0;cursor:pointer">
        <b>${it.name}${it.pending ? html` <span class="pend" title="Pendiente de enviar">${icon('clock', 'sm')}</span>` : ''}</b>${it.checked && it.checked_by_name ? html`<small>${it.checked_by_name}${it.checked_at ? ` · ${timeAgo(it.checked_at)}` : ''}</small>` : hintFor(it)}</button>
      ${it.qty ? html`<span class="qty">${it.qty}</span>` : ''}
      ${it.price ? html`<span class="pr">${money(it.price)}</span>` : ''}
      ${can('edit') ? html`<button class="btn ghost sm icon-only edit-btn" data-edit="${it.id}" aria-label="Editar ${it.name}">${icon('pencil', 'sm')}</button>` : ''}
      ${can('edit') && !it.checked && !selecting ? html`<button type="button" data-grip aria-label="Arrastrar para mover ${it.name}">${icon('grip-vertical', 'sm')}</button>` : ''}
    </div>`;
    if (!can('edit')) return html`<div class="sw" data-sw="${it.id}"><div class="sw-fg">${inner}</div></div>`;
    return swipeRow(inner, {
      id: it.id,
      left: { icon: 'pencil', label: 'Editar', tone: 'blue' },
      right: { icon: 'trash-2', label: 'Quitar', tone: 'red' },
    });
  };

  // Lo anotado sin conexión se ve ya en la lista (con un relojito) hasta que llega al servidor.
  function overlayPending() {
    if (!list) return;
    for (const op of pendingOps(store.hid)) {
      if (op.listId !== list.id) continue;
      if (op.kind === 'shop-check') {
        const it = list.items.find((x) => x.id === op.itemId);
        if (it) Object.assign(it, { checked: op.body.checked ? 1 : 0, pending: true, checked_by_name: store.me.display_name });
      } else if (op.kind === 'shop-add') {
        op.names.forEach((name, i) => {
          const id = -(op.id * 100 + i);
          if (!list.items.some((x) => x.id === id)) {
            list.items.push({ id, name: name.charAt(0).toUpperCase() + name.slice(1), qty: '', price: null, section: 'otros', checked: 0, pending: true, sort: 1e9 + id });
          }
        });
      }
    }
  }

  // ---------- Acciones ----------
  async function addItems(text) {
    const value = text.trim();
    if (!value || !listId) return;
    const cid = newId();
    try {
      list = await post(`/shopping/lists/${listId}/items`, { name: value, client_id: cid });
      sugs = sugs.filter((s) => !value.toLowerCase().split(/[,;\n]/).map((x) => x.trim()).includes(s.name.toLowerCase()));
      draw(true);
      $('[data-add] input', ctx.el)?.focus();
      lists = await get('/shopping/lists');
    } catch (e) {
      if (!isOffline(e)) return toastError(e);
      const names = value.split(/\n|,|;/).map((x) => x.trim()).filter(Boolean);
      await enqueue({
        hid: store.hid, kind: 'shop-add', method: 'POST', path: `/shopping/lists/${listId}/items`, body: { name: value, client_id: cid },
        listId, names, label: `A la compra: ${names.join(', ')}`,
      });
      overlayPending();
      draw(true);
      $('[data-add] input', ctx.el)?.focus();
      // El aviso se da una vez: el relojito ya indica lo que falta por enviar.
      if (Date.now() - offlineToastAt > 60000) toast('Sin conexión: se añadirá a la lista en cuanto vuelva la cobertura', { iconName: 'cloud-off' });
      offlineToastAt = Date.now();
    }
  }

  on(ctx.el, 'submit', '[data-add]', (e, form) => {
    e.preventDefault();
    const input = form.elements.name;
    const v = input.value;
    input.value = '';
    addItems(v);
  });
  on(ctx.el, 'click', '[data-sug]', (e, b) => addItems(b.dataset.sug));
  on(ctx.el, 'click', '[data-check]', async (e, b) => {
    const it = list.items.find((x) => x.id === Number(b.dataset.check));
    if (!it || !can('edit')) return;
    if (it.id < 0) return toast('Se podrá marcar en cuanto llegue a la lista (al volver la conexión)', { iconName: 'cloud-off' });
    if (selecting) return toggleSelect(it.id);
    haptic(8);
    it.checked = it.checked ? 0 : 1;
    it.checked_by_name = store.me.display_name;
    it.checked_at = new Date().toISOString();
    draw();
    try {
      list = await patch(`/shopping/items/${it.id}`, { checked: !!it.checked });
      prevItems.set(it.id, { checked: it.checked, name: it.name, qty: it.qty });
      overlayPending();
      draw();
    } catch (err) {
      if (isOffline(err)) {
        await enqueue({
          hid: store.hid, kind: 'shop-check', method: 'PATCH', path: `/shopping/items/${it.id}`, body: { checked: !!it.checked },
          listId, itemId: it.id, label: `${it.checked ? 'Comprado' : 'Por comprar'}: ${it.name}`,
        });
        it.pending = true;
        draw();
        return;
      }
      toastError(err);
      load();
    }
  });
  on(ctx.el, 'click', '[data-edit]', (e, b) => editItem(list.items.find((x) => x.id === Number(b.dataset.edit))));
  on(ctx.el, 'click', '[data-list]', (e, b) => {
    listId = Number(b.dataset.list);
    history.replaceState(null, '', `#/compra/${listId}`);
    load();
  });
  on(ctx.el, 'click', '[data-act=toggle-done]', () => {
    showDone = !showDone;
    draw();
  });
  on(ctx.el, 'click', '[data-act=clear]', async () => {
    try {
      list = await post(`/shopping/lists/${listId}/clear-checked`);
      draw();
    } catch (e) {
      toastError(e);
    }
  });
  on(ctx.el, 'click', '[data-act=reopen]', async () => {
    await patch(`/shopping/lists/${listId}`, { status: 'active' }).catch(toastError);
    load();
  });
  on(ctx.el, 'click', '[data-act=complete]', () => completeSheet());
  on(ctx.el, 'click', '[data-act=list-prices]', () => openListPrices(listId));
  on(ctx.el, 'click', '[data-act=new-list]', () => listForm());
  const headerEl = document.getElementById('page-actions');
  ctx.onCleanup(on(headerEl, 'click', '[data-act=new-list]', () => listForm()));
  on(ctx.el, 'click', '[data-act=list-menu]', (e, b) => openMenu(b, [
    { label: 'Poner precios por supermercado', icon: 'tag', onClick: () => openListPrices(listId) },
    { label: 'Comparar precios entre súper', icon: 'store', onClick: () => { location.hash = '#/precios'; } },
    { label: 'Productos: fotos, secciones y precios', icon: 'package', onClick: () => { location.hash = '#/productos'; } },
    { label: 'Cambiar nombre o tienda', icon: 'pencil', onClick: () => listForm(list) },
    { label: list.status === 'active' ? 'Archivar lista' : 'Volver a usarla', icon: 'archive', onClick: async () => {
      await patch(`/shopping/lists/${listId}`, { status: list.status === 'active' ? 'done' : 'active' }).catch(toastError);
      if (list.status === 'active') listId = null;
      load();
    } },
    'sep',
    { label: 'Borrar lista', icon: 'trash-2', danger: true, onClick: async () => {
      if (!(await confirmDialog({ title: `¿Borrar «${list.name}»?`, text: 'Se borrarán sus productos. Las compras ya anotadas en movimientos se conservan.', confirm: 'Borrar', danger: true }))) return;
      try {
        await del(`/shopping/lists/${listId}`);
        listId = null;
        notifyChange('shopping');
      } catch (err) {
        toastError(err);
      }
    } },
  ], { align: 'end' }));

  function editItem(it) {
    if (!it || !can('edit')) return;
    if (it.id < 0) return toast('Se podrá editar en cuanto llegue a la lista (al volver la conexión)', { iconName: 'cloud-off' });
    const s = sheet({
      title: 'Producto',
      size: 'narrow',
      body: html`<form class="form" id="itf">
        <div class="field"><label for="it-n">Nombre</label><input class="input" id="it-n" name="name" value="${it.name}" maxlength="80" required></div>
        <div class="grid-2">
          <div class="field"><label for="it-q">Cantidad</label><div class="stepper">
            <button type="button" data-step="-1" aria-label="Menos">${icon('minus', 'sm')}</button>
            <input class="input" id="it-q" name="qty" value="${it.qty}" maxlength="30" placeholder="1">
            <button type="button" data-step="1" aria-label="Más">${icon('plus', 'sm')}</button></div></div>
          <div class="field"><label for="it-p">Precio aprox.</label><div class="input-group"><input class="input" id="it-p" name="price" inputmode="decimal" value="${amountStr(it.price)}" placeholder="0,00" style="padding-left:13px"><span class="suffix">€</span></div></div>
        </div>
        <p class="hint" data-perkg style="margin-top:-6px"></p>
        <div class="field"><label for="it-st">Tienda del precio</label><input class="input" id="it-st" name="price_store" value="${list.store}" maxlength="60" placeholder="Mercadona, Lidl…"></div>
        <label class="switch"><input type="checkbox" name="save_price" checked><span class="track"></span><span class="txt">Guardar el precio en el comparador<small>Para saber en qué súper sale más barato.</small></span></label>
        <div class="field"><label>Sección del súper</label>${chipPicker('section', SECTIONS.map((x) => ({ value: x.id, label: x.name, emoji: x.icon })), it.section, { optional: false })}</div>
        <button type="button" class="link-row" data-act="product">${icon('package', 'sm')}<span>Ficha del producto<small>Foto, cómo se vende y precios en cada súper</small></span>${icon('chevron-right', 'sm')}</button>
      </form>`,
      foot: html`<button class="btn danger icon-only" data-act="del" aria-label="Quitar">${icon('trash-2')}</button><span class="spacer"></span>
        <button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const f = $('#itf', s.el);
    bindPickers(f);
    // Cantidad con +/−: respeta la unidad escrita ("2 kg" → "3 kg").
    on(f, 'click', '[data-step]', (e, b) => {
      const input = $('#it-q', f);
      const m = input.value.trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
      const n = m ? Number(m[1].replace(',', '.')) : input.value.trim() ? 1 : 0;
      const next = Math.max(0, n + Number(b.dataset.step));
      input.value = next ? `${String(next).replace('.', ',')}${m && m[2] ? ` ${m[2]}` : ''}` : '';
      haptic(8);
    });
    // Carne, pescado, fruta…: con el peso en la cantidad se sabe el precio por kilo.
    const h = list?.hints?.[it.name.toLowerCase()];
    const perKg = () => {
      const w = weightOf($('#it-q', f).value);
      const price = parseAmount($('#it-p', f).value);
      const box = $('[data-perkg]', f);
      if (w && price > 0) box.textContent = `Sale a ${money(price / w.n)} por ${w.base === 'l' ? 'litro' : 'kilo'}. Así se compara con otros supermercados.`;
      else if (h?.base_unit === 'kg' && !w) box.textContent = 'Se compara por kilo: pon el peso en la cantidad (por ejemplo, 800 g) y el precio que has pagado.';
      else box.textContent = '';
      box.classList.toggle('hidden', !box.textContent);
    };
    on(f, 'input', '#it-q, #it-p', perKg);
    on(f, 'click', '[data-act=product]', async () => {
      s.close();
      const changed = it.product_id ? await openProduct(it.product_id) : await openProductByName(it.name);
      if (changed) load();
    });
    on(f, 'click', '[data-step]', perKg);
    perKg();
    on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
      const v = readForm(f);
      const price = v.price ? parseAmount(v.price) : null;
      try {
        list = await patch(`/shopping/items/${it.id}`, {
          name: v.name, qty: v.qty, price: Number.isNaN(price) ? null : price, section: v.section,
          save_price: v.save_price && v.price_store.trim() && price > 0, price_store: v.price_store.trim(),
        });
        draw();
        s.close();
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=del]', async () => {
      try {
        list = await del(`/shopping/items/${it.id}`);
        draw();
        s.close();
      } catch (err) {
        toastError(err);
      }
    });
  }

  async function listForm(l = null) {
    const s = sheet({
      title: l ? 'Editar lista' : 'Nueva lista',
      size: 'narrow',
      body: html`<form class="form" id="lf">
        <div class="field"><label for="lf-n">Nombre</label><input class="input" id="lf-n" name="name" value="${l?.name || ''}" maxlength="60" required placeholder="Compra semanal, barbacoa, farmacia…"></div>
        <div class="field"><label for="lf-s">Tienda habitual</label><input class="input" id="lf-s" name="store" value="${l?.store || ''}" maxlength="60" placeholder="Mercadona, Lidl… (opcional)"></div>
        <div class="field"><label>Icono</label>${emojiPicker('icon', l?.icon || '🛒', ['🛒', '🧺', '🥦', '🎂', '🎉', '💊', '🏖️', '🎄', '🍖', '🧴', '🐾', '🧰'])}</div>
      </form>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">${l ? 'Guardar' : 'Crear lista'}</button>`,
    });
    const f = $('#lf', s.el);
    bindPickers(f);
    focusLater($('#lf-n', f), 50);
    const save = (e, b) => withBusy(b, async () => {
      const v = readForm(f);
      if (!v.name.trim()) return showFormError(f, 'Ponle un nombre a la lista');
      try {
        const r = l ? await patch(`/shopping/lists/${l.id}`, v) : await post('/shopping/lists', v);
        listId = r.id;
        history.replaceState(null, '', `#/compra/${listId}`);
        notifyChange('shopping');
        s.close();
      } catch (err) {
        showFormError(f, err.message);
      }
    });
    on(s.el, 'click', '[data-act=save]', save);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      save(e, $('[data-act=save]', s.el));
    });
  }

  function completeSheet() {
    const inCart = list.items.filter((i) => i.checked);
    const estimate = inCart.reduce((s, i) => s + (i.price || 0), 0) || null;
    const superCat = categories('expense').find((c) => /super|aliment|compra/i.test(c.name));
    const s = sheet({
      title: 'Terminar compra',
      body: html`<form class="form" id="cf">
        <p class="small muted" style="text-align:center">${plural(inCart.length, 'producto', 'productos')} en el carro. Escribe el total del ticket.</p>
        ${amountField('amount', estimate)}
        <div class="field"><label for="cf-m">Tienda</label><input class="input" id="cf-m" name="merchant" value="${list.store}" maxlength="80" placeholder="Mercadona, Lidl…"></div>
        ${dateQuick('date', today())}
        <div class="field"><label>Categoría</label>${catPicker('expense', superCat?.id ?? null)}</div>
        ${people().length ? html`<div class="field"><label>¿Quién ha pagado?</label>${chipPicker('person_id', personOptions(), myPersonId(), { scroll: true })}</div>` : ''}
        <div class="field"><label>Forma de pago</label>${chipPicker('method', methodOptions(), 'card', { scroll: true })}</div>
        ${attachmentField(null, { label: 'Foto del ticket', accept: 'image/*,application/pdf' })}
        ${inCart.some((i) => i.price) ? html`<label class="switch"><input type="checkbox" name="save_prices" checked><span class="track"></span><span class="txt">Guardar los precios en el comparador<small>Los ${inCart.filter((i) => i.price).length} productos del carro que tienen precio.</small></span></label>` : ''}
        <label class="switch"><input type="checkbox" name="archive"><span class="track"></span><span class="txt">Archivar la lista<small>Para listas de una sola vez (una fiesta, un viaje…).</small></span></label>
      </form>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn success" data-act="ok">${icon('check')}Anotar compra</button>`,
    });
    const f = $('#cf', s.el);
    bindAmount(f);
    bindDateQuick(f);
    bindPickers(f);
    bindAttachment(f);
    focusLater($('#f-amount', f), 80);
    on(s.el, 'click', '[data-act=ok]', (e, b) => withBusy(b, async () => {
      const v = readForm(f);
      const amount = parseAmount(v.amount);
      if (Number.isNaN(amount) || amount <= 0) return showFormError(f, 'Escribe el total del ticket');
      try {
        await post(`/shopping/lists/${listId}/complete`, {
          amount, date: v.date, merchant: v.merchant, category_id: intOrNull(v.category_id), person_id: intOrNull(v.person_id),
          method: v.method || null, attachment_id: intOrNull(v.attachment_id), archive: v.archive, save_prices: !!v.save_prices,
        });
        notifyChange('shopping');
        toast(`Compra anotada: ${money(amount)}`);
        s.close();
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
  }

  // ---------- Gestos: deslizar, mantener pulsado y arrastrar ----------
  function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    if (!selected.size) selecting = false;
    draw();
  }
  function startSelect(id) {
    selecting = true;
    selected.clear();
    if (id) selected.add(id);
    draw();
  }
  enableSwipe(ctx.el, {
    destructive: { right: true },
    onSwipe: async (el, action) => {
      const it = list.items.find((x) => x.id === Number(el.dataset.sw));
      if (!it) return;
      if (action === 'left') return editItem(it);
      const copy = { name: it.name, qty: it.qty, price: it.price, section: it.section };
      try {
        list = await del(`/shopping/items/${it.id}`);
        draw();
        toast(`${it.name} quitado de la lista`, {
          iconName: 'trash-2',
          action: { label: 'Deshacer', fn: async () => {
            list = await post(`/shopping/lists/${listId}/items`, copy);
            draw();
          } },
        });
      } catch (err) {
        toastError(err);
        draw();
      }
    },
    onLongPress: (el) => startSelect(Number(el.dataset.sw)),
  });
  enableDragSort(ctx.el, {
    onDrop: async (el, zone) => {
      const id = Number(el.dataset.sw);
      const it = list.items.find((x) => x.id === id);
      const ids = [...ctx.el.querySelectorAll('[data-drop] > .sw')].map((x) => Number(x.dataset.sw));
      const section = zone?.dataset.section;
      try {
        list = await post(`/shopping/lists/${listId}/reorder`, { ids, moved: section && it && section !== it.section ? { id, section } : null });
        draw();
        if (section && it && section !== it.section) toast(`${it.name} movido a ${secInfo(section).name}`);
      } catch (err) {
        toastError(err);
        load();
      }
    },
  });
  on(ctx.el, 'click', '[data-bulk]', async (e, b) => {
    const action = b.dataset.bulk;
    if (action === 'cancel') {
      selecting = false;
      selected.clear();
      return draw();
    }
    const ids = [...selected];
    const run = async (body, msg) => {
      try {
        list = await post('/shopping/items/bulk', { ids, ...body });
        selecting = false;
        selected.clear();
        draw();
        toast(msg);
        lists = await get('/shopping/lists');
      } catch (err) {
        toastError(err);
      }
    };
    if (action === 'move') {
      return openMenu(b, lists.filter((l) => l.status === 'active' && l.id !== listId).map((l) => ({
        label: `${l.icon}  ${l.name}`, onClick: () => run({ action: 'move', list_id: l.id }, `${plural(ids.length, 'producto movido', 'productos movidos')} a ${l.name}`),
      })));
    }
    if (action === 'delete') return run({ action: 'delete' }, `${plural(ids.length, 'producto quitado', 'productos quitados')}`);
    if (action === 'check') return run({ action: 'check' }, 'Al carro');
  });
  on(ctx.el, 'click', '[data-item]', (e, row) => {
    if (selecting && !e.target.closest('[data-check], [data-edit]')) toggleSelect(Number(row.dataset.item));
  });

  // Dictado por voz: «leche, pan y dos kilos de naranjas».
  on(ctx.el, 'click', '[data-act=voice]', (e, b) => {
    const rec = new Speech();
    rec.lang = 'es-ES';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    b.classList.add('listening');
    haptic(15);
    rec.onresult = (ev) => {
      const said = ev.results[0][0].transcript;
      const text = said.replace(/\s+y\s+/gi, ', ').replace(/\s+(también|además)\s+/gi, ', ');
      toast(`Añadido: ${text}`);
      addItems(text);
    };
    rec.onerror = (ev) => {
      if (ev.error !== 'no-speech' && ev.error !== 'aborted') toastError(new Error(ev.error === 'not-allowed' ? 'Permite el uso del micrófono para dictar' : 'No se ha podido escuchar'));
    };
    rec.onend = () => b.classList.remove('listening');
    rec.start();
  });

  ctx.setRefresh((evt) => load({ quiet: evt?.entity === 'shopping' && evt.by && evt.by !== store.me.id }));
  ctx.el.innerHTML = skeletonPage();
  await load();
  const items = ctx.el.querySelector('.items');
  if (items && can('edit')) {
    gestureHint(items.parentElement, 'shop', 'Toca para tachar · desliza → editar, ← quitar');
  }
}

