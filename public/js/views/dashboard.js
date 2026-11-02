// Inicio: el mes en casa de un vistazo.
import { get, post } from '../api.js';
import {
  $, amountStr, compactMoney, fmtDate, fmtDateLong, html, icon, initials, money, moneyParts, monthLabel, monthLabelFull, monthShort, on,
  parseAmount, parseDate, pct, plural, shiftMonth, thisMonth, timeAgo, toast, toastError, today, withBusy,
} from '../ui.js';
import { can, loadHouse, store } from '../store.js';
import { catAxis, disposeCharts, grid, mountChart, tipBox, tipHTML, valAxis } from '../charts.js';
import { notifyChange, openTxForm, pendingTxRows, pickTicket, txRow } from '../forms.js';
import { payBill, payRecurring, quickShopping } from '../actions.js';
import { bindInsights, insightCards } from '../insights.js';
import { isSimple } from '../prefs.js';
import { blockOf, editHome, homeLayout } from '../home.js';

export default async function dashboard(ctx) {
  // Vista sencilla: un inicio con lo esencial en grande.
  if (isSimple()) return (await import('./simple.js')).default(ctx);
  let month = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month : thisMonth();
  const hour = new Date().getHours();
  const hello = hour < 6 ? 'Buenas noches' : hour < 14 ? 'Buenos días' : hour < 21 ? 'Buenas tardes' : 'Buenas noches';
  const header = () => ctx.setHeader(`${hello}, ${store.me.display_name.split(' ')[0]}`, fmtDateLong(today()));
  header();

  let data = null;
  let editing = false; // «Personalizar el inicio» abierto: los datos se siguen cargando, pero no se pinta encima
  // En el ordenador, los bloques van en dos columnas; en el móvil, uno debajo de otro en el orden de cada persona.
  const twoCols = window.matchMedia('(min-width: 981px)');
  const relayout = () => data && !editing && ctx.isCurrent() && draw();
  twoCols.addEventListener('change', relayout);
  ctx.onCleanup(() => twoCols.removeEventListener('change', relayout));
  let shownSpent = 0; // lo que enseñaba el héroe: el importe «cuenta» desde ahí hasta el nuevo
  let showAllCats = false;
  let insights = [];
  let allInsights = false;

  async function load() {
    const wrap = $('.dash', ctx.el);
    wrap?.classList.add('loading');
    try {
      [data, insights] = await Promise.all([
        get(`/stats/dashboard?month=${month}`),
        month === thisMonth() ? get('/stats/insights').catch(() => []) : [],
      ]);
      if (!ctx.isCurrent() || editing) return;
      draw();
      tweenAmount(shownSpent, data.totals.expense);
      shownSpent = data.totals.expense;
    } finally {
      wrap?.classList.remove('loading');
    }
  }

  // Cada bloque del inicio (home.js); '' si ahora no tiene nada que enseñar.
  function block(id, d) {
    switch (id) {
      case 'hero': return hero(d);
      case 'quick': return quickTiles();
      case 'insights': return insightsPanel();
      case 'stats': return stats(d);
      case 'categories': return categoriesPanel(d);
      case 'trend': return trendPanel();
      case 'recent': return recentPanel(d);
      case 'power': return d.power ? powerPanel(d.power) : '';
      case 'upcoming': return upcomingPanel(d);
      case 'installments': return d.installments.count ? installmentsPanel(d) : '';
      case 'lists': return d.lists.length ? listsPanel(d) : '';
      case 'goals': return d.goals.length ? goalsPanel(d) : '';
      case 'activity': return activityPanel(d);
      default: return '';
    }
  }
  const hasContent = (id) => ({
    quick: can('edit'), insights: insights.length > 0, power: !!data.power, installments: data.installments.count > 0,
    lists: data.lists.length > 0, goals: data.goals.length > 0,
  })[id] ?? true;

  function draw() {
    const d = data;
    const empty = !d.trend.some((m) => m.expense || m.income) && !d.recent.length;
    const { order, hidden } = homeLayout();
    const visible = order.filter((id) => !hidden.has(id));
    // Lo del momento (el resumen del mes pasado, los primeros pasos) va debajo del resumen y los atajos, o arriba.
    let anchor = visible.indexOf('hero');
    if (anchor >= 0 && visible[anchor + 1] === 'quick') anchor++;
    const extras = html`${recapBanner()}${empty ? onboarding() : ''}`;
    const parts = anchor < 0 ? [extras] : [];
    // En el ordenador, los paneles seguidos se reparten en sus dos columnas (en el orden de cada persona dentro de
    // cada una); lo ancho (el resumen, las cifras…) corta y va a todo el ancho.
    let cols = null;
    const flush = () => {
      if (!cols) return;
      if (cols.main.length && cols.side.length) {
        parts.push(html`<div class="grid cols-main"><div class="stack" style="gap:18px">${cols.main}</div><div class="stack" style="gap:18px">${cols.side}</div></div>`);
      } else parts.push(...cols.main, ...cols.side);
      cols = null;
    };
    visible.forEach((id, i) => {
      const content = block(id, d);
      // Envoltorio sin caja propia (display: contents): no cambia la maquetación y marca qué bloque es cada cosa.
      const out = content && html`<div class="home-block" data-home="${id}">${content}</div>`;
      if (out) {
        if (!twoCols.matches || blockOf(id).wide) {
          flush();
          parts.push(out);
        } else (cols ||= { main: [], side: [] })[blockOf(id).col].push(out);
      }
      if (i === anchor) {
        flush();
        parts.push(extras);
      }
    });
    flush();
    ctx.el.innerHTML = String(html`<div class="dash stack" style="gap:18px">
      ${incomeAsk(d)}
      ${parts}
      ${!visible.length ? html`<div class="empty"><div class="art">🙈</div><h3>Has ocultado todo el inicio</h3>
        <p>Elige qué quieres ver en «Personalizar el inicio».</p></div>` : ''}
      <div class="home-custom"><button type="button" class="btn ghost" data-act="customize">${icon('sliders-horizontal')}Personalizar el inicio</button></div>
    </div>`);
    drawCharts();
  }

  // «Personalizar el inicio»: el orden y lo que se ve, de cada persona.
  function customize() {
    if (editing || !data) return;
    editing = true;
    editHome(ctx, {
      has: hasContent,
      done: () => {
        editing = false;
        header();
        draw();
        window.scrollTo({ top: 0 });
      },
    });
    disposeCharts(ctx.el);
    window.scrollTo({ top: 0 });
  }
  on(ctx.el, 'click', '[data-act=customize]', customize);

  function quickTiles() {
    if (!can('edit')) return '';
    return html`<div class="quick-row quick-tiles only-mobile" aria-label="Atajos">
      <button class="qa-tile" data-qa="ticket" style="--qc:var(--cobalt)"><span class="qi">${icon('camera')}</span>Ticket</button>
      <button class="qa-tile" data-qa="income" style="--qc:var(--pine)"><span class="qi">${icon('arrow-down-right')}</span>Ingreso</button>
      <button class="qa-tile" data-qa="shop" style="--qc:var(--chart-4)"><span class="qi">${icon('shopping-cart')}</span>A la compra</button>
      <button class="qa-tile" data-act="quick" style="--qc:var(--chart-7)"><span class="qi">${icon('grid-2x2')}</span>Más</button></div>`;
  }
  // La primera semana del mes, el resumen del anterior.
  function recapBanner() {
    if (!(Number(today().slice(8)) <= 7 && month === thisMonth())) return '';
    return html`<a class="recap-banner" href="#/resumen?m=${shiftMonth(month, -1)}">
      <span class="rb-ico">${icon('sparkles')}</span><span class="grow"><b>Ya está vuestro resumen de ${monthLabelFull(shiftMonth(month, -1)).split(' ')[0].toLowerCase()}</b>
      <small>Lo que entró, lo que salió y en qué. Con imagen para compartir.</small></span>${icon('chevron-right')}</a>`;
  }
  function trendPanel() {
    return html`<section class="panel"><div class="panel-head"><h2>Últimos 12 meses</h2>
      <div class="actions"><div class="chart-legend" style="margin:0">
        <span><i style="--c:var(--chart-1)"></i>Gastos</span><span><i style="--c:var(--chart-2)"></i>Ingresos</span></div></div></div>
      <div class="chart" id="trend" role="img" aria-label="Gastos e ingresos de los últimos 12 meses"></div>
      <p class="tiny muted" style="margin-top:6px">Toca una barra para ver ese mes.</p>
    </section>`;
  }
  function recentPanel(d) {
    return html`<section class="panel"><div class="panel-head"><h2>Últimos movimientos</h2>
      <div class="actions"><a class="btn ghost sm" href="#/movimientos">Ver todos</a></div></div>
      ${pendingTxRows(store.hid)}
      ${d.recent.length ? html`<div class="rows">${d.recent.map((t) => txRow(t, { showDate: true }))}</div>`
        : html`<div class="empty" style="padding:20px"><p>Aún no hay movimientos.</p></div>`}
    </section>`;
  }

  // El gasto del mes sube (o baja) contando hasta su valor: al abrir la app, al cambiar de mes o al llegar un gasto nuevo.
  function tweenAmount(from, to) {
    const el = $('.hero-amount', ctx.el);
    if (!el || from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t0 = performance.now();
    const dur = Math.min(900, 450 + Math.abs(to - from) / 400);
    const paint = (v) => {
      const p = moneyParts(Math.round(v));
      el.innerHTML = String(html`${p.symBefore ? p.sym : ''}${p.int}<span class="cents">${p.dec}${p.symBefore ? '' : ` ${p.sym}`}</span>`);
    };
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      paint(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    paint(from);
    requestAnimationFrame(step);
  }

  // ---------- Héroe ----------
  function hero(d) {
    const spent = d.totals.expense;
    const p = moneyParts(spent);
    const isPast = month < thisMonth();
    const isFuture = month > thisMonth();
    const prevName = monthLabel(shiftMonth(month, -1), { year: false }).toLowerCase();
    let sentence;
    if (isFuture) sentence = html`Este mes aún no ha empezado. Ya hay pagos programados en el calendario.`;
    else if (d.isCurrent) {
      const diff = spent - d.prevSameDay;
      if (!d.prevSameDay && !spent) sentence = html`Todavía no habéis anotado gastos este mes.`;
      else if (!d.prevSameDay) sentence = html`Gastado en lo que va de mes.`;
      else if (Math.abs(diff) < 100) sentence = html`Vais igual que en ${prevName} a estas alturas.`;
      else sentence = html`Vais <strong>${money(Math.abs(diff), { decimals: 0 })} ${diff < 0 ? 'por debajo' : 'por encima'}</strong> de ${prevName} a estas alturas.`;
    } else {
      const diff = spent - d.prevTotals.expense;
      sentence = d.prevTotals.expense
        ? html`Gastado en total. <strong>${money(Math.abs(diff), { decimals: 0 })} ${diff < 0 ? 'menos' : 'más'}</strong> que en ${prevName}.`
        : html`Gastado en total ese mes.`;
    }
    const budget = d.budgetTotal;
    // La previsión, salvo la primera semana de un hogar sin meses anteriores (con uno o dos días sale un disparate).
    const forecast = d.forecast && !d.forecast.rough;
    let budgetBlock = '';
    if (budget) {
      const ratio = spent / budget;
      const left = budget - spent;
      const daysLeft = d.days - d.dayNow;
      const expected = d.isCurrent ? d.dayNow / d.days : isPast ? 1 : 0;
      budgetBlock = html`<div class="hero-budget">
        <div class="row between wrap"><span>Presupuesto <strong>${money(budget, { decimals: 0 })}</strong></span>
          <span>${left >= 0
            ? html`Quedan <strong>${money(left, { decimals: 0 })}</strong>${d.isCurrent ? ` para ${plural(daysLeft + 1, 'día', 'días')}` : ''}`
            : html`Superado en <strong>${money(-left, { decimals: 0 })}</strong>`}</span></div>
        <div class="meter thick ${ratio > 1 ? 'over' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}"
          aria-label="Presupuesto gastado">
          <div class="fill" style="width:${Math.min(ratio, 1) * 100}%"></div>
          ${d.isCurrent ? html`<div class="tick" style="left:${expected * 100}%" title="Donde deberíais ir hoy"></div>` : ''}
        </div>
      </div>`;
    } else if (d.budgets.length) budgetBlock = limitsBlock(d, isPast);
    return html`<section class="hero" aria-label="Resumen del mes">
      <div>
        <div class="hero-month">
          <button data-act="month" data-d="-1" aria-label="Mes anterior">${icon('chevron-left')}</button>
          <span class="m">${monthLabelFull(month)}</span>
          <button data-act="month" data-d="1" aria-label="Mes siguiente" ${month >= shiftMonth(thisMonth(), 1) ? 'disabled' : ''}>${icon('chevron-right')}</button>
          ${month !== thisMonth() ? html`<button data-act="month-now" aria-label="Volver al mes actual" style="width:auto;padding:0 10px;font-size:calc(13px * var(--fs));font-weight:600">Hoy</button>` : ''}
        </div>
        <div class="hero-amount" aria-label="${money(spent)}">${p.symBefore ? p.sym : ''}${p.int}<span class="cents">${p.dec}${p.symBefore ? '' : ` ${p.sym}`}</span></div>
        <p class="hero-sentence">${sentence}</p>
        ${budgetBlock}
        ${forecast ? html`<div class="hero-forecast">${icon('trending-up', 'sm')}<span>Previsión al cerrar el mes: <strong>${money(d.forecast.total, { decimals: 0 })}</strong>${budget && d.forecast.total > budget
          ? html`<span style="color:#ffb3ba">, ${money(d.forecast.total - budget, { decimals: 0 })} por encima del presupuesto</span>` : ''}</span></div>` : ''}
      </div>
      <div class="hero-chart">
        <div class="hero-legend">
          <span style="color:#fff"><i></i><span class="lg-long">${monthLabel(month, { year: false })}</span><span class="lg-short">${monthShort(month)}</span></span>
          <span style="color:rgba(255,255,255,.5)"><i></i><span class="lg-long">${monthLabel(shiftMonth(month, -1), { year: false })}</span><span class="lg-short">${monthShort(shiftMonth(month, -1))}</span></span>
          ${budget ? html`<span style="color:var(--saffron)"><i></i>Presupuesto</span>` : ''}
          ${forecast ? html`<span style="color:rgba(255,255,255,.75)"><i style="background:repeating-linear-gradient(90deg,currentColor 0 4px,transparent 4px 7px)"></i>Previsión</span>` : ''}
        </div>
        <div class="chart" id="pace" role="img" aria-label="Gasto acumulado día a día"></div>
      </div>
    </section>`;
  }

  // Sin presupuesto total: los límites de cada categoría, cada uno con lo gastado en ella (y no con todo el mes).
  // Primero los que van más justos; si hay muchos, los tres primeros.
  function limitsBlock(d, isPast) {
    const expected = d.isCurrent ? d.dayNow / d.days : isPast ? 1 : 0;
    const ranked = d.budgets.slice().sort((a, b) => b.total / b.budget - a.total / a.budget);
    const over = ranked.filter((b) => b.total > b.budget).length;
    const daysLeft = d.days - d.dayNow;
    return html`<div class="hero-budget hero-limits">
      <div class="hl-head"><span>${ranked.length === 1 ? 'Límite por categoría' : `Límites por categoría${over ? ` · ${over} superado${over > 1 ? 's' : ''}` : ''}`}</span>
        <a href="#/presupuestos">${ranked.length > 3 ? `Ver los ${ranked.length}` : 'Presupuestos'}</a></div>
      ${ranked.slice(0, 3).map((b) => {
        const ratio = b.total / b.budget;
        const left = b.budget - b.total;
        return html`<a class="hl-row" href="#/movimientos?cat=${b.id}&month=${month}">
          <span class="row between"><span class="hl-name">${b.icon} ${b.name}</span>
            <span><strong>${money(b.total, { decimals: 0 })}</strong> de ${money(b.budget, { decimals: 0 })}</span></span>
          <span class="meter ${ratio > 1 ? 'over' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}"
            aria-label="${b.name}: gastado del límite"><span class="fill" style="width:${Math.min(ratio, 1) * 100}%"></span>
            ${d.isCurrent ? html`<span class="tick" style="left:${expected * 100}%" title="Donde deberíais ir hoy"></span>` : ''}</span>
          ${ranked.length === 1 ? html`<span class="hl-note">${left >= 0
            ? html`Quedan <strong>${money(left, { decimals: 0 })}</strong>${d.isCurrent ? ` para ${plural(daysLeft + 1, 'día', 'días')}` : ''}`
            : html`Superado en <strong>${money(-left, { decimals: 0 })}</strong>`}</span>` : ''}
        </a>`;
      })}
    </div>`;
  }

  function stats(d) {
    const prevInc = d.isCurrent ? d.prevSameDayIncome : d.prevTotals.income;
    const incDelta = prevInc ? (d.totals.income - prevInc) / prevInc : null;
    const balance = d.totals.income - d.totals.expense;
    const pb = d.pendingBills;
    return html`<section class="stat-strip" aria-label="Cifras del mes">
      <a class="stat clickable" href="#/movimientos?kind=income&month=${month}" style="color:inherit;text-decoration:none">
        <span class="label">${icon('arrow-down-right', 'sm')}Ingresos</span>
        <span class="value pos">${money(d.totals.income, { decimals: 0 })}</span>
        ${d.forecast?.expectedIncome ? html`<span class="delta good">+${money(d.forecast.expectedIncome, { decimals: 0 })} previstos este mes</span>`
          : incDelta !== null ? html`<span class="delta ${incDelta >= 0 ? 'good' : 'bad'}">${incDelta >= 0 ? '▲' : '▼'} ${pct(Math.abs(incDelta))} ${d.isCurrent ? 'vs mismo día del mes pasado' : 'vs mes anterior'}</span>`
          : html`<span class="delta">este mes</span>`}</a>
      <div class="stat"><span class="label">${icon('scale', 'sm')}Balance</span>
        <span class="value ${balance >= 0 ? 'pos' : 'neg'}">${money(balance, { sign: true, decimals: 0 })}</span>
        ${d.forecast && !d.forecast.rough ? html`<span class="delta ${d.forecast.balance >= 0 ? 'good' : 'bad'}">Al cierre: ${money(d.forecast.balance, { sign: true, decimals: 0 })} previsto</span>`
          : html`<span class="delta">${balance < 0 ? 'más gastos que ingresos' : d.totals.income ? `ahorro del ${pct(balance / d.totals.income)}` : 'ingresos − gastos'}</span>`}</div>
      <a class="stat clickable" href="#/fijos" style="color:inherit;text-decoration:none"><span class="label">${icon('repeat', 'sm')}Fijos al mes</span>
        <span class="value">${money(d.fixedMonthly, { decimals: 0 })}</span><span class="delta">recibos, cuotas y suscripciones</span></a>
      <a class="stat clickable" href="#/fijos?tab=plazos" style="color:inherit;text-decoration:none"><span class="label">${icon('calendar-clock', 'sm')}Plazos pendientes</span>
        <span class="value">${money(d.installments.remaining, { decimals: 0 })}</span>
        <span class="delta">${d.installments.count ? `${plural(d.installments.count, 'compra', 'compras')}, ${money(d.installments.monthly, { decimals: 0 })}/mes` : 'ninguna compra a plazos'}</span></a>
      <a class="stat clickable" href="#/facturas" style="color:inherit;text-decoration:none"><span class="label">${icon('receipt', 'sm')}Facturas por pagar</span>
        <span class="value">${money(pb.total, { decimals: 0 })}</span>
        <span class="delta ${pb.overdue ? 'bad' : ''}">${pb.n ? `${plural(pb.n, 'factura', 'facturas')}${pb.overdue ? `, ${pb.overdue} vencida${pb.overdue > 1 ? 's' : ''}` : ''}` : 'todo pagado'}</span></a>
    </section>`;
  }

  function onboarding() {
    const steps = [
      ...(can('admin') && !store.house.household.setup_done ? [{ icon: 'wand-sparkles', t: 'Prepara la casa en 2 minutos', s: 'Ingresos, pagos fijos y presupuesto con plantillas de un toque.', act: 'setup' }] : []),
      { icon: 'plus', t: 'Anota tu primer gasto', s: 'El botón azul o la tecla N. Escribe el importe y elige una categoría.', act: 'first-tx' },
      ...(can('admin') && !store.house.household.setup_done ? [] : [{ icon: 'repeat', t: 'Añade los pagos fijos', s: 'Alquiler o hipoteca, luz, seguros, suscripciones… Se anotan solos cada mes.', href: '#/fijos?new=1' }]),
      { icon: 'calendar-clock', t: '¿Algo comprado a plazos?', s: 'Indica precio y meses: cada cuota se suma a los gastos hasta terminar.', href: '#/fijos?tab=plazos&new=1' },
      { icon: 'user-plus', t: 'Invita a tu familia', s: 'Compartid gastos y la lista de la compra en tiempo real.', href: '#/ajustes/miembros' },
    ];
    return html`<section class="panel" style="border-color:var(--cobalt-line)">
      <div class="panel-head"><h2>Primeros pasos</h2>
        ${can('admin') ? html`<div class="actions"><button class="btn soft sm" data-act="demo">${icon('wand-sparkles')}Probar con datos de ejemplo</button></div>` : ''}</div>
      <div class="grid cols-2" style="gap:10px">
        ${steps.map((st) => html`${st.href ? html`<a class="rowi clickable" href="${st.href}" style="border:1px solid var(--line);border-radius:14px;padding:12px">`
          : html`<button class="rowi" data-act="${st.act}" style="border:1px solid var(--line);border-radius:14px;padding:12px">`}
          <span class="cat-dot" style="--c:var(--cobalt)">${icon(st.icon)}</span>
          <span class="main-txt"><span class="title">${st.t}</span><span class="meta" style="white-space:normal">${st.s}</span></span>
          ${st.href ? html`</a>` : html`</button>`}`)}
      </div></section>`;
  }

  // ---------- Avisos que se adelantan ----------
  // Nóminas que cambian: «¿la de este mes es igual que la anterior?» (una fila por nómina; «Más tarde» la esconde hasta mañana).
  const laterKey = `gastosbyath.nominas.${store.house.household.id}`;
  const askedLater = () => {
    try {
      return localStorage.getItem(laterKey) === today();
    } catch {
      return false;
    }
  };
  function incomeAsk(d) {
    const qs = d.income_questions || [];
    if (!qs.length || !can('edit') || askedLater()) return '';
    const name = monthLabelFull(month).split(' ')[0].toLowerCase();
    return html`<section class="pay-ask" aria-label="Nóminas de este mes">
      <div class="pa-head"><span class="pa-ico">${icon('hand-coins')}</span>
        <div class="grow"><h2>${qs.length > 1 ? `Las nóminas de ${name}` : `La nómina de ${name}`}</h2>
          <p>¿Es igual que la anterior? Con la cantidad buena, la previsión del mes acierta.</p></div>
        <button type="button" class="btn ghost sm" data-act="ask-later">Más tarde</button></div>
      ${qs.map((q) => {
        const prev = q.previous ? q.previous.amount : q.amount;
        return html`<div class="pa-item">
          <div class="pa-who"><b>${q.name}${q.person_name && !q.name.includes(q.person_name) ? ` de ${q.person_name}` : ''}</b>
            <small>${q.previous ? `La anterior: ${money(q.previous.amount)}, el ${fmtDate(q.previous.date)}` : `Prevista: ${money(q.amount)}`}</small></div>
          <div class="pa-actions">
            <button type="button" class="btn sm" data-same="${q.id}" data-amount="${prev}">${icon('check', 'sm')}Igual</button>
            <button type="button" class="btn sm ghost" data-diff="${q.id}">Es diferente</button></div>
          <form class="pa-form" data-diffform="${q.id}" hidden>
            <div class="input-group"><input class="input" inputmode="decimal" name="amount" placeholder="${amountStr(prev)}" aria-label="Importe de ${q.name} este mes" style="padding-left:13px"><span class="suffix">€</span></div>
            <button type="submit" class="btn sm primary">Guardar</button></form>
        </div>`;
      })}
      <a class="pa-add" href="#/fijos?new=1&kind=income&name=N%C3%B3mina&variable=1">${icon('plus', 'sm')}Añadir la nómina de otra persona</a>
    </section>`;
  }
  const answerIncome = (id, amount, btn) => withBusy(btn, async () => {
    try {
      await post(`/recurring/${id}/month-amount`, { amount });
      toast(`Guardado: ${money(amount)} este mes. La previsión ya lo tiene en cuenta.`);
      notifyChange('recurring');
      await load();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'click', '[data-same]', (e, b) => answerIncome(Number(b.dataset.same), Number(b.dataset.amount), b));
  on(ctx.el, 'click', '[data-diff]', (e, b) => {
    const f = $(`[data-diffform="${b.dataset.diff}"]`, ctx.el);
    f.hidden = false;
    b.hidden = true;
    $('input', f).focus();
  });
  on(ctx.el, 'submit', '[data-diffform]', (e, f) => {
    e.preventDefault();
    const amount = parseAmount($('input', f).value);
    if (!(amount > 0)) return toastError(new Error('Escribe cuánto es este mes'));
    answerIncome(Number(f.dataset.diffform), amount, $('button', f));
  });
  on(ctx.el, 'click', '[data-act=ask-later]', () => {
    try {
      localStorage.setItem(laterKey, today());
    } catch { /* sin almacenamiento: vuelve a salir al recargar */ }
    $('.pay-ask', ctx.el)?.remove();
  });

  function insightsPanel() {
    if (!insights.length) return html`<div class="insights-slot"></div>`;
    return html`<section class="panel insights-panel insights-slot"><div class="panel-head"><h2>Para que lo sepas</h2>
      ${insights.length > 3 ? html`<div class="actions"><button class="btn ghost sm" data-act="all-insights">${allInsights ? 'Ver menos' : `Ver los ${insights.length}`}</button></div>` : ''}</div>
      ${insightCards(insights, { all: allInsights })}</section>`;
  }
  const repaintInsights = () => {
    const slot = $('.insights-slot', ctx.el);
    if (slot) slot.outerHTML = String(insightsPanel());
  };
  bindInsights(ctx.el, (key) => {
    insights = insights.filter((x) => x.key !== key);
    repaintInsights();
  });
  on(ctx.el, 'click', '[data-act=all-insights]', () => {
    allInsights = !allInsights;
    repaintInsights();
  });

  // ---------- Categorías ----------
  function categoriesPanel(d) {
    const cats = d.byCategory;
    const total = d.totals.expense || 1;
    const max = Math.max(...cats.map((c) => c.total), 1);
    const shown = showAllCats ? cats : cats.slice(0, 7);
    return html`<section class="panel"><div class="panel-head"><h2>En qué se va el dinero</h2>
      <span class="sub">${monthLabel(month)}</span>
      <div class="actions"><a class="btn ghost sm" href="#/analisis">Análisis</a></div></div>
      ${cats.length ? html`
        <div class="cat-strip" role="img" aria-label="Reparto del gasto por categorías">
          ${cats.map((c) => html`<span style="--c:${c.color};flex:${c.total}" title="${c.icon} ${c.name}: ${money(c.total)}"></span>`)}</div>
        <div>${shown.map((c) => {
          const share = c.total / total;
          const hasBudget = c.budget > 0;
          const ratio = hasBudget ? c.total / c.budget : c.total / max;
          const base = d.isCurrent ? c.prev_same : c.prev;
          const delta = base ? (c.total - base) / base : null;
          const prevName = monthShort(shiftMonth(month, -1));
          return html`<a class="cat-line clickable" href="#/movimientos?cat=${c.id ?? 'none'}&month=${month}" style="color:inherit;text-decoration:none">
            <span class="cat-dot sm" style="--c:${c.color}"><span class="emoji">${c.icon}</span></span>
            <span class="n"><span class="ellipsis">${c.name}</span><span class="pct">${pct(share)}</span></span>
            <span class="v">${money(c.total)}</span>
            <span class="bar"><span class="meter ${hasBudget && ratio > 1 ? 'over' : hasBudget && ratio > 0.85 ? 'warn' : ''}" style="--c:${c.color}">
              <span class="fill" style="width:${Math.min(ratio, 1) * 100}%"></span></span>
              <small>${hasBudget ? `de ${money(c.budget, { decimals: 0 })}`
                : delta !== null ? (Math.abs(delta) < 0.005 ? `igual que en ${prevName}${d.isCurrent ? ' a estas alturas' : ''}` : `${delta >= 0 ? '+' : '−'}${pct(Math.abs(delta))} vs ${prevName}${d.isCurrent ? ' a estas alturas' : ''}`)
                  : c.prev ? `en ${prevName} aún no había gasto a estas alturas` : 'nuevo este mes'}</small></span>
          </a>`;
        })}</div>
        ${cats.length > 7 ? html`<button class="btn ghost sm" data-act="all-cats" style="margin-top:6px">${showAllCats ? 'Ver menos' : `Ver las ${cats.length} categorías`}</button>` : ''}`
      : html`<div class="empty" style="padding:24px"><div class="art">🧺</div><p>Sin gastos en ${monthLabel(month).toLowerCase()}.</p></div>`}
    </section>`;
  }

  // ---------- Próximos pagos ----------
  function upcomingPanel(d) {
    const items = d.upcoming.slice(0, 14);
    const groups = [];
    for (const it of items) {
      const key = it.overdue ? 'overdue' : it.date || 'nodate';
      let g = groups.find((x) => x.key === key);
      if (!g) groups.push((g = { key, date: it.date, overdue: it.overdue, items: [] }));
      g.items.push(it);
    }
    const typeIcon = { recurring: 'repeat', installment: 'calendar-clock', bill: 'receipt', pet: 'paw-print', reminder: 'calendar-check' };
    const t = today();
    const total = d.upcoming.filter((x) => x.kind === 'expense' && x.amount).reduce((s, x) => s + x.amount, 0);
    return html`<section class="panel"><div class="panel-head"><h2>Próximos 30 días</h2>
      <span class="sub">${money(total, { decimals: 0 })} en pagos</span>
      <div class="actions"><a class="btn ghost sm" href="#/fijos?tab=calendario">Calendario</a></div></div>
      ${groups.length ? html`<div class="timeline">${groups.map((g) => {
        const dd = g.date ? parseDate(g.date) : null;
        return html`<div class="tl-day">
          <div class="tl-date ${g.overdue ? 'overdue' : g.date === t ? 'today' : ''}">
            ${g.overdue ? html`<span class="dn">${icon('triangle-alert')}</span><span class="mn">vencido</span>`
              : dd ? html`<span class="dn">${dd.getDate()}</span><span class="mn">${g.date === t ? 'hoy' : monthShort(g.date.slice(0, 7))}</span>` : html`<span class="mn">sin fecha</span>`}
          </div>
          <div class="tl-items">${g.items.map((it) => {
            const needsAction = (it.type === 'recurring' || it.type === 'installment') ? (!it.auto && (it.overdue || it.first)) : it.type === 'bill';
            const isRem = it.type === 'reminder';
            return html`<div class="tl-item">
              <span class="ico ${it.type} ${it.kind === 'income' ? 'income' : ''}">${icon(typeIcon[it.type])}</span>
              <span class="t"><div class="title">${it.title}</div>
                <div class="meta">${[it.overdue && it.date ? `Era el ${it.date.slice(8)}/${it.date.slice(5, 7)}` : '', it.subtitle && it.type !== 'pet' ? it.subtitle : '',
                  it.type === 'pet' || isRem ? 'Recordatorio' : it.auto ? 'Se anota solo' : it.type === 'bill' ? 'Factura' : 'Pago manual', it.variable ? 'importe variable' : '']
                  .filter(Boolean).join(' · ')}</div></span>
              ${it.amount ? html`<span class="a ${it.kind === 'income' ? 'pos' : ''}">${it.kind === 'income' ? '+' : ''}${money(it.amount)}</span>` : ''}
              ${needsAction && can('edit') ? html`<button class="btn sm ${it.overdue ? 'primary' : ''}" data-pay="${d.upcoming.indexOf(it)}">${it.kind === 'income' ? 'Cobrar' : 'Pagar'}</button>` : ''}
              ${it.type === 'pet' ? html`<a class="btn sm ghost" href="#/mascotas/${it.id}">Ver</a>` : ''}
              ${isRem ? html`<a class="btn sm ghost" href="#/recordatorios">Ver</a>` : ''}
            </div>`;
          })}</div></div>`;
      })}</div>
      ${d.upcoming.length > items.length ? html`<div class="panel-foot"><a href="#/fijos?tab=calendario" class="small">Y ${d.upcoming.length - items.length} más en el calendario</a></div>` : ''}`
      : html`<div class="empty" style="padding:24px"><div class="art">🗓️</div><p>No hay pagos programados. Añade tus recibos y suscripciones en Pagos fijos.</p>
        <div class="row"><a class="btn sm" href="#/fijos?new=1">${icon('plus', 'sm')}Añadir pago fijo</a></div></div>`}
    </section>`;
  }

  function powerPanel(p) {
    const lv = { cheap: ['Barata', 'paid'], mid: ['Media', 'pending'], dear: ['Cara', 'overdue'] }[p.level];
    return html`<a class="panel" href="#/luz" style="display:flex;gap:14px;align-items:center;color:inherit;text-decoration:none">
      <span class="cat-dot lg" style="--c:#d39a00">${icon('zap')}</span>
      <span class="grow" style="min-width:0"><span class="small muted">Luz ahora</span>
        <span class="row" style="gap:8px;align-items:baseline"><b style="font-size:calc(22px * var(--fs));font-stretch:84%">${money(p.price * 100, { decimals: 3 })}</b><span class="small muted">/kWh</span>
          <span class="pill ${lv[1]}">${lv[0]}</span></span>
        <span class="tiny muted">La hora más barata hoy: ${String(p.cheapest).padStart(2, '0')}:00</span></span>
      <span style="text-align:right"><span class="small muted">Factura en curso</span><br><b>${money(p.estimated)}</b><br><span class="tiny muted">estimado</span></span>
    </a>`;
  }

  function installmentsPanel(d) {
    return html`<section class="panel"><div class="panel-head"><h2>Compras a plazos</h2>
      <span class="sub">${money(d.installments.monthly, { decimals: 0 })}/mes</span>
      <div class="actions"><a class="btn ghost sm" href="#/fijos?tab=plazos">Ver todas</a></div></div>
      <div class="stack" style="gap:16px">${d.installments.plans.map((p) => html`<div class="plan">
        <div class="row between"><span style="font-weight:620" class="ellipsis">${p.category_icon || '🛍️'} ${p.name}</span>
          <span class="small muted nowrap">${p.installments_done} de ${p.installments}</span></div>
        ${segments(p)}
        <div class="row between small"><span class="muted">Quedan ${money(p.remaining)}</span>
          <span class="muted">Termina ${new Date(p.end_date + 'T12:00').toLocaleDateString('es-ES', { month: 'short', year: 'numeric' }).replace('.', '')}</span></div>
      </div>`)}</div></section>`;
  }

  function listsPanel(d) {
    return html`<section class="panel"><div class="panel-head"><h2>Lista de la compra</h2>
      <div class="actions"><a class="btn ghost sm" href="#/compra">Abrir</a></div></div>
      <div class="rows">${d.lists.map((l) => html`<a class="rowi" href="#/compra/${l.id}">
        <span class="cat-dot sm"><span class="emoji">${l.icon}</span></span>
        <span class="main-txt"><span class="title">${l.name}</span></span>
        <span class="pill ${l.pending ? 'info' : 'paid'}">${l.pending ? `${l.pending} por comprar` : 'Todo comprado'}</span></a>`)}</div></section>`;
  }

  function goalsPanel(d) {
    return html`<section class="panel"><div class="panel-head"><h2>Ahorro</h2>
      <div class="actions"><a class="btn ghost sm" href="#/ahorro">Ver metas</a></div></div>
      <div class="stack" style="gap:14px">${d.goals.map((g) => html`<div class="stack" style="gap:6px">
        <div class="row between"><span style="font-weight:600" class="ellipsis">${g.icon} ${g.name}</span>
          <span class="small num"><b>${money(g.saved, { decimals: 0 })}</b> <span class="muted">de ${money(g.target, { decimals: 0 })}</span></span></div>
        <div class="meter" style="--c:${g.color}"><div class="fill" style="width:${Math.min(g.saved / g.target, 1) * 100}%"></div></div>
      </div>`)}</div></section>`;
  }

  function activityPanel(d) {
    return html`<section class="panel"><div class="panel-head"><h2>Actividad en casa</h2></div>
      ${d.activity.length ? html`<div class="feed">${d.activity.map((a) => html`<div class="feed-item">
        ${a.user_name ? html`<span class="avatar sm" style="--c:${a.user_color}">${initials(a.user_name)}</span>`
          : html`<span class="avatar sm" style="--c:var(--ink-3)">${icon('refresh-cw', 'sm')}</span>`}
        <span class="grow">${a.summary}<span class="when">${timeAgo(a.created_at)}</span></span></div>`)}</div>`
      : html`<p class="small muted">Aquí verás lo que anota cada persona del hogar.</p>`}
    </section>`;
  }

  // ---------- Gráficos ----------
  function drawCharts() {
    const d = data;
    const daysArr = Array.from({ length: d.days }, (_, i) => i + 1);
    const cum = (arr, upto) => {
      let s = 0;
      return arr.map((v, i) => (i < upto ? (s += v) : null));
    };
    const showUntil = d.isCurrent ? d.dayNow : month < thisMonth() ? d.days : 0;
    const cur = cum(d.daily, showUntil);
    const prev = cum(d.prevDaily, d.prevDaily.length).slice(0, d.days);
    while (prev.length < d.days) prev.push(prev.at(-1) ?? null);
    const forecastLine = d.forecast && !d.forecast.rough && d.dayNow ? daysArr.map((day) => {
      if (day < d.dayNow) return null;
      const start = cur[d.dayNow - 1] ?? 0;
      return Math.round(start + ((d.forecast.total - start) * (day - d.dayNow)) / Math.max(d.days - d.dayNow, 1));
    }) : null;

    mountChart($('#pace', ctx.el), (t) => {
      const white = '#ffffff';
      const series = [
        {
          name: monthLabel(shiftMonth(month, -1), { year: false }), type: 'line', data: prev, showSymbol: false, symbol: 'circle', symbolSize: 7,
          lineStyle: { width: 1.5, color: 'rgba(255,255,255,0.42)' }, itemStyle: { color: 'rgba(255,255,255,0.6)' }, z: 1,
        },
        {
          name: monthLabel(month, { year: false }), type: 'line', data: cur, showSymbol: false, symbol: 'circle', symbolSize: 9,
          lineStyle: { width: 2.5, color: white, cap: 'round' }, itemStyle: { color: white, borderColor: t.dark ? '#172a78' : '#1d3aa5', borderWidth: 2 },
          areaStyle: { color: 'rgba(255,255,255,0.10)' }, z: 3,
          endLabel: showUntil ? { show: true, formatter: (p) => compactMoney(p.value), color: white, fontFamily: t.font, fontWeight: 700, fontSize: 13, distance: 6 } : undefined,
          markPoint: showUntil ? { symbol: 'circle', symbolSize: 10, data: [{ coord: [showUntil - 1, cur[showUntil - 1]] }], itemStyle: { color: white, borderColor: '#1d3aa5', borderWidth: 2 }, label: { show: false } } : undefined,
          markLine: d.budgetTotal ? {
            symbol: 'none', silent: true, data: [{ yAxis: d.budgetTotal }],
            lineStyle: { color: t.saffron, width: 1.5, type: 'solid' },
            label: { formatter: () => `Presupuesto ${compactMoney(d.budgetTotal)}`, color: t.saffron, fontFamily: t.font, fontSize: 11.5, fontWeight: 600, position: 'insideStartTop' },
          } : undefined,
        },
      ];
      if (forecastLine) {
        series.push({
          name: 'Previsión', type: 'line', data: forecastLine, showSymbol: false, symbol: 'none',
          lineStyle: { width: 1.5, color: 'rgba(255,255,255,0.7)', type: [4, 4] }, z: 2, tooltip: { show: false },
        });
      }
      return {
        animationDuration: 700,
        grid: { left: 2, right: 54, top: 22, bottom: 2, containLabel: true },
        tooltip: {
          ...tipBox(t), trigger: 'axis',
          axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,0.4)', width: 1 } },
          formatter: (ps) => {
            const day = ps[0].axisValue;
            const rows = ps.filter((p) => p.seriesName !== 'Previsión' && p.value != null)
              .map((p) => ({ color: p.seriesIndex === 1 ? t.cobalt : t.muted, value: money(p.value, { decimals: 0 }), label: p.seriesName }));
            return tipHTML(`Día ${day}`, rows);
          },
        },
        xAxis: {
          type: 'category', data: daysArr, boundaryGap: false,
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.25)' } }, axisTick: { show: false },
          axisLabel: { color: 'rgba(255,255,255,0.6)', fontFamily: t.font, fontSize: 11, interval: (i) => [0, 4, 9, 14, 19, 24, d.days - 1].includes(i) },
        },
        yAxis: {
          type: 'value', position: 'right', splitNumber: 3,
          max: (v) => Math.max(v.max, d.budgetTotal || 0) * 1.08,
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.10)' } },
          axisLabel: { color: 'rgba(255,255,255,0.55)', fontFamily: t.font, fontSize: 11, formatter: (v) => compactMoney(v) },
        },
        series,
      };
    }).catch(() => {});

    const trendEl = $('#trend', ctx.el);
    mountChart(trendEl, (t) => ({
      animationDuration: 600,
      grid: grid({ top: 10 }),
      tooltip: {
        ...tipBox(t), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.dark ? 'rgba(255,255,255,0.04)' : 'rgba(17,26,48,0.04)' } },
        formatter: (ps) => {
          const m = d.trend[ps[0].dataIndex];
          return tipHTML(monthLabelFull(m.month), [
            { color: t.series[0], value: money(m.expense, { decimals: 0 }), label: 'Gastos', box: true },
            { color: t.series[1], value: money(m.income, { decimals: 0 }), label: 'Ingresos', box: true },
            { color: 'transparent', value: money(m.income - m.expense, { sign: true, decimals: 0 }), label: 'Balance' },
          ]);
        },
      },
      xAxis: catAxis(t, d.trend.map((m) => monthShort(m.month))),
      yAxis: valAxis(t),
      series: [
        {
          name: 'Gastos', type: 'bar', barMaxWidth: 14, barGap: '20%',
          data: d.trend.map((m) => ({ value: m.expense, itemStyle: { opacity: m.month === month ? 1 : 0.78 } })),
          itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] },
        },
        {
          name: 'Ingresos', type: 'bar', barMaxWidth: 14,
          data: d.trend.map((m) => ({ value: m.income, itemStyle: { opacity: m.month === month ? 1 : 0.78 } })),
          itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] },
        },
      ],
    })).then((inst) => {
      inst?.off('click');
      inst?.on('click', (p) => {
        month = d.trend[p.dataIndex].month;
        load();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }).catch(() => {});
  }

  // ---------- Eventos ----------
  on(ctx.el, 'click', '[data-act=month]', (e, b) => {
    month = shiftMonth(month, Number(b.dataset.d));
    load();
  });
  on(ctx.el, 'click', '[data-act=month-now]', () => {
    month = thisMonth();
    load();
  });
  on(ctx.el, 'click', '[data-act=all-cats]', () => {
    showAllCats = !showAllCats;
    draw();
  });
  on(ctx.el, 'click', '[data-act=first-tx]', () => openTxForm());
  on(ctx.el, 'click', '[data-qa]', (e, b) => {
    const a = b.dataset.qa;
    if (a === 'ticket') pickTicket().then((file) => file && openTxForm({ ticket: file }));
    else if (a === 'income') openTxForm({ kind: 'income' });
    else if (a === 'shop') quickShopping();
    else if (a === 'reminder') ctx.navigate('#/recordatorios?new=1');
    else if (a === 'price') ctx.navigate('#/precios?new=1');
  });
  on(ctx.el, 'click', '[data-tx]', (e, b) => {
    const t = data.recent.find((x) => x.id === Number(b.dataset.tx));
    if (t) openTxForm({ tx: t });
  });
  on(ctx.el, 'click', '[data-pay]', (e, b) => {
    const it = data.upcoming[Number(b.dataset.pay)];
    if (!it) return;
    if (it.type === 'bill') payBill(it);
    else payRecurring({ ...it, ref: it.id });
  });
  on(ctx.el, 'click', '[data-act=demo]', (e, b) => withBusy(b, async () => {
    try {
      await post('/demo');
      await loadHouse();
      notifyChange('household');
      toast('Datos de ejemplo cargados: una familia con dos hijos, una perra y un gato.');
      await load();
    } catch (err) {
      toastError(err);
    }
  }));

  on(ctx.el, 'click', '[data-act=setup]', () => import('../setup.js').then((m) => m.openSetup()));

  ctx.setRefresh(load);
  ctx.el.innerHTML = '<div class="hero skeleton" style="height:340px;background:var(--hero-bg);opacity:.9"></div>';
  await load();
  // Desde «Cómo se ve» (menú Más o Ajustes): se abre directamente «Personalizar el inicio».
  if (ctx.query.editar && ctx.isCurrent()) {
    history.replaceState(null, '', '#/inicio');
    customize();
  }
  // Hogar recién creado (o casi vacío) y sin preparar: se ofrece el asistente una vez por sesión.
  const h = store.house.household;
  const seenKey = `gastosbyath.setup.${h.id}`;
  let seen = true;
  try {
    seen = !!sessionStorage.getItem(seenKey);
    sessionStorage.setItem(seenKey, '1');
  } catch { /* sin almacenamiento: no se ofrece solo */ }
  if (can('admin') && !h.setup_done && data && data.fixedMonthly === 0 && data.recent.length < 10 && !seen) {
    import('../setup.js').then((m) => m.openSetup({ auto: true }));
  }
}

export function segments(p) {
  const n = p.installments;
  const dense = n > 24;
  if (n > 60) {
    return html`<div class="meter thick" style="--c:var(--saffron)"><div class="fill" style="width:${p.progress * 100}%"></div></div>`;
  }
  return html`<div class="segments ${dense ? 'dense' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${p.installments_done}"
    aria-label="${p.installments_done} de ${n} cuotas pagadas">
    ${Array.from({ length: n }, (_, i) => html`<i class="${i < p.installments_done ? 'done' : i === p.installments_done && !p.finished ? 'next' : ''}"></i>`)}</div>`;
}
