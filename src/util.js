// Utilidades compartidas: errores HTTP, validación de entrada y aritmética de fechas.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const bad = (msg) => new HttpError(400, msg);
export const notFound = (what = 'Elemento') => new HttpError(404, `${what} no encontrado`);
export const forbidden = (msg = 'No tienes permiso para hacer esto') => new HttpError(403, msg);

// ---------- Validación ----------
// Cada validador recibe (valor, etiqueta) y devuelve el valor limpio o lanza 400.
// `undefined` significa "campo no enviado" y se deja pasar para las actualizaciones parciales.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const v = {
  str: (opts = {}) => (val, label) => {
    if (val === undefined) return undefined;
    if (val === null) val = '';
    if (typeof val !== 'string' && typeof val !== 'number') throw bad(`${label}: texto no válido`);
    const s = String(val).trim();
    if (opts.required && !s) throw bad(`${label} es obligatorio`);
    if (opts.max && s.length > opts.max) throw bad(`${label}: máximo ${opts.max} caracteres`);
    if (opts.min && s.length < opts.min) throw bad(`${label}: mínimo ${opts.min} caracteres`);
    if (opts.pattern && s && !opts.pattern.test(s)) throw bad(`${label}: formato no válido`);
    return s;
  },
  // Importe en céntimos (entero). Acepta números.
  cents: (opts = {}) => (val, label) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') {
      if (opts.required) throw bad(`${label} es obligatorio`);
      return null;
    }
    const n = Number(val);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw bad(`${label}: importe no válido`);
    if (!opts.allowNegative && n < 0) throw bad(`${label}: no puede ser negativo`);
    if (opts.positive && n <= 0) throw bad(`${label}: debe ser mayor que cero`);
    if (Math.abs(n) > 99_999_999_99) throw bad(`${label}: importe demasiado grande`);
    return n;
  },
  num: (opts = {}) => (val, label) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') return null;
    const n = Number(val);
    if (!Number.isFinite(n)) throw bad(`${label}: número no válido`);
    if (opts.min !== undefined && n < opts.min) throw bad(`${label}: mínimo ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) throw bad(`${label}: máximo ${opts.max}`);
    return n;
  },
  int: (opts = {}) => (val, label) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') {
      if (opts.required) throw bad(`${label} es obligatorio`);
      return null;
    }
    const n = Number(val);
    if (!Number.isInteger(n)) throw bad(`${label}: número entero no válido`);
    if (opts.min !== undefined && n < opts.min) throw bad(`${label}: mínimo ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) throw bad(`${label}: máximo ${opts.max}`);
    return n;
  },
  bool: () => (val) => (val === undefined ? undefined : val ? 1 : 0),
  date: (opts = {}) => (val, label) => {
    if (val === undefined) return undefined;
    if (val === null || val === '') {
      if (opts.required) throw bad(`${label} es obligatoria`);
      return null;
    }
    // La fecha debe existir de verdad (2026-02-30 no se acepta como 2 de marzo).
    const d = typeof val === 'string' && DATE_RE.test(val) ? new Date(`${val}T00:00:00Z`) : null;
    const ok = d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === val;
    if (!ok) throw bad(`${label}: fecha no válida`);
    return val;
  },
  oneOf: (values, opts = {}) => (val, label) => {
    if (val === undefined) return undefined;
    if ((val === null || val === '') && !opts.required) return null;
    if (!values.includes(val)) throw bad(`${label}: valor no permitido`);
    return val;
  },
  color: () => (val, label) => {
    if (val === undefined || val === null || val === '') return undefined;
    if (typeof val !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(val)) throw bad(`${label}: color no válido`);
    return val.toUpperCase();
  },
  emoji: () => (val, label) => {
    if (val === undefined || val === null || val === '') return undefined;
    const s = String(val ?? '').trim();
    if (!s || [...s].length > 8) throw bad(`${label}: icono no válido`);
    return s;
  },
};

// Valida `body` contra `spec` ({ campo: [validador, 'Etiqueta'] }).
// Con { partial: true } solo se devuelven los campos presentes.
export function validate(body, spec, { partial = false } = {}) {
  if (!body || typeof body !== 'object') throw bad('Cuerpo de la petición no válido');
  const out = {};
  for (const [key, [fn, label]] of Object.entries(spec)) {
    const raw = body[key];
    if (raw === undefined && partial) continue;
    // En creación, un campo ausente se valida como null (el validador decide si es obligatorio).
    const clean = fn(raw === undefined ? null : raw, label);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

export const METHODS = ['card', 'cash', 'transfer', 'direct_debit', 'bizum', 'other'];
export const FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'fourmonthly', 'semiannual', 'annual'];

// ---------- Fechas (siempre 'YYYY-MM-DD' en hora local del servidor) ----------

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (s, n) => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
export const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); // m: 1..12

// Suma meses manteniendo el día "ancla" (31 → último día del mes si no existe).
export function addMonthsAnchored(s, months, anchorDay) {
  const [y, m] = s.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(anchorDay, daysInMonth(ny, nm));
  return `${ny}-${pad(nm)}-${pad(day)}`;
}

const FREQ_MONTHS = { monthly: 1, bimonthly: 2, quarterly: 3, fourmonthly: 4, semiannual: 6, annual: 12 };
const FREQ_DAYS = { weekly: 7, biweekly: 14 };

// Siguiente fecha de un pago periódico a partir de `from`, anclado al día de inicio.
export function nextOccurrence(frequency, from, startDate) {
  if (FREQ_DAYS[frequency]) return addDays(from, FREQ_DAYS[frequency]);
  const anchor = Number(startDate.split('-')[2]);
  return addMonthsAnchored(from, FREQ_MONTHS[frequency], anchor);
}

// Importe mensual equivalente (para totales de "fijos al mes").
export function monthlyEquivalent(amount, frequency) {
  if (FREQ_DAYS[frequency]) return Math.round((amount * 365) / 12 / FREQ_DAYS[frequency]);
  return Math.round(amount / FREQ_MONTHS[frequency]);
}

export const monthBounds = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`, days: daysInMonth(y, m) };
};
export const shiftMonth = (ym, n) => addMonthsAnchored(`${ym}-01`, n, 1).slice(0, 7);
export const currentMonth = () => today().slice(0, 7);

// Igual que en la interfaz: separador de miles siempre («1.268,10 €», no «1268,10 €»).
export const formatEuros = (cents, currency = 'EUR') =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency, useGrouping: 'always' }).format((cents || 0) / 100);

export const idParam = (val) => {
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
