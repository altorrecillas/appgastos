// Cifras para el panel de inicio, el análisis y el calendario de pagos.
import express from 'express';
import { all, normText, one, run } from '../db.js';
import { addDays, currentMonth, monthBounds, parseYmd, shiftMonth, today } from '../util.js';
import { amountFor, decorate as decorateRecurring, incomeQuestions, labelFor, occurrences, processDue } from './recurring.js';
import { petReminders } from './pets.js';
import { activeReminders, reminderDates } from './reminders.js';
import { billPeriod, dayPrices, pendingEstimates, powerSettings } from '../power.js';
import { insightsFor } from '../insights.js';

const r = express.Router();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const sumByKind = (hid, from, to) => {
  const out = { expense: 0, income: 0, count: 0 };
  for (const row of all(
    `SELECT kind, SUM(amount) AS total, COUNT(*) AS n FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ? GROUP BY kind`,
    hid, from, to,
  )) {
    out[row.kind] = row.total;
    out.count += row.n;
  }
  return out;
};

function dailySeries(hid, from, days, kind = 'expense') {
  const arr = new Array(days).fill(0);
  const to = addDays(from, days - 1);
  for (const row of all(
    `SELECT date, SUM(amount) AS total FROM transactions WHERE household_id = ? AND kind = ? AND date BETWEEN ? AND ? GROUP BY date`,
    hid, kind, from, to,
  )) {
    arr[Number(row.date.slice(8)) - 1] = row.total;
  }
  return arr;
}

// Próximos pagos: cuotas de pagos fijos, facturas pendientes y recordatorios de mascotas.
function upcoming(hid, days = 30) {
  const t = today();
  const until = addDays(t, days);
  const items = [];
  for (const rec of all(`SELECT * FROM recurring WHERE household_id = ? AND active = 1`, hid)) {
    // Cuotas vencidas sin anotar (pagos manuales).
    if (rec.next_date < t) {
      items.push({
        type: rec.plan === 'installment' ? 'installment' : 'recurring', id: rec.id, date: rec.next_date, title: labelFor(rec, rec.next_date),
        subtitle: rec.provider, amount: amountFor(rec, rec.next_date), kind: rec.kind, overdue: true, auto: !!rec.auto, variable: !!rec.variable,
      });
    }
    for (const d of occurrences(rec, t, until, 60)) {
      items.push({
        type: rec.plan === 'installment' ? 'installment' : 'recurring', id: rec.id, date: d, title: labelFor(rec, d), subtitle: rec.provider,
        amount: amountFor(rec, d), kind: rec.kind, overdue: false, auto: !!rec.auto, variable: !!rec.variable, first: d === rec.next_date,
      });
    }
  }
  for (const b of all(
    `SELECT id, supplier, concept, amount, due_date FROM bills WHERE household_id = ? AND status = 'pending' AND (due_date IS NULL OR due_date <= ?)`,
    hid, until,
  )) {
    items.push({
      type: 'bill', id: b.id, date: b.due_date, title: b.supplier, subtitle: b.concept, amount: b.amount, kind: 'expense',
      overdue: !!b.due_date && b.due_date < t, first: true,
    });
  }
  for (const p of petReminders(hid, until)) {
    items.push({
      type: 'pet', id: p.pet_id, event_id: p.id, date: p.next_date, title: `${p.pet_name}: ${p.title}`, subtitle: p.type,
      species: p.species, overdue: p.next_date < t, first: true,
    });
  }
  for (const m of activeReminders(hid)) {
    if (m.date < t) {
      items.push({
        type: 'reminder', id: m.id, date: m.date, title: m.title, subtitle: m.notes.split('\n')[0].slice(0, 60), amount: m.amount, kind: 'expense',
        overdue: true, first: true, reminder_kind: m.kind, repeat: m.repeat,
      });
    }
    reminderDates(m, t, until, 10).forEach((d, i) => items.push({
      type: 'reminder', id: m.id, date: d, title: m.title, subtitle: m.notes.split('\n')[0].slice(0, 60), amount: m.amount, kind: 'expense',
      overdue: false, first: i === 0 && m.date >= t, reminder_kind: m.kind, repeat: m.repeat, remind_days: m.remind_days,
    }));
  }
  return items.sort((a, b) => (a.date || '0000').localeCompare(b.date || '0000'));
}

