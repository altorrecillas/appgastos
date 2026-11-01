// Mascotas: fichas, salud (vacunas, desparasitaciones, veterinario), peso y gastos.
import { del, get, hurl, patch, post, upload } from '../api.js';
import {
  $, PET_EVENTS, SPECIES, addDays, ageText, amountStr, confirmDialog, daysBetween, fmtDate, fmtDateFull, fmtDateLong, html, icon, money,
  monthShort, num, on, parseAmount, relDay, sheet, shiftMonth, thisMonth, today, toast, toastError, withBusy, focusLater, skeletonPage,
} from '../ui.js';
import { can, loadHouse } from '../store.js';
import {
  bindDateQuick, bindPickers, chipPicker, colorPicker, dateQuick, focusFirst, methodOptions, notifyChange, readForm, showFormError,
} from '../forms.js';
import { catAxis, grid, mountChart, tipBox, tipHTML, valAxis, axisLabel } from '../charts.js';

const TITLES = {
  vaccine: { dog: ['Rabia', 'Polivalente', 'Leishmaniosis', 'Tos de las perreras'], cat: ['Trivalente felina', 'Leucemia felina', 'Rabia'], other: ['Rabia'] },
  deworming: { any: ['Desparasitación interna', 'Desparasitación externa (pipeta)', 'Collar antiparasitario'] },
  vet: { any: ['Revisión anual', 'Consulta', 'Análisis de sangre', 'Urgencias', 'Dentista'] },
  food: { dog: ['Pienso', 'Comida húmeda', 'Premios y snacks'], cat: ['Pienso', 'Latas y sobres', 'Premios'], any: ['Comida', 'Premios'] },
  grooming: { any: ['Baño y corte', 'Corte de uñas', 'Limpieza de oídos'] },
  medication: { any: ['Antibiótico', 'Antiinflamatorio', 'Tratamiento crónico'] },
  weight: { any: ['Peso'] },
  other: { any: [] },
};

const petPhoto = (p, cls = '') => html`<div class="pet-photo ${cls}" style="--c:${p.color}">
  ${p.photo_id ? html`<img src="${hurl(`/attachments/${p.photo_id}`)}" alt="${p.name}" loading="lazy">` : html`<span class="emoji">${SPECIES[p.species]?.emoji || '🐾'}</span>`}
</div>`;

