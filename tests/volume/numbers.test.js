// Con muchos datos (6 años, ~50.000 movimientos), cada número que enseña la app cuadra con la suma hecha aparte a
// partir de la base de datos (sin pasar por el código de la app), y nada tarda demasiado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser } from '../lib/client.js';
import { addDays, bigHousehold, snapshot } from '../lib/bigdata.js';

const H = '/api/h/1';
const YEARS = Number(process.env.VOLUME_YEARS || 6);
let srv;
let big;
let ana;
let S; // lo que hay de verdad en la base de datos
const timings = [];

// ---------- Utilidades de la referencia ----------
const pad = (n) => String(n).padStart(2, '0');
const monthOf = (d) => d.slice(0, 7);
const shift = (m, k) => {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + mo - 1 + k;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
const bounds = (m) => {
  const [y, mo] = m.split('-').map(Number);
  const days = new Date(y, mo, 0).getDate();
  return { start: `${m}-01`, end: `${m}-${pad(days)}`, days };
};
const inRange = (from, to) => (t) => t.date >= from && t.date <= to;
const sum = (arr) => arr.reduce((s, t) => s + t.amount, 0);
const kinds = (rows) => ({ expense: sum(rows.filter((t) => t.kind === 'expense')), income: sum(rows.filter((t) => t.kind === 'income')), count: rows.length });
const group = (rows, keyFn) => {
  const m = new Map();
  for (const t of rows) {
    const k = keyFn(t);
    const g = m.get(k) || { total: 0, n: 0 };
    g.total += t.amount;
    g.n += 1;
    m.set(k, g);
  }
  return m;
};
const asMap = (list, key = 'id') => new Map(list.map((x) => [x[key] ?? null, { total: x.total, n: x.n }]));
// Comparar dos mapas {clave → {total, n}} sin depender del orden.
const sameGroups = (got, want, what) => {
  const norm = (m) => [...m].map(([k, v]) => [String(k), v.total, v.n ?? null]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(norm(got), norm(want), what);
};
// Texto «normalizado»: sin acentos ni mayúsculas (como espera una persona al buscar o agrupar).
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

async function timed(label, method, path, body) {
  const t0 = performance.now();
  const data = await ana.ok(method, path, body);
  timings.push([label, Math.round(performance.now() - t0)]);
  return data;
}

before(async () => {
  srv = await startServer();
  big = await bigHousehold(srv, { years: YEARS });
  ana = big.ana;
  await ana.ok('GET', `${H}/stats/dashboard`); // anota lo que toque de los pagos fijos antes de mirar la base
  S = snapshot(srv.db);
  timings.push([`crear ${big.rows} movimientos (importación)`, big.importMs]);
});
after(async () => {
  console.log(`\nTiempos con ${S?.tx.length} movimientos:\n${timings.map(([l, ms]) => `  ${String(ms).padStart(6)} ms  ${l}`).join('\n')}`);
  await srv?.stop();
});

const TODAY = () => big.today;
const CM = () => monthOf(big.today);

test('se han guardado todos los movimientos', () => {
  const imported = S.tx.filter((t) => !t.recurring_id && !t.bill_id);
  assert.equal(imported.length, big.rows);
  assert.ok(S.tx.length > big.rows, 'más los de pagos fijos y facturas');
});

test('Inicio: totales, categorías, presupuestos, gasto por día, 12 meses y previsión de varios meses', async () => {
  const first = monthOf(big.first);
  for (const m of [CM(), shift(CM(), -1), shift(CM(), -13), first]) {
    const d = await timed(`Inicio (${m})`, 'GET', `${H}/stats/dashboard?month=${m}`);
    const { start, end, days } = bounds(m);
    const rows = S.tx.filter(inRange(start, end));
    const k = kinds(rows);
    assert.deepEqual(d.totals, k, `${m}: totales`);
    const exp = rows.filter((t) => t.kind === 'expense');
    sameGroups(asMap(d.byCategory), group(exp, (t) => t.category_id), `${m}: por categoría`);
    const byCat = group(exp, (t) => t.category_id);
    for (const b of d.budgets) assert.equal(b.total, byCat.get(b.id)?.total || 0, `${m}: presupuesto de ${b.name}`);
    const daily = new Array(days).fill(0);
    for (const t of exp) daily[Number(t.date.slice(8)) - 1] += t.amount;
    assert.deepEqual(d.daily, daily, `${m}: gasto por día`);
    for (let i = 0; i < 12; i++) {
      const mm = shift(m, i - 11);
      const r = kinds(S.tx.filter(inRange(bounds(mm).start, bounds(mm).end)));
      assert.deepEqual(d.trend[i], { month: mm, expense: r.expense, income: r.income }, `${m}: tendencia ${mm}`);
    }
    if (m === CM()) {
      const dayNow = Number(TODAY().slice(8));
      const pm = shift(m, -1);
      const same = `${pm}-${pad(Math.min(dayNow, bounds(pm).days))}`;
      const prevTo = kinds(S.tx.filter(inRange(bounds(pm).start, same)));
      assert.equal(d.prevSameDay, prevTo.expense, 'mes anterior hasta el mismo día');
      assert.equal(d.prevSameDayIncome, prevTo.income);
      const soFar = sum(exp.filter((t) => t.date <= TODAY() && !t.recurring_id && !t.bill_id));
      const rest = Math.round((soFar / Math.max(dayNow, 1)) * (days - dayNow));
      assert.equal(d.forecast.variableRest, rest, 'previsión: lo del día a día que falta');
      assert.equal(d.forecast.total, k.expense + d.forecast.scheduled + rest, 'previsión: suma');
      assert.equal(d.forecast.expectedIncome, 180000 + 150000, 'previsión: las dos nóminas que faltan por cobrar');
      assert.equal(d.forecast.balance, k.income + d.forecast.expectedIncome - d.forecast.total);
    }
  }
});

test('Movimientos: los totales de la lista cuadran con cualquier filtro', async () => {
  const y2 = `${Number(big.first.slice(0, 4)) + 1}`;
  const [c1, c2] = big.expenseCats;
  const p = big.people[1];
  const cases = [
    ['todo', '', () => true],
    ['gastos de un año', `kind=expense&from=${y2}-01-01&to=${y2}-12-31`, (t) => t.kind === 'expense' && t.date.startsWith(y2)],
    ['dos categorías y una persona', `category=${c1},${c2}&person=${p}`, (t) => [c1, c2].includes(t.category_id) && t.person_id === p],
    ['sin categoría', 'category=none', (t) => t.category_id === null],
    ['con mascota', 'pet=any', (t) => t.pet_id !== null],
    ['Bizum', 'method=bizum', (t) => t.method === 'bizum'],
    ['entre 10 y 50,50 €', 'min=10&max=50.5', (t) => t.amount >= 1000 && t.amount <= 5050],
    ['entre 10 y 50,50 € (con coma)', 'min=10&max=50%2C5', (t) => t.amount >= 1000 && t.amount <= 5050],
    ['pagos fijos', 'source=recurring', (t) => t.recurring_id !== null],
    ['facturas', 'source=bills', (t) => t.bill_id !== null],
  ];
  for (const [label, qs, fn] of cases) {
    const r = await timed(`Movimientos: ${label}`, 'GET', `${H}/transactions?${qs}&limit=1`);
    const want = kinds(S.tx.filter(fn));
    assert.deepEqual({ expense: r.expense, income: r.income, count: r.total }, want, label);
  }
});

test('Buscar no distingue mayúsculas ni acentos («nandu» encuentra «CAFÉ ÑANDÚ»)', async () => {
  const cats = new Map(S.categories.map((c) => [c.id, c.name]));
  for (const q of ['mercadona', 'MERCADONA', 'ñandú', 'nandu', 'cafe', 'Peluqueria']) {
    const r = await timed(`Buscar «${q}»`, 'GET', `${H}/transactions?q=${encodeURIComponent(q)}&limit=1`);
    const want = S.tx.filter((t) => [t.description, t.merchant, t.notes, cats.get(t.category_id)].some((f) => norm(f).includes(norm(q))));
    assert.equal(r.total, want.length, `«${q}»`);
  }
});

test('Movimientos: al pasar páginas no se repite ni se pierde ninguno (en cualquier orden)', async () => {
  const y = `${Number(big.first.slice(0, 4)) + 2}`;
  const want = S.tx.filter((t) => t.kind === 'expense' && t.date.startsWith(y)).map((t) => t.id).sort((a, b) => a - b);
  for (const sort of ['date_desc', 'date_asc', 'amount_desc', 'amount_asc']) {
    const ids = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await timed(`Página de 1000 (${sort})`, 'GET', `${H}/transactions?kind=expense&from=${y}-01-01&to=${y}-12-31&sort=${sort}&limit=1000&offset=${offset}`);
      ids.push(...r.items.map((t) => t.id));
      if (r.items.length < 1000) break;
    }
    assert.equal(new Set(ids).size, ids.length, `${sort}: sin repetidos`);
    assert.deepEqual(ids.sort((a, b) => a - b), want, `${sort}: están todos`);
  }
});

test('Análisis: último año, todo el histórico y un tramo raro cuadran en todas sus cifras', async () => {
  const end = bounds(CM()).end;
  for (const [label, from, to] of [
    ['último año', bounds(shift(CM(), -11)).start, end],
    ['todo', big.first, end],
    ['tramo raro', `${Number(big.first.slice(0, 4)) + 1}-03-15`, `${Number(big.first.slice(0, 4)) + 2}-02-10`],
  ]) {
    const a = await timed(`Análisis (${label})`, 'GET', `${H}/stats/analytics?from=${from}&to=${to}`);
    const rows = S.tx.filter(inRange(from, to));
    const exp = rows.filter((t) => t.kind === 'expense');
    assert.deepEqual(a.totals, kinds(rows), `${label}: totales`);
    for (const mo of a.monthly) {
      const r = kinds(rows.filter((t) => monthOf(t.date) === mo.month));
      assert.deepEqual([mo.expense, mo.income], [r.expense, r.income], `${label}: mes ${mo.month}`);
    }
    assert.equal(a.monthly.length, Math.min(120, (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1));
    sameGroups(asMap(a.byCategory), group(exp, (t) => t.category_id), `${label}: gasto por categoría`);
    sameGroups(asMap(a.incomeByCategory), group(rows.filter((t) => t.kind === 'income'), (t) => t.category_id), `${label}: ingresos por categoría`);
    for (const c of a.monthlyByCategory) {
      const want = a.months.map((mm) => sum(exp.filter((t) => t.category_id === c.id && monthOf(t.date) === mm)));
      assert.deepEqual(c.values, want, `${label}: ${c.name} mes a mes`);
    }
    const effTo = to < TODAY() ? to : TODAY();
    const wdDays = new Array(7).fill(0);
    for (let d = from; d <= effTo; d = addDays(d, 1)) wdDays[new Date(`${d}T12:00`).getDay()]++;
    const wd = group(exp, (t) => new Date(`${t.date}T12:00`).getDay());
    for (const w of a.weekday) {
      const g = wd.get(w.wd) || { total: 0, n: 0 };
      assert.deepEqual([w.total, w.n, w.avg], [g.total, g.n, wdDays[w.wd] ? Math.round(g.total / wdDays[w.wd]) : 0], `${label}: día ${w.wd}`);
    }
    sameGroups(new Map(a.daily.map((x) => [x.date, { total: x.total, n: x.n }])), group(exp, (t) => t.date), `${label}: por día`);
    sameGroups(asMap(a.byPerson), group(exp, (t) => t.person_id), `${label}: por persona`);
    sameGroups(asMap(a.byMethod, 'method'), group(exp, (t) => t.method || 'none'), `${label}: por forma de pago`);
    sameGroups(asMap(a.byPet), group(exp.filter((t) => t.pet_id), (t) => t.pet_id), `${label}: por mascota`);
    // Comercios: «Mercadona», «MERCADONA» y «mercadona» son el mismo; «Café Ñandú» y «CAFÉ ÑANDÚ», también.
    const shops = [...group(exp, (t) => norm(t.merchant || t.description || 'Sin nombre'))].sort((x, y) => y[1].total - x[1].total).slice(0, 12);
    assert.deepEqual(a.merchants.map((x) => [norm(x.name), x.total, x.n]), shops.map(([k, v]) => [k, v.total, v.n]), `${label}: comercios`);
    const big8 = exp.filter((t) => !t.recurring_id && !t.bill_id).map((t) => t.amount).sort((x, y) => y - x).slice(0, 8);
    assert.deepEqual(a.biggest.map((x) => x.amount), big8, `${label}: los más grandes`);
    assert.deepEqual(a.sources, {
      recurring: sum(exp.filter((t) => t.recurring_id)), bills: sum(exp.filter((t) => t.bill_id)), shopping: sum(exp.filter((t) => t.list_id)),
      other: sum(exp.filter((t) => !t.recurring_id && !t.bill_id && !t.list_id)),
    }, `${label}: de dónde sale el gasto`);
    const year = Number(to.slice(0, 4));
    const yoy = (yy) => Array.from({ length: 12 }, (_, i) => sum(S.tx.filter((t) => t.kind === 'expense' && t.date.startsWith(`${yy}-${pad(i + 1)}`))));
    assert.deepEqual([a.yoy.current, a.yoy.previous], [yoy(year), yoy(year - 1)], `${label}: año contra año`);
  }
});

test('Resumen del mes: cifras, categorías, el día de más gasto, lo fijo y la racha', async () => {
  for (const m of [shift(CM(), -1), shift(CM(), -14), shift(CM(), -30)]) {
    const r = await timed(`Resumen (${m})`, 'GET', `${H}/stats/recap?month=${m}`);
    const { start, end } = bounds(m);
    const rows = S.tx.filter(inRange(start, end));
    const exp = rows.filter((t) => t.kind === 'expense');
    assert.deepEqual(r.totals, kinds(rows), `${m}: totales`);
    const pm = shift(m, -1);
    const prev = kinds(S.tx.filter(inRange(bounds(pm).start, bounds(pm).end)));
    assert.deepEqual([r.prev.expense, r.prev.income], [prev.expense, prev.income], `${m}: mes anterior`);
    const six = [1, 2, 3, 4, 5, 6].map((k) => kinds(S.tx.filter(inRange(bounds(shift(m, -k)).start, bounds(shift(m, -k)).end))).expense).filter(Boolean);
    assert.equal(r.avg6, six.length ? Math.round(six.reduce((a, b) => a + b, 0) / six.length) : null, `${m}: media de 6 meses`);
    const cats = [...group(exp, (t) => t.category_id)].sort((x, y) => y[1].total - x[1].total).slice(0, 6);
    const prevCats = group(S.tx.filter((t) => t.kind === 'expense' && t.date >= bounds(pm).start && t.date <= bounds(pm).end), (t) => t.category_id);
    assert.deepEqual(r.categories.map((c) => [c.id, c.total, c.prev]), cats.map(([id, v]) => [id, v.total, prevCats.get(id)?.total || 0]), `${m}: categorías`);
    for (const c of r.categories) assert.ok(Math.abs(c.share - c.total / r.totals.expense) < 1e-12);
    assert.equal(r.biggest.amount, Math.max(...exp.filter((t) => !t.estimate).map((t) => t.amount)), `${m}: el más grande`);
    const days = group(exp.filter((t) => !t.estimate && !t.recurring_id && !t.bill_id), (t) => t.date);
    const busiest = [...days].sort((x, y) => y[1].total - x[1].total)[0];
    assert.deepEqual([r.busiest.date, r.busiest.total], [busiest[0], busiest[1].total], `${m}: el día de más gasto`);
    const fixed = sum(exp.filter((t) => t.recurring_id || t.bill_id || t.estimate));
    assert.equal(r.fixed, fixed, `${m}: lo fijo`);
    const lastDay = end < TODAY() ? end : TODAY();
    assert.equal(r.daily, Math.round((r.totals.expense - fixed) / Number(lastDay.slice(8))), `${m}: gasto medio por día`);
    sameGroups(new Map(r.people.map((p) => [p.name, { total: p.total }])),
      new Map([...group(exp.filter((t) => t.person_id), (t) => S.people.find((p) => p.id === t.person_id).name)].map(([k, v]) => [k, { total: v.total }])), `${m}: por persona`);
    let streak = 0;
    for (let k = 0; k < 24; k++) {
      const x = kinds(S.tx.filter(inRange(bounds(shift(m, -k)).start, bounds(shift(m, -k)).end)));
      if (!x.income || x.income <= x.expense) break;
      streak++;
    }
    assert.equal(r.streak, streak, `${m}: racha de meses ahorrando`);
  }
});

test('CSV: mismas filas e importes que la lista, y los textos raros no se rompen', async () => {
  const y = big.first.slice(0, 4);
  const t0 = performance.now();
  const res = await ana.get(`${H}/transactions/export.csv`);
  timings.push(['CSV de todo', Math.round(performance.now() - t0)]);
  const csv = res.data.toString('utf8').replace(/^﻿/, '');
  // Lector de CSV con comillas (los textos con «;», comillas o saltos de línea van entre comillas).
  const recs = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (q) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ';') { row.push(cell); cell = ''; } else if (ch === '\r' && csv[i + 1] === '\n') { row.push(cell); recs.push(row); row = []; cell = ''; i++; } else cell += ch;
  }
  row.push(cell);
  recs.push(row);
  const [head, ...lines] = recs;
  assert.equal(head.length, 10);
  assert.equal(lines.length, S.tx.length);
  assert.ok(lines.every((l) => l.length === 10), 'todas las filas con 10 columnas');
  const cents = (s) => Math.round(Number(s.replace(',', '.')) * 100);
  const all = kinds(S.tx);
  assert.equal(lines.reduce((s, l) => s + cents(l[2]), 0), all.income - all.expense, 'importes con signo');
  const tricky = lines.find((l) => l[9].includes('segunda línea'));
  assert.equal(tricky[9], 'Pagado con "tarjeta"; ver ticket\nsegunda línea');
  // Un texto que empieza por «=» no puede convertirse en una fórmula al abrirlo en una hoja de cálculo.
  assert.ok(!lines.some((l) => [3, 4, 5, 6, 7, 9].some((i) => /^[=+@]/.test(l[i]) || /^-[^\d]/.test(l[i]))), 'sin fórmulas');
  assert.ok(lines.some((l) => l[4] === "'=SUMA(A1:A9)"));
  const r = await ana.ok('GET', `${H}/transactions?from=${y}-01-01&to=${y}-12-31&limit=1`);
  const yLines = lines.filter((l) => l[0].startsWith(y));
  assert.equal(yLines.length, r.total);
});

