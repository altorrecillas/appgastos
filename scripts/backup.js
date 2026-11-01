// Copia de seguridad en caliente: la base de datos entera cada vez y los adjuntos (fotos, PDF) solo cuando son nuevos.
// Uso: node scripts/backup.js [carpeta-destino] [copias-a-conservar]
//
// En la carpeta de destino quedan:
//   gastosbyath-AAAA-MM-DD-HH-MM-SS.db   una por ejecución; se guardan las N últimas
//   adjuntos/                            cada adjunto copiado una sola vez (no cambian nunca después de subirlos)
// Un adjunto borrado en la app se conserva aquí mientras alguna de las copias guardadas de la base de datos lo use:
// así cualquiera de ellas se puede restaurar completa.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data'));
const dest = path.resolve(process.argv[2] || path.join(DATA_DIR, 'backups'));
const keep = Math.max(1, Number(process.argv[3] || process.env.BACKUP_KEEP || 30));
const UPLOADS = path.join(DATA_DIR, 'uploads');
const FILES = path.join(dest, 'adjuntos');
fs.mkdirSync(FILES, { recursive: true });

// 1. La base de datos, entera.
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const target = path.join(dest, `gastosbyath-${stamp}.db`);
// Antes de arrancar la versión nueva por primera vez, la base de datos aún puede tener el nombre antiguo.
const source = ['gastosbyath.db', 'cuartos.db'].map((f) => path.join(DATA_DIR, f)).find((f) => fs.existsSync(f));
if (!source) throw new Error(`No hay base de datos en ${DATA_DIR}`);
const db = new Database(source, { readonly: true });
await db.backup(target);
db.close();
// La copia queda como un único archivo (sin -wal ni -shm al abrirla después).
const copy = new Database(target);
copy.pragma('journal_mode = DELETE');
copy.close();

// 2. Los adjuntos nuevos. Uno copiado a medias en otra ejecución (otro tamaño) se vuelve a copiar.
const files = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name)
  : []);
const current = files(UPLOADS);
let added = 0;
let addedBytes = 0;
let already = 0;
for (const name of current) {
  try {
    const size = fs.statSync(path.join(UPLOADS, name)).size;
    const to = path.join(FILES, name);
    if (fs.existsSync(to) && fs.statSync(to).size === size) {
      already++;
      continue;
    }
    const tmp = path.join(FILES, `.${name}.part`);
    fs.copyFileSync(path.join(UPLOADS, name), tmp, fs.constants.COPYFILE_FICLONE);
    fs.renameSync(tmp, to);
    added++;
    addedBytes += size;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // borrado en la app mientras se hacía la copia
  }
}

// 3. Solo las N últimas copias de la base de datos (también las de cuando la app se llamaba «Cuartos»).
const stampOf = (f) => f.replace(/^(gastosbyath|cuartos|adjuntos)-/, '').replace(/\.(db|tar\.gz)$/, '');
const copies = fs.readdirSync(dest).filter((f) => /^(gastosbyath|cuartos)-.+\.db$/.test(f)).sort((a, b) => stampOf(a).localeCompare(stampOf(b)));
for (const f of copies.slice(0, Math.max(copies.length - keep, 0))) fs.rmSync(path.join(dest, f));
const kept = copies.slice(-keep);

// 4. Fuera los adjuntos que ya no están en la app ni los usa ninguna copia guardada.
// Si alguna copia no se puede leer, no se retira nada (mejor que sobre a que falte).
const needed = new Set(current);
let readable = true;
for (const f of kept) {
  try {
    const c = new Database(path.join(dest, f), { readonly: true, fileMustExist: true });
    for (const r of c.prepare('SELECT stored_name FROM attachments').all()) needed.add(r.stored_name);
    c.close();
  } catch (e) {
    readable = false;
    console.warn(`No se puede leer ${f} (${e.message}): esta vez no se retira ningún adjunto.`);
  }
}
let removed = 0;
if (readable) {
  for (const name of files(FILES)) {
    if (!needed.has(name)) {
      fs.rmSync(path.join(FILES, name));
      removed++;
    }
  }
}
for (const name of fs.readdirSync(FILES)) if (name.endsWith('.part')) fs.rmSync(path.join(FILES, name), { force: true });

// 5. Las copias de versiones anteriores empaquetaban todos los adjuntos cada día (adjuntos-*.tar.gz):
// cada una se borra cuando ya no queda su copia de la base de datos.
for (const f of fs.readdirSync(dest).filter((x) => /^adjuntos-.+\.tar\.gz$/.test(x))) {
  if (stampOf(f) < stampOf(kept[0])) fs.rmSync(path.join(dest, f));
}

const mb = (b) => `${(b / 1048576).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`;
console.log(`Base de datos copiada en ${target} (se guardan las ${keep} últimas).`);
console.log(`Adjuntos: ${added} nuevos (${mb(addedBytes)}), ${already} ya estaban${removed ? `, ${removed} retirados porque ya no los usa ninguna copia` : ''}.`);