export default async function petsView(ctx) {
  const id = Number(ctx.params[0]) || null;
  if (id) return petDetail(ctx, id);
  ctx.setHeader('Mascotas', '', can('edit') ? html`<button class="btn primary" data-act="new">${icon('plus')}<span class="desktop-only">Añadir mascota</span></button>` : '');
  let pets = [];
  async function load() {
    try {
      pets = await get('/pets');
      if (ctx.isCurrent()) draw();
    } catch (e) {
      toastError(e);
    }
  }
  function draw() {
    const active = pets.filter((p) => !p.archived);
    const yearTotal = active.reduce((s, p) => s + p.spent_year, 0);
    const reminders = active.flatMap((p) => p.reminders.map((r) => ({ ...r, pet: p }))).sort((a, b) => a.next_date.localeCompare(b.next_date));
    if (!pets.length) {
      ctx.el.innerHTML = String(html`<div class="empty"><div class="art">🐾</div><h3>Añade a los animales de la casa</h3>
        <p>Lleva al día vacunas y desparasitaciones con recordatorio, el peso, el veterinario y lo que cuesta cada uno.</p>
        ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="new">${icon('plus')}Añadir mascota</button></div>` : ''}</div>`);
      return;
    }
    ctx.el.innerHTML = String(html`
      ${reminders.length ? html`<section class="panel" style="margin-bottom:20px"><div class="panel-head"><h2>Próximos cuidados</h2></div>
        <div class="rows">${reminders.slice(0, 6).map((r) => {
          const n = daysBetween(today(), r.next_date);
          return html`<a class="rowi" href="#/mascotas/${r.pet.id}">
            <span class="ev-ico">${PET_EVENTS[r.type]?.emoji || '📝'}</span>
            <span class="main-txt"><span class="title">${r.title} · ${r.pet.name}</span><span class="meta">${fmtDateLong(r.next_date)}</span></span>
            <span class="pill ${n < 0 ? 'overdue' : n <= 14 ? 'pending' : 'plain'}">${n < 0 ? `Vencida ${relDay(r.next_date).toLowerCase()}` : relDay(r.next_date)}</span></a>`;
        })}</div></section>` : ''}
      <div class="pets-grid">
        ${active.map((p) => {
          const next = p.reminders[0];
          return html`<a class="pet-card" href="#/mascotas/${p.id}">
            <div style="position:relative">${petPhoto(p)}
              ${next ? html`<span class="pill ${next.next_date < today() ? 'overdue' : 'info'}" style="position:absolute;left:12px;bottom:12px;background:var(--surface)">
                ${PET_EVENTS[next.type]?.emoji} ${next.title}: ${relDay(next.next_date).toLowerCase()}</span>` : ''}</div>
            <div class="pet-body"><h3>${p.name}</h3>
              <div class="small muted">${[SPECIES[p.species]?.name, p.breed, p.sex === 'f' ? 'Hembra' : p.sex === 'm' ? 'Macho' : ''].filter(Boolean).join(' · ')}</div>
              <div class="pet-facts">
                <div>Edad<b>${p.birth_date ? ageText(p.birth_date).replace(/ y .*/, '') : '—'}</b></div>
                <div>Peso<b>${p.weight ? `${num(p.weight)} kg` : '—'}</b></div>
                <div>Este año<b>${money(p.spent_year, { decimals: 0 })}</b></div>
              </div></div></a>`;
        })}
      </div>
      ${yearTotal ? html`<p class="small muted" style="margin-top:16px">Entre todos, ${money(yearTotal, { decimals: 0 })} en lo que va de año (veterinario, comida, peluquería…).</p>` : ''}
      ${pets.some((p) => p.archived) ? html`<div class="section-title"><h2>Archivadas</h2></div>
        <div class="rows">${pets.filter((p) => p.archived).map((p) => html`<a class="rowi" href="#/mascotas/${p.id}">
          <span class="cat-dot"><span class="emoji">${SPECIES[p.species]?.emoji}</span></span><span class="main-txt"><span class="title">${p.name}</span></span></a>`)}</div>` : ''}`);
  }
  on(ctx.el, 'click', '[data-act=new]', () => petForm());
  const headerEl = document.getElementById('page-actions');
  ctx.onCleanup(on(headerEl, 'click', '[data-act=new]', () => petForm()));
  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
}

async function petDetail(ctx, id) {
  let pet = null;
  let tab = ctx.query.tab || 'salud';
  async function load() {
    try {
      pet = await get(`/pets/${id}`);
      if (!ctx.isCurrent()) return;
      ctx.setHeader(pet.name, [SPECIES[pet.species]?.name, pet.breed].filter(Boolean).join(' · '), html`
        <a class="btn ghost" href="#/mascotas">${icon('chevron-left')}<span class="desktop-only">Mascotas</span></a>
        ${can('edit') ? html`<button class="btn primary" data-act="event">${icon('plus')}<span class="desktop-only">Anotar</span></button>` : ''}`);
      draw();
    } catch (e) {
      if (e.status === 404) ctx.navigate('#/mascotas', { replace: true });
      else toastError(e);
    }
  }
  function draw() {
    const p = pet;
    const weights = p.events.filter((e) => e.weight != null).slice().reverse();
    ctx.el.innerHTML = String(html`
      <div class="pet-hero">${petPhoto(p)}
        <div class="stack" style="gap:10px">
          <h2>${p.name}</h2>
          <div class="row wrap small ink-2" style="gap:8px">
            ${p.birth_date ? html`<span class="pill plain">🎂 ${ageText(p.birth_date)}</span>` : ''}
            ${p.weight ? html`<span class="pill plain">⚖️ ${num(p.weight)} kg</span>` : ''}
            ${p.sterilized ? html`<span class="pill plain">Esterilizad${p.sex === 'f' ? 'a' : 'o'}</span>` : ''}
            ${p.chip ? html`<span class="pill plain">Chip ${p.chip}</span>` : ''}
          </div>
          <div class="row wrap" style="gap:22px;margin-top:4px">
            <div><div class="small muted">Gastado este año</div><div style="font-size:calc(24px * var(--fs));font-weight:720;font-stretch:84%">${money(p.spent_year)}</div></div>
            <div><div class="small muted">Desde que la registraste</div><div style="font-size:calc(24px * var(--fs));font-weight:720;font-stretch:84%">${money(p.total_spent)}</div></div>
          </div>
          ${can('edit') ? html`<div class="row" style="gap:8px"><button class="btn sm" data-act="edit">${icon('pencil', 'sm')}Editar ficha</button>
            <button class="btn sm" data-act="weight">${icon('weight', 'sm')}Anotar peso</button></div>` : ''}
        </div></div>
      ${p.reminders.length ? html`<div class="chips" style="margin-bottom:18px">${p.reminders.map((r) => {
        const n = daysBetween(today(), r.next_date);
        return html`<span class="pill ${n < 0 ? 'overdue' : n <= 14 ? 'pending' : 'info'}" style="height:30px;font-size:calc(13px * var(--fs))">${PET_EVENTS[r.type]?.emoji} ${r.title}: ${n < 0 ? `vencida ${relDay(r.next_date).toLowerCase()}` : `${relDay(r.next_date).toLowerCase()} (${fmtDate(r.next_date)})`}</span>`;
      })}</div>` : ''}
      <div class="tabs" role="tablist">
        ${[['salud', 'Salud y cuidados', 'heart-pulse'], ['peso', 'Peso', 'weight'], ['gastos', 'Gastos', 'wallet'], ['ficha', 'Ficha', 'file-text']].map(([k, l, ic]) =>
          html`<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${icon(ic, 'sm')}${l}</button>`)}
      </div>
      ${tab === 'salud' ? health(p) : tab === 'peso' ? html`<section class="panel">${weights.length > 1 ? html`<div class="chart" id="wchart" role="img" aria-label="Evolución del peso"></div>`
        : html`<p class="muted">Anota el peso de vez en cuando para ver su evolución.</p>`}
        <div class="rows" style="margin-top:10px">${weights.slice().reverse().slice(0, 12).map((w, i, arr) => {
          const prev = arr[i + 1];
          const diff = prev ? w.weight - prev.weight : 0;
          return html`<div class="rowi"><span class="main-txt"><span class="title">${num(w.weight)} kg</span><span class="meta">${fmtDateLong(w.date)}</span></span>
            ${prev ? html`<span class="small ${diff > 0 ? 'neg' : diff < 0 ? 'pos' : 'muted'}">${diff > 0 ? '+' : ''}${num(diff)} kg</span>` : ''}</div>`;
        })}</div></section>`
      : tab === 'gastos' ? html`<section class="panel"><div class="panel-head"><h2>Últimos 12 meses</h2></div>
        <div class="chart short" id="pchart" role="img" aria-label="Gasto mensual"></div></section>
        <section class="panel" style="margin-top:18px"><div class="panel-head"><h2>Movimientos</h2>
          <div class="actions">${can('edit') ? html`<button class="btn sm" data-act="expense">${icon('plus', 'sm')}Anotar gasto</button>` : ''}
            <a class="btn ghost sm" href="#/movimientos?pet=${p.id}&period=all">Ver todos</a></div></div>
          ${p.expenses.length ? html`<div class="rows">${p.expenses.slice(0, 30).map((t) => html`<div class="rowi">
            <span class="cat-dot sm"><span class="emoji">${t.category_icon || '🐾'}</span></span>
            <span class="main-txt"><span class="title">${t.description || t.merchant}</span><span class="meta">${fmtDateFull(t.date)}${t.merchant ? ` · ${t.merchant}` : ''}</span></span>
            <span class="amount">${money(t.amount)}</span></div>`)}</div>` : html`<p class="muted small">Aún no hay gastos de ${p.name}. Con «Anotar gasto» apuntas la comida, el veterinario o la peluquería, y queda como gasto de ${p.name}.</p>`}</section>`
      : html`<section class="panel"><dl class="kv">
          <dt>Especie</dt><dd>${SPECIES[p.species]?.emoji} ${SPECIES[p.species]?.name}</dd>
          <dt>Raza</dt><dd>${p.breed || '—'}</dd>
          <dt>Sexo</dt><dd>${p.sex === 'f' ? 'Hembra' : p.sex === 'm' ? 'Macho' : '—'}${p.sterilized ? ' (esterilizado)' : ''}</dd>
          <dt>Nacimiento</dt><dd>${p.birth_date ? `${fmtDateFull(p.birth_date)} (${ageText(p.birth_date)})` : '—'}</dd>
          <dt>Microchip</dt><dd>${p.chip || '—'}</dd>
          <dt>Veterinario</dt><dd>${p.vet || '—'}${p.vet_phone ? html` · <a href="tel:${p.vet_phone.replace(/\s/g, '')}">${p.vet_phone}</a>` : ''}</dd>
          <dt>Seguro</dt><dd>${p.insurance || '—'}</dd>
          <dt>Alimentación</dt><dd>${p.food || '—'}</dd>
          <dt>Notas</dt><dd style="white-space:pre-wrap">${p.notes || '—'}</dd>
        </dl></section>`}`);
    if (tab === 'peso' && weights.length > 1) {
      mountChart($('#wchart', ctx.el), (t) => ({
        grid: grid({ top: 14 }),
        tooltip: { ...tipBox(t), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: t.axis } },
          formatter: (ps) => tipHTML(fmtDateFull(weights[ps[0].dataIndex].date), [{ color: p.color, value: `${num(ps[0].value)} kg`, label: 'peso' }]) },
        xAxis: catAxis(t, weights.map((w) => fmtDate(w.date)), { boundaryGap: false }),
        yAxis: { type: 'value', scale: true, splitNumber: 4, splitLine: { lineStyle: { color: t.grid } }, axisLabel: axisLabel(t, { formatter: (v) => `${num(v)} kg` }) },
        series: [{ type: 'line', data: weights.map((w) => w.weight), smooth: 0.2, symbol: 'circle', symbolSize: 8, showSymbol: weights.length < 20,
          lineStyle: { width: 2, color: p.color }, itemStyle: { color: p.color, borderColor: t.surface, borderWidth: 2 }, areaStyle: { color: p.color, opacity: 0.08 } }],
      }));
    }
    if (tab === 'gastos') {
      const months = Array.from({ length: 12 }, (_, i) => shiftMonth(thisMonth(), i - 11));
      const vals = months.map((m) => p.monthly.find((x) => x.month === m)?.total || 0);
      mountChart($('#pchart', ctx.el), (t) => ({
        grid: grid({ top: 8 }),
        tooltip: { ...tipBox(t), trigger: 'item', formatter: (x) => tipHTML(months[x.dataIndex], [{ color: p.color, value: money(x.value), label: 'gastado', box: true }]) },
        xAxis: catAxis(t, months.map(monthShort)),
        yAxis: valAxis(t, { splitNumber: 3 }),
        series: [{ type: 'bar', data: vals, barMaxWidth: 20, itemStyle: { color: p.color, borderRadius: [4, 4, 0, 0] } }],
      }));
    }
  }

  function health(p) {
    const evs = p.events.filter((e) => e.type !== 'weight');
    if (!evs.length) return html`<div class="empty"><div class="art">💉</div><p>Anota vacunas, desparasitaciones y visitas al veterinario.
      Si pones la fecha de la próxima, te lo recordaremos.</p>${can('edit') ? html`<div class="row"><button class="btn primary" data-act="event">${icon('plus')}Anotar</button></div>` : ''}</div>`;
    return html`<section class="panel"><div class="ev-list">${evs.map((e) => html`<div class="ev-row">
      <span class="ev-ico">${PET_EVENTS[e.type]?.emoji || '📝'}</span>
      <div style="min-width:0"><div style="font-weight:600">${e.title}</div>
        <div class="small muted">${fmtDateLong(e.date)}${e.next_date ? ` · próxima: ${fmtDateFull(e.next_date)}` : ''}${e.created_by_name ? ` · ${e.created_by_name}` : ''}</div>
        ${e.notes ? html`<div class="small ink-2" style="margin-top:2px">${e.notes}</div>` : ''}</div>
      <div class="row" style="gap:6px">${e.cost ? html`<span class="amount" style="font-weight:650">${money(e.cost)}</span>` : ''}
        ${can('edit') ? html`<button class="btn ghost sm icon-only" data-ev="${e.id}" aria-label="Editar">${icon('pencil', 'sm')}</button>` : ''}</div>
    </div>`)}</div></section>`;
  }

  on(ctx.el, 'click', '[data-tab]', (e, b) => {
    tab = b.dataset.tab;
    history.replaceState(null, '', `#/mascotas/${id}?tab=${tab}`);
    draw();
  });
  on(ctx.el, 'click', '[data-act=edit]', () => petForm(pet));
  on(ctx.el, 'click', '[data-act=weight]', () => eventForm(pet, null, 'weight'));
  on(ctx.el, 'click', '[data-act=expense]', () => eventForm(pet, null, 'food'));
  on(ctx.el, 'click', '[data-act=event]', () => eventForm(pet));
  on(ctx.el, 'click', '[data-ev]', (e, b) => eventForm(pet, pet.events.find((x) => x.id === Number(b.dataset.ev))));
  const headerEl = document.getElementById('page-actions');
  ctx.onCleanup(on(headerEl, 'click', '[data-act=event]', () => eventForm(pet)));
  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
}

