// Preferencias de cada persona que cambian cómo se ve la app: vista sencilla y tamaño del texto.
export const TEXT_SIZES = { normal: 1, large: 1.15, xlarge: 1.3 };
export const isSimple = () => document.documentElement.dataset.simple === '1';

export function applyPrefs(settings = {}) {
  const root = document.documentElement;
  const fs = TEXT_SIZES[settings.text] || 1;
  root.style.setProperty('--fs', String(fs));
  if (settings.simple) root.dataset.simple = '1';
  else delete root.dataset.simple;
  // Copia local para aplicarlas antes de pintar la próxima vez (sin parpadeo).
  try {
    localStorage.setItem('gastosbyath.text', String(fs));
    localStorage.setItem('gastosbyath.simple', settings.simple ? '1' : '0');
  } catch { /* sin almacenamiento */ }
}
