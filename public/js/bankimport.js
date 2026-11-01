// Importar movimientos del banco: CSV, XLS, XLSX u ODS de los bancos españoles más habituales.
// Se reconoce el banco y las columnas, se limpian los conceptos, se propone la categoría de cada
// movimiento y se marca lo que ya estaba anotado para no duplicarlo.
import { post } from './api.js';
import { $, fmtDate, html, icon, money, on, plural, sheet, toast, toastError, withBusy } from './ui.js';
import { categories } from './store.js';
import { notifyChange } from './forms.js';

const BANKS = [
  ['Santander', '#EC0000', /santander/], ['BBVA', '#004481', /\bbbva\b/], ['CaixaBank', '#007EAE', /caixa ?bank|la caixa|imagin ?bank/],
  ['ING', '#FF6200', /\bing\b|ing direct/], ['Sabadell', '#006DFF', /sabadell/], ['Openbank', '#E4002B', /openbank/],
  ['Bankinter', '#FF6600', /bankinter/], ['Unicaja', '#00843D', /unicaja/], ['Kutxabank', '#DA291C', /kutxa/], ['Abanca', '#00A0DF', /abanca/],
  ['Ibercaja', '#0055A5', /ibercaja/], ['Cajamar', '#009B3A', /cajamar/], ['Revolut', '#191C1F', /revolut/], ['N26', '#36A18B', /\bn26\b/],
  ['EVO Banco', '#E6007E', /evo ?banco/], ['MyInvestor', '#00A6D6', /myinvestor/], ['Deutsche Bank', '#0018A8', /deutsche/],
].map(([name, color, re]) => ({ name, color, re }));

// Nombres de columna de cada dato (ya sin acentos ni signos); el orden marca la preferencia.
const COLS = {
  date: ['fecha operacion', 'f operacion', 'fecha de operacion', 'fecha', 'date', 'started date', 'booking date', 'fecha contable', 'completed date', 'f valor', 'fecha valor', 'data'],
  desc: ['concepto', 'descripcion', 'description', 'detalle', 'payee', 'beneficiario', 'comercio', 'concepto comun', 'movimiento'],
  extra: ['mas datos', 'observaciones', 'comentario', 'payment reference', 'referencia 1', 'referencia 2', 'concepto propio', 'informacion adicional', 'movimiento'],
  amount: ['importe', 'amount', 'cantidad', 'importe en euros'],
  debit: ['cargo', 'cargos', 'debe', 'adeudo', 'salida', 'salidas', 'debit', 'reintegros'],
  credit: ['abono', 'abonos', 'haber', 'ingreso', 'ingresos', 'entrada', 'entradas', 'credit'],
  bankcat: ['categoria', 'category'],
  subcat: ['subcategoria'],
  state: ['state', 'estado'],
  fee: ['fee', 'comision', 'comisiones'],
};
const SKIP_HEAD = /^(saldo|balance|disponible|divisa|currency|moneda)/;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- Lectura del archivo ----------
let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxLoading) {
    xlsxLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/xlsx.full.min.js';
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => {
        xlsxLoading = null;
        reject(new Error('No se ha podido cargar el lector de hojas de cálculo'));
      };
      document.head.append(s);
    });
  }
  return xlsxLoading;
}

export function parseCsv(text) {
  const firstLines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
  const sep = [';', ',', '\t', '|'].map((s) => [s, Math.max(...firstLines.map((l) => l.split(s).length))]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim().replace(/^﻿/, '')));
}

async function readFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(xlsx?|ods|xlsm|numbers)$/.test(name)) {
    const XLSX = await loadXlsx();
    // raw: los «.xls» que son texto o HTML se leen tal cual («-45,67» no es -4567 en notación inglesa).
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false, raw: true });
    // La hoja con más filas (algunos bancos ponen una portada antes).
    const sheets = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '', blankrows: false }));
    return { rows: sheets.sort((a, b) => b.length - a.length)[0] || [], XLSX };
  }
  let text = await file.text();
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(await file.arrayBuffer());
  // Algunos «.xls» son en realidad una tabla HTML.
  if (/^\s*<(!doctype|html|table)/i.test(text)) {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(text, { type: 'string', raw: true });
    return { rows: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '', blankrows: false }), XLSX };
  }
  return { rows: parseCsv(text), XLSX: null };
}

