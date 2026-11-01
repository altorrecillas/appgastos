// Interpreta el texto leído de un ticket: total, fecha y comercio.
// No depende del navegador para poder probarlo aparte con tickets de ejemplo.

const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const pad = (n) => String(n).padStart(2, '0');

// Comercios que se reconocen aunque la lectura tenga alguna letra mal.
const KNOWN = [
  'Mercadona', 'Lidl', 'Carrefour', 'Dia', 'Alcampo', 'Aldi', 'Eroski', 'Consum', 'Ahorramas', 'Hipercor', 'El Corte Inglés', 'bonÀrea', 'Gadis',
  'Froiz', 'Condis', 'Caprabo', 'Spar', 'Covirán', 'Lupa', 'Masymas', 'Supercor', 'Alimerka', 'Ametller Origen', 'Repsol', 'Cepsa', 'Moeve', 'Galp',
  'Shell', 'BP', 'Petronor', 'Ballenoil', 'Plenoil', 'IKEA', 'Leroy Merlin', 'Bricomart', 'Decathlon', 'Zara', 'Primark', 'MediaMarkt',
  'Media Markt', 'Worten', 'Fnac', "McDonald's", 'Burger King', 'Telepizza', 'KFC', 'Starbucks', 'VIPS', 'Goiko', 'Rodilla', 'Druni', 'Primor',
  'Kiwoko', 'Tiendanimal', 'Action', 'Tiger', 'Normal', 'Pepco', 'Mango', 'Pull&Bear', 'Bershka', 'Stradivarius', 'Kiabi', 'Sprinter',
  'Farmacia', 'Parafarmacia', 'Gasolinera',
];
const KNOWN_KEYS = KNOWN.map((name) => ({ name, key: plain(name).replace(/[^A-Z0-9]/g, '') })).sort((a, b) => b.key.length - a.key.length);

function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Importes con dos decimales: «23,45», «1.234,56», «23.45», «23,45€», «-1,20». La lectura a veces mete un espacio: «23, 45».
const MONEY = /(?<![\d.,/])(-?)(\d{1,3}(?:[.\s]\d{3})+|\d{1,5})\s?[,.]\s?(\d{2})(?![\d])(?![.,/-]\d)/g;
export function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(MONEY)) {
    const euros = Number(m[2].replace(/[.\s]/g, ''));
    const cents = euros * 100 + Number(m[3]);
    if (cents > 0) out.push({ cents: m[1] ? -cents : cents, index: m.index });
  }
  return out;
}

const TOTAL_STRONG = /\b(TOTAL\s*(A\s*PAGAR|COMPRA|EUR|EUROS|FACTURA|TICKET|IMPORTE)?|IMPORTE\s*(TOTAL|A\s*PAGAR)|A\s*PAGAR|TOTAL\s*\(?\s*E\s*\)?)\b/;
const TOTAL_FUZZY = /\b(T[O0]TAL|TQTAL|TOTA1|T0TA1|TOT\s*AL)\b/;
const NOT_TOTAL = /\b(SUB\s*TOTAL|BASE|IVA|I\.V\.A|CUOTA|DTO|DESCUENTO|AHORRO|AHORRADO|PUNTOS|ARTICULOS|ART\.?|UNIDADES|UDS|ENTREGADO|ENTREGA|CAMBIO|DEVOLVER|DEVOLUCION|PRECIO|KG|LITROS?|IMP\.)\b/;
const PAYMENT = /\b(TARJETA|TARJ|VISA|MASTERCARD|MAESTRO|CONTACTLESS|PAGO\s+CON|DATAFONO|DEBITO|CREDITO|BIZUM)\b/;
const CASH = /\b(EFECTIVO|ENTREGADO|ENTREGA|CAMBIO|DEVOLVER|METALICO)\b/;

export function findTotal(lines) {
  const cands = [];
  lines.forEach((raw, i) => {
    const up = plain(raw);
    let score = 0;
    const strong = TOTAL_STRONG.test(up) || TOTAL_FUZZY.test(up);
    if (strong) score += 10;
    else if (/\bIMPORTE\b/.test(up)) score += 8; // gasolineras y datáfonos: «IMPORTE: 52,74 €»
    if (/SUB\s*TOTAL/.test(up)) score -= 6;
    if (NOT_TOTAL.test(up) && !/TOTAL\s*A\s*PAGAR/.test(up)) score -= 5;
    if (PAYMENT.test(up)) score += 4;
    if (CASH.test(up)) score -= 6;
    if (score <= 0) return;
    let amounts = amountsIn(raw);
    // A veces el importe va en la línea de debajo.
    if (!amounts.length && lines[i + 1] && !/[A-Z]{4,}/.test(plain(lines[i + 1]))) amounts = amountsIn(lines[i + 1]);
    if (!amounts.length) return;
    const cents = Math.abs(amounts.at(-1).cents);
    cands.push({ cents, score: score + (i > lines.length / 2 ? 1 : 0), line: raw.trim(), strong, payment: PAYMENT.test(up) });
  });
  // Si el pago con tarjeta coincide con un total, ese total es casi seguro.
  for (const c of cands) if (c.strong && cands.some((o) => o !== c && o.payment && o.cents === c.cents)) c.score += 4;
  cands.sort((a, b) => b.score - a.score || b.cents - a.cents);
  if (cands.length) {
    const best = cands[0];
    return { cents: best.cents, line: best.line, confidence: best.score >= 14 ? 'high' : best.score >= 8 ? 'medium' : 'low' };
  }
  // Sin la palabra «total»: el importe que más se repite al final del ticket, o el mayor.
  const tail = lines.slice(Math.floor(lines.length * 0.4)).flatMap((l) => amountsIn(l).map((a) => Math.abs(a.cents)));
  if (!tail.length) return null;
  const counts = new Map();
  tail.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
  const [repeated, n] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  return { cents: n > 1 ? repeated : Math.max(...tail), line: '', confidence: 'low' };
}

