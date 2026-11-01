// Facturas y recibos: luz, agua, gas, teléfono, comunidad… con consumo, vencimiento y adjunto.
import express from 'express';
import { all, insert, one, run, tx, update } from '../db.js';
import { METHODS, bad, formatEuros, idParam, notFound, today, v, validate } from '../util.js';
import { changed } from '../events.js';
import { ensureRef } from './household.js';
import { createTransaction } from './transactions.js';
import { absorbEstimates, billPeriod, isPowerBillGuess, pendingEstimates, releaseEstimates } from '../power.js';

const r = express.Router();

const spec = {
  supplier: [v.str({ required: true, max: 60 }), 'Proveedor'],
  concept: [v.str({ max: 80 }), 'Concepto'],
  number: [v.str({ max: 40 }), 'Número de factura'],
  amount: [v.cents({ required: true }), 'Importe'],
  category_id: [v.int(), 'Categoría'],
  issue_date: [v.date(), 'Fecha de emisión'],
  due_date: [v.date(), 'Vencimiento'],
  period_start: [v.date(), 'Inicio del periodo'],
  period_end: [v.date(), 'Fin del periodo'],
  consumption: [v.num({ min: 0 }), 'Consumo'],
  unit: [v.str({ max: 12 }), 'Unidad'],
  method: [v.oneOf(METHODS), 'Forma de pago'],
  attachment_id: [v.int(), 'Adjunto'],
  notes: [v.str({ max: 1000 }), 'Notas'],
  power: [v.bool(), 'Factura de la luz'],
};

const SELECT = `
  SELECT b.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
         a.name AS attachment_name, a.mime AS attachment_mime,
         (SELECT id FROM transactions t WHERE t.bill_id = b.id AND t.estimate = 0 ORDER BY id DESC LIMIT 1) AS transaction_id,
         (SELECT COALESCE(SUM(amount), 0) FROM transactions t WHERE t.bill_id = b.id AND t.estimate = 1) AS absorbed
    FROM bills b
    LEFT JOIN categories c ON c.id = b.category_id
    LEFT JOIN attachments a ON a.id = b.attachment_id`;

function decorate(b) {
  const out = { ...b, overdue: b.status === 'pending' && !!b.due_date && b.due_date < today() };
  // En una factura de la luz pendiente, cuánto se lleva ya estimado en su periodo.
  if (b.power && b.status === 'pending') {
    const { from, to } = billPeriod(b.household_id, b);
    out.pending_estimates = pendingEstimates(b.household_id, from, to).s;
  }
  return out;
}

function checkRefs(d, hid) {
  ensureRef('categories', d.category_id, hid, 'Categoría');
  ensureRef('attachments', d.attachment_id, hid, 'Adjunto');
  if (d.period_start && d.period_end && d.period_end < d.period_start) throw bad('El periodo termina antes de empezar');
}

// Pagar una factura crea su gasto. En la factura de la luz, los consumos estimados del periodo
// quedan dentro de ella y solo se anota la diferencia, para no contar dos veces.
function payBill(req, bill, { date, method }) {
  let amount = bill.amount;
  let description = [bill.supplier, bill.concept].filter(Boolean).join(' — ');
  if (bill.power) {
    const a = absorbEstimates(req.hid, bill);
    amount = a.rest;
    if (a.estimated) description += ` (incluye ${formatEuros(Math.min(a.estimated, bill.amount), req.household.currency)} ya estimados)`;
  }
  if (amount > 0) {
    createTransaction(req, {
      kind: 'expense', amount, date, description, merchant: bill.supplier, category_id: bill.category_id, method: method || bill.method,
      bill_id: bill.id, attachment_id: bill.attachment_id,
    });
  }
  run(`UPDATE bills SET status = 'paid', paid_date = ?, method = COALESCE(?, method), updated_at = datetime('now') WHERE id = ?`,
    date, method || null, bill.id);
}

// Quita el pago (y libera los consumos estimados que hubiera absorbido).
function unpayBill(hid, billId) {
  run('DELETE FROM transactions WHERE bill_id = ? AND household_id = ? AND estimate = 0', billId, hid);
  releaseEstimates(hid, billId);
}

r.get('/', (req, res) => {
  const where = ['b.household_id = ?'];
  const params = [req.hid];
  if (req.query.status === 'pending' || req.query.status === 'paid') {
    where.push('b.status = ?');
    params.push(req.query.status);
  }
  if (req.query.supplier) {
    where.push('b.supplier = ?');
    params.push(String(req.query.supplier));
  }
  const rows = all(
    `${SELECT} WHERE ${where.join(' AND ')}
      ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(b.due_date, b.issue_date) DESC, b.id DESC`,
    ...params,
  );
  res.json(rows.map(decorate));
});

