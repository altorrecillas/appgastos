// Formularios compartidos: anotar movimientos y piezas reutilizables (importe, categorías, adjuntos…).
import { del, get, hurl, patch, post, upload } from './api.js';
import {
  $, $$, COLORS, EMOJIS, METHOD_ICONS, METHOD_NAMES, SPECIES, addDays, amountStr, debounce, focusLater, html, icon, money, on, parseAmount,
  sheet, today, toast, toastError, withBusy,
} from './ui.js';
import { can, cat, categories, myPersonId, people, pets, pref, store } from './store.js';
import { haptic } from './gestures.js';
import { enqueue, isOffline, newId, pending as pendingOps } from './offline.js';

export const notifyChange = (entity) => window.dispatchEvent(new CustomEvent('gastosbyath:changed', { detail: { entity } }));

// ---------- Piezas ----------

export function amountField(name, cents, { kind = 'expense', autofocus = false, label = 'Importe' } = {}) {
  return html`<div class="amount-input ${kind === 'income' ? 'income' : ''}" data-amount-wrap>
      <label class="sr-only" for="f-${name}">${label}</label>
      <input id="f-${name}" name="${name}" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${amountStr(cents)}"
        ${autofocus ? 'data-autofocus' : ''} enterkeyhint="done">
      <span class="cur">€</span>
    </div>
    <div class="amount-hint" data-amount-hint></div>`;
}

// El campo crece con lo que se escribe y muestra el resultado de una suma ("12,40+3").
const measurer = document.createElement('span');
measurer.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0';
function fitAmount(input) {
  if (!measurer.isConnected) document.body.append(measurer);
  const cs = getComputedStyle(input);
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStretch', 'fontStyle', 'letterSpacing', 'fontVariationSettings', 'fontFeatureSettings']) {
    measurer.style[k] = cs[k];
  }
  measurer.textContent = input.value || input.placeholder || '0';
  input.style.width = `${Math.ceil(measurer.getBoundingClientRect().width) + 12}px`;
}
export function bindAmount(root) {
  $$('[data-amount-wrap] input', root).forEach((input) => {
    const hint = input.closest('[data-amount-wrap]').nextElementSibling;
    input.addEventListener('input', () => fitAmount(input));
    requestAnimationFrame(() => fitAmount(input));
    document.fonts?.ready.then(() => fitAmount(input));
    const upd = () => {
      const v = input.value.trim();
      if (/[+-]/.test(v.replace(/^[-+]/, ''))) {
        const c = parseAmount(v);
        hint.textContent = Number.isNaN(c) ? 'Revisa la operación' : `= ${money(c)}`;
      } else hint.textContent = '';
    };
    input.addEventListener('input', upd);
    upd();
  });
}

export function catPicker(kind, selected, { name = 'category_id' } = {}) {
  const list = categories(kind);
  return html`<div class="cat-grid" role="radiogroup" data-pick="${name}">
    ${list.map((c) => html`<button type="button" class="cat-opt" role="radio" data-v="${c.id}" style="--c:${c.color}"
      aria-pressed="${c.id === selected}" aria-checked="${c.id === selected}"><span class="emoji">${c.icon}</span>${c.name}</button>`)}
  </div><input type="hidden" name="${name}" value="${selected ?? ''}">`;
}

