// Mascotas: ficha, vacunas y desparasitaciones con recordatorio, peso y gastos.
import express from 'express';
import { all, insert, one, run, tx, update } from '../db.js';
import { METHODS, bad, formatEuros, idParam, notFound, today, v, validate } from '../util.js';
import { changed } from '../events.js';
import { ensureRef } from './household.js';
import { createTransaction } from './transactions.js';

const r = express.Router();

export const SPECIES = ['dog', 'cat', 'bird', 'fish', 'rabbit', 'rodent', 'reptile', 'horse', 'other'];
export const EVENT_TYPES = ['vaccine', 'deworming', 'vet', 'grooming', 'medication', 'weight', 'other'];
const EVENT_NAMES = {
  vaccine: 'Vacuna', deworming: 'Desparasitación', vet: 'Veterinario', grooming: 'Peluquería', medication: 'Medicación', weight: 'Peso', other: 'Otro',
};

const petSpec = {
  name: [v.str({ required: true, max: 40 }), 'Nombre'],
  species: [v.oneOf(SPECIES, { required: true }), 'Especie'],
  breed: [v.str({ max: 60 }), 'Raza'],
  sex: [v.oneOf(['m', 'f']), 'Sexo'],
  birth_date: [v.date(), 'Fecha de nacimiento'],
  color: [v.color(), 'Color'],
  chip: [v.str({ max: 30 }), 'Microchip'],
  sterilized: [v.bool(), 'Esterilizado'],
  vet: [v.str({ max: 80 }), 'Veterinario'],
  vet_phone: [v.str({ max: 30 }), 'Teléfono del veterinario'],
  insurance: [v.str({ max: 80 }), 'Seguro'],
  food: [v.str({ max: 120 }), 'Alimentación'],
  notes: [v.str({ max: 2000 }), 'Notas'],
  photo_id: [v.int(), 'Foto'],
  archived: [v.bool(), 'Archivada'],
};

const eventSpec = {
  type: [v.oneOf(EVENT_TYPES, { required: true }), 'Tipo'],
  title: [v.str({ max: 80 }), 'Título'],
  date: [v.date({ required: true }), 'Fecha'],
  next_date: [v.date(), 'Próxima fecha'],
  weight: [v.num({ min: 0, max: 2000 }), 'Peso'],
  notes: [v.str({ max: 1000 }), 'Notas'],
};

// Recordatorios: eventos con próxima fecha que no tienen un evento posterior del mismo tipo y título.
export function petReminders(hid, untilDate) {
  return all(
    `SELECT e.id, e.pet_id, e.type, e.title, e.date, e.next_date, p.name AS pet_name, p.species, p.color AS pet_color
       FROM pet_events e JOIN pets p ON p.id = e.pet_id
      WHERE e.household_id = ? AND p.archived = 0 AND e.next_date IS NOT NULL AND e.next_date <= ?
        AND NOT EXISTS (
          SELECT 1 FROM pet_events e2 WHERE e2.pet_id = e.pet_id AND e2.type = e.type
             AND lower(e2.title) = lower(e.title) AND (e2.date > e.date OR (e2.date = e.date AND e2.id > e.id)))
      ORDER BY e.next_date`,
    hid, untilDate,
  );
}

const PET_SELECT = `
  SELECT p.*,
         (SELECT COALESCE(SUM(amount), 0) FROM transactions t WHERE t.pet_id = p.id AND t.kind = 'expense') AS total_spent,
         (SELECT COALESCE(SUM(amount), 0) FROM transactions t WHERE t.pet_id = p.id AND t.kind = 'expense'
             AND t.date >= date('now', 'localtime', 'start of year')) AS spent_year,
         (SELECT weight FROM pet_events e WHERE e.pet_id = p.id AND e.weight IS NOT NULL ORDER BY e.date DESC, e.id DESC LIMIT 1) AS weight
    FROM pets p`;

r.get('/', (req, res) => {
  const pets = all(`${PET_SELECT} WHERE p.household_id = ? ORDER BY p.archived, p.name`, req.hid);
  const reminders = petReminders(req.hid, '9999-12-31');
  res.json(pets.map((p) => ({ ...p, reminders: reminders.filter((x) => x.pet_id === p.id) })));
});

r.get('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const pet = one(`${PET_SELECT} WHERE p.id = ? AND p.household_id = ?`, id, req.hid);
  if (!pet) throw notFound('Mascota');
  pet.events = all(
    `SELECT e.*, t.amount AS cost, u.display_name AS created_by_name FROM pet_events e
       LEFT JOIN transactions t ON t.id = e.transaction_id LEFT JOIN users u ON u.id = e.created_by
      WHERE e.pet_id = ? ORDER BY e.date DESC, e.id DESC`,
    id,
  );
  pet.reminders = petReminders(req.hid, '9999-12-31').filter((x) => x.pet_id === id);
  pet.expenses = all(
    `SELECT t.id, t.date, t.amount, t.description, t.merchant, c.name AS category_name, c.icon AS category_icon
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.pet_id = ? AND t.household_id = ? AND t.kind = 'expense' ORDER BY t.date DESC LIMIT 100`,
    id, req.hid,
  );
  pet.monthly = all(
    `SELECT substr(date, 1, 7) AS month, SUM(amount) AS total FROM transactions
      WHERE pet_id = ? AND household_id = ? AND kind = 'expense' AND date >= date('now', 'localtime', 'start of month', '-11 months')
      GROUP BY month ORDER BY month`,
    id, req.hid,
  );
  res.json(pet);
});

