// Gráficos con ECharts (cargado bajo demanda desde /vendor) y un estilo común:
// marcas finas, rejilla de un filete, tooltips con el valor delante y colores del tema.
import { compactMoney, esc, money, monthShort } from './ui.js';

let loading = null;
export function loadECharts() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/echarts.min.js';
      s.onload = () => resolve(window.echarts);
      s.onerror = () => {
        loading = null;
        reject(new Error('No se pudo cargar la librería de gráficos'));
      };
      document.head.append(s);
    });
  }
  return loading;
}

export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    dark: document.documentElement.dataset.theme === 'dark',
    font: v('--font'),
    ink: v('--ink'),
    ink2: v('--ink-2'),
    ink3: v('--ink-3'),
    surface: v('--surface'),
    surface2: v('--surface-2'),
    surface3: v('--surface-3'),
    line: v('--line'),
    grid: v('--chart-grid'),
    axis: v('--chart-axis'),
    muted: v('--chart-muted'),
    cobalt: v('--cobalt'),
    saffron: v('--saffron'),
    pine: v('--pine'),
    granada: v('--granada'),
    heroInk: '#ffffff',
    heroInk2: 'rgba(255,255,255,0.72)',
    heroLine: 'rgba(255,255,255,0.16)',
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--chart-${i}`)),
  };
}

// Registro de instancias para redimensionar, retematizar y liberar.
const live = new Map(); // el -> { inst, build, ro }

export async function mountChart(el, build) {
  if (!el) return null;
  const ec = await loadECharts();
  let entry = live.get(el);
  if (!entry || entry.inst.isDisposed()) {
    const inst = ec.init(el, null, { renderer: 'svg' });
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(el);
    entry = { inst, ro, build };
    live.set(el, entry);
  }
  entry.build = build;
  entry.inst.setOption(build(tokens()), { notMerge: true });
  return entry.inst;
}

export function disposeCharts(root = document) {
  for (const [el, { inst, ro }] of live) {
    if (!document.contains(el) || root.contains(el)) {
      ro.disconnect();
      inst.dispose();
      live.delete(el);
    }
  }
}

export function rethemeCharts() {
  for (const [el, entry] of live) {
    if (!document.contains(el)) continue;
    entry.inst.setOption(entry.build(tokens()), { notMerge: true });
  }
}

// ---------- Piezas comunes ----------
export const tipBox = (t) => ({
  backgroundColor: t.surface,
  borderColor: t.line,
  borderWidth: 1,
  padding: [9, 12],
  textStyle: { color: t.ink, fontFamily: t.font, fontSize: 13 },
  extraCssText: 'border-radius:12px; box-shadow: 0 12px 32px -12px rgba(0,0,0,.35);',
  confine: true,
});

// Filas del tooltip: el valor primero y en negrita; la etiqueta, después.
export function tipHTML(title, rows) {
  return `<div class="ec-tip">${title ? `<div class="h">${esc(title)}</div>` : ''}${rows
    .map((r) => `<div class="r"><i class="${r.box ? 'box' : ''}" style="background:${esc(r.color || 'transparent')}"></i><b>${esc(r.value)}</b><span>${esc(r.label || '')}</span></div>`)
    .join('')}</div>`;
}

export const axisLabel = (t, extra = {}) => ({ color: t.ink3, fontFamily: t.font, fontSize: 11.5, ...extra });

export function catAxis(t, data, extra = {}) {
  return {
    type: 'category',
    data,
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: axisLabel(t),
    ...extra,
  };
}
export function valAxis(t, extra = {}) {
  return {
    type: 'value',
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
    axisLabel: axisLabel(t, { formatter: (v) => compactMoney(v) }),
    splitNumber: 4,
    ...extra,
  };
}
export const grid = (extra = {}) => ({ left: 4, right: 12, top: 18, bottom: 4, containLabel: true, ...extra });

export const barSeries = (t, extra = {}) => ({
  type: 'bar',
  barMaxWidth: 22,
  itemStyle: { borderRadius: [4, 4, 0, 0] },
  emphasis: { focus: 'none', itemStyle: { opacity: 0.85 } },
  ...extra,
});
export const lineSeries = (t, extra = {}) => ({
  type: 'line',
  showSymbol: false,
  symbol: 'circle',
  symbolSize: 8,
  lineStyle: { width: 2, cap: 'round', join: 'round' },
  emphasis: { focus: 'none', scale: 1 },
  ...extra,
});

export const monthTick = (ym) => monthShort(ym);
export const moneyTip = (cents) => money(cents);
