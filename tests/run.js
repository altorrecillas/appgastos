// Lanza las pruebas por tandas (unitarias, API y pantalla) y al final resume cómo ha ido cada una.
// Uso: npm test                       todas
//      npm test -- api e2e            solo esas tandas
//      npm test -- api --test-name-pattern=privada   (lo que empiece por «-» se le pasa a node --test)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PHASES = {
  unit: { name: 'Unitarias', args: [] },
  api: { name: 'API', args: [] },
  // Cada archivo abre su propio Chromium: de dos en dos para no ahogar la máquina.
  e2e: { name: 'Pantalla (navegador)', args: ['--test-concurrency=2'] },
};

const args = process.argv.slice(2);
const extra = args.filter((a) => a.startsWith('-'));
const wanted = args.filter((a) => !a.startsWith('-'));
const unknown = wanted.filter((w) => !PHASES[w]);
if (unknown.length) {
  console.error(`No conozco «${unknown.join('», «')}». Tandas: ${Object.keys(PHASES).join(', ')}.`);
  process.exit(2);
}
const color = process.stdout.isTTY;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

function run(key) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    console.log(paint('1', `\n▶ ${PHASES[key].name}\n`));
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...PHASES[key].args, ...extra, path.join(DIR, key)], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, TZ: 'Europe/Madrid', ...(color ? { FORCE_COLOR: '1' } : {}) },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.on('exit', (code) => {
      const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
      const count = (what) => Number(plain.match(new RegExp(`^ℹ ${what} (\\d+)`, 'm'))?.[1] || 0);
      resolve({ key, code, secs: (Date.now() - t0) / 1000, pass: count('pass'), fail: count('fail'), skipped: count('skipped') });
    });
  });
}

const results = [];
for (const key of wanted.length ? wanted : Object.keys(PHASES)) results.push(await run(key));

console.log(paint('1', '\nResumen'));
const n = (x) => x.toLocaleString('es-ES');
for (const r of results) {
  const parts = [paint('32', `${n(r.pass)} bien`)];
  if (r.fail) parts.push(paint('31', `${n(r.fail)} mal`));
  if (r.skipped) parts.push(paint('33', `${n(r.skipped)} saltadas`));
  const mark = r.code === 0 ? paint('32', '✔') : paint('31', '✘');
  console.log(`  ${mark} ${PHASES[r.key].name.padEnd(22)} ${parts.join(', ')}  ${paint('2', `(${r.secs.toLocaleString('es-ES', { maximumFractionDigits: 1 })} s)`)}`);
}
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
