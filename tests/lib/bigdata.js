// Un hogar con muchos datos para las pruebas de volumen: años de movimientos de cuatro personas, pagos fijos que se
// anotan solos, una compra a plazos, nóminas que cambian, facturas, metas, cientos de productos con precios, notas y
// una lista larga. Los datos salen de un generador con semilla: siempre los mismos. Lleva a propósito casos difíciles
// (importes enormes y de un céntimo, comercios con mayúsculas y acentos, notas con «;», comillas y saltos de línea).
import Database from 'better-sqlite3';
import { join, newUser } from './client.js';

const H = '/api/h/1';
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
};

// Números pseudoaleatorios repetibles (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = ['Mercadona', 'MERCADONA', 'mercadona', 'Lidl', 'Carrefour', 'Café Ñandú', 'CAFÉ ÑANDÚ', 'Repsol', 'Amazon', 'Farmacia López',
  'Panadería Ruiz', 'Zara', 'Decathlon', 'Renfe', ''];
const DESCRIPTIONS = ['Compra semanal', 'Café con leche', 'Gasolina', 'Cena', 'Farmacia', 'Ropa', 'Regalo', 'Libro', 'Taxi', 'Parking', 'Peluquería',
  'Cine', 'Material escolar', 'Pan', 'Fruta', ''];
const METHODS = ['card', 'card', 'card', 'cash', 'transfer', 'direct_debit', 'bizum', 'other', null];