// Selección única (chips / categorías): actualiza el input oculto con el mismo name.
export function bindPickers(root, onPick) {
  on(root, 'click', '[data-pick] [data-v]', (e, btn) => {
    const group = btn.closest('[data-pick]');
    const input = root.querySelector(`input[type=hidden][name="${group.dataset.pick}"]`);
    const multi = group.hasAttribute('data-multi');
    const already = btn.getAttribute('aria-pressed') === 'true';
    if (!multi) {
      $$('[data-v]', group).forEach((b) => {
        b.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-checked', 'false');
      });
    }
    const optional = group.hasAttribute('data-optional');
    const next = optional && already ? false : !already || !multi ? true : false;
    btn.setAttribute('aria-pressed', String(next));
    btn.setAttribute('aria-checked', String(next));
    if (input) {
      if (multi) input.value = $$('[data-v][aria-pressed=true]', group).map((b) => b.dataset.v).join(',');
      else input.value = next ? btn.dataset.v : '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    onPick?.(group.dataset.pick, input?.value, btn);
  });
}

export function chipPicker(name, options, selected, { optional = true, multi = false, scroll = false } = {}) {
  const sel = multi ? String(selected ?? '').split(',').filter(Boolean) : [String(selected ?? '')];
  return html`<div class="chips ${scroll ? 'scroll' : ''}" data-pick="${name}" ${optional ? 'data-optional' : ''} ${multi ? 'data-multi' : ''}>
    ${options.map((o) => html`<button type="button" class="chip" data-v="${o.value}" aria-pressed="${sel.includes(String(o.value))}">
      ${o.img ? html`<img class="chip-img" src="${o.img}" alt="">` : o.emoji ? html`<span class="emoji">${o.emoji}</span>` : ''}${o.icon ? icon(o.icon, 'sm') : ''}${o.label}</button>`)}
  </div><input type="hidden" name="${name}" value="${multi ? sel.join(',') : selected ?? ''}">`;
}

export const personOptions = () => people().map((p) => ({ value: p.id, label: p.name, emoji: p.emoji, img: p.photo_id ? hurl(`/attachments/${p.photo_id}`) : null }));
export const methodOptions = () => Object.entries(METHOD_NAMES).map(([value, label]) => ({ value, label, icon: METHOD_ICONS[value] }));
export const petOptions = () => pets().map((p) => ({ value: p.id, label: p.name, emoji: SPECIES[p.species]?.emoji || '🐾' }));

export function colorPicker(name, value) {
  return html`<div class="swatches" data-pick="${name}">
    ${COLORS.map((c) => html`<button type="button" class="swatch" style="--c:${c}" data-v="${c}" aria-pressed="${c.toUpperCase() === String(value).toUpperCase()}" aria-label="Color ${c}"></button>`)}
  </div><input type="hidden" name="${name}" value="${value || COLORS[0]}">`;
}

export function emojiPicker(name, value, extra = []) {
  const list = [...new Set([value, ...extra, ...EMOJIS].filter(Boolean))];
  return html`<div class="emoji-pick" data-pick="${name}">
    ${list.map((e) => html`<button type="button" data-v="${e}" aria-pressed="${e === value}">${e}</button>`)}
  </div><input type="hidden" name="${name}" value="${value || list[0]}">`;
}

export function dateQuick(name, value, { label = 'Fecha' } = {}) {
  const t = today();
  const y = addDays(t, -1);
  return html`<div class="field"><label>${label}</label>
    <div class="row wrap" data-date-quick>
      <div class="segmented"><button type="button" data-d="${t}" aria-pressed="${value === t}">Hoy</button>
      <button type="button" data-d="${y}" aria-pressed="${value === y}">Ayer</button></div>
      <input class="input sm" type="date" name="${name}" value="${value}" style="width:auto;flex:1;min-width:150px" required>
    </div></div>`;
}
export function bindDateQuick(root) {
  $$('[data-date-quick]', root).forEach((wrap) => {
    const input = $('input[type=date]', wrap);
    const sync = () => $$('[data-d]', wrap).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.d === input.value)));
    on(wrap, 'click', '[data-d]', (e, b) => {
      input.value = b.dataset.d;
      sync();
    });
    input.addEventListener('change', sync);
  });
}

