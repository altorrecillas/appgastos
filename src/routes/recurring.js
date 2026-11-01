// Pagos fijos y periódicos (alquiler, seguros, suscripciones, recibos bimestrales…)
// y compras a plazos (un producto que se paga en N cuotas y termina solo).
import express from 'express';
import { all, insert, one, run, tx, update } from '../db.js';
import {
  FREQUENCIES, METHODS, bad, formatEuros, idParam, monthlyEquivalent, nextOccurrence, notFound, today, v, validate,
} from '../util.js';
import { changed, emit } from '../events.js';
import { ensureRef, incomeCheck } from './household.js';
import { createTransaction } from './transactions.js';

const r = express.Router();

const spec = {
  kind: [v.oneOf(['expense', 'income'], { required: true }), 'Tipo'],
  plan: [v.oneOf(['fixed', 'installment']), 'Tipo de pago'],
  name: [v.str({ required: true, max: 60 }), 'Nombre'],
  provider: [v.str({ max: 60 }), 'Proveedor'],
  amount: [v.cents(), 'Importe'],
  variable: [v.bool(), 'Importe variable'],
  category_id: [v.int(), 'Categoría'],
  person_id: [v.int(), 'Persona'],
  pet_id: [v.int(), 'Mascota'],
  method: [v.oneOf(METHODS), 'Forma de pago'],
  frequency: [v.oneOf(FREQUENCIES), 'Frecuencia'],
  start_date: [v.date({ required: true }), 'Primer pago'],
  next_date: [v.date(), 'Próximo pago'],
  end_date: [v.date(), 'Último pago'],
  auto: [v.bool(), 'Anotar automáticamente'],
  remind_days: [v.int({ min: 0, max: 60 }), 'Días de aviso'],
  active: [v.bool(), 'Activo'],
  notes: [v.str({ max: 1000 }), 'Notas'],
  // Compras a plazos
  installments: [v.int({ min: 1, max: 600 }), 'Número de cuotas'],
  total_amount: [v.cents(), 'Precio total'],
  down_payment: [v.cents(), 'Entrada'],
  cash_price: [v.cents(), 'Precio al contado'],
  purchase_date: [v.date(), 'Fecha de compra'],
};

function checkRefs(d, hid) {
  ensureRef('categories', d.category_id, hid, 'Categoría');
  ensureRef('people', d.person_id, hid, 'Persona');
  ensureRef('pets', d.pet_id, hid, 'Mascota');
}

// ---------- Calendario de cuotas ----------

// Fecha de la cuota número n (1 = start_date).
function nthDate(rec, n) {
  let d = rec.start_date;
  for (let i = 1; i < n; i++) d = nextOccurrence(rec.frequency, d, rec.start_date);
  return d;
}

// Número de cuota que corresponde a una fecha del calendario.
export function installmentIndex(rec, date) {
  let d = rec.start_date;
  let k = 1;
  while (d < date && k < 1000) {
    d = nextOccurrence(rec.frequency, d, rec.start_date);
    k++;
  }
  return k;
}

// Primera fecha del calendario igual o posterior a `date`.
function firstOnOrAfter(rec, date) {
  let d = rec.start_date;
  for (let i = 0; i < 2000 && d < date; i++) d = nextOccurrence(rec.frequency, d, rec.start_date);
  return d;
}

const financedOf = (rec) => Math.max((rec.total_amount || 0) - (rec.down_payment || 0), 0);

// Importe de la cuota de una fecha: la última absorbe el redondeo.
export function amountFor(rec, date) {
  if (rec.plan !== 'installment' || !rec.installments) return rec.amount;
  const k = installmentIndex(rec, date);
  if (k >= rec.installments) return financedOf(rec) - rec.amount * (rec.installments - 1);
  return rec.amount;
}

export function labelFor(rec, date) {
  if (rec.plan !== 'installment' || !rec.installments) return rec.name;
  return `${rec.name} (cuota ${Math.min(installmentIndex(rec, date), rec.installments)}/${rec.installments})`;
}

// Fechas de un pago periódico dentro de [from, to], empezando por su próximo pago.
export function occurrences(rec, from, to, max = 400) {
  const out = [];
  let d = rec.next_date;
  for (let i = 0; i < max && d <= to; i++) {
    if (rec.end_date && d > rec.end_date) break;
    if (d >= from) out.push(d);
    d = nextOccurrence(rec.frequency, d, rec.start_date);
  }
  return out;
}

// Calcula cuota y última fecha de una compra a plazos.
function computePlan(d) {
  if (!d.installments) throw bad('Indica en cuántas cuotas se paga');
  if (!d.total_amount || d.total_amount <= 0) throw bad('Indica el precio total');
  const down = d.down_payment || 0;
  if (down >= d.total_amount) throw bad('La entrada no puede ser igual o mayor que el precio total');
  const financed = d.total_amount - down;
  d.amount = Math.round(financed / d.installments);
  d.end_date = nthDate(d, d.installments);
  d.variable = 0;
}

