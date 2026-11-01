// Movimientos: lista filtrable agrupada por días, con exportación e importación CSV.
import { del, get, hurl, post } from '../api.js';
import {
  $, $$, METHOD_NAMES, confirmDialog, debounce, download, fmtDateLong, html, icon, money, monthEnd, monthLabelFull, monthStart, on,
  openMenu, plural, sheet, shiftMonth, thisMonth, today, toast, toastError, withBusy,
} from '../ui.js';
import { can, categories, cat, people, pets, store } from '../store.js';
import { deleteTx, notifyChange, openTxForm, pendingTxRows, txRow } from '../forms.js';
import { enableSwipe, gestureHint, swipeRow } from '../gestures.js';
import { catAxis, grid, mountChart, tipBox, tipHTML, valAxis } from '../charts.js';
import { isBankFile, openBankImport } from '../bankimport.js';

const PAGE = 150;

export default async function transactionsView(ctx) {
  const q = ctx.query;
  const f = {
    period: q.period || (q.from || q.to ? 'custom' : 'month'),
    month: /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : thisMonth(),
    from: q.from || '',
    to: q.to || '',
    q: q.q || '',
    kind: q.kind || '',
    category: q.cat || '',
    person: q.person || '',
    method: q.method || '',
    pet: q.pet || '',
    source: q.source || '',
  };
  let items = [];
  let totals = { total: 0, expense: 0, income: 0 };
  let offset = 0;
  let selecting = false;
  const selected = new Set();

  ctx.setHeader('Movimientos', '', html`
    <button class="btn desktop-only" data-act="export">${icon('download')}Exportar</button>
    ${can('edit') ? html`<button class="btn" data-act="import" aria-label="Importar del banco">${icon('upload')}<span class="desktop-only">Importar del banco</span></button>
      <button class="btn soft" data-act="income">${icon('arrow-down-right')}<span class="desktop-only">Ingreso</span></button>` : ''}`);

  const range = () => {
    if (f.period === 'month') return { from: monthStart(f.month), to: monthEnd(f.month) };
    if (f.period === 'year') return { from: `${f.month.slice(0, 4)}-01-01`, to: `${f.month.slice(0, 4)}-12-31` };
    if (f.period === '12m') return { from: monthStart(shiftMonth(thisMonth(), -11)), to: monthEnd(thisMonth()) };
    if (f.period === 'custom') return { from: f.from, to: f.to };
    return { from: '', to: '' };
  };
  const periodLabel = () => {
    if (f.period === 'month') return monthLabelFull(f.month);
    if (f.period === 'year') return `Año ${f.month.slice(0, 4)}`;
    if (f.period === '12m') return 'Últimos 12 meses';
    if (f.period === 'custom') return `${f.from || '…'} → ${f.to || '…'}`;
    return 'Todo el historial';
  };
  const params = (extra = {}) => {
    const r = range();
    const p = new URLSearchParams();
    if (r.from) p.set('from', r.from);
    if (r.to) p.set('to', r.to);
    for (const k of ['q', 'kind', 'category', 'person', 'method', 'pet', 'source']) if (f[k]) p.set(k, f[k]);
    for (const [k, val] of Object.entries(extra)) p.set(k, val);
    return p;
  };
  const syncUrl = () => {
    const p = new URLSearchParams();
    if (f.period !== 'month') p.set('period', f.period);
    if (f.period === 'month' || f.period === 'year') p.set('month', f.month);
    if (f.period === 'custom') {
      if (f.from) p.set('from', f.from);
      if (f.to) p.set('to', f.to);
    }
    for (const [k, key] of [['q', 'q'], ['kind', 'kind'], ['category', 'cat'], ['person', 'person'], ['method', 'method'], ['pet', 'pet'], ['source', 'source']]) {
      if (f[k]) p.set(key, f[k]);
    }
    history.replaceState(null, '', `#/movimientos${p.toString() ? `?${p}` : ''}`);
  };

  async function load(more = false) {
    const list = $('[data-list]', ctx.el);
    list?.classList.add('loading');
    try {
      if (!more) offset = 0;
      const r = await get(`/transactions?${params({ limit: PAGE, offset })}`);
      if (!ctx.isCurrent()) return;
      items = more ? [...items, ...r.items] : r.items;
      totals = r;
      offset = items.length;
      drawResults();
    } catch (e) {
      toastError(e);
    } finally {
      list?.classList.remove('loading');
    }
  }

  function activeChips() {
    const chips = [];
    if (f.category) {
      for (const id of f.category.split(',')) {
        const c = id === 'none' ? { icon: '❔', name: 'Sin categoría' } : cat(Number(id));
        if (c) chips.push({ k: 'category', v: id, label: `${c.icon} ${c.name}` });
      }
    }
    if (f.person) for (const id of f.person.split(',')) {
      const p = store.house.people.find((x) => x.id === Number(id));
      if (p) chips.push({ k: 'person', v: id, label: `${p.emoji} ${p.name}` });
    }
    if (f.method) chips.push({ k: 'method', v: f.method, label: METHOD_NAMES[f.method] });
    if (f.pet) chips.push({ k: 'pet', v: f.pet, label: f.pet === 'any' ? '🐾 Cualquier mascota' : `🐾 ${store.house.pets.find((p) => p.id === Number(f.pet))?.name || ''}` });
    if (f.source) chips.push({ k: 'source', v: f.source, label: { recurring: 'Pagos fijos', bills: 'Facturas', shopping: 'Compras' }[f.source] });
    return chips;
  }

  function drawFrame() {
    ctx.el.innerHTML = String(html`
      <div class="filters">
        <div class="month-nav">
          <button data-act="prev" aria-label="Anterior" ${['month', 'year'].includes(f.period) ? '' : 'disabled'}>${icon('chevron-left')}</button>
          <button class="lbl" data-act="period" data-menu-anchor>${periodLabel()}</button>
          <button data-act="next" aria-label="Siguiente" ${['month', 'year'].includes(f.period) ? '' : 'disabled'}>${icon('chevron-right')}</button>
        </div>
        <div class="input-group">${icon('search')}<input class="input sm" type="search" placeholder="Buscar concepto, comercio, nota…" value="${f.q}" data-q aria-label="Buscar"></div>
        <div class="segmented" data-kind>
          <button data-v="" aria-pressed="${!f.kind}">Todo</button>
          <button data-v="expense" aria-pressed="${f.kind === 'expense'}">Gastos</button>
          <button data-v="income" aria-pressed="${f.kind === 'income'}">Ingresos</button>
        </div>
        <button class="btn sm" data-act="filters" data-menu-anchor>${icon('sliders-horizontal')}Filtros</button>
        ${can('edit') ? html`<button class="btn sm ghost desktop-only" data-act="select">${icon('list-checks')}Seleccionar</button>` : ''}
      </div>
      <div class="chips" data-chips style="margin:-4px 0 14px">${activeChips().map((c) => html`<button class="chip sm" data-rm="${c.k}" data-v="${c.v}">${c.label}${icon('x', 'sm x')}</button>`)}</div>
      <div data-summary></div>
      <div data-pending></div>
      <div data-list></div>`);
  }

  function drawResults() {
    $('[data-pending]', ctx.el).innerHTML = String(pendingTxRows(store.hid));
    const balance = totals.income - totals.expense;
    const r = range();
    const showDaily = f.period === 'month' && totals.total > 0 && f.kind !== 'income';
    $('[data-summary]', ctx.el).innerHTML = String(html`
      <section class="stat-strip compact" style="margin-bottom:16px">
        <div class="stat"><span class="label">Gastos</span><span class="value">${money(totals.expense)}</span></div>
        <div class="stat"><span class="label">Ingresos</span><span class="value pos">${money(totals.income)}</span></div>
        <div class="stat"><span class="label">Balance</span><span class="value ${balance >= 0 ? 'pos' : 'neg'}">${money(balance, { sign: true })}</span></div>
        <div class="stat"><span class="label">Movimientos</span><span class="value">${totals.total.toLocaleString('es-ES')}</span>
          ${totals.total && f.kind !== 'income' && r.from && r.to ? html`<span class="delta">${money(Math.round(totals.expense / Math.max(1, daysIn(r))), { decimals: 0 })} de gasto al día</span>` : ''}</div>
      </section>
      ${showDaily ? html`<section class="panel" style="margin-bottom:8px;padding-bottom:12px"><div class="panel-head" style="margin-bottom:4px"><h2>Gasto diario</h2>
        <span class="sub">${monthLabelFull(f.month)}</span></div><div class="chart short mini-m" id="daily" role="img" aria-label="Gasto por día"></div></section>` : ''}`);

    const groups = [];
    for (const t of items) {
      let g = groups.at(-1);
      if (!g || g.date !== t.date) groups.push((g = { date: t.date, items: [], exp: 0, inc: 0 }));
      g.items.push(t);
      if (t.kind === 'expense') g.exp += t.amount;
      else g.inc += t.amount;
    }
    $('[data-list]', ctx.el).innerHTML = String(items.length ? html`
      ${groups.map((g) => html`<div class="day-group">
        <div class="day-head"><span class="d">${g.date === today() ? 'Hoy' : fmtDateLong(g.date)}</span>
          <span class="t">${g.exp ? `−${money(g.exp)}` : ''}${g.exp && g.inc ? '  ' : ''}${g.inc ? html`<span class="pos">+${money(g.inc)}</span>` : ''}</span></div>
        <div class="rows">${g.items.map(rowFor)}</div></div>`)}
      ${items.length < totals.total ? html`<div class="row" style="justify-content:center;margin-top:16px">
        <button class="btn" data-act="more">Cargar más (${(totals.total - items.length).toLocaleString('es-ES')} restantes)</button></div>` : ''}`
      : html`<div class="empty"><div class="art">🔎</div><h3>No hay movimientos</h3>
        <p>${f.q || activeChips().length || f.kind ? 'Prueba a quitar filtros o a cambiar el periodo.' : `Nada anotado en ${periodLabel().toLowerCase()}.`}</p>
        ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="add">${icon('plus')}Anotar gasto</button></div>` : ''}</div>`);

    if (showDaily) drawDaily();
  }

  // Días transcurridos del periodo (los futuros no cuentan para la media diaria).
  const daysIn = (r) => {
    const end = r.to > today() ? today() : r.to;
    return Math.max(1, Math.round((new Date(end) - new Date(r.from)) / 864e5) + 1);
  };

  async function drawDaily() {
    const days = Number(monthEnd(f.month).slice(8));
    // Gasto diario del periodo (consulta ligera aparte para no depender de la paginación).
    const all = await get(`/stats/calendar?month=${f.month}`).catch(() => null);
    if (!all || !ctx.isCurrent()) return;
    const byDay = new Array(days).fill(0);
    for (const row of all.daily) byDay[Number(row.date.slice(8)) - 1] = row.expense;
    const avg = byDay.reduce((s, x) => s + x, 0) / days;
    mountChart($('#daily', ctx.el), (t) => ({
      animationDuration: 500,
      grid: grid({ top: 8 }),
      tooltip: {
        ...tipBox(t), trigger: 'item',
        formatter: (p) => tipHTML(fmtDateLong(`${f.month}-${String(p.dataIndex + 1).padStart(2, '0')}`), [{ color: t.series[0], value: money(p.value), label: 'gastado', box: true }]),
      },
      xAxis: catAxis(t, byDay.map((_, i) => i + 1), { axisLabel: { color: t.ink3, fontSize: 11, interval: (i) => i === 0 || (i + 1) % 5 === 0 } }),
      yAxis: valAxis(t, { splitNumber: 3 }),
      series: [{
        type: 'bar', data: byDay, barMaxWidth: 16, itemStyle: { color: t.series[0], borderRadius: [3, 3, 0, 0] },
        emphasis: { itemStyle: { color: t.cobalt } },
        markLine: {
          symbol: 'none', silent: true, data: [{ yAxis: avg }], lineStyle: { color: t.ink3, width: 1, type: 'solid' },
          label: { formatter: `Media ${money(avg, { decimals: 0 })}`, color: t.ink3, fontSize: 11, position: 'insideEndTop' },
        },
      }],
    })).then((inst) => {
      inst?.off('click');
      inst?.on('click', (p) => {
        f.period = 'custom';
        f.from = f.to = `${f.month}-${String(p.dataIndex + 1).padStart(2, '0')}`;
        refreshAll();
      });
    });
  }

  function refreshAll() {
    syncUrl();
    drawFrame();
    load();
  }

  // ---------- Filtros ----------
  on(ctx.el, 'click', '[data-act=prev], [data-act=next]', (e, b) => {
    const dir = b.dataset.act === 'prev' ? -1 : 1;
    f.month = f.period === 'year' ? `${Number(f.month.slice(0, 4)) + dir}-${f.month.slice(5)}` : shiftMonth(f.month, dir);
    refreshAll();
  });
  on(ctx.el, 'click', '[data-act=period]', (e, b) => {
    const set = (period, extra = {}) => () => {
      Object.assign(f, { period, ...extra });
      refreshAll();
    };
    openMenu(b, [
      { label: 'Este mes', checked: f.period === 'month' && f.month === thisMonth(), onClick: set('month', { month: thisMonth() }) },
      { label: 'Mes pasado', checked: f.period === 'month' && f.month === shiftMonth(thisMonth(), -1), onClick: set('month', { month: shiftMonth(thisMonth(), -1) }) },
      { label: 'Este año', checked: f.period === 'year', onClick: set('year', { month: thisMonth() }) },
      { label: 'Últimos 12 meses', checked: f.period === '12m', onClick: set('12m') },
      { label: 'Todo el historial', checked: f.period === 'all', onClick: set('all') },
      'sep',
      { label: 'Elegir fechas…', icon: 'calendar-days', onClick: () => customRange() },
    ]);
  });
  function customRange() {
    const s = sheet({
      title: 'Elegir fechas',
      size: 'narrow',
      body: html`<form class="form" id="rg"><div class="grid-2 keep">
        <div class="field"><label for="rg-f">Desde</label><input class="input" type="date" id="rg-f" value="${f.from || monthStart(f.month)}"></div>
        <div class="field"><label for="rg-t">Hasta</label><input class="input" type="date" id="rg-t" value="${f.to || today()}"></div></div></form>`,
      foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" form="rg">Aplicar</button>`,
    });
    $('#rg', s.el).addEventListener('submit', (e) => {
      e.preventDefault();
      f.period = 'custom';
      f.from = $('#rg-f', s.el).value;
      f.to = $('#rg-t', s.el).value;
      s.close();
      refreshAll();
    });
  }
  const searchNow = debounce(() => {
    syncUrl();
    load();
  }, 280);
  on(ctx.el, 'input', '[data-q]', (e, input) => {
    f.q = input.value.trim();
    searchNow();
  });
  on(ctx.el, 'click', '[data-kind] [data-v]', (e, b) => {
    f.kind = b.dataset.v;
    $$('[data-kind] [data-v]', ctx.el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    syncUrl();
    load();
  });
  on(ctx.el, 'click', '[data-rm]', (e, b) => {
    const k = b.dataset.rm;
    f[k] = f[k].split(',').filter((x) => x !== b.dataset.v).join(',');
    refreshAll();
  });
  on(ctx.el, 'click', '[data-act=filters]', (e, b) => filtersSheet());

  function filtersSheet() {
    const selCats = new Set(f.category.split(',').filter(Boolean));
    const selPeople = new Set(f.person.split(',').filter(Boolean));
    const catBtn = (c) => html`<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${selCats.has(String(c.id))}"><span class="emoji">${c.icon}</span>${c.name}</button>`;
    const s = sheet({
      title: 'Filtros',
      body: html`<div class="stack" style="gap:20px">
        <div class="field"><label>Categorías de gasto</label><div class="chips">${categories('expense').map(catBtn)}
          <button type="button" class="chip" data-cat="none" aria-pressed="${selCats.has('none')}">❔ Sin categoría</button></div></div>
        <div class="field"><label>Categorías de ingreso</label><div class="chips">${categories('income').map(catBtn)}</div></div>
        ${people().length ? html`<div class="field"><label>Personas</label><div class="chips">${people().map((p) => html`<button type="button" class="chip" data-person="${p.id}"
          aria-pressed="${selPeople.has(String(p.id))}"><span class="emoji">${p.emoji}</span>${p.name}</button>`)}</div></div>` : ''}
        <div class="field"><label>Forma de pago</label><div class="chips">${Object.entries(METHOD_NAMES).map(([k, v]) => html`<button type="button" class="chip" data-method="${k}" aria-pressed="${f.method === k}">${v}</button>`)}</div></div>
        ${pets().length ? html`<div class="field"><label>Mascotas</label><div class="chips">
          <button type="button" class="chip" data-pet="any" aria-pressed="${f.pet === 'any'}">🐾 Cualquiera</button>
          ${pets().map((p) => html`<button type="button" class="chip" data-pet="${p.id}" aria-pressed="${f.pet === String(p.id)}">${p.name}</button>`)}</div></div>` : ''}
        <div class="field"><label>Origen</label><div class="chips">${[['recurring', 'Pagos fijos y plazos'], ['bills', 'Facturas'], ['shopping', 'Lista de la compra']].map(([k, v]) => html`<button type="button" class="chip" data-source="${k}" aria-pressed="${f.source === k}">${v}</button>`)}</div></div>
      </div>`,
      foot: html`<button class="btn ghost" data-act="clear">Quitar filtros</button><span class="spacer"></span><button class="btn primary" data-act="apply">Ver resultados</button>`,
    });
    const toggle = (b) => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    const single = (attr) => on(s.el, 'click', `[data-${attr}]`, (e, b) => {
      const was = b.getAttribute('aria-pressed') === 'true';
      $$(`[data-${attr}]`, s.el).forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', String(!was));
    });
    on(s.el, 'click', '[data-cat], [data-person]', (e, b) => toggle(b));
    single('method');
    single('pet');
    single('source');
    on(s.el, 'click', '[data-act=clear]', () => {
      $$('[aria-pressed=true]', s.body).forEach((b) => b.setAttribute('aria-pressed', 'false'));
    });
    on(s.el, 'click', '[data-act=apply]', () => {
      const pressed = (attr) => $$(`[data-${attr}][aria-pressed=true]`, s.el).map((b) => b.dataset[attr]);
      f.category = pressed('cat').join(',');
      f.person = pressed('person').join(',');
      f.method = pressed('method')[0] || '';
      f.pet = pressed('pet')[0] || '';
      f.source = pressed('source')[0] || '';
      s.close();
      refreshAll();
    });
  }

  // ---------- Filas deslizables y selección múltiple ----------
  function rowFor(t) {
    const row = html`<div aria-selected="${selected.has(t.id)}">${txRow(t)}</div>`;
    if (!can('edit') || t.estimate) return row;
    return swipeRow(row, {
      id: t.id,
      left: { icon: 'copy', label: 'Repetir hoy', tone: 'green' },
      right: { icon: 'trash-2', label: 'Borrar', tone: 'red' },
    });
  }
  function selbar() {
    let bar = $('.selbar', ctx.el);
    if (!selecting) return bar?.remove();
    const chosen = items.filter((t) => selected.has(t.id));
    const sum = chosen.reduce((s, t) => s + (t.kind === 'expense' ? -t.amount : t.amount), 0);
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'selbar';
      ctx.el.append(bar);
    }
    bar.innerHTML = String(html`<span class="t">${plural(selected.size, 'seleccionado', 'seleccionados')}<br><span class="tiny" style="opacity:.75">${money(sum, { sign: true })}</span></span>
      <button class="btn sm" data-bulk="category" data-menu-anchor>${icon('tag', 'sm')}Categoría</button>
      ${people().length ? html`<button class="btn sm" data-bulk="person" data-menu-anchor>${icon('user', 'sm')}Persona</button>` : ''}
      <button class="btn sm danger" data-bulk="delete">${icon('trash-2', 'sm')}Borrar</button>
      <button class="btn sm icon-only" data-bulk="cancel" aria-label="Terminar selección">${icon('x', 'sm')}</button>`);
  }
  function setSelecting(on_, id) {
    selecting = on_;
    selected.clear();
    if (on_ && id) selected.add(id);
    $('[data-list]', ctx.el)?.classList.toggle('selecting', selecting);
    $$('[data-list] [aria-selected]', ctx.el).forEach((x) => x.setAttribute('aria-selected', String(selected.has(Number(x.closest('.sw')?.dataset.sw || x.querySelector('[data-tx]')?.dataset.tx)))));
    selbar();
  }
  function toggle(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    const row = $(`[data-tx="${id}"]`, ctx.el)?.parentElement;
    row?.setAttribute('aria-selected', String(selected.has(id)));
    if (!selected.size) setSelecting(false);
    else selbar();
  }
  enableSwipe(ctx.el, {
    destructive: { right: true },
    onSwipe: async (el, action) => {
      const t = items.find((x) => x.id === Number(el.dataset.sw));
      if (!t) return;
      if (action === 'right') {
        try {
          await deleteTx(t);
        } catch (err) {
          toastError(err);
          load();
        }
        return;
      }
      // Repetir hoy: mismo concepto, importe y categoría con la fecha de hoy.
      const keep = ['kind', 'amount', 'description', 'merchant', 'category_id', 'person_id', 'pet_id', 'method', 'notes'];
      const copy = { ...Object.fromEntries(keep.map((k) => [k, t[k] ?? null])), date: today() };
      try {
        const saved = await post('/transactions', copy);
        notifyChange('transactions');
        toast(`Repetido hoy: ${t.description || t.merchant} (${money(t.amount)})`, {
          iconName: 'copy',
          action: { label: 'Deshacer', fn: async () => {
            await del(`/transactions/${saved.id}`);
            notifyChange('transactions');
          } },
        });
      } catch (err) {
        toastError(err);
      }
    },
    onLongPress: (el) => setSelecting(true, Number(el.dataset.sw)),
  });
  on(ctx.el, 'click', '[data-act=select]', () => setSelecting(!selecting));
  on(ctx.el, 'click', '[data-bulk]', async (e, b) => {
    const action = b.dataset.bulk;
    const ids = [...selected];
    if (action === 'cancel') return setSelecting(false);
    const run = async (body, msg) => {
      try {
        const r = await post('/transactions/bulk', { ids, ...body });
        setSelecting(false);
        notifyChange('transactions');
        toast(r.skipped ? `${msg} (${r.skipped} no se podían cambiar)` : msg);
      } catch (err) {
        toastError(err);
      }
    };
    if (action === 'delete') {
      if (!(await confirmDialog({ title: `¿Borrar ${plural(ids.length, 'movimiento', 'movimientos')}?`, text: 'No se puede deshacer.', confirm: 'Borrar', danger: true }))) return;
      return run({ action: 'delete' }, `${plural(ids.length, 'movimiento borrado', 'movimientos borrados')}`);
    }
    if (action === 'category') {
      const kinds = new Set(items.filter((t) => selected.has(t.id)).map((t) => t.kind));
      const opts = categories(kinds.size === 1 ? [...kinds][0] : 'expense');
      return openMenu(b, opts.map((c) => ({ label: `${c.icon}  ${c.name}`, onClick: () => run({ action: 'update', data: { category_id: c.id } }, `Categoría cambiada a ${c.name}`) })));
    }
    if (action === 'person') {
      return openMenu(b, [...people().map((p) => ({ label: `${p.emoji}  ${p.name}`, onClick: () => run({ action: 'update', data: { person_id: p.id } }, `Asignados a ${p.name}`) })),
        { label: 'Sin persona', onClick: () => run({ action: 'update', data: { person_id: null } }, 'Persona quitada') }]);
    }
  });

  // ---------- Acciones ----------
  on(ctx.el, 'click', '[data-tx]', (e, b) => {
    const id = Number(b.dataset.tx);
    if (selecting) return toggle(id);
    const t = items.find((x) => x.id === id);
    if (t) openTxForm({ tx: t });
  });
  on(ctx.el, 'click', '[data-act=more]', (e, b) => withBusy(b, () => load(true)));
  const header = document.getElementById('page-actions');
  const offHeader = on(header, 'click', '[data-act]', (e, b) => {
    if (b.dataset.act === 'export') download(hurl(`/transactions/export.csv?${params()}`));
    if (b.dataset.act === 'import') openBankImport();
    if (b.dataset.act === 'income') openTxForm({ kind: 'income' });
  });
  ctx.onCleanup(offHeader);

  // Soltar el extracto del banco encima de la lista también lo importa.
  if (can('edit')) {
    on(ctx.el, 'dragover', '*', (e) => {
      if ([...(e.dataTransfer?.items || [])].some((it) => it.kind === 'file')) {
        e.preventDefault();
        ctx.el.classList.add('drop-on');
      }
    });
    on(ctx.el, 'dragleave', '*', (e) => {
      if (!ctx.el.contains(e.relatedTarget)) ctx.el.classList.remove('drop-on');
    });
    on(ctx.el, 'drop', '*', (e) => {
      const file = e.dataTransfer?.files?.[0];
      ctx.el.classList.remove('drop-on');
      if (!file) return;
      e.preventDefault();
      if (isBankFile(file)) openBankImport(file);
      else toastError(new Error('Suelta aquí el extracto del banco en CSV, XLS, XLSX u ODS'));
    });
  }

  ctx.setRefresh(() => (selecting ? null : load()));
  drawFrame();
  await load();
  if (items.length && can('edit')) gestureHint($('[data-list]', ctx.el), 'tx', 'Desliza → para repetirlo hoy · ← para borrarlo');
}