r.get('/:id', (req, res) => {
  const b = one(`${SELECT} WHERE b.id = ? AND b.household_id = ?`, idParam(req.params.id), req.hid);
  if (!b) throw notFound('Factura');
  res.json(decorate(b));
});

r.post('/', (req, res) => {
  const data = validate(req.body, spec);
  checkRefs(data, req.hid);
  if (req.body.power === undefined) data.power = isPowerBillGuess(data) ? 1 : 0;
  const paid = req.body.status === 'paid';
  const id = tx(() => {
    const newId = insert('bills', { ...data, household_id: req.hid, created_by: req.user.id });
    if (paid) {
      const bill = one('SELECT * FROM bills WHERE id = ?', newId);
      payBill(req, bill, { date: req.body.paid_date || data.due_date || data.issue_date || today(), method: data.method });
    }
    return newId;
  })();
  changed(req, 'bills', 'create', id, `${req.user.display_name} ha registrado una factura de ${data.supplier} (${formatEuros(data.amount, req.household.currency)})`);
  res.status(201).json(decorate(one(`${SELECT} WHERE b.id = ?`, id)));
});

r.patch('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const current = one('SELECT * FROM bills WHERE id = ? AND household_id = ?', id, req.hid);
  if (!current) throw notFound('Factura');
  const data = validate(req.body, spec, { partial: true });
  checkRefs({ ...current, ...data }, req.hid);
  tx(() => {
    update('bills', id, req.hid, data, { touch: true });
    const b = { ...current, ...data };
    // Factura de la luz ya pagada: se rehace el reparto entre lo estimado y lo que falta.
    if (current.status === 'paid' && (current.power || b.power)) {
      unpayBill(req.hid, id);
      payBill(req, b, { date: current.paid_date || today(), method: b.method });
      return;
    }
    // Mantiene el movimiento asociado coherente con la factura.
    if (current.status === 'paid') {
      run(
        `UPDATE transactions SET amount = ?, category_id = ?, merchant = ?, description = ?, attachment_id = ?, updated_at = datetime('now')
          WHERE bill_id = ? AND household_id = ? AND estimate = 0`,
        b.amount, b.category_id, b.supplier, [b.supplier, b.concept].filter(Boolean).join(' — '), b.attachment_id, id, req.hid,
      );
    }
  })();
  changed(req, 'bills', 'update', id, `${req.user.display_name} ha editado la factura de ${data.supplier || current.supplier}`);
  res.json(decorate(one(`${SELECT} WHERE b.id = ?`, id)));
});

r.delete('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const b = one('SELECT * FROM bills WHERE id = ? AND household_id = ?', id, req.hid);
  if (!b) throw notFound('Factura');
  const removeTx = req.query.keep_transaction !== '1';
  tx(() => {
    if (removeTx) run('DELETE FROM transactions WHERE bill_id = ? AND household_id = ? AND estimate = 0', id, req.hid);
    releaseEstimates(req.hid, id);
    run('DELETE FROM bills WHERE id = ?', id);
  })();
  changed(req, 'bills', 'delete', id, `${req.user.display_name} ha borrado la factura de ${b.supplier}`);
  res.json({ ok: true });
});

r.post('/:id/pay', (req, res) => {
  const id = idParam(req.params.id);
  const b = one('SELECT * FROM bills WHERE id = ? AND household_id = ?', id, req.hid);
  if (!b) throw notFound('Factura');
  if (b.status === 'paid') throw bad('Esta factura ya está pagada');
  const body = validate(req.body || {}, { date: [v.date(), 'Fecha'], method: [v.oneOf(METHODS), 'Forma de pago'] });
  tx(() => payBill(req, b, { date: body.date || today(), method: body.method }))();
  changed(req, 'bills', 'pay', id, `${req.user.display_name} ha pagado la factura de ${b.supplier} (${formatEuros(b.amount, req.household.currency)})`);
  res.json(decorate(one(`${SELECT} WHERE b.id = ?`, id)));
});

r.post('/:id/unpay', (req, res) => {
  const id = idParam(req.params.id);
  const b = one('SELECT * FROM bills WHERE id = ? AND household_id = ?', id, req.hid);
  if (!b) throw notFound('Factura');
  tx(() => {
    unpayBill(req.hid, id);
    run(`UPDATE bills SET status = 'pending', paid_date = NULL, updated_at = datetime('now') WHERE id = ?`, id);
  })();
  changed(req, 'bills', 'unpay', id, `${req.user.display_name} ha marcado como pendiente la factura de ${b.supplier}`);
  res.json(decorate(one(`${SELECT} WHERE b.id = ?`, id)));
});

export default r;