r.post('/', (req, res) => {
  const data = validate(req.body, petSpec);
  ensureRef('attachments', data.photo_id, req.hid, 'Foto');
  const id = insert('pets', { ...data, household_id: req.hid });
  if (req.body.weight) {
    insert('pet_events', {
      pet_id: id, household_id: req.hid, type: 'weight', title: 'Peso', date: today(), weight: Number(req.body.weight), created_by: req.user.id,
    });
  }
  changed(req, 'pets', 'create', id, `${req.user.display_name} ha añadido a ${data.name} a la familia`);
  res.status(201).json(one(`${PET_SELECT} WHERE p.id = ?`, id));
});

r.patch('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const data = validate(req.body, petSpec, { partial: true });
  ensureRef('attachments', data.photo_id, req.hid, 'Foto');
  if (!update('pets', id, req.hid, data) && Object.keys(data).length) throw notFound('Mascota');
  changed(req, 'pets', 'update', id);
  res.json(one(`${PET_SELECT} WHERE p.id = ?`, id));
});

r.delete('/:id', (req, res) => {
  const id = idParam(req.params.id);
  const p = one('SELECT name FROM pets WHERE id = ? AND household_id = ?', id, req.hid);
  if (!p) throw notFound('Mascota');
  run('DELETE FROM pets WHERE id = ?', id);
  changed(req, 'pets', 'delete', id, `${req.user.display_name} ha borrado la ficha de ${p.name}`);
  res.json({ ok: true });
});

// ----- Eventos de salud y cuidados (con coste opcional que se anota como gasto) -----

function eventCostFields(body) {
  return validate(body || {}, {
    cost: [v.cents(), 'Coste'],
    category_id: [v.int(), 'Categoría'],
    method: [v.oneOf(METHODS), 'Forma de pago'],
    merchant: [v.str({ max: 80 }), 'Lugar'],
  });
}

function petCategory(hid) {
  return one(
    `SELECT id FROM categories WHERE household_id = ? AND kind = 'expense' AND archived = 0
      ORDER BY CASE WHEN lower(name) LIKE '%mascota%' THEN 0 ELSE 1 END, sort LIMIT 1`,
    hid,
  )?.id ?? null;
}

r.post('/:id/events', (req, res) => {
  const petId = idParam(req.params.id);
  const pet = one('SELECT * FROM pets WHERE id = ? AND household_id = ?', petId, req.hid);
  if (!pet) throw notFound('Mascota');
  const data = validate(req.body, eventSpec);
  const cost = eventCostFields(req.body);
  ensureRef('categories', cost.category_id, req.hid, 'Categoría');
  if (data.type === 'weight' && !data.weight) throw bad('Indica el peso');
  if (!data.title) data.title = EVENT_NAMES[data.type];
  const id = tx(() => {
    let transactionId = null;
    if (cost.cost && cost.cost > 0) {
      transactionId = createTransaction(req, {
        kind: 'expense', amount: cost.cost, date: data.date, description: `${pet.name}: ${data.title}`,
        merchant: cost.merchant || pet.vet || '', category_id: cost.category_id ?? petCategory(req.hid), pet_id: petId,
        method: cost.method,
      });
    }
    return insert('pet_events', { ...data, pet_id: petId, household_id: req.hid, transaction_id: transactionId, created_by: req.user.id });
  })();
  const costTxt = cost.cost ? ` (${formatEuros(cost.cost, req.household.currency)})` : '';
  changed(req, 'pets', 'event', petId, `${req.user.display_name} ha anotado ${data.title.toLowerCase()} de ${pet.name}${costTxt}`);
  res.status(201).json({ id });
});

r.patch('/:id/events/:eid', (req, res) => {
  const petId = idParam(req.params.id);
  const eid = idParam(req.params.eid);
  const ev = one('SELECT * FROM pet_events WHERE id = ? AND pet_id = ? AND household_id = ?', eid, petId, req.hid);
  if (!ev) throw notFound('Evento');
  const data = validate(req.body, eventSpec, { partial: true });
  const cost = eventCostFields(req.body);
  tx(() => {
    update('pet_events', eid, req.hid, data);
    if (cost.cost !== undefined) {
      if (ev.transaction_id && cost.cost) {
        run('UPDATE transactions SET amount = ?, date = ? WHERE id = ? AND household_id = ?', cost.cost, data.date || ev.date, ev.transaction_id, req.hid);
      } else if (ev.transaction_id && !cost.cost) {
        run('DELETE FROM transactions WHERE id = ? AND household_id = ?', ev.transaction_id, req.hid);
      } else if (!ev.transaction_id && cost.cost) {
        const pet = one('SELECT * FROM pets WHERE id = ?', petId);
        const tid = createTransaction(req, {
          kind: 'expense', amount: cost.cost, date: data.date || ev.date, description: `${pet.name}: ${data.title || ev.title}`,
          merchant: cost.merchant || pet.vet || '', category_id: cost.category_id ?? petCategory(req.hid), pet_id: petId, method: cost.method,
        });
        run('UPDATE pet_events SET transaction_id = ? WHERE id = ?', tid, eid);
      }
    }
  })();
  changed(req, 'pets', 'event', petId);
  res.json({ ok: true });
});

r.delete('/:id/events/:eid', (req, res) => {
  const petId = idParam(req.params.id);
  const eid = idParam(req.params.eid);
  const ev = one('SELECT * FROM pet_events WHERE id = ? AND pet_id = ? AND household_id = ?', eid, petId, req.hid);
  if (!ev) throw notFound('Evento');
  tx(() => {
    run('DELETE FROM pet_events WHERE id = ?', eid);
    if (ev.transaction_id && req.query.keep_transaction !== '1') run('DELETE FROM transactions WHERE id = ? AND household_id = ?', ev.transaction_id, req.hid);
  })();
  changed(req, 'pets', 'event', petId);
  res.json({ ok: true });
});

export default r;