test('Pagos fijos y metas: lo pagado y lo ahorrado suman lo que hay', async () => {
  const recs = await timed('Pagos fijos', 'GET', `${H}/recurring`);
  for (const rec of recs) {
    const paid = S.tx.filter((t) => t.recurring_id === rec.id);
    assert.deepEqual([rec.total_paid, rec.times_paid, rec.last_paid], [sum(paid), paid.length, paid.length ? paid.map((t) => t.date).sort().at(-1) : null], rec.name);
  }
  const goals = await timed('Metas', 'GET', `${H}/goals`);
  for (const g of goals) assert.equal(g.saved, sum(S.moves.filter((m) => m.goal_id === g.id)), g.name);
  await timed('Calendario del mes', 'GET', `${H}/stats/calendar?month=${CM()}`);
  await timed('Avisos', 'GET', `${H}/stats/alerts`);
  await timed('Para que lo sepas (avisos inteligentes)', 'GET', `${H}/stats/insights`);
  await timed('Precios (300 productos)', 'GET', `${H}/prices`);
  await timed('Histórico de precios', 'GET', `${H}/prices/history`);
  await timed('Cesta', 'GET', `${H}/prices/basket`);
  await timed('Productos', 'GET', `${H}/products`);
  await timed('Notas (400)', 'GET', `${H}/notes`);
  await timed('Buscar en notas', 'GET', `${H}/notes?q=lentejas`);
});

