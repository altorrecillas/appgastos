// Ajustes: hogar, miembros, familia, categorías, cuenta, notificaciones, datos y apariencia.
import { api, del, get, hurl, patch, post } from '../api.js';
import {
  $, $$, COLORS, ROLE_NAMES, amountStr, confirmDialog, download, focusLater, html, icon, money, on, parseAmount, plural, promptDialog, sheet,
  timeAgo, toast, toastError, withBusy,
} from '../ui.js';
import { can, categories, loadHouse, pref, setHouse, setSession, store } from '../store.js';
import { bindPickers, colorPicker, emojiPicker, notifyChange, readForm, showFormError } from '../forms.js';
import { disablePush, enablePush, pushStatus, testPush } from '../push.js';
import { NAME } from '../brand.js';
import { applyTint } from '../tint.js';
import { avatar, bindPhotoField, photoField } from '../photo.js';
import { bindPrefsControls, prefsControls } from '../app.js';

const SECTIONS = [
  ['hogar', 'Hogar', 'house'], ['miembros', 'Miembros', 'users'], ['familia', 'Familia', 'user'], ['categorias', 'Categorías', 'tag'],
  ['cuenta', 'Mi cuenta', 'key-round'], ['avisos', 'Notificaciones', 'bell'], ['datos', 'Copias y datos', 'archive'], ['apariencia', 'Apariencia', 'palette'],
];
const CURRENCIES = [['EUR', 'Euro (€)'], ['USD', 'Dólar (US$)'], ['GBP', 'Libra (£)'], ['MXN', 'Peso mexicano'], ['ARS', 'Peso argentino'], ['COP', 'Peso colombiano'], ['CLP', 'Peso chileno'], ['CHF', 'Franco suizo']];

