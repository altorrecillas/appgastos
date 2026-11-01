// Recordatorios de pagos y fechas importantes.
import { del, get, patch, post } from '../api.js';
import {
  $, addDays, confirmDialog, daysBetween, fmtDateFull, fmtDateLong, html, icon, money, on, openMenu, parseAmount, relDay, sheet,
  shiftMonth, today, toast, toastError, withBusy, skeletonPage,
} from '../ui.js';
import { can, people } from '../store.js';
import {
  amountField, bindAmount, bindDateQuick, bindPickers, catPicker, chipPicker, dateQuick, focusFirst, intOrNull, methodOptions,
  notifyChange, personOptions, readForm, showFormError,
} from '../forms.js';
import { disablePush, enablePush, pushStatus, testPush } from '../push.js';
import { enableSwipe, gestureHint, haptic, swipeRow } from '../gestures.js';
import { NAME } from '../brand.js';

const REPEAT_NAMES = {
  none: 'No se repite', weekly: 'Cada semana', monthly: 'Cada mes', bimonthly: 'Cada 2 meses', quarterly: 'Cada 3 meses', semiannual: 'Cada 6 meses', annual: 'Cada año',
};
const BEFORE = [[0, 'El mismo día'], [1, '1 día antes'], [3, '3 días antes'], [7, '1 semana antes'], [14, '2 semanas antes'], [30, '1 mes antes']];
// Horas habituales para el aviso (también se puede poner cualquier otra).
const HOURS = ['09:00', '14:00', '18:00', '21:00'];
const DAY_HOUR = '09:00';

