// Acciones rápidas que se lanzan desde varias pantallas: pagar una cuota o una factura.
import { del, get, patch, post } from './api.js';
import { $, fmtDateLong, html, icon, money, on, parseAmount, sheet, today, toast, withBusy, focusLater } from './ui.js';
import {
  amountField, bindAmount, bindDateQuick, bindPickers, chipPicker, dateQuick, methodOptions, notifyChange, readForm, showFormError,
} from './forms.js';
import { can } from './store.js';

// Pagar la cuota pendiente de un pago fijo o de una compra a plazos.
export function payRecurring(item) {
  if (!can('edit')) return toast('Tu rol en este hogar es de solo lectura', { type: 'err' });
  const due = item.date || item.next_date;
  const date = due && due < today() ? due : today();
  const s = sheet({
    title: item.kind === 'income' ? 'Marcar como cobrado' : 'Marcar como pagado',
    size: 'narrow',
    body: html`<form class="form" id="payf">
      <div class="row"><div class="grow"><div style="font-weight:650;font-size:calc(17px * var(--fs))">${item.title || item.name}</div>
        <div class="small muted">${due ? `Tocaba el ${fmtDateLong(due).toLowerCase()}` : ''}</div></div></div>
      ${amountField('amount', item.amount, { kind: item.kind })}
      ${item.variable ? html`<p class="small muted" style="text-align:center;margin-top:-8px">Importe variable: escribe lo que ha llegado esta vez.</p>` : ''}
      ${dateQuick('date', date, { label: 'Fecha del pago' })}
      ${item.kind !== 'income' ? html`<div class="field"><label>Forma de pago</label>${chipPicker('method', methodOptions(), item.method || 'direct_debit', { scroll: true })}</div>` : ''}
    </form>`,
    foot: html`${item.plan === 'installment' || item.type === 'installment' ? '' : html`<button class="btn ghost" data-act="skip">${icon('skip-forward')}Saltar esta cuota</button>`}<span class="spacer"></span>
      <button class="btn success" data-act="pay">${icon('check')}${item.kind === 'income' ? 'Cobrado' : 'Pagado'}</button>`,
  });
  const form = $('#payf', s.el);
  bindAmount(form);
  bindDateQuick(form);
  bindPickers(form);
  const id = item.ref || item.id;
  on(s.el, 'click', '[data-act=pay]', (e, b) =>
    withBusy(b, async () => {
      const v = readForm(form);
      const amount = parseAmount(v.amount);
      if (Number.isNaN(amount) || amount <= 0) return showFormError(form, 'Escribe el importe');
      try {
        await post(`/recurring/${id}/pay`, { amount, date: v.date, method: v.method || undefined });
        notifyChange('recurring');
        toast(`${item.title || item.name}: ${money(amount)} anotado`);
        s.close(true);
      } catch (err) {
        showFormError(form, err.message);
      }
    }));
  on(s.el, 'click', '[data-act=skip]', (e, b) =>
    withBusy(b, async () => {
      try {
        await post(`/recurring/${id}/skip`);
        notifyChange('recurring');
        toast('Cuota saltada. No se ha anotado ningún gasto.');
        s.close(true);
      } catch (err) {
        showFormError(form, err.message);
      }
    }));
  return s.done;
}