export default async function settingsView(ctx) {
  let section = SECTIONS.some((s) => s[0] === ctx.params[0]) ? ctx.params[0] : 'hogar';
  let catKind = 'expense';
  ctx.setHeader('Ajustes', store.house.household.name);

  const reloadHouse = async () => {
    await loadHouse();
    notifyChange('household');
  };

  async function draw() {
    let body = '';
    if (section === 'hogar') body = hogar();
    else if (section === 'miembros') body = miembros();
    else if (section === 'familia') body = familia();
    else if (section === 'categorias') body = await categorias();
    else if (section === 'cuenta') body = await cuenta();
    else if (section === 'avisos') body = await avisos();
    else if (section === 'datos') body = datos();
    else body = apariencia();
    if (!ctx.isCurrent()) return;
    ctx.el.innerHTML = String(html`<div class="settings-layout">
      <nav class="settings-nav" aria-label="Secciones de ajustes">${SECTIONS.map(([k, l, ic]) => html`<a href="#/ajustes/${k}" data-sec="${k}" aria-current="${section === k}">${icon(ic)}${l}</a>`)}</nav>
      <div class="settings-section">${body}</div></div>`);
    // Tu foto se guarda en cuanto se elige.
    const mine = store.house.people.find((p) => p.user_id === store.me.id);
    if (section === 'cuenta' && mine) {
      bindPhotoField($('#myphoto', ctx.el), mine, async (id) => {
        try {
          setHouse(await patch(`/people/${mine.id}`, { photo_id: id }));
          notifyChange('people');
          toast(id ? 'Foto guardada' : 'Foto quitada');
        } catch (err) {
          toastError(err);
        }
      });
    }
  }
  bindPickers(ctx.el);

  // ---------- Hogar ----------
  function hogar() {
    const h = store.house.household;
    const admin = can('admin');
    return html`
      <section class="panel"><div class="panel-head"><h2>Datos del hogar</h2></div>
        <form class="form" id="hf">
          <div class="grid-2"><div class="field"><label for="h-n">Nombre</label><input class="input" id="h-n" name="name" value="${h.name}" maxlength="60" ${admin ? '' : 'disabled'}></div>
            <div class="field"><label for="h-c">Moneda</label><select class="select" id="h-c" name="currency" ${admin ? '' : 'disabled'}>
              ${CURRENCIES.map(([k, l]) => html`<option value="${k}" ${h.currency === k ? 'selected' : ''}>${l}</option>`)}</select></div></div>
          <div class="field" style="max-width:280px"><label for="h-b">Presupuesto mensual total <span class="muted">(opcional)</span></label>
            <div class="input-group"><input class="input" id="h-b" name="monthly_budget" inputmode="decimal" value="${amountStr(h.monthly_budget)}" placeholder="Suma de categorías" style="padding-left:13px" ${admin ? '' : 'disabled'}><span class="suffix">€</span></div></div>
          ${admin ? html`<div class="field"><label>Icono</label>${emojiPicker('icon', h.icon, ['🏠', '🏡', '🏢', '🏖️', '🏔️', '🌳', '🏰', '⛺', '🛖', '🏘️'])}</div>
            <div class="field"><label>Color</label>${colorPicker('color', h.color)}</div>
            <label class="switch"><input type="checkbox" name="tint" ${h.tint ? 'checked' : ''}><span class="track"></span>
              <span class="txt">Teñir la aplicación con este color<small>Botones, enlaces y la cabecera de Inicio. Ayuda a saber en qué hogar estás.</small></span></label>
            <div class="row"><button class="btn primary" type="submit">Guardar cambios</button></div>` : html`<p class="small muted">Solo quien administra el hogar puede cambiar estos datos.</p>`}
        </form></section>
      <section class="panel danger-zone"><div class="panel-head"><h2>Zona delicada</h2></div>
        <div class="stack">
          ${h.role !== 'owner' ? html`<div class="row between wrap"><div><b>Salir de este hogar</b><p class="small muted">Dejarás de ver sus datos. Podrán volver a invitarte.</p></div>
            <button class="btn danger" data-act="leave">${icon('door-open')}Salir del hogar</button></div>` : ''}
          ${h.role === 'owner' ? html`<div class="row between wrap"><div><b>Borrar el hogar</b><p class="small muted">Se borran todos sus movimientos, facturas, listas y mascotas. No se puede deshacer.</p></div>
            <button class="btn danger" data-act="delete-house">${icon('trash-2')}Borrar hogar</button></div>` : ''}
        </div></section>`;
  }

  // ---------- Miembros ----------
  function miembros() {
    const admin = can('admin');
    const owner = can('owner');
    const inv = store.house.invitations;
    return html`
      <section class="panel"><div class="panel-head"><h2>Quién tiene acceso</h2><span class="sub">${plural(store.house.members.length, 'persona', 'personas')}</span></div>
        <div class="rows">${store.house.members.map((m) => html`<div class="rowi">
          ${avatar(m)}
          <span class="main-txt"><span class="title">${m.display_name}${m.id === store.me.id ? html` <span class="muted">(tú)</span>` : ''}</span>
            <span class="meta">@${m.username} · desde ${new Date(m.joined_at.replace(' ', 'T') + 'Z').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}</span>
            ${admin && m.id !== store.me.id ? html`<button type="button" class="chip sm member-simple" data-member-simple="${m.id}" aria-pressed="${!!m.simple}">${icon(m.simple ? 'check' : 'eye', 'sm')}Vista sencilla</button>` : ''}</span>
          ${admin && m.role !== 'owner' && m.id !== store.me.id && (owner || m.role !== 'admin') ? html`<select class="select sm" data-role="${m.id}" style="width:auto" aria-label="Rol de ${m.display_name}">
            ${['admin', 'editor', 'viewer'].filter((r) => owner || r !== 'admin').map((r) => html`<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLE_NAMES[r]}</option>`)}</select>
            <button class="btn ghost sm icon-only" data-kick="${m.id}" aria-label="Quitar a ${m.display_name}">${icon('x')}</button>`
            : html`<span class="pill ${m.role === 'owner' ? 'info' : ''}">${ROLE_NAMES[m.role]}</span>`}
          ${owner && m.id !== store.me.id ? html`<button class="btn ghost sm" data-transfer="${m.id}" title="Hacer propietario">${icon('key-round', 'sm')}</button>` : ''}
        </div>`)}</div>
        <details style="margin-top:14px"><summary class="small" style="cursor:pointer;color:var(--cobalt)">¿Qué puede hacer cada rol?</summary>
          <dl class="kv small" style="margin-top:10px">
            <dt>Propietario</dt><dd>Todo, incluido borrar el hogar y transferir la propiedad.</dd>
            <dt>Administrador</dt><dd>Invitar y quitar miembros, cambiar ajustes del hogar y cargar copias.</dd>
            <dt>Editor</dt><dd>Anotar, editar y borrar gastos, facturas, listas, mascotas…</dd>
            <dt>Solo lectura</dt><dd>Ver todo sin cambiar nada.</dd></dl></details>
      </section>
      ${admin ? html`
      <section class="panel"><div class="panel-head"><h2>Invitar a alguien que ya usa ${NAME}</h2></div>
        <form class="row wrap" id="invf" style="gap:10px">
          <div class="input-group" style="flex:1;min-width:200px">${icon('at-sign')}<input class="input" name="username" placeholder="Nombre de usuario" autocapitalize="none" required></div>
          <select class="select" name="role" style="width:auto">${['editor', 'viewer', ...(owner ? ['admin'] : [])].map((r) => html`<option value="${r}">${ROLE_NAMES[r]}</option>`)}</select>
          <button class="btn primary" type="submit">${icon('send')}Invitar</button></form>
        <p class="small muted" style="margin-top:8px">Verá la invitación al entrar en la app y podrá aceptarla.</p></section>
      <section class="panel"><div class="panel-head"><h2>Invitar con un código</h2></div>
        <p class="small ink-2">Para quien aún no tiene cuenta: que se registre en esta misma dirección y use «Unirme con un código».</p>
        <div class="row wrap" style="gap:10px;margin-top:12px">
          <select class="select sm" id="code-role" style="width:auto"><option value="editor">Editor</option><option value="viewer">Solo lectura</option></select>
          <select class="select sm" id="code-days" style="width:auto"><option value="1">Válido 1 día</option><option value="7" selected>Válido 7 días</option><option value="30">Válido 30 días</option></select>
          <select class="select sm" id="code-uses" style="width:auto"><option value="1">1 uso</option><option value="5">5 usos</option></select>
          <button class="btn" data-act="code">${icon('key-round')}Generar código</button></div>
        <div id="code-out"></div></section>
      ${inv.length ? html`<section class="panel"><div class="panel-head"><h2>Invitaciones pendientes</h2></div>
        <div class="rows">${inv.map((i) => html`<div class="rowi"><span class="cat-dot sm">${icon(i.code ? 'key-round' : 'mail', 'sm')}</span>
          <span class="main-txt"><span class="title">${i.code ? html`Código <b class="num">${i.code}</b>` : `@${i.username}`}</span>
            <span class="meta">${ROLE_NAMES[i.role]}${i.code ? ` · ${i.uses}/${i.max_uses} usos · caduca ${timeAgo(i.expires_at).replace('hace', 'en')}` : ` · ${timeAgo(i.created_at)}`}</span></span>
          <button class="btn ghost sm" data-cancel-inv="${i.id}">Cancelar</button></div>`)}</div></section>` : ''}` : ''}`;
  }

  // ---------- Familia ----------
  function familia() {
    const ppl = store.house.people;
    return html`<section class="panel"><div class="panel-head"><h2>Personas de la familia</h2>
      ${can('edit') ? html`<div class="actions"><button class="btn sm" data-act="add-person">${icon('plus', 'sm')}Añadir</button></div>` : ''}</div>
      <p class="small muted" style="margin:-6px 0 12px">Sirven para saber quién paga o para quién es cada gasto, aunque no tengan cuenta (por ejemplo, los niños).</p>
      <div class="rows">${ppl.map((p) => html`<div class="rowi" style="${p.archived ? 'opacity:.55' : ''}">
        ${avatar(p)}
        <span class="main-txt"><span class="title">${p.name}</span><span class="meta">${p.user_id ? 'Tiene cuenta en el hogar' : 'Sin cuenta'}${p.archived ? ' · archivada' : ''}</span></span>
        ${can('edit') ? html`<button class="btn ghost sm" data-person="${p.id}">${icon('pencil', 'sm')}Editar</button>` : ''}</div>`)}</div></section>`;
  }

  function personForm(p = null) {
    const s = sheet({
      title: p ? `Editar a ${p.name}` : 'Añadir persona',
      size: 'narrow',
      body: html`<form class="form" id="pp">${photoField(p)}<div class="field"><label for="pp-n">Nombre</label><input class="input" id="pp-n" name="name" value="${p?.name || ''}" maxlength="40" required></div>
        <div class="field"><label>Icono</label>${emojiPicker('emoji', p?.emoji || '🙂', ['🙂', '👩', '👨', '👧', '👦', '👶', '👵', '👴', '🧑', '👱‍♀️', '🧔', '👩‍🦱'])}</div>
        <div class="field"><label>Color</label>${colorPicker('color', p?.color || COLORS[2])}</div></form>`,
      foot: html`${p ? html`<button class="btn danger" data-act="arch">${p.archived ? 'Recuperar' : 'Archivar'}</button>
        ${!p.user_id ? html`<button class="btn danger icon-only" data-act="del" aria-label="Borrar">${icon('trash-2')}</button>` : ''}` : ''}
        <span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const f = $('#pp', s.el);
    bindPickers(f);
    bindPhotoField(f, p || {});
    const done = async (r) => {
      setHouse(r);
      notifyChange('people');
      s.close();
      draw();
    };
    on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
      const v = readForm(f);
      if (!v.name.trim()) return showFormError(f, 'Escribe el nombre');
      try {
        await done(p ? await patch(`/people/${p.id}`, v) : await post('/people', v));
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=arch]', async () => done(await patch(`/people/${p.id}`, { archived: !p.archived })).catch(toastError));
    on(s.el, 'click', '[data-act=del]', async () => {
      if (!(await confirmDialog({ title: `¿Borrar a ${p.name}?`, text: 'Sus gastos se conservan pero quedarán sin persona asignada.', confirm: 'Borrar', danger: true }))) return;
      try {
        await done(await del(`/people/${p.id}`));
      } catch (err) {
        toastError(err);
      }
    });
  }

  // ---------- Categorías ----------
  let allRules = false;
  async function categorias() {
    const list = categories(catKind, { all: true });
    const [rules, apply] = await Promise.all([
      get('/rules').catch(() => []),
      can('edit') ? post('/rules/apply', { dry: true }).catch(() => null) : null,
    ]);
    return html`${categoryList(list)}${rulesPanel(rules.filter((r) => r.kind === catKind), apply)}`;
  }

  // Lo que la app ha aprendido (o le han dicho) de cada comercio.
  function rulesPanel(rules, apply) {
    const shown = allRules ? rules : rules.slice(0, 12);
    return html`<section class="panel"><div class="panel-head"><h2>Categorías automáticas</h2>
      <span class="sub">${plural(rules.length, 'comercio', 'comercios')}</span>
      ${can('edit') ? html`<div class="actions"><button class="btn sm" data-act="add-rule">${icon('plus', 'sm')}Añadir</button></div>` : ''}</div>
      <p class="small ink-2" style="margin-bottom:12px">Al anotar a mano, leer un ticket o importar del banco, cada comercio va a su categoría.
        Se aprende sola cada vez que eliges o corriges una; aquí puedes ajustarla.</p>
      ${apply?.matched ? html`<div class="ha-alert info" style="margin-bottom:12px">${icon('wand-sparkles', 'sm')}
        <span>${plural(apply.matched, 'movimiento sin categoría ya tiene', 'movimientos sin categoría ya tienen')} una propuesta.</span>
        <button class="btn sm" data-act="apply-rules">Ponérsela</button></div>` : ''}
      ${rules.length ? html`<div class="rows">${shown.map((r) => html`<div class="rowi">
        <span class="cat-dot sm" style="--c:${r.category_color}"><span class="emoji">${r.category_icon}</span></span>
        <span class="main-txt"><span class="title">${r.pattern}</span>
          <span class="meta">${r.source === 'manual' ? 'Puesta a mano' : `Aprendida · ${plural(r.hits, 'vez', 'veces')}`}</span></span>
        ${can('edit') ? html`<select class="select sm" data-rule-cat="${r.id}" aria-label="Categoría de ${r.pattern}" style="max-width:220px">
            ${categories(r.kind).map((c) => html`<option value="${c.id}" ${c.id === r.category_id ? 'selected' : ''}>${c.icon} ${c.name}</option>`)}</select>
          <button class="btn ghost sm icon-only" data-del-rule="${r.id}" aria-label="Olvidar ${r.pattern}">${icon('x', 'sm')}</button>`
          : html`<span class="small">${r.category_name}</span>`}
      </div>`)}</div>
      ${rules.length > 12 ? html`<div class="row" style="justify-content:center;margin-top:10px"><button class="btn sm" data-act="all-rules">${allRules ? 'Ver menos' : `Ver los ${rules.length}`}</button></div>` : ''}`
        : html`<p class="small muted">Aún no hay ninguna. Aparecerán según vayáis anotando.</p>`}
    </section>`;
  }

  function ruleForm() {
    const s = sheet({
      title: 'Nueva categoría automática', size: 'narrow',
      body: html`<form class="form" id="rf"><div class="field"><label for="rf-p">Cuando el concepto o el comercio contenga</label>
          <input class="input" id="rf-p" name="pattern" maxlength="60" placeholder="MERCADONA, GIMNASIO, COLEGIO…" required></div>
        <div class="field"><label for="rf-c">Ponerle la categoría</label><select class="select" id="rf-c" name="category_id">
          ${categories(catKind).map((c) => html`<option value="${c.id}">${c.icon} ${c.name}</option>`)}</select></div></form>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const f = $('#rf', s.el);
    focusLater($('#rf-p', f), 150);
    const save = (b) => withBusy(b, async () => {
      const v = readForm(f);
      try {
        await post('/rules', { pattern: v.pattern, kind: catKind, category_id: Number(v.category_id) });
        s.close();
        draw();
      } catch (err) {
        showFormError(f, err.message);
      }
    });
    on(s.el, 'click', '[data-act=save]', (e, b) => save(b));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      save($('[data-act=save]', s.el));
    });
  }

  function categoryList(list) {
    return html`<section class="panel"><div class="panel-head">
      <div class="segmented" data-ck><button data-v="expense" aria-pressed="${catKind === 'expense'}">Gastos</button><button data-v="income" aria-pressed="${catKind === 'income'}">Ingresos</button></div>
      ${can('edit') ? html`<div class="actions"><button class="btn sm" data-act="add-cat">${icon('plus', 'sm')}Nueva categoría</button></div>` : ''}</div>
      <div class="rows">${list.map((c, i) => html`<div class="rowi" style="${c.archived ? 'opacity:.5' : ''}">
        <span class="cat-dot" style="--c:${c.color}"><span class="emoji">${c.icon}</span></span>
        <span class="main-txt"><span class="title">${c.name}</span><span class="meta">${c.budget ? `Presupuesto ${money(c.budget, { decimals: 0 })}/mes` : 'Sin presupuesto'}${c.archived ? ' · archivada' : ''}</span></span>
        ${can('edit') ? html`<span class="row" style="gap:2px">
          <button class="btn ghost sm icon-only" data-move="${c.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir">${icon('chevron-up', 'sm')}</button>
          <button class="btn ghost sm icon-only" data-move="${c.id}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Bajar">${icon('chevron-down', 'sm')}</button>
          <button class="btn ghost sm" data-cat="${c.id}">${icon('pencil', 'sm')}Editar</button></span>` : ''}</div>`)}</div></section>`;
  }

  function catForm(c = null) {
    const kind = c?.kind || catKind;
    const s = sheet({
      title: c ? 'Editar categoría' : `Nueva categoría de ${kind === 'expense' ? 'gasto' : 'ingreso'}`,
      body: html`<form class="form" id="cf">
        <div class="grid-2"><div class="field"><label for="cf-n">Nombre</label><input class="input" id="cf-n" name="name" value="${c?.name || ''}" maxlength="40" required></div>
          ${kind === 'expense' ? html`<div class="field"><label for="cf-b">Presupuesto mensual</label><div class="input-group"><input class="input" id="cf-b" name="budget" inputmode="decimal" value="${amountStr(c?.budget)}" placeholder="Sin límite" style="padding-left:13px"><span class="suffix">€</span></div></div>` : ''}</div>
        <div class="field"><label>Icono</label>${emojiPicker('icon', c?.icon || '🏷️')}</div>
        <div class="field"><label>Color</label>${colorPicker('color', c?.color || COLORS[1])}</div></form>`,
      foot: html`${c ? html`<button class="btn danger" data-act="arch">${c.archived ? 'Recuperar' : 'Archivar'}</button>
        <button class="btn danger icon-only" data-act="del" aria-label="Borrar">${icon('trash-2')}</button>` : ''}
        <span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const f = $('#cf', s.el);
    bindPickers(f);
    const done = (r) => {
      setHouse(r);
      notifyChange('categories');
      s.close();
      draw();
    };
    on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
      const v = readForm(f);
      if (!v.name.trim()) return showFormError(f, 'Escribe el nombre');
      const budget = v.budget ? parseAmount(v.budget) : null;
      const payload = { name: v.name, icon: v.icon, color: v.color, budget: Number.isNaN(budget) ? null : budget };
      try {
        done(c ? await patch(`/categories/${c.id}`, payload) : await post('/categories', { ...payload, kind }));
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=arch]', async () => {
      try {
        done(await patch(`/categories/${c.id}`, { archived: !c.archived }));
      } catch (err) {
        toastError(err);
      }
    });
    on(s.el, 'click', '[data-act=del]', () => {
      const others = categories(kind).filter((x) => x.id !== c.id);
      const d = sheet({
        title: `Borrar «${c.name}»`,
        size: 'narrow',
        body: html`<form class="form" id="dc"><p class="ink-2">¿A qué categoría pasan sus movimientos, pagos fijos y facturas?</p>
          <select class="select" name="move_to"><option value="">Dejarlos sin categoría</option>${others.map((o) => html`<option value="${o.id}">${o.icon} ${o.name}</option>`)}</select></form>`,
        foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn danger solid" data-act="ok">Borrar</button>`,
      });
      on(d.el, 'click', '[data-act=ok]', (e, b) => withBusy(b, async () => {
        try {
          const r = await del(`/categories/${c.id}`, { move_to: Number($('select', d.el).value) || null });
          d.close();
          done(r);
        } catch (err) {
          toastError(err);
        }
      }));
    });
  }

  // ---------- Cuenta ----------
  async function cuenta() {
    const sessions = await api('/auth/sessions').catch(() => []);
    const me = store.me;
    const device = (ua = '') => (/iphone|ipad/i.test(ua) ? 'iPhone / iPad' : /android/i.test(ua) ? 'Android' : /mac/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : 'Navegador');
    const mine = store.house.people.find((p) => p.user_id === me.id);
    return html`
      ${mine ? html`<section class="panel"><div class="panel-head"><h2>Tu foto</h2><span class="sub">en ${store.house.household.name}</span></div>
        <form class="form" id="myphoto">${photoField(mine)}</form></section>` : ''}
      <section class="panel"><div class="panel-head"><h2>Tus datos</h2></div>
        <form class="form" id="mef"><div class="grid-2">
          <div class="field"><label for="me-n">Nombre</label><input class="input" id="me-n" name="display_name" value="${me.display_name}" maxlength="40"></div>
          <div class="field"><label>Usuario</label><input class="input" value="@${me.username}" disabled></div>
          <div class="field"><label for="me-e">Email</label><input class="input" id="me-e" name="email" type="email" value="${me.email || ''}" maxlength="120"></div></div>
          <div class="field"><label>Tu color</label>${colorPicker('color', me.color)}</div>
          <div class="row"><button class="btn primary" type="submit">Guardar</button></div></form></section>
      <section class="panel"><div class="panel-head"><h2>Cambiar contraseña</h2></div>
        <form class="form" id="pwf"><div class="grid-2">
          <div class="field"><label for="pw-c">Contraseña actual</label><input class="input" id="pw-c" name="current" type="password" autocomplete="current-password"></div>
          <div class="field"><label for="pw-n">Nueva contraseña</label><input class="input" id="pw-n" name="next" type="password" autocomplete="new-password" minlength="8"></div></div>
          <div class="row"><button class="btn" type="submit">${icon('lock')}Cambiar contraseña</button><span class="small muted">Se cerrarán tus otras sesiones.</span></div></form></section>
      <section class="panel"><div class="panel-head"><h2>Dispositivos con sesión abierta</h2>
        ${sessions.length > 1 ? html`<div class="actions"><button class="btn sm" data-act="close-others">Cerrar las demás</button></div>` : ''}</div>
        <div class="rows">${sessions.map((x) => html`<div class="rowi"><span class="cat-dot sm">${icon(/iphone|android/i.test(x.user_agent) ? 'smartphone' : 'monitor', 'sm')}</span>
          <span class="main-txt"><span class="title">${device(x.user_agent)}${x.current ? html` <span class="pill paid" style="margin-left:6px">Este dispositivo</span>` : ''}</span>
            <span class="meta">Último uso ${timeAgo(x.last_seen_at)} · IP ${x.ip || '—'}</span></span></div>`)}</div></section>
      <section class="panel danger-zone"><div class="row between wrap"><div><b>Borrar mi cuenta</b>
        <p class="small muted">Se borra tu usuario. Los hogares que compartes pasan a otro miembro; los que son solo tuyos se borran.</p></div>
        <button class="btn danger" data-act="delete-me">${icon('trash-2')}Borrar cuenta</button></div></section>`;
  }

  // ---------- Notificaciones ----------
  async function avisos() {
    const st = await pushStatus().catch(() => ({ supported: false }));
    const httpsUrl = `https://${location.hostname.split('.')[0]}.<tu-tailnet>.ts.net`;
    return html`<section class="panel"><div class="panel-head"><h2>Notificaciones en este dispositivo</h2></div>
      <p class="ink-2">Te avisamos de pagos y facturas que vencen, cuotas de plazos, recordatorios y vacunas de las mascotas, aunque tengas la app cerrada.</p>
      <div class="row wrap" style="margin-top:14px;gap:10px">
        ${!st.supported ? html`<span class="pill overdue">Este navegador no admite notificaciones</span>`
          : !st.secure ? html`<div class="form-error" style="background:var(--amber-soft);color:var(--amber-ink)">${icon('lock', 'sm')}<span>Hace falta abrir ${NAME} por <b>HTTPS</b>.
            En el contenedor ejecuta <code>tailscale serve --bg 8080</code> y entra desde ${httpsUrl}.</span></div>`
            : st.subscribed ? html`<span class="pill paid">${icon('circle-check')}Activadas</span><button class="btn" data-act="push-test">Enviar prueba</button><button class="btn danger" data-act="push-off">Desactivar</button>`
              : html`<button class="btn primary" data-act="push-on">${icon('bell')}Activar notificaciones</button>`}
      </div>
      ${st.permission === 'denied' ? html`<p class="small neg" style="margin-top:10px">Has bloqueado las notificaciones para esta web. Actívalas en los ajustes del navegador.</p>` : ''}
      <p class="small muted" style="margin-top:14px">En iPhone hay que añadir antes ${NAME} a la pantalla de inicio (Compartir → Añadir a pantalla de inicio) y abrirla desde ahí.</p>
    </section>
    <section class="panel"><div class="panel-head"><h2>Cuándo avisamos</h2></div><dl class="kv small">
      <dt>Recordatorios</dt><dd>Con la antelación que elijas en cada uno, el mismo día y al día siguiente si sigue pendiente.</dd>
      <dt>Pagos fijos y plazos</dt><dd>Los días de antelación de cada pago y, si es manual, el día que toca.</dd>
      <dt>Facturas</dt><dd>3 días antes de vencer, el día del vencimiento y al día siguiente si sigue sin pagar.</dd>
      <dt>Mascotas</dt><dd>3 días antes de cada vacuna o desparasitación y ese mismo día.</dd></dl></section>`;
  }

  // ---------- Datos ----------
  function datos() {
    return html`
      <section class="panel"><div class="panel-head"><h2>Copia de seguridad del hogar</h2></div>
        <p class="ink-2">Descarga todos los datos de «${store.house.household.name}» en un archivo. Sirve para guardar una copia o pasar los datos a otro servidor de ${NAME}.</p>
        <div class="row wrap" style="margin-top:14px;gap:10px"><button class="btn primary" data-act="export-json">${icon('download')}Descargar copia (JSON)</button>
          ${can('admin') ? html`<button class="btn" data-act="import-json">${icon('upload')}Cargar una copia</button>` : ''}</div>
        <p class="small muted" style="margin-top:10px">Los archivos adjuntos (tickets, PDF, fotos) se guardan en el servidor, en la carpeta <code>data/uploads</code>.</p></section>
      <section class="panel"><div class="panel-head"><h2>Copia de las notas</h2></div>
        <p class="ink-2">Un .zip con tus notas (las del hogar y tus privadas), sus cuadernos e imágenes, que se lee sin la app y se restaura aquí tal cual.</p>
        <div class="row wrap" style="margin-top:14px;gap:10px"><a class="btn" href="#/notas?copia=1">${icon('archive')}Copia de seguridad de las notas</a></div></section>
      <section class="panel"><div class="panel-head"><h2>Hoja de cálculo</h2></div>
        <p class="ink-2">Exporta los movimientos a CSV para abrirlos en Excel o LibreOffice, o importa el extracto de tu banco.</p>
        <div class="row wrap" style="margin-top:14px;gap:10px"><button class="btn" data-act="export-csv">${icon('file-down')}Exportar movimientos (CSV)</button>
          <a class="btn" href="#/movimientos">${icon('file-up')}Importar desde Movimientos</a></div></section>
      ${can('admin') ? html`<section class="panel"><div class="panel-head"><h2>Datos de ejemplo</h2></div>
        <p class="ink-2">Rellena este hogar con un año de datos de una familia ficticia (gastos, facturas, plazos, mascotas…) para probar la app. Solo funciona en hogares sin movimientos.</p>
        <div class="row" style="margin-top:14px"><button class="btn" data-act="demo">${icon('wand-sparkles')}Cargar datos de ejemplo</button></div></section>` : ''}`;
  }

  function apariencia() {
    const t = pref('gastosbyath.theme') || 'auto';
    return html`<section class="panel"><div class="panel-head"><h2>Tema</h2></div>
      <div class="segmented" data-theme-pick><button data-v="auto" aria-pressed="${t === 'auto'}">${icon('sun-moon', 'sm')}Automático</button>
        <button data-v="light" aria-pressed="${t === 'light'}">${icon('sun', 'sm')}Claro</button><button data-v="dark" aria-pressed="${t === 'dark'}">${icon('moon', 'sm')}Oscuro</button></div>
      <p class="small muted" style="margin-top:10px">«Automático» sigue la configuración de tu dispositivo.</p></section>
      <section class="panel"><div class="panel-head"><h2>Leer con comodidad</h2></div><div class="stack" style="gap:14px">${prefsControls()}</div>
        <p class="small muted" style="margin-top:10px">Solo para ti y en todos tus dispositivos. Quien administra el hogar también puede poner la vista sencilla a otros miembros desde Miembros.</p></section>
      <section class="panel"><div class="panel-head"><h2>Atajos de teclado</h2></div><dl class="kv small">
        <dt><kbd>N</kbd></dt><dd>Anotar un gasto</dd><dt><kbd>I</kbd></dt><dd>Anotar un ingreso</dd>
        <dt><kbd>Ctrl</kbd> + <kbd>K</kbd> o <kbd>/</kbd></dt><dd>Buscar movimientos y acciones</dd></dl></section>
      <section class="panel"><div class="panel-head"><h2>Instalar en el móvil</h2></div>
        <p class="ink-2">${NAME} se puede instalar como una app: en Android, menú del navegador → «Instalar aplicación»; en iPhone, Compartir → «Añadir a pantalla de inicio».</p></section>`;
  }

  // ---------- Eventos ----------
  on(ctx.el, 'click', '[data-sec]', (e, a) => {
    e.preventDefault();
    section = a.dataset.sec;
    history.replaceState(null, '', `#/ajustes/${section}`);
    draw();
  });
  // Vista previa del color del hogar mientras se elige (si no se guarda, vuelve el de antes).
  const previewTint = () => {
    const f = $('#hf', ctx.el);
    if (f) applyTint({ color: readForm(f).color, tint: f.elements.tint?.checked ? 1 : 0 });
  };
  on(ctx.el, 'click', '#hf [data-pick=color] [data-v]', () => setTimeout(previewTint));
  on(ctx.el, 'change', '#hf [name=tint]', previewTint);
  ctx.onCleanup(() => applyTint(store.house?.household));
  on(ctx.el, 'submit', '#hf', (e, f) => {
    e.preventDefault();
    const btn = $('button[type=submit]', f);
    withBusy(btn, async () => {
      const v = readForm(f);
      const budget = v.monthly_budget ? parseAmount(v.monthly_budget) : null;
      try {
        setHouse(await patch('', { name: v.name, currency: v.currency, icon: v.icon, color: v.color, tint: !!v.tint, monthly_budget: Number.isNaN(budget) ? null : budget }));
        notifyChange('household');
        toast('Hogar actualizado');
        location.reload();
      } catch (err) {
        showFormError(f, err.message);
      }
    });
  });
  on(ctx.el, 'click', '[data-act=leave]', async () => {
    if (!(await confirmDialog({ title: '¿Salir de este hogar?', text: 'Dejarás de ver sus datos.', confirm: 'Salir', danger: true }))) return;
    try {
      await del(`/members/${store.me.id}`);
      setSession(await api('/auth/me'));
      location.hash = '#/inicio';
      location.reload();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'click', '[data-act=delete-house]', async () => {
    const name = await promptDialog({ title: 'Borrar el hogar', label: `Escribe «${store.house.household.name}» para confirmar`, confirm: 'Borrar para siempre' });
    if (name === undefined || name === null) return;
    try {
      await del('', { confirm: name });
      location.hash = '#/inicio';
      location.reload();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'change', '[data-role]', async (e, sel) => {
    try {
      setHouse(await patch(`/members/${sel.dataset.role}`, { role: sel.value }));
      toast('Rol actualizado');
    } catch (err) {
      toastError(err);
      draw();
    }
  });
  on(ctx.el, 'click', '[data-kick]', async (e, b) => {
    const m = store.house.members.find((x) => x.id === Number(b.dataset.kick));
    if (!(await confirmDialog({ title: `¿Quitar a ${m.display_name}?`, text: 'Dejará de tener acceso a este hogar.', confirm: 'Quitar', danger: true }))) return;
    try {
      setHouse(await del(`/members/${m.id}`));
      draw();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'click', '[data-transfer]', async (e, b) => {
    const m = store.house.members.find((x) => x.id === Number(b.dataset.transfer));
    if (!(await confirmDialog({ title: `¿Hacer propietario a ${m.display_name}?`, text: 'Tú pasarás a ser administrador.', confirm: 'Transferir' }))) return;
    try {
      setHouse(await post('/transfer', { user_id: m.id }));
      draw();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'submit', '#invf', (e, f) => {
    e.preventDefault();
    withBusy($('button', f), async () => {
      const v = readForm(f);
      try {
        setHouse(await post('/invitations', v));
        toast(`Invitación enviada a @${v.username}`);
        draw();
      } catch (err) {
        toastError(err);
      }
    });
  });
  on(ctx.el, 'click', '[data-act=code]', (e, b) => withBusy(b, async () => {
    try {
      const r = await post('/invite-codes', { role: $('#code-role', ctx.el).value, days: Number($('#code-days', ctx.el).value), max_uses: Number($('#code-uses', ctx.el).value) });
      setHouse(r);
      const text = `Únete a «${store.house.household.name}» en ${NAME}: entra en ${location.origin}, crea tu cuenta y usa el código ${r.code}`;
      $('#code-out', ctx.el).innerHTML = String(html`<div class="code-box" style="margin-top:14px">${r.code}</div>
        <div class="row wrap" style="margin-top:10px;gap:8px"><button class="btn sm" data-copy="${text}">${icon('copy', 'sm')}Copiar mensaje</button>
          ${navigator.share ? html`<button class="btn sm" data-share="${text}">${icon('share-2', 'sm')}Compartir</button>` : ''}</div>`);
    } catch (err) {
      toastError(err);
    }
  }));
  on(ctx.el, 'click', '[data-copy]', async (e, b) => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast('Copiado');
    } catch {
      toast(b.dataset.copy, { timeout: 9000 });
    }
  });
  on(ctx.el, 'click', '[data-share]', (e, b) => navigator.share({ text: b.dataset.share }).catch(() => {}));
  on(ctx.el, 'click', '[data-cancel-inv]', async (e, b) => {
    try {
      setHouse(await del(`/invitations/${b.dataset.cancelInv}`));
      draw();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'click', '[data-act=add-person]', () => personForm());
  on(ctx.el, 'click', '[data-person]', (e, b) => personForm(store.house.people.find((p) => p.id === Number(b.dataset.person))));
  on(ctx.el, 'click', '[data-ck] [data-v]', (e, b) => {
    catKind = b.dataset.v;
    draw();
  });
  on(ctx.el, 'click', '[data-act=add-cat]', () => catForm());
  on(ctx.el, 'click', '[data-act=add-rule]', () => ruleForm());
  bindPrefsControls(ctx.el);
  on(ctx.el, 'click', '[data-member-simple]', async (e, b) => {
    const on2 = b.getAttribute('aria-pressed') !== 'true';
    try {
      await patch(`/members/${b.dataset.memberSimple}/prefs`, { simple: on2 });
      const m = store.house.members.find((x) => x.id === Number(b.dataset.memberSimple));
      if (m) m.simple = on2 ? 1 : 0;
      toast(on2 ? `${m?.display_name || 'Esa persona'} verá la vista sencilla` : `${m?.display_name || 'Esa persona'} vuelve a la vista completa`);
      draw();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'click', '[data-act=all-rules]', () => {
    allRules = !allRules;
    draw();
  });
  on(ctx.el, 'change', '[data-rule-cat]', async (e, sel) => {
    try {
      await patch(`/rules/${sel.dataset.ruleCat}`, { category_id: Number(sel.value) });
      toast('Categoría automática guardada');
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'click', '[data-del-rule]', async (e, b) => {
    try {
      await del(`/rules/${b.dataset.delRule}`);
      draw();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'click', '[data-act=apply-rules]', (e, b) => withBusy(b, async () => {
    try {
      const r = await post('/rules/apply', {});
      notifyChange('transactions');
      toast(`Categoría puesta a ${plural(r.applied, 'movimiento', 'movimientos')}`);
      draw();
    } catch (err) {
      toastError(err);
    }
  }));
  on(ctx.el, 'click', '[data-cat]', (e, b) => catForm(store.house.categories.find((c) => c.id === Number(b.dataset.cat))));
  on(ctx.el, 'click', '[data-move]', async (e, b) => {
    const list = categories(catKind, { all: true }).map((c) => c.id);
    const i = list.indexOf(Number(b.dataset.move));
    const j = i + Number(b.dataset.dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    try {
      setHouse(await post('/categories/reorder', { ids: list }));
      draw();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'submit', '#mef', (e, f) => {
    e.preventDefault();
    withBusy($('button[type=submit]', f), async () => {
      try {
        setSession(await api('/auth/me', { method: 'PATCH', body: readForm(f) }));
        await reloadHouse();
        toast('Datos guardados');
      } catch (err) {
        showFormError(f, err.message);
      }
    });
  });
  on(ctx.el, 'submit', '#pwf', (e, f) => {
    e.preventDefault();
    withBusy($('button[type=submit]', f), async () => {
      try {
        await api('/auth/password', { method: 'POST', body: readForm(f) });
        f.reset();
        toast('Contraseña cambiada');
        draw();
      } catch (err) {
        showFormError(f, err.message);
      }
    });
  });
  on(ctx.el, 'click', '[data-act=close-others]', async () => {
    const r = await api('/auth/sessions/close-others', { method: 'POST', body: {} }).catch(toastError);
    if (r) toast(`${plural(r.closed, 'sesión cerrada', 'sesiones cerradas')}`);
    draw();
  });
  on(ctx.el, 'click', '[data-act=delete-me]', async () => {
    const pw = await promptDialog({ title: 'Borrar mi cuenta', label: 'Escribe tu contraseña para confirmar', type: 'password', confirm: 'Borrar mi cuenta' });
    if (!pw) return;
    try {
      await api('/auth/me', { method: 'DELETE', body: { password: pw } });
      location.hash = '';
      location.reload();
    } catch (err) {
      toastError(err);
    }
  });
  on(ctx.el, 'click', '[data-act=push-on]', (e, b) => withBusy(b, async () => {
    try {
      await enablePush();
      await testPush().catch(() => {});
      toast('Notificaciones activadas');
      draw();
    } catch (err) {
      toastError(err);
    }
  }));
  on(ctx.el, 'click', '[data-act=push-off]', async () => {
    await disablePush();
    draw();
  });
  on(ctx.el, 'click', '[data-act=push-test]', () => testPush().then(() => toast('Notificación enviada')).catch(toastError));
  on(ctx.el, 'click', '[data-act=export-json]', () => download(hurl('/data/export.json')));
  on(ctx.el, 'click', '[data-act=export-csv]', () => download(hurl('/transactions/export.csv')));
  on(ctx.el, 'click', '[data-act=import-json]', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        return toastError(new Error('El archivo no es un JSON válido'));
      }
      const n = data.transactions?.length || 0;
      if (!(await confirmDialog({ title: 'Cargar copia de seguridad', text: `Se añadirán ${plural(n, 'movimiento', 'movimientos')} y el resto de datos a «${store.house.household.name}». Las categorías y personas con el mismo nombre se reutilizan.`, confirm: 'Cargar' }))) return;
      try {
        const r = await post('/data/import.json', data);
        await reloadHouse();
        toast(`Copia cargada: ${plural(r.counts.transactions, 'movimiento', 'movimientos')}`);
      } catch (err) {
        toastError(err);
      }
    };
    input.click();
  });
  on(ctx.el, 'click', '[data-act=demo]', (e, b) => withBusy(b, async () => {
    try {
      setHouse(await post('/demo'));
      notifyChange('household');
      toast('Datos de ejemplo cargados');
      ctx.navigate('#/inicio');
    } catch (err) {
      toastError(err);
    }
  }));
  on(ctx.el, 'click', '[data-theme-pick] [data-v]', async (e, b) => {
    const { setTheme } = await import('../app.js');
    setTheme(b.dataset.v);
    $$('[data-theme-pick] [data-v]', ctx.el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });

  ctx.setRefresh(() => draw());
  await draw();
}
