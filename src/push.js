// Notificaciones push (Web Push con claves VAPID propias). Funcionan con la app cerrada
// siempre que se acceda por HTTPS (por ejemplo con `tailscale serve`).
import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, all, one, run } from './db.js';
import { addDays, formatEuros, today } from './util.js';
import { amountFor, incomeQuestions, labelFor } from './routes/recurring.js';
import { incomeCheck } from './routes/household.js';
import { petReminders } from './routes/pets.js';
import { activeReminders } from './routes/reminders.js';
import { computeInsights } from './insights.js';

const KEY_FILE = path.join(DATA_DIR, 'vapid.json');
let keys;
try {
  keys = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
} catch {
  keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEY_FILE, JSON.stringify(keys), { mode: 0o600 });
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:gastosbyath@localhost', keys.publicKey, keys.privateKey);
export const publicKey = keys.publicKey;

export async function sendToUser(userId, payload) {
  const subs = all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 20 });
      sent++;
    } catch (e) {
      // La suscripción ya no existe (app desinstalada, permisos retirados…).
      if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
    }
  }));
  return sent;
}

async function sendToHousehold(hid, payload) {
  for (const m of all('SELECT user_id FROM memberships WHERE household_id = ?', hid)) await sendToUser(m.user_id, payload);
}

// Envía cada aviso una sola vez por día y motivo.
async function once(key, hid, payload) {
  if (one('SELECT 1 FROM push_log WHERE key = ?', key)) return;
  run('INSERT INTO push_log (key) VALUES (?)', key);
  await sendToHousehold(hid, payload);
}

const money = (c, cur) => (c ? ` (${formatEuros(c, cur)})` : '');
const when = (date, t) => (date === t ? 'Hoy' : date === addDays(t, 1) ? 'Mañana' : `El ${Number(date.slice(8))}/${Number(date.slice(5, 7))}`);

// Revisión diaria (a partir de las 9:00): recordatorios, cuotas, facturas y mascotas.
// Recordatorios a su hora: el día de antelación elegido, el mismo día y el siguiente si sigue pendiente; cada aviso a la hora
// que tenga el recordatorio (o a la de los avisos del día) y una sola vez. Se mira cada minuto.
export function remindersDue(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const t = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const dayHour = `${pad(Number(process.env.PUSH_HOUR || 9))}:00`;
  const out = [];
  for (const h of all('SELECT id, name, currency FROM households')) {
    for (const m of activeReminders(h.id)) {
      if (hhmm < (m.remind_time || dayHour)) continue;
      const start = addDays(m.date, -(m.remind_days || 0));
      if (t !== start && t !== m.date && t !== addDays(m.date, 1)) continue;
      const overdue = m.date < t;
      out.push({
        key: `${h.id}:rem${m.id}:${t}`, hid: h.id,
        payload: {
          url: '/#/recordatorios', household: h.id,
          title: overdue ? `Pendiente: ${m.title}` : `${when(m.date, t)}${m.remind_time && m.date === t ? ` a las ${m.remind_time}` : ''}: ${m.title}`,
          body: `${m.kind === 'payment' ? 'Recordatorio de pago' : 'Recordatorio'}${money(m.amount, h.currency)} · ${h.name}`,
        },
      });
    }
  }
  return out;
}
export async function pushReminders(now = new Date()) {
  if (!one('SELECT 1 FROM push_subscriptions LIMIT 1')) return;
  for (const r of remindersDue(now)) await once(r.key, r.hid, r.payload);
}

