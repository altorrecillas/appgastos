// Avisos que se adelantan: lo que conviene saber antes de que llegue el recibo o se acabe el mes.
// Cada aviso tiene una clave estable (incluye la semana, el mes o el movimiento) para poder descartarlo.
import { all, one } from './db.js';
import { addDays, currentMonth, formatEuros, monthBounds, parseYmd, shiftMonth, today } from './util.js';
import { keyOf } from './categorize.js';
import { amountFor, occurrences } from './routes/recurring.js';
import { powerSummary } from './routes/power.js';

const pct = (x) => `${Math.round(x * 100)} %`;
const daysIn = (ym) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthName = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
// Gasto del día a día: sin recibos fijos, facturas ni consumos de luz estimados.
const DAILY = `kind = 'expense' AND recurring_id IS NULL AND bill_id IS NULL AND estimate = 0`;
const DAILY_T = `t.kind = 'expense' AND t.recurring_id IS NULL AND t.bill_id IS NULL AND t.estimate = 0`;

export function computeInsights(hid) {
  const h = one('SELECT currency, monthly_budget FROM households WHERE id = ?', hid);
  const eur = (c) => formatEuros(c, h?.currency);
  const t = today();
  const ym = currentMonth();
  const dom = Number(t.slice(8));
  const out = [];
  const push = (x) => out.push(x);

  // 1. La factura de la luz va por encima (o por debajo) de lo normal.
  try {
    const p = powerSummary(hid);
    const forecast = p.predicted || null;
    if (forecast && p.avgBill && p.days >= 7) {
      const ratio = forecast / p.avgBill;
      if (ratio >= 1.15) {
        push({
          key: `power_high:${p.from}`, tone: 'warn', icon: 'zap', url: '#/luz', score: 80,
          title: `La luz va un ${pct(ratio - 1)} por encima de lo normal`,
          text: `A este ritmo la próxima factura rondará ${eur(forecast)}, frente a los ${eur(p.avgBill)} de media.`,
        });
      } else if (ratio <= 0.85) {
        push({
          key: `power_low:${p.from}`, tone: 'good', icon: 'zap', url: '#/luz', score: 30,
          title: `La luz va un ${pct(1 - ratio)} por debajo de lo normal`,
          text: `La próxima factura rondaría ${eur(forecast)} (de media pagáis ${eur(p.avgBill)}).`,
        });
      }
    }
  } catch { /* sin datos de luz */ }

  // 2. Recibos y suscripciones que suben de precio.
  const recent = all(
    `SELECT id, recurring_id, description, merchant, amount, date FROM transactions
      WHERE household_id = ? AND kind = 'expense' AND estimate = 0 AND date >= ? ORDER BY date`,
    hid, addDays(t, -100),
  );
  const series = new Map();
  for (const x of recent) {
    const key = x.recurring_id ? `r${x.recurring_id}` : keyOf(`${x.merchant} ${x.description}`);
    if (!key) continue;
    if (!series.has(key)) series.set(key, []);
    series.get(key).push(x);
  }
  const recurringNames = all('SELECT id, name, provider, amount FROM recurring WHERE household_id = ? AND active = 1', hid);
  for (const [key, list] of series) {
    if (list.length < 2) continue;
    const last = list.at(-1);
    const prev = list.at(-2);
    const gap = (parseYmd(last.date) - parseYmd(prev.date)) / 864e5;
    const monthly = gap >= 24 && gap <= 38;
    const name = last.description || last.merchant || 'Un recibo';
    if ((key.startsWith('r') || monthly) && last.amount > prev.amount * 1.03 && last.amount - prev.amount >= 50 && last.date >= addDays(t, -40)) {
      push({
        key: `price_up:${key}:${last.date}`, tone: 'warn', icon: 'trending-up', url: '#/fijos', score: 70,
        title: `${name} ha subido de precio`,
        text: `De ${eur(prev.amount)} a ${eur(last.amount)} (un ${pct(last.amount / prev.amount - 1)} más): ${eur((last.amount - prev.amount) * 12)} más al año.`,
      });
    }
    // 3. Un cargo que se repite cada mes y que no está como pago fijo: ¿suscripción nueva?
    if (!key.startsWith('r') && monthly && list.length >= 2 && last.date >= addDays(t, -40)
      && Math.abs(last.amount - prev.amount) <= prev.amount * 0.1
      && !recurringNames.some((r) => keyOf(`${r.provider} ${r.name}`) === key)) {
      push({
        key: `new_sub:${key}`, tone: 'info', icon: 'repeat', score: 45,
        title: `¿${name} es una suscripción?`,
        text: `Se ha cobrado ${list.length >= 3 ? `${list.length} meses` : 'dos meses'} seguidos (${eur(last.amount)}). Si la pasas a pagos fijos se anotará sola y la tendrás en cuenta en las previsiones.`,
        action: { label: 'Pasar a pagos fijos', href: `#/fijos?new=1&name=${encodeURIComponent(name)}&amount=${last.amount}&day=${Number(last.date.slice(8))}` },
      });
    }
  }

  // 4. Esta semana frente a la anterior (gasto del día a día, mismos días de la semana).
  const wd = (parseYmd(t).getDay() + 6) % 7; // 0 = lunes
  if (wd >= 2) {
    const monday = addDays(t, -wd);
    const sum = (from, to) => one(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE household_id = ? AND ${DAILY} AND date BETWEEN ? AND ?`, hid, from, to).s;
    const now = sum(monday, t);
    const before = sum(addDays(monday, -7), addDays(t, -7));
    const diff = now - before;
    if (before > 0 && Math.abs(diff) >= 2000 && Math.abs(diff) / before >= 0.15) {
      push(diff < 0
        ? { key: `week:${monday}`, tone: 'good', icon: 'trending-down', url: '#/movimientos', score: 35, title: `Esta semana vais ${eur(-diff)} por debajo de la anterior`, text: `${eur(now)} en el día a día, frente a ${eur(before)} la semana pasada a estas alturas.` }
        : { key: `week:${monday}`, tone: 'warn', icon: 'trending-up', url: '#/movimientos', score: 50, title: `Esta semana lleváis ${eur(diff)} más que la anterior`, text: `${eur(now)} en el día a día, frente a ${eur(before)} la semana pasada a estas alturas.` });
    }
  }

  // 5. Categorías disparadas este mes (comparando con los tres anteriores a la misma altura).
  if (dom >= 5) {
    const cats = all(
      `SELECT c.id, c.name, c.icon, c.budget, SUM(t.amount) AS total FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = ? AND t.kind = 'expense' AND t.estimate = 0 AND t.date BETWEEN ? AND ? GROUP BY c.id`,
      hid, `${ym}-01`, t,
    );
    const spikes = [];
    for (const c of cats) {
      const past = [1, 2, 3].map((k) => {
        const m = shiftMonth(ym, -k);
        const cut = `${m}-${String(Math.min(dom, daysIn(m))).padStart(2, '0')}`;
        return one(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE household_id = ? AND category_id = ? AND kind = 'expense' AND estimate = 0 AND date BETWEEN ? AND ?`, hid, c.id, `${m}-01`, cut).s;
      });
      const avg = past.reduce((a, b) => a + b, 0) / 3;
      if (past.filter(Boolean).length >= 2 && c.total - avg >= 3000 && c.total >= avg * 1.4) spikes.push({ c, avg });
      // 6. Presupuesto que se va a pasar a este ritmo.
      if (c.budget > 0 && c.total < c.budget && dom >= 7) {
        const perDay = c.total / dom;
        const projected = perDay * daysIn(ym);
        if (projected > c.budget * 1.05) {
          const day = Math.ceil(c.budget / perDay);
          push({
            key: `budget:${c.id}:${ym}`, tone: 'warn', icon: 'gauge', url: '#/presupuestos', score: 65,
            title: `${c.icon} ${c.name}: a este ritmo os pasáis del presupuesto`,
            text: `Lleváis ${eur(c.total)} de ${eur(c.budget)}; si seguís igual, se acaba hacia el día ${Math.min(day, daysIn(ym))}.`,
          });
        }
      }
    }
    spikes.sort((a, b) => (b.c.total - b.avg) - (a.c.total - a.avg)).slice(0, 2).forEach(({ c, avg }) => push({
      key: `spike:${c.id}:${ym}`, tone: 'warn', icon: 'chart-column', url: `#/movimientos?cat=${c.id}`, score: 55,
      title: `${c.icon} ${c.name} va disparado este mes`,
      text: `${eur(c.total)} hasta hoy, un ${pct(c.total / avg - 1)} más de lo habitual a estas alturas (${eur(Math.round(avg))}).`,
    }));
  }

  // 7. Gastos poco habituales de los últimos días.
  for (const x of all(
    `SELECT t.id, t.amount, t.description, t.merchant, t.category_id, c.name AS cat, c.icon FROM transactions t JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ? AND ${DAILY_T} AND t.date >= ? AND t.amount >= 5000 ORDER BY t.amount DESC LIMIT 5`,
    hid, addDays(t, -6),
  )) {
    const hist = all(
      `SELECT amount FROM transactions WHERE household_id = ? AND category_id = ? AND kind = 'expense' AND id != ? AND date >= ?`,
      hid, x.category_id, x.id, addDays(t, -180),
    ).map((r) => r.amount);
    if (hist.length >= 5 && x.amount >= median(hist) * 3) {
      push({
        key: `big:${x.id}`, tone: 'info', icon: 'circle-alert', url: `#/movimientos?cat=${x.category_id}`, score: 40,
        title: `Gasto poco habitual en ${x.cat}`,
        text: `${eur(x.amount)}${x.description || x.merchant ? ` en ${x.description || x.merchant}` : ''}: lo normal en ${x.cat} es unos ${eur(median(hist))}.`,
      });
      break;
    }
  }

  // 8. La semana que viene llegan muchos recibos.
  const until = addDays(t, 7);
  let load = 0;
  let n = 0;
  for (const rec of all(`SELECT * FROM recurring WHERE household_id = ? AND active = 1 AND kind = 'expense'`, hid)) {
    for (const d of occurrences(rec, addDays(t, 1), until, 10)) {
      load += amountFor(rec, d);
      n++;
    }
  }
  for (const b of all(`SELECT amount FROM bills WHERE household_id = ? AND status = 'pending' AND due_date BETWEEN ? AND ?`, hid, addDays(t, 1), until)) {
    load += b.amount;
    n++;
  }
  if (n >= 2 && load >= 20000) {
    push({
      key: `load:${t}`, tone: 'info', icon: 'calendar-clock', url: '#/fijos?tab=calendario', score: 50,
      title: `En los próximos 7 días se cobran ${eur(load)}`,
      text: `${n} recibos y facturas. Mira el calendario para tenerlo previsto.`,
    });
  }

  // 9. Rachas de ahorro (meses completos con más ingresos que gastos).
  let streak = 0;
  let saved = 0;
  for (let k = 1; k <= 12; k++) {
    const { start, end } = monthBounds(shiftMonth(ym, -k));
    const s = one(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount END), 0) AS inc, COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount END), 0) AS exp
         FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ?`,
      hid, start, end,
    );
    if (!s.inc || s.inc <= s.exp) break;
    streak++;
    saved += s.inc - s.exp;
  }
  if (streak >= 2) {
    push({
      key: `streak:${ym}`, tone: 'good', icon: 'piggy-bank', url: '#/analisis', score: 25,
      title: `Lleváis ${streak} meses seguidos ahorrando`,
      text: `${eur(saved)} en total desde ${monthName(shiftMonth(ym, -streak))}. ¡Bien hecho!`,
    });
  }

  // 10. El mes va mejor (o peor) que el anterior a estas alturas.
  if (dom >= 8) {
    const prevYm = shiftMonth(ym, -1);
    const cut = `${prevYm}-${String(Math.min(dom, daysIn(prevYm))).padStart(2, '0')}`;
    const sum = (from, to) => one(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE household_id = ? AND ${DAILY} AND date BETWEEN ? AND ?`, hid, from, to).s;
    const now = sum(`${ym}-01`, t);
    const before = sum(`${prevYm}-01`, cut);
    if (before > 0 && before - now >= 5000 && now <= before * 0.9) {
      push({
        key: `month_good:${ym}`, tone: 'good', icon: 'trending-down', url: '#/analisis', score: 30,
        title: `Vais ${eur(before - now)} por debajo de ${monthName(prevYm)}`,
        text: `En el día a día lleváis ${eur(now)} este mes, frente a ${eur(before)} en ${monthName(prevYm)} a estas alturas.`,
      });
    }
  }

  const order = { warn: 0, info: 1, good: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone] || b.score - a.score);
}

export function insightsFor(hid, userId) {
  const dismissed = new Set(all('SELECT key FROM insight_dismissals WHERE household_id = ? AND user_id = ?', hid, userId).map((r) => r.key));
  return computeInsights(hid).filter((x) => !dismissed.has(x.key));
}

