// Presupuestos: límite mensual del hogar y por categoría, con ritmo de gasto.
import { api, get } from '../api.js';
import { $, $$, amountStr, html, icon, money, monthLabelFull, on, parseAmount, pct, shiftMonth, thisMonth, toast, toastError, withBusy, skeletonPage } from '../ui.js';
import { can, categories, loadHouse, store } from '../store.js';
import { notifyChange } from '../forms.js';

export default async function budgetsView(ctx) {
  let month = thisMonth();
  let data = null;
  let editing = false;

  async function load() {
    try {
      data = await get(`/stats/dashboard?month=${month}`);
      if (ctx.isCurrent()) draw();
    } catch (e) {
      toastError(e);
    }
  }

  function draw() {
    ctx.setHeader('Presupuestos', 'Cuánto queréis gastar como máximo cada mes',
      can('admin') || can('edit') ? html`<button class="btn ${editing ? 'primary' : ''}" data-act="edit" aria-label="${editing ? 'Guardar' : 'Editar límites'}">${icon(editing ? 'check' : 'pencil')}<span class="${editing ? '' : 'desktop-only'}">${editing ? 'Guardar' : 'Editar límites'}</span></button>` : '');
    const spentBy = new Map(data.byCategory.map((c) => [c.id, c.total]));
    const prevBy = new Map(data.byCategory.map((c) => [c.id, c.prev]));
    const cats = categories('expense');
    const withBudget = cats.filter((c) => c.budget > 0);
    const without = cats.filter((c) => !(c.budget > 0));
    const expected = data.isCurrent ? data.dayNow / data.days : month < thisMonth() ? 1 : 0;
    const totalBudget = store.house.household.monthly_budget || withBudget.reduce((s, c) => s + c.budget, 0);
    const spent = data.totals.expense;
    const ratio = totalBudget ? spent / totalBudget : 0;

    const row = (c) => {
      const s = spentBy.get(c.id) || 0;
      const r = c.budget ? s / c.budget : 0;
      const left = (c.budget || 0) - s;
      return html`<div class="budget-row">
        <span class="cat-dot" style="--c:${c.color}"><span class="emoji">${c.icon}</span></span>
        <div class="top"><b class="ellipsis">${c.name}</b><span class="r">${money(s)}${c.budget ? html` de ${money(c.budget, { decimals: 0 })}` : ''}</span></div>
        ${editing ? html`<div class="edit"><div class="input-group"><input class="input sm" inputmode="decimal" data-budget="${c.id}" value="${amountStr(c.budget)}" placeholder="Sin límite" aria-label="Límite de ${c.name}"><span class="suffix">€</span></div></div>`
          : html`<div class="edit small ${left < 0 ? 'neg' : 'muted'}" style="text-align:right">${c.budget ? (left >= 0 ? `Quedan ${money(left, { decimals: 0 })}` : `+${money(-left, { decimals: 0 })} de más`) : `Mes pasado ${money(prevBy.get(c.id) || 0, { decimals: 0 })}`}</div>`}
        <div class="meter ${r > 1 ? 'over' : r > expected + 0.1 && r > 0.8 ? 'warn' : ''}" style="--c:${c.color}">
          <div class="fill" style="width:${c.budget ? Math.min(r, 1) * 100 : 0}%"></div>
          ${c.budget && expected > 0 && expected < 1 ? html`<div class="tick" style="left:${expected * 100}%" title="Dónde deberíais ir hoy"></div>` : ''}</div>
      </div>`;
    };

    ctx.el.innerHTML = String(html`
      <div class="filters"><div class="month-nav"><button data-m="-1" aria-label="Mes anterior">${icon('chevron-left')}</button>
        <span class="lbl" style="display:grid;place-items:center">${monthLabelFull(month)}</span>
        <button data-m="1" aria-label="Mes siguiente">${icon('chevron-right')}</button></div></div>
      <section class="panel" style="margin-bottom:20px">
        <div class="row between wrap" style="align-items:flex-end;gap:16px">
          <div><div class="small muted">Gastado en ${monthLabelFull(month).toLowerCase()}</div>
            <div style="font-size:calc(40px * var(--fs));font-weight:720;font-stretch:80%;letter-spacing:-.02em">${money(spent)}</div></div>
          <div style="text-align:right">
            ${editing && can('admin') ? html`<label class="small muted" for="hb">Presupuesto total del hogar</label>
              <div class="input-group" style="width:200px"><input class="input" id="hb" inputmode="decimal" value="${amountStr(store.house.household.monthly_budget)}" placeholder="Suma de categorías" style="padding-left:13px"><span class="suffix">€</span></div>`
              : html`<div class="small muted">Presupuesto</div><div style="font-size:calc(24px * var(--fs));font-weight:700;font-stretch:86%">${totalBudget ? money(totalBudget, { decimals: 0 }) : 'Sin definir'}</div>`}
          </div>
        </div>
        ${totalBudget ? html`<div class="meter thick ${ratio > 1 ? 'over' : ''}" style="margin-top:16px;--c:var(--cobalt)"><div class="fill" style="width:${Math.min(ratio, 1) * 100}%"></div>
          ${expected > 0 && expected < 1 ? html`<div class="tick" style="left:${expected * 100}%"></div>` : ''}</div>
          <p class="small ink-2" style="margin-top:10px">${ratio > 1 ? html`<span class="neg">Os habéis pasado ${money(spent - totalBudget, { decimals: 0 })}.</span>`
            : data.isCurrent ? html`Habéis gastado el ${pct(ratio)} con el ${pct(expected)} del mes transcurrido. ${ratio <= expected ? 'Vais bien.' : 'Vais algo rápido: frenad un poco.'}`
              : `Se gastó el ${pct(ratio)} del presupuesto.`}
            ${data.forecast && totalBudget ? html` Previsión al cierre: <b>${money(data.forecast.total, { decimals: 0 })}</b>.` : ''}</p>` : ''}
      </section>
      ${withBudget.length || editing ? html`<section class="panel"><div class="panel-head"><h2>Por categoría</h2>
        <span class="sub">La marca negra indica dónde deberíais ir hoy</span></div>
        <div>${(editing ? cats : withBudget).map(row)}</div></section>`
        : html`<div class="empty"><div class="art">🎯</div><h3>Aún no hay límites</h3><p>Pon un máximo mensual a las categorías que más se os van (súper, restaurantes, ocio…) y vigilad el ritmo durante el mes.</p>
          ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="edit">${icon('pencil')}Definir presupuestos</button></div>` : ''}</div>`}
      ${!editing && without.length && withBudget.length ? html`<div class="section-title"><h2>Sin límite</h2></div>
        <section class="panel"><div>${without.filter((c) => spentBy.get(c.id)).map(row)}</div>
        ${!without.some((c) => spentBy.get(c.id)) ? html`<p class="small muted">Sin gastos este mes en categorías sin límite.</p>` : ''}</section>` : ''}`);
  }

  async function save(btn) {
    await withBusy(btn, async () => {
      try {
        const inputs = $$('[data-budget]', ctx.el);
        for (const input of inputs) {
          const id = Number(input.dataset.budget);
          const c = store.house.categories.find((x) => x.id === id);
          const val = input.value.trim() ? parseAmount(input.value) : null;
          if (val !== null && Number.isNaN(val)) throw new Error(`Revisa el límite de ${c.name}`);
          if ((c.budget || null) !== (val || null)) await api(`/h/${store.hid}/categories/${id}`, { method: 'PATCH', body: { budget: val || null } });
        }
        const hb = $('#hb', ctx.el);
        if (hb) {
          const v = hb.value.trim() ? parseAmount(hb.value) : null;
          if ((store.house.household.monthly_budget || null) !== (v || null)) await api(`/h/${store.hid}`, { method: 'PATCH', body: { monthly_budget: v || null } });
        }
        await loadHouse();
        editing = false;
        notifyChange('categories');
        toast('Presupuestos guardados');
      } catch (e) {
        toastError(e);
      }
    });
  }

  const headerEl = document.getElementById('page-actions');
  ctx.onCleanup(on(headerEl, 'click', '[data-act=edit]', (e, b) => (editing ? save(b) : ((editing = true), draw()))));
  on(ctx.el, 'click', '[data-act=edit]', () => {
    editing = true;
    draw();
  });
  on(ctx.el, 'click', '[data-m]', (e, b) => {
    month = shiftMonth(month, Number(b.dataset.m));
    load();
  });
  ctx.setRefresh(() => (editing ? null : load()));
  ctx.el.innerHTML = skeletonPage();
  await load();
}