// Adjuntos: foto del ticket o PDF de la factura.
export function attachmentField(current, { label = 'Ticket o factura', accept = 'image/*,application/pdf' } = {}) {
  return html`<div class="field" data-attach>
    <label>${label}</label>
    <input type="hidden" name="attachment_id" value="${current?.id ?? ''}">
    <input type="file" accept="${accept}" hidden data-file>
    <div data-attach-view>${attachmentPreview(current)}</div>
  </div>`;
}
function attachmentPreview(a) {
  if (!a?.id) {
    return html`<div class="row wrap">
      <button type="button" class="btn sm" data-act="pick-file">${icon('paperclip')}Adjuntar archivo</button>
      <button type="button" class="btn sm mobile-only" data-act="pick-camera" style="display:inline-flex">${icon('camera')}Hacer foto</button>
      <span class="drop-hint desktop-only">o arrastra aquí una imagen o PDF</span></div>`;
  }
  const isImg = String(a.mime).startsWith('image/');
  return html`<div class="attach">
    ${isImg ? html`<img src="${hurl(`/attachments/${a.id}`)}" alt="">` : html`<div class="file-ico">${icon('file-text')}</div>`}
    <div class="grow"><div class="ellipsis" style="font-weight:560">${a.name}</div>
      <a class="small" href="${hurl(`/attachments/${a.id}`)}" target="_blank" rel="noopener">Abrir</a></div>
    <button type="button" class="btn ghost sm icon-only" data-act="remove-file" aria-label="Quitar adjunto">${icon('x')}</button>
  </div>`;
}
export function bindAttachment(root) {
  const wrap = $('[data-attach]', root);
  if (!wrap) return;
  const fileInput = $('[data-file]', wrap);
  const hidden = $('input[name=attachment_id]', wrap);
  const view = $('[data-attach-view]', wrap);
  const handle = async (file) => {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) return toastError(new Error('El archivo supera los 15 MB'));
    wrap.pendingFile = null;
    view.innerHTML = '<div class="attach"><div class="file-ico skeleton"></div><div class="grow muted">Subiendo…</div></div>';
    try {
      const a = await upload(file);
      hidden.value = a.id;
      view.innerHTML = String(attachmentPreview(a));
    } catch (e) {
      if (isOffline(e)) {
        // Sin conexión: se guarda en el dispositivo y se sube junto con el gasto.
        wrap.pendingFile = file;
        hidden.value = '';
        const isImg = file.type.startsWith('image/');
        view.innerHTML = String(html`<div class="attach">
          ${isImg ? html`<img src="${URL.createObjectURL(file)}" alt="">` : html`<div class="file-ico">${icon('file-text')}</div>`}
          <div class="grow"><div class="ellipsis" style="font-weight:560">${file.name}</div><span class="small muted">Se subirá al volver la conexión</span></div>
          <button type="button" class="btn ghost sm icon-only" data-act="remove-file" aria-label="Quitar adjunto">${icon('x')}</button></div>`);
        return;
      }
      view.innerHTML = String(attachmentPreview(null));
      toastError(e);
    }
  };
  wrap.addEventListener('attach-file', (e) => handle(e.detail));
  on(wrap, 'click', '[data-act=pick-file]', () => {
    fileInput.removeAttribute('capture');
    fileInput.click();
  });
  on(wrap, 'click', '[data-act=pick-camera]', () => {
    fileInput.setAttribute('capture', 'environment');
    fileInput.accept = 'image/*';
    fileInput.click();
  });
  on(wrap, 'click', '[data-act=remove-file]', () => {
    hidden.value = '';
    wrap.pendingFile = null;
    view.innerHTML = String(attachmentPreview(null));
  });
  fileInput.addEventListener('change', () => handle(fileInput.files[0]));
  // Arrastrar y soltar sobre la hoja (una sola vez aunque el formulario se redibuje).
  const card = root.closest('.sheet-card') || root;
  card._dropHandler = (e) => {
    e.preventDefault();
    handle(e.dataTransfer.files[0]);
  };
  if (!card._dropBound) {
    card._dropBound = true;
    card.addEventListener('dragover', (e) => e.preventDefault());
    card.addEventListener('drop', (e) => card._dropHandler(e));
  }
}

// Lee los campos con name de un formulario como objeto plano.
export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}
export const intOrNull = (v) => (v === '' || v === undefined || v === null ? null : Number(v));

