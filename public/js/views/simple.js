// Inicio en vista sencilla: lo esencial en grande (anotar, foto del ticket, la compra y cuánto llevamos).
import { get } from '../api.js';
import { html, icon, money, monthLabelFull, on, plural, relDay, thisMonth, today, skeletonPage } from '../ui.js';
import { can, store } from '../store.js';
import { openTxForm, pendingTxRows, pickTicket } from '../forms.js';
import { quickShopping } from '../actions.js';

export default async function simpleHome(ctx) {
  const hour = new Date().getHours();
  const hello = hour < 6 ? 'Buenas noches' : hour < 14 ? 'Buenos días' : hour < 21 ? 'Buenas tardes' : 'Buenas noches';
  ctx.setHeader(`${hello}, ${store.me.display_name.split(' ')[0]}`, monthLabelFull(thisMonth()));
  let d = null;

  async function load() {
    d = await get(`/stats/dashboard?month=${thisMonth()}`);
    if (ctx.isCurrent()) draw();
  }

  function draw() {
    const spent = d.totals.expense;
    const budget = d.budgetTotal || store.house.household.monthly_budget || 0;
    const left = budget - spent;
    const daysLeft = Math.max(1, d.days - d.dayNow + 1);
    const due = (d.upcoming || []).filter((x) => x.kind !== 'income' && (x.overdue || x.date <= today())).slice(0, 4);
    const list = (d.lists || [])[0];
    ctx.el.innerHTML = String(html`<div class="simple">
      ${can('edit') ? html`<div class="simple-actions">
        <button class="simple-big primary" data-s="add">${icon('plus')}<span>Anotar un gasto</span></button>
        <button class="simple-big" data-s="ticket">${icon('camera')}<span>Foto del ticket</span></button>
        <button class="simple-big" data-s="shop">${icon('shopping-cart')}<span>Añadir a la compra</span></button>
      </div>` : ''}
      <section class="simple-card simple-month">
        <span class="sm-label">Este mes llevamos gastado</span>
        <b class="sm-big">${money(spent)}</b>
        ${budget ? html`<div class="meter thick ${left < 0 ? 'over' : left < budget * 0.15 ? 'warn' : ''}" style="--c:var(--pine)"><div class="fill" style="width:${Math.min(1, spent / budget) * 100}%"></div></div>
          <p class="sm-sentence">${left >= 0 ? html`Quedan <b>${money(left, { decimals: 0 })}</b> para ${plural(daysLeft, 'día', 'días')}: unos <b>${money(Math.floor(left / daysLeft), { decimals: 0 })}</b> al día.` : html`Nos hemos pasado <b>${money(-left, { decimals: 0 })}</b> del presupuesto.`}</p>` : ''}
      </section>
      ${due.length ? html`<section class="simple-card"><h2>${icon('calendar-check')}Hoy toca pagar</h2>
        <div class="simple-rows">${due.map((x) => html`<div class="simple-row"><span class="grow">${x.title}<small class="${x.overdue ? 'neg' : ''}">${x.overdue ? 'Vencido' : relDay(x.date)}</small></span>
          <b>${x.amount ? money(x.amount) : ''}</b></div>`)}</div></section>` : ''}
      ${list ? html`<a class="simple-card simple-link" href="#/compra/${list.id}">${icon('shopping-cart')}<span><b>${list.name}</b>
        <small>${list.pending ? plural(list.pending, 'cosa por comprar', 'cosas por comprar') : 'No falta nada'}</small></span>${icon('chevron-right')}</a>` : ''}
      <section class="simple-card"><h2>${icon('list-ordered')}Lo último que se ha anotado</h2>
        ${pendingTxRows(store.hid)}
        ${d.recent.length ? html`<div class="simple-rows">${d.recent.slice(0, 6).map((t) => html`<button type="button" class="simple-row" data-tx="${t.id}">
          <span class="emoji">${t.category_icon || '❔'}</span><span class="grow">${t.description || t.merchant || t.category_name || 'Movimiento'}<small>${relDay(t.date)}${t.person_name ? ` · ${t.person_name}` : ''}</small></span>
          <b class="${t.kind === 'income' ? 'pos' : ''}">${t.kind === 'income' ? '+' : '−'}${money(t.amount)}</b></button>`)}</div>`
          : html`<p class="sm-sentence">Todavía no hay nada anotado este mes.</p>`}
        <a class="btn block" href="#/movimientos">Ver todos los movimientos</a></section>
    </div>`);
  }

  on(ctx.el, 'click', '[data-s=add]', () => openTxForm());
  on(ctx.el, 'click', '[data-s=ticket]', () => pickTicket().then((f) => f && openTxForm({ ticket: f })));
  on(ctx.el, 'click', '[data-s=shop]', () => quickShopping());
  on(ctx.el, 'click', '[data-tx]', (e, b) => {
    const t = d.recent.find((x) => x.id === Number(b.dataset.tx));
    if (t && can('edit')) openTxForm({ tx: t });
  });
  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
}
