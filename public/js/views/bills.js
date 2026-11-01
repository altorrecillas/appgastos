// Facturas: suministros y recibos con consumo, vencimiento, adjunto y evolución por proveedor.
import { del, get, hurl, patch, post } from '../api.js';
import {
  $, amountStr, confirmDialog, fmtDate, fmtDateFull, html, icon, initials, money, monthShort, num, on, openMenu, parseAmount, pct, plural,
  relDay, sheet, today, toast, toastError, withBusy, skeletonPage,
} from '../ui.js';
import { can, categories } from '../store.js';
import {
  attachmentField, bindAttachment, bindPickers, catPicker, chipPicker, focusFirst, intOrNull, methodOptions, notifyChange, readForm,
  showFormError,
} from '../forms.js';
import { payBill, quickPayBill } from '../actions.js';
import { enableSwipe, swipeRow } from '../gestures.js';
import { catAxis, grid, mountChart, tipBox, tipHTML, valAxis } from '../charts.js';

const UNITS = ['kWh', 'm³', 'GB', 'litros', 'min', 'unidades'];

export default async function billsView(ctx) {
  let bills = [];
  let status = '';
  let supplier = '';
  let metric = 'amount';

  ctx.setHeader('Facturas', '', can('edit') ? html`<button class="btn primary" data-act="new">${icon('plus')}<span class="desktop-only">Registrar factura</span></button>` : '');

  async function load() {
    try {
      bills = await get('/bills');
      if (ctx.isCurrent()) draw();
    } catch (e) {
      toastError(e);
    }
  }

  const supplierStats = () => {
    const map = new Map();
    for (const b of bills) {
      const s = map.get(b.supplier) || { name: b.supplier, items: [], color: b.category_color, icon: b.category_icon };
      s.items.push(b);
      map.set(b.supplier, s);
    }
    return [...map.values()].sort((a, b) => b.items.length - a.items.length);
  };

  function draw() {
    const t = today();
    const year = t.slice(0, 4);
    const pending = bills.filter((b) => b.status === 'pending');
    const overdue = pending.filter((b) => b.overdue);
    const paidYear = bills.filter((b) => b.status === 'paid' && (b.paid_date || b.due_date || '').startsWith(year)).reduce((s, b) => s + b.amount, 0);
    const last12 = bills.filter((b) => (b.period_end || b.issue_date || b.due_date || '') >= `${Number(year) - 1}${t.slice(4)}`);
    const sups = supplierStats();
    const list = bills.filter((b) => (!status || b.status === status) && (!supplier || b.supplier === supplier));

    if (!bills.length) {
      ctx.el.innerHTML = String(html`<div class="empty"><div class="art">🧾</div><h3>Sin facturas registradas</h3>
        <p>Guarda aquí las facturas de luz, agua, gas, teléfono o comunidad: con su consumo, fecha de vencimiento y el PDF.
        Verás cómo evoluciona cada una y te avisaremos antes de que venzan.</p>
        ${can('edit') ? html`<div class="row"><button class="btn primary" data-act="new">${icon('plus')}Registrar factura</button></div>` : ''}</div>`);
      return;
    }
    ctx.el.innerHTML = String(html`
      <section class="stat-strip" style="margin-bottom:18px">
        <div class="stat"><span class="label">Por pagar</span><span class="value">${money(pending.reduce((s, b) => s + b.amount, 0))}</span>
          <span class="delta">${plural(pending.length, 'factura', 'facturas')}</span></div>
        <div class="stat"><span class="label">Vencidas</span><span class="value ${overdue.length ? 'neg' : ''}">${overdue.length}</span>
          <span class="delta ${overdue.length ? 'bad' : ''}">${overdue.length ? money(overdue.reduce((s, b) => s + b.amount, 0)) : 'ninguna'}</span></div>
        <div class="stat"><span class="label">Pagado en ${year}</span><span class="value">${money(paidYear, { decimals: 0 })}</span></div>
        <div class="stat"><span class="label">Media al mes</span><span class="value">${money(last12.reduce((s, b) => s + b.amount, 0) / 12, { decimals: 0 })}</span>
          <span class="delta">últimos 12 meses</span></div>
      </section>
      ${sups.some((s) => s.items.length >= 2) ? html`<div class="section-title"><h2>Evolución por proveedor</h2>
        <div class="actions segmented" data-metric>
          <button data-v="amount" aria-pressed="${metric === 'amount'}">Importe</button><button data-v="consumption" aria-pressed="${metric === 'consumption'}">Consumo</button></div></div>
        <div class="grid cols-2">${sups.filter((s) => s.items.length >= 2).slice(0, 4).map((s, i) => supplierCard(s, i))}</div>` : ''}
      <div class="section-title"><h2>Facturas</h2></div>
      <div class="filters">
        <div class="segmented" data-status>
          <button data-v="" aria-pressed="${!status}">Todas</button>
          <button data-v="pending" aria-pressed="${status === 'pending'}">Pendientes ${pending.length ? html`<span class="badge">${pending.length}</span>` : ''}</button>
          <button data-v="paid" aria-pressed="${status === 'paid'}">Pagadas</button></div>
        <div class="chips scroll" style="flex:1">${sups.map((s) => html`<button class="chip sm" data-sup="${s.name}" aria-pressed="${supplier === s.name}">${s.name}</button>`)}</div>
      </div>
      ${list.length ? html`<div class="panel flush"><div class="rows" style="margin:0">${list.map(row)}</div></div>`
        : html`<div class="empty"><p>No hay facturas con estos filtros.</p></div>`}`);
    drawCharts(sups.filter((s) => s.items.length >= 2).slice(0, 4));
  }

  function supplierCard(s, i) {
    const items = s.items.slice().sort((a, b) => keyDate(a).localeCompare(keyDate(b)));
    const last = items.at(-1);
    const prevYear = items.find((b) => keyDate(b).slice(0, 7) === `${Number(keyDate(last).slice(0, 4)) - 1}${keyDate(last).slice(4, 7)}`);
    const avg = items.reduce((x, b) => x + b.amount, 0) / items.length;
    const unit = items.find((b) => b.unit)?.unit;
    const yoy = prevYear ? (last.amount - prevYear.amount) / prevYear.amount : null;
    return html`<section class="panel"><div class="panel-head" style="margin-bottom:6px">
      <span class="avatar" style="--c:${s.color || 'var(--cobalt)'}">${initials(s.name)}</span>
      <div style="min-width:0"><h2 class="ellipsis">${s.name}</h2><div class="sub">${plural(items.length, 'factura', 'facturas')} · media ${money(avg)}</div></div>
      <div class="actions" style="text-align:right"><div style="font-weight:700;font-size:calc(18px * var(--fs))">${money(last.amount)}</div>
        <div class="tiny ${yoy === null || Math.abs(yoy) < 0.005 ? 'muted' : yoy > 0 ? 'neg' : 'pos'}">${yoy === null ? 'última factura' : Math.abs(yoy) < 0.005 ? 'igual que hace un año' : `${yoy > 0 ? '+' : '−'}${pct(Math.abs(yoy))} que hace un año`}</div></div></div>
      ${metric === 'consumption' && !unit ? html`<p class="small muted" style="padding:40px 0;text-align:center">Sin datos de consumo para este proveedor.</p>`
        : html`<div class="chart short mini-m" id="sup-${i}" role="img" aria-label="Evolución de ${s.name}"></div>`}
    </section>`;
  }
  const keyDate = (b) => b.period_end || b.issue_date || b.due_date || b.created_at.slice(0, 10);

  function drawCharts(sups) {
    sups.forEach((s, i) => {
      const el = $(`#sup-${i}`, ctx.el);
      if (!el) return;
      const items = s.items.slice().sort((a, b) => keyDate(a).localeCompare(keyDate(b))).slice(-14);
      const unit = items.find((b) => b.unit)?.unit || '';
      const vals = items.map((b) => (metric === 'amount' ? b.amount : b.consumption ?? 0));
      mountChart(el, (t) => ({
        animationDuration: 500,
        grid: grid({ top: 8 }),
        tooltip: {
          ...tipBox(t), trigger: 'item',
          formatter: (p) => {
            const b = items[p.dataIndex];
            return tipHTML(b.period_start && b.period_end ? `${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}` : fmtDateFull(keyDate(b)), [
              { color: t.series[0], value: money(b.amount), label: 'importe', box: true },
              ...(b.consumption != null ? [{ color: 'transparent', value: `${num(b.consumption)} ${b.unit}`, label: 'consumo' }] : []),
              ...(b.consumption ? [{ color: 'transparent', value: money(b.amount / b.consumption, { decimals: 3 }), label: `por ${b.unit}` }] : []),
            ]);
          },
        },
        xAxis: catAxis(t, items.map((b) => monthShort(keyDate(b).slice(0, 7)))),
        yAxis: metric === 'amount' ? valAxis(t, { splitNumber: 3 }) : valAxis(t, { splitNumber: 3, axisLabel: { color: t.ink3, fontSize: 11, formatter: (v) => `${num(v, 0)} ${unit}` } }),
        series: [{
          type: 'bar', data: vals.map((v, j) => ({ value: v, itemStyle: { color: items[j].status === 'pending' ? t.saffron : t.series[0] } })),
          barMaxWidth: 18, itemStyle: { borderRadius: [4, 4, 0, 0] },
        }],
      }));
    });
  }

  function row(b) {
    const pill = b.status === 'paid' ? html`<span class="pill paid">Pagada ${b.paid_date ? fmtDate(b.paid_date) : ''}</span>`
      : b.overdue ? html`<span class="pill overdue">Vencida ${relDay(b.due_date).toLowerCase()}</span>`
        : b.due_date ? html`<span class="pill pending">Vence ${relDay(b.due_date).toLowerCase()}</span>` : html`<span class="pill pending">Pendiente</span>`;
    const inner = html`<div class="rowi bill-row">
      ${can('edit') ? (b.status === 'pending'
        ? html`<button class="tick" data-qpay="${b.id}" aria-label="Marcar como pagada: ${b.supplier}"><span>${icon('check')}</span></button>`
        : html`<span class="tick done" aria-hidden="true"><span>${icon('check')}</span></span>`) : ''}
      <span class="avatar lg b-ava" style="--c:${b.category_color || 'var(--cobalt)'};border-radius:14px">${initials(b.supplier)}</span>
      <span class="main-txt"><span class="title">${b.supplier}${b.concept ? html` <span class="muted" style="font-weight:500">${b.concept}</span>` : ''}</span>
        <span class="meta">${b.period_start && b.period_end ? html`<span>${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}</span>` : b.issue_date ? html`<span>Emitida ${fmtDate(b.issue_date)}</span>` : ''}
          ${b.consumption != null ? html`<span class="sep"></span><span>${num(b.consumption)} ${b.unit}</span>` : ''}
          ${b.number ? html`<span class="sep b-num"></span><span class="b-num">Nº ${b.number}</span>` : ''}
          ${b.power && b.status === 'paid' && b.absorbed ? html`<span class="sep"></span><span>${icon('zap', 'sm')} incluye ${money(b.absorbed)} estimados</span>` : ''}
          ${b.power && b.status === 'pending' && b.pending_estimates ? html`<span class="sep"></span><span>${icon('zap', 'sm')} ${money(b.pending_estimates)} ya estimados</span>` : ''}
          <span class="mobile-only" style="display:inline">${pill}</span></span></span>
      <span class="desktop-only">${pill}</span>
      ${b.attachment_id ? html`<a class="btn ghost sm icon-only" href="${hurl(`/attachments/${b.attachment_id}`)}" target="_blank" rel="noopener" aria-label="Ver factura">${icon('paperclip')}</a>` : ''}
      <span class="amount">${money(b.amount)}</span>
      ${can('edit') && b.status === 'pending' ? html`<button class="btn sm b-pay ${b.overdue ? 'primary' : ''}" data-pay="${b.id}">Pagar</button>` : ''}
      ${can('edit') ? html`<button class="btn ghost sm icon-only" data-menu="${b.id}" data-menu-anchor aria-label="Opciones">${icon('ellipsis-vertical')}</button>` : ''}
    </div>`;
    if (!can('edit')) return inner;
    return swipeRow(inner, {
      id: b.id,
      left: b.status === 'pending' ? { icon: 'check', label: 'Pagar', tone: 'green' } : null,
      right: { icon: 'pencil', label: 'Editar', tone: 'blue' },
    });
  }

  // ---------- Formulario ----------
  function form(bill = null) {
    if (!can('edit')) return;
    const editing = !!bill;
    const utilities = categories('expense').find((c) => /luz|agua|gas|suministro/i.test(c.name));
    const d = {
      supplier: '', concept: '', number: '', amount: null, category_id: utilities?.id ?? null, issue_date: today(), due_date: '', period_start: '', period_end: '',
      consumption: '', unit: '', method: 'direct_debit', notes: '', attachment_id: null, status: 'pending', ...(bill || {}),
    };
    const sups = [...new Set(bills.map((b) => b.supplier))];
    const attach = d.attachment_id ? { id: d.attachment_id, name: d.attachment_name || 'Factura', mime: d.attachment_mime || '' } : null;
    const s = sheet({
      title: editing ? 'Editar factura' : 'Registrar factura',
      size: 'wide',
      body: html`<form class="form" id="bf" autocomplete="off">
        <div class="grid-2">
          <div class="field"><label for="bf-s">Proveedor</label><input class="input" id="bf-s" name="supplier" list="bf-sups" value="${d.supplier}" required maxlength="60"
            placeholder="Iberdrola, Canal de Isabel II, Movistar…" data-autofocus><datalist id="bf-sups">${sups.map((x) => html`<option value="${x}">`)}</datalist></div>
          <div class="field"><label for="bf-c">Concepto</label><input class="input" id="bf-c" name="concept" value="${d.concept}" maxlength="80" placeholder="Electricidad, agua, gas…"></div>
        </div>
        <div class="grid-3">
          <div class="field"><label for="bf-a">Importe</label><div class="input-group"><input class="input" id="bf-a" name="amount" inputmode="decimal" value="${amountStr(d.amount)}" placeholder="0,00" style="padding-left:13px;font-weight:650"><span class="suffix">€</span></div></div>
          <div class="field"><label for="bf-i">Fecha de emisión</label><input class="input" type="date" id="bf-i" name="issue_date" value="${d.issue_date || ''}"></div>
          <div class="field"><label for="bf-d">Vence el</label><input class="input" type="date" id="bf-d" name="due_date" value="${d.due_date || ''}"></div>
        </div>
        <div class="grid-3">
          <div class="field"><label for="bf-ps">Periodo desde</label><input class="input" type="date" id="bf-ps" name="period_start" value="${d.period_start || ''}"></div>
          <div class="field"><label for="bf-pe">Periodo hasta</label><input class="input" type="date" id="bf-pe" name="period_end" value="${d.period_end || ''}"></div>
          <div class="field"><label for="bf-q">Consumo</label><div class="row" style="gap:6px">
            <input class="input" id="bf-q" name="consumption" inputmode="decimal" value="${d.consumption ?? ''}" placeholder="245" style="flex:1;min-width:0">
            <select class="select" name="unit" style="width:112px"><option value="">—</option>${UNITS.map((u) => html`<option ${d.unit === u ? 'selected' : ''}>${u}</option>`)}</select></div></div>
        </div>
        <div class="field"><label>Categoría</label>${catPicker('expense', d.category_id)}</div>
        <div class="grid-2">
          <div class="field"><label for="bf-n">Nº de factura</label><input class="input" id="bf-n" name="number" value="${d.number}" maxlength="40" placeholder="Opcional"></div>
          <div class="field"><label>Forma de pago</label>${chipPicker('method', methodOptions().filter((m) => ['direct_debit', 'card', 'transfer', 'cash'].includes(m.value)), d.method, { scroll: true })}</div>
        </div>
        ${attachmentField(attach, { label: 'PDF o foto de la factura' })}
        <label class="switch"><input type="checkbox" name="power" ${d.power || (!editing && d.unit === 'kWh') ? 'checked' : ''}><span class="track"></span>
          <span class="txt">Es la factura de la luz<small>Los consumos de luz estimados de su periodo${d.pending_estimates ? ` (${money(d.pending_estimates)} ahora mismo)` : ''} quedarán dentro de esta factura: solo se añade la diferencia.</small></span></label>
        ${!editing ? html`<label class="switch"><input type="checkbox" name="paid"><span class="track"></span><span class="txt">Ya está pagada<small>Se anotará el gasto en movimientos con la fecha de vencimiento.</small></span></label>` : ''}
        <div class="field"><label for="bf-no">Notas</label><textarea class="textarea" id="bf-no" name="notes" maxlength="1000">${d.notes}</textarea></div>
      </form>`,
      foot: html`${editing ? html`<button class="btn danger icon-only" data-act="del" aria-label="Borrar">${icon('trash-2')}</button>` : ''}
        <span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-act="save">Guardar</button>`,
    });
    const f = $('#bf', s.el);
    bindPickers(f);
    bindAttachment(f);
    focusFirst(f);
    // Se marca sola como factura de la luz si lo parece (solo al crearla).
    const guessPower = () => {
      if (editing) return;
      const txt = `${$('#bf-s', f).value} ${$('#bf-c', f).value}`;
      const unit = $('select[name=unit]', f).value;
      f.elements.power.checked = /luz|electric|eléctric/i.test(txt) || (unit === 'kWh' && !/gas/i.test(txt));
    };
    ['#bf-s', '#bf-c'].forEach((sel) => $(sel, f).addEventListener('input', guessPower));
    $('select[name=unit]', f).addEventListener('change', guessPower);
    // Al escribir un proveedor conocido se completan los datos de su última factura,
    // pero nunca en un campo que la persona ya esté rellenando.
    const fillFromLast = () => {
      if (editing) return;
      const last = bills.find((b) => b.supplier.toLowerCase() === $('#bf-s', f).value.trim().toLowerCase());
      if (!last) return;
      const concept = $('#bf-c', f);
      if (!concept.value && document.activeElement !== concept) concept.value = last.concept;
      const unit = $('select[name=unit]', f);
      if (!unit.value && last.unit) unit.value = last.unit;
      f.elements.power.checked = !!last.power || f.elements.power.checked;
      if (last.category_id && !f.dataset.catTouched) {
        const btn = $(`[data-pick=category_id] [data-v="${last.category_id}"]`, f);
        if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
        delete f.dataset.catTouched;
      }
    };
    $('#bf-s', f).addEventListener('input', fillFromLast);
    $('#bf-s', f).addEventListener('change', fillFromLast);
    f.querySelector('[data-pick=category_id]')?.addEventListener('click', (e) => {
      if (e.isTrusted) f.dataset.catTouched = '1';
    });
    on(s.el, 'click', '[data-act=save]', (e, b) => withBusy(b, async () => {
      const v = readForm(f);
      const amount = parseAmount(v.amount);
      if (!v.supplier.trim()) return showFormError(f, 'Indica el proveedor');
      if (Number.isNaN(amount) || amount < 0) return showFormError(f, 'Escribe el importe de la factura');
      const consumption = v.consumption ? Number(String(v.consumption).replace(',', '.')) : null;
      const payload = {
        supplier: v.supplier, concept: v.concept, number: v.number, amount, category_id: intOrNull(v.category_id), issue_date: v.issue_date || null,
        due_date: v.due_date || null, period_start: v.period_start || null, period_end: v.period_end || null, consumption: Number.isFinite(consumption) ? consumption : null,
        unit: v.unit, method: v.method || null, attachment_id: intOrNull(v.attachment_id), notes: v.notes, power: !!v.power,
      };
      try {
        if (editing) await patch(`/bills/${bill.id}`, payload);
        else await post('/bills', { ...payload, status: v.paid ? 'paid' : 'pending', paid_date: v.due_date || v.issue_date || today() });
        notifyChange('bills');
        toast(editing ? 'Factura guardada' : v.paid ? 'Factura registrada y anotada como gasto' : 'Factura registrada. Te avisaremos antes de que venza.');
        s.close(true);
      } catch (err) {
        showFormError(f, err.message);
      }
    }));
    on(s.el, 'click', '[data-act=del]', () => removeBill(bill, s));
  }

  async function removeBill(b, s) {
    const ok = await confirmDialog({
      title: `¿Borrar la factura de ${b.supplier}?`,
      text: b.status === 'paid' ? 'También se borrará el gasto que se anotó al pagarla.' : 'Esta acción no se puede deshacer.',
      confirm: 'Borrar', danger: true,
    });
    if (!ok) return;
    try {
      await del(`/bills/${b.id}`);
      notifyChange('bills');
      toast('Factura borrada');
      s?.close();
    } catch (e) {
      toastError(e);
    }
  }

  // ---------- Eventos ----------
  const headerEl = document.getElementById('page-actions');
  ctx.onCleanup(on(headerEl, 'click', '[data-act=new]', () => form()));
  on(ctx.el, 'click', '[data-act=new]', () => form());
  on(ctx.el, 'click', '[data-status] [data-v]', (e, b) => {
    status = b.dataset.v;
    draw();
  });
  on(ctx.el, 'click', '[data-metric] [data-v]', (e, b) => {
    metric = b.dataset.v;
    draw();
  });
  on(ctx.el, 'click', '[data-sup]', (e, b) => {
    supplier = supplier === b.dataset.sup ? '' : b.dataset.sup;
    draw();
  });
  on(ctx.el, 'click', '[data-pay]', (e, b) => payBill(bills.find((x) => x.id === Number(b.dataset.pay))));
  on(ctx.el, 'click', '[data-qpay]', (e, b) => {
    b.classList.add('done');
    quickPayBill(bills.find((x) => x.id === Number(b.dataset.qpay)));
  });
  enableSwipe(ctx.el, {
    onSwipe: (el, action) => {
      const bill = bills.find((x) => x.id === Number(el.dataset.sw));
      if (!bill) return;
      if (action === 'left') payBill(bill);
      else form(bill);
    },
  });
  on(ctx.el, 'click', '[data-menu]', (e, b) => {
    const bill = bills.find((x) => x.id === Number(b.dataset.menu));
    openMenu(b, [
      { label: 'Editar', icon: 'pencil', onClick: () => form(bill) },
      ...(bill.attachment_id ? [{ label: 'Descargar adjunto', icon: 'download', onClick: () => window.open(hurl(`/attachments/${bill.attachment_id}?download=1`)) }] : []),
      ...(bill.status === 'paid' ? [{ label: 'Marcar como pendiente', icon: 'rotate-ccw', onClick: async () => {
        try {
          await post(`/bills/${bill.id}/unpay`);
          notifyChange('bills');
          toast('Factura pendiente. Se ha quitado el gasto anotado.');
        } catch (err) {
          toastError(err);
        }
      } }] : []),
      'sep',
      { label: 'Borrar', icon: 'trash-2', danger: true, onClick: () => removeBill(bill) },
    ], { align: 'end' });
  });

  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
  if (ctx.query.new) {
    history.replaceState(null, '', '#/facturas');
    form();
  }
}