test('Copia completa del hogar con todo esto: se restaura en otro servidor y cuadra', async () => {
  const t0 = performance.now();
  const copy = await ana.ok('GET', `${H}/data/export.json`);
  timings.push([`Exportar copia (${(JSON.stringify(copy).length / 1048576).toFixed(1)} MB)`, Math.round(performance.now() - t0)]);
  const srv2 = await startServer();
  try {
    const nueva = await newUser(srv2.base, 'ana', 'Ana');
    const t1 = performance.now();
    const r = await nueva.post(`${H}/data/import.json`, copy);
    timings.push(['Importar copia', Math.round(performance.now() - t1)]);
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
    const a = await nueva.ok('GET', `${H}/transactions?limit=1`);
    const all = kinds(S.tx);
    assert.deepEqual({ expense: a.expense, income: a.income, count: a.total }, all);
    assert.deepEqual(srv2.errors(), []);
  } finally {
    await srv2.stop();
  }
});

test('nada tarda demasiado', () => {
  const slow = timings.filter(([l, ms]) => !l.startsWith('crear') && !l.startsWith('Exportar') && !l.startsWith('Importar') && ms > 1000);
  assert.deepEqual(slow, [], 'más de 1 segundo');
});

test('el servidor no ha registrado errores', () => {
  assert.deepEqual(srv.errors(), []);
});