// ---------- Interpretación ----------
const pad = (n) => String(n).padStart(2, '0');
export function parseDateCell(v, XLSX) {
  if (typeof v === 'number' && v > 20000 && v < 80000 && XLSX) {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  let y;
  let mo;
  let d;
  if (m) [, y, mo, d] = m;
  else {
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
    if (!m) return null;
    [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
  }
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

export function parseMoneyCell(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : NaN;
  let s = String(v ?? '').trim().replace(/[−–]/g, '-');
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (/-\s*$/.test(s)) {
    neg = true;
    s = s.replace(/-\s*$/, '');
  }
  s = s.replace(/eur|euros|€|\s| /gi, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return NaN;
  s = s.replace(/'/g, '');
  const lastC = s.lastIndexOf(',');
  const lastD = s.lastIndexOf('.');
  let n;
  if (lastC >= 0 && lastD >= 0) {
    n = lastC > lastD ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastC >= 0) {
    n = /,\d{1,2}$/.test(s) && s.split(',').length === 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastD >= 0) {
    n = /\.\d{1,2}$/.test(s) && s.split('.').length === 2 ? s : s.replace(/\./g, '');
  } else n = s;
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 100) * (neg ? -1 : 1) : NaN;
}

function findCol(head, aliases, used) {
  for (const a of aliases) {
    const i = head.findIndex((h, j) => !used.has(j) && h === a);
    if (i >= 0) return i;
  }
  for (const a of aliases) {
    const i = head.findIndex((h, j) => !used.has(j) && !SKIP_HEAD.test(h) && h.startsWith(`${a} `));
    if (i >= 0) return i;
  }
  return -1;
}

export function detect(rows, fileName = '') {
  let headerIndex = -1;
  let map = null;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const head = rows[r].map(norm);
    const used = new Set();
    const take = (key) => {
      const i = findCol(head, COLS[key], used);
      if (i >= 0) used.add(i);
      return i;
    };
    const m = { date: take('date') };
    if (m.date < 0) continue;
    m.amount = take('amount');
    m.debit = m.amount < 0 ? take('debit') : -1;
    m.credit = m.amount < 0 ? take('credit') : -1;
    if (m.amount < 0 && m.debit < 0 && m.credit < 0) continue;
    m.desc = take('desc');
    m.bankcat = take('bankcat');
    m.subcat = take('subcat');
    m.state = take('state');
    m.fee = take('fee');
    m.extra = COLS.extra.map((a) => head.findIndex((h, j) => !used.has(j) && (h === a || h.startsWith(`${a} `)))).filter((i) => i >= 0);
    headerIndex = r;
    map = m;
    break;
  }
  const text = norm([fileName, ...rows.slice(0, Math.max(headerIndex, 0) + 1).flat()].join(' '));
  let bank = BANKS.find((b) => b.re.test(text)) || null;
  if (!bank && map) {
    const head = rows[headerIndex].map(norm);
    if (head.includes('started date') && head.includes('state')) bank = BANKS.find((b) => b.name === 'Revolut');
    else if (head.includes('payee') && head.some((h) => h.startsWith('amount'))) bank = BANKS.find((b) => b.name === 'N26');
    else if (head.includes('subcategoria') && head.some((h) => h.startsWith('f valor'))) bank = BANKS.find((b) => b.name === 'ING');
  }
  return { headerIndex, map, bank };
}

// «COMPRA TARJ. 4B*1234 MERCADONA VALENCIA 12/10» → «Mercadona Valencia».
const SMALL = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'a', 'al', 'con', 'por']);
export function cleanConcept(original) {
  let s = String(original || '')
    .replace(/\b(compra|pago)s?\s+(con\s+)?(tarj(eta)?|tj)\.?(\s+(de\s+)?(credito|cr[eé]dito|debito|d[eé]bito))?\b\.?/gi, ' ')
    .replace(/\bpago\s+m[oó]vil(\s+en)?\b/gi, ' ')
    .replace(/^\s*pago\s+en\s+/i, ' ')
    .replace(/\b(apple|google|samsung)\s*pay\b/gi, ' ')
    .replace(/^\s*compra(\s+en)?\b/i, ' ')
    .replace(/\b4B\b/g, ' ')
    .replace(/[\dX*]{4,}[\dX*]*/gi, (m) => (/\d/.test(m) ? ' ' : m))
    .replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
    .replace(/[*#]+/g, ' ')
    .replace(/\b(s\.?\s?a\.?\s?u?|s\.?\s?l\.?\s?u?|s\.?\s?c\.?|c\.?\s?b\.?)\.?\s*$/i, ' ')
    .replace(/\be\.\s?s\.?(?=\s|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '');
  if (s.length < 2) s = String(original || '').trim();
  // Solo se pasa a minúsculas lo que viene todo en mayúsculas.
  if (s === s.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{3,}/.test(s)) {
    s = s.toLowerCase().split(' ').map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  }
  return s.slice(0, 120);
}

function methodOf(text, kind) {
  const t = norm(text);
  if (/\bbizum\b/.test(t)) return 'bizum';
  if (/\b(recibo|adeudo|domicilia)/.test(t)) return 'direct_debit';
  if (/\b(cajero|reintegro|retirada efectivo|disposicion efectivo|disp efectivo)\b/.test(t)) return 'cash';
  if (/\b(transf|transferencia|traspaso)\b/.test(t)) return 'transfer';
  if (/\b(tarj|tarjeta|compra|pago movil|contactless|apple pay|google pay)\b/.test(t)) return 'card';
  return kind === 'expense' ? 'card' : 'transfer';
}

// Categorías propias del banco (ING, BBVA…) → las del hogar, si no hay nada mejor.
const BANK_CATS = [
  [/aliment|supermerc|hipermerc/, 'Supermercado'], [/restaur|bares|cafeter|comida fuera/, 'Restaurantes'],
  [/transport|vehicul|gasolin|combust|carbur|parking|peaje/, 'Transporte'], [/salud|farmac|medic|optica|dentist/, 'Salud'],
  [/seguro/, 'Seguros'], [/ocio|viaje|cultura|espectac|suscrip|entreten/, 'Ocio y suscripciones'], [/ropa|moda|calzado/, 'Ropa y calzado'],
  [/hogar|casa|mueble|bricol|decorac/, 'Hogar y reparaciones'], [/telef|internet|comunicac|movil/, 'Teléfono e internet'],
  [/luz|agua|gas|suministro|energ/, 'Luz, agua y gas'], [/educa|formac|colegio/, 'Educación'], [/impuesto|tasa|hacienda|tribut/, 'Impuestos y tasas'],
  [/mascota|animal/, 'Mascotas'], [/regalo/, 'Regalos'], [/nomina|salario|pension/, 'Nómina'],
];
function bankCategory(text, kind) {
  const t = norm(text);
  if (!t) return null;
  const list = categories(kind);
  const exact = list.find((c) => norm(c.name) === t);
  if (exact) return exact.id;
  for (const [re, name] of BANK_CATS) {
    if (re.test(t)) {
      const c = list.find((x) => norm(x.name) === norm(name));
      if (c) return c.id;
    }
  }
  return null;
}

export function buildRows(rows, { headerIndex, map }, { invert = false, XLSX = null } = {}) {
  const out = [];
  let skipped = 0;
  for (const r of rows.slice(headerIndex + 1)) {
    const date = parseDateCell(r[map.date], XLSX);
    let cents = NaN;
    if (map.amount >= 0) cents = parseMoneyCell(r[map.amount]);
    else {
      const d = map.debit >= 0 ? parseMoneyCell(r[map.debit]) : NaN;
      const c = map.credit >= 0 ? parseMoneyCell(r[map.credit]) : NaN;
      cents = (Number.isNaN(c) ? 0 : Math.abs(c)) - (Number.isNaN(d) ? 0 : Math.abs(d));
      if (Number.isNaN(d) && Number.isNaN(c)) cents = NaN;
    }
    const descRaw = map.desc >= 0 ? String(r[map.desc] ?? '').trim() : '';
    if (!date || Number.isNaN(cents) || !cents || /^(saldo|total)\b/i.test(descRaw)) {
      skipped++;
      continue;
    }
    // Revolut: solo lo completado, y la comisión cuenta como gasto.
    if (map.state >= 0) {
      const st = norm(r[map.state]);
      if (st && !/^(completed|completado|completada)$/.test(st)) {
        skipped++;
        continue;
      }
    }
    if (map.fee >= 0) {
      const fee = parseMoneyCell(r[map.fee]);
      if (!Number.isNaN(fee)) cents -= Math.abs(fee);
    }
    if (invert) cents = -cents;
    const extra = map.extra.map((i) => String(r[i] ?? '').trim()).filter((x) => x && x !== descRaw);
    const original = [descRaw, ...extra].filter(Boolean).join(' · ');
    const kind = cents < 0 ? 'expense' : 'income';
    const t = norm(original);
    out.push({
      date, kind, amount: Math.abs(cents), original,
      description: cleanConcept(descRaw || extra[0] || ''),
      method: methodOf(original, kind),
      bankCat: [map.bankcat, map.subcat].filter((i) => i >= 0).map((i) => String(r[i] ?? '')).join(' '),
      atm: kind === 'expense' && /\b(cajero|reintegro|retirada efectivo|disposicion efectivo|disp efectivo)\b/.test(t),
      own: /\btraspaso\b/.test(t),
    });
  }
  return { list: out, skipped };
}

// ---------- Pantalla ----------
export function openBankImport(file = null) {
  if (file) return start(file);
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.txt,.xls,.xlsx,.ods,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  input.onchange = () => input.files[0] && start(input.files[0]);
  input.click();
}

async function start(file) {
  let parsed;
  try {
    parsed = await readFile(file);
  } catch (e) {
    return toastError(new Error(`No se puede leer «${file.name}»: ${e.message}`));
  }
  const rows = parsed.rows.map((r) => (Array.isArray(r) ? r : []));
  if (rows.length < 2) return toastError(new Error('El archivo no tiene movimientos'));
  let det = detect(rows, file.name);
  if (!det.map) {
    // Formato desconocido: se empieza con una suposición y se deja elegir las columnas.
    const width = Math.max(...rows.slice(0, 10).map((r) => r.length));
    det = { headerIndex: 0, map: { date: 0, desc: Math.min(1, width - 1), amount: width - 1, debit: -1, credit: -1, bankcat: -1, subcat: -1, state: -1, fee: -1, extra: [] }, bank: det.bank, unknown: true };
  }
  importSheet(file, rows, det, parsed.XLSX);
}

const STATUS = {
  new: ['Nuevo', 'info'], exact: ['Ya anotado', 'paid'], possible: ['¿Ya anotado?', 'pending'], atm: ['Sacar dinero', 'plain'], own: ['Traspaso', 'plain'],
};

function importSheet(file, rows, det, XLSX) {
  let invert = false;
  let items = [];
  let filter = 'all';
  let shown = 100;
  const head = rows[det.headerIndex] || [];
  const colOptions = (key, optional) => html`<select class="select sm" data-col="${key}">
    ${optional ? html`<option value="-1">— Ninguna —</option>` : ''}
    ${head.map((h, i) => html`<option value="${i}" ${det.map[key] === i ? 'selected' : ''}>${String(h || `Columna ${i + 1}`).slice(0, 40)}</option>`)}</select>`;

  const s = sheet({
    title: 'Importar del banco',
    size: 'wide',
    className: 'bank-import',
    body: html`<div class="stack" style="gap:14px">
      <div class="bi-head">
        ${det.bank ? html`<span class="bank-chip" style="--c:${det.bank.color}"><i></i>${det.bank.name}</span>` : html`<span class="bank-chip"><i></i>${det.unknown ? 'Formato sin reconocer' : 'Formato reconocido'}</span>`}
        <span class="small muted ellipsis" data-range>${file.name}</span>
      </div>
      ${det.unknown ? html`<div class="ha-alert info">${icon('info', 'sm')}<span>No reconozco este archivo. Indica abajo qué columna es la fecha, el concepto y el importe.</span></div>` : ''}
      <div class="bi-stats" data-stats></div>
      <div class="bi-list" data-list><div class="skeleton" style="height:240px"></div></div>
      <details class="bi-cols" ${det.unknown ? 'open' : ''}><summary>${icon('sliders-horizontal', 'sm')}Columnas del archivo</summary>
        <div class="grid-3" style="margin-top:10px">
          <div class="field"><label>Fecha</label>${colOptions('date')}</div>
          <div class="field"><label>Concepto</label>${colOptions('desc', true)}</div>
          <div class="field"><label>Importe</label>${colOptions('amount', true)}</div>
          ${det.map.amount < 0 ? html`<div class="field"><label>Cargos</label>${colOptions('debit', true)}</div>
            <div class="field"><label>Abonos</label>${colOptions('credit', true)}</div>` : ''}
        </div>
        <label class="switch" style="margin-top:12px"><input type="checkbox" data-invert><span class="track"></span>
          <span class="txt">Los gastos vienen en positivo<small>Actívalo si tu banco no pone el signo menos a los cargos.</small></span></label>
      </details>
    </div>`,
    foot: html`<span class="small muted grow" data-foot-sum></span><button class="btn" data-close>Cancelar</button>
      <button class="btn primary" data-act="go">${icon('upload')}Importar</button>`,
  });

  const catOptions = (kind, selected) => html`<option value="">Sin categoría</option>${categories(kind).map((c) => html`<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.icon} ${c.name}</option>`)}`;

  async function analyse() {
    const { list, skipped } = buildRows(rows, det, { invert, XLSX });
    items = list.map((x, i) => ({ ...x, i, include: true, status: 'new', catSource: null, category_id: null }));
    $('[data-list]', s.el).innerHTML = '<div class="skeleton" style="height:240px"></div>';
    if (items.length) {
      const dates = items.map((x) => x.date).sort();
      $('[data-range]', s.el).textContent = `${file.name} · ${plural(items.length, 'movimiento', 'movimientos')} del ${fmtDate(dates[0])} al ${fmtDate(dates.at(-1))}${skipped ? ` · ${skipped} filas sin fecha o importe` : ''}`;
      try {
        const [checks, guesses] = await Promise.all([
          post('/transactions/import/check', { rows: items.map((x) => ({ date: x.date, amount: x.amount, kind: x.kind, description: x.original })) }),
          post('/rules/categorize', { items: items.map((x) => ({ text: x.original, kind: x.kind })) }),
        ]);
        items.forEach((x, k) => {
          const c = checks[k];
          if (c) {
            x.status = c.status;
            x.match = c;
          } else if (x.atm) x.status = 'atm';
          else if (x.own) x.status = 'own';
          x.include = x.status === 'new';
          const g = guesses[k] || {};
          x.key = g.key;
          x.category_id = g.category_id || bankCategory(x.bankCat, x.kind);
          x.catSource = g.category_id ? g.source : x.category_id ? 'bank' : null;
        });
      } catch (e) {
        toastError(e);
      }
    } else $('[data-range]', s.el).textContent = `${file.name} · no se encuentran movimientos con estas columnas`;
    draw();
  }

  const visible = () => items.filter((x) => filter === 'all' || (filter === 'nocat' ? !x.category_id && x.include : filter === 'skip' ? ['exact', 'possible', 'atm', 'own'].includes(x.status) : x.status === filter));

  function drawStats() {
    const n = (st) => items.filter((x) => x.status === st).length;
    const sel = items.filter((x) => x.include);
    const exp = sel.filter((x) => x.kind === 'expense').reduce((a, x) => a + x.amount, 0);
    const inc = sel.filter((x) => x.kind === 'income').reduce((a, x) => a + x.amount, 0);
    const nocat = sel.filter((x) => !x.category_id).length;
    const tile = (key, label, value, hint) => html`<button type="button" class="bi-stat ${filter === key ? 'on' : ''}" data-filter="${key}">
      <b>${value}</b><span>${label}</span>${hint ? html`<small>${hint}</small>` : ''}</button>`;
    $('[data-stats]', s.el).innerHTML = String(html`
      ${tile('all', 'Todos', items.length)}
      ${tile('new', 'Nuevos', n('new'))}
      ${tile('skip', 'Se omiten', n('exact') + n('possible') + n('atm') + n('own'), n('possible') ? `${n('possible')} por revisar` : '')}
      ${tile('nocat', 'Sin categoría', nocat)}`);
    $('[data-foot-sum]', s.el).textContent = sel.length
      ? `${plural(sel.length, 'movimiento', 'movimientos')}: −${money(exp)} en gastos${inc ? ` y +${money(inc)} en ingresos` : ''}`
      : 'Nada marcado para importar';
    const go = $('[data-act=go]', s.el);
    go.disabled = !sel.length;
    go.innerHTML = String(html`${icon('upload')}${sel.length ? `Importar ${sel.length}` : 'Importar'}`);
  }

  function rowHTML(x) {
    const [label, tone] = STATUS[x.status] || STATUS.new;
    const why = x.status === 'possible' && x.match ? `Parecido a «${x.match.description}» del ${fmtDate(x.match.date)}`
      : x.status === 'exact' ? 'Ya está en tus movimientos' : x.status === 'atm' ? 'Sacar del cajero no es un gasto en sí: anota luego en qué lo gastas'
        : x.status === 'own' ? 'Movimiento entre tus cuentas' : '';
    return html`<div class="bi-row ${x.include ? '' : 'off'}" data-i="${x.i}">
      <label class="bi-check"><input type="checkbox" ${x.include ? 'checked' : ''} aria-label="Importar ${x.description}"></label>
      <div class="bi-main">
        <div class="bi-desc ellipsis">${x.description || x.original || 'Sin concepto'}</div>
        <div class="bi-meta"><span>${fmtDate(x.date)}</span>${x.original && x.original !== x.description ? html`<span class="ellipsis">${x.original}</span>` : ''}</div>
        ${x.status !== 'new' ? html`<span class="pill ${tone}" title="${why}">${label}</span>` : ''}
      </div>
      <div class="bi-cat"><select class="select sm" data-cat aria-label="Categoría">${catOptions(x.kind, x.category_id)}</select>
        ${x.catSource && x.catSource !== 'user' ? html`<small>${x.catSource === 'builtin' ? 'sugerida' : x.catSource === 'bank' ? 'del banco' : 'como otras veces'}</small>` : ''}</div>
      <div class="bi-amt ${x.kind === 'income' ? 'income' : ''}">${x.kind === 'income' ? '+' : '−'}${money(x.amount)}</div>
    </div>`;
  }

  function draw() {
    drawStats();
    const list = visible();
    const box = $('[data-list]', s.el);
    box.innerHTML = list.length
      ? String(html`${list.slice(0, shown).map(rowHTML)}${list.length > shown ? html`<button type="button" class="btn block" data-more>Ver ${Math.min(100, list.length - shown)} más (de ${list.length - shown})</button>` : ''}`)
      : String(html`<p class="small muted" style="padding:16px">Nada que mostrar con este filtro.</p>`);
  }

  on(s.el, 'click', '[data-filter]', (e, b) => {
    filter = b.dataset.filter;
    shown = 100;
    draw();
  });
  on(s.el, 'click', '[data-more]', () => {
    shown += 100;
    draw();
  });
  on(s.el, 'change', '.bi-check input', (e, inp) => {
    const x = items[Number(inp.closest('[data-i]').dataset.i)];
    x.include = inp.checked;
    inp.closest('.bi-row').classList.toggle('off', !x.include);
    drawStats();
  });
  // Al corregir una categoría se aplica también al resto de movimientos del mismo comercio.
  on(s.el, 'change', '[data-cat]', (e, sel) => {
    const x = items[Number(sel.closest('[data-i]').dataset.i)];
    x.category_id = sel.value ? Number(sel.value) : null;
    x.catSource = 'user';
    let same = 0;
    if (x.key) {
      for (const y of items) {
        if (y !== x && y.key === x.key && y.kind === x.kind && y.catSource !== 'user') {
          y.category_id = x.category_id;
          y.catSource = 'user';
          same++;
        }
      }
    }
    if (same) {
      draw();
      toast(`Aplicado también a ${plural(same, 'movimiento', 'movimientos')} de ${x.description}`, { iconName: 'check-check' });
    } else drawStats();
  });
  on(s.el, 'change', '[data-col]', (e, sel) => {
    det.map[sel.dataset.col] = Number(sel.value);
    det.map.extra = det.map.extra.filter((i) => !Object.values(det.map).includes(i));
    analyse();
  });
  on(s.el, 'change', '[data-invert]', (e, inp) => {
    invert = inp.checked;
    analyse();
  });
  on(s.el, 'click', '[data-act=go]', (e, b) => withBusy(b, async () => {
    const sel = items.filter((x) => x.include);
    if (!sel.length) return;
    const payload = sel.map((x) => ({
      kind: x.kind, amount: x.amount, date: x.date, description: x.description.slice(0, 120), category_id: x.category_id, method: x.method,
      notes: x.original && x.original !== x.description ? x.original.slice(0, 1000) : '',
    }));
    try {
      let done = 0;
      for (let k = 0; k < payload.length; k += 1000) {
        const r = await post('/transactions/import', { rows: payload.slice(k, k + 1000) });
        done += r.imported;
      }
      notifyChange('transactions');
      const dates = sel.map((x) => x.date).sort();
      toast(`${plural(done, 'movimiento importado', 'movimientos importados')}`, {
        action: { label: 'Ver', fn: () => (location.hash = `#/movimientos?from=${dates[0]}&to=${dates.at(-1)}`) },
      });
      s.close(true);
    } catch (err) {
      toastError(err);
    }
  }));
  analyse();
}

export const isBankFile = (f) => /\.(csv|txt|xlsx?|ods)$/i.test(f?.name || '');