export function showFormError(form, message) {
  let box = $('.form-error', form);
  if (!message) return box?.remove();
  if (!box) {
    box = document.createElement('div');
    box.className = 'form-error';
    form.prepend(box);
  }
  box.innerHTML = String(html`${icon('circle-alert', 'sm')}<span>${message}</span>`);
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function focusFirst(root) {
  const el = $('[data-autofocus]', root);
  if (el && window.matchMedia('(pointer: fine)').matches) focusLater(el, 60);
  else if (el && root.closest('dialog')) focusLater(el, 260);
}

// ---------- Anotar / editar un movimiento ----------

// Abre la cámara (o la galería) para leer un ticket. Hay que llamarla dentro del toque de la persona.
export function pickTicket({ camera = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.setAttribute('capture', 'environment');
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

export function openTxForm({ tx = null, kind = tx?.kind || 'expense', defaults = {}, ticket = null, focusTicket = false } = {}) {
  if (!can('edit')) return toast('Tu rol en este hogar es de solo lectura', { type: 'err' });
  // El consumo de luz estimado se calcula desde «Consumo de luz».
  if (tx?.estimate) {
    location.hash = '#/luz';
    return Promise.resolve();
  }
  const editing = !!tx;
  const d = {
    kind,
    amount: null,
    date: today(),
    description: '',
    merchant: '',
    category_id: null,
    person_id: kind === 'expense' ? myPersonId() : null,
    method: pref('gastosbyath.method') || 'card',
    pet_id: null,
    notes: '',
    attachment_id: null,
    ...defaults,
    ...(tx || {}),
  };
  const attach = d.attachment_id ? { id: d.attachment_id, name: d.attachment_name || 'Adjunto', mime: d.attachment_mime || '' } : null;
  const showMore = editing && (d.merchant || d.notes || d.pet_id || d.attachment_id);

  const body = (k) => html`
    <form class="form" id="txf" autocomplete="off">
      <div class="segmented block kind" data-kind>
        <button type="button" data-v="expense" aria-pressed="${k === 'expense'}">${icon('arrow-up-right', 'sm')}Gasto</button>
        <button type="button" data-v="income" aria-pressed="${k === 'income'}">${icon('arrow-down-right', 'sm')}Ingreso</button>
      </div>
      <input type="hidden" name="kind" value="${k}">
      <div class="amount-stage ${k === 'income' ? 'income' : ''}">${amountField('amount', d.amount, { kind: k, autofocus: true })}</div>
      ${!editing && k === 'expense' ? html`<div class="ticket-zone" data-ticket-zone>${ticketButtons()}</div>` : ''}
      ${!editing ? html`<div class="freq" data-freq aria-label="Habituales"></div>` : ''}
      <div class="field ac">
        <label for="f-desc">Concepto</label>
        <input class="input" id="f-desc" name="description" value="${d.description}" maxlength="120"
          placeholder="${k === 'expense' ? 'Mercadona, gasolina, farmacia…' : 'Nómina, venta, devolución…'}">
        <div class="ac-list hidden" data-ac role="listbox"></div>
      </div>
      <div class="field"><label>Categoría <span class="cat-hint" data-cat-hint hidden>sugerida por el concepto</span></label><div data-cats>${catPicker(k, d.category_id)}</div></div>
      ${dateQuick('date', d.date)}
      <button type="button" class="more-toggle" data-act="more" aria-expanded="${!!showMore}">
        ${icon(showMore ? 'chevron-up' : 'chevron-down', 'sm')}Más detalles</button>
      <div class="stack ${showMore ? '' : 'hidden'}" data-more style="gap:16px">
        ${people().length ? html`<div class="field"><label>${k === 'expense' ? '¿Quién lo ha pagado o para quién es?' : '¿Quién lo recibe?'}</label>
          ${chipPicker('person_id', personOptions(), d.person_id, { scroll: true })}</div>` : ''}
        ${k === 'expense' ? html`<div class="field"><label>Forma de pago</label>${chipPicker('method', methodOptions(), d.method, { scroll: true })}</div>` : ''}
        ${k === 'expense' && pets().length ? html`<div class="field"><label>Mascota</label>${chipPicker('pet_id', petOptions(), d.pet_id)}</div>` : ''}
        <div class="field"><label for="f-merchant">Comercio o pagador</label>
          <input class="input" id="f-merchant" name="merchant" value="${d.merchant}" maxlength="80" placeholder="Opcional"></div>
        <div class="field"><label for="f-notes">Notas</label>
          <textarea class="textarea" id="f-notes" name="notes" maxlength="1000" placeholder="Opcional">${d.notes}</textarea></div>
        ${attachmentField(attach)}
      </div>
    </form>`;

  const s = sheet({
    title: editing ? (d.kind === 'expense' ? 'Editar gasto' : 'Editar ingreso') : 'Anotar movimiento',
    body: body(d.kind),
    foot: html`${editing ? html`<button class="btn danger icon-only" data-act="delete" aria-label="Borrar">${icon('trash-2')}</button>` : ''}
      <span class="spacer"></span>
      ${!editing ? html`<button class="btn desktop-only" data-act="save-another">Guardar y anotar otro</button>` : ''}
      <button class="btn primary" data-act="save">${editing ? 'Guardar cambios' : 'Guardar'}</button>`,
  });

  const bindAll = () => {
    const form = $('#txf', s.el);
    // Lo que la persona toca a mano no lo pisa luego el lector de tickets.
    form.dataset.dateAuto = '1';
    const userDate = (e) => {
      if (e.isTrusted) delete form.dataset.dateAuto;
    };
    $('input[name=date]', form)?.addEventListener('input', userDate);
    on(form, 'click', '[data-date-quick] [data-d]', userDate);
    $('#f-amount', form).addEventListener('input', (e) => {
      if (e.isTrusted) delete e.target.dataset.fromTicket;
    });
    bindAmount(form);
    bindDateQuick(form);
    bindAttachment(form);
    bindSuggest(form);
    bindAutoCategory(form);
    focusFirst(form);
    if (!editing) loadFrequent(form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      save(false, $('[data-act=save]', s.el));
    });
    $('#f-amount', form).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('#f-desc', form).focus();
      }
    });
  };
  bindPickers(s.body);

  on(s.body, 'click', '[data-kind] [data-v]', (e, b) => {
    const form = $('#txf', s.el);
    const cur = readForm(form);
    const k = b.dataset.v;
    if (k === cur.kind) return;
    Object.assign(d, {
      kind: k, amount: Number.isNaN(parseAmount(cur.amount)) ? null : parseAmount(cur.amount), description: cur.description, date: cur.date,
      category_id: null, notes: cur.notes || '', merchant: cur.merchant || '',
    });
    s.body.innerHTML = String(body(k));
    bindAll();
  });
  on(s.body, 'click', '[data-act=more]', (e, b) => {
    const more = $('[data-more]', s.body);
    const open = more.classList.toggle('hidden') === false;
    b.setAttribute('aria-expanded', String(open));
    b.innerHTML = String(html`${icon(open ? 'chevron-up' : 'chevron-down', 'sm')}Más detalles`);
  });

  // Los gastos que más se repiten, para rellenar el formulario con un solo toque.
  async function loadFrequent(form) {
    const box = $('[data-freq]', form);
    if (!box) return;
    const kindNow = $('input[name=kind]', form).value;
    let list = [];
    try {
      list = await get(`/transactions/frequent?kind=${kindNow}`);
    } catch {
      return;
    }
    if (!box.isConnected || !list.length) return box.remove();
    box.innerHTML = String(html`${list.map((it, i) => html`<button type="button" data-fq="${i}"><span class="emoji">${it.category_icon || '🏷️'}</span>
      ${it.description}<small>${money(it.amount, { decimals: it.amount % 100 ? 2 : 0 })}</small></button>`)}`);
    on(box, 'click', '[data-fq]', (e, b) => {
      const it = list[Number(b.dataset.fq)];
      $('#f-desc', form).value = it.description;
      const m = $('#f-merchant', form);
      if (m) m.value = it.merchant || '';
      for (const [name, value] of [['category_id', it.category_id], ['method', it.method], ['person_id', it.person_id]]) {
        if (value == null) continue;
        const btn = $(`[data-pick=${name}] [data-v="${value}"]`, form);
        if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
      }
      const amt = $('#f-amount', form);
      amt.value = amountStr(it.amount);
      amt.dispatchEvent(new Event('input'));
      amt.focus();
      amt.select();
      haptic(10);
    });
  }

  // Al escribir el concepto se propone la categoría (lo aprendido del hogar o comercios conocidos),
  // salvo que la persona ya haya elegido una.
  function bindAutoCategory(form) {
    let chosen = !!$('input[name=category_id]', form).value;
    const hint = $('[data-cat-hint]', form);
    on(form, 'click', '[data-pick=category_id] [data-v]', (e) => {
      if (e.isTrusted) {
        chosen = true;
        hint.hidden = true;
      }
    });
    const guess = debounce(async () => {
      if (chosen) return;
      const text = `${$('#f-merchant', form)?.value || ''} ${$('#f-desc', form).value}`.trim();
      if (text.length < 3) return;
      try {
        const [g] = await post('/rules/categorize', { items: [{ text, kind: $('input[name=kind]', form).value }] });
        if (chosen || !form.isConnected || !g?.category_id || g.confidence < 0.7) return;
        const btn = $(`[data-pick=category_id] [data-v="${g.category_id}"]`, form);
        if (btn && btn.getAttribute('aria-pressed') !== 'true') {
          btn.click();
          hint.hidden = false;
        }
      } catch { /* sin sugerencia */ }
    }, 400);
    $('#f-desc', form).addEventListener('input', guess);
    $('#f-merchant', form)?.addEventListener('input', guess);
  }

  function bindSuggest(form) {
    const input = $('#f-desc', form);
    const list = $('[data-ac]', form);
    let items = [];
    let idx = -1;
    const hide = () => {
      list.classList.add('hidden');
      idx = -1;
    };
    const apply = (it) => {
      input.value = it.description || it.merchant;
      const m = $('#f-merchant', form);
      if (m && !m.value && it.merchant && it.merchant !== input.value) m.value = it.merchant;
      const kindNow = $('input[name=kind]', form).value;
      if (it.category_id && it.kind === kindNow) {
        const btn = $(`[data-pick=category_id] [data-v="${it.category_id}"]`, form);
        if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
      }
      const amt = $('#f-amount', form);
      if (!amt.value && it.amount) amt.value = amountStr(it.amount);
      if (it.method) {
        const mb = $(`[data-pick=method] [data-v="${it.method}"]`, form);
        if (mb && mb.getAttribute('aria-pressed') !== 'true') mb.click();
      }
      hide();
    };
    const fetchSug = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) return hide();
      try {
        items = await get(`/transactions/suggest?q=${encodeURIComponent(q)}`);
      } catch {
        items = [];
      }
      if (!items.length || document.activeElement !== input) return hide();
      list.innerHTML = String(html`${items.map((it, i) => {
        const c = categories().find((x) => x.id === it.category_id);
        return html`<button type="button" role="option" data-i="${i}"><span class="emoji">${c?.icon || '🏷️'}</span>
          <span class="grow ellipsis">${it.description || it.merchant}${it.merchant && it.description && it.merchant !== it.description ? html` <span class="muted">· ${it.merchant}</span>` : ''}</span>
          <span class="a">${money(it.amount)}</span></button>`;
      })}`);
      list.classList.remove('hidden');
    }, 180);
    input.addEventListener('input', fetchSug);
    input.addEventListener('blur', () => setTimeout(hide, 150));
    input.addEventListener('keydown', (e) => {
      if (list.classList.contains('hidden')) {
        if (e.key === 'Enter') {
          e.preventDefault();
          save(false, $('[data-act=save]', s.el));
        }
        return;
      }
      const btns = $$('button', list);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
        btns.forEach((b, i) => b.setAttribute('aria-selected', String(i === idx)));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (idx >= 0) apply(items[idx]);
        else hide();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        hide();
      }
    });
    on(list, 'mousedown', '[data-i]', (e, b) => {
      e.preventDefault();
      apply(items[Number(b.dataset.i)]);
    });
  }

  async function save(another, btn) {
    const form = $('#txf', s.el);
    const v = readForm(form);
    const amount = parseAmount(v.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      showFormError(form, 'Escribe un importe mayor que cero');
      $('#f-amount', form).focus();
      return;
    }
    const payload = {
      kind: v.kind,
      amount,
      date: v.date,
      description: v.description,
      merchant: v.merchant ?? '',
      category_id: intOrNull(v.category_id),
      person_id: intOrNull(v.person_id),
      method: v.kind === 'expense' ? v.method || null : 'transfer',
      pet_id: v.kind === 'expense' ? intOrNull(v.pet_id) : null,
      notes: v.notes ?? '',
      attachment_id: intOrNull(v.attachment_id),
    };
    if (!payload.description && !payload.category_id) {
      showFormError(form, 'Pon un concepto o elige una categoría');
      return;
    }
    // Cada gasto nuevo lleva su identificador: si se envía dos veces (mala cobertura), no se duplica.
    if (!editing) {
      d.clientId = d.clientId || newId();
      payload.client_id = d.clientId;
    }
    const attachWrap = $('[data-attach]', form);
    await withBusy(btn, async () => {
      try {
        if (attachWrap?.pendingFile && !payload.attachment_id) {
          const a = await upload(attachWrap.pendingFile);
          payload.attachment_id = a.id;
        }
        const saved = editing ? await patch(`/transactions/${tx.id}`, payload) : await post('/transactions', payload);
        if (payload.method && payload.kind === 'expense') pref('gastosbyath.method', payload.method);
        notifyChange('transactions');
        const what = `${payload.kind === 'expense' ? 'Gasto' : 'Ingreso'} de ${money(amount)}`;
        if (editing) toast(`${what} guardado`);
        else {
          toast(`${what} anotado`, {
            action: {
              label: 'Deshacer',
              fn: async () => {
                await del(`/transactions/${saved.id}`);
                notifyChange('transactions');
              },
            },
          });
        }
        afterSave(another, v.kind, saved);
      } catch (e) {
        if (!editing && isOffline(e)) {
          await enqueue({
            hid: store.hid, kind: 'tx', method: 'POST', path: '/transactions', body: payload, file: attachWrap?.pendingFile || null,
            label: payload.description || cat(payload.category_id)?.name || 'Movimiento', amount: payload.amount, txKind: payload.kind,
            date: payload.date, category_id: payload.category_id,
          });
          notifyChange('transactions');
          haptic(14);
          toast('Sin conexión: guardado en el móvil. Se enviará solo en cuanto vuelva la cobertura.', { iconName: 'cloud-off', timeout: 6000 });
          afterSave(another, v.kind, null);
          return;
        }
        showFormError(form, e.message);
      }
    });
  }

  function afterSave(another, kindNow, saved) {
    if (another) {
      Object.assign(d, { amount: null, description: '', merchant: '', notes: '', attachment_id: null, category_id: null, clientId: null });
      s.body.innerHTML = String(body(kindNow));
      bindAll();
      $('#f-amount', s.el).focus();
    } else s.close(saved);
  }

  on(s.el, 'click', '[data-act=save]', (e, b) => save(false, b));
  on(s.el, 'click', '[data-act=save-another]', (e, b) => save(true, b));
  on(s.el, 'click', '[data-act=delete]', async (e, b) => {
    await withBusy(b, async () => {
      try {
        await deleteTx(tx);
        s.close();
      } catch (err) {
        toastError(err);
      }
    });
  });
  // ---------- Foto del ticket ----------
  let ticketRun = 0;
  on(s.body, 'click', '[data-act=scan]', async (e, b) => {
    const file = await pickTicket({ camera: !!b.dataset.camera });
    if (file) scanTicket(file);
  });
  on(s.body, 'click', '[data-act=rescan]', () => {
    if (lastTicket) scanTicket(lastTicket);
  });
  let lastTicket = null;
  let attachedFor = null;
  async function scanTicket(file) {
    const form = $('#txf', s.el);
    const zone = $('[data-ticket-zone]', form);
    if (!zone) return;
    const run = ++ticketRun;
    lastTicket = file;
    const url = URL.createObjectURL(file);
    const view = (state, inner) => html`<div class="ticket-scan ${state}">
      <div class="tk-photo"><img src="${url}" alt="Foto del ticket">${state === 'reading' ? html`<i class="tk-line"></i>` : ''}</div>
      <div class="tk-info">${inner}</div></div>`;
    zone.innerHTML = String(view('reading', html`<b data-tk-text>Preparando la foto…</b>
      <div class="meter"><div class="fill" data-tk-bar style="width:4%"></div></div><small>Se lee en tu propio dispositivo; la foto no sale de aquí para leerla.</small>`));
    // La foto se adjunta mientras se lee (ligera y en color).
    if (attachedFor !== file) {
      attachedFor = file;
      import('./ocr.js').then(({ compressPhoto }) => compressPhoto(file)).then((photo) => {
        if (run === ticketRun && form.isConnected) $('[data-attach]', form)?.dispatchEvent(new CustomEvent('attach-file', { detail: photo }));
      }).catch(() => {});
    }
    try {
      const { readReceipt } = await import('./ocr.js');
      const r = await readReceipt(file, ({ text, value }) => {
        if (run !== ticketRun || !form.isConnected) return;
        const t = $('[data-tk-text]', zone);
        if (t) t.textContent = value != null ? `${text} ${Math.round(value * 100)} %` : text;
        const bar = $('[data-tk-bar]', zone);
        if (bar && value != null) bar.style.width = `${Math.max(4, value * 100)}%`;
      });
      if (run !== ticketRun || !form.isConnected) return;
      fillFromTicket(form, r);
      const parts = [r.total ? money(r.total) : null, r.merchant, r.date ? fmtShort(r.date) : null].filter(Boolean);
      const sure = r.confidence === 'high' || r.confidence === 'medium';
      zone.innerHTML = String(view(r.total ? (sure ? 'done' : 'unsure') : 'failed', html`
        <b>${r.total ? parts.join(' · ') : 'No encuentro el total'}</b>
        <small>${!r.total ? 'Escríbelo tú; la foto queda adjunta al gasto.' : sure ? 'Revisa que esté todo bien antes de guardar.' : 'No estoy seguro del importe: compruébalo con el ticket.'}</small>
        <span class="row" style="gap:6px;margin-top:6px"><button type="button" class="btn sm ghost" data-act="rescan">${icon('rotate-ccw', 'sm')}Leer otra vez</button>
          <button type="button" class="btn sm ghost" data-act="scan" data-camera="1">${icon('camera', 'sm')}Otra foto</button></span>`));
      haptic(r.total ? 18 : 8);
    } catch (err) {
      if (run !== ticketRun || !form.isConnected) return;
      zone.innerHTML = String(view('failed', html`<b>No se ha podido leer</b><small>${err.message}</small>
        <span class="row" style="gap:6px;margin-top:6px"><button type="button" class="btn sm ghost" data-act="rescan">${icon('rotate-ccw', 'sm')}Reintentar</button></span>`));
    }
  }

  function fillFromTicket(form, r) {
    const flash = (el) => {
      if (!el) return;
      el.classList.remove('tk-filled');
      void el.offsetWidth;
      el.classList.add('tk-filled');
    };
    const amt = $('#f-amount', form);
    if (r.total && (!amt.value || amt.dataset.fromTicket)) {
      amt.value = amountStr(r.total);
      amt.dataset.fromTicket = '1';
      amt.dispatchEvent(new Event('input', { bubbles: true }));
      flash(amt.closest('.field') || amt);
    }
    const date = $('input[name=date]', form);
    if (r.date && date && form.dataset.dateAuto) {
      date.value = r.date;
      date.dispatchEvent(new Event('change', { bubbles: true }));
      flash(date.closest('.field'));
    }
    const desc = $('#f-desc', form);
    if (r.merchant && !desc.value.trim()) {
      desc.value = r.merchant;
      desc.dispatchEvent(new Event('input', { bubbles: true }));
      flash(desc.closest('.field'));
    }
    const merchant = $('#f-merchant', form);
    if (r.merchant && merchant && !merchant.value.trim()) merchant.value = r.merchant;
  }

  bindAll();
  if (ticket) scanTicket(ticket);
  else if (focusTicket) {
    const btn = $('.ticket-btn', s.el);
    btn?.classList.add('attn');
    focusLater(btn, 300);
  }
  return s.done;
}

