// Datos de ejemplo realistas (familia con dos hijos, perra y gato) para explorar la aplicación.
import { all, insert, one, run } from './db.js';
import { addDays, addMonthsAnchored, nextOccurrence, today } from './util.js';
import { processDue } from './routes/recurring.js';
import { productId } from './catalog.js';
import { syncPowerDay } from './power.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function loadDemo(hid, user) {
  const rand = rng(20241024 + hid);
  const between = (a, b) => a + rand() * (b - a);
  const cents = (a, b) => Math.round(between(a, b) * 100);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const T = today();
  const start = addMonthsAnchored(T.slice(0, 7) + '-01', -13, 1);

  const cat = {};
  for (const c of all('SELECT id, name FROM categories WHERE household_id = ?', hid)) cat[c.name] = c.id;
  const C = (name) => cat[name] ?? null;

  run('UPDATE households SET monthly_budget = ? WHERE id = ?', 320000, hid);
  const budgets = { Supermercado: 65000, Restaurantes: 18000, 'Ropa y calzado': 15000, 'Ocio y suscripciones': 12000, Transporte: 26000, Salud: 8000 };
  for (const [n, b] of Object.entries(budgets)) run('UPDATE categories SET budget = ? WHERE id = ?', b, C(n));

  // Personas
  const me = one('SELECT id FROM people WHERE household_id = ? AND user_id = ?', hid, user.id)?.id
    ?? insert('people', { household_id: hid, name: user.display_name, emoji: '🙂', color: '#2347C5', user_id: user.id });
  const laura = insert('people', { household_id: hid, name: 'Laura', emoji: '👩', color: '#B5487A', sort: 1 });
  const lucia = insert('people', { household_id: hid, name: 'Lucía', emoji: '👧', color: '#0E9AA7', sort: 2 });
  const pablo = insert('people', { household_id: hid, name: 'Pablo', emoji: '👦', color: '#EB6834', sort: 3 });
  const adults = [me, me, laura];

  // Mascotas
  const luna = insert('pets', {
    household_id: hid, name: 'Luna', species: 'dog', breed: 'Golden retriever', sex: 'f', birth_date: '2019-04-12', color: '#EDA100',
    chip: '941000024587123', sterilized: 1, vet: 'Clínica veterinaria San Antón', vet_phone: '912 345 678', insurance: 'Santévet Básico',
    food: 'Pienso Advance Medium Adult, 2 tomas', notes: 'Alérgica al pollo. Le encanta nadar.',
  });
  const michi = insert('pets', {
    household_id: hid, name: 'Michi', species: 'cat', breed: 'Común europeo', sex: 'm', birth_date: '2021-09-03', color: '#5B6B82',
    chip: '941000031122907', sterilized: 1, vet: 'Clínica veterinaria San Antón', vet_phone: '912 345 678',
    food: 'Pienso esterilizados + latas los domingos', notes: 'No sale de casa.',
  });

  const tx = (d) => insert('transactions', { household_id: hid, created_by: user.id, method: 'card', ...d });
  const petEvent = (pet, type, title, date, next, extra = {}) => {
    let tid = null;
    if (extra.cost) {
      tid = tx({
        kind: 'expense', amount: extra.cost, date, description: `${pet === luna ? 'Luna' : 'Michi'}: ${title}`,
        merchant: 'Clínica veterinaria San Antón', category_id: C('Mascotas'), pet_id: pet,
      });
    }
    insert('pet_events', {
      pet_id: pet, household_id: hid, type, title, date, next_date: next, weight: extra.weight ?? null, notes: extra.notes ?? '',
      transaction_id: tid, created_by: user.id,
    });
  };

  // Historial de salud
  const yAgo = addDays(T, -340);
  petEvent(luna, 'vaccine', 'Rabia', yAgo, addDays(yAgo, 365), { cost: 3500 });
  petEvent(luna, 'vaccine', 'Polivalente', addDays(yAgo, 2), addDays(yAgo, 367), { cost: 4200 });
  petEvent(michi, 'vaccine', 'Trivalente felina', addDays(T, -300), addDays(T, 65), { cost: 3800 });
  petEvent(michi, 'vet', 'Revisión anual', addDays(T, -300), null, { cost: 3000, notes: 'Todo bien. Vigilar peso.' });
  for (let d = addDays(T, -360); d <= T; d = addDays(d, 91)) {
    const next = addDays(d, 91);
    petEvent(luna, 'deworming', 'Desparasitación interna', d, next, { cost: 1290 });
    petEvent(michi, 'deworming', 'Desparasitación interna', addDays(d, 3), addDays(next, 3), { cost: 990 });
  }
  let w = 28.4;
  for (let d = addDays(T, -380); d <= T; d = addDays(d, 32)) {
    w = Math.round((w + between(-0.35, 0.5)) * 10) / 10;
    petEvent(luna, 'weight', 'Peso', d, null, { weight: w });
  }
  let wc = 4.6;
  for (let d = addDays(T, -370); d <= T; d = addDays(d, 61)) {
    wc = Math.round((wc + between(-0.1, 0.15)) * 10) / 10;
    petEvent(michi, 'weight', 'Peso', d, null, { weight: wc });
  }
  petEvent(luna, 'vet', 'Otitis', addDays(T, -150), null, { cost: 6800, notes: 'Gotas Otomax 7 días.' });
  petEvent(luna, 'medication', 'Apoquel (alergia)', addDays(T, -60), addDays(T, 12), { cost: 4650 });

  // Pagos fijos (con historial automático desde hace 13 meses)
  const recur = (d) => insert('recurring', {
    household_id: hid, kind: 'expense', method: 'direct_debit', auto: 1, remind_days: 3, created_by: user.id, ...d,
    next_date: d.next_date || d.start_date,
  });
  const dayIn = (day) => `${start.slice(0, 8)}${String(day).padStart(2, '0')}`;
  recur({ name: 'Hipoteca', provider: 'Banco Santander', amount: 74218, frequency: 'monthly', start_date: dayIn(1), category_id: C('Vivienda'), person_id: me });
  recur({ name: 'Comunidad de vecinos', provider: 'Administración Ruiz', amount: 6500, frequency: 'monthly', start_date: dayIn(5), category_id: C('Vivienda') });
  recur({ name: 'Fibra y móviles', provider: 'Movistar', amount: 7490, frequency: 'monthly', start_date: dayIn(8), category_id: C('Teléfono e internet') });
  recur({ name: 'Netflix', provider: 'Netflix', amount: 1399, frequency: 'monthly', start_date: dayIn(14), category_id: C('Ocio y suscripciones'), method: 'card' });
  recur({ name: 'Spotify Familiar', provider: 'Spotify', amount: 2199, frequency: 'monthly', start_date: dayIn(20), category_id: C('Ocio y suscripciones'), method: 'card' });
  recur({ name: 'Gimnasio', provider: 'Basic-Fit', amount: 3499, frequency: 'fourweekly', start_date: dayIn(3), category_id: C('Gimnasio y deporte') ?? C('Salud'), person_id: laura });
  recur({ name: 'Inglés extraescolar', provider: 'Academia Oxford', amount: 4500, frequency: 'monthly', start_date: dayIn(2), category_id: C('Educación'), person_id: lucia });
  recur({ name: 'Peluquería de Luna', provider: 'Guau Estilistas', amount: 3500, frequency: 'bimonthly', start_date: dayIn(16), category_id: C('Mascotas'), pet_id: luna, method: 'card' });
  recur({ name: 'Pienso de Luna', provider: 'Tiendanimal', amount: 5490, frequency: 'monthly', start_date: dayIn(11), category_id: C('Mascotas'), pet_id: luna, method: 'card' });
  recur({ name: 'Seguro de hogar', provider: 'Mapfre', amount: 31240, frequency: 'annual', start_date: addDays(start, 95), category_id: C('Seguros') });
  recur({ name: 'Seguro del coche', provider: 'Línea Directa', amount: 48655, frequency: 'annual', start_date: addDays(start, 200), category_id: C('Seguros') });
  recur({ name: 'IBI', provider: 'Ayuntamiento', amount: 41280, frequency: 'annual', start_date: addDays(start, 160), category_id: C('Impuestos y tasas') });
  recur({ name: 'Seguro dental', provider: 'Sanitas', amount: 3890, frequency: 'quarterly', start_date: dayIn(10), category_id: C('Salud') });
  recur({ name: 'Nómina', provider: 'Empresa', kind: 'income', amount: 215000, frequency: 'monthly', start_date: dayIn(28), category_id: C('Nómina'), person_id: me, method: 'transfer' });
  recur({ name: 'Nómina Laura', provider: 'Hospital', kind: 'income', amount: 178000, frequency: 'monthly', start_date: dayIn(27), category_id: C('Nómina'), person_id: laura, method: 'transfer' });
  // Un pago manual (no automático) para ver avisos de pagos pendientes.
  recur({ name: 'Comedor escolar', provider: 'Colegio Santa Ana', amount: 12800, frequency: 'monthly', start_date: addDays(T, 4), category_id: C('Educación'), auto: 0, method: 'transfer' });

  // Compras a plazos
  const plan = (d) => {
    const financed = d.total_amount - (d.down_payment || 0);
    const amount = Math.round(financed / d.installments);
    let end = d.start_date;
    for (let i = 1; i < d.installments; i++) end = nextOccurrence('monthly', end, d.start_date);
    const id = insert('recurring', {
      household_id: hid, kind: 'expense', plan: 'installment', frequency: 'monthly', auto: 1, method: 'card', created_by: user.id,
      amount, end_date: end, next_date: d.start_date, purchase_date: d.purchase_date || d.start_date, ...d,
    });
    if (d.down_payment) {
      tx({ kind: 'expense', amount: d.down_payment, date: d.purchase_date, description: `${d.name} (entrada)`, merchant: d.provider, category_id: d.category_id, recurring_id: id });
    }
  };
  plan({ name: 'Frigorífico combi', provider: 'MediaMarkt', total_amount: 89900, down_payment: 9900, installments: 10, purchase_date: addMonthsAnchored(T, -4, 6), start_date: addMonthsAnchored(T, -3, 6), category_id: C('Hogar y reparaciones') });
  plan({ name: 'Móvil de Laura', provider: 'Movistar', total_amount: 100900, cash_price: 95900, installments: 24, start_date: addMonthsAnchored(T, -7, 12), category_id: C('Teléfono e internet'), person_id: laura, method: 'direct_debit' });
  plan({ name: 'Sofá chaise longue', provider: 'Muebles La Fábrica', total_amount: 118800, installments: 12, start_date: addMonthsAnchored(T, -13, 22), category_id: C('Hogar y reparaciones') });
  plan({ name: 'Ortodoncia de Lucía', provider: 'Clínica dental Sonríe', total_amount: 240000, down_payment: 30000, installments: 18, purchase_date: addMonthsAnchored(T, -2, 15), start_date: addMonthsAnchored(T, -1, 15), category_id: C('Salud'), person_id: lucia });

  // Movimientos del día a día
  for (let d = start; d <= T; d = addDays(d, 1)) {
    const dt = new Date(d + 'T12:00:00');
    const wd = dt.getDay();
    const m = dt.getMonth() + 1;
    const day = dt.getDate();
    const winter = [11, 12, 1, 2].includes(m);
    if (wd === 6 || (wd === 3 && rand() < 0.35)) {
      tx({ kind: 'expense', amount: cents(78, 148), date: d, description: 'Compra semanal', merchant: 'Mercadona', category_id: C('Supermercado'), person_id: pick(adults) });
    }
    if (rand() < 0.11) tx({ kind: 'expense', amount: cents(22, 64), date: d, description: 'Compra', merchant: pick(['Lidl', 'Lidl', 'Carrefour', 'Dia']), category_id: C('Supermercado'), person_id: pick(adults) });
    if (rand() < 0.16) tx({ kind: 'expense', amount: cents(3, 16), date: d, description: pick(['Fruta', 'Pan y bollería', 'Carnicería']), merchant: pick(['Frutería Paco', 'Panadería La Espiga', 'Carnicería Hnos. Gil']), category_id: C('Supermercado'), method: pick(['cash', 'card']) });
    if (rand() < 0.085) tx({ kind: 'expense', amount: cents(52, 78), date: d, description: 'Gasolina', merchant: pick(['Repsol', 'Cepsa', 'BP']), category_id: C('Transporte'), person_id: pick(adults) });
    if (day === 1) tx({ kind: 'expense', amount: 2000, date: d, description: 'Abono joven transporte', merchant: 'Consorcio de Transportes', category_id: C('Transporte'), person_id: lucia });
    if (rand() < 0.03) tx({ kind: 'expense', amount: cents(2, 12), date: d, description: 'Parking', merchant: 'Parking centro', category_id: C('Transporte'), method: 'card' });
    if ((wd === 5 || wd === 6 || wd === 0) && rand() < 0.3) {
      tx({ kind: 'expense', amount: cents(16, 92), date: d, description: pick(['Cena', 'Comida familiar', 'Pizza', 'Tapas', 'Brunch']), merchant: pick(['La Tagliatella', 'Telepizza', 'Bar El Rincón', 'Foster’s Hollywood', 'Sushi Mo', 'VIPS']), category_id: C('Restaurantes'), person_id: pick(adults) });
    }
    if (rand() < 0.12) tx({ kind: 'expense', amount: cents(2.2, 7.5), date: d, description: 'Café', merchant: pick(['Café Central', 'Starbucks', 'Granier']), category_id: C('Restaurantes'), method: pick(['card', 'cash']), person_id: pick(adults) });
    if (rand() < 0.05) tx({ kind: 'expense', amount: cents(5, 34), date: d, description: 'Farmacia', merchant: 'Farmacia Ldo. Morales', category_id: C('Salud'), person_id: pick([me, laura, lucia, pablo]) });
    const sale = m === 1 || m === 7;
    if (rand() < (sale ? 0.12 : 0.05)) tx({ kind: 'expense', amount: cents(19, sale ? 140 : 95), date: d, description: pick(['Ropa', 'Zapatillas', 'Abrigo', 'Camisetas', 'Ropa niños']), merchant: pick(['Zara', 'Decathlon', 'Primark', 'Kiabi', 'El Corte Inglés']), category_id: C('Ropa y calzado'), person_id: pick([me, laura, lucia, pablo]) });
    if (rand() < 0.05) tx({ kind: 'expense', amount: cents(8, 45), date: d, description: pick(['Cine', 'Entradas parque', 'Libro', 'Videojuego', 'Bolera']), merchant: pick(['Cinesa', 'Amazon', 'Casa del Libro', 'Fnac', 'Parque Warner']), category_id: C('Ocio y suscripciones'), person_id: pick([me, laura, lucia, pablo]) });
    if (rand() < 0.035) tx({ kind: 'expense', amount: cents(6, 75), date: d, description: pick(['Bombillas', 'Tornillería', 'Menaje', 'Organizadores', 'Pintura']), merchant: pick(['IKEA', 'Leroy Merlin', 'Ferretería López', 'Amazon']), category_id: C('Hogar y reparaciones') });
    if (rand() < 0.02) tx({ kind: 'expense', amount: cents(12, 60), date: d, description: 'Regalo cumpleaños', merchant: pick(['Toys"R"Us', 'Amazon', 'El Corte Inglés']), category_id: C('Regalos') });
    if (m === 12 && day >= 10 && day <= 24 && rand() < 0.35) tx({ kind: 'expense', amount: cents(25, 140), date: d, description: 'Regalos de Navidad', merchant: pick(['Amazon', 'El Corte Inglés', 'Toys"R"Us', 'Fnac']), category_id: C('Regalos') });
    if (m === 9 && day === 3) tx({ kind: 'expense', amount: 26480, date: d, description: 'Libros de texto', merchant: 'Librería Escolar', category_id: C('Educación'), person_id: lucia });
    if (m === 9 && day === 6) tx({ kind: 'expense', amount: 8735, date: d, description: 'Material escolar', merchant: 'Abacus', category_id: C('Educación'), person_id: pablo });
    if (wd === 0 && !winter && rand() < 0.5) tx({ kind: 'expense', amount: cents(8, 20), date: d, description: 'Helados', merchant: 'Heladería Los Alpes', category_id: C('Restaurantes'), method: 'cash' });
    if (day === 17 && rand() < 0.6) tx({ kind: 'expense', amount: 1250, date: d, description: 'Arena para gatos', merchant: 'Tiendanimal', category_id: C('Mascotas'), pet_id: michi });
    if (day === 9) tx({ kind: 'expense', amount: 3290, date: d, description: 'Pienso de Michi', merchant: 'Tiendanimal', category_id: C('Mascotas'), pet_id: michi });
    if (m === 6 && day === 25) tx({ kind: 'income', amount: 64218, date: d, description: 'Devolución de la renta', merchant: 'Agencia Tributaria', category_id: C('Devoluciones e intereses'), method: 'transfer' });
    if (rand() < 0.012) tx({ kind: 'income', amount: cents(80, 320), date: d, description: pick(['Clases particulares', 'Venta en Wallapop', 'Traducción']), category_id: C('Trabajos extra'), person_id: pick(adults), method: 'transfer' });
    if (day === 30 || (day === 28 && m === 2)) tx({ kind: 'income', amount: cents(1, 4), date: d, description: 'Intereses cuenta remunerada', merchant: 'Trade Republic', category_id: C('Devoluciones e intereses'), method: 'transfer' });
  }
  tx({ kind: 'expense', amount: 28940, date: addDays(T, -95), description: 'Revisión y neumáticos', merchant: 'Taller Hermanos Ruiz', category_id: C('Transporte') });
  tx({ kind: 'expense', amount: 18900, date: addDays(T, -210), description: 'Gafas graduadas', merchant: 'Óptica Visión', category_id: C('Salud'), person_id: laura });
  tx({ kind: 'expense', amount: 4521, date: addDays(T, -48), description: 'ITV', merchant: 'ITV Getafe', category_id: C('Transporte') });
  tx({ kind: 'expense', amount: 62000, date: addDays(T, -120), description: 'Apartamento en Cádiz (vacaciones)', merchant: 'Booking', category_id: C('Ocio y suscripciones'), notes: '5 noches en agosto' });

  // Facturas de suministros con consumo
  const bill = (d) => {
    const id = insert('bills', { household_id: hid, created_by: user.id, method: 'direct_debit', ...d });
    if (d.status === 'paid') {
      tx({
        kind: 'expense', amount: d.amount, date: d.paid_date, description: [d.supplier, d.concept].filter(Boolean).join(' — '),
        merchant: d.supplier, category_id: d.category_id, bill_id: id, method: 'direct_debit',
      });
    }
  };
  for (let i = 12; i >= 0; i--) {
    const ps = addMonthsAnchored(T.slice(0, 8) + '01', -i - 1, 1);
    const pe = addDays(addMonthsAnchored(ps, 1, 1), -1);
    const mm = Number(ps.slice(5, 7));
    const kwh = Math.round(([1, 2, 12].includes(mm) ? 410 : [7, 8].includes(mm) ? 380 : [6, 9].includes(mm) ? 300 : 245) * between(0.9, 1.1));
    const issue = addDays(pe, 6);
    const due = addDays(issue, 12);
    const pending = due >= T;
    bill({
      supplier: 'Iberdrola', concept: 'Electricidad', power: 1, number: `FE${ps.replace(/-/g, '').slice(2, 6)}${String(Math.floor(rand() * 90000) + 10000)}`,
      amount: Math.round(kwh * between(0.205, 0.235) * 100) + 1290, category_id: C('Luz, agua y gas'), issue_date: issue, due_date: due,
      period_start: ps, period_end: pe, consumption: kwh, unit: 'kWh', status: pending ? 'pending' : 'paid', paid_date: pending ? null : due,
    });
    if (i % 2 === 0) {
      const ps2 = addMonthsAnchored(ps, -1, 1);
      const m3 = Math.round(between(17, 24) * 10) / 10;
      const gas = Math.round(([1, 2, 12, 11].includes(mm) ? 1650 : [3, 10].includes(mm) ? 980 : 420) * between(0.88, 1.12));
      const due2 = addDays(issue, 15);
      bill({
        supplier: 'Canal de Isabel II', concept: 'Agua', amount: Math.round(m3 * 215 + 1200), category_id: C('Luz, agua y gas'),
        issue_date: addDays(issue, 3), due_date: due2, period_start: ps2, period_end: pe, consumption: m3, unit: 'm³',
        status: due2 >= T ? 'pending' : 'paid', paid_date: due2 >= T ? null : due2,
      });
      bill({
        supplier: 'Naturgy', concept: 'Gas natural', amount: Math.round(gas * 0.089 * 100) + 1850, category_id: C('Luz, agua y gas'),
        issue_date: addDays(issue, 1), due_date: addDays(issue, 20), period_start: ps2, period_end: pe, consumption: gas, unit: 'kWh',
        status: addDays(issue, 20) >= T ? 'pending' : 'paid', paid_date: addDays(issue, 20) >= T ? null : addDays(issue, 20),
      });
    }
  }
  // Una factura vencida sin pagar, para ver el aviso.
  bill({ supplier: 'Ayuntamiento', concept: 'Tasa de basuras', amount: 9850, category_id: C('Impuestos y tasas'), issue_date: addDays(T, -40), due_date: addDays(T, -5), status: 'pending', method: 'transfer' });

  // Lista de la compra
  const list = one('SELECT id FROM shopping_lists WHERE household_id = ? ORDER BY id LIMIT 1', hid)?.id
    ?? insert('shopping_lists', { household_id: hid, name: 'Compra de la semana', icon: '🛒', created_by: user.id });
  run(`UPDATE shopping_lists SET store = 'Mercadona' WHERE id = ?`, list);
  const items = [
    ['Leche semidesnatada', '6 bricks', 'lacteos', 0], ['Plátanos', '1 kg', 'fruta', 1], ['Tomates', '', 'fruta', 0], ['Pan de molde', '', 'panaderia', 0],
    ['Yogures naturales', '8', 'lacteos', 1], ['Pechuga de pavo', '', 'carne', 0], ['Merluza', '2 filetes', 'carne', 0], ['Aceite de oliva', '1 l', 'despensa', 0],
    ['Detergente', '', 'limpieza', 0], ['Papel higiénico', '12 rollos', 'higiene', 1], ['Huevos', '12', 'lacteos', 0], ['Arena para gatos', '', 'mascotas', 0],
    ['Manzanas', '', 'fruta', 0], ['Café molido', '', 'despensa', 0],
  ];
  items.forEach(([name, qty, section, checked], i) => {
    insert('shopping_items', { list_id: list, household_id: hid, name, qty, section, checked, checked_by: checked ? user.id : null, sort: i, created_by: user.id });
  });
  const party = insert('shopping_lists', { household_id: hid, name: 'Cumpleaños de Pablo', icon: '🎂', store: 'Carrefour', created_by: user.id });
  [['Tarta de chocolate', '', 'panaderia'], ['Velas', '', 'otros'], ['Refrescos', '6', 'bebidas'], ['Patatas fritas', '4 bolsas', 'despensa'], ['Globos', '', 'otros'], ['Platos y vasos', '', 'otros']]
    .forEach(([name, qty, section], i) => insert('shopping_items', { list_id: party, household_id: hid, name, qty, section, sort: i, created_by: user.id }));
  const catalog = ['Leche semidesnatada:lacteos', 'Pan de molde:panaderia', 'Plátanos:fruta', 'Huevos:lacteos', 'Yogures naturales:lacteos', 'Tomates:fruta', 'Aceite de oliva:despensa', 'Pasta:despensa', 'Arroz:despensa', 'Pollo:carne', 'Detergente:limpieza', 'Papel higiénico:higiene', 'Café molido:despensa', 'Agua mineral:bebidas', 'Queso:lacteos', 'Manzanas:fruta', 'Cebollas:fruta', 'Patatas:fruta', 'Galletas:despensa', 'Champú:higiene'];
  catalog.forEach((s, i) => {
    const [name, section] = s.split(':');
    run(`INSERT OR IGNORE INTO shopping_catalog (household_id, name, section, times) VALUES (?, ?, ?, ?)`, hid, name, section, 30 - i);
  });

  // Consumo de luz: electrodomésticos y usos desde la última factura (estimación diaria del gasto).
  run('UPDATE households SET power = ? WHERE id = ?', JSON.stringify({ tariff: 'pvpc', taxes: true, vat: 21, base_kwh: 2.4, since: `${T.slice(0, 7)}-01` }), hid);
  const appl = {};
  for (const [name, icon, watts, minutes, kwhUse] of [
    ['Lavadora', '🧺', 2000, 90, 0.9], ['Lavavajillas', '🍽️', 1800, 120, 1.05], ['Horno', '♨️', 2200, 45, null], ['Secadora', '🌀', 2500, 60, null],
    ['Vitrocerámica', '🍳', 1800, 30, null], ['Termo eléctrico', '🚿', 1500, 90, null], ['Plancha', '👔', 2200, 30, null],
  ]) appl[name] = { id: insert('appliances', { household_id: hid, name, icon, watts, minutes, kwh_per_use: kwhUse }), watts, minutes, kwhUse };
  const powerPrice = 0.15 * (1 + 0.0511269632) * 1.21;
  const peak = (h) => (h >= 18 && h < 22 ? 1.35 : h < 8 ? 0.7 : 1);
  for (let d = `${T.slice(0, 7)}-01`; d <= T; d = addDays(d, 1)) {
    const wd = new Date(`${d}T12:00`).getDay();
    const uses = [];
    if ([1, 3, 6].includes(wd)) uses.push(['Lavadora', pick(['09:30', '15:00', '22:30'])]);
    uses.push(['Lavavajillas', pick(['22:00', '23:30', '14:30'])]);
    if (rand() < 0.35) uses.push(['Horno', pick(['13:30', '20:30'])]);
    if (rand() < 0.5) uses.push(['Vitrocerámica', pick(['13:45', '21:00'])]);
    if (wd === 6 && rand() < 0.6) uses.push(['Secadora', '17:00']);
    if (wd === 0) uses.push(['Plancha', '18:30']);
    for (const [name, time] of uses) {
      const a = appl[name];
      const kwh = a.kwhUse || (a.watts * a.minutes) / 60000;
      const cost = Math.round(kwh * powerPrice * peak(Number(time.slice(0, 2))) * 100);
      insert('power_usages', { household_id: hid, appliance_id: a.id, name, date: d, start_time: time, minutes: a.minutes, kwh, cost, price_avg: powerPrice, created_by: user.id });
    }
    syncPowerDay(hid, d, user.id);
  }

  // Comparador de precios: lo habitual en cuatro supermercados durante los dos últimos años y medio,
  // con subidas distintas según el producto (el aceite bajando tras su pico, el café y los huevos subiendo…).
  const prand = rng(777 + hid);
  const pb = (a, b) => a + prand() * (b - a);
  const STORES = [['Mercadona', 1, 0.032], ['Lidl', 0.9, 0.027], ['Carrefour', 1.04, 0.036], ['Dia', 0.96, 0.024]];
  // Nombre, cantidad, unidad, precio de hoy en Mercadona y subida anual propia del producto.
  const PRODUCTS = [
    ['Leche semidesnatada', 1, 'l', 0.95, 0.01], ['Huevos', 1, 'pack', 2.45, 0.08], ['Pan de molde', 1, 'ud', 1.35, 0.02], ['Aceite de oliva', 1, 'l', 8.95, -0.16],
    ['Plátanos', 1, 'kg', 1.99, 0.03], ['Tomates', 1, 'kg', 2.29, 0.05], ['Pollo', 1, 'kg', 6.95, 0.04], ['Yogures naturales', 1, 'pack', 1.6, 0.02],
    ['Café molido', 250, 'g', 2.95, 0.14], ['Papel higiénico', 1, 'pack', 4.75, 0.0], ['Detergente', 3, 'l', 7.5, -0.01], ['Pasta', 500, 'g', 0.85, 0.01],
    ['Arroz', 1, 'kg', 1.25, 0.03], ['Queso', 250, 'g', 2.6, 0.04], ['Agua mineral', 9, 'l', 2.1, 0.02], ['Manzanas', 1, 'kg', 2.1, 0.05],
  ];
  for (const [name, qty, unit, basePrice, drift] of PRODUCTS) {
    const pid = productId(hid, name);
    for (const [store, ratio, storeDrift] of STORES) {
      if (store === 'Dia' && prand() < 0.3) continue;
      if (store === 'Carrefour' && prand() < 0.15) continue;
      const own = ratio * pb(0.93, 1.07);
      // Precio de hace k meses: lo de hoy deshaciendo la subida anual (con algo de ruido).
      for (let k = 30; k >= 0; k -= pb(1.2, 3.2)) {
        const date = addDays(T, -Math.round(k * 30.4 + pb(0, 6)));
        const offer = prand() < 0.08;
        const yearly = 1 + drift + (storeDrift - 0.03);
        const price = Math.round(basePrice * own * yearly ** (-k / 12) * pb(0.985, 1.015) * (offer ? 0.8 : 1) * 100);
        insert('prices', { household_id: hid, product_id: pid, store, price, qty, unit, date, offer: offer ? 1 : 0, created_by: user.id });
      }
    }
  }

  // Notas: cuadernos del hogar (con un subcuaderno) y uno privado, con tareas, casillas y etiquetas.
  const book = (name, icon, priv = false, parent = null) => insert('note_books', { household_id: hid, owner_id: priv ? user.id : null, parent_id: parent, name, icon });
  const stamp = (days, h = 10) => `${addDays(T, -days)} ${String(h).padStart(2, '0')}:${String(Math.floor(prand() * 60)).padStart(2, '0')}:00`;
  const note = (bookId, title, body, { tags = [], pinned = 0, todo = false, due = null, done = null, days = 3, priv = false } = {}) => {
    const id = insert('notes', {
      household_id: hid, book_id: bookId, owner_id: priv ? user.id : null, title, body, pinned, is_todo: todo ? 1 : 0, due_at: due,
      done_at: done ? `${addDays(T, -done)}T18:00:00.000Z` : null, created_by: user.id, updated_by: user.id,
      created_at: stamp(days + 20), updated_at: stamp(days, 9 + Math.floor(prand() * 10)),
    });
    for (const t of tags) run('INSERT INTO note_tags (note_id, tag) VALUES (?, ?)', id, t);
  };
  const casa = book('Notas de casa', '🏠');
  const recetas = book('Recetas', '🍳');
  const postres = book('Postres', '🍮', false, recetas);
  const viajes = book('Viajes', '✈️');
  const mias = book('Mis notas', '📓', true);
  note(casa, 'Wifi y contraseñas de casa', '**Red:** CasaATH-5G\n**Contraseña:** la de la pegatina del router\n\nPara invitados: *CasaATH-Invitados* — `bienvenidos2026`', { tags: ['casa'], pinned: 1, days: 40 });
  note(casa, 'Teléfonos útiles', '- **Fontanero** (Paco): 600 123 456\n- **Electricista**: 611 222 333\n- **Pediatra** (Dra. Ruiz): 915 555 010\n- **Veterinaria** de Luna y Michi: 918 444 777\n- **Administrador de la comunidad**: 914 000 222', { tags: ['contactos', 'casa'], days: 12 });
  note(casa, 'Menú de la semana', '- [x] Lunes: lentejas de la abuela\n- [x] Martes: merluza con patatas\n- [ ] Miércoles: pasta con verduras\n- [ ] Jueves: pollo al horno\n- [ ] Viernes: pizza casera 🍕', { tags: ['comida'], days: 1 });
  note(casa, 'Pedir cita para la ITV', 'Llamar por la mañana. Llevar la ficha técnica y el seguro.', { todo: true, due: addDays(T, 5), days: 2, tags: ['coche'] });
  note(casa, 'Cambiar el filtro de la campana', '', { todo: true, due: addDays(T, -3), days: 9 });
  note(casa, 'Devolver el taladro al vecino del 2.º', '', { todo: true, done: 2, days: 6 });
  note(recetas, 'Lentejas de la abuela', '## Ingredientes\n- 400 g de lentejas pardinas\n- 1 chorizo\n- 1 zanahoria, 1 pimiento y media cebolla\n- 1 hoja de laurel y pimentón\n\n## Cómo se hacen\n1. Sofreír la verdura picada.\n2. Añadir las lentejas, el chorizo y agua hasta cubrir.\n3. **35 minutos** a fuego medio. Sal al final.', { tags: ['comida', 'receta'], days: 30 });
  note(postres, 'Flan de huevo', '- [ ] 4 huevos\n- [ ] 500 ml de leche\n- [ ] 100 g de azúcar (y un poco más para el caramelo)\n\nAl baño maría, **45 minutos** a 180 ºC.', { tags: ['receta'], days: 18 });
  note(viajes, 'Vacaciones en Asturias', 'Del **1 al 8 de julio**. Apartamento en Llanes (pagada la señal).\n\n### Qué llevar\n- [ ] Chubasqueros\n- [ ] Botas de montaña\n- [x] Cargadores\n\n### Qué ver\n- Lagos de Covadonga\n- Playa de Gulpiyuri\n- Cudillero', { tags: ['viajes'], days: 5 });
  note(mias, 'Ideas para el cumpleaños de Laura', '- Reloj deportivo\n- Escapada a la Sierra\n- **Cena sorpresa** el sábado (reservar antes del día 20)', { tags: ['regalos'], days: 4, priv: true });
  note(mias, 'Hablar con el banco', 'Preguntar por amortizar parte de la hipoteca con la paga extra.', { todo: true, due: addDays(T, 10), days: 3, priv: true });

  // Metas de ahorro
  const goal = (g, moves) => {
    const id = insert('goals', { household_id: hid, ...g });
    for (const [amount, date, note] of moves) insert('goal_moves', { goal_id: id, household_id: hid, amount, date, note, created_by: user.id });
  };
  const ny = Number(T.slice(0, 4)) + 1;
  goal({ name: 'Vacaciones en Asturias', icon: '🏖️', color: '#0E9AA7', target: 240000, deadline: `${ny}-07-01` },
    Array.from({ length: 9 }, (_, i) => [15000, addMonthsAnchored(T, -i, 1), 'Aportación mensual']));
  goal({ name: 'Fondo de emergencia', icon: '🛟', color: '#2A78D6', target: 600000 },
    [[300000, addDays(T, -300), 'Saldo inicial'], ...Array.from({ length: 6 }, (_, i) => [15000, addMonthsAnchored(T, -i * 2, 3), 'Aportación'])]);
  goal({ name: 'Ordenador para los niños', icon: '💻', color: '#6250D6', target: 90000, deadline: `${ny}-09-01` },
    [[20000, addDays(T, -60), 'Paga extra'], [10000, addDays(T, -20), 'Aportación']]);

  // Recordatorios
  const rem = (d) => insert('reminders', { household_id: hid, created_by: user.id, remind_days: 3, repeat: 'none', ...d });
  rem({ title: 'Matrícula de la escuela de música', kind: 'payment', amount: 6000, date: addDays(T, 5), category_id: C('Educación'), person_id: pablo });
  rem({ title: 'Cumpleaños de la abuela Carmen', kind: 'date', date: addDays(T, 12), repeat: 'annual', remind_days: 7, notes: 'Comprar flores y reservar comida' });
  rem({ title: 'Pasar la ITV del coche', kind: 'payment', amount: 4521, date: addDays(T, 26), repeat: 'annual', remind_days: 14, category_id: C('Transporte'), notes: 'Pedir cita en ITV Getafe' });
  rem({ title: 'Renovar el DNI de Lucía', kind: 'date', date: addDays(T, 41), person_id: lucia, remind_days: 14 });
  rem({ title: 'Revisión anual de la caldera', kind: 'payment', amount: 8900, date: addDays(T, -2), repeat: 'annual', category_id: C('Hogar y reparaciones') });

  processDue(hid);

}