const SELECT = `
  SELECT r.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
         p.name AS person_name, pt.name AS pet_name,
         (SELECT MAX(date) FROM transactions t WHERE t.recurring_id = r.id) AS last_paid,
         (SELECT COUNT(*) FROM transactions t WHERE t.recurring_id = r.id) AS times_paid,
         (SELECT COALESCE(SUM(amount), 0) FROM transactions t WHERE t.recurring_id = r.id) AS total_paid
    FROM recurring r
    LEFT JOIN categories c ON c.id = r.category_id
    LEFT JOIN people p ON p.id = r.person_id
    LEFT JOIN pets pt ON pt.id = r.pet_id`;

export function decorate(row) {
  const out = { ...row, monthly: monthlyEquivalent(row.amount, row.frequency) };
  if (row.plan === 'installment' && row.installments) {
    const financed = financedOf(row);
    // Las cuotas anteriores a la próxima fecha se consideran ya pagadas (o saltadas).
    const done = Math.min(Math.max(installmentIndex(row, row.next_date) - 1, 0), row.installments);
    const paidAmount = done >= row.installments ? financed : done * row.amount;
    Object.assign(out, {
      financed,
      installments_done: done,
      installments_left: row.installments - done,
      remaining: Math.max(financed - paidAmount, 0),
      progress: row.installments ? done / row.installments : 0,
      last_amount: financed - row.amount * (row.installments - 1),
      financing_cost: row.cash_price ? row.total_amount - row.cash_price : null,
      finished: done >= row.installments,
    });
    if (out.finished) out.monthly = 0;
  }
  return out;
}

// Anota los pagos automáticos que ya han vencido. Devuelve cuántos movimientos ha creado.
export function processDue(hid) {
  const t = today();
  const due = all(`SELECT * FROM recurring WHERE household_id = ? AND active = 1 AND auto = 1 AND next_date <= ?`, hid, t);
  let created = 0;
  for (const rec of due) {
    tx(() => {
      let d = rec.next_date;
      let count = 0;
      for (let i = 0; i < 120 && d <= t; i++) {
        if (rec.end_date && d > rec.end_date) break;
        insert('transactions', {
          household_id: hid, kind: rec.kind, amount: amountFor(rec, d), date: d, description: labelFor(rec, d),
          merchant: rec.provider, category_id: rec.category_id, person_id: rec.person_id, pet_id: rec.pet_id,
          method: rec.method, recurring_id: rec.id, created_by: rec.created_by,
        });
        count++;
        d = nextOccurrence(rec.frequency, d, rec.start_date);
      }
      const active = rec.end_date && d > rec.end_date ? 0 : 1;
      run(`UPDATE recurring SET next_date = ?, active = ?, updated_at = datetime('now') WHERE id = ?`, d, active, rec.id);
      if (count) {
        created += count;
        const what = count === 1 ? labelFor(rec, rec.next_date) : `${rec.name} (${count} cuotas)`;
        insert('activity', {
          household_id: hid, user_id: null, action: 'auto', entity: 'recurring', entity_id: rec.id,
          summary: `Pago automático anotado: ${what}`,
        });
      }
      if (!active && rec.plan === 'installment') {
        insert('activity', {
          household_id: hid, user_id: null, action: 'finish', entity: 'recurring', entity_id: rec.id,
          summary: `¡${rec.name} ya está pagado del todo!`,
        });
      }
    })();
  }
  if (created) emit(hid, { entity: 'transactions', action: 'auto', by: null });
  return created;
}

r.get('/', (req, res) => {
  processDue(req.hid);
  const rows = all(`${SELECT} WHERE r.household_id = ? ORDER BY r.active DESC, r.next_date, r.name`, req.hid).map(decorate);
  res.json(rows);
});

r.get('/:id', (req, res) => {
  const row = one(`${SELECT} WHERE r.id = ? AND r.household_id = ?`, idParam(req.params.id), req.hid);
  if (!row) throw notFound('Pago fijo');
  const history = all(
    `SELECT id, date, amount, method, description FROM transactions WHERE recurring_id = ? AND household_id = ? ORDER BY date DESC, id DESC LIMIT 120`,
    row.id, req.hid,
  );
  // Calendario completo de una compra a plazos.
  let schedule = null;
  if (row.plan === 'installment' && row.installments) {
    schedule = [];
    let d = row.start_date;
    for (let k = 1; k <= row.installments; k++) {
      schedule.push({ n: k, date: d, amount: amountFor(row, d), done: d < row.next_date });
      d = nextOccurrence(row.frequency, d, row.start_date);
    }
  }
  res.json({ ...decorate(row), history, schedule });
});

