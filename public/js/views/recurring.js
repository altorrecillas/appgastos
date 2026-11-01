// Pagos fijos (e ingresos fijos como la nómina), compras a plazos y calendario de pagos.
import { del, get, patch, post } from '../api.js';
import {
  $, $$, FREQ_EVERY, FREQ_NAMES, METHOD_NAMES, addDays, amountStr, compactMoney, daysBetween, fmtDate, fmtDateFull, fmtDateLong,
  html, icon, money, monthLabel, monthLabelFull, monthShort, on, openMenu, parseAmount, plural, relDay, sheet, shiftMonth,
  thisMonth, today, toast, toastError, withBusy, confirmDialog, skeletonPage,
} from '../ui.js';
import { can, myPersonId, people } from '../store.js';
import {
  amountField, bindAmount, bindPickers, catPicker, chipPicker, intOrNull, methodOptions, notifyChange, personOptions, readForm,
  showFormError, focusFirst,
} from '../forms.js';
import { payBill, payRecurring, quickPayRecurring } from '../actions.js';
import { enableSwipe, gestureHint, swipeRow } from '../gestures.js';
import { segments } from './dashboard.js';
import { catAxis, grid, mountChart, tipBox, tipHTML, valAxis } from '../charts.js';

const NOTICE = [{ value: 0, label: 'No avisar' }, { value: 1, label: '1 día antes' }, { value: 3, label: '3 días antes' }, { value: 7, label: '1 semana antes' }];
const FREQ_M = { monthly: 1, bimonthly: 2, quarterly: 3, fourmonthly: 4, semiannual: 6, annual: 12 };
const FREQ_D = { weekly: 7, biweekly: 14 };
const pad = (n) => String(n).padStart(2, '0');
function addMonthsAnchored(s, months, anchor) {
  const [y, m] = s.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(anchor, new Date(ny, nm, 0).getDate()))}`;
}
export const nextOcc = (freq, from, start) =>
  FREQ_D[freq] ? addDays(from, FREQ_D[freq]) : addMonthsAnchored(from, FREQ_M[freq], Number(start.slice(8, 10)));

export default async function recurringView(ctx) {
  let tab = ['fijos', 'plazos', 'calendario'].includes(ctx.query.tab) ? ctx.query.tab : 'fijos';
  let rows = [];
  let calMonth = thisMonth();
  let calSel = today();
  let cal = null;

  const header = () => {
    const actions = can('edit')
      ? tab === 'plazos'
        ? html`<button class="btn primary" data-act="new-plan">${icon('plus')}<span class="desktop-only">Compra a plazos</span></button>`
        : html`<button class="btn soft desktop-only" data-act="new-income">${icon('arrow-down-right')}Ingreso fijo</button>
          <button class="btn primary" data-act="new-fixed">${icon('plus')}<span class="desktop-only">Pago fijo</span></button>`
      : '';
    ctx.setHeader('Pagos fijos y plazos', '', actions);
  };

  async function load() {
    try {
      rows = await get('/recurring');
      if (tab === 'calendario') cal = await get(`/stats/calendar?month=${calMonth}`);
      if (!ctx.isCurrent()) return;
      draw();
    } catch (e) {
      toastError(e);
    }
  }

  function draw() {
    header();
    ctx.el.innerHTML = String(html`
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="fijos" aria-selected="${tab === 'fijos'}">${icon('repeat', 'sm')}<span class="long">Pagos e ingresos fijos</span><span class="short">Fijos</span></button>
        <button role="tab" data-tab="plazos" aria-selected="${tab === 'plazos'}">${icon('calendar-clock', 'sm')}<span class="long">Compras a plazos</span><span class="short">Plazos</span>
          ${rows.filter((r) => r.plan === 'installment' && !r.finished).length ? html`<span class="badge blue">${rows.filter((r) => r.plan === 'installment' && !r.finished).length}</span>` : ''}</button>
        <button role="tab" data-tab="calendario" aria-selected="${tab === 'calendario'}">${icon('calendar-days', 'sm')}Calendario</button>
      </div>
      <div data-tabbody>${tab === 'fijos' ? fixedTab() : tab === 'plazos' ? plansTab() : calendarTab()}</div>`);
    if (tab === 'plazos') drawDebtChart();
  }

  // ---------- Pagos e ingresos fijos ----------
  function fixedTab() {
    const fixed = rows.filter((r) => r.plan === 'fixed');
    const active = fixed.filter((r) => r.active);
    const exp = active.filter((r) => r.kind === 'expense');
    const inc = active.filter((r) => r.kind === 'income');
    const plansMonthly = rows.filter((r) => r.plan === 'installment' && r.active && !r.finished).reduce((s, r) => s + r.monthly, 0);
    const expM = exp.reduce((s, r) => s + r.monthly, 0);
    const incM = inc.reduce((s, r) => s + r.monthly, 0);
    const free = incM - expM - plansMonthly;
    const soon = active.filter((r) => r.kind === 'expense' && daysBetween(today(), r.next_date) <= 7);
    const inactive = fixed.filter((r) => !r.active);
    if (!fixed.length) {
      return html`<div class="empty"><div class="art">🔁</div><h3>Sin pagos fijos todavía</h3>
        <p>Añade lo que pagas o cobras cada cierto tiempo: hipoteca o alquiler, luz, seguros, colegio, suscripciones… y también la nómina.
        Se anotan solos en su fecha y verás cuánto te queda libre cada mes.</p>
        ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="new-fixed">${icon('plus')}Añadir pago fijo</button>
          <button class="btn" data-act="new-income">${icon('arrow-down-right')}Añadir nómina u otro ingreso</button></div>` : ''}</div>`;
    }
    return html`
      <section class="stat-strip" style="margin-bottom:22px">
        <div class="stat"><span class="label">Ingresos fijos al mes</span><span class="value pos">${money(incM, { decimals: 0 })}</span>
          <span class="delta">${inc.length ? plural(inc.length, 'ingreso', 'ingresos') : 'añade tu nómina'}</span></div>
        <div class="stat"><span class="label">Gastos fijos al mes</span><span class="value">${money(expM, { decimals: 0 })}</span>
          <span class="delta">${plural(exp.length, 'pago', 'pagos')}, en equivalente mensual</span></div>
        <div class="stat"><span class="label">Cuotas de plazos</span><span class="value">${money(plansMonthly, { decimals: 0 })}</span><span class="delta">al mes</span></div>
        <div class="stat"><span class="label">Libre cada mes</span><span class="value ${free >= 0 ? 'pos' : 'neg'}">${money(free, { sign: true, decimals: 0 })}</span>
          <span class="delta">${incM ? `para el día a día: ${money(Math.max(free, 0) / 30.4, { decimals: 0 })}/día` : 'ingresos fijos − gastos fijos'}</span></div>
      </section>
      ${soon.length ? html`<p class="small ink-2" style="margin:-10px 0 18px">${icon('clock', 'sm')} En los próximos 7 días: ${soon.map((r) => `${r.name} (${money(r.amount)})`).join(', ')}.</p>` : ''}
      ${inc.length ? html`<div class="section-title"><h2>Ingresos fijos</h2><span class="sub">${money(incM)}/mes</span></div>
        <div class="panel flush"><div class="rows" style="margin:0">${inc.map(fixedRow)}</div></div>` : ''}
      <div class="section-title"><h2>Gastos fijos</h2><span class="sub">${money(expM)}/mes · ${money(expM * 12, { decimals: 0 })} al año</span></div>
      ${exp.length ? html`<div class="panel flush"><div class="rows" style="margin:0">${exp.map(fixedRow)}</div></div>`
        : html`<p class="muted">No hay gastos fijos activos.</p>`}
      ${inactive.length ? html`<div class="section-title"><h2>Pausados o terminados</h2></div>
        <div class="panel flush" style="opacity:.75"><div class="rows" style="margin:0">${inactive.map(fixedRow)}</div></div>` : ''}`;
  }

  function fixedRow(r) {
    const days = daysBetween(today(), r.next_date);
    const overdue = r.active && days < 0;
    const status = !r.active ? html`<span class="pill">Pausado</span>`
      : overdue ? html`<span class="pill overdue">Vencido ${relDay(r.next_date).toLowerCase()}</span>`
        : html`<span class="pill ${days <= 3 ? 'pending' : 'plain'}">${relDay(r.next_date)}</span>`;
    const canTick = can('edit') && r.active && !r.auto;
    const inner = html`<div class="rowi dense" style="padding:14px 18px">
      ${canTick ? html`<button class="tick" data-qpay="${r.id}" aria-label="${r.kind === 'income' ? 'Marcar como cobrado' : 'Marcar como pagado'}: ${r.name}"><span>${icon('check')}</span></button>` : ''}
      <span class="cat-dot" style="--c:${r.category_color || '#8A8F98'}"><span class="emoji">${r.category_icon || '🔁'}</span></span>
      <span class="main-txt"><button class="title" data-detail="${r.id}" style="border:0;background:none;padding:0;text-align:left;font:inherit;font-weight:600;cursor:pointer">${r.name}</button>
        <span class="meta"><span>${FREQ_NAMES[r.frequency]}</span>${r.provider ? html`<span class="sep"></span><span>${r.provider}</span>` : ''}
          <span class="sep"></span><span>${r.auto ? 'Se anota solo' : 'Manual'}</span>${r.variable ? html`<span class="sep"></span><span>Importe variable</span>` : ''}
          ${r.person_name ? html`<span class="sep"></span><span>${r.person_name}</span>` : ''}</span></span>
      <span class="side"><span class="amount ${r.kind === 'income' ? 'income' : ''}">${r.kind === 'income' ? '+' : ''}${money(r.amount)}</span>
        ${r.frequency !== 'monthly' ? html`<span class="tiny muted">${money(r.monthly)}/mes</span>` : html`<span class="tiny muted">${fmtDate(r.next_date)}</span>`}</span>
      <span class="desktop-only" style="width:120px;text-align:right">${status}</span>
      ${can('edit') ? html`<button class="btn ghost sm icon-only" data-menu="${r.id}" data-menu-anchor aria-label="Opciones">${icon('ellipsis-vertical')}</button>` : ''}
    </div>`;
    if (!can('edit')) return inner;
    return swipeRow(inner, {
      id: r.id,
      left: r.active ? { icon: 'check', label: r.kind === 'income' ? 'Cobrar' : 'Pagar', tone: 'green' } : null,
      right: { icon: 'pencil', label: 'Editar', tone: 'blue' },
    });
  }

  // ---------- Compras a plazos ----------
  function plansTab() {
    const plans = rows.filter((r) => r.plan === 'installment');
    const active = plans.filter((p) => !p.finished && p.active);
    const done = plans.filter((p) => p.finished || !p.active);
    if (!plans.length) {
      return html`<div class="empty"><div class="art">🛋️</div><h3>Ninguna compra a plazos</h3>
        <p>¿Has comprado un móvil, un electrodoméstico o un tratamiento a plazos? Indica el precio y en cuántos meses lo pagas:
        cada cuota se anotará sola como gasto hasta terminar.</p>
        ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="new-plan">${icon('plus')}Añadir compra a plazos</button></div>` : ''}</div>`;
    }
    const remaining = active.reduce((s, p) => s + p.remaining, 0);
    const monthly = active.reduce((s, p) => s + p.monthly, 0);
    const nextEnd = active.slice().sort((a, b) => a.end_date.localeCompare(b.end_date))[0];
    const lastEnd = active.slice().sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
    return html`
      <section class="stat-strip" style="margin-bottom:18px">
        <div class="stat"><span class="label">Pendiente de pagar</span><span class="value">${money(remaining, { decimals: 0 })}</span>
          <span class="delta">${plural(active.length, 'compra activa', 'compras activas')}</span></div>
        <div class="stat"><span class="label">Cuotas al mes</span><span class="value">${money(monthly, { decimals: 0 })}</span><span class="delta">se suman a tus gastos</span></div>
        <div class="stat"><span class="label">Próxima en terminar</span><span class="value" style="font-size:calc(20px * var(--fs))">${nextEnd ? nextEnd.name : '—'}</span>
          <span class="delta">${nextEnd ? `${monthLabel(nextEnd.end_date.slice(0, 7))} · ${plural(nextEnd.installments_left, 'cuota', 'cuotas')}` : ''}</span></div>
        <div class="stat"><span class="label">Libre de plazos</span><span class="value" style="font-size:calc(20px * var(--fs))">${lastEnd ? monthLabelFull(lastEnd.end_date.slice(0, 7)) : '¡Ya!'}</span>
          <span class="delta">cuando termine la última</span></div>
      </section>
      ${active.length ? html`<section class="panel" style="margin-bottom:18px"><div class="panel-head"><h2>Cómo baja lo que debes</h2>
        <span class="sub">pendiente al final de cada mes</span></div><div class="chart short" id="debt" role="img" aria-label="Deuda pendiente por mes"></div></section>` : ''}
      <div class="grid cols-2">${active.map(planCard)}</div>
      ${done.length ? html`<div class="section-title"><h2>Terminadas</h2><span class="sub">${plural(done.length, 'compra pagada', 'compras pagadas')}</span></div>
        <div class="grid cols-2">${done.map(planCard)}</div>` : ''}`;
  }

  function planCard(p) {
    const next = !p.finished && p.active;
    return html`<article class="plan-card ${p.finished ? 'finished' : ''}">
      <div class="plan-head">
        <span class="cat-dot lg" style="--c:${p.category_color || '#EDA100'}"><span class="emoji">${p.category_icon || '🛍️'}</span></span>
        <div class="grow" style="min-width:0"><div class="title ellipsis">${p.name}</div>
          <div class="meta">${[p.provider, p.person_name, p.purchase_date ? `comprado el ${fmtDateFull(p.purchase_date)}` : ''].filter(Boolean).join(' · ')}</div></div>
        ${p.finished ? html`<span class="pill paid">${icon('circle-check')}Pagado</span>` : ''}
        ${can('edit') ? html`<button class="btn ghost sm icon-only" data-menu="${p.id}" data-menu-anchor aria-label="Opciones">${icon('ellipsis-vertical')}</button>` : ''}
      </div>
      ${segments(p)}
      <div class="row between small"><span><b>${p.installments_done}</b> <span class="muted">de ${p.installments} cuotas pagadas</span></span>
        <span class="muted">${Math.round(p.progress * 100)} %</span></div>
      <div class="plan-figs">
        <div>Cuota<strong>${money(p.amount)}</strong></div>
        <div>Pagado<strong>${money(p.financed - p.remaining + (p.down_payment || 0))}</strong></div>
        <div>Pendiente<strong>${money(p.remaining)}</strong></div>
        <div>${p.finished ? 'Terminó' : 'Termina'}<strong>${monthLabel(p.end_date.slice(0, 7))}</strong></div>
      </div>
      <div class="row wrap small muted" style="gap:14px">
        <span>Precio total ${money(p.total_amount)}</span>
        ${p.down_payment ? html`<span>Entrada ${money(p.down_payment)}</span>` : ''}
        ${p.financing_cost > 0 ? html`<span class="neg">Financiar te cuesta ${money(p.financing_cost)} más</span>` : ''}
        ${next ? html`<span>Próxima cuota: ${relDay(p.next_date).toLowerCase()}${p.auto ? ' (automática)' : ''}</span>` : ''}
      </div>
      <div class="row" style="gap:8px">
        <button class="btn sm" data-detail="${p.id}">${icon('list-checks', 'sm')}Ver cuotas</button>
        ${next && !p.auto && can('edit') ? html`<button class="btn sm primary" data-pay="${p.id}">Pagar cuota</button>` : ''}
      </div>
    </article>`;
  }

  async function drawDebtChart() {
    const el = $('#debt', ctx.el);
    if (!el) return;
    const active = rows.filter((r) => r.plan === 'installment' && !r.finished && r.active);
    // Simula las cuotas pendientes de cada compra hasta que termine.
    const start = thisMonth();
    const months = [];
    const lastEnd = active.reduce((m, p) => (p.end_date > m ? p.end_date : m), start);
    for (let m = start; m <= lastEnd.slice(0, 7) && months.length < 72; m = shiftMonth(m, 1)) months.push(m);
    const series = active.map((p) => {
      let remaining = p.remaining;
      let d = p.next_date;
      let k = p.installments_done + 1;
      const byMonth = {};
      while (d <= p.end_date && k <= p.installments) {
        const amt = k === p.installments ? p.last_amount : p.amount;
        byMonth[d.slice(0, 7)] = (byMonth[d.slice(0, 7)] || 0) + amt;
        d = nextOcc(p.frequency, d, p.start_date);
        k++;
      }
      return {
        name: p.name, color: p.category_color,
        values: months.map((m) => {
          remaining -= byMonth[m] || 0;
          return Math.max(remaining, 0);
        }),
      };
    });
    const totals = months.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
    mountChart(el, (t) => ({
      animationDuration: 600,
      grid: grid({ top: 10 }),
      tooltip: {
        ...tipBox(t), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: t.axis } },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          const rowsT = series.filter((s) => s.values[i] > 0).map((s) => ({ color: t.saffron, value: money(s.values[i], { decimals: 0 }), label: s.name }));
          return tipHTML(`Al final de ${monthLabelFull(months[i]).toLowerCase()}`, [{ color: t.saffron, value: money(totals[i], { decimals: 0 }), label: 'en total', box: true }, ...rowsT]);
        },
      },
      xAxis: catAxis(t, months.map((m) => monthShort(m)), { boundaryGap: false }),
      yAxis: valAxis(t, { splitNumber: 3 }),
      series: [{
        type: 'line', step: 'end', data: totals, showSymbol: false, symbol: 'circle', symbolSize: 8,
        lineStyle: { width: 2, color: t.saffron }, itemStyle: { color: t.saffron }, areaStyle: { color: t.saffron, opacity: 0.12 },
      }],
    }));
  }

  // ---------- Calendario ----------
  function calendarTab() {
    if (!cal) return html`<div class="skeleton" style="height:520px"></div>`;
    const [y, m] = calMonth.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(y, m, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push({ date: addDays(`${calMonth}-01`, i - lead), out: true });
    for (let d = 1; d <= days; d++) cells.push({ date: `${calMonth}-${pad(d)}` });
    while (cells.length % 7) cells.push({ date: addDays(cells.at(-1).date, 1), out: true });
    const evBy = {};
    for (const e of cal.events) (evBy[e.date] ||= []).push(e);
    const spendBy = Object.fromEntries(cal.daily.map((d) => [d.date, d]));
    const sel = evBy[calSel] || [];
    const selSpend = spendBy[calSel];
    const monthPending = cal.events.filter((e) => e.status !== 'paid' && e.kind === 'expense' && e.amount).reduce((s, e) => s + e.amount, 0);
    const monthPaid = cal.events.filter((e) => e.status === 'paid' && e.kind === 'expense').reduce((s, e) => s + e.amount, 0);
    return html`
      <div class="filters">
        <div class="month-nav"><button data-cal="-1" aria-label="Mes anterior">${icon('chevron-left')}</button>
          <span class="lbl" style="display:grid;place-items:center">${monthLabelFull(calMonth)}</span>
          <button data-cal="1" aria-label="Mes siguiente">${icon('chevron-right')}</button></div>
        ${calMonth !== thisMonth() ? html`<button class="btn sm" data-cal="0">Hoy</button>` : ''}
        <span class="spacer"></span>
        <span class="small ink-2">Pagado <b>${money(monthPaid, { decimals: 0 })}</b> · Pendiente <b>${money(monthPending, { decimals: 0 })}</b></span>
      </div>
      <div class="cal" role="grid" aria-label="Calendario de pagos">
        ${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((d) => html`<div class="dow">${d}</div>`)}
        ${cells.map((c) => {
          const evs = evBy[c.date] || [];
          const sp = spendBy[c.date];
          return html`<button class="cell ${c.out ? 'out' : ''} ${c.date === today() ? 'today' : ''}" data-day="${c.date}" aria-selected="${c.date === calSel}" role="gridcell">
            <span class="dn">${Number(c.date.slice(8))}</span>
            <span class="evs stack" style="gap:3px">${evs.slice(0, 3).map((e) => html`<span class="ev ${e.type} ${e.status}"><span class="x">${e.title}</span></span>`)}</span>
            ${evs.length > 3 ? html`<span class="more">+${evs.length - 3} más</span>` : ''}
            ${sp?.expense ? html`<span class="spend">−${compactMoney(sp.expense)}</span>` : ''}
          </button>`;
        })}
      </div>
      <div class="cal-legend">
        <span><i style="background:var(--cobalt)"></i>Pago fijo</span><span><i style="background:var(--saffron)"></i>Cuota de plazos</span>
        <span><i style="background:#6250d6"></i>Factura</span><span><i style="background:#8c6d46"></i>Mascotas</span><span><i style="background:var(--pine)"></i>Recordatorio</span>
        <span class="muted">Atenuado: ya pagado</span>
      </div>
      <section class="panel" style="margin-top:18px"><div class="panel-head"><h2>${fmtDateLong(calSel)}</h2>
        ${selSpend ? html`<span class="sub">${selSpend.expense ? `Gastado ${money(selSpend.expense)}` : ''}${selSpend.income ? ` · Ingresado ${money(selSpend.income)}` : ''}</span>` : ''}
        <div class="actions">${can('edit') ? html`<a class="btn ghost sm" href="#/recordatorios?new=1&date=${calSel}">${icon('plus', 'sm')}Recordatorio</a>` : ''}<a class="btn ghost sm" href="#/movimientos?period=custom&from=${calSel}&to=${calSel}">Movimientos del día</a></div></div>
        ${sel.length ? html`<div class="rows">${sel.map((e, i) => html`<div class="rowi">
          <span class="tl-item" style="padding:0"><span class="ico ${e.type}">${icon({ recurring: 'repeat', installment: 'calendar-clock', bill: 'receipt', pet: 'paw-print', reminder: 'calendar-check' }[e.type])}</span></span>
          <span class="main-txt"><span class="title">${e.title}</span><span class="meta">${e.subtitle || ''}${e.auto && e.status !== 'paid' ? ' Se anotará solo' : ''}</span></span>
          ${e.amount ? html`<span class="amount ${e.kind === 'income' ? 'income' : ''}">${money(e.amount)}</span>` : ''}
          <span class="pill ${e.status}">${{ paid: 'Pagado', pending: 'Pendiente', overdue: 'Vencido' }[e.status]}</span>
          ${e.status !== 'paid' && can('edit') && !['pet', 'reminder'].includes(e.type) && !(e.auto && e.status === 'pending') ? html`<button class="btn sm" data-calpay="${i}">Pagar</button>` : ''}
          ${e.type === 'reminder' ? html`<a class="btn sm ghost" href="#/recordatorios">Ver</a>` : ''}
        </div>`)}</div>` : html`<p class="muted small">Nada programado este día.</p>`}
      </section>`;
  }

  // ---------- Formularios ----------
  function fixedForm(rec = null, kind = 'expense', prefill = {}) {
    if (!can('edit')) return;
    const editing = !!rec;
    const d = {
      kind, name: '', provider: '', amount: null, variable: 0, frequency: 'monthly', start_date: today(), end_date: '', category_id: null,
      person_id: kind === 'income' ? myPersonId() : null, method: kind === 'income' ? 'transfer' : 'direct_debit', auto: 1, remind_days: 3, notes: '',
      ...prefill,
      ...(rec || {}),
    };
    const body = (k) => html`<form class="form" id="rf" autocomplete="off">
      <div class="segmented block kind" data-rkind>
        <button type="button" data-v="expense" aria-pressed="${k === 'expense'}">${icon('arrow-up-right', 'sm')}Gasto fijo</button>
        <button type="button" data-v="income" aria-pressed="${k === 'income'}">${icon('arrow-down-right', 'sm')}Ingreso fijo</button>
      </div>
      <input type="hidden" name="kind" value="${k}">
      <div class="grid-2">
        <div class="field"><label for="rf-name">Nombre</label><input class="input" id="rf-name" name="name" value="${d.name}" required maxlength="60"
          placeholder="${k === 'income' ? 'Nómina, pensión, alquiler cobrado…' : 'Hipoteca, luz, Netflix, seguro…'}" data-autofocus></div>
        <div class="field"><label for="rf-prov">${k === 'income' ? 'Pagador' : 'Proveedor'}</label><input class="input" id="rf-prov" name="provider" value="${d.provider}" maxlength="60" placeholder="Opcional"></div>
      </div>
      ${amountField('amount', d.amount, { kind: k })}
      <label class="switch" style="justify-content:center"><input type="checkbox" name="variable" ${d.variable ? 'checked' : ''}><span class="track"></span>
        <span class="txt">El importe cambia cada vez<small>${k === 'income' ? 'Pon una cantidad aproximada: al cobrar podrás ajustarla.' : 'Luz, agua… Pon una estimación; al pagar podrás ajustarla.'}</small></span></label>
      <div class="field"><label>¿Cada cuánto?</label>${chipPicker('frequency', Object.entries(FREQ_NAMES).map(([value, label]) => ({ value, label })), d.frequency, { optional: false })}</div>
      <div class="grid-2">
        <div class="field"><label for="rf-start">${editing ? 'Próximo pago' : 'Fecha del próximo pago'}</label>
          <input class="input" type="date" id="rf-start" name="${editing ? 'next_date' : 'start_date'}" value="${editing ? d.next_date : d.start_date}" required></div>
        <div class="field"><label for="rf-end">Último pago <span class="muted">(opcional)</span></label>
          <input class="input" type="date" id="rf-end" name="end_date" value="${d.end_date || ''}"><span class="hint">Déjalo vacío si no tiene fin.</span></div>
      </div>
      <div class="field" data-past hidden><label class="switch"><input type="checkbox" name="include_past"><span class="track"></span>
        <span class="txt">Anotar también los pagos ya pasados<small>Desde esa fecha hasta hoy, para que aparezcan en el historial.</small></span></label></div>
      <div class="field"><label>Categoría</label>${catPicker(k, d.category_id)}</div>
      ${people().length ? html`<div class="field"><label>${k === 'income' ? '¿De quién es?' : '¿Para quién?'}</label>${chipPicker('person_id', personOptions(), d.person_id, { scroll: true })}</div>` : ''}
      ${k === 'expense' ? html`<div class="field"><label>Forma de pago</label>${chipPicker('method', methodOptions(), d.method, { scroll: true })}</div>` : ''}
      <label class="switch"><input type="checkbox" name="auto" ${d.auto ? 'checked' : ''}><span class="track"></span>
        <span class="txt">${k === 'income' ? 'Anotar el cobro automáticamente' : 'Anotar el pago automáticamente'}<small>En su fecha se añadirá solo a movimientos. Si lo desactivas, te avisaremos para que lo marques tú.</small></span></label>
      <div class="field"><label>Recordatorio en el móvil</label>${chipPicker('remind_days', NOTICE, d.remind_days ?? 3, { optional: false })}</div>
      <div class="field"><label for="rf-notes">Notas</label><textarea class="textarea" id="rf-notes" name="notes" maxlength="1000" placeholder="Nº de contrato, póliza…">${d.notes}</textarea></div>
    </form>`;
    const s = sheet({
      title: editing ? `Editar ${d.kind === 'income' ? 'ingreso' : 'pago'} fijo` : kind === 'income' ? 'Nuevo ingreso fijo' : 'Nuevo pago fijo',
      body: body(d.kind),
      foot: html`${editing ? html`<button class="btn danger icon-only" data-act="del" aria-label="Borrar">${icon('trash-2')}</button>` : ''}
        <span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const bind = () => {
      const form = $('#rf', s.el);
      bindAmount(form);
      focusFirst(form);
      const start = $('#rf-start', form);
      const past = $('[data-past]', form);
      const upd = () => (past.hidden = editing || !(start.value && start.value < today()));
      start.addEventListener('change', upd);
      upd();
    };
    bindPickers(s.body);
    on(s.body, 'click', '[data-rkind] [data-v]', (e, b) => {
      const v = readForm($('#rf', s.el));
      if (v.kind === b.dataset.v) return;
      Object.assign(d, { name: v.name, provider: v.provider, amount: parseAmount(v.amount) || null, category_id: null, kind: b.dataset.v });
      s.body.innerHTML = String(body(b.dataset.v));
      bind();
    });
    on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
      const form = $('#rf', s.el);
      const v = readForm(form);
      const amount = parseAmount(v.amount);
      if (!v.name.trim()) return showFormError(form, 'Ponle un nombre');
      if (Number.isNaN(amount) || amount <= 0) return showFormError(form, 'Escribe el importe');
      const payload = {
        kind: v.kind, plan: 'fixed', name: v.name, provider: v.provider, amount, variable: v.variable, frequency: v.frequency,
        end_date: v.end_date || null, category_id: intOrNull(v.category_id), person_id: intOrNull(v.person_id),
        method: v.kind === 'income' ? 'transfer' : v.method || null, auto: v.auto, notes: v.notes, remind_days: Number(v.remind_days || 0),
      };
      try {
        if (editing) {
          payload.next_date = v.next_date;
          delete payload.plan;
          await patch(`/recurring/${rec.id}`, payload);
        } else {
          payload.start_date = v.start_date;
          payload.include_past = !!v.include_past;
          await post('/recurring', payload);
        }
        notifyChange('recurring');
        toast(editing ? 'Cambios guardados' : `${payload.kind === 'income' ? 'Ingreso' : 'Pago'} fijo añadido`);
        s.close(true);
      } catch (err) {
        showFormError(form, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=del]', () => removeRec(rec, s));
    bind();
  }

  function planForm(rec = null) {
    if (!can('edit')) return;
    const editing = !!rec;
    const t = today();
    const d = {
      name: '', provider: '', total_amount: null, down_payment: null, cash_price: null, installments: 12, frequency: 'monthly',
      purchase_date: t, start_date: addMonthsAnchored(t, 1, Number(t.slice(8))), category_id: null, person_id: myPersonId(), method: 'card', auto: 1, notes: '',
      ...(rec || {}),
    };
    const s = sheet({
      title: editing ? 'Editar compra a plazos' : 'Nueva compra a plazos',
      body: html`<form class="form" id="pf" autocomplete="off">
        <div class="grid-2">
          <div class="field"><label for="pf-name">¿Qué has comprado?</label><input class="input" id="pf-name" name="name" value="${d.name}" required maxlength="60"
            placeholder="Frigorífico, móvil, sofá, ortodoncia…" data-autofocus></div>
          <div class="field"><label for="pf-prov">Tienda o financiera</label><input class="input" id="pf-prov" name="provider" value="${d.provider}" maxlength="60" placeholder="Opcional"></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="pf-total">Precio total a pagar</label>
            <div class="input-group"><input class="input" id="pf-total" name="total_amount" inputmode="decimal" value="${amountStr(d.total_amount)}" placeholder="0,00" style="padding-left:13px"><span class="suffix">€</span></div>
            <span class="hint">Con intereses incluidos, si los hay.</span></div>
          <div class="field"><label for="pf-down">Entrada <span class="muted">(opcional)</span></label>
            <div class="input-group"><input class="input" id="pf-down" name="down_payment" inputmode="decimal" value="${amountStr(d.down_payment)}" placeholder="0,00" style="padding-left:13px"><span class="suffix">€</span></div>
            <span class="hint">Lo que pagaste al comprarlo.</span></div>
        </div>
        <div class="field"><label for="pf-n">Número de cuotas</label>
          <div class="row wrap" style="gap:8px"><input class="input" id="pf-n" name="installments" type="number" min="1" max="600" value="${d.installments}" style="width:110px">
            <div class="chips" data-nq>${[3, 6, 10, 12, 18, 24, 36, 48].map((n) => html`<button type="button" class="chip sm" data-n="${n}" aria-pressed="${Number(d.installments) === n}">${n}</button>`)}</div></div></div>
        <div class="grid-2">
          <div class="field"><label for="pf-freq">Frecuencia de las cuotas</label><select class="select" id="pf-freq" name="frequency">
            ${Object.entries(FREQ_NAMES).map(([k, v]) => html`<option value="${k}" ${d.frequency === k ? 'selected' : ''}>${v}</option>`)}</select></div>
          <div class="field"><label for="pf-start">Fecha de la primera cuota</label><input class="input" type="date" id="pf-start" name="start_date" value="${d.start_date}" required></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="pf-buy">Fecha de compra</label><input class="input" type="date" id="pf-buy" name="purchase_date" value="${d.purchase_date || ''}"></div>
          <div class="field"><label for="pf-cash">Precio al contado <span class="muted">(opcional)</span></label>
            <div class="input-group"><input class="input" id="pf-cash" name="cash_price" inputmode="decimal" value="${amountStr(d.cash_price)}" placeholder="0,00" style="padding-left:13px"><span class="suffix">€</span></div>
            <span class="hint">Para saber cuánto te cuesta financiarlo.</span></div>
        </div>
        <div class="panel" data-preview style="background:var(--saffron-soft);border-color:transparent;padding:16px 18px"></div>
        <div class="field" data-past hidden><label class="switch"><input type="checkbox" name="include_past" checked><span class="track"></span>
          <span class="txt">Anotar también las cuotas ya pagadas<small>Desactívalo si ya las tenías anotadas en movimientos.</small></span></label></div>
        <div class="field"><label>Categoría</label>${catPicker('expense', d.category_id)}</div>
        ${people().length ? html`<div class="field"><label>¿Para quién?</label>${chipPicker('person_id', personOptions(), d.person_id, { scroll: true })}</div>` : ''}
        <div class="field"><label>Forma de pago</label>${chipPicker('method', methodOptions(), d.method, { scroll: true })}</div>
        <label class="switch"><input type="checkbox" name="auto" ${d.auto ? 'checked' : ''}><span class="track"></span>
          <span class="txt">Anotar cada cuota automáticamente<small>Se sumará a los gastos del mes en su fecha, hasta la última.</small></span></label>
        <div class="field"><label>Recordatorio en el móvil</label>${chipPicker('remind_days', NOTICE, d.remind_days ?? 1, { optional: false })}</div>
        <div class="field"><label for="pf-notes">Notas</label><textarea class="textarea" id="pf-notes" name="notes" maxlength="1000" placeholder="Nº de contrato, TAE, garantía…">${d.notes}</textarea></div>
      </form>`,
      foot: html`${editing ? html`<button class="btn danger icon-only" data-act="del" aria-label="Borrar">${icon('trash-2')}</button>` : ''}
        <span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">${editing ? 'Guardar' : 'Añadir compra'}</button>`,
    });
    const form = $('#pf', s.el);
    bindPickers(form);
    focusFirst(form);
    const calc = () => {
      const v = readForm(form);
      const total = parseAmount(v.total_amount);
      const down = parseAmount(v.down_payment) || 0;
      const cash = parseAmount(v.cash_price);
      const n = Math.max(1, Math.min(600, Number(v.installments) || 0));
      $$('[data-n]', form).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.n) === n)));
      $('[data-past]', form).hidden = editing || !(v.start_date && v.start_date < today());
      const box = $('[data-preview]', form);
      if (Number.isNaN(total) || total <= 0 || !v.start_date) {
        box.innerHTML = String(html`<p class="small" style="color:var(--saffron-ink)">${icon('calculator', 'sm')} Escribe el precio y el número de cuotas para ver el cálculo.</p>`);
        return null;
      }
      if (down >= total) {
        box.innerHTML = String(html`<p class="small neg">La entrada no puede ser igual o mayor que el precio.</p>`);
        return null;
      }
      const financed = total - down;
      const cuota = Math.round(financed / n);
      const last = financed - cuota * (n - 1);
      let end = v.start_date;
      for (let i = 1; i < n; i++) end = nextOcc(v.frequency, end, v.start_date);
      let paidSoFar = 0;
      for (let dd = v.start_date, i = 1; i <= n && dd <= today(); i++, dd = nextOcc(v.frequency, dd, v.start_date)) paidSoFar = i;
      const cost = !Number.isNaN(cash) && cash > 0 ? total - cash : null;
      box.innerHTML = String(html`<div class="stack" style="gap:6px;color:var(--ink)">
        <div style="font-size:calc(22px * var(--fs));font-weight:720;font-stretch:84%">${n} cuotas de ${money(cuota)}</div>
        <div class="small ink-2">${FREQ_EVERY[v.frequency][0].toUpperCase()}${FREQ_EVERY[v.frequency].slice(1)}, del ${fmtDateFull(v.start_date)} al ${fmtDateFull(end)}.
          ${last !== cuota ? `La última será de ${money(last)} para cuadrar el redondeo.` : ''}</div>
        <div class="small ink-2">${down ? `Entrada de ${money(down)} + ` : ''}${money(financed)} a plazos = <b>${money(total)}</b>.
          ${cost > 0 ? html`<span class="neg">Financiarlo te cuesta ${money(cost)} más que al contado.</span>` : cost !== null && cost <= 0 ? 'Sin intereses.' : ''}</div>
        ${!editing && paidSoFar ? html`<div class="small" style="color:var(--saffron-ink)">${plural(paidSoFar, 'cuota ya ha vencido', 'cuotas ya han vencido')} a fecha de hoy.</div>` : ''}
      </div>`);
      return { total, down, cash, n };
    };
    on(form, 'input', 'input, select', calc);
    on(form, 'change', 'input, select', calc);
    on(form, 'click', '[data-n]', (e, b) => {
      $('#pf-n', form).value = b.dataset.n;
      calc();
    });
    calc();
    on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
      const v = readForm(form);
      const c = calc();
      if (!v.name.trim()) return showFormError(form, 'Indica qué has comprado');
      if (!c) return showFormError(form, 'Revisa el precio, la entrada y el número de cuotas');
      const payload = {
        kind: 'expense', plan: 'installment', name: v.name, provider: v.provider, total_amount: c.total, down_payment: c.down || 0,
        cash_price: Number.isNaN(c.cash) ? null : c.cash, installments: c.n, frequency: v.frequency, start_date: v.start_date,
        purchase_date: v.purchase_date || null, category_id: intOrNull(v.category_id), person_id: intOrNull(v.person_id),
        method: v.method || null, auto: v.auto, notes: v.notes, remind_days: Number(v.remind_days || 0),
      };
      try {
        if (editing) {
          delete payload.plan;
          await patch(`/recurring/${rec.id}`, payload);
        } else {
          payload.include_past = !!v.include_past;
          await post('/recurring', payload);
        }
        notifyChange('recurring');
        toast(editing ? 'Compra a plazos actualizada' : `${v.name}: ${c.n} cuotas añadidas a tus gastos`);
        s.close(true);
      } catch (err) {
        showFormError(form, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=del]', () => removeRec(rec, s));
  }

  async function removeRec(rec, s) {
    const ok = await confirmDialog({
      title: `¿Borrar ${rec.name}?`,
      text: 'Dejará de anotarse en el futuro. Los pagos que ya están en movimientos se conservan.',
      confirm: 'Borrar', danger: true,
    });
    if (!ok) return;
    try {
      await del(`/recurring/${rec.id}`);
      notifyChange('recurring');
      toast(`${rec.name} borrado`);
      s?.close();
    } catch (e) {
      toastError(e);
    }
  }

  async function detail(id) {
    const r = await get(`/recurring/${id}`);
    const isPlan = r.plan === 'installment';
    const s = sheet({
      title: r.name,
      size: 'wide',
      body: html`<div class="stack" style="gap:16px">
        <div class="row wrap small ink-2" style="gap:14px">
          <span class="pill info">${FREQ_NAMES[r.frequency]}</span>
          ${r.provider ? html`<span>${r.provider}</span>` : ''}
          ${r.category_name ? html`<span>${r.category_icon} ${r.category_name}</span>` : ''}
          ${r.method ? html`<span>${METHOD_NAMES[r.method]}</span>` : ''}
          <span>${r.auto ? 'Se anota solo' : 'Pago manual'}</span>
        </div>
        ${isPlan ? html`${segments(r)}
          <div class="table-scroll"><table class="table-view"><thead><tr><th>Cuota</th><th>Fecha</th><th class="n">Importe</th><th>Estado</th></tr></thead>
          <tbody>${r.schedule.map((c) => html`<tr><td>${c.n} de ${r.installments}</td><td>${fmtDateFull(c.date)}</td><td class="n">${money(c.amount)}</td>
            <td>${c.done ? html`<span class="pill paid">Pagada</span>` : c.date === r.next_date ? html`<span class="pill pending">Siguiente</span>` : html`<span class="pill">Pendiente</span>`}</td></tr>`)}</tbody></table></div>`
        : html`<div class="stat-strip">
            <div class="stat"><span class="label">Próximo</span><span class="value" style="font-size:calc(20px * var(--fs))">${r.active ? fmtDateFull(r.next_date) : 'Pausado'}</span></div>
            <div class="stat"><span class="label">Al mes</span><span class="value" style="font-size:calc(20px * var(--fs))">${money(r.monthly)}</span></div>
            <div class="stat"><span class="label">Al año</span><span class="value" style="font-size:calc(20px * var(--fs))">${money(r.monthly * 12, { decimals: 0 })}</span></div>
            <div class="stat"><span class="label">Pagado en total</span><span class="value" style="font-size:calc(20px * var(--fs))">${money(r.total_paid, { decimals: 0 })}</span></div></div>
          ${r.history.length > 1 ? html`<div class="chart short" id="rh" role="img" aria-label="Historial de importes"></div>` : ''}
          <div class="rows">${r.history.slice(0, 24).map((h) => html`<div class="rowi"><span class="main-txt"><span class="title">${fmtDateLong(h.date)}</span>
            <span class="meta">${h.method ? METHOD_NAMES[h.method] : ''}</span></span><span class="amount">${money(h.amount)}</span></div>`)}</div>
          ${!r.history.length ? html`<p class="muted small">Todavía no hay pagos anotados.</p>` : ''}`}
        ${r.notes ? html`<p class="small ink-2" style="white-space:pre-wrap">${r.notes}</p>` : ''}
      </div>`,
      foot: can('edit') ? html`<span class="spacer"></span><button class="btn" data-act="edit">${icon('pencil')}Editar</button>
        ${r.active && !(isPlan && r.finished) ? html`<button class="btn primary" data-act="pay">${r.kind === 'income' ? 'Cobrar ahora' : 'Pagar cuota ahora'}</button>` : ''}` : '',
    });
    on(s.el, 'click', '[data-act=edit]', () => {
      s.close();
      isPlan ? planForm(r) : fixedForm(r, r.kind);
    });
    on(s.el, 'click', '[data-act=pay]', () => {
      s.close();
      payRecurring({ ...r, title: r.name, amount: isPlan && r.installments_left === 1 ? r.last_amount : r.amount });
    });
    const hist = r.history.slice(0, 18).reverse();
    if (hist.length > 1) {
      mountChart($('#rh', s.el), (t) => ({
        grid: grid({ top: 8 }),
        tooltip: { ...tipBox(t), trigger: 'item', formatter: (p) => tipHTML(fmtDateFull(hist[p.dataIndex].date), [{ color: t.series[0], value: money(p.value), label: 'pagado', box: true }]) },
        xAxis: catAxis(t, hist.map((h) => fmtDate(h.date))),
        yAxis: valAxis(t, { splitNumber: 3 }),
        series: [{ type: 'bar', data: hist.map((h) => h.amount), barMaxWidth: 18, itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] } }],
      }));
    }
  }

  // ---------- Eventos ----------
  on(ctx.el, 'click', '[data-tab]', (e, b) => {
    tab = b.dataset.tab;
    history.replaceState(null, '', `#/fijos${tab !== 'fijos' ? `?tab=${tab}` : ''}`);
    if (tab === 'calendario' && !cal) load();
    else draw();
  });
  on(ctx.el, 'click', '[data-act=new-fixed]', () => fixedForm(null, 'expense'));
  on(ctx.el, 'click', '[data-act=new-income]', () => fixedForm(null, 'income'));
  on(ctx.el, 'click', '[data-act=new-plan]', () => planForm());
  const headerEl = document.getElementById('page-actions');
  ctx.onCleanup(on(headerEl, 'click', '[data-act]', (e, b) => {
    if (b.dataset.act === 'new-fixed') fixedForm(null, 'expense');
    if (b.dataset.act === 'new-income') fixedForm(null, 'income');
    if (b.dataset.act === 'new-plan') planForm();
  }));
  on(ctx.el, 'click', '[data-detail]', (e, b) => detail(Number(b.dataset.detail)).catch(toastError));
  on(ctx.el, 'click', '[data-qpay]', (e, b) => {
    b.classList.add('done');
    quickPayRecurring(rows.find((x) => x.id === Number(b.dataset.qpay)));
  });
  enableSwipe(ctx.el, {
    onSwipe: (el, action) => {
      const r = rows.find((x) => x.id === Number(el.dataset.sw));
      if (!r) return;
      if (action === 'left') payRecurring({ ...r, title: r.name, amount: r.plan === 'installment' && r.installments_left === 1 ? r.last_amount : r.amount });
      else (r.plan === 'installment' ? planForm(r) : fixedForm(r, r.kind));
    },
  });
  on(ctx.el, 'click', '[data-pay]', (e, b) => {
    const r = rows.find((x) => x.id === Number(b.dataset.pay));
    if (r) payRecurring({ ...r, title: r.name, amount: r.installments_left === 1 ? r.last_amount : r.amount });
  });
  on(ctx.el, 'click', '[data-menu]', (e, b) => {
    const r = rows.find((x) => x.id === Number(b.dataset.menu));
    if (!r) return;
    const isPlan = r.plan === 'installment';
    openMenu(b, [
      { label: 'Ver detalle', icon: 'list-checks', onClick: () => detail(r.id).catch(toastError) },
      ...(r.active ? [
        { label: r.kind === 'income' ? 'Marcar como cobrado' : 'Pagar cuota ahora', icon: 'check', onClick: () => payRecurring({ ...r, title: r.name, amount: isPlan && r.installments_left === 1 ? r.last_amount : r.amount }) },
        ...(isPlan ? [] : [{ label: 'Saltar esta cuota', icon: 'skip-forward', onClick: async () => {
          try {
            await post(`/recurring/${r.id}/skip`);
            notifyChange('recurring');
            toast('Cuota saltada');
          } catch (err) {
            toastError(err);
          }
        } }]),
      ] : []),
      { label: 'Editar', icon: 'pencil', onClick: () => (isPlan ? planForm(r) : fixedForm(r, r.kind)) },
      ...(!isPlan ? [{ label: r.active ? 'Pausar' : 'Reactivar', icon: r.active ? 'clock' : 'refresh-cw', onClick: async () => {
        try {
          await patch(`/recurring/${r.id}`, { active: r.active ? 0 : 1, ...(r.active ? {} : { next_date: r.next_date < today() ? today() : r.next_date }) });
          notifyChange('recurring');
        } catch (err) {
          toastError(err);
        }
      } }] : []),
      'sep',
      { label: 'Borrar', icon: 'trash-2', danger: true, onClick: () => removeRec(r) },
    ], { align: 'end' });
  });
  on(ctx.el, 'click', '[data-cal]', async (e, b) => {
    const dlt = Number(b.dataset.cal);
    calMonth = dlt === 0 ? thisMonth() : shiftMonth(calMonth, dlt);
    calSel = calMonth === thisMonth() ? today() : `${calMonth}-01`;
    cal = await get(`/stats/calendar?month=${calMonth}`);
    draw();
  });
  on(ctx.el, 'click', '[data-day]', (e, b) => {
    calSel = b.dataset.day;
    if (calSel.slice(0, 7) !== calMonth) {
      calMonth = calSel.slice(0, 7);
      get(`/stats/calendar?month=${calMonth}`).then((c) => {
        cal = c;
        draw();
      });
    } else draw();
  });
  on(ctx.el, 'click', '[data-calpay]', (e, b) => {
    const ev = (cal.events.filter((x) => x.date === calSel))[Number(b.dataset.calpay)];
    if (!ev) return;
    if (ev.type === 'bill') payBill({ ...ev, supplier: ev.title, concept: ev.subtitle });
    else {
      const r = rows.find((x) => x.id === ev.ref);
      payRecurring({ ...(r || {}), ...ev, id: ev.ref, title: ev.title, date: r?.next_date || ev.date });
    }
  });

  ctx.setRefresh(async () => {
    if (tab === 'calendario') cal = await get(`/stats/calendar?month=${calMonth}`).catch(() => cal);
    await load();
  });
  header();
  ctx.el.innerHTML = skeletonPage();
  await load();
  if (tab === 'fijos' && rows.length && can('edit')) gestureHint(ctx.el, 'fixed', 'Toca el círculo para marcarlo pagado · o desliza la fila');
  if (ctx.query.new) {
    history.replaceState(null, '', `#/fijos${tab !== 'fijos' ? `?tab=${tab}` : ''}`);
    if (tab === 'plazos') planForm();
    else fixedForm(null, 'expense', prefillFrom(ctx.query));
  }
}

// Pago fijo propuesto desde un aviso («¿Spotify es una suscripción?»): nombre, importe y día del próximo cargo.
function prefillFrom(q) {
  const out = {};
  if (q.name) out.name = String(q.name).slice(0, 60);
  if (/^\d+$/.test(q.amount || '')) out.amount = Number(q.amount);
  const day = Number(q.day);
  if (day >= 1 && day <= 31) {
    const t = new Date();
    const next = new Date(t.getFullYear(), t.getMonth() + (t.getDate() >= day ? 1 : 0), 1);
    next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
    out.start_date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    out.method = 'card';
  }
  return out;
}