r.get('/dashboard', (req, res) => {
  const hid = req.hid;
  processDue(hid);
  const month = MONTH_RE.test(req.query.month || '') ? req.query.month : currentMonth();
  const { start, end, days } = monthBounds(month);
  const prevMonth = shiftMonth(month, -1);
  const pb = monthBounds(prevMonth);
  const t = today();
  const isCurrent = month === currentMonth();
  const dayNow = isCurrent ? Number(t.slice(8)) : month < currentMonth() ? days : 0;

  const totals = sumByKind(hid, start, end);
  const prevTotals = sumByKind(hid, pb.start, pb.end);
  const sameDay = `${prevMonth}-${String(Math.min(Math.max(dayNow, 1), pb.days)).padStart(2, '0')}`;
  const prevTo = sumByKind(hid, pb.start, sameDay);
  const prevSameDay = prevTo.expense;
  const prevSameDayIncome = prevTo.income;

  const daily = dailySeries(hid, start, days);
  const prevDaily = dailySeries(hid, pb.start, pb.days);

  const byCategory = all(
    `SELECT c.id, COALESCE(c.name, 'Sin categoría') AS name, COALESCE(c.icon, '❔') AS icon, COALESCE(c.color, '#8A8F98') AS color,
            c.budget, SUM(t.amount) AS total, COUNT(*) AS n
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ? AND t.kind = 'expense' AND t.date BETWEEN ? AND ?
      GROUP BY t.category_id ORDER BY total DESC`,
    hid, start, end,
  );
  const catTotals = (from, to) => new Map(all(
    `SELECT category_id AS id, SUM(amount) AS total FROM transactions
      WHERE household_id = ? AND kind = 'expense' AND date BETWEEN ? AND ? GROUP BY category_id`,
    hid, from, to,
  ).map((x) => [x.id, x.total]));
  const prevByCat = catTotals(pb.start, pb.end);
  // En el mes en curso se compara con el mes anterior hasta el mismo día (comparación justa).
  const prevSameByCat = isCurrent ? catTotals(pb.start, sameDay) : prevByCat;
  for (const c of byCategory) {
    c.prev = prevByCat.get(c.id) || 0;
    c.prev_same = prevSameByCat.get(c.id) || 0;
  }
  // Categorías con presupuesto aunque aún no tengan gasto este mes.
  const budgets = all(
    `SELECT id, name, icon, color, budget FROM categories WHERE household_id = ? AND kind = 'expense' AND archived = 0 AND budget IS NOT NULL AND budget > 0 ORDER BY sort`,
    hid,
  ).map((c) => ({ ...c, total: byCategory.find((x) => x.id === c.id)?.total || 0, prev: prevByCat.get(c.id) || 0 }));

  const from12 = monthBounds(shiftMonth(month, -11)).start;
  const trendRows = all(
    `SELECT substr(date, 1, 7) AS m, kind, SUM(amount) AS total FROM transactions
      WHERE household_id = ? AND date BETWEEN ? AND ? GROUP BY m, kind`,
    hid, from12, end,
  );
  const trend = Array.from({ length: 12 }, (_, i) => {
    const m = shiftMonth(month, i - 11);
    return {
      month: m,
      expense: trendRows.find((x) => x.m === m && x.kind === 'expense')?.total || 0,
      income: trendRows.find((x) => x.m === m && x.kind === 'income')?.total || 0,
    };
  });

  // Previsión de cierre del mes en curso.
  let forecast = null;
  const recurringAll = all(`SELECT * FROM recurring WHERE household_id = ?`, hid);
  if (isCurrent) {
    let scheduled = 0;
    for (const rec of recurringAll.filter((x) => x.active && x.kind === 'expense')) {
      for (const d of occurrences(rec, rec.next_date < t ? rec.next_date : t, end, 40)) scheduled += amountFor(rec, d);
    }
    for (const b of all(`SELECT * FROM bills WHERE household_id = ? AND status = 'pending' AND due_date BETWEEN ? AND ?`, hid, start, end)) {
      if (!b.power) scheduled += b.amount;
      else {
        const { from, to } = billPeriod(hid, b);
        scheduled += Math.max(0, b.amount - pendingEstimates(hid, from, to).s);
      }
    }
    const variableSoFar = one(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE household_id = ? AND kind = 'expense' AND date BETWEEN ? AND ?
          AND recurring_id IS NULL AND bill_id IS NULL`,
      hid, start, t,
    ).s;
    const variableRest = Math.round((variableSoFar / Math.max(dayNow, 1)) * (days - dayNow));
    // Ingresos que aún deben llegar este mes (nóminas y otros ingresos fijos).
    let expectedIncome = 0;
    for (const rec of recurringAll.filter((x) => x.active && x.kind === 'income')) {
      for (const d of occurrences(rec, rec.next_date < t ? rec.next_date : t, end, 40)) expectedIncome += amountFor(rec, d);
    }
    const total = totals.expense + scheduled + variableRest;
    forecast = {
      total, scheduled, variableRest, expectedIncome,
      income: totals.income + expectedIncome,
      balance: totals.income + expectedIncome - total,
    };
  }

  const plans = recurringAll.filter((x) => x.plan === 'installment').map(decorateRecurring);
  const activePlans = plans.filter((p) => !p.finished && p.active);
  const fixedMonthly = recurringAll
    .filter((x) => x.active && x.kind === 'expense')
    .map(decorateRecurring)
    .reduce((s, x) => s + x.monthly, 0);

  const budgetTotal = req.household.monthly_budget
    || one(`SELECT SUM(budget) AS s FROM categories WHERE household_id = ? AND kind = 'expense' AND archived = 0`, hid).s
    || null;

  // Luz ahora (solo si el hogar usa el seguimiento del consumo eléctrico).
  let power = null;
  const ps = powerSettings(hid);
  if (ps.base_kwh > 0 || one('SELECT 1 FROM appliances WHERE household_id = ? LIMIT 1', hid)) {
    const { prices, source } = dayPrices(hid, t, ps);
    const h = new Date().getHours();
    const sorted = [...prices].sort((a, b) => a - b);
    power = {
      price: prices[h], source, level: prices[h] <= sorted[7] ? 'cheap' : prices[h] >= sorted[16] ? 'dear' : 'mid',
      cheapest: prices.indexOf(sorted[0]), estimated: pendingEstimates(hid, '0000-01-01', t).s,
    };
  }

  res.json({
    power,
    month, start, end, days, dayNow, isCurrent,
    totals, prevTotals, prevSameDay, prevSameDayIncome, daily, prevDaily, byCategory, budgets, trend, forecast, budgetTotal, fixedMonthly,
    installments: {
      count: activePlans.length,
      remaining: activePlans.reduce((s, p) => s + p.remaining, 0),
      monthly: activePlans.reduce((s, p) => s + p.monthly, 0),
      plans: activePlans.sort((a, b) => b.progress - a.progress).slice(0, 4),
    },
    upcoming: upcoming(hid, 30),
    // Nóminas que cambian: «¿la de este mes es igual que la anterior?».
    income_questions: isCurrent ? incomeQuestions(hid, req.household, t) : [],
    recent: all(
      `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color, p.name AS person_name, u.display_name AS created_by_name
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN people p ON p.id = t.person_id
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.household_id = ? ORDER BY t.date DESC, t.id DESC LIMIT 8`,
      hid,
    ),
    activity: all(
      `SELECT a.id, a.summary, a.created_at, a.entity, a.action, u.display_name AS user_name, u.color AS user_color
         FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.household_id = ? ORDER BY a.id DESC LIMIT 8`,
      hid,
    ),
    lists: all(
      `SELECT l.id, l.name, l.icon, (SELECT COUNT(*) FROM shopping_items i WHERE i.list_id = l.id AND i.checked = 0) AS pending,
              (SELECT COUNT(*) FROM shopping_items i WHERE i.list_id = l.id) AS items
         FROM shopping_lists l WHERE l.household_id = ? AND l.status = 'active' ORDER BY l.created_at DESC LIMIT 4`,
      hid,
    ),
    goals: all(
      `SELECT g.id, g.name, g.icon, g.color, g.target, g.deadline,
              (SELECT COALESCE(SUM(amount), 0) FROM goal_moves m WHERE m.goal_id = g.id) AS saved
         FROM goals g WHERE g.household_id = ? AND g.archived = 0 ORDER BY g.deadline IS NULL, g.deadline LIMIT 3`,
      hid,
    ),
    pendingBills: one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total, SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END) AS overdue
         FROM bills WHERE household_id = ? AND status = 'pending'`,
      t, hid,
    ),
  });
});