r.post('/', (req, res) => {
  const data = validate(req.body, spec);
  checkRefs(data, req.hid);
  data.plan = data.plan || 'fixed';
  data.frequency = data.frequency || 'monthly';
  if (data.plan === 'installment') {
    computePlan(data);
    data.purchase_date = data.purchase_date || data.start_date;
  } else {
    delete data.installments;
    delete data.total_amount;
    delete data.down_payment;
    delete data.cash_price;
    if (data.amount === null || data.amount === undefined) throw bad('Importe es obligatorio');
  }
  if (data.end_date && data.end_date < data.start_date) throw bad('El último pago no puede ser anterior al primero');
  // Si la compra empezó en el pasado, se puede elegir no anotar las cuotas ya pagadas.
  const includePast = req.body.include_past !== false;
  const t = today();
  data.next_date = data.next_date || (includePast ? data.start_date : firstOnOrAfter(data, t));
  const ended = data.end_date && data.next_date > data.end_date;
  data.active = ended ? 0 : req.body.active === undefined ? 1 : data.active;

  const id = tx(() => {
    const newId = insert('recurring', { ...data, household_id: req.hid, created_by: req.user.id });
    const downDate = data.purchase_date || data.start_date;
    if (data.plan === 'installment' && data.down_payment > 0 && (includePast || downDate >= t)) {
      createTransaction(req, {
        kind: 'expense', amount: data.down_payment, date: downDate, description: `${data.name} (entrada)`,
        merchant: data.provider || '', category_id: data.category_id ?? null, person_id: data.person_id ?? null,
        pet_id: data.pet_id ?? null, method: data.method ?? null, recurring_id: newId,
      });
    }
    return newId;
  })();
  const summary = data.plan === 'installment'
    ? `${req.user.display_name} ha añadido la compra a plazos ${data.name}: ${data.installments} cuotas de ${formatEuros(data.amount, req.household.currency)}`
    : `${req.user.display_name} ha añadido el pago fijo ${data.name}`;
  changed(req, 'recurring', 'create', id, summary);
  processDue(req.hid);
  res.status(201).json(decorate(one(`${SELECT} WHERE r.id = ?`, id)));
});

r.patch('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const current = one('SELECT * FROM recurring WHERE id = ? AND household_id = ?', id, req.hid);
  if (!current) throw notFound('Pago fijo');
  const data = validate(req.body, spec, { partial: true });
  delete data.plan; // el tipo no cambia después de crearlo
  checkRefs(data, req.hid);
  const merged = { ...current, ...data };
  if (current.plan === 'installment') {
    const planKeys = ['installments', 'total_amount', 'down_payment', 'start_date', 'frequency'];
    if (planKeys.some((k) => k in data)) {
      computePlan(merged);
      Object.assign(data, { amount: merged.amount, end_date: merged.end_date, variable: 0 });
      if (('start_date' in data || 'frequency' in data) && !('next_date' in data)) {
        // Recoloca la próxima cuota en el nuevo calendario tras el último pago anotado.
        const last = one(
          `SELECT MAX(date) AS d FROM transactions WHERE recurring_id = ? AND description NOT LIKE '%(entrada)'`, id,
        ).d;
        data.next_date = last ? firstOnOrAfter(merged, last) : merged.start_date;
        if (last && data.next_date === last) data.next_date = nextOccurrence(merged.frequency, last, merged.start_date);
      }
      const nd = data.next_date || current.next_date;
      data.active = nd <= data.end_date ? 1 : 0;
    }
  }
  if (merged.end_date && merged.end_date < merged.start_date) throw bad('El último pago no puede ser anterior al primero');
  update('recurring', id, req.hid, data, { touch: true });
  changed(req, 'recurring', 'update', id, `${req.user.display_name} ha editado ${data.name || current.name}`);
  processDue(req.hid);
  res.json(decorate(one(`${SELECT} WHERE r.id = ?`, id)));
});

r.delete('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const rec = one('SELECT name FROM recurring WHERE id = ? AND household_id = ?', id, req.hid);
  if (!rec) throw notFound('Pago fijo');
  // Los movimientos ya anotados se conservan (pierden el vínculo).
  run('DELETE FROM recurring WHERE id = ?', id);
  changed(req, 'recurring', 'delete', id, `${req.user.display_name} ha borrado ${rec.name}`);
  res.json({ ok: true });
});

