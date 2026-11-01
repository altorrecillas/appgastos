// Sube la versión de la app (package.json) y abre su apartado en CHANGELOG.md.
// Uso:
//   npm run subir-version -- "Novedad" "Otra novedad"           0.43 → 0.44 (una mejora)
//   npm run subir-version -- arreglo "Qué se ha arreglado"      0.44 → 0.44.1 (solo un arreglo)
//   npm run subir-version -- 0.50 "Novedad"                     una versión concreta
// Al subirla a GitHub y actualizar el contenedor, la app avisa en los móviles de que hay una versión nueva.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (f) => path.join(ROOT, f);
const show = (v) => v.replace(/\.0$/, '');

const args = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file('package.json'), 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
let next = `${major}.${minor + 1}.0`;
if (args[0] === 'arreglo') {
  next = `${major}.${minor}.${patch + 1}`;
  args.shift();
} else if (/^\d+\.\d+(\.\d+)?$/.test(args[0] || '')) {
  next = args.shift().split('.').concat('0').slice(0, 3).join('.');
}
const items = args.map((x) => x.trim()).filter(Boolean);
const num = (v) => v.split('.').reduce((s, x) => s * 1000 + Number(x), 0);
if (num(next) <= num(pkg.version)) {
  console.error(`La versión nueva (${show(next)}) tiene que ser mayor que la actual (${show(pkg.version)}).`);
  process.exit(1);
}

// package.json y package-lock.json (mismo formato que npm: 2 espacios y salto de línea final).
const save = (f, data) => fs.writeFileSync(file(f), `${JSON.stringify(data, null, 2)}\n`);
pkg.version = next;
save('package.json', pkg);
if (fs.existsSync(file('package-lock.json'))) {
  const lock = JSON.parse(fs.readFileSync(file('package-lock.json'), 'utf8'));
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  save('package-lock.json', lock);
}

// Apartado nuevo en CHANGELOG.md, encima del anterior.
const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const changelog = fs.existsSync(file('CHANGELOG.md')) ? fs.readFileSync(file('CHANGELOG.md'), 'utf8') : '# Novedades\n';
const section = `## ${show(next)} — ${date}\n\n${(items.length ? items : ['…']).map((x) => `- ${x}`).join('\n')}\n\n`;
const at = changelog.search(/^## /m);
fs.writeFileSync(file('CHANGELOG.md'), at < 0 ? `${changelog.trimEnd()}\n\n${section}` : changelog.slice(0, at) + section + changelog.slice(at));

console.log(`Versión ${show(`${major}.${minor}.${patch}`)} → ${show(next)}.`);
if (!items.length) console.log('Escribe sus novedades en CHANGELOG.md (donde pone «…»).');
console.log('Cuando la subas a GitHub y actualices el contenedor, la app avisará en los móviles de que hay una versión nueva.');