// Avisos para la campana: vencidos y lo que toca en los próximos 7 días, más presupuestos superados.
r.get('/alerts', (req, res) => {
  const hid = req.hid;
  processDue(hid);
  const t = today();
  // Los recordatorios avisan con la antelación que se haya elegido en cada uno.
  const items = upcoming(hid, 60).filter((x) => {
    if (x.overdue) return true;
    if (x.first === false || !x.date) return false;
    const window = x.type === 'reminder' ? x.remind_days ?? 3 : 7;
    return x.date <= addDays(t, window);
  });
  const { start, end } = monthBounds(currentMonth());
  const over = all(
    `SELECT c.id, c.name, c.icon, c.budget, SUM(t.amount) AS total FROM transactions t JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ? AND t.kind = 'expense' AND t.date BETWEEN ? AND ? AND c.budget > 0
      GROUP BY c.id HAVING total > c.budget`,
    hid, start, end,
  );
  res.json({ items, over, count: items.filter((x) => x.overdue).length + over.length });
});

// Resumen de un mes para verlo con calma o compartirlo: lo que entró, lo que salió, en qué y lo más destacado.
r.get('/recap', (req, res) => {
  const hid = req.hid;
  const cm = currentMonth();
  const def = Number(today().slice(8)) <= 7 ? shiftMonth(cm, -1) : cm;
  const month = MONTH_RE.test(req.query.month || '') && req.query.month <= cm ? req.query.month : def;
  const { start, end } = monthBounds(month);
  const to = end < today() ? end : today();
  const days = Number(to.slice(8));
  const totals = sumByKind(hid, start, end);
  const prevM = shiftMonth(month, -1);
  const prev = sumByKind(hid, monthBounds(prevM).start, monthBounds(prevM).end);
  const avg6 = [1, 2, 3, 4, 5, 6].map((k) => sumByKind(hid, monthBounds(shiftMonth(month, -k)).start, monthBounds(shiftMonth(month, -k)).end).expense).filter(Boolean);
  const cats = all(
    `SELECT t.category_id AS id, COALESCE(c.name, 'Sin categoría') AS name, COALESCE(c.icon, '❔') AS icon, COALESCE(c.color, '#8A8F98') AS color,
            SUM(t.amount) AS total, COUNT(*) AS n
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ? AND t.kind = 'expense' AND t.date BETWEEN ? AND ? GROUP BY t.category_id ORDER BY total DESC`,
    hid, start, end,
  );
  const prevCats = new Map(all(
    `SELECT category_id AS id, SUM(amount) AS total FROM transactions WHERE household_id = ? AND kind = 'expense' AND date BETWEEN ? AND ? GROUP BY category_id`,
    hid, monthBounds(prevM).start, monthBounds(prevM).end,
  ).map((x) => [x.id, x.total]));
  const biggest = one(
    `SELECT t.amount, t.date, t.description, t.merchant, c.name AS category, c.icon FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ? AND t.kind = 'expense' AND t.estimate = 0 AND t.date BETWEEN ? AND ? ORDER BY t.amount DESC LIMIT 1`,
    hid, start, end,
  );
  const dayRows = all(
    `SELECT date, SUM(amount) AS total, COUNT(*) AS n FROM transactions WHERE household_id = ? AND kind = 'expense' AND estimate = 0
        AND recurring_id IS NULL AND bill_id IS NULL AND date BETWEEN ? AND ? GROUP BY date ORDER BY total DESC`,
    hid, start, end,
  );
  // Qué día de la semana se gasta más en el día a día (media por día).
  const wd = new Array(7).fill(0);
  const wdDays = new Array(7).fill(0);
  for (let d = start; d <= to; d = addDays(d, 1)) wdDays[parseYmd(d).getDay()]++;
  for (const r2 of dayRows) wd[parseYmd(r2.date).getDay()] += r2.total;
  const wdAvg = wd.map((x, i) => (wdDays[i] ? x / wdDays[i] : 0));
  const topWd = wdAvg.indexOf(Math.max(...wdAvg));
  const restAvg = wdAvg.filter((_, i) => i !== topWd && wdDays[i]).reduce((a, b) => a + b, 0) / Math.max(1, wdAvg.filter((_, i) => i !== topWd && wdDays[i]).length);
  const fixed = one(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE household_id = ? AND kind = 'expense' AND (recurring_id IS NOT NULL OR bill_id IS NOT NULL OR estimate = 1) AND date BETWEEN ? AND ?`,
    hid, start, end,
  ).s;
  const superCat = all(`SELECT id FROM categories WHERE household_id = ? AND kind = 'expense' AND lower(name) LIKE 'supermercado%'`, hid)[0];
  const superm = superCat ? one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE household_id = ? AND category_id = ? AND date BETWEEN ? AND ?`,
    hid, superCat.id, start, end,
  ) : null;
  const people = all(
    `SELECT p.name, p.emoji, p.color, p.photo_id, SUM(t.amount) AS total FROM transactions t JOIN people p ON p.id = t.person_id
      WHERE t.household_id = ? AND t.kind = 'expense' AND t.date BETWEEN ? AND ? GROUP BY p.id ORDER BY total DESC`,
    hid, start, end,
  );
  let streak = 0;
  for (let k = 0; k < 24; k++) {
    const m = shiftMonth(month, -k);
    const x = sumByKind(hid, monthBounds(m).start, monthBounds(m).end);
    if (!x.income || x.income <= x.expense) break;
    streak++;
  }
  const first = one('SELECT MIN(date) AS d FROM transactions WHERE household_id = ?', hid).d;
  res.json({
    month, complete: end < today(), days, totals, prev: { month: prevM, ...prev },
    avg6: avg6.length ? Math.round(avg6.reduce((a, b) => a + b, 0) / avg6.length) : null,
    categories: cats.slice(0, 6).map((c) => ({ ...c, share: totals.expense ? c.total / totals.expense : 0, prev: prevCats.get(c.id) || 0 })),
    biggest, busiest: dayRows[0] || null,
    weekday: wdAvg[topWd] > 0 && restAvg > 0 ? { day: topWd, avg: Math.round(wdAvg[topWd]), ratio: wdAvg[topWd] / restAvg } : null,
    fixed, daily: Math.round((totals.expense - fixed) / Math.max(days, 1)), supermarket: superm?.n ? { ...superm, avg: Math.round(superm.total / superm.n) } : null,
    budget: req.household.monthly_budget || null, people, streak,
    canPrev: !!first && first < start, canNext: month < cm,
  });
});

