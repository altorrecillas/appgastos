// Base de datos SQLite (better-sqlite3) con migraciones versionadas por PRAGMA user_version.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const DB_FILE = path.join(DATA_DIR, 'gastosbyath.db');
// La app se llamaba «Cuartos»: si solo está la base de datos con el nombre antiguo, se renombra
// (antes se vuelca su registro WAL para que no se pierda ningún cambio).
const LEGACY_FILE = path.join(DATA_DIR, 'cuartos.db');
if (!fs.existsSync(DB_FILE) && fs.existsSync(LEGACY_FILE)) {
  const old = new Database(LEGACY_FILE);
  old.pragma('wal_checkpoint(TRUNCATE)');
  old.close();
  fs.renameSync(LEGACY_FILE, DB_FILE);
  for (const ext of ['-wal', '-shm']) fs.rmSync(LEGACY_FILE + ext, { force: true });
  console.log('Base de datos renombrada: cuartos.db → gastosbyath.db');
}

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

const migrations = [
  // v1 — esquema inicial
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#2347C5',
    is_admin INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE households (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    icon TEXT NOT NULL DEFAULT '🏠',
    color TEXT NOT NULL DEFAULT '#2347C5',
    monthly_budget INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE memberships (
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (household_id, user_id)
  );
  CREATE INDEX idx_memberships_user ON memberships(user_id);

  CREATE TABLE invitations (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    code TEXT UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at TEXT,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_invitations_user ON invitations(user_id, status);

  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🙂',
    color TEXT NOT NULL DEFAULT '#2347C5',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🏷️',
    color TEXT NOT NULL DEFAULT '#6B7280',
    budget INTEGER,
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_categories_h ON categories(household_id);

  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE pets (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    species TEXT NOT NULL DEFAULT 'dog',
    breed TEXT NOT NULL DEFAULT '',
    sex TEXT,
    birth_date TEXT,
    color TEXT NOT NULL DEFAULT '#2347C5',
    chip TEXT NOT NULL DEFAULT '',
    sterilized INTEGER NOT NULL DEFAULT 0,
    vet TEXT NOT NULL DEFAULT '',
    vet_phone TEXT NOT NULL DEFAULT '',
    insurance TEXT NOT NULL DEFAULT '',
    food TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    photo_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE recurring (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
    plan TEXT NOT NULL DEFAULT 'fixed' CHECK (plan IN ('fixed','installment')),
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    installments INTEGER,
    total_amount INTEGER,
    down_payment INTEGER NOT NULL DEFAULT 0,
    cash_price INTEGER,
    purchase_date TEXT,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    variable INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    pet_id INTEGER REFERENCES pets(id) ON DELETE SET NULL,
    method TEXT,
    frequency TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly','bimonthly','quarterly','fourmonthly','semiannual','annual')),
    start_date TEXT NOT NULL,
    next_date TEXT NOT NULL,
    end_date TEXT,
    auto INTEGER NOT NULL DEFAULT 0,
    remind_days INTEGER NOT NULL DEFAULT 3,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_recurring_h ON recurring(household_id, active, next_date);

  CREATE TABLE bills (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    supplier TEXT NOT NULL,
    concept TEXT NOT NULL DEFAULT '',
    number TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL CHECK (amount >= 0),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    issue_date TEXT,
    due_date TEXT,
    period_start TEXT,
    period_end TEXT,
    consumption REAL,
    unit TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
    paid_date TEXT,
    method TEXT,
    attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
    recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_bills_h ON bills(household_id, status, due_date);

  CREATE TABLE shopping_lists (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🛒',
    store TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE shopping_items (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    qty TEXT NOT NULL DEFAULT '',
    price INTEGER,
    section TEXT NOT NULL DEFAULT '',
    checked INTEGER NOT NULL DEFAULT 0,
    checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    checked_at TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_items_list ON shopping_items(list_id);

  CREATE TABLE shopping_catalog (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    section TEXT NOT NULL DEFAULT '',
    last_price INTEGER,
    times INTEGER NOT NULL DEFAULT 1,
    last_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (household_id, name)
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    date TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    merchant TEXT NOT NULL DEFAULT '',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    pet_id INTEGER REFERENCES pets(id) ON DELETE SET NULL,
    method TEXT,
    notes TEXT NOT NULL DEFAULT '',
    recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
    bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL,
    list_id INTEGER REFERENCES shopping_lists(id) ON DELETE SET NULL,
    attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_tx_h_date ON transactions(household_id, date);
  CREATE INDEX idx_tx_h_cat ON transactions(household_id, category_id);
  CREATE INDEX idx_tx_bill ON transactions(bill_id);
  CREATE INDEX idx_tx_pet ON transactions(pet_id);

  CREATE TABLE pet_events (
    id INTEGER PRIMARY KEY,
    pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('vaccine','deworming','vet','grooming','medication','weight','other')),
    title TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    next_date TEXT,
    weight REAL,
    notes TEXT NOT NULL DEFAULT '',
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_pet_events ON pet_events(pet_id, date);

  CREATE TABLE goals (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🎯',
    color TEXT NOT NULL DEFAULT '#2347C5',
    target INTEGER NOT NULL CHECK (target > 0),
    deadline TEXT,
    notes TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE goal_moves (
    id INTEGER PRIMARY KEY,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_activity_h ON activity(household_id, id DESC);
  `,
  // v2 — recordatorios propios y notificaciones push
  `
  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','date')),
    date TEXT NOT NULL,
    amount INTEGER,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none','weekly','monthly','bimonthly','quarterly','semiannual','annual')),
    remind_days INTEGER NOT NULL DEFAULT 3,
    notes TEXT NOT NULL DEFAULT '',
    done_at TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_reminders_h ON reminders(household_id, done_at, date);

  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE push_log (
    key TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // v3 — comparador de precios por supermercado
  `
  CREATE TABLE prices (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES shopping_catalog(id) ON DELETE CASCADE,
    store TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    qty REAL NOT NULL DEFAULT 1 CHECK (qty > 0),
    unit TEXT NOT NULL DEFAULT 'ud',
    date TEXT NOT NULL,
    offer INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_prices_product ON prices(household_id, product_id, store, date);
  `,
  // v4 — consumo eléctrico: precio regulado (PVPC), electrodomésticos y estimación de la factura
  `
  ALTER TABLE households ADD COLUMN power TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE transactions ADD COLUMN estimate INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bills ADD COLUMN power INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_tx_estimate ON transactions(household_id, estimate, date);

  CREATE TABLE appliances (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🔌',
    watts INTEGER NOT NULL DEFAULT 1000 CHECK (watts > 0),
    minutes INTEGER NOT NULL DEFAULT 60 CHECK (minutes > 0),
    kwh_per_use REAL,
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE power_usages (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    appliance_id INTEGER REFERENCES appliances(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT,
    minutes INTEGER,
    kwh REAL NOT NULL CHECK (kwh >= 0),
    cost INTEGER NOT NULL,
    price_avg REAL,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_power_usages ON power_usages(household_id, date);

  CREATE TABLE power_prices (
    date TEXT NOT NULL,
    hour INTEGER NOT NULL,
    price REAL NOT NULL,
    PRIMARY KEY (date, hour)
  );
  `,
  // v5 — Home Assistant: enchufes inteligentes con consumo real
  `
  ALTER TABLE households ADD COLUMN ha TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE power_usages ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE power_usages ADD COLUMN link_id INTEGER;
  ALTER TABLE power_usages ADD COLUMN end_time TEXT;
  ALTER TABLE power_usages ADD COLUMN running INTEGER NOT NULL DEFAULT 0;
  -- Uso anotado a mano que ha quedado sustituido por lo medido con un enchufe (id del enlace).
  ALTER TABLE power_usages ADD COLUMN superseded_by INTEGER;
  CREATE INDEX idx_power_usages_link ON power_usages(link_id, date);

  CREATE TABLE ha_links (
    -- AUTOINCREMENT: un enchufe nuevo nunca reutiliza el número de uno borrado (lo medido conserva su origen).
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🔌',
    energy_entity TEXT,
    power_entity TEXT,
    appliance_id INTEGER REFERENCES appliances(id) ON DELETE SET NULL,
    mode TEXT NOT NULL DEFAULT 'cycles' CHECK (mode IN ('cycles','continuous')),
    threshold_w REAL NOT NULL DEFAULT 15,
    min_kwh REAL NOT NULL DEFAULT 0.05,
    gap_min INTEGER NOT NULL DEFAULT 15,
    enabled INTEGER NOT NULL DEFAULT 1,
    backfilled INTEGER NOT NULL DEFAULT 0,
    last_value REAL,
    last_seen TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (energy_entity IS NOT NULL OR power_entity IS NOT NULL)
  );

  CREATE TABLE ha_hourly (
    link_id INTEGER NOT NULL REFERENCES ha_links(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    hour INTEGER NOT NULL,
    kwh REAL NOT NULL,
    cost REAL NOT NULL, -- céntimos con decimales (sumar horas sin perder precisión)
    PRIMARY KEY (link_id, date, hour)
  );

  CREATE TABLE ha_sync_log (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    ok INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    cycles INTEGER NOT NULL DEFAULT 0,
    kwh REAL NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_ha_sync_log ON ha_sync_log(household_id, id DESC);
  `,
  // v6 — anotar sin conexión, categorías aprendidas, fotos, color del hogar, asistente y avisos
  `
  -- Identificador que pone el móvil al anotar sin conexión: reenviar no duplica.
  ALTER TABLE transactions ADD COLUMN client_id TEXT;
  CREATE UNIQUE INDEX idx_tx_client ON transactions(household_id, client_id) WHERE client_id IS NOT NULL;
  ALTER TABLE shopping_items ADD COLUMN client_id TEXT;
  CREATE UNIQUE INDEX idx_items_client ON shopping_items(household_id, client_id) WHERE client_id IS NOT NULL;

  -- «MERCADONA» → Supermercado: se aprende de lo que anota cada hogar.
  CREATE TABLE category_rules (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
    pattern TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'learned' CHECK (source IN ('learned','manual')),
    hits INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (household_id, kind, pattern)
  );

  ALTER TABLE people ADD COLUMN photo_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL;
  -- El color del hogar tiñe la aplicación; el asistente de primer uso se ofrece hasta completarlo o descartarlo.
  ALTER TABLE households ADD COLUMN tint INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE households ADD COLUMN setup_done INTEGER NOT NULL DEFAULT 0;

  -- Avisos que cada persona ya ha visto y descartado.
  CREATE TABLE insight_dismissals (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, household_id, key)
  );
  `,
  // v7 — ficha de cada producto de la compra: foto, cómo se vende y marca o detalle
  `
  ALTER TABLE shopping_catalog ADD COLUMN photo_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL;
  -- Formato habitual (ud, kg, g, l, ml, pack) y su cantidad; 1 kg es «al peso». NULL: se deduce de los precios.
  ALTER TABLE shopping_catalog ADD COLUMN unit TEXT;
  ALTER TABLE shopping_catalog ADD COLUMN unit_qty REAL;
  ALTER TABLE shopping_catalog ADD COLUMN note TEXT NOT NULL DEFAULT '';
  `,
  // v8 — IPC oficial del INE (general y alimentación) para compararlo con los precios del hogar
  `
  CREATE TABLE ipc (
    series TEXT NOT NULL,   -- general | food
    month TEXT NOT NULL,    -- AAAA-MM
    idx REAL,               -- índice (base 2025 = 100)
    yoy REAL,               -- variación anual publicada, en %
    PRIMARY KEY (series, month)
  );
  `,
  // v9 — notas (al estilo de Joplin): cuadernos, notas en Markdown, etiquetas y tareas.
  // Las privadas (owner_id) solo las ve quien las escribe: ni los administradores del hogar.
  `
  CREATE TABLE note_books (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL: del hogar; si no, privado de esa persona
    parent_id INTEGER REFERENCES note_books(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '📒',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_note_books ON note_books(household_id, owner_id);

  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    book_id INTEGER NOT NULL REFERENCES note_books(id) ON DELETE CASCADE,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- el mismo que su cuaderno
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    is_todo INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    due_at TEXT, -- AAAA-MM-DD o AAAA-MM-DDTHH:MM
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT -- en la papelera
  );
  CREATE INDEX idx_notes ON notes(household_id, owner_id, book_id);

  CREATE TABLE note_tags (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (note_id, tag)
  );

  -- Búsqueda de texto completo (sin distinguir tildes ni mayúsculas).
  CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;
  CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  END;
  CREATE TRIGGER notes_au AFTER UPDATE OF title, body ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  END;

  -- Imágenes de una nota privada: solo las puede abrir quien las subió.
  ALTER TABLE attachments ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  `,
];

const current = db.pragma('user_version', { simple: true });
for (let v = current; v < migrations.length; v++) {
  db.transaction(() => {
    db.exec(migrations[v]);
    db.pragma(`user_version = ${v + 1}`);
  })();
}

// Caché de sentencias preparadas: el mismo SQL se compila una sola vez.
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export const one = (sql, ...params) => stmt(sql).get(...params);
export const all = (sql, ...params) => stmt(sql).all(...params);
export const run = (sql, ...params) => stmt(sql).run(...params);
export const tx = (fn) => db.transaction(fn);

// INSERT a partir de un objeto plano { columna: valor }.
// Los valores null/undefined se omiten para que actúen los DEFAULT de la tabla.
export function insert(table, data) {
  const cols = Object.keys(data).filter((c) => data[c] !== undefined && data[c] !== null);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return Number(stmt(sql).run(...cols.map((c) => data[c])).lastInsertRowid);
}

// UPDATE parcial por id (y household_id para aislar hogares).
export function update(table, id, hid, data, { touch = false } = {}) {
  const cols = Object.keys(data);
  if (!cols.length && !touch) return 0;
  const sets = cols.map((c) => `${c} = ?`);
  if (touch) sets.push(`updated_at = datetime('now')`);
  const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND household_id = ?`;
  return stmt(sql).run(...cols.map((c) => data[c]), id, hid).changes;
}
