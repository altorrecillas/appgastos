// Comparador de precios entre supermercados y cálculo del ahorro en la compra habitual.
import { get, post } from '../api.js';
import {
  $, fmtDate, html, icon, money, num, on, openMenu, parseAmount, pct, plural, promptDialog, sheet, today, toast, toastError,
  withBusy, focusLater, skeletonPage,
} from '../ui.js';
import { can } from '../store.js';
import { bindDateQuick, dateQuick, notifyChange, readForm, showFormError } from '../forms.js';
import { axisLabel, grid, mountChart, tipBox, tipHTML } from '../charts.js';
import { openProduct } from './products.js';
import { historyTab } from './pricehistory.js';

const UNIT_NAMES = { ud: 'unidad', kg: 'kg', g: 'g', l: 'litro', ml: 'ml', pack: 'paquete' };
const BASE_LABEL = { ud: 'ud', kg: 'kg', l: 'l', pack: 'paquete' };

// ¿Se anotó como precio por kilo (o por litro), al peso?
export const isPerBase = (p) => p.qty === 1 && ['kg', 'l'].includes(p.unit);

// Precio legible: el de la etiqueta y, si tiene sentido, el precio por kg o litro.
export const priceLabel = (p, baseUnit) => {
  if (isPerBase(p)) return { main: `${money(p.price)}/${p.unit}`, qty: p.unit === 'kg' ? 'al peso' : 'a granel', unit: '' };
  const qtyTxt = p.qty !== 1 || !['ud', 'pack'].includes(p.unit) ? `${num(p.qty, 3)} ${p.unit}` : '';
  return { main: money(p.price), qty: qtyTxt, unit: ['kg', 'l'].includes(baseUnit) ? `${money(p.unit_price)}/${BASE_LABEL[baseUnit]}` : '' };
};

// Peso o volumen escrito en la lista de la compra («800 g», «1,5 kg», «medio kilo», «75 cl») → { kg | l }.
// Igual que en el servidor (parseQty), pero solo hace falta saber si es un peso.
export const weightOf = (text) => {
  const t = String(text || '').trim().toLowerCase();
  if (/^(medio|1\/2)\s*(kg|kilo)$/.test(t)) return { n: 0.5, base: 'kg' };
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(kg|kilos?|g|gr|grs|gramos?|l|litros?|ml|cl)\.?$/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const f = { g: 0.001, gr: 0.001, grs: 0.001, gramo: 0.001, gramos: 0.001, ml: 0.001, cl: 0.01 }[m[2]] || 1;
  return n > 0 ? { n: n * f, base: /^(l|litros?|ml|cl)$/.test(m[2]) ? 'l' : 'kg' } : null;
};

// Para comparar en una fila: si se compara por kg o litro manda ese precio y debajo va el envase.
export const compareLabel = (p, baseUnit) => {
  if (!['kg', 'l'].includes(baseUnit)) {
    const l = priceLabel(p, baseUnit);
    return { main: l.main, sub: l.qty };
  }
  return { main: `${money(p.unit_price)}/${BASE_LABEL[baseUnit]}`, sub: isPerBase(p) ? (p.unit === 'kg' ? 'al peso' : 'a granel') : `${money(p.price)} · ${num(p.qty, 3)} ${p.unit}` };
};

