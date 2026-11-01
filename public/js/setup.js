// Asistente de primer uso: en un par de minutos la casa tiene sus ingresos, sus pagos fijos y un presupuesto,
// y la aplicación deja de estar vacía.
import { post } from './api.js';
import { $, $$, COLORS, amountStr, html, icon, money, on, parseAmount, promptDialog, sheet, today, toast, toastError, withBusy } from './ui.js';
import { loadHouse, people, store } from './store.js';
import { notifyChange, openTxForm, pickTicket } from './forms.js';
import { haptic } from './gestures.js';
import { applyTint } from './tint.js';

const INCOMES = [
  { name: 'Nómina', emoji: '💼', category: 'Nómina', day: 28 },
  { name: 'Pensión', emoji: '🧓', category: 'Otros ingresos', day: 25 },
  { name: 'Prestación o paro', emoji: '🏛️', category: 'Otros ingresos', day: 10 },
  { name: 'Alquiler que cobras', emoji: '🔑', category: 'Otros ingresos', day: 5 },
  { name: 'Otro ingreso fijo', emoji: '✨', category: 'Otros ingresos', day: 1 },
];
// [nombre, emoji, categoría, frecuencia, importe variable, forma de pago, ejemplo de importe, día]
const FIXED = [
  ['Alquiler', '🏠', 'Vivienda', 'monthly', 0, 'transfer', 750, 1], ['Hipoteca', '🏦', 'Vivienda', 'monthly', 0, 'direct_debit', 650, 1],
  ['Comunidad', '🏢', 'Vivienda', 'monthly', 0, 'direct_debit', 60, 5], ['Luz', '💡', 'Luz, agua y gas', 'monthly', 1, 'direct_debit', 70, 15],
  ['Agua', '💧', 'Luz, agua y gas', 'bimonthly', 1, 'direct_debit', 40, 20], ['Gas', '🔥', 'Luz, agua y gas', 'bimonthly', 1, 'direct_debit', 50, 20],
  ['Internet y móvil', '📶', 'Teléfono e internet', 'monthly', 0, 'direct_debit', 55, 5], ['Seguro de hogar', '🛡️', 'Seguros', 'annual', 0, 'direct_debit', 250, 1],
  ['Seguro del coche', '🚗', 'Seguros', 'annual', 0, 'direct_debit', 450, 1], ['Seguro de salud', '🩺', 'Seguros', 'monthly', 0, 'direct_debit', 60, 1],
  ['Préstamo', '💳', 'Otros gastos', 'monthly', 0, 'direct_debit', 200, 5], ['Gimnasio', '🏋️', 'Gimnasio y deporte', 'monthly', 0, 'direct_debit', 35, 1],
  ['Netflix', '🎬', 'Ocio y suscripciones', 'monthly', 0, 'card', 13.99, 10], ['Spotify', '🎧', 'Ocio y suscripciones', 'monthly', 0, 'card', 10.99, 10],
  ['Disney+', '🏰', 'Ocio y suscripciones', 'monthly', 0, 'card', 9.99, 10], ['Max', '📺', 'Ocio y suscripciones', 'monthly', 0, 'card', 9.99, 10],
  ['Amazon Prime', '📦', 'Ocio y suscripciones', 'annual', 0, 'card', 49.9, 1], ['Colegio', '🎓', 'Educación', 'monthly', 0, 'direct_debit', 120, 5],
  ['Guardería', '🧸', 'Educación', 'monthly', 0, 'direct_debit', 300, 5], ['Comedor escolar', '🍽️', 'Educación', 'monthly', 0, 'direct_debit', 110, 5],
  ['Extraescolares', '⚽', 'Educación', 'monthly', 0, 'direct_debit', 40, 5], ['IBI', '🧾', 'Impuestos y tasas', 'annual', 0, 'direct_debit', 350, 1],
  ['Impuesto de circulación', '🚘', 'Impuestos y tasas', 'annual', 0, 'direct_debit', 80, 1],
].map(([name, emoji, category, frequency, variable, method, example, day]) => ({ name, emoji, category, frequency, variable, method, example, day }));
const PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, fourweekly: 365 / 28 / 12, monthly: 1, bimonthly: 1 / 2, quarterly: 1 / 3, fourmonthly: 1 / 4, semiannual: 1 / 6, annual: 1 / 12 };
const FREQ_SHORT = { fourweekly: 'cada 4 semanas', monthly: 'al mes', bimonthly: 'cada 2 meses', quarterly: 'cada 3 meses', semiannual: 'cada 6 meses', annual: 'al año', weekly: 'a la semana' };
const HOUSE_ICONS = ['🏠', '🏡', '🏘️', '🏢', '🏰', '🛖', '⛺', '🌻', '🌊', '🌳', '🐾', '❤️'];
const KID_EMOJIS = ['👧', '👦', '🧒', '👶', '👵', '👴', '👩', '👨', '🧑'];
const STEPS = ['Vuestra casa', 'Lo que entra', 'Lo que pagáis', 'Presupuesto', 'La familia', 'Listo'];

