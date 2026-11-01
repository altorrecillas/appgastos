// Copia las dependencias del navegador a public/ (gráficos, tipografía e iconos)
// para que la aplicación funcione sin acceso a internet dentro de la tailnet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const PUB = path.join(ROOT, 'public');
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log('·', path.relative(ROOT, to));
};

copy(path.join(NM, 'echarts/dist/echarts.min.js'), path.join(PUB, 'vendor/echarts.min.js'));
copy(path.join(NM, 'echarts/LICENSE'), path.join(PUB, 'vendor/echarts.LICENSE.txt'));

// Hojas de cálculo de los bancos (XLS, XLSX, ODS): solo se descarga al importar.
copy(path.join(NM, 'xlsx/dist/xlsx.full.min.js'), path.join(PUB, 'vendor/xlsx.full.min.js'));
copy(path.join(NM, 'xlsx/LICENSE'), path.join(PUB, 'vendor/xlsx.LICENSE.txt'));

// Notas en Markdown: el intérprete y el limpiador de HTML (solo se descargan al abrir las notas).
const copyModule = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*$/gm, ''));
  console.log('·', path.relative(ROOT, to));
};
copyModule(path.join(NM, 'marked/lib/marked.esm.js'), path.join(PUB, 'vendor/marked.esm.js'));
copy(path.join(NM, 'marked/LICENSE'), path.join(PUB, 'vendor/marked.LICENSE.txt'));
copyModule(path.join(NM, 'dompurify/dist/purify.es.mjs'), path.join(PUB, 'vendor/purify.es.js'));
copy(path.join(NM, 'dompurify/LICENSE'), path.join(PUB, 'vendor/purify.LICENSE.txt'));

// Lectura de tickets en el propio dispositivo: Tesseract (WebAssembly) y el modelo de español.
const TESS = path.join(PUB, 'vendor/tesseract');
copy(path.join(NM, 'tesseract.js/dist/tesseract.min.js'), path.join(TESS, 'tesseract.min.js'));
copy(path.join(NM, 'tesseract.js/dist/worker.min.js'), path.join(TESS, 'worker.min.js'));
copy(path.join(NM, 'tesseract.js/LICENSE.md'), path.join(TESS, 'LICENSE.txt'));
for (const core of ['tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
  copy(path.join(NM, 'tesseract.js-core', core), path.join(TESS, 'core', core));
}
copy(path.join(NM, '@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz'), path.join(TESS, 'lang/spa.traineddata.gz'));
for (const sub of ['latin', 'latin-ext']) {
  const f = `bricolage-grotesque-${sub}-standard-normal.woff2`;
  copy(path.join(NM, '@fontsource-variable/bricolage-grotesque/files', f), path.join(PUB, 'fonts', f));
}
copy(path.join(NM, '@fontsource-variable/bricolage-grotesque/LICENSE'), path.join(PUB, 'fonts/OFL.txt'));

// Sprite SVG solo con los iconos de Lucide que usa la interfaz.
const ICONS = `house list-ordered receipt repeat shopping-cart paw-print piggy-bank chart-pie chart-column settings plus search bell
user users log-out chevron-left chevron-right chevron-down chevron-up x check trash-2 pencil calendar calendar-days filter
download upload moon sun paperclip camera ellipsis ellipsis-vertical arrow-up-right arrow-down-right arrow-up arrow-down wallet
credit-card banknote landmark smartphone circle-check circle-alert triangle-alert clock file-text zap droplet flame syringe
stethoscope heart-pulse target trending-up trending-down refresh-cw copy share-2 key-round shield-check link user-plus mail
sparkles list-checks store tag sliders-horizontal eye eye-off history activity menu house-plus door-open info archive
rotate-ccw minus square-check square monitor palette lock calculator coins sun-moon skip-forward image cake weight scissors
pill bug-off package wand-sparkles circle-dollar-sign hand-coins split credit-card arrow-left-right calendar-clock
calendar-check gauge layers chart-line chart-no-axes-column send log-in grid-2x2 sun-medium cloud-off wifi hourglass
circle-plus circle-minus external-link file-down file-up table-2 baby bone fish bird rabbit squirrel turtle cat dog
mic grip-vertical list-plus undo-2 check-check copy-plus hand-coins house-plug plug plug-zap unplug wifi-off timer server
scan-search link-2-off power play radio cable shield-alert arrow-down-up
notebook-pen notebook notebook-tabs lock lock-open hash pin pin-off bold italic heading list list-todo square-check-big code quote link-2 table eye book-open folder folder-plus folder-open tags trash rotate-ccw-square file-text file-down sticky-note strikethrough list-checks text-quote corner-down-left`
  .split(/\s+/).filter(Boolean);
const symbols = [];
for (const name of [...new Set(ICONS)]) {
  const file = path.join(NM, 'lucide-static/icons', `${name}.svg`);
  if (!fs.existsSync(file)) {
    console.warn('  (falta el icono)', name);
    continue;
  }
  const svg = fs.readFileSync(file, 'utf8');
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>')).trim();
  symbols.push(`<symbol id="i-${name}" viewBox="0 0 24 24">${inner.replace(/\s*\n\s*/g, '')}</symbol>`);
}
fs.mkdirSync(path.join(PUB, 'icons'), { recursive: true });
fs.writeFileSync(
  path.join(PUB, 'icons/sprite.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide (ISC) -->${symbols.join('')}</svg>\n`,
);
console.log('· public/icons/sprite.svg', symbols.length, 'iconos');