// Avisos que se adelantan (sin los que esta persona ya ha descartado).
r.get('/insights', (req, res) => res.json(insightsFor(req.hid, req.user.id)));
r.post('/insights/dismiss', (req, res) => {
  const key = String(req.body?.key || '').slice(0, 120);
  if (!key) return res.status(400).json({ error: 'Falta el aviso' });
  run('INSERT OR IGNORE INTO insight_dismissals (user_id, household_id, key) VALUES (?, ?, ?)', req.user.id, req.hid, key);
  run(`DELETE FROM insight_dismissals WHERE user_id = ? AND household_id = ? AND at < datetime('now', '-120 days')`, req.user.id, req.hid);
  res.json({ ok: true });
});

r.get('/analytics', (req, res) => {
  const hid = req.hid;
  const cm = currentMonth();
  let from = DATE_RE.test(req.query.from || '') ? req.query.from : monthBounds(shiftMonth(cm, -11)).start;
  let to = DATE_RE.test(req.query.to || '') ? req.query.to : monthBounds(cm).end;
  if (from > to) [from, to] = [to, from];
  const base = `FROM transactions t WHERE t.household_id = ? AND t.date BETWEEN ? AND ?`;
  const P = [hid, from, to];

  const totals = sumByKind(hid, from, to);
  const months = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && months.length < 120; m = shiftMonth(m, 1)) months.push(m);

  const monthlyRows = all(`SELECT substr(t.date, 1, 7) AS m, t.kind, SUM(t.amount) AS total ${base} GROUP BY m, t.kind`, ...P);
  const monthly = months.map((m) => ({
    month: m,
    expense: monthlyRows.find((x) => x.m === m && x.kind === 'expense')?.total || 0,
    income: monthlyRows.find((x) => x.m === m && x.kind === 'income')?.total || 0,
  }));

  const catQuery = (kind) => all(
    `SELECT t.category_id AS id, COALESCE(c.name, 'Sin categoría') AS name, COALESCE(c.icon, '❔') AS icon,
            COALESCE(c.color, '#8A8F98') AS color, SUM(t.amount) AS total, COUNT(*) AS n
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.kind = ?
      GROUP BY t.category_id ORDER BY total DESC`,
    ...P, kind,
  );
  const byCategory = catQuery('expense');
  const incomeByCategory = catQuery('income');

  const catMonthRows = all(
    `SELECT substr(t.date, 1, 7) AS m, t.category_id AS id, SUM(t.amount) AS total ${base} AND t.kind = 'expense' GROUP BY m, t.category_id`,
    ...P,
  );
  const monthlyByCategory = byCategory.map((c) => ({
    id: c.id, name: c.name, icon: c.icon, color: c.color,
    values: months.map((m) => catMonthRows.find((x) => x.m === m && x.id === c.id)?.total || 0),
  }));

  // Gasto medio por día de la semana (0 = domingo).
  const wdRows = all(`SELECT CAST(strftime('%w', t.date) AS INTEGER) AS wd, SUM(t.amount) AS total, COUNT(*) AS n ${base} AND t.kind = 'expense' GROUP BY wd`, ...P);
  // Los días futuros del periodo no cuentan para las medias.
  const effTo = to < today() ? to : today();
  const wdCount = new Array(7).fill(0);
  for (let d = from, i = 0; d <= effTo && i < 4000; d = addDays(d, 1), i++) wdCount[parseYmd(d).getDay()]++;
  const weekday = [1, 2, 3, 4, 5, 6, 0].map((wd) => {
    const row = wdRows.find((x) => x.wd === wd);
    return { wd, total: row?.total || 0, n: row?.n || 0, avg: wdCount[wd] ? Math.round((row?.total || 0) / wdCount[wd]) : 0 };
  });

  const daily = all(`SELECT t.date, SUM(t.amount) AS total, COUNT(*) AS n ${base} AND t.kind = 'expense' GROUP BY t.date ORDER BY t.date`, ...P);

  const byPerson = all(
    `SELECT p.id, COALESCE(p.name, 'Sin asignar') AS name, COALESCE(p.emoji, '👤') AS emoji, COALESCE(p.color, '#8A8F98') AS color,
            SUM(t.amount) AS total, COUNT(*) AS n
       FROM transactions t LEFT JOIN people p ON p.id = t.person_id
      WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.kind = 'expense' GROUP BY t.person_id ORDER BY total DESC`,
    ...P,
  );
  const byMethod = all(`SELECT COALESCE(t.method, 'none') AS method, SUM(t.amount) AS total, COUNT(*) AS n ${base} AND t.kind = 'expense' GROUP BY t.method ORDER BY total DESC`, ...P);
  const byPet = all(
    `SELECT p.id, p.name, p.species, p.color, SUM(t.amount) AS total, COUNT(*) AS n
       FROM transactions t JOIN pets p ON p.id = t.pet_id
      WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.kind = 'expense' GROUP BY t.pet_id ORDER BY total DESC`,
    ...P,
  );
  // Comercios: «Mercadona», «MERCADONA» y «mercadona» son el mismo (también con acentos); se enseña la forma más usada.
  const shopMap = new Map();
  for (const row of all(
    `SELECT COALESCE(NULLIF(t.merchant, ''), NULLIF(t.description, ''), 'Sin nombre') AS name, SUM(t.amount) AS total, COUNT(*) AS n,
            MAX(t.date) AS last
       ${base} AND t.kind = 'expense' GROUP BY name`,
    ...P,
  )) {
    const key = normText(row.name).trim();
    const g = shopMap.get(key);
    if (!g) shopMap.set(key, { ...row, top: row.n });
    else {
      if (row.n > g.top) Object.assign(g, { name: row.name, top: row.n });
      g.total += row.total;
      g.n += row.n;
      if (row.last > g.last) g.last = row.last;
    }
  }
  const merchants = [...shopMap.values()].sort((a, b) => b.total - a.total).slice(0, 12).map(({ top, ...m }) => m);
  const biggest = all(
    `SELECT t.id, t.date, t.amount, t.description, t.merchant, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ? AND t.date BETWEEN ? AND ? AND t.kind = 'expense' AND t.recurring_id IS NULL AND t.bill_id IS NULL
      ORDER BY t.amount DESC LIMIT 8`,
    ...P,
  );
  const sources = one(
    `SELECT COALESCE(SUM(CASE WHEN t.recurring_id IS NOT NULL THEN t.amount END), 0) AS recurring,
            COALESCE(SUM(CASE WHEN t.bill_id IS NOT NULL THEN t.amount END), 0) AS bills,
            COALESCE(SUM(CASE WHEN t.list_id IS NOT NULL THEN t.amount END), 0) AS shopping,
            COALESCE(SUM(CASE WHEN t.recurring_id IS NULL AND t.bill_id IS NULL AND t.list_id IS NULL THEN t.amount END), 0) AS other
       ${base} AND t.kind = 'expense'`,
    ...P,
  );

  // Comparativa interanual: este año frente al anterior, mes a mes.
  const year = Number(to.slice(0, 4));
  const yoyRows = all(
    `SELECT substr(date, 1, 4) AS y, CAST(substr(date, 6, 2) AS INTEGER) AS m, SUM(amount) AS total FROM transactions
      WHERE household_id = ? AND kind = 'expense' AND date BETWEEN ? AND ? GROUP BY y, m`,
    hid, `${year - 1}-01-01`, `${year}-12-31`,
  );
  const yoy = {
    year,
    current: Array.from({ length: 12 }, (_, i) => yoyRows.find((x) => x.y === String(year) && x.m === i + 1)?.total || 0),
    previous: Array.from({ length: 12 }, (_, i) => yoyRows.find((x) => x.y === String(year - 1) && x.m === i + 1)?.total || 0),
  };

  const dayCount = Math.round((parseYmd(to) - parseYmd(from)) / 864e5) + 1;
  const effDays = Math.max(1, Math.round((parseYmd(effTo) - parseYmd(from)) / 864e5) + 1);
  res.json({
    from, to, months, dayCount, effDays, totals, monthly, byCategory, incomeByCategory, monthlyByCategory, weekday, daily,
    byPerson, byMethod, byPet, merchants, biggest, sources, yoy,
  });
});