const nextDateFor = (day) => {
  const t = new Date();
  for (let k = 0; k < 13; k++) {
    const d = new Date(t.getFullYear(), t.getMonth() + k, 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (s >= today()) return s;
  }
  return today();
};

export function openSetup({ auto = false } = {}) {
  const h = store.house.household;
  const st = {
    step: 0,
    house: { name: h.name, icon: h.icon, color: h.color },
    incomes: new Map(),
    fixed: new Map(),
    budget: null,
    noBudget: false,
    kids: [],
  };
  const s = sheet({ title: null, size: 'wide', className: 'setup', dismissable: true, body: '', onClose: (done) => {
    if (!done && auto) post('/setup/skip').catch(() => {});
    applyTint(store.house.household);
  } });
  const card = $('.sheet-card', s.el);

  const monthlyIn = () => [...st.incomes.values()].reduce((a, x) => a + (x.amount || 0), 0);
  const monthlyFixed = () => [...st.fixed.values()].reduce((a, x) => a + (x.amount || 0) * PER_MONTH[x.frequency || 'monthly'], 0);

  function view() {
    const dots = html`<ol class="su-steps" aria-label="Pasos">${STEPS.map((name, i) => html`<li class="${i < st.step ? 'done' : i === st.step ? 'now' : ''}" aria-current="${i === st.step ? 'step' : 'false'}"><span>${name}</span></li>`)}</ol>`;
    const body = [stepHouse, stepIncomes, stepFixed, stepBudget, stepFamily, stepDone][st.step]();
    const last = st.step === STEPS.length - 1;
    return html`<div class="su">
      <header class="su-head">${dots}<button class="btn ghost sm icon-only" data-close aria-label="Cerrar">${icon('x')}</button></header>
      <div class="su-body">${body}</div>
      <footer class="su-foot">
        ${st.step > 0 && !last ? html`<button class="btn ghost" data-su="back">${icon('chevron-left')}Atrás</button>` : html`<span></span>`}
        ${st.step === 0 && auto ? html`<button class="btn ghost" data-close>Ahora no</button>` : ''}
        <span class="spacer"></span>
        ${last ? html`<button class="btn primary lg" data-su="finish">${icon('check')}Guardar y empezar</button>`
          : html`<button class="btn primary lg" data-su="next">${st.step === 4 ? 'Ver el resumen' : 'Siguiente'}${icon('chevron-right')}</button>`}
      </footer></div>`;
  }
  const paint = () => {
    card.innerHTML = String(view());
    card.scrollTop = 0;
    $('.su-body', card).scrollTop = 0;
  };

  // ---------- Pasos ----------
  function stepHouse() {
    return html`<h2 class="su-title">Vamos a dejar vuestra casa lista</h2>
      <p class="su-lead">En dos minutos: lo que entra, lo que se paga cada mes y un presupuesto. Todo se puede cambiar luego.</p>
      <div class="field"><label for="su-name">Nombre del hogar</label><input class="input lg" id="su-name" data-house="name" value="${st.house.name}" maxlength="60"></div>
      <div class="field"><span class="label">Icono</span><div class="su-icons">${HOUSE_ICONS.map((e) => html`<button type="button" data-hicon="${e}" aria-pressed="${e === st.house.icon}">${e}</button>`)}</div></div>
      <div class="field"><span class="label">Color de la casa</span>
        <div class="swatches">${COLORS.map((c) => html`<button type="button" class="swatch" style="--c:${c}" data-hcolor="${c}" aria-pressed="${c.toUpperCase() === String(st.house.color).toUpperCase()}" aria-label="Color ${c}"></button>`)}</div>
        <span class="hint">Tiñe toda la aplicación: así se distingue de un vistazo en qué hogar estás.</span></div>`;
  }

  function itemRows(map, kind) {
    return html`${[...map.values()].map((x) => {
      const monthly = (x.frequency || 'monthly') === 'monthly';
      return html`<div class="su-item" data-item="${x.name}">
        <span class="emoji">${x.emoji}</span>
        <div class="su-item-name"><b>${x.name}</b><small>${x.variable ? 'Importe aproximado · ' : ''}${FREQ_SHORT[x.frequency || 'monthly']}</small></div>
        <div class="input-group su-amount"><input class="input" inputmode="decimal" data-amount value="${x.amount ? amountStr(x.amount) : ''}" placeholder="${x.example ? String(x.example).replace('.', ',') : '0'}" aria-label="Importe de ${x.name}"><span class="suffix">€</span></div>
        ${monthly ? html`<label class="su-day"><span>día</span><select class="select sm" data-day aria-label="Día del mes">${Array.from({ length: 31 }, (_, i) => html`<option value="${i + 1}" ${i + 1 === x.day ? 'selected' : ''}>${i + 1}</option>`)}</select></label>`
          : html`<label class="su-day"><span>próximo</span><input class="input sm" type="date" data-next value="${x.next_date || nextDateFor(x.day || 1)}" aria-label="Fecha del próximo pago"></label>`}
        ${kind === 'income' && people().length > 1 ? html`<select class="select sm su-who" data-who aria-label="Quién lo cobra"><option value="">¿Quién?</option>${people().map((p) => html`<option value="${p.id}" ${p.id === x.person_id ? 'selected' : ''}>${p.emoji} ${p.name}</option>`)}</select>` : ''}
        <button type="button" class="btn ghost sm icon-only" data-remove aria-label="Quitar ${x.name}">${icon('x', 'sm')}</button>
      </div>`;
    })}`;
  }

  function stepIncomes() {
    return html`<h2 class="su-title">¿Qué entra en casa cada mes?</h2>
      <p class="su-lead">Elige lo que tengáis y pon cuánto es. Se anotará solo cada mes el día que indiques.</p>
      <div class="su-tiles">${INCOMES.map((t) => html`<button type="button" class="su-tile" data-pick-income="${t.name}" aria-pressed="${st.incomes.has(t.name)}"><span class="emoji">${t.emoji}</span>${t.name}</button>`)}</div>
      <div class="su-items" data-list="income">${itemRows(st.incomes, 'income')}</div>
      ${st.incomes.size ? html`<div class="su-total">Entra al mes: <b>${money(Math.round(monthlyIn()))}</b></div>` : ''}`;
  }

  function stepFixed() {
    return html`<h2 class="su-title">¿Qué pagáis todos los meses?</h2>
      <p class="su-lead">Toca los que tengáis. Los que cambian de importe (luz, agua…) pon lo que suele venir: al pagar podrás ajustarlo.</p>
      <div class="su-tiles">${FIXED.map((t) => html`<button type="button" class="su-tile" data-pick-fixed="${t.name}" aria-pressed="${st.fixed.has(t.name)}"><span class="emoji">${t.emoji}</span>${t.name}</button>`)}
        <button type="button" class="su-tile ghost" data-act="custom-fixed"><span class="emoji">➕</span>Otro</button></div>
      <div class="su-items" data-list="expense">${itemRows(st.fixed, 'expense')}</div>
      ${st.fixed.size ? html`<div class="su-total">En pagos fijos: <b>${money(Math.round(monthlyFixed()))}</b> al mes de media</div>` : ''}`;
  }

  function stepBudget() {
    const inc = monthlyIn();
    const fix = monthlyFixed();
    const left = inc - fix;
    if (st.budget === null) {
      // Propuesta: los fijos y el 70 % de lo que queda para el día a día (redondeado a 50 €).
      const daily = left > 0 ? Math.round((left * 0.7) / 5000) * 5000 : 30000;
      st.budget = Math.round(fix / 100) * 100 + daily;
    }
    const daily = Math.max(0, st.budget - fix);
    const saving = inc - st.budget;
    const maxDaily = Math.max(left > 0 ? left : 100000, daily, 100000);
    return html`<h2 class="su-title">Un presupuesto para el mes</h2>
      <p class="su-lead">${inc ? html`Entran <b>${money(Math.round(inc))}</b> y se van <b>${money(Math.round(fix))}</b> en fijos: quedan <b>${money(Math.round(left))}</b> para el día a día y el ahorro.` : 'Elige cuánto queréis gastar como mucho al mes.'}</p>
      ${!st.noBudget ? html`<div class="su-budget">
        <div class="su-budget-num"><span>Gasto máximo al mes</span><b data-budget-total>${money(st.budget, { decimals: 0 })}</b></div>
        <label class="field"><span class="label">Para el día a día (súper, gasolina, salir…)</span>
          <input type="range" min="0" max="${Math.round(maxDaily / 100)}" step="10" value="${Math.round(daily / 100)}" data-daily aria-label="Gasto del día a día">
          <span class="su-range"><b data-daily-label>${money(daily, { decimals: 0 })}</b> al mes · <span data-saving>${inc ? (saving >= 0 ? `ahorraríais ${money(saving, { decimals: 0 })} al mes` : `faltarían ${money(-saving, { decimals: 0 })} al mes`) : ''}</span></span></label>
      </div>` : ''}
      <label class="switch"><input type="checkbox" data-nobudget ${st.noBudget ? 'checked' : ''}><span class="track"></span><span class="txt">Prefiero no poner presupuesto<small>Podréis ponerlo cuando queráis en Presupuestos.</small></span></label>`;
  }

  function stepFamily() {
    return html`<h2 class="su-title">¿Quién vive en casa?</h2>
      <p class="su-lead">Añade a los peques o a quien no vaya a usar la app: así podréis apuntar para quién es cada gasto. A los mayores, mejor invítalos desde Ajustes → Miembros.</p>
      <div class="su-people">${people().map((p) => html`<span class="su-person"><span class="emoji">${p.emoji}</span>${p.name}</span>`)}
        ${st.kids.map((k, i) => html`<span class="su-person new"><span class="emoji">${k.emoji}</span>${k.name}<button type="button" data-rmkid="${i}" aria-label="Quitar ${k.name}">${icon('x', 'sm')}</button></span>`)}</div>
      <form class="su-addkid" data-addkid>
        <select class="select" name="emoji" aria-label="Emoji">${KID_EMOJIS.map((e) => html`<option>${e}</option>`)}</select>
        <input class="input" name="name" placeholder="Nombre (Lucía, Pablo…)" maxlength="40" aria-label="Nombre">
        <button class="btn" type="submit">${icon('plus')}Añadir</button></form>`;
  }

  function stepDone() {
    const inc = monthlyIn();
    const fix = monthlyFixed();
    const rows = [
      ['Hogar', `${st.house.icon} ${st.house.name}`],
      ['Ingresos fijos', st.incomes.size ? `${st.incomes.size} · ${money(Math.round(inc))} al mes` : 'Ninguno'],
      ['Pagos fijos', st.fixed.size ? `${st.fixed.size} · ${money(Math.round(fix))} al mes de media` : 'Ninguno'],
      ['Presupuesto', st.noBudget ? 'Sin presupuesto' : `${money(st.budget, { decimals: 0 })} al mes`],
      ['Familia', [...people().map((p) => p.name), ...st.kids.map((k) => k.name)].join(', ')],
    ];
    return html`<h2 class="su-title">Todo listo</h2>
      <p class="su-lead">Esto es lo que se va a guardar. Los pagos e ingresos fijos se anotarán solos cada vez que toque.</p>
      <dl class="su-summary">${rows.map(([k, val]) => html`<div><dt>${k}</dt><dd>${val}</dd></div>`)}</dl>
      ${inc && !st.noBudget ? html`<div class="su-hint">${icon('piggy-bank')}<span>${inc - st.budget >= 0 ? html`Con este presupuesto, cada mes os quedarían unos <b>${money(inc - st.budget, { decimals: 0 })}</b> para ahorrar.` : html`El presupuesto supera lo que entra en <b>${money(st.budget - inc, { decimals: 0 })}</b>: revisadlo cuando podáis.`}</span></div>` : ''}`;
  }

  // ---------- Datos de cada paso ----------
  const readItems = () => {
    for (const row of $$('[data-item]', card)) {
      const map = row.closest('[data-list]').dataset.list === 'income' ? st.incomes : st.fixed;
      const x = map.get(row.dataset.item);
      if (!x) continue;
      const a = parseAmount($('[data-amount]', row).value);
      x.amount = Number.isNaN(a) || a <= 0 ? null : a;
      const day = $('[data-day]', row);
      if (day) x.day = Number(day.value);
      const next = $('[data-next]', row);
      if (next) x.next_date = next.value;
      const who = $('[data-who]', row);
      if (who) x.person_id = Number(who.value) || null;
    }
  };
  const validateStep = () => {
    readItems();
    if (st.step === 0) {
      st.house.name = $('[data-house=name]', card).value.trim() || st.house.name;
    }
    const missing = [...(st.step === 1 ? st.incomes : st.step === 2 ? st.fixed : new Map()).values()].filter((x) => !x.amount);
    if (missing.length) {
      toast(`Falta el importe de ${missing.map((x) => x.name).join(', ')}`, { type: 'err' });
      $(`[data-item="${CSS.escape(missing[0].name)}"] [data-amount]`, card)?.focus();
      return false;
    }
    return true;
  };

  on(card, 'click', '[data-su=next]', () => {
    if (!validateStep()) return;
    st.step = Math.min(st.step + 1, STEPS.length - 1);
    haptic(8);
    paint();
  });
  on(card, 'click', '[data-su=back]', () => {
    readItems();
    st.step = Math.max(0, st.step - 1);
    paint();
  });
  on(card, 'input', '[data-house=name]', (e, inp) => (st.house.name = inp.value));
  on(card, 'click', '[data-hicon]', (e, b) => {
    st.house.icon = b.dataset.hicon;
    $$('[data-hicon]', card).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
  on(card, 'click', '[data-hcolor]', (e, b) => {
    st.house.color = b.dataset.hcolor;
    $$('[data-hcolor]', card).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    applyTint({ color: st.house.color, tint: 1 });
  });
  const toggle = (map, tpl) => {
    readItems();
    if (map.has(tpl.name)) map.delete(tpl.name);
    else map.set(tpl.name, { ...tpl, amount: null });
    paint();
    $(`[data-item="${CSS.escape(tpl.name)}"] [data-amount]`, card)?.focus();
  };
  on(card, 'click', '[data-pick-income]', (e, b) => toggle(st.incomes, INCOMES.find((x) => x.name === b.dataset.pickIncome)));
  on(card, 'click', '[data-pick-fixed]', (e, b) => toggle(st.fixed, FIXED.find((x) => x.name === b.dataset.pickFixed)));
  on(card, 'click', '[data-act=custom-fixed]', async () => {
    readItems();
    const name = (await promptDialog({ title: 'Otro pago fijo', label: '¿Cómo se llama?', placeholder: 'Academia de inglés, cuota del club…', confirm: 'Añadir' }))?.trim().slice(0, 60);
    if (!name || st.fixed.has(name)) return;
    st.fixed.set(name, { name, emoji: '📌', category: 'Otros gastos', frequency: 'monthly', variable: 0, method: 'direct_debit', day: 1, amount: null });
    paint();
    $(`[data-item="${CSS.escape(name)}"] [data-amount]`, card)?.focus();
  });
  on(card, 'click', '[data-remove]', (e, b) => {
    readItems();
    const row = b.closest('[data-item]');
    (row.closest('[data-list]').dataset.list === 'income' ? st.incomes : st.fixed).delete(row.dataset.item);
    paint();
  });
  on(card, 'input', '[data-amount]', () => {
    readItems();
    const tot = $('.su-total b', card);
    if (tot) tot.textContent = money(Math.round(st.step === 1 ? monthlyIn() : monthlyFixed()));
  });
  on(card, 'input', '[data-daily]', (e, r) => {
    const daily = Number(r.value) * 100;
    st.budget = Math.round(monthlyFixed() / 100) * 100 + daily;
    $('[data-daily-label]', card).textContent = money(daily, { decimals: 0 });
    $('[data-budget-total]', card).textContent = money(st.budget, { decimals: 0 });
    const inc = monthlyIn();
    if (inc) $('[data-saving]', card).textContent = inc - st.budget >= 0 ? `ahorraríais ${money(inc - st.budget, { decimals: 0 })} al mes` : `faltarían ${money(st.budget - inc, { decimals: 0 })} al mes`;
  });
  on(card, 'change', '[data-nobudget]', (e, c) => {
    st.noBudget = c.checked;
    paint();
  });
  on(card, 'submit', '[data-addkid]', (e, f) => {
    e.preventDefault();
    const name = f.elements.name.value.trim();
    if (!name) return f.elements.name.focus();
    st.kids.push({ name, emoji: f.elements.emoji.value });
    paint();
    $('[data-addkid] [name=name]', card)?.focus();
  });
  on(card, 'click', '[data-rmkid]', (e, b) => {
    st.kids.splice(Number(b.dataset.rmkid), 1);
    paint();
  });
  on(card, 'click', '[data-su=finish]', (e, b) => withBusy(b, async () => {
    const item = (x) => ({
      name: x.name, amount: x.amount, category: x.category, frequency: x.frequency || 'monthly', variable: !!x.variable, method: x.method,
      ...(x.frequency && x.frequency !== 'monthly' ? { next_date: x.next_date || nextDateFor(x.day || 1) } : { day: x.day || 1 }), person_id: x.person_id || null,
    });
    try {
      const r = await post('/setup', {
        house: st.house, incomes: [...st.incomes.values()].map(item), fixed: [...st.fixed.values()].map(item),
        budget: st.noBudget ? undefined : st.budget, people: st.kids,
      });
      await loadHouse();
      notifyChange('household');
      s.close(true);
      haptic(20);
      celebrate(r);
    } catch (err) {
      toastError(err);
    }
  }));
  paint();
  return s;
}

// Final: qué se ha guardado y cómo seguir.
function celebrate(r) {
  const s = sheet({
    title: null, size: 'narrow',
    body: html`<div class="su-yay"><div class="art">🎉</div><h2>¡Casa lista!</h2>
      <p>${r.created ? `${r.created} pagos e ingresos fijos guardados: se anotarán solos.` : 'Ya puedes empezar a anotar.'} Ahora, lo primero: anota un gasto o haz una foto a un ticket.</p>
      <div class="stack" style="gap:8px;margin-top:6px">
        <button class="btn primary lg block" data-yay="ticket">${icon('camera')}Foto del ticket</button>
        <button class="btn lg block" data-yay="tx">${icon('plus')}Anotar un gasto</button>
        <button class="btn ghost block" data-close>Más tarde</button></div></div>`,
  });
  on(s.el, 'click', '[data-yay=ticket]', () => {
    s.close();
    pickTicket().then((f) => f && openTxForm({ ticket: f }));
  });
  on(s.el, 'click', '[data-yay=tx]', () => {
    s.close();
    openTxForm();
  });
}