export default async function pricesView(ctx) {
  let data = null;
  let basket = null;
  let basketList = '';
  let lists = [];
  let q = '';
  let tab = ctx.query.tab === 'historico' ? 'historico' : 'comparar';
  let hist = null;

  ctx.setHeader('Comparar precios', 'Lo que cuesta lo habitual en cada supermercado', html`
    <a class="btn ghost desktop-only" href="#/productos">${icon('package')}Productos</a>
    ${can('edit') ? html`<button class="btn primary" data-act="new-price">${icon('plus')}<span class="desktop-only">Anotar precio</span></button>` : ''}`);

  const tabs = () => html`<div class="tabs" role="tablist">
    <button role="tab" data-tab="comparar" aria-selected="${tab === 'comparar'}">${icon('store', 'sm')}<span class="long">Comparar supermercados</span><span class="short">Comparar</span></button>
    <button role="tab" data-tab="historico" aria-selected="${tab === 'historico'}">${icon('chart-line', 'sm')}<span class="long">Histórico e inflación</span><span class="short">Histórico</span></button>
  </div>`;

  async function load() {
    if (tab === 'historico') {
      if (hist) return hist.reload();
      ctx.el.innerHTML = String(html`${tabs()}<div data-hist></div>`);
      hist = await historyTab($('[data-hist]', ctx.el), { onOpenProduct: (id) => openProduct(id).then((ch) => ch && hist?.reload()) });
      return;
    }
    hist = null;
    try {
      [data, basket, lists] = await Promise.all([
        get('/prices'), get(`/prices/basket${basketList ? `?list=${basketList}` : ''}`), get('/shopping/lists'),
      ]);
      if (ctx.isCurrent()) draw();
    } catch (e) {
      toastError(e);
    }
  }

  // Colores fijos por tienda (siguen a la tienda, no a su posición en cada gráfico).
  const storeIndex = (store) => Math.max(0, data.stores.findIndex((s) => s.store.toLowerCase() === store.toLowerCase())) % 8;
  const storeColor = (store) => `var(--chart-${storeIndex(store) + 1})`;

  function draw() {
    if (!data.products.length) {
      ctx.el.innerHTML = String(html`${tabs()}<div class="empty"><div class="art">🏷️</div><h3>Compara precios entre supermercados</h3>
        <p>Anota lo que cuestan vuestros productos habituales en cada súper (o pon el precio al tachar cosas de la lista de la compra)
        y te diremos dónde sale más barata la compra y cuánto podéis ahorrar al mes.</p>
        ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="new-price">${icon('plus')}Anotar precios de un producto</button>
          ${lists.some((l) => l.status === 'active' && l.items) ? html`<button class="btn" data-act="list-prices">${icon('shopping-cart')}Poner precios a mi lista de la compra</button>` : ''}</div>` : ''}</div>`);
      return;
    }
    const stores = data.stores.slice(0, 6).map((s) => s.store);
    const filtered = data.products.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
    ctx.el.innerHTML = String(html`${tabs()}
      ${basketPanel()}
      <div class="section-title"><h2>Producto a producto</h2><span class="sub">último precio anotado en cada tienda</span></div>
      <div class="filters"><div class="input-group">${icon('search')}<input class="input sm" type="search" placeholder="Buscar producto…" value="${q}" data-q aria-label="Buscar producto"></div>
        <div class="row wrap small muted" style="gap:12px">${stores.map((s) => html`<span class="row" style="gap:6px"><i style="width:10px;height:10px;border-radius:3px;background:${storeColor(s)}"></i>${s}</span>`)}</div></div>
      <div class="panel flush"><div style="overflow-x:auto">
        <table class="table-view price-table">
          <thead><tr><th>Producto</th>${stores.map((s) => html`<th class="n">${s}</th>`)}<th class="n">Diferencia</th></tr></thead>
          <tbody>${filtered.map((p) => {
            const vals = stores.map((s) => p.stores[s] && ['kg', 'l', 'ud', 'pack'].includes(p.base_unit) ? p.stores[s] : null);
            const ups = vals.filter(Boolean).map((x) => x.unit_price);
            const min = Math.min(...ups);
            const max = Math.max(...ups);
            return html`<tr data-prod="${p.id}" style="cursor:pointer">
              <td><b>${p.name}</b>${p.change !== null && Math.abs(p.change) >= 0.02 ? html`<br><span class="tiny ${p.change > 0 ? 'neg' : 'pos'}">${p.change > 0 ? '▲' : '▼'} ${pct(Math.abs(p.change))} desde el primer precio</span>` : ''}</td>
              ${vals.map((x) => {
                if (!x) return html`<td class="n muted">—</td>`;
                const l = compareLabel(x, p.base_unit);
                const isMin = ups.length > 1 && x.unit_price === min;
                const isMax = ups.length > 1 && x.unit_price === max;
                return html`<td class="n"><span class="${isMin ? 'pill paid' : isMax ? 'neg' : ''}" style="${isMin ? 'font-size:calc(13.5px * var(--fs))' : ''}">${l.main}</span>
                  ${x.offer ? html`<span class="pill pending" style="height:18px;font-size:calc(10.5px * var(--fs));margin-left:4px">oferta</span>` : ''}
                  <br><span class="tiny muted">${l.sub || fmtDate(x.date)}</span></td>`;
              })}
              <td class="n">${ups.length > 1 ? html`<b>${pct(p.spread)}</b><br><span class="tiny muted">más barato en ${p.best.store}</span>` : html`<span class="tiny muted">solo en 1 tienda</span>`}</td>
            </tr>`;
          })}</tbody></table></div></div>
      <p class="small muted" style="margin-top:12px">Consejo: al editar un producto de la lista de la compra y poner su precio, se guarda aquí con la tienda de la lista.</p>`);
    drawBasketChart();
  }

  function basketPanel() {
    const b = basket;
    const chips = html`<div class="chips scroll" style="margin-bottom:14px">
      <button class="chip sm" data-basket="" aria-pressed="${!basketList}">Compra habitual</button>
      ${lists.filter((l) => l.status === 'active').map((l) => html`<button class="chip sm" data-basket="${l.id}" aria-pressed="${String(l.id) === basketList}">${l.icon} ${l.name}</button>`)}
      ${can('edit') && lists.some((l) => l.status === 'active' && l.items) ? html`<button class="chip sm" data-act="list-prices" style="border-color:var(--cobalt);color:var(--cobalt)">${icon('tag', 'sm')}Poner precios ${basketList ? 'a esta lista' : 'a una lista'}</button>` : ''}</div>`;
    if (!b.common || b.compared.length < 2) {
      return html`<section class="panel">${chips}<div class="panel-head"><h2>¿Dónde sale más barata la compra?</h2></div>
        <p class="ink-2">Hacen falta precios de los mismos productos en al menos dos supermercados para comparar.
        ${b.products ? `Ahora hay ${b.products} productos con precio, pero no coinciden en varias tiendas.` : ''}</p></section>`;
    }
    const cheapest = b.stores.find((s) => s.store === b.cheapest);
    const usual = b.stores.find((s) => s.store === b.usual);
    const same = b.cheapest === b.usual;
    return html`<section class="panel" style="border-color:var(--cobalt-line)">${chips}
      <div class="grid cols-2" style="gap:24px;align-items:center">
        <div class="stack" style="gap:12px">
          <h2 style="font-size:calc(24px * var(--fs));font-weight:720;font-stretch:86%;line-height:1.15">${same
            ? html`Ya compráis donde sale más barato: ${b.cheapest}`
            : html`${basketList ? 'Esta lista' : 'Vuestra compra habitual'} sale más barata en ${b.cheapest}`}</h2>
          <p class="ink-2">${plural(b.common, 'producto', 'productos')} con precio en ${b.compared.length} tiendas: <b>${money(cheapest.common_total)}</b> en ${b.cheapest}
            ${!same && usual ? html`frente a <b>${money(usual.common_total)}</b> en ${b.usual}, donde más compráis (un ${pct(b.saving_pct)} menos).` : '.'}</p>
          ${!same && b.monthly_saving > 0 ? html`<div class="hero-forecast" style="background:var(--pine-soft);color:var(--pine);margin:0;align-self:flex-start">
            ${icon('piggy-bank', 'sm')}<span>Con lo que gastáis en el súper (${money(b.monthly_super, { decimals: 0 })} al mes), ahorraríais unos
            <strong style="color:inherit">${money(b.monthly_saving, { decimals: 0 })} al mes</strong> (${money(b.monthly_saving * 12, { decimals: 0 })} al año).</span></div>` : ''}
          ${b.split_total && Object.keys(b.split_assignment).length > 1 ? html`<p class="small ink-2">Repartiendo la compra (cada producto donde es más barato) serían
            <b>${money(b.split_total)}</b>: ${`${Object.entries(b.split_assignment).map(([s, n]) => `${n} en ${s}`).join(', ')}.`}
            ${b.monthly_saving_split > b.monthly_saving ? `Ahorro estimado: ${money(b.monthly_saving_split, { decimals: 0 })} al mes.` : ''}</p>` : ''}
        </div>
        <div class="chart short" id="basket" role="img" aria-label="Coste de la cesta en cada supermercado"></div>
      </div>
      <details style="margin-top:12px"><summary class="small" style="cursor:pointer;color:var(--cobalt)">Ver la cesta comparada</summary>
        <div class="table-scroll" style="margin-top:8px"><table class="table-view"><thead><tr><th>Producto</th>${b.compared.map((s) => html`<th class="n">${s}</th>`)}</tr></thead>
        <tbody>${b.items.map((it) => {
          const min = Math.min(...Object.values(it.prices));
          return html`<tr><td>${it.name}</td>${b.compared.map((s) => html`<td class="n ${it.prices[s] === min ? 'pos' : ''}">${money(it.prices[s])}</td>`)}</tr>`;
        })}
        <tr><td><b>Total</b></td>${b.compared.map((s) => html`<td class="n"><b>${money(b.stores.find((x) => x.store === s).common_total)}</b></td>`)}</tr></tbody></table></div></details>
    </section>`;
  }

  function drawBasketChart() {
    const el = $('#basket', ctx.el);
    if (!el) return;
    const rows = basket.stores.filter((s) => s.common_total !== null).sort((a, b) => b.common_total - a.common_total);
    mountChart(el, (t) => ({
      animationDuration: 600,
      grid: grid({ left: 4, right: 70, top: 4, bottom: 4 }),
      tooltip: { ...tipBox(t), trigger: 'item', formatter: (p) => tipHTML(rows[p.dataIndex].store, [{ color: p.color, value: money(p.value), label: plural(basket.common, 'producto', 'productos'), box: true }]) },
      xAxis: { type: 'value', show: false, max: (v) => v.max * 1.02 },
      yAxis: { type: 'category', data: rows.map((r) => r.store), axisLine: { show: false }, axisTick: { show: false }, axisLabel: axisLabel(t, { fontSize: 13, color: t.ink2 }) },
      series: [{
        type: 'bar', barMaxWidth: 22,
        data: rows.map((r) => ({ value: r.common_total, itemStyle: { color: r.store === basket.cheapest ? t.pine : t.muted, borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: 'right', formatter: (p) => money(p.value), color: t.ink, fontFamily: t.font, fontWeight: 650, fontSize: 12.5 },
      }],
    }));
  }

  // ---------- Anotar precios ----------
  const priceForm = (preset = {}) => openPriceForm(preset);

  on(ctx.el, 'input', '[data-q]', (e, input) => {
    q = input.value;
    const pos = input.selectionStart;
    draw();
    const again = $('[data-q]', ctx.el);
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  on(ctx.el, 'click', '[data-prod]', async (e, row) => {
    if (await openProduct(Number(row.dataset.prod))) load();
  });
  on(ctx.el, 'click', '[data-basket]', async (e, b) => {
    basketList = b.dataset.basket;
    basket = await get(`/prices/basket${basketList ? `?list=${basketList}` : ''}`).catch(() => basket);
    draw();
  });
  on(ctx.el, 'click', '[data-act=new-price]', () => priceForm());
  on(ctx.el, 'click', '[data-tab]', (e, b) => {
    if (b.dataset.tab === tab) return;
    tab = b.dataset.tab;
    history.replaceState(null, '', tab === 'historico' ? '#/precios?tab=historico' : '#/precios');
    hist = null;
    ctx.el.innerHTML = skeletonPage();
    load();
  });
  on(ctx.el, 'click', '[data-act=list-prices]', async (e, b) => {
    const active = lists.filter((l) => l.status === 'active' && l.items);
    let id = Number(basketList) || (active.length === 1 ? active[0].id : null);
    if (!id && active.length > 1) {
      return openMenu(b, active.map((l) => ({ label: `${l.icon}  ${l.name}`, onClick: () => openListPrices(l.id).then(load) })));
    }
    if (id) {
      await openListPrices(id);
      load();
    }
  });
  ctx.onCleanup(on(document.getElementById('page-actions'), 'click', '[data-act=new-price]', () => priceForm()));
  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
  if (ctx.query.new) {
    history.replaceState(null, '', '#/precios');
    priceForm({ product: ctx.query.product || '' });
  }
}


// ======================================================================
// Anotar precios: un producto en varios supermercados a la vez.
// ======================================================================
const COMMON_STORES = ['Mercadona', 'Lidl', 'Carrefour', 'Dia', 'Alcampo', 'Aldi', 'Eroski', 'Consum', 'Ahorramás', 'BM', 'Gadis', 'Bonpreu'];
const norm = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const unitOptions = (sel, { perKg = false } = {}) => html`${perKg ? html`<option value="perkg" ${sel === 'perkg' ? 'selected' : ''}>Al peso</option>` : ''}
  ${Object.entries(UNIT_NAMES).map(([k, n]) => html`<option value="${k}" ${k === sel ? 'selected' : ''}>${n}</option>`)}`;

// Precios, listas activas y productos de las listas (para sugerir).
async function priceContext() {
  const [prices, lists] = await Promise.all([get('/prices'), get('/shopping/lists')]);
  const active = lists.filter((l) => l.status === 'active');
  const details = await Promise.all(active.map((l) => get(`/shopping/lists/${l.id}`)));
  const listItems = [];
  for (const l of details) {
    for (const it of l.items) {
      if (!listItems.some((x) => norm(x.name) === norm(it.name))) listItems.push({ name: it.name, list: l.name });
    }
  }
  const stores = [];
  for (const st of [...prices.stores.map((x) => x.store), ...active.map((l) => l.store)]) {
    if (st && !stores.some((x) => norm(x) === norm(st))) stores.push(st);
  }
  const byName = new Map(prices.products.map((p) => [norm(p.name), p]));
  return { prices, lists: active, details, listItems, stores, byName };
}

// Último precio de un producto en una tienda (si lo hay).
const lastAt = (c, name, store) => {
  const p = c.byName.get(norm(name));
  if (!p) return null;
  const hit = Object.entries(p.stores).find(([st]) => norm(st) === norm(store));
  return hit ? hit[1] : null;
};

export async function openPriceForm(preset = {}) {
  if (!can('edit')) return;
  let c;
  try {
    c = await priceContext();
  } catch (e) {
    return toastError(e);
  }
  const stores = [...c.stores];
  if (preset.store && !stores.some((x) => norm(x) === norm(preset.store))) stores.unshift(preset.store);
  const s = sheet({
    title: 'Anotar precios',
    body: html`<form class="form" id="prf" autocomplete="off">
      <div class="field ac"><label for="pr-p">Producto</label>
        <input class="input" id="pr-p" name="product" value="${preset.product || ''}" maxlength="80" placeholder="Toca para elegir o escribe uno nuevo" autocomplete="off">
        <div class="ac-list hidden" data-prodlist role="listbox"></div></div>
      ${c.listItems.length ? html`<div class="field"><span class="label">De tu lista de la compra</span>
        <div class="chips" data-listchips>${c.listItems.slice(0, 30).map((it) => html`<button type="button" class="chip sm" data-pick="${it.name}">${it.name}</button>`)}</div></div>` : ''}
      <div class="field"><span class="label">¿Cómo se vende?</span>
        <div class="segmented block sold" data-sold>
          <button type="button" data-v="pack" aria-pressed="true">${icon('package', 'sm')}Por unidad o paquete</button>
          <button type="button" data-v="kg" aria-pressed="false">${icon('weight', 'sm')}Al peso (€/kg)</button>
        </div></div>
      <div class="row" style="gap:10px;align-items:flex-end" data-pack>
        <div class="field" style="width:96px"><label for="pr-q">Cantidad</label><input class="input" id="pr-q" name="qty" inputmode="decimal" value="1"></div>
        <div class="field" style="width:140px"><label for="pr-u">Formato</label><select class="select" id="pr-u" name="unit">${unitOptions('ud')}</select></div>
        <span class="small muted" style="padding-bottom:12px" data-fmt-hint></span>
      </div>
      <p class="hint hidden" data-kg-hint style="margin-top:-6px">Escribe el precio del kilo que pone en la etiqueta o en el mostrador (carne, pescado, fruta…). Se compara por kilo con los demás supermercados, también con las bandejas de 500 g.</p>
      <div class="field"><span class="label">Precio en cada supermercado</span>
        <div class="stack" data-rows style="gap:10px"></div>
        <div class="chips" data-addstores style="margin-top:6px"></div>
        <span class="hint">Rellena solo los que sepas. Si un precio es de oferta, márcalo.</span></div>
      ${dateQuick('date', today())}
      <div class="field"><label for="pr-n">Nota</label><input class="input" id="pr-n" name="note" maxlength="120" placeholder="Marca, formato… (opcional)"></div>
    </form>`,
    foot: html`<span class="spacer"></span><button class="btn desktop-only" data-act="save-another">Guardar y otro producto</button>
      <button class="btn primary" data-act="save">Guardar precios</button>`,
  });
  const f = $('#prf', s.el);
  bindDateQuick(f);
  const input = $('#pr-p', f);
  const list = $('[data-prodlist]', f);
  // «pack»: precio del paquete con su cantidad y formato. «kg»: precio por kilo, al peso.
  let sold = 'pack';
  const setSold = (v) => {
    sold = v;
    f.querySelectorAll('[data-sold] button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    $('[data-pack]', f).classList.toggle('hidden', v === 'kg');
    $('[data-kg-hint]', f).classList.toggle('hidden', v !== 'kg');
  };
  // Lo último que se sabe de un precio, dicho en el modo del formulario.
  const lastText = (last) => {
    if (!last) return '';
    const when = ` el ${fmtDate(last.date)}${last.offer ? ' (oferta)' : ''}`;
    if (isPerBase(last)) return `Último: ${money(last.price)}/${last.unit}${when}`;
    const perKg = ['kg', 'g'].includes(last.unit) ? ` (${money(last.unit_price)}/kg)` : '';
    return `Último: ${money(last.price)} · ${num(last.qty, 3)} ${last.unit}${perKg}${when}`;
  };
  const lastPlaceholder = (last) => {
    if (!last) return '0,00';
    if (sold === 'kg') return ['kg', 'g'].includes(last.unit) ? amountFmt(Math.round(last.unit_price)) : '0,00';
    return isPerBase(last) ? '0,00' : amountFmt(last.price);
  };

  const drawRows = () => {
    const name = input.value.trim();
    const typed = Object.fromEntries([...f.querySelectorAll('[data-row]')].map((r) => [r.dataset.row, {
      price: $('[data-price]', r).value, offer: $('[data-offer]', r).getAttribute('aria-pressed'),
    }]));
    $('[data-rows]', f).innerHTML = String(html`${stores.length ? stores.map((st) => {
      const last = name ? lastAt(c, name, st) : null;
      const prev = typed[st] || {};
      return html`<div class="price-row" data-row="${st}">
        <span class="ps">${st}</span>
        <div class="input-group"><input class="input" inputmode="decimal" data-price value="${prev.price || ''}" placeholder="${lastPlaceholder(last)}"
          aria-label="${sold === 'kg' ? `Precio del kilo en ${st}` : `Precio en ${st}`}"><span class="suffix">${sold === 'kg' ? '€/kg' : '€'}</span></div>
        <button type="button" class="chip sm" data-offer aria-pressed="${prev.offer === 'true'}">Oferta</button>
        <span class="tiny muted up" data-up>${lastText(last)}</span>
      </div>`;
    }) : html`<p class="small muted">Añade los supermercados en los que compras:</p>`}`);
    const suggestions = COMMON_STORES.filter((x) => !stores.some((y) => norm(y) === norm(x))).slice(0, stores.length ? 4 : 8);
    $('[data-addstores]', f).innerHTML = String(html`${suggestions.map((x) => html`<button type="button" class="chip sm" data-addstore="${x}">${icon('plus', 'sm')}${x}</button>`)}
      <button type="button" class="chip sm" data-newstore>${icon('plus', 'sm')}Otro supermercado…</button>`);
    updateUnitPrices();
  };
  const updateUnitPrices = () => {
    if (sold === 'kg') return;
    const qty = Number(String($('#pr-q', f).value).replace(',', '.'));
    const unit = $('#pr-u', f).value;
    const factor = { g: 0.001, ml: 0.001 }[unit] || 1;
    const baseU = { g: 'kg', ml: 'l' }[unit] || unit;
    $('[data-fmt-hint]', f).textContent = ['kg', 'l'].includes(baseU) && !(qty === 1 && ['kg', 'l'].includes(unit)) ? `Se compara por ${baseU === 'l' ? 'litro' : 'kg'}` : '';
    f.querySelectorAll('[data-row]').forEach((r) => {
      const price = parseAmount($('[data-price]', r).value);
      if (price > 0 && qty > 0 && ['kg', 'l'].includes(baseU) && !(qty === 1 && ['kg', 'l'].includes(unit))) {
        $('[data-up]', r).textContent = `Sale a ${money(price / (qty * factor))} por ${baseU === 'l' ? 'litro' : 'kg'}`;
      }
    });
  };
  // Al elegir un producto: formato y últimos precios conocidos.
  const setProduct = (name) => {
    input.value = name;
    list.classList.add('hidden');
    const p = c.byName.get(norm(name));
    // Formato: el del último precio o, si aún no tiene, el de la ficha del producto.
    const cat = c.prices.catalog.find((x) => norm(x.name) === norm(name));
    const latest = (p ? Object.values(p.stores).sort((a, b) => b.date.localeCompare(a.date))[0] : null)
      || (cat?.unit ? { qty: cat.unit_qty, unit: cat.unit } : null);
    if (latest && latest.qty === 1 && latest.unit === 'kg') setSold('kg');
    else if (latest) {
      setSold('pack');
      $('#pr-q', f).value = String(latest.qty).replace('.', ',');
      $('#pr-u', f).value = latest.unit;
    }
    f.querySelectorAll('[data-pick]').forEach((b) => b.setAttribute('aria-pressed', String(norm(b.dataset.pick) === norm(name))));
    drawRows();
    const first = f.querySelector('[data-price]');
    if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
  };
  const showList = () => {
    const qn = norm(input.value);
    const names = [];
    const push = (name, group) => {
      if (!names.some((x) => norm(x.name) === norm(name)) && (!qn || norm(name).includes(qn))) names.push({ name, group });
    };
    c.listItems.forEach((it) => push(it.name, 'En tu lista de la compra'));
    c.prices.products.forEach((p) => push(p.name, 'Con precios anotados'));
    c.prices.catalog.forEach((p) => push(p.name, 'Productos habituales'));
    const exact = names.some((x) => norm(x.name) === qn);
    const shown = names.slice(0, 40);
    let lastGroup = '';
    list.innerHTML = String(html`${shown.map((x) => {
        const head = x.group !== lastGroup ? html`<div class="pal-cap">${x.group}</div>` : '';
        lastGroup = x.group;
        const p = c.byName.get(norm(x.name));
        return html`${head}<button type="button" data-opt="${x.name}"><span class="grow ellipsis">${x.name}</span>
          ${p?.best ? html`<span class="a">desde ${money(p.stores[p.best.store].price)} en ${p.best.store}</span>` : ''}</button>`;
      })}
      ${qn && !exact ? html`${shown.length ? html`<div class="pal-cap">Nuevo</div>` : ''}<button type="button" data-opt="${input.value.trim()}">${icon('plus', 'sm')}<span class="grow">Añadir «${input.value.trim()}» como producto nuevo</span></button>` : ''}
      ${!shown.length && !qn ? html`<div class="small muted" style="padding:10px">Aún no hay productos. Escribe el nombre del producto.</div>` : ''}`);
    list.classList.toggle('hidden', !list.innerHTML.trim());
  };
  input.addEventListener('focus', showList);
  input.addEventListener('input', () => {
    showList();
    drawRows();
  });
  input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 180));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Intro elige la primera sugerencia (o el texto tal cual si no hay ninguna).
      const first = list.classList.contains('hidden') ? null : list.querySelector('[data-opt]');
      setProduct(first ? first.dataset.opt : input.value.trim());
    }
  });
  on(list, 'mousedown', '[data-opt]', (e) => e.preventDefault());
  on(list, 'click', '[data-opt]', (e, b) => setProduct(b.dataset.opt));
  on(f, 'click', '[data-pick]', (e, b) => setProduct(b.dataset.pick));
  on(f, 'click', '[data-offer]', (e, b) => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
  on(f, 'click', '[data-sold] button', (e, b) => {
    if (b.dataset.v === sold) return;
    setSold(b.dataset.v);
    drawRows();
  });
  on(f, 'input', '[data-price], #pr-q', updateUnitPrices);
  on(f, 'change', '#pr-u', updateUnitPrices);
  on(f, 'click', '[data-addstore]', (e, b) => {
    stores.push(b.dataset.addstore);
    drawRows();
    f.querySelector(`[data-row="${CSS.escape(b.dataset.addstore)}"] [data-price]`)?.focus();
  });
  on(f, 'click', '[data-newstore]', async () => {
    const name = (await promptDialog({ title: 'Otro supermercado', label: 'Nombre', placeholder: 'Ahorramás, frutería del barrio…', confirm: 'Añadir' }))?.trim();
    if (name && !stores.some((x) => norm(x) === norm(name))) stores.push(name);
    drawRows();
  });

  const save = (another) => (e, btn) => withBusy(btn, async () => {
    const v = readForm(f);
    const product = input.value.trim();
    const qty = sold === 'kg' ? 1 : Number(String(v.qty).replace(',', '.'));
    const unit = sold === 'kg' ? 'kg' : v.unit;
    if (!product) return showFormError(f, 'Elige o escribe el producto');
    if (!(qty > 0)) return showFormError(f, 'La cantidad no es válida');
    const items = [];
    for (const r of f.querySelectorAll('[data-row]')) {
      const raw = $('[data-price]', r).value.trim();
      if (!raw) continue;
      const price = parseAmount(raw);
      if (Number.isNaN(price) || price <= 0) return showFormError(f, `Revisa el precio de ${r.dataset.row}`);
      items.push({ product, store: r.dataset.row, price, qty, unit, date: v.date, offer: $('[data-offer]', r).getAttribute('aria-pressed') === 'true', note: v.note });
    }
    if (!items.length) return showFormError(f, 'Escribe al menos un precio');
    try {
      await post('/prices/bulk', { items });
      notifyChange('prices');
      const cheapest = items.slice().sort((a, b) => a.price - b.price)[0];
      const shown = `${money(cheapest.price)}${sold === 'kg' ? '/kg' : ''}`;
      toast(items.length > 1 ? `${product}: ${items.length} precios guardados. Más barato en ${cheapest.store} (${shown})` : `${product}: ${shown} en ${cheapest.store}`);
      if (another) {
        c = await priceContext();
        input.value = '';
        f.querySelectorAll('[data-price]').forEach((x) => (x.value = ''));
        showFormError(f, '');
        drawRows();
        input.focus();
      } else s.close(true);
    } catch (err) {
      showFormError(f, err.message);
    }
  });
  on(s.el, 'click', '[data-act=save]', save(false));
  on(s.el, 'click', '[data-act=save-another]', save(true));
  drawRows();
  if (preset.product) setProduct(preset.product);
  else focusLater(input, 120);
  return s.done;
}

// ======================================================================
// Precios de una lista: «estoy en Lidl» y se apunta el precio de cada producto.
// ======================================================================
export async function openListPrices(listId, presetStore = '') {
  if (!can('edit')) return;
  let c;
  let list;
  try {
    [c, list] = await Promise.all([priceContext(), get(`/shopping/lists/${listId}`)]);
  } catch (e) {
    return toastError(e);
  }
  const stores = [...c.stores];
  let store = presetStore || list.store || stores[0] || '';
  if (store && !stores.some((x) => norm(x) === norm(store))) stores.unshift(store);
  const items = [];
  for (const it of [...list.items.filter((i) => !i.checked), ...list.items.filter((i) => i.checked)]) {
    if (!items.some((x) => norm(x.name) === norm(it.name))) items.push(it);
  }
  const s = sheet({
    title: `Precios de «${list.name}»`,
    size: 'wide',
    body: html`<div class="stack" style="gap:14px">
      <div class="field"><span class="label">¿En qué supermercado estás?</span><div class="chips" data-stores></div></div>
      <div data-items></div>
      <div data-summary></div>
    </div>`,
    foot: html`<span class="spacer"></span><button class="btn" data-close>Cerrar</button><button class="btn primary" data-act="save">Guardar precios</button>`,
  });
  const drawStores = () => {
    const suggestions = COMMON_STORES.filter((x) => !stores.some((y) => norm(y) === norm(x))).slice(0, stores.length ? 3 : 8);
    $('[data-stores]', s.el).innerHTML = String(html`${stores.map((st) => html`<button type="button" class="chip" data-store="${st}" aria-pressed="${norm(st) === norm(store)}">${icon('store', 'sm')}${st}</button>`)}
      ${suggestions.map((x) => html`<button type="button" class="chip" data-store="${x}" aria-pressed="false">${icon('plus', 'sm')}${x}</button>`)}
      <button type="button" class="chip" data-newstore>${icon('plus', 'sm')}Otro…</button>`);
    $('[data-act=save]', s.el).textContent = store ? `Guardar precios de ${store}` : 'Guardar precios';
  };
  const drawItems = () => {
    if (!items.length) {
      $('[data-items]', s.el).innerHTML = String(html`<p class="muted">La lista está vacía. Añade productos para comparar sus precios.</p>`);
      return;
    }
    if (!store) {
      $('[data-items]', s.el).innerHTML = String(html`<p class="muted">Elige arriba el supermercado y apunta el precio de cada producto.</p>`);
      return;
    }
    $('[data-items]', s.el).innerHTML = String(html`<div class="lp-head small muted"><span>Producto</span><span>Cantidad</span><span>Formato</span><span>Precio en ${store}</span></div>
      ${items.map((it) => {
        const last = lastAt(c, it.name, store);
        const p = c.byName.get(norm(it.name));
        const latestAny = p ? Object.values(p.stores).sort((a, b) => b.date.localeCompare(a.date))[0] : null;
        const cat = c.prices.catalog.find((x) => norm(x.name) === norm(it.name));
        const fmt = last || latestAny || (cat?.unit ? { qty: cat.unit_qty, unit: cat.unit, price: 0, unit_price: 0 } : null);
        const best = p?.best && norm(p.best.store) !== norm(store) ? p.stores[p.best.store] : null;
        const perKg = fmt && isPerBase(fmt) && fmt.unit === 'kg';
        const say = (x) => compareLabel(x, p.base_unit).main;
        return html`<div class="lp-row ${perKg ? 'perkg' : ''}" data-item="${it.name}">
          <div class="nm"><b>${it.name}</b><br><span class="tiny muted">${last ? `Último aquí: ${say(last)} (${fmtDate(last.date)})` : 'Sin precio aquí'}${best ? ` · En ${p.best.store}: ${say(best)}` : ''}</span></div>
          <input class="input sm" inputmode="decimal" data-qty value="${fmt && !perKg ? String(fmt.qty).replace('.', ',') : '1'}" aria-label="Cantidad de ${it.name}">
          <select class="select sm" data-unit aria-label="Formato de ${it.name}">${unitOptions(perKg ? 'perkg' : fmt?.unit || 'ud', { perKg: true })}</select>
          <div class="input-group"><input class="input sm" inputmode="decimal" data-price placeholder="${last ? amountFmt(perKg ? Math.round(last.unit_price) : last.price) : '0,00'}" aria-label="Precio de ${it.name} en ${store}"><span class="suffix">${perKg ? '€/kg' : '€'}</span></div>
        </div>`;
      })}`);
  };
  const drawSummary = async () => {
    const box = $('[data-summary]', s.el);
    try {
      const b = await get(`/prices/basket?list=${listId}`);
      if (!b.common || b.compared.length < 2) {
        box.innerHTML = String(html`<p class="small muted">${icon('info', 'sm')} Cuando tengas precios de la lista en dos o más supermercados, aquí verás dónde sale más barata.</p>`);
        return;
      }
      const rows = b.stores.filter((x) => x.common_total !== null).sort((x, y) => x.common_total - y.common_total);
      box.innerHTML = String(html`<div class="panel" style="background:var(--pine-soft);border-color:transparent;padding:14px 16px">
        <b>Esta lista sale más barata en ${b.cheapest}</b>
        <div class="small ink-2" style="margin-top:4px">${rows.map((x) => `${x.store}: ${money(x.common_total)}`).join(' · ')} <span class="muted">(${plural(b.common, 'producto comparable', 'productos comparables')})</span></div>
        ${b.split_total && Object.keys(b.split_assignment).length > 1 ? html`<div class="small ink-2">Comprando cada cosa donde es más barata: ${money(b.split_total)}.</div>` : ''}
      </div>`);
    } catch {
      box.innerHTML = '';
    }
  };
  // «€/kg, al peso»: el precio es el del kilo y la cantidad sobra.
  on(s.el, 'change', '[data-unit]', (e, sel) => {
    const row = sel.closest('[data-item]');
    row.classList.toggle('perkg', sel.value === 'perkg');
    $('.suffix', row).textContent = sel.value === 'perkg' ? '€/kg' : '€';
  });
  on(s.el, 'click', '[data-store]', (e, b) => {
    store = b.dataset.store;
    if (!stores.some((x) => norm(x) === norm(store))) stores.push(store);
    drawStores();
    drawItems();
  });
  on(s.el, 'click', '[data-newstore]', async () => {
    const name = (await promptDialog({ title: 'Otro supermercado', label: 'Nombre', placeholder: 'Ahorramás, frutería del barrio…', confirm: 'Añadir' }))?.trim();
    if (!name) return;
    if (!stores.some((x) => norm(x) === norm(name))) stores.push(name);
    store = name;
    drawStores();
    drawItems();
  });
  on(s.el, 'click', '[data-act=save]', (e, btn) => withBusy(btn, async () => {
    if (!store) return toastError(new Error('Elige primero el supermercado'));
    const out = [];
    for (const r of s.el.querySelectorAll('[data-item]')) {
      const raw = $('[data-price]', r).value.trim();
      if (!raw) continue;
      const price = parseAmount(raw);
      const perKg = $('[data-unit]', r).value === 'perkg';
      const qty = perKg ? 1 : Number(String($('[data-qty]', r).value).replace(',', '.'));
      if (Number.isNaN(price) || price <= 0) return toastError(new Error(`Revisa el precio de ${r.dataset.item}`));
      if (!(qty > 0)) return toastError(new Error(`Revisa la cantidad de ${r.dataset.item}`));
      out.push({ product: r.dataset.item, store, price, qty, unit: perKg ? 'kg' : $('[data-unit]', r).value, date: today() });
    }
    if (!out.length) return toastError(new Error('Escribe al menos un precio'));
    try {
      await post('/prices/bulk', { items: out });
      notifyChange('prices');
      toast(`${out.length} ${out.length === 1 ? 'precio guardado' : 'precios guardados'} en ${store}`);
      c = await priceContext();
      drawItems();
      drawSummary();
      s.body.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      toastError(err);
    }
  }));
  drawStores();
  drawItems();
  drawSummary();
  return s.done;
}

const amountFmt = (cents) => (cents / 100).toFixed(2).replace('.', ',');