export function payBill(bill) {
  if (!can('edit')) return toast('Tu rol en este hogar es de solo lectura', { type: 'err' });
  const s = sheet({
    title: 'Pagar factura',
    size: 'narrow',
    body: html`<form class="form" id="pbf">
      <div><div style="font-weight:650;font-size:calc(17px * var(--fs))">${bill.supplier || bill.title}</div>
        <div class="small muted">${bill.concept || bill.subtitle || ''}</div></div>
      <div style="font-size:calc(40px * var(--fs));font-weight:720;font-stretch:80%;text-align:center">${money(bill.amount)}</div>
      ${dateQuick('date', today(), { label: 'Fecha del pago' })}
      <div class="field"><label>Forma de pago</label>${chipPicker('method', methodOptions(), bill.method || 'direct_debit', { scroll: true })}</div>
    </form>`,
    foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button>
      <button class="btn success" data-act="pay">${icon('check')}Pagada</button>`,
  });
  const form = $('#pbf', s.el);
  bindDateQuick(form);
  bindPickers(form);
  on(s.el, 'click', '[data-act=pay]', (e, b) =>
    withBusy(b, async () => {
      const v = readForm(form);
      try {
        await post(`/bills/${bill.ref || bill.id}/pay`, { date: v.date, method: v.method || undefined });
        notifyChange('bills');
        toast('Factura pagada y anotada en movimientos');
        s.close(true);
      } catch (err) {
        showFormError(form, err.message);
      }
    }));
  return s.done;
}

// Añadir productos a la lista de la compra desde cualquier pantalla.
export async function quickShopping() {
  if (!can('edit')) return toast('Tu rol en este hogar es de solo lectura', { type: 'err' });
  let lists = [];
  try {
    lists = (await get('/shopping/lists')).filter((l) => l.status === 'active');
  } catch (e) {
    return toast(e.message, { type: 'err' });
  }
  if (!lists.length) return toast('Crea primero una lista en «Lista de la compra»', { type: 'err' });
  let listId = lists[0].id;
  const added = [];
  const s = sheet({
    title: 'Añadir a la compra',
    body: html`<div class="stack" style="gap:14px">
      ${lists.length > 1 ? html`<div class="chips" data-lists>${lists.map((l) => html`<button type="button" class="chip" data-l="${l.id}" aria-pressed="${l.id === listId}">${l.icon} ${l.name}</button>`)}</div>` : ''}
      <form class="add-item" data-q style="position:static">
        <input class="input" name="name" placeholder="Leche, pan, 2 kg naranjas…" autocomplete="off" enterkeyhint="send" aria-label="Producto">
        <button class="btn primary" type="submit" aria-label="Añadir">${icon('plus')}</button></form>
      <div class="sugs" data-sugs></div>
      <div class="small pos" data-added></div>
    </div>`,
    foot: html`<a class="btn ghost" href="#/compra" data-close>Ver la lista</a><span class="spacer"></span><button class="btn primary" data-close>Hecho</button>`,
  });
  const input = $('[data-q] input', s.el);
  const loadSugs = async () => {
    const sugs = await get(`/shopping/suggestions?list=${listId}`).catch(() => []);
    $('[data-sugs]', s.el).innerHTML = String(html`${sugs.slice(0, 12).map((x) => html`<button type="button" class="chip" data-sug="${x.name}">${icon('plus')}${x.name}</button>`)}`);
  };
  const add = async (text) => {
    if (!text.trim()) return;
    try {
      await post(`/shopping/lists/${listId}/items`, { name: text });
      added.push(...text.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean));
      $('[data-added]', s.el).textContent = `Añadido: ${added.join(', ')}`;
      notifyChange('shopping');
      loadSugs();
    } catch (e) {
      toast(e.message, { type: 'err' });
    }
  };
  $('[data-q]', s.el).addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    input.value = '';
    add(v);
    input.focus();
  });
  on(s.el, 'click', '[data-sug]', (e, b) => add(b.dataset.sug));
  on(s.el, 'click', '[data-l]', (e, b) => {
    listId = Number(b.dataset.l);
    s.el.querySelectorAll('[data-l]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadSugs();
  });
  loadSugs();
  focusLater(input, 80);
}

// Pagar con un toque (importe y fecha por defecto) y opción de deshacer.
export async function quickPayRecurring(rec) {
  if (!can('edit')) return;
  if (rec.variable) return payRecurring({ ...rec, title: rec.name });
  try {
    const r = await post(`/recurring/${rec.id}/pay`, {});
    notifyChange('recurring');
    toast(`${rec.name}: ${money(rec.installments_left === 1 ? rec.last_amount : rec.amount)} anotado`, {
      action: { label: 'Deshacer', fn: async () => {
        await del(`/transactions/${r.transaction_id}`);
        await patch(`/recurring/${rec.id}`, { next_date: r.previous_next_date, active: 1 });
        notifyChange('recurring');
      } },
    });
  } catch (e) {
    toast(e.message, { type: 'err' });
  }
}

export async function quickPayBill(bill) {
  if (!can('edit')) return;
  try {
    await post(`/bills/${bill.id}/pay`, {});
    notifyChange('bills');
    toast(`Factura de ${bill.supplier} pagada (${money(bill.amount)})`, {
      action: { label: 'Deshacer', fn: async () => {
        await post(`/bills/${bill.id}/unpay`);
        notifyChange('bills');
      } },
    });
  } catch (e) {
    toast(e.message, { type: 'err' });
  }
}