const MONTHS = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DIC: 12 };
export function findDate(lines, today) {
  const t = new Date(`${today}T12:00:00`);
  const valid = (y, m, d) => {
    const date = new Date(y, m - 1, d, 12);
    if (date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    const diff = (t - date) / 864e5;
    if (diff < -1 || diff > 400) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  };
  for (const raw of lines) {
    const up = plain(raw).replace(/[Oo]/g, (c, i, s) => (/\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '') ? '0' : c));
    for (const m of up.matchAll(/\b(\d{1,2})\s?[/.-]\s?(\d{1,2})\s?[/.-]\s?(\d{4}|\d{2})\b/g)) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const r = valid(y, Number(m[2]), Number(m[1]));
      if (r) return r;
    }
    for (const m of up.matchAll(/\b(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/g)) {
      const r = valid(Number(m[1]), Number(m[2]), Number(m[3]));
      if (r) return r;
    }
    for (const m of up.matchAll(/\b(\d{1,2})\s+(?:DE\s+)?(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEPT?|OCT|NOV|DIC)[A-Z]*\.?\s+(?:DE\s+)?(\d{4})\b/g)) {
      const r = valid(Number(m[3]), MONTHS[m[2]], Number(m[1]));
      if (r) return r;
    }
  }
  return null;
}

const title = (s) => s.toLowerCase().replace(/(^|[\s(-])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase());
const NOT_NAME = /\b(NIF|CIF|N\.I\.F|C\.I\.F|TEL|TELF|TELEFONO|FACTURA|SIMPLIFICADA|TICKET|BIENVENID|GRACIAS|CP|HORA|FECHA|CAJA|CAJERO|OPERADOR|TIENDA\s+N|WWW|HTTP|COPIA)\b/;
// «Plaza Mayor 3» es una dirección; «Cafetería La Plaza», un nombre: la palabra solo cuenta al principio o con un número.
const ADDRESS = /^(CALLE|C\/|AVDA|AVENIDA|PLAZA|PZA|PASEO|CTRA|CARRETERA)\b|\b(CALLE|C\/|AVDA|AVENIDA|PLAZA|PZA|PASEO|CTRA)\b.*\d/;
export function findMerchant(lines) {
  // El nombre va en la cabecera; más abajo solo se buscan nombres largos (un «menú del día» no es el DIA).
  for (const [scope, minLen] of [[lines.slice(0, 4), 2], [lines, 6]]) {
    for (const raw of scope) {
      if (minLen < 6 && amountsIn(raw).length) continue; // una línea con precio es un producto, no el nombre
      const words = plain(raw).replace(/[^A-Z0-9& ]/g, ' ').split(/\s+/).filter(Boolean);
      const joined = words.join('');
      for (const k of KNOWN_KEYS) {
        if (k.key.length < minLen) continue;
        if (k.key.length <= 4 ? words.includes(k.key) : joined.includes(k.key)) return k.name;
        if (k.key.length >= 6 && words.some((w) => w.length >= k.key.length - 1 && editDistance(w, k.key, 1) <= 1)) return k.name;
      }
    }
  }
  for (const raw of lines.slice(0, 6)) {
    const up = plain(raw);
    const letters = (up.match(/[A-Z]/g) || []).length;
    if (letters >= 4 && letters / up.replace(/\s/g, '').length > 0.7 && !NOT_NAME.test(up) && !ADDRESS.test(up) && !amountsIn(raw).length) {
      return title(raw.replace(/[^\p{L}\p{N}&'.\- ]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, 60);
    }
  }
  return null;
}

export function parseReceipt(text, { today } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1);
  const total = findTotal(lines);
  return {
    total: total?.cents ?? null,
    totalLine: total?.line || '',
    confidence: total?.confidence || 'none',
    date: findDate(lines, today),
    merchant: findMerchant(lines),
    lines: lines.length,
  };
}
