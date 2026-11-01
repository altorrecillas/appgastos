// Ahorro: metas con objetivo, fecha y aportaciones.
import { del, get, patch, post } from '../api.js';
import {
  $, confirmDialog, daysBetween, fmtDateFull, html, icon, money, on, openMenu, parseAmount, pct, sheet, today,
  toast, toastError, withBusy, focusLater, skeletonPage,
} from '../ui.js';
import { can } from '../store.js';
import {
  amountField, bindAmount, bindDateQuick, bindPickers, colorPicker, dateQuick, emojiPicker, focusFirst, notifyChange, readForm, showFormError,
} from '../forms.js';

const ring = (ratio, color, label) => {
  const r = 42;
  const c = 2 * Math.PI * r;
  return html`<div class="ring" style="--c:${color}" role="img" aria-label="${label}">
    <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="${r}" fill="none" stroke-width="9"/>
      <circle class="prog" cx="50" cy="50" r="${r}" fill="none" stroke-width="9" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(ratio, 1))}"/></svg>
    <div class="lbl">${Math.round(Math.min(ratio, 9.99) * 100)} %</div></div>`;
};

export default async function goalsView(ctx) {
  let goals = [];
  ctx.setHeader('Ahorro', 'Metas para las que estáis apartando dinero',
    can('edit') ? html`<button class="btn primary" data-act="new">${icon('plus')}<span class="desktop-only">Nueva meta</span></button>` : '');

  async function load() {
    try {
      goals = await get('/goals');
      if (ctx.isCurrent()) draw();
    } catch (e) {
      toastError(e);
    }
  }

  function draw() {
    const active = goals.filter((g) => !g.archived);
    const totalSaved = active.reduce((s, g) => s + g.saved, 0);
    const totalTarget = active.reduce((s, g) => s + g.target, 0);
    if (!goals.length) {
      ctx.el.innerHTML = String(html`<div class="empty"><div class="art">🐷</div><h3>Empieza una hucha</h3>
        <p>Unas vacaciones, un fondo para imprevistos, el coche nuevo… Pon un objetivo y una fecha y te diremos cuánto apartar cada mes.</p>
        ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="new">${icon('plus')}Crear meta</button></div>` : ''}</div>`);
      return;
    }
    ctx.el.innerHTML = String(html`
      <section class="stat-strip" style="margin-bottom:20px">
        <div class="stat"><span class="label">Ahorrado</span><span class="value pos">${money(totalSaved, { decimals: 0 })}</span></div>
        <div class="stat"><span class="label">Objetivo total</span><span class="value">${money(totalTarget, { decimals: 0 })}</span></div>
        <div class="stat"><span class="label">Conseguido</span><span class="value">${totalTarget ? pct(totalSaved / totalTarget) : '—'}</span></div>
      </section>
      <div class="goals-grid">${active.map(card)}</div>
      ${goals.some((g) => g.archived) ? html`<div class="section-title"><h2>Archivadas</h2></div><div class="goals-grid" style="opacity:.7">${goals.filter((g) => g.archived).map(card)}</div>` : ''}`);
  }

  function card(g) {
    const ratio = g.saved / g.target;
    const left = Math.max(g.target - g.saved, 0);
    let pace = '';
    if (left > 0 && g.deadline) {
      const days = daysBetween(today(), g.deadline);
      const months = Math.max(days / 30.44, 0);
      pace = days <= 0 ? html`<span class="neg">La fecha ya ha pasado</span>`
        : html`Para llegar el ${fmtDateFull(g.deadline)}: <b>${money(left / Math.max(months, 1), { decimals: 0 })} al mes</b>`;
    } else if (left <= 0) pace = html`<span class="pos">¡Meta conseguida! 🎉</span>`;
    else {
      const recent = g.moves.filter((m) => m.amount > 0 && daysBetween(m.date, today()) <= 90).reduce((s, m) => s + m.amount, 0) / 3;
      pace = recent > 0 ? html`A este ritmo (${money(recent, { decimals: 0 })}/mes) la conseguís en <b>${Math.ceil(left / recent)} meses</b>` : 'Sin fecha objetivo';
    }
    return html`<article class="goal-card">
      <div class="goal-top">${ring(ratio, g.color, `${Math.round(ratio * 100)} % conseguido`)}
        <div class="grow" style="min-width:0"><div class="row" style="gap:6px"><span class="emoji" style="font-size:calc(22px * var(--fs))">${g.icon}</span>
          <h3 style="font-size:calc(18px * var(--fs));line-height:1.2">${g.name}</h3></div>
          <div style="font-size:calc(26px * var(--fs));font-weight:720;font-stretch:82%;margin-top:4px">${money(g.saved, { decimals: 0 })}</div>
          <div class="small muted">de ${money(g.target, { decimals: 0 })} · faltan ${money(left, { decimals: 0 })}</div></div>
        ${can('edit') ? html`<button class="btn ghost sm icon-only" data-menu="${g.id}" data-menu-anchor aria-label="Opciones" style="align-self:flex-start">${icon('ellipsis-vertical')}</button>` : ''}
      </div>
      <p class="small ink-2">${pace}</p>
      ${can('edit') && !g.archived ? html`<div class="row" style="gap:8px">
        <button class="btn sm success" data-move="${g.id}" data-sign="1">${icon('plus', 'sm')}Apartar</button>
        <button class="btn sm" data-move="${g.id}" data-sign="-1">${icon('minus', 'sm')}Retirar</button></div>` : ''}
      ${g.moves.length ? html`<details><summary class="small" style="cursor:pointer;color:var(--cobalt)">Historial (${g.moves.length})</summary>
        <div class="rows" style="margin-top:6px">${g.moves.slice(0, 12).map((m) => html`<div class="rowi" style="padding:8px 0">
          <span class="main-txt"><span class="title" style="font-size:calc(14px * var(--fs))">${m.note || (m.amount > 0 ? 'Aportación' : 'Retirada')}</span>
            <span class="meta">${fmtDateFull(m.date)}${m.created_by_name ? ` · ${m.created_by_name}` : ''}</span></span>
          <span class="amount ${m.amount > 0 ? 'income' : ''}">${m.amount > 0 ? '+' : '−'}${money(Math.abs(m.amount))}</span>
          ${can('edit') ? html`<button class="btn ghost sm icon-only" data-delmove="${g.id}:${m.id}" aria-label="Borrar">${icon('x', 'sm')}</button>` : ''}</div>`)}</div></details>` : ''}
    </article>`;
  }

  function form(g = null) {
    const editing = !!g;
    const d = { name: '', icon: '🎯', color: '#0E9AA7', target: null, deadline: '', notes: '', ...(g || {}) };
    const s = sheet({
      title: editing ? 'Editar meta' : 'Nueva meta de ahorro',
      body: html`<form class="form" id="gf">
        <div class="field"><label for="g-n">¿Para qué ahorráis?</label><input class="input" id="g-n" name="name" value="${d.name}" maxlength="60" required data-autofocus placeholder="Vacaciones, fondo de emergencia, coche…"></div>
        ${amountField('target', d.target, { label: 'Objetivo' })}
        <p class="small muted" style="text-align:center;margin-top:-10px">Objetivo</p>
        <div class="grid-2">
          <div class="field"><label for="g-d">Fecha objetivo <span class="muted">(opcional)</span></label><input class="input" type="date" id="g-d" name="deadline" value="${d.deadline || ''}"></div>
          ${!editing ? html`<div class="field"><label for="g-i">Ya tenéis ahorrado</label><div class="input-group"><input class="input" id="g-i" name="initial" inputmode="decimal" placeholder="0,00" style="padding-left:13px"><span class="suffix">€</span></div></div>` : ''}
        </div>
        <div class="field"><label>Icono</label>${emojiPicker('icon', d.icon, ['🎯', '🏖️', '🛟', '🚗', '🏡', '💻', '🎓', '💍', '👶', '✈️', '🎄', '🛋️'])}</div>
        <div class="field"><label>Color</label>${colorPicker('color', d.color)}</div>
      </form>`,
      foot: html`${editing ? html`<button class="btn danger icon-only" data-act="del" aria-label="Borrar">${icon('trash-2')}</button>` : ''}<span class="spacer"></span>
        <button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const f = $('#gf', s.el);
    bindAmount(f);
    bindPickers(f);
    focusFirst(f);
    on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
      const v = readForm(f);
      const target = parseAmount(v.target);
      if (!v.name.trim()) return showFormError(f, 'Ponle un nombre a la meta');
      if (Number.isNaN(target) || target <= 0) return showFormError(f, 'Indica cuánto queréis ahorrar');
      const payload = { name: v.name, target, deadline: v.deadline || null, icon: v.icon, color: v.color };
      try {
        if (editing) await patch(`/goals/${g.id}`, payload);
        else await post('/goals', { ...payload, initial: v.initial ? parseAmount(v.initial) || 0 : 0 });
        notifyChange('goals');
        s.close();
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=del]', async () => {
      if (!(await confirmDialog({ title: `¿Borrar «${g.name}»?`, text: 'Se borrará también su historial de aportaciones.', confirm: 'Borrar', danger: true }))) return;
      await del(`/goals/${g.id}`).catch(toastError);
      notifyChange('goals');
      s.close();
    });
  }

  function moveSheet(g, sign) {
    const s = sheet({
      title: sign > 0 ? `Apartar para ${g.name}` : `Retirar de ${g.name}`,
      size: 'narrow',
      body: html`<form class="form" id="mf">${amountField('amount', null, { kind: sign > 0 ? 'income' : 'expense' })}
        ${dateQuick('date', today())}
        <div class="field"><label for="m-n">Nota</label><input class="input" id="m-n" name="note" maxlength="120" placeholder="${sign > 0 ? 'Aportación de octubre, paga extra…' : 'Reserva del hotel…'}"></div></form>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn ${sign > 0 ? 'success' : 'primary'}" data-act="ok">${sign > 0 ? 'Apartar' : 'Retirar'}</button>`,
    });
    const f = $('#mf', s.el);
    bindAmount(f);
    bindDateQuick(f);
    focusLater($('#f-amount', f), 60);
    on(s.el, 'click', '[data-act=ok]', (e, b) => withBusy(b, async () => {
      const v = readForm(f);
      const amount = parseAmount(v.amount);
      if (Number.isNaN(amount) || amount <= 0) return showFormError(f, 'Escribe el importe');
      try {
        await post(`/goals/${g.id}/moves`, { amount: amount * sign, date: v.date, note: v.note });
        notifyChange('goals');
        toast(sign > 0 ? `${money(amount)} apartados para ${g.name}` : `${money(amount)} retirados`);
        s.close();
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
  }

  const headerEl = document.getElementById('page-actions');
  ctx.onCleanup(on(headerEl, 'click', '[data-act=new]', () => form()));
  on(ctx.el, 'click', '[data-act=new]', () => form());
  on(ctx.el, 'click', '[data-move]', (e, b) => moveSheet(goals.find((g) => g.id === Number(b.dataset.move)), Number(b.dataset.sign)));
  on(ctx.el, 'click', '[data-delmove]', async (e, b) => {
    const [gid, mid] = b.dataset.delmove.split(':');
    await del(`/goals/${gid}/moves/${mid}`).catch(toastError);
    notifyChange('goals');
  });
  on(ctx.el, 'click', '[data-menu]', (e, b) => {
    const g = goals.find((x) => x.id === Number(b.dataset.menu));
    openMenu(b, [
      { label: 'Editar', icon: 'pencil', onClick: () => form(g) },
      { label: g.archived ? 'Recuperar' : 'Archivar', icon: 'archive', onClick: async () => {
        await patch(`/goals/${g.id}`, { archived: !g.archived }).catch(toastError);
        notifyChange('goals');
      } },
    ], { align: 'end' });
  });
  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
  if (ctx.query.new && can('edit')) {
    history.replaceState(null, '', '#/ahorro');
    if (goals.some((g) => !g.archived)) {
      const active = goals.filter((g) => !g.archived);
      if (active.length === 1) moveSheet(active[0], 1);
      else form();
    } else form();
  }
}

