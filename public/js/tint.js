// El color del hogar tiñe la aplicación: botones, enlaces, selección y la cabecera de Inicio.
// Los tonos se calculan en OKLCH (claridad perceptual) y se ajustan para que el texto siga leyéndose bien.

const BRAND = '#2347C5';
const VARS = ['--cobalt', '--cobalt-hover', '--cobalt-deep', '--cobalt-soft', '--cobalt-line', '--hero-bg'];

// ---------- Conversión sRGB ↔ OKLCH ----------
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function hexToOklch(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => toLin(x / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), H: (Math.atan2(B, A) * 180) / Math.PI };
}
function oklchToRgb({ L, C, H }) {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
// Si el color se sale de sRGB se va bajando la saturación hasta que cabe.
function oklchToHex(c) {
  let cc = { ...c };
  for (let i = 0; i < 30; i++) {
    const rgb = oklchToRgb(cc);
    if (rgb.every((x) => x >= -0.0005 && x <= 1.0005)) break;
    cc = { ...cc, C: cc.C * 0.93 };
  }
  return `#${oklchToRgb(cc).map((x) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, x))))) * 255).toString(16).padStart(2, '0')).join('')}`;
}
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => toLin(x / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// Baja (o sube) la claridad hasta llegar al contraste pedido contra un fondo.
function untilContrast(base, against, min, step) {
  let c = { ...base };
  for (let i = 0; i < 60 && contrast(oklchToHex(c), against) < min; i++) c = { ...c, L: Math.max(0.05, Math.min(0.97, c.L + step)) };
  return c;
}

export function tintPalette(hex, dark = false) {
  const base = hexToOklch(hex);
  const C = Math.min(base.C, 0.2);
  const H = base.H;
  if (!dark) {
    const accent = untilContrast({ L: Math.min(base.L, 0.6), C, H }, '#ffffff', 4.8, -0.02);
    return {
      '--cobalt': oklchToHex(accent),
      '--cobalt-hover': oklchToHex({ ...accent, L: accent.L - 0.05 }),
      '--cobalt-deep': oklchToHex({ ...accent, L: accent.L - 0.1 }),
      '--cobalt-soft': oklchToHex({ L: 0.95, C: Math.min(C * 0.3, 0.04), H }),
      '--cobalt-line': oklchToHex({ L: 0.86, C: Math.min(C * 0.5, 0.08), H }),
      '--hero-bg': oklchToHex(untilContrast({ L: Math.min(accent.L - 0.06, 0.44), C: Math.min(C, 0.16), H }, '#ffffff', 7.5, -0.02)),
    };
  }
  const accent = untilContrast({ L: 0.74, C: Math.min(C, 0.15), H }, '#111829', 6, 0.02);
  return {
    '--cobalt': oklchToHex(accent),
    '--cobalt-hover': oklchToHex({ ...accent, L: accent.L + 0.05 }),
    '--cobalt-deep': oklchToHex(untilContrast({ L: 0.55, C: Math.min(C, 0.16), H }, '#ffffff', 4.6, -0.02)),
    '--cobalt-soft': oklchToHex({ L: 0.27, C: Math.min(C * 0.45, 0.07), H }),
    '--cobalt-line': oklchToHex({ L: 0.38, C: Math.min(C * 0.55, 0.09), H }),
    '--hero-bg': oklchToHex(untilContrast({ L: 0.34, C: Math.min(C, 0.13), H }, '#ffffff', 8, -0.02)),
  };
}

let current = null;
// h: { color, tint }. Con el azul de la marca o el tinte desactivado se usan los colores de siempre.
export function applyTint(h) {
  current = h;
  const root = document.documentElement;
  const off = !h || !h.tint || !h.color || h.color.toUpperCase() === BRAND;
  if (off) {
    VARS.forEach((v) => root.style.removeProperty(v));
  } else {
    const pal = tintPalette(h.color, root.dataset.theme === 'dark');
    for (const [k, val] of Object.entries(pal)) root.style.setProperty(k, val);
  }
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', root.dataset.theme === 'dark' ? '#0a0f1d' : getComputedStyle(root).getPropertyValue('--hero-bg').trim() || '#1d3aa5');
}
// Al cambiar entre claro y oscuro se recalcula.
export const reapplyTint = () => applyTint(current);