function ticketButtons() {
  return html`<div class="ticket-bar">
    <button type="button" class="ticket-btn" data-act="scan" data-camera="1" title="Relleno yo el importe, la fecha y la tienda">
      <span class="ti">${icon('camera', 'sm')}</span><b>Foto del ticket</b></button>
    <button type="button" class="ticket-pick" data-act="scan" aria-label="Elegir la foto del ticket de la galería">${icon('image', 'sm')}<span>Galería</span></button></div>
    <p class="ticket-hint">Con la foto relleno yo el importe, la fecha y la tienda.</p>`;
}

// Borra con opción de deshacer (se vuelve a crear con los mismos datos).
export async function deleteTx(tx) {
  await del(`/transactions/${tx.id}`);
  notifyChange('transactions');
  const keep = ['kind', 'amount', 'date', 'description', 'merchant', 'category_id', 'person_id', 'pet_id', 'method', 'notes', 'attachment_id'];
  const copy = Object.fromEntries(keep.map((k) => [k, tx[k] ?? null]));
  toast(`Borrado: ${tx.description || tx.merchant || money(tx.amount)}`, {
    iconName: 'trash-2',
    action: {
      label: 'Deshacer',
      fn: async () => {
        try {
          await post('/transactions', copy);
          notifyChange('transactions');
        } catch (e) {
          toastError(e);
        }
      },
    },
  });
}