export async function pushDigest() {
  if (!one('SELECT 1 FROM push_subscriptions LIMIT 1')) return;
  if (new Date().getHours() < Number(process.env.PUSH_HOUR || 9)) return;
  const t = today();
  for (const h of all('SELECT id, name, currency, income_check FROM households')) {
    const hid = h.id;
    const tag = (k) => `${hid}:${k}:${t}`;
    const base = { url: '/#/inicio', household: hid };

    for (const rec of all('SELECT * FROM recurring WHERE household_id = ? AND active = 1', hid)) {
      const pre = addDays(rec.next_date, -(rec.remind_days || 0));
      const manualDue = !rec.auto && (t === rec.next_date || t === addDays(rec.next_date, 1));
      if ((rec.remind_days && t === pre) || manualDue) {
        const amount = amountFor(rec, rec.next_date);
        const verb = rec.kind === 'income' ? 'Cobro' : rec.auto ? 'Se cargará' : 'Toca pagar';
        await once(tag(`rec${rec.id}`), hid, {
          ...base, url: rec.plan === 'installment' ? '/#/fijos?tab=plazos' : '/#/fijos',
          title: `${when(rec.next_date, t)}: ${labelFor(rec, rec.next_date)}`,
          body: `${verb}${money(amount, h.currency)} · ${h.name}`,
        });
      }
    }
    // El día elegido: «¿cuánto es la nómina de este mes?», si hay nóminas que cambian sin confirmar.
    const ask = incomeQuestions(hid, h, t);
    if (ask.length && Number(t.slice(8)) === incomeCheck(h).day) {
      const name = new Date(`${t.slice(0, 7)}-15T12:00`).toLocaleDateString('es-ES', { month: 'long' });
      await once(tag('income-ask'), hid, {
        ...base,
        title: ask.length > 1 ? `¿Cuánto son las nóminas de ${name}?` : `¿Cuánto es «${ask[0].name}» de ${name}?`,
        body: `Confírmalo para que la previsión del mes salga bien · ${h.name}`,
      });
    }
    for (const b of all(`SELECT * FROM bills WHERE household_id = ? AND status = 'pending' AND due_date IS NOT NULL`, hid)) {
      if (t === addDays(b.due_date, -3) || t === b.due_date || t === addDays(b.due_date, 1)) {
        await once(tag(`bill${b.id}`), hid, {
          ...base, url: '/#/facturas',
          title: b.due_date < t ? `Factura vencida: ${b.supplier}` : `${when(b.due_date, t)} vence la factura de ${b.supplier}`,
          body: `${b.concept || 'Factura'}${money(b.amount, h.currency)} · ${h.name}`,
        });
      }
    }
    // El día 1: el resumen del mes que acaba de terminar.
    if (t.endsWith('-01')) {
      const prevMonth = addDays(t, -1).slice(0, 7);
      const m = one(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount END), 0) AS exp, COALESCE(SUM(CASE WHEN kind = 'income' THEN amount END), 0) AS inc
           FROM transactions WHERE household_id = ? AND date BETWEEN ? AND ?`,
        hid, `${prevMonth}-01`, `${prevMonth}-31`,
      );
      if (m.exp) {
        const name = new Date(`${prevMonth}-15T12:00`).toLocaleDateString('es-ES', { month: 'long' });
        const saved = m.inc - m.exp;
        await once(tag('recap'), hid, {
          ...base, url: `/#/resumen?m=${prevMonth}`, title: `Vuestro ${name}, en un vistazo`,
          body: `${formatEuros(m.exp, h.currency)} gastados${m.inc ? (saved >= 0 ? `, ${formatEuros(saved, h.currency)} ahorrados` : `, ${formatEuros(-saved, h.currency)} más de lo que entró`) : ''}. Toca para ver el resumen.`,
        });
      }
    }
    // Como mucho un aviso importante al día («la luz va un 25 % por encima», «Netflix ha subido»…), y cada uno una sola vez.
    try {
      if (!one('SELECT 1 FROM push_log WHERE key = ?', tag('insight'))) {
        const x = computeInsights(hid).find((w) => w.tone === 'warn' && !one('SELECT 1 FROM push_log WHERE key = ?', `${hid}:ins:${w.key}`));
        if (x) {
          run('INSERT INTO push_log (key) VALUES (?)', `${hid}:ins:${x.key}`);
          await once(tag('insight'), hid, { ...base, url: x.url?.startsWith('#') ? `/${x.url}` : '/#/inicio', title: x.title, body: x.text });
        }
      }
    } catch { /* un aviso que no se puede calcular no frena el resto */ }
    for (const p of petReminders(hid, addDays(t, 3))) {
      if (t === addDays(p.next_date, -3) || t === p.next_date) {
        await once(tag(`pet${p.id}`), hid, {
          ...base, url: `/#/mascotas/${p.pet_id}`, title: `${when(p.next_date, t)}: ${p.title} de ${p.pet_name}`, body: `Recordatorio de ${h.name}`,
        });
      }
    }
  }
  run(`DELETE FROM push_log WHERE sent_at < datetime('now', '-40 days')`);
}