function eventForm(pet, ev = null, presetType = null) {
  if (!can('edit')) return;
  const editing = !!ev;
  const d = { type: presetType || 'vaccine', title: '', date: today(), next_date: '', weight: '', notes: '', cost: null, ...(ev || {}) };
  const body = (type) => {
    let sugg = TITLES[type]?.[pet.species] || TITLES[type]?.any || TITLES[type]?.other || [];
    // La comida que pone su ficha («Pienso Advance Medium Adult…»), la primera.
    if (type === 'food' && pet.food) sugg = [pet.food.split(/[,.;(]/)[0].trim().slice(0, 80), ...sugg].filter((x, i, a) => x && a.indexOf(x) === i);
    return html`<form class="form" id="evf" autocomplete="off">
      <div class="field"><label>¿Qué ha sido?</label>${chipPicker('type', Object.entries(PET_EVENTS).map(([value, x]) => ({ value, label: x.name, emoji: x.emoji })), type, { optional: false })}</div>
      ${type !== 'weight' ? html`<div class="field"><label for="ev-t">Título</label><input class="input" id="ev-t" name="title" value="${d.title}" maxlength="80" list="ev-sug" placeholder="${sugg[0] || 'Descripción'}">
        <datalist id="ev-sug">${sugg.map((x) => html`<option value="${x}">`)}</datalist>
        ${sugg.length ? html`<div class="chips" style="margin-top:4px">${sugg.map((x) => html`<button type="button" class="chip sm" data-title="${x}">${x}</button>`)}</div>` : ''}</div>` : ''}
      ${dateQuick('date', d.date)}
      ${type === 'weight' || d.weight ? html`<div class="field"><label for="ev-w">Peso</label><div class="input-group"><input class="input" id="ev-w" name="weight" inputmode="decimal" value="${d.weight ?? ''}" style="padding-left:13px" placeholder="${pet.weight || ''}"><span class="suffix">kg</span></div></div>` : ''}
      ${type !== 'weight' ? html`
        <div class="field"><label for="ev-n">Próxima vez <span class="muted">(te lo recordaremos)</span></label>
          <input class="input" type="date" id="ev-n" name="next_date" value="${d.next_date || ''}">
          <div class="chips" style="margin-top:4px">${[[30, '+1 mes'], [91, '+3 meses'], [182, '+6 meses'], [365, '+1 año']].map(([n, l]) => html`<button type="button" class="chip sm" data-next="${n}">${l}</button>`)}</div></div>
        <div class="grid-2">
          <div class="field"><label for="ev-c">Coste</label><div class="input-group"><input class="input" id="ev-c" name="cost" inputmode="decimal" value="${amountStr(d.cost)}" placeholder="0,00" style="padding-left:13px"><span class="suffix">€</span></div>
            <span class="hint">Se anota como gasto de ${pet.name}.</span></div>
          ${!editing ? html`<div class="field"><label>Forma de pago</label>${chipPicker('method', methodOptions().filter((m) => ['card', 'cash', 'bizum'].includes(m.value)), 'card')}</div>` : ''}
        </div>` : ''}
      <div class="field"><label for="ev-no">Notas</label><textarea class="textarea" id="ev-no" name="notes" maxlength="1000" placeholder="Lote de la vacuna, dosis, indicaciones…">${d.notes}</textarea></div>
    </form>`;
  };
  const s = sheet({
    title: editing ? 'Editar' : `Anotar para ${pet.name}`,
    body: body(d.type),
    foot: html`${editing ? html`<button class="btn danger icon-only" data-act="del" aria-label="Borrar">${icon('trash-2')}</button>` : ''}<span class="spacer"></span>
      <button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
  });
  const bind = () => {
    const f = $('#evf', s.el);
    bindDateQuick(f);
    focusFirst(f);
    if (d.type === 'weight') focusLater($('#ev-w', f), 80);
  };
  bindPickers(s.body, (name, value) => {
    if (name !== 'type') return;
    const v = readForm($('#evf', s.el));
    Object.assign(d, { type: value, date: v.date, notes: v.notes, title: '' });
    s.body.innerHTML = String(body(value));
    bind();
  });
  on(s.body, 'click', '[data-title]', (e, b) => ($('#ev-t', s.el).value = b.dataset.title));
  on(s.body, 'click', '[data-next]', (e, b) => {
    const base = $('input[name=date]', s.el).value || today();
    $('#ev-n', s.el).value = addDays(base, Number(b.dataset.next));
  });
  on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
    const f = $('#evf', s.el);
    const v = readForm(f);
    const weight = v.weight ? Number(String(v.weight).replace(',', '.')) : null;
    if (v.type === 'weight' && !(weight > 0)) return showFormError(f, 'Escribe el peso');
    const cost = v.cost ? parseAmount(v.cost) : null;
    if (cost !== null && Number.isNaN(cost)) return showFormError(f, 'El coste no es válido');
    const payload = {
      type: v.type, title: v.title || (v.type === 'weight' ? 'Peso' : ''), date: v.date, next_date: v.next_date || null, weight: weight || null,
      notes: v.notes, cost: cost || null, method: v.method || undefined,
    };
    try {
      if (editing) await patch(`/pets/${pet.id}/events/${ev.id}`, payload);
      else await post(`/pets/${pet.id}/events`, payload);
      notifyChange('pets');
      toast(editing ? 'Guardado' : `Anotado${cost ? ` (${money(cost)} añadido a gastos)` : ''}${payload.next_date ? '. Te avisaremos' : ''}`);
      s.close();
    } catch (err) {
      showFormError(f, err.message);
    }
  }));
  on(s.el, 'click', '[data-act=del]', async () => {
    if (!(await confirmDialog({ title: '¿Borrar este registro?', text: ev.cost ? 'También se borrará el gasto asociado.' : '', confirm: 'Borrar', danger: true }))) return;
    try {
      await del(`/pets/${pet.id}/events/${ev.id}`);
      notifyChange('pets');
      s.close();
    } catch (err) {
      toastError(err);
    }
  });
  bind();
}

export function petForm(pet = null) {
  if (!can('edit')) return;
  const editing = !!pet;
  const d = { name: '', species: 'dog', breed: '', sex: '', birth_date: '', color: '#EDA100', chip: '', sterilized: 0, vet: '', vet_phone: '', insurance: '', food: '', notes: '', photo_id: null, ...(pet || {}) };
  let photoId = d.photo_id;
  const s = sheet({
    title: editing ? `Editar a ${pet.name}` : 'Nueva mascota',
    size: 'wide',
    body: html`<form class="form" id="ptf" autocomplete="off">
      <div class="row" style="gap:16px;align-items:center">
        <button type="button" class="pet-photo" data-act="photo" style="--c:${d.color};width:96px;height:96px;border-radius:24px;border:0;aspect-ratio:1;flex:none;cursor:pointer" aria-label="Cambiar foto">
          ${photoId ? html`<img src="${hurl(`/attachments/${photoId}`)}" alt="">` : html`<span class="emoji" style="font-size:calc(44px * var(--fs))">${SPECIES[d.species]?.emoji}</span>`}</button>
        <div class="grow"><div class="field"><label for="pt-n">Nombre</label><input class="input" id="pt-n" name="name" value="${d.name}" required maxlength="40" data-autofocus></div>
          <span class="hint small muted">Toca la imagen para poner una foto.</span></div>
        <input type="file" accept="image/*" hidden data-photo>
      </div>
      <div class="field"><label>Especie</label>${chipPicker('species', Object.entries(SPECIES).map(([value, x]) => ({ value, label: x.name, emoji: x.emoji })), d.species, { optional: false })}</div>
      <div class="grid-3">
        <div class="field"><label for="pt-b">Raza</label><input class="input" id="pt-b" name="breed" value="${d.breed}" maxlength="60"></div>
        <div class="field"><label for="pt-bd">Fecha de nacimiento</label><input class="input" type="date" id="pt-bd" name="birth_date" value="${d.birth_date || ''}"></div>
        <div class="field"><label>Sexo</label>${chipPicker('sex', [{ value: 'f', label: 'Hembra' }, { value: 'm', label: 'Macho' }], d.sex)}</div>
      </div>
      ${!editing ? html`<div class="field" style="max-width:220px"><label for="pt-w">Peso actual</label><div class="input-group"><input class="input" id="pt-w" name="weight" inputmode="decimal" style="padding-left:13px"><span class="suffix">kg</span></div></div>` : ''}
      <div class="field"><label>Color en la app</label>${colorPicker('color', d.color)}</div>
      <div class="grid-2">
        <div class="field"><label for="pt-c">Microchip</label><input class="input" id="pt-c" name="chip" value="${d.chip}" maxlength="30" inputmode="numeric"></div>
        <div class="field" style="justify-content:flex-end"><label class="switch"><input type="checkbox" name="sterilized" ${d.sterilized ? 'checked' : ''}><span class="track"></span><span class="txt">Esterilizado/a</span></label></div>
        <div class="field"><label for="pt-v">Veterinario</label><input class="input" id="pt-v" name="vet" value="${d.vet}" maxlength="80"></div>
        <div class="field"><label for="pt-vp">Teléfono del veterinario</label><input class="input" id="pt-vp" name="vet_phone" value="${d.vet_phone}" maxlength="30" inputmode="tel"></div>
        <div class="field"><label for="pt-i">Seguro</label><input class="input" id="pt-i" name="insurance" value="${d.insurance}" maxlength="80"></div>
        <div class="field"><label for="pt-f">Alimentación</label><input class="input" id="pt-f" name="food" value="${d.food}" maxlength="120"></div>
      </div>
      <div class="field"><label for="pt-no">Notas</label><textarea class="textarea" id="pt-no" name="notes" maxlength="2000" placeholder="Alergias, carácter, cuidados especiales…">${d.notes}</textarea></div>
    </form>`,
    foot: html`${editing ? html`<button class="btn danger" data-act="archive">${icon('archive')}${pet.archived ? 'Recuperar' : 'Archivar'}</button>` : ''}<span class="spacer"></span>
      <button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
  });
  const f = $('#ptf', s.el);
  bindPickers(f, (name, value) => {
    if (name === 'species' && !photoId) $('[data-act=photo] .emoji', f).textContent = SPECIES[value]?.emoji;
    if (name === 'color') $('[data-act=photo]', f).style.setProperty('--c', value);
  });
  focusFirst(f);
  on(f, 'click', '[data-act=photo]', () => $('[data-photo]', f).click());
  $('[data-photo]', f).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const a = await upload(file);
      photoId = a.id;
      $('[data-act=photo]', f).innerHTML = String(html`<img src="${hurl(`/attachments/${a.id}`)}" alt="">`);
    } catch (err) {
      toastError(err);
    }
  });
  on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
    const v = readForm(f);
    if (!v.name.trim()) return showFormError(f, 'Escribe el nombre');
    const payload = { ...v, sex: v.sex || null, birth_date: v.birth_date || null, photo_id: photoId || null, weight: v.weight ? Number(String(v.weight).replace(',', '.')) || undefined : undefined };
    try {
      const r = editing ? await patch(`/pets/${pet.id}`, payload) : await post('/pets', payload);
      await loadHouse();
      notifyChange('pets');
      toast(editing ? 'Ficha guardada' : `¡${v.name} ya es de la familia!`);
      s.close();
      if (!editing) location.hash = `#/mascotas/${r.id}`;
    } catch (err) {
      showFormError(f, err.message);
    }
  }));
  on(s.el, 'click', '[data-act=archive]', async () => {
    try {
      await patch(`/pets/${pet.id}`, { archived: !pet.archived });
      await loadHouse();
      notifyChange('pets');
      s.close();
    } catch (err) {
      toastError(err);
    }
  });
}