r.get('/calendar', (req, res) => {
  const hid = req.hid;
  const month = MONTH_RE.test(req.query.month || '') ? req.query.month : currentMonth();
  const { start, end } = monthBounds(month);
  const t = today();
  const events = [];

  // Pagos fijos ya anotados este mes.
  for (const row of all(
    `SELECT t.id, t.date, t.amount, t.kind, t.description, t.recurring_id, r.plan FROM transactions t JOIN recurring r ON r.id = t.recurring_id
      WHERE t.household_id = ? AND t.date BETWEEN ? AND ?`,
    hid, start, end,
  )) {
    events.push({
      date: row.date, type: row.plan === 'installment' ? 'installment' : 'recurring', ref: row.recurring_id, title: row.description,
      amount: row.amount, kind: row.kind, status: 'paid',
    });
  }
  // Cuotas futuras (y vencidas sin pagar).
  for (const rec of all(`SELECT * FROM recurring WHERE household_id = ? AND active = 1`, hid)) {
    for (const d of occurrences(rec, start, end, 60)) {
      events.push({
        date: d, type: rec.plan === 'installment' ? 'installment' : 'recurring', ref: rec.id, title: labelFor(rec, d), amount: amountFor(rec, d),
        kind: rec.kind, status: d < t ? 'overdue' : 'pending', auto: !!rec.auto,
      });
    }
  }
  for (const b of all(
    `SELECT id, supplier, concept, amount, due_date, status, paid_date FROM bills WHERE household_id = ? AND
        ((status = 'pending' AND due_date BETWEEN ? AND ?) OR (status = 'paid' AND COALESCE(paid_date, due_date) BETWEEN ? AND ?))`,
    hid, start, end, start, end,
  )) {
    events.push({
      date: b.status === 'paid' ? (b.paid_date || b.due_date) : b.due_date, type: 'bill', ref: b.id, title: b.supplier,
      subtitle: b.concept, amount: b.amount, kind: 'expense',
      status: b.status === 'paid' ? 'paid' : b.due_date < t ? 'overdue' : 'pending',
    });
  }
  for (const p of petReminders(hid, end).filter((x) => x.next_date >= start)) {
    events.push({ date: p.next_date, type: 'pet', ref: p.pet_id, title: `${p.pet_name}: ${p.title}`, status: p.next_date < t ? 'overdue' : 'pending' });
  }
  for (const m of activeReminders(hid)) {
    for (const d of reminderDates(m, start, end)) {
      events.push({ date: d, type: 'reminder', ref: m.id, title: m.title, amount: m.amount, kind: 'expense', status: d < t ? 'overdue' : 'pending' });
    }
    if (m.date < start && m.date < t && m.repeat === 'none') {
      // Vencido de meses anteriores: se muestra hoy si se está viendo el mes actual.
      if (t >= start && t <= end) events.push({ date: t, type: 'reminder', ref: m.id, title: m.title, amount: m.amount, kind: 'expense', status: 'overdue' });
    }
  }
  const daily = all(
    `SELECT date, SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END) AS expense,
            SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END) AS income, COUNT(*) AS n
       FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ? GROUP BY date`,
    hid, start, end,
  );
  res.json({ month, start, end, events: events.sort((a, b) => a.date.localeCompare(b.date)), daily });
});

export default r;
