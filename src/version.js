// Versión de la aplicación: la de package.json (0.43.0 se enseña como «0.43»). Se sube con «npm run subir-version».
// El servidor la pone en la página y en el service worker: al subirla, cada móvil carga la nueva y lo avisa.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const VERSION = pkg.version.replace(/\.0$/, '');

// Novedades de CHANGELOG.md, de la más reciente a la más antigua: [{ version, date, items }].
export function changelog() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const head = line.match(/^##\s+(\d+(?:\.\d+)+)(?:\s+[—–-]\s+(\d{4}-\d{2}-\d{2}))?/);
    if (head) out.push({ version: head[1], date: head[2] || null, items: [] });
    else if (out.length && /^\s*[-*]\s+\S/.test(line)) out.at(-1).items.push(line.replace(/^\s*[-*]\s+/, '').trim());
  }
  return out;
}