export default async function remindersView(ctx) {
  let data = { active: [], done: [] };
  let push = { supported: false };

  ctx.setHeader('Recordatorios', 'Pagos puntuales y fechas que no se pueden olvidar',
    can('edit') ? html`<button class="btn primary" data-act="new">${icon('plus')}<span class="desktop-only">Nuevo recordatorio</span></button>` : '');

  async function load() {
    try {
      [data, push] = await Promise.all([get('/reminders'), pushStatus().catch(() => ({ supported: false }))]);
      if (ctx.isCurrent()) draw();
    } catch (e) {
      toastError(e);
    }
  }

  function draw() {
    const t = today();
    const groups = [
      { k: 'overdue', t: 'Vencidos', test: (d) => d < t },
      { k: 'today', t: 'Hoy', test: (d) => d === t },
      { k: 'week', t: 'Próximos 7 días', test: (d) => d > t && d <= addDays(t, 7) },
      { k: 'month', t: 'Este mes y el siguiente', test: (d) => d > addDays(t, 7) && d <= `${shiftMonth(t.slice(0, 7), 1)}-31` },
      { k: 'later', t: 'Más adelante', test: (d) => d > `${shiftMonth(t.slice(0, 7), 1)}-31` },
    ].map((g) => ({ ...g, items: data.active.filter((m) => g.test(m.date)) })).filter((g) => g.items.length);
    const paymentsSoon = data.active.filter((m) => m.kind === 'payment' && m.amount && m.date <= addDays(t, 30)).reduce((s, m) => s + m.amount, 0);

    ctx.el.innerHTML = String(html`<div class="content narrow" style="padding:0;max-width:880px">
      ${pushBanner()}
      ${data.active.length ? html`
        <section class="stat-strip" style="margin-bottom:6px">
          <div class="stat"><span class="label">Pendientes</span><span class="value">${data.active.length}</span></div>
          <div class="stat"><span class="label">Vencidos</span><span class="value ${groups.find((g) => g.k === 'overdue') ? 'neg' : ''}">${groups.find((g) => g.k === 'overdue')?.items.length || 0}</span></div>
          <div class="stat"><span class="label">Pagos en 30 días</span><span class="value">${money(paymentsSoon, { decimals: 0 })}</span></div>
        </section>
        ${groups.map((g) => html`<div class="section-title"><h2 class="${g.k === 'overdue' ? 'neg' : ''}">${g.t}</h2><span class="sec-count ${g.k === 'overdue' ? 'neg' : ''}">${g.items.length}</span></div>
          <div class="panel flush"><div class="rows" style="margin:0">${g.items.map(row)}</div></div>`)}`
      : html`<div class="empty"><div class="art">🔔</div><h3>Ningún recordatorio pendiente</h3>
          <p>Apunta pagos sueltos y fechas importantes: la ITV, renovar el seguro o el DNI, la matrícula, un cumpleaños… Te avisaremos con la antelación que elijas.</p>
          ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="new">${icon('plus')}Crear recordatorio</button></div>` : ''}</div>`}
      <p class="small muted" style="margin-top:18px">${icon('info', 'sm')} Los pagos fijos, las cuotas de plazos, las facturas y las vacunas de las mascotas ya avisan solos: no hace falta crear recordatorios para ellos.</p>
      ${data.done.length ? html`<div class="section-title"><h2>Hechos recientemente</h2></div>
        <div class="panel flush" style="opacity:.8"><div class="rows" style="margin:0">${data.done.slice(0, 10).map((m) => html`<div class="rowi dense" style="padding:12px 18px">
          <span class="cat-dot sm" style="--c:var(--pine)">${icon('check', 'sm')}</span>
          <span class="main-txt"><span class="title" style="text-decoration:line-through;color:var(--ink-3)">${m.title}</span>
            <span class="meta">${fmtDateFull(m.date)}</span></span>
          ${can('edit') ? html`<button class="btn ghost sm" data-undo="${m.id}">Deshacer</button>` : ''}</div>`)}</div></div>` : ''}
    </div>`);
  }

  function pushBanner() {
    if (push.subscribed) {
      return html`<div class="row wrap small" style="margin-bottom:16px;gap:10px;color:var(--pine)">${icon('circle-check', 'sm')}
        <span>Este dispositivo recibe los avisos.</span><button class="btn ghost sm" data-act="push-test">Enviar prueba</button>
        <button class="btn ghost sm" data-act="push-off">Desactivar</button></div>`;
    }
    if (!push.supported) return '';
    return html`<section class="panel" style="margin-bottom:18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;border-color:var(--cobalt-line)">
      <span class="cat-dot" style="--c:var(--cobalt)">${icon('bell')}</span>
      <div class="grow" style="min-width:220px"><b>Recibe los avisos en este dispositivo</b>
        <p class="small muted">${push.secure ? 'Te llegará una notificación aunque tengas la app cerrada.'
          : `Necesita HTTPS: abre ${NAME} con la dirección https de Tailscale (tailscale serve). Mientras, los verás en la campana.`}</p></div>
      ${push.secure ? html`<button class="btn primary" data-act="push-on">${icon('bell')}Activar notificaciones</button>` : ''}
    </section>`;
  }

  function row(m) {
    const n = daysBetween(today(), m.date);
    const inner = html`<div class="rowi dense" style="padding:14px 18px">
      ${can('edit') ? html`<button class="tick" data-done="${m.id}" aria-label="Marcar «${m.title}» como hecho"><span>${icon('check')}</span></button>` : ''}
      <span class="cat-dot" style="--c:${m.category_color || (m.kind === 'payment' ? 'var(--saffron)' : 'var(--cobalt)')}">
        ${m.category_icon ? html`<span class="emoji">${m.category_icon}</span>` : icon(m.kind === 'payment' ? 'banknote' : 'calendar-check')}</span>
      <span class="main-txt"><span class="title">${m.title}</span>
        <span class="meta"><span class="${n < 0 ? 'neg' : ''}">${n < 0 ? `Venció ${relDay(m.date).toLowerCase()}` : relDay(m.date)} · ${fmtDateLong(m.date).toLowerCase()}</span>
          ${m.remind_time ? html`<span class="sep"></span><span>${icon('bell', 'sm')} ${m.remind_time}</span>` : ''}
          ${m.repeat !== 'none' ? html`<span class="sep"></span><span>${icon('repeat', 'sm')} ${REPEAT_NAMES[m.repeat].toLowerCase()}</span>` : ''}
          ${m.person_name ? html`<span class="sep"></span><span>${m.person_emoji} ${m.person_name}</span>` : ''}
          ${m.notes ? html`<span class="sep"></span><span class="ellipsis" style="max-width:240px">${m.notes}</span>` : ''}</span></span>
      ${m.amount ? html`<span class="amount">${money(m.amount)}</span>` : ''}
      ${can('edit') ? html`<button class="btn ghost sm icon-only" data-menu="${m.id}" data-menu-anchor aria-label="Opciones">${icon('ellipsis-vertical')}</button>` : ''}
    </div>`;
    if (!can('edit')) return inner;
    return swipeRow(inner, {
      id: m.id,
      left: { icon: 'check', label: 'Hecho', tone: 'green' },
      right: { icon: 'clock', label: 'Una semana más', tone: 'amber' },
    });
  }

  // ---------- Formulario ----------
  function form(rem = null, preset = {}) {
    if (!can('edit')) return;
    const editing = !!rem;
    const d = {
      kind: 'payment', title: '', date: addDays(today(), 7), amount: null, repeat: 'none', remind_days: 3, remind_time: DAY_HOUR, category_id: null, person_id: null, notes: '',
      ...preset, ...(rem || {}),
    };
    if (!d.remind_time) d.remind_time = DAY_HOUR;
    const body = (k) => html`<form class="form" id="remf" autocomplete="off">
      <div class="segmented block" data-rk>
        <button type="button" data-v="payment" aria-pressed="${k === 'payment'}">${icon('banknote', 'sm')}Pago</button>
        <button type="button" data-v="date" aria-pressed="${k === 'date'}">${icon('calendar-check', 'sm')}Fecha importante</button>
      </div>
      <input type="hidden" name="kind" value="${k}">
      <div class="field"><label for="rm-t">¿Qué hay que recordar?</label><input class="input" id="rm-t" name="title" value="${d.title}" maxlength="80" required data-autofocus
        placeholder="${k === 'payment' ? 'Pagar la ITV, matrícula del cole, derrama…' : 'Renovar el DNI, cumpleaños de la abuela…'}"></div>
      ${k === 'payment' ? amountField('amount', d.amount, { label: 'Importe (opcional)' }) : ''}
      ${dateQuick('date', d.date, { label: '¿Cuándo?' })}
      <div class="chips" data-qd>${[[1, 'Mañana'], [7, 'En una semana'], [30, 'En un mes'], [90, 'En tres meses']].map(([n, l]) => html`<button type="button" class="chip sm" data-qd="${n}">${l}</button>`)}</div>
      <div class="rem-alert">
        <div class="field"><label>Avisar</label>${chipPicker('remind_days', BEFORE.map(([value, label]) => ({ value, label })), d.remind_days, { optional: false })}</div>
        <div class="field"><label for="rm-h">¿A qué hora?</label>
          <div class="rem-hours">${HOURS.map((h) => html`<button type="button" class="chip" data-hour="${h}" aria-pressed="${d.remind_time === h}">${h}</button>`)}</div>
          <div class="rem-other"><span>U otra hora</span><input class="input" type="time" id="rm-h" name="remind_time" value="${d.remind_time}" step="300" required></div>
          <span class="hint">${icon('bell', 'sm')} El aviso llega al móvil a esa hora; si sigue pendiente, también ese día y el siguiente.</span></div>
      </div>
      <div class="field"><label>Repetir</label>${chipPicker('repeat', Object.entries(REPEAT_NAMES).map(([value, label]) => ({ value, label })), d.repeat, { optional: false })}</div>
      ${k === 'payment' ? html`<div class="field"><label>Categoría del pago</label>${catPicker('expense', d.category_id)}</div>` : ''}
      ${people().length ? html`<div class="field"><label>¿De quién es?</label>${chipPicker('person_id', personOptions(), d.person_id, { scroll: true })}</div>` : ''}
      <div class="field"><label for="rm-n">Notas</label><textarea class="textarea" id="rm-n" name="notes" maxlength="1000" placeholder="Dónde, qué llevar, teléfono…">${d.notes}</textarea></div>
    </form>`;
    const s = sheet({
      title: editing ? 'Editar recordatorio' : 'Nuevo recordatorio',
      body: body(d.kind),
      foot: html`${editing ? html`<button class="btn danger icon-only" data-act="del" aria-label="Borrar">${icon('trash-2')}</button>` : ''}
        <span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const bind = () => {
      const f = $('#remf', s.el);
      bindAmount(f);
      bindDateQuick(f);
      focusFirst(f);
    };
    bindPickers(s.body);
    on(s.body, 'click', '[data-rk] [data-v]', (e, b) => {
      const v = readForm($('#remf', s.el));
      Object.assign(d, { title: v.title, date: v.date, notes: v.notes, repeat: v.repeat, remind_days: Number(v.remind_days), remind_time: v.remind_time || DAY_HOUR, kind: b.dataset.v });
      s.body.innerHTML = String(body(b.dataset.v));
      bind();
    });
    // La hora: los atajos rellenan el campo y se marca el que coincide con lo escrito.
    const markHour = () => {
      const val = $('#rm-h', s.el).value;
      s.el.querySelectorAll('[data-hour]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.hour === val)));
    };
    on(s.body, 'click', '[data-hour]', (e, b) => {
      $('#rm-h', s.el).value = b.dataset.hour;
      markHour();
    });
    on(s.body, 'input', '#rm-h', markHour);
    on(s.body, 'click', '[data-qd]', (e, b) => {
      if (!b.dataset.qd || b.matches('.chips')) return;
      const input = $('input[name=date]', s.el);
      input.value = addDays(today(), Number(b.dataset.qd));
      input.dispatchEvent(new Event('change'));
    });
    on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
      const f = $('#remf', s.el);
      const v = readForm(f);
      if (!v.title.trim()) return showFormError(f, 'Escribe qué hay que recordar');
      const amount = v.kind === 'payment' && v.amount ? parseAmount(v.amount) : null;
      if (amount !== null && (Number.isNaN(amount) || amount < 0)) return showFormError(f, 'El importe no es válido');
      const payload = {
        kind: v.kind, title: v.title, date: v.date, amount, repeat: v.repeat || 'none', remind_days: Number(v.remind_days || 0),
        remind_time: v.remind_time || DAY_HOUR, category_id: intOrNull(v.category_id), person_id: intOrNull(v.person_id), notes: v.notes,
      };
      try {
        if (editing) await patch(`/reminders/${rem.id}`, payload);
        else await post('/reminders', payload);
        notifyChange('reminders');
        const whenTxt = payload.remind_days ? BEFORE.find((x) => x[0] === payload.remind_days)?.[1].toLowerCase() : 'ese mismo día';
        toast(editing ? 'Recordatorio guardado' : `Te avisaremos ${whenTxt} a las ${payload.remind_time}`);
        s.close(true);
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=del]', async () => {
      if (!(await confirmDialog({ title: '¿Borrar recordatorio?', text: rem.title, confirm: 'Borrar', danger: true }))) return;
      try {
        await del(`/reminders/${rem.id}`);
        notifyChange('reminders');
        s.close();
      } catch (err) {
        toastError(err);
      }
    });
    bind();
  }

  function doneSheet(m) {
    if (m.kind !== 'payment') return markDone(m, {});
    const s = sheet({
      title: 'Marcar como hecho',
      size: 'narrow',
      body: html`<form class="form" id="dn"><div style="font-weight:650;font-size:calc(17px * var(--fs))">${m.title}</div>
        <label class="switch"><input type="checkbox" name="register" ${m.amount ? 'checked' : ''}><span class="track"></span>
          <span class="txt">Anotar el pago en movimientos<small>Se sumará a los gastos del mes.</small></span></label>
        <div data-reg>${amountField('amount', m.amount)}${dateQuick('date', today(), { label: 'Fecha del pago' })}
          <div class="field" style="margin-top:14px"><label>Forma de pago</label>${chipPicker('method', methodOptions(), 'card', { scroll: true })}</div></div>
        ${m.repeat !== 'none' ? html`<p class="small muted">Se repite ${REPEAT_NAMES[m.repeat].toLowerCase()}: el recordatorio pasará a la siguiente fecha.</p>` : ''}
      </form>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn success" data-act="ok">${icon('check')}Hecho</button>`,
    });
    const f = $('#dn', s.el);
    bindAmount(f);
    bindDateQuick(f);
    bindPickers(f);
    const sync = () => ($('[data-reg]', f).hidden = !$('input[name=register]', f).checked);
    $('input[name=register]', f).addEventListener('change', sync);
    sync();
    on(s.el, 'click', '[data-act=ok]', (e, b) => withBusy(b, async () => {
      const v = readForm(f);
      const body = v.register ? { register: true, amount: parseAmount(v.amount), date: v.date, method: v.method || undefined } : {};
      if (v.register && (Number.isNaN(body.amount) || body.amount <= 0)) return showFormError(f, 'Escribe el importe pagado');
      if (await markDone(m, body)) s.close();
    }));
    return s.done;
  }

  async function markDone(m, body) {
    try {
      const r = await post(`/reminders/${m.id}/done`, body);
      notifyChange('reminders');
      haptic(15);
      toast(body.register ? `Hecho y anotado: ${money(body.amount)}` : m.repeat !== 'none' ? `${m.title}: hecho. Te avisaremos la próxima vez.` : `${m.title}: hecho`, {
        action: body.register ? undefined : {
          label: 'Deshacer',
          fn: async () => {
            if (m.repeat === 'none') await post(`/reminders/${m.id}/undo`);
            else await patch(`/reminders/${m.id}`, { date: r.previous_date });
            notifyChange('reminders');
          },
        },
      });
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  }

  // ---------- Eventos ----------
  const headerEl = document.getElementById('page-actions');
  ctx.onCleanup(on(headerEl, 'click', '[data-act=new]', () => form()));
  on(ctx.el, 'click', '[data-act=new]', () => form());
  on(ctx.el, 'click', '[data-done]', (e, b) => {
    b.classList.add('done');
    Promise.resolve(doneSheet(data.active.find((m) => m.id === Number(b.dataset.done)))).then(() => b.isConnected && b.classList.remove('done'));
  });
  const postpone = async (m) => {
    try {
      await patch(`/reminders/${m.id}`, { date: addDays(m.date < today() ? today() : m.date, 7) });
      notifyChange('reminders');
      toast(`${m.title}: pospuesto una semana`, { iconName: 'clock', action: { label: 'Deshacer', fn: async () => {
        await patch(`/reminders/${m.id}`, { date: m.date });
        notifyChange('reminders');
      } } });
    } catch (err) {
      toastError(err);
    }
  };
  enableSwipe(ctx.el, {
    onSwipe: (el, action) => {
      const m = data.active.find((x) => x.id === Number(el.dataset.sw));
      if (!m) return;
      if (action === 'left') doneSheet(m);
      else postpone(m);
    },
  });
  on(ctx.el, 'click', '[data-undo]', async (e, b) => {
    try {
      await post(`/reminders/${b.dataset.undo}/undo`);
      notifyChange('reminders');
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'click', '[data-menu]', (e, b) => {
    const m = data.active.find((x) => x.id === Number(b.dataset.menu));
    openMenu(b, [
      { label: 'Editar', icon: 'pencil', onClick: () => form(m) },
      { label: 'Posponer una semana', icon: 'clock', onClick: () => postpone(m) },
      'sep',
      { label: 'Borrar', icon: 'trash-2', danger: true, onClick: async () => {
        try {
          await del(`/reminders/${m.id}`);
          notifyChange('reminders');
          toast('Recordatorio borrado');
        } catch (err) {
          toastError(err);
        }
      } },
    ], { align: 'end' });
  });
  on(ctx.el, 'click', '[data-act=push-on]', (e, b) => withBusy(b, async () => {
    try {
      await enablePush();
      toast('Notificaciones activadas en este dispositivo');
      await testPush().catch(() => {});
      load();
    } catch (err) {
      toastError(err);
    }
  }));
  on(ctx.el, 'click', '[data-act=push-off]', async () => {
    await disablePush();
    toast('Notificaciones desactivadas en este dispositivo');
    load();
  });
  on(ctx.el, 'click', '[data-act=push-test]', async () => {
    try {
      await testPush();
      toast('Notificación de prueba enviada');
    } catch (err) {
      toastError(err);
    }
  });

  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
  if (data.active.length && can('edit')) gestureHint(ctx.el.querySelector('.content') || ctx.el, 'rem', 'Toca el círculo al hacerlo · desliza ← para posponer');
  if (ctx.query.new) {
    history.replaceState(null, '', '#/recordatorios');
    form(null, ctx.query.date ? { date: ctx.query.date } : {});
  }
}