// Fila de movimiento reutilizable.
export function txRow(t, { showDate = false } = {}) {
  const sourceIcon = t.recurring_id ? 'repeat' : t.bill_id ? 'receipt' : t.list_id ? 'shopping-cart' : null;
  const title = t.description || t.merchant || t.category_name || 'Movimiento';
  return html`<button type="button" class="rowi dense" data-tx="${t.id}">
    <span class="selbox"></span>
    <span class="cat-dot" style="--c:${t.category_color || '#8A8F98'}"><span class="emoji">${t.category_icon || '❔'}</span></span>
    <span class="main-txt">
      <span class="title">${title}</span>
      <span class="meta">
        ${showDate ? html`<span>${fmtShort(t.date)}</span><span class="sep"></span>` : ''}
        <span>${t.category_name || 'Sin categoría'}</span>
        ${t.merchant && t.merchant !== title ? html`<span class="sep"></span><span class="ellipsis">${t.merchant}</span>` : ''}
        ${t.person_name ? html`<span class="sep"></span><span class="who">${t.person_photo ? html`<img class="mini-ava" src="${hurl(`/attachments/${t.person_photo}`)}" alt="" loading="lazy">` : t.person_emoji || ''} ${t.person_name}</span>` : ''}
        ${t.pet_name ? html`<span class="sep"></span><span>🐾 ${t.pet_name}</span>` : ''}
        ${sourceIcon ? icon(sourceIcon, 'sm') : ''}${t.attachment_id ? icon('paperclip', 'sm') : ''}
        ${t.estimate ? html`<span class="pill info" style="height:19px;font-size:calc(11px * var(--fs))">${t.bill_id ? 'en factura' : 'estimado'}</span>` : ''}
      </span>
    </span>
    <span class="amount ${t.kind === 'income' ? 'income' : ''}">${t.kind === 'income' ? '+' : '−'}${money(t.amount)}</span>
  </button>`;
}
// Gastos anotados sin conexión que aún no han llegado al servidor (se ven arriba de la lista).
export function pendingTxRows(hid) {
  const ops = pendingOps(hid).filter((op) => op.kind === 'tx');
  if (!ops.length) return '';
  return html`<div class="pending-block"><div class="pending-head">${icon('cloud-off', 'sm')}<span>Anotado sin conexión</span>
    <button type="button" class="btn ghost sm" data-act="netinfo">Ver</button></div>
    <div class="rows">${ops.map((op) => {
      const c = cat(op.category_id);
      return html`<div class="rowi pending-row">
        <span class="cat-dot" style="--c:${c?.color || '#8A8F98'}"><span class="emoji">${c?.icon || '❔'}</span></span>
        <span class="main-txt"><span class="title">${op.label}</span>
          <span class="meta"><span>${fmtShort(op.date)}</span><span class="sep"></span><span>${c?.name || 'Sin categoría'}</span>
            ${op.file ? icon('paperclip', 'sm') : ''}</span></span>
        <span class="pill ${op.error ? 'overdue' : 'pending'}">${op.error ? 'No enviado' : 'Pendiente'}</span>
        <span class="amount ${op.txKind === 'income' ? 'income' : ''}">${op.txKind === 'income' ? '+' : '−'}${money(op.amount)}</span>
      </div>`;
    })}</div></div>`;
}

const fmtShort = (s) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(s + 'T12:00')).replace('.', '');
