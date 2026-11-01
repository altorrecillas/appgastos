// Markdown de las notas: marked para interpretarlo y DOMPurify para que el HTML resultante sea seguro.
// Las dos librerías se descargan la primera vez que se abre una nota.
let lib = null;

function load() {
  if (!lib) {
    lib = Promise.all([import('/vendor/marked.esm.js'), import('/vendor/purify.es.js')]).then(([m, p]) => {
      const marked = new m.Marked({ gfm: true, breaks: true });
      const purify = p.default;
      // Enlaces: solo web, correo y teléfono. Imágenes: solo las guardadas en la propia app (nada de rastreadores externos).
      purify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A') {
          if (node.hasAttribute('href') && !SAFE_LINK.test(node.getAttribute('href'))) node.removeAttribute('href');
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
        if (node.tagName === 'IMG') {
          if (!SAFE_IMG.test(node.getAttribute('src') || '')) node.removeAttribute('src');
          node.setAttribute('loading', 'lazy');
        }
      });
      return { marked, purify };
    });
  }
  return lib;
}

const SAFE_LINK = /^(?:https?:|mailto:|tel:|#)/i;
const SAFE_IMG = /^\/api\/h\/\d+\/attachments\/\d+$/;

export async function renderMarkdown(src) {
  const { marked, purify } = await load();
  return purify.sanitize(marked.parse(String(src || '')), {
    ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
  });
}

// Posición de cada casilla «- [ ]» del texto, en el mismo orden en que salen al verlo (sin contar los bloques de código).
export function taskOffsets(src) {
  const out = [];
  let fence = false;
  let pos = 0;
  for (const line of String(src).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const m = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/);
      if (m) out.push(pos + m[1].length + 1);
    }
    pos += line.length + 1;
  }
  return out;
}

// Marca o desmarca la casilla número i.
export function toggleTask(src, i) {
  const at = taskOffsets(src)[i];
  if (at === undefined) return src;
  return src.slice(0, at) + (src[at] === ' ' ? 'x' : ' ') + src.slice(at + 1);
}

// Progreso de las casillas de una nota: { done, total }.
export function taskProgress(src) {
  const offs = taskOffsets(src);
  return { total: offs.length, done: offs.filter((o) => src[o] !== ' ').length };
}
