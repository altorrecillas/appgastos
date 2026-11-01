// Lectura de tickets en el propio dispositivo (Tesseract en WebAssembly): la foto no sale del móvil para leerse.
// La primera vez se descarga el lector (unos 12 MB) y queda guardado para las siguientes.
import { parseReceipt } from './receipt.js';
import { today } from './ui.js';

const BASE = '/vendor/tesseract';
let scriptLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!scriptLoading) {
    scriptLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${BASE}/tesseract.min.js`;
      s.onload = resolve;
      s.onerror = () => {
        scriptLoading = null;
        reject(new Error('No se ha podido cargar el lector de tickets'));
      };
      document.head.append(s);
    });
  }
  return scriptLoading;
}

let onProgress = () => {};
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadTesseract();
      const w = await window.Tesseract.createWorker('spa', 1, {
        workerPath: `${BASE}/worker.min.js`, corePath: `${BASE}/core`, langPath: `${BASE}/lang`,
        workerBlobURL: false, gzip: true, logger: (m) => onProgress(m),
      });
      // Los tickets son una columna de líneas de distinto tamaño.
      await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return w;
    })();
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}
export const ocrReady = () => !!workerPromise;

async function bitmapOf(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Algunos navegadores no abren ciertos formatos con createImageBitmap: se intenta con <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch {
      throw new Error('No se puede abrir esa imagen. Prueba con una foto en JPG o PNG.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// Foto para leer: tamaño cómodo, en gris y con el contraste estirado (papel blanco, tinta negra).
async function prepare(bmp) {
  const w0 = bmp.width;
  const h0 = bmp.height;
  const long = Math.max(w0, h0);
  const scale = long > 2400 ? 2400 / long : long < 1400 ? 1400 / long : 1;
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = y;
    hist[y]++;
  }
  const n = w * h;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && acc + hist[lo] < n * 0.01; lo++) acc += hist[lo];
  for (let acc = 0; hi > 0 && acc + hist[hi] < n * 0.02; hi--) acc += hist[hi];
  const span = Math.max(hi - lo, 1);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Copia para adjuntar al gasto: en color, bien orientada y ligera.
export async function compressPhoto(file, max = 1600) {
  const bmp = await bitmapOf(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.82));
  const stamp = today().replace(/-/g, '');
  return new File([blob], `ticket-${stamp}.jpg`, { type: 'image/jpeg' });
}

const STEPS = {
  'loading tesseract core': 'Preparando el lector de tickets…',
  'initializing tesseract': 'Preparando el lector de tickets…',
  'loading language traineddata': 'Descargando el español del lector (solo la primera vez)…',
  'initializing api': 'Preparando el lector de tickets…',
  'recognizing text': 'Leyendo el ticket…',
};

// Lee un ticket: { total (céntimos), date, merchant, confidence, text }.
export async function readReceipt(file, progress = () => {}) {
  onProgress = (m) => progress({ text: STEPS[m.status] || 'Leyendo el ticket…', value: m.status === 'recognizing text' ? m.progress : null });
  progress({ text: 'Preparando la foto…', value: null });
  const [worker, canvas] = await Promise.all([getWorker(), bitmapOf(file).then(prepare)]);
  const { data } = await worker.recognize(canvas);
  return { ...parseReceipt(data.text, { today: today() }), text: data.text, ocrConfidence: data.confidence };
}