export async function bigHousehold(srv, { years = 6, perDay = 24, seed = 7 } = {}) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const t0 = Date.now();
  const ana = await newUser(srv.base, 'ana', 'Ana');
  const beto = await newUser(srv.base, 'beto', 'Beto');
  await join(ana, beto, 'editor');
  // Beto ya es una persona del hogar al unirse; se añaden los demás.
  const existing = (await ana.ok('GET', H)).people.map((p) => p.name);
  for (const name of ['Beto', 'Hugo', 'Sara'].filter((x) => !existing.includes(x))) await ana.ok('POST', `${H}/people`, { name });
  // Categorías nuevas con presupuesto y un presupuesto mensual total.
  for (const [name, budget] of [['Ocio', 25000], ['Coche', 30000], ['Niños', 20000]]) {
    await ana.ok('POST', `${H}/categories`, { kind: 'expense', name, budget });
  }
  await ana.ok('PATCH', H, { name: 'Casa de pruebas', currency: 'EUR', monthly_budget: 320000 });
  const pets = [];
  for (const [name, species] of [['Luna', 'dog'], ['Michi', 'cat']]) pets.push((await ana.ok('POST', `${H}/pets`, { name, species })).id);
  const house = await ana.ok('GET', H);
  const people = house.people.map((p) => p.id);
  const expenseCats = house.categories.filter((c) => c.kind === 'expense').map((c) => c.id);
  const incomeCats = house.categories.filter((c) => c.kind === 'income').map((c) => c.id);

  // ---------- Movimientos sueltos ----------
  const today = ymd(new Date());
  const first = `${new Date().getFullYear() - years + 1}-01-01`;
  const rows = [];
  const money = (min, max) => Math.round(min + (max - min) * r());
  for (let d = first; d <= today; d = addDays(d, 1)) {
    const weekend = [0, 6].includes(new Date(`${d}T12:00`).getDay());
    const n = Math.round(perDay * (weekend ? 1.3 : 0.85) * (0.4 + r() * 1.2));
    for (let i = 0; i < n; i++) {
      // Importes con forma real: muchos pequeños y algunos grandes.
      const amount = Math.max(1, Math.round(Math.exp(r() * Math.log(30000))));
      rows.push({
        kind: 'expense', amount, date: d, category_id: r() < 0.06 ? null : pick(expenseCats), description: pick(DESCRIPTIONS), merchant: pick(MERCHANTS),
        person_id: r() < 0.2 ? null : pick(people), pet_id: r() < 0.04 ? pick(pets) : null, method: pick(METHODS),
      });
    }
    // Nóminas el 28, distintas cada mes, y algún ingreso extra.
    if (d.endsWith('-28')) {
      [180000, 150000, 120000].forEach((base, k) => rows.push({
        kind: 'income', amount: Math.round(base * (0.9 + r() * 0.2)), date: d, category_id: incomeCats[0] ?? null, description: 'Nómina',
        merchant: ['Empresa A', 'Empresa B', 'Ayuntamiento'][k], person_id: people[k], method: 'transfer',
      }));
    }
    if (r() < 0.06) rows.push({ kind: 'income', amount: money(5000, 80000), date: d, category_id: pick(incomeCats) ?? null, description: 'Extra', merchant: '', method: 'bizum' });
  }
  // Casos difíciles.
  const y = new Date().getFullYear() - 1;
  rows.push(
    { kind: 'income', amount: 25000000, date: `${y}-06-15`, category_id: incomeCats[0] ?? null, description: 'Venta del piso', merchant: 'Notaría', method: 'transfer' },
    { kind: 'expense', amount: 12000000, date: `${y}-06-20`, category_id: expenseCats[0], description: 'Entrada de la casa', merchant: 'Notaría', method: 'transfer' },
    { kind: 'expense', amount: 1, date: today, category_id: expenseCats[1], description: 'Redondeo', merchant: 'Hucha', method: 'card' },
    { kind: 'expense', amount: 1234, date: today, category_id: expenseCats[2], description: '=SUMA(A1:A9)', merchant: '@hack', notes: 'Pagado con "tarjeta"; ver ticket\nsegunda línea', method: 'card' },
  );
  // Algún gasto con fecha futura dentro de este mes (anotado por adelantado).
  const monthEnd = ymd(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0));
  if (today < monthEnd) rows.push({ kind: 'expense', amount: 4500, date: monthEnd, category_id: expenseCats[0], description: 'Reserva', merchant: 'Hotel', method: 'card' });

  const tImport = Date.now();
  for (let i = 0; i < rows.length; i += 5000) await ana.ok('POST', `${H}/transactions/import`, { rows: rows.slice(i, i + 5000) });
  const importMs = Date.now() - tImport;

  // ---------- Pagos fijos (los automáticos se anotan solos con su historia) ----------
  const ago = (months) => {
    const dt = new Date();
    dt.setMonth(dt.getMonth() - months, 5);
    return ymd(dt);
  };
  const recurring = [
    { kind: 'expense', name: 'Hipoteca', amount: 65000, frequency: 'monthly', start_date: ago(36), auto: true, category_id: expenseCats[0], method: 'direct_debit' },
    { kind: 'expense', name: 'Netflix', amount: 1799, frequency: 'monthly', start_date: ago(24), auto: true, category_id: expenseCats[3], method: 'card' },
    { kind: 'expense', name: 'Seguro del coche', amount: 48000, frequency: 'annual', start_date: ago(48), auto: true, category_id: expenseCats[4] },
    { kind: 'expense', name: 'Agua', amount: 4500, variable: true, frequency: 'bimonthly', start_date: ago(24), auto: true, category_id: expenseCats[5] },
    { kind: 'expense', name: 'Gimnasio', amount: 3990, frequency: 'monthly', start_date: addDays(today, 7), auto: false, category_id: expenseCats[3] },
    { kind: 'income', name: 'Nómina', amount: 180000, variable: true, frequency: 'monthly', start_date: monthEnd, auto: false, person_id: people[0] },
    { kind: 'income', name: 'Nómina', amount: 150000, variable: true, frequency: 'monthly', start_date: monthEnd, auto: false, person_id: people[1] },
  ];
  for (const rec of recurring) await ana.ok('POST', `${H}/recurring`, rec);
  await ana.ok('POST', `${H}/recurring`, {
    kind: 'expense', plan: 'installment', name: 'Sofá', total_amount: 120000, installments: 12, frequency: 'monthly', start_date: ago(6), auto: true,
    category_id: expenseCats[0], purchase_date: ago(6),
  });
  await ana.ok('GET', `${H}/recurring`); // anota las cuotas atrasadas de los automáticos

  // ---------- Facturas, metas, precios, notas y compra ----------
  for (let i = 0; i < 40; i++) {
    const due = addDays(today, i < 30 ? -30 * (i + 1) : 3 + i);
    await ana.ok('POST', `${H}/bills`, {
      supplier: pick(['Canal de Isabel II', 'Movistar', 'Mapfre', 'Comunidad']), concept: `Recibo ${i + 1}`, amount: money(2000, 30000),
      due_date: due, category_id: pick(expenseCats), ...(i < 30 ? { status: 'paid', paid_date: due } : {}),
    });
  }
  for (const [name, target] of [['Vacaciones', 300000], ['Coche nuevo', 1500000], ['Colchón', 600000]]) {
    const g = await ana.ok('POST', `${H}/goals`, { name, target });
    for (let i = 0; i < 70; i++) await ana.ok('POST', `${H}/goals/${g.id}/moves`, { amount: r() < 0.85 ? money(1000, 30000) : -money(500, 10000), date: addDays(today, -i * 9) });
  }
  const stores = ['Mercadona', 'Lidl', 'Carrefour', 'Dia', 'Alcampo'];
  const priceItems = [];
  for (let p = 0; p < 300; p++) {
    const base = money(50, 2500);
    const perKg = p % 7 === 0;
    for (const st of stores) {
      for (let k = 0; k < 4; k++) {
        priceItems.push({
          product: `Producto ${p + 1}`, store: st, price: Math.round(base * (0.85 + r() * 0.3)), qty: perKg ? 1 : 1, unit: perKg ? 'kg' : 'ud',
          date: addDays(today, -k * 120), offer: r() < 0.05,
        });
      }
    }
  }
  for (let i = 0; i < priceItems.length; i += 200) await ana.ok('POST', `${H}/prices/bulk`, { items: priceItems.slice(i, i + 200) });
  const meta = await ana.ok('GET', `${H}/notes/meta`);
  const books = meta.books.map((b) => b.id);
  for (let i = 0; i < 400; i++) {
    await ana.ok('POST', `${H}/notes`, {
      book_id: books[i % books.length], title: `Nota ${i + 1}${i % 50 === 0 ? ' — receta de lentejas' : ''}`,
      body: `Texto de la nota ${i + 1}.\n\n- [ ] tarea\n- [x] hecha\n\n${'Lorem ipsum dolor sit amet. '.repeat(1 + (i % 6))}`, tags: i % 3 ? ['casa'] : ['casa', 'compras'],
    });
  }
  const list = await ana.ok('POST', `${H}/shopping/lists`, { name: 'Grande', store: 'Mercadona' });
  for (let i = 0; i < 120; i += 20) {
    await ana.ok('POST', `${H}/shopping/lists/${list.id}/items`, { name: Array.from({ length: 20 }, (_, k) => `Cosa ${i + k + 1}`).join(', ') });
  }

  return { ana, beto, rows: rows.length, importMs, totalMs: Date.now() - t0, first, today, people, pets, expenseCats, incomeCats };
}

// Lo que hay de verdad en la base de datos, leído directamente (sin pasar por la app): la referencia de las pruebas.
export function snapshot(dbFile) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const out = {
    tx: db.prepare('SELECT * FROM transactions WHERE household_id = 1').all(),
    categories: db.prepare('SELECT * FROM categories WHERE household_id = 1').all(),
    people: db.prepare('SELECT * FROM people WHERE household_id = 1').all(),
    pets: db.prepare('SELECT * FROM pets WHERE household_id = 1').all(),
    recurring: db.prepare('SELECT * FROM recurring WHERE household_id = 1').all(),
    goals: db.prepare('SELECT g.*, (SELECT COALESCE(SUM(amount), 0) FROM goal_moves m WHERE m.goal_id = g.id) AS saved FROM goals g WHERE household_id = 1').all(),
    moves: db.prepare('SELECT * FROM goal_moves WHERE household_id = 1').all(),
  };
  db.close();
  return out;
}