// ---------- Nóminas que cambian cada mes ----------
// Desde el día elegido (el 1 por defecto) se pregunta el importe de este mes de cada ingreso fijo con importe variable
// que aún no se ha cobrado ni confirmado. Lo que se conteste es el importe del mes y lo que usan las previsiones.
export function incomeQuestions(hid, household, t = today()) {
  const cfg = incomeCheck(household);
  if (!cfg.enabled || Number(t.slice(8)) < cfg.day) return [];
  const month = t.slice(0, 7);
  return all(
    `${SELECT} WHERE r.household_id = ? AND r.active = 1 AND r.kind = 'income' AND r.variable = 1 AND r.plan = 'fixed'
        AND r.next_date <= ? AND (r.amount_month IS NULL OR r.amount_month <> ?) ORDER BY r.next_date, r.name`,
    hid, `${month}-31`, month,
  ).map((rec) => {
    const last = one('SELECT amount, date FROM transactions WHERE recurring_id = ? ORDER BY date DESC, id DESC LIMIT 1', rec.id);
    return {
      id: rec.id, name: rec.name, provider: rec.provider, person_name: rec.person_name, month, date: rec.next_date, amount: rec.amount,
      previous: last ? { amount: last.amount, date: last.date } : null,
    };
  });
}

// «La nómina de este mes es…»: pasa a ser su importe previsto (y deja de preguntarse este mes).
r.post('/:id/month-amount', (req, res) => {
  const id = idParam(req.params.id);
  const rec = one('SELECT * FROM recurring WHERE id = ? AND household_id = ?', id, req.hid);
  if (!rec) throw notFound('Pago fijo');
  if (rec.kind !== 'income' || !rec.active) throw bad('Solo se puede confirmar el importe de un ingreso fijo activo');
  const { amount } = validate(req.body || {}, { amount: [v.cents({ positive: true, required: true }), 'Importe'] });
  run(`UPDATE recurring SET amount = ?, amount_month = ?, updated_at = datetime('now') WHERE id = ?`, amount, today().slice(0, 7), id);
  changed(req, 'recurring', 'update', id, `${req.user.display_name} ha confirmado ${rec.name} de este mes (${formatEuros(amount, req.household.currency)})`);
  res.json(decorate(one(`${SELECT} WHERE r.id = ?`, id)));
});

// Marca como pagada la cuota pendiente: crea el movimiento y avanza a la siguiente fecha.
r.post('/:id/pay', (req, res) => {
  const id = idParam(req.params.id);
  const rec = one('SELECT * FROM recurring WHERE id = ? AND household_id = ?', id, req.hid);
  if (!rec) throw notFound('Pago fijo');
  if (!rec.active) throw bad('Este pago ya no está activo');
  const body = validate(req.body || {}, {
    amount: [v.cents({ positive: true }), 'Importe'],
    date: [v.date(), 'Fecha'],
    method: [v.oneOf(METHODS), 'Forma de pago'],
  });
  const amount = body.amount ?? amountFor(rec, rec.next_date);
  if (!amount) throw bad('Indica el importe de esta cuota');
  const date = body.date || (rec.next_date <= today() ? rec.next_date : today());
  const label = labelFor(rec, rec.next_date);
  const txId = tx(() => {
    const tid = createTransaction(req, {
      kind: rec.kind, amount, date, description: label, merchant: rec.provider, category_id: rec.category_id,
      person_id: rec.person_id, pet_id: rec.pet_id, method: body.method || rec.method, recurring_id: rec.id,
    });
    const next = nextOccurrence(rec.frequency, rec.next_date, rec.start_date);
    const active = rec.end_date && next > rec.end_date ? 0 : 1;
    // Una nómina que cambia: lo cobrado es la referencia para el mes siguiente.
    const keep = rec.kind === 'income' && rec.variable ? amount : rec.amount;
    run(`UPDATE recurring SET next_date = ?, active = ?, amount = ?, updated_at = datetime('now') WHERE id = ?`, next, active, keep, id);
    return tid;
  })();
  changed(req, 'recurring', 'pay', id, `${req.user.display_name} ha pagado ${label} (${formatEuros(amount, req.household.currency)})`);
  res.json({ ...decorate(one(`${SELECT} WHERE r.id = ?`, id)), transaction_id: txId, previous_next_date: rec.next_date });
});

// Salta la cuota actual sin anotar nada.
r.post('/:id/skip', (req, res) => {
  const id = idParam(req.params.id);
  const rec = one('SELECT * FROM recurring WHERE id = ? AND household_id = ?', id, req.hid);
  if (!rec) throw notFound('Pago fijo');
  if (rec.plan === 'installment') throw bad('Las cuotas de una compra a plazos no se pueden saltar');
  const next = nextOccurrence(rec.frequency, rec.next_date, rec.start_date);
  const active = rec.end_date && next > rec.end_date ? 0 : 1;
  run(`UPDATE recurring SET next_date = ?, active = ?, updated_at = datetime('now') WHERE id = ?`, next, active, id);
  changed(req, 'recurring', 'skip', id, `${req.user.display_name} ha saltado la cuota de ${rec.name}`);
  res.json(decorate(one(`${SELECT} WHERE r.id = ?`, id)));
});

export default r;
