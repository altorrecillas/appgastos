// Gestos táctiles: deslizar filas, pulsación larga, arrastrar para ordenar y vibración.
import { html, icon } from './ui.js';

export const haptic = (ms = 12) => {
  try {
    navigator.vibrate?.(ms);
  } catch { /* sin vibración */ }
};
export const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

// Envoltorio de una fila deslizable. Acciones: { icon, label, tone: 'blue'|'green'|'red'|'amber', destructive }
export function swipeRow(content, { id, left = null, right = null, extraClass = '' } = {}) {
  return html`<div class="sw ${extraClass}" data-sw="${id}" ${left ? 'data-has-left' : ''} ${right ? 'data-has-right' : ''}>
    <div class="sw-bg" aria-hidden="true">
      ${left ? html`<span class="sw-a sw-l tone-${left.tone || 'blue'}">${icon(left.icon)}<b>${left.label}</b></span>` : ''}
      ${right ? html`<span class="sw-a sw-r tone-${right.tone || 'red'}">${icon(right.icon)}<b>${right.label}</b></span>` : ''}
    </div>
    <div class="sw-fg">${content}</div>
  </div>`;
}

// Activa deslizar y pulsación larga en las filas .sw de un contenedor.
// onSwipe(el, 'left'|'right') → la acción "left" se revela al deslizar hacia la derecha.
export function enableSwipe(root, { onSwipe, onLongPress, destructive = {} } = {}) {
  let st = null;
  let suppressClick = false;

  const reset = (el, animate = true) => {
    const fg = el.querySelector('.sw-fg');
    fg.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : '';
    fg.style.transform = '';
    el.classList.remove('armed', 'swiping');
    delete el.dataset.dir;
  };

  const down = (e) => {
    const el = e.target.closest('.sw');
    if (!el || !root.contains(el) || e.button > 0) return;
    if (e.target.closest('.sw-nodrag, input, select, textarea, [data-grip]')) return;
    if (root.classList.contains('selecting')) return;
    st = { el, x: e.clientX, y: e.clientY, id: e.pointerId, t: Date.now(), dx: 0, mode: null, touch: e.pointerType !== 'mouse' };
    if (onLongPress && st.touch) {
      st.timer = setTimeout(() => {
        if (st && !st.mode) {
          st.mode = 'long';
          haptic(25);
          suppressClick = true;
          onLongPress(el);
        }
      }, 480);
    }
  };

  const move = (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    if (!st.mode) {
      if (Math.abs(dx) > 9 && Math.abs(dx) > Math.abs(dy) * 1.3 && st.touch) {
        st.mode = 'swipe';
        clearTimeout(st.timer);
        st.el.classList.add('swiping');
        try {
          st.el.setPointerCapture(e.pointerId);
        } catch { /* nada */ }
      } else if (Math.abs(dy) > 9 || Math.abs(dx) > 9) {
        clearTimeout(st.timer);
        st.mode = 'scroll';
      }
    }
    if (st.mode !== 'swipe') return;
    e.preventDefault();
    const w = st.el.offsetWidth;
    const dir = dx > 0 ? 'right' : 'left';
    const allowed = dir === 'right' ? st.el.hasAttribute('data-has-left') : st.el.hasAttribute('data-has-right');
    let x = dx;
    if (!allowed) x = dx / 6; // resistencia si no hay acción en ese lado
    else if (Math.abs(dx) > w * 0.6) x = Math.sign(dx) * (w * 0.6 + (Math.abs(dx) - w * 0.6) / 4);
    st.dx = dx;
    const fg = st.el.querySelector('.sw-fg');
    fg.style.transition = '';
    fg.style.transform = `translateX(${x}px)`;
    st.el.dataset.dir = dir;
    const armed = allowed && Math.abs(dx) > Math.min(110, w * 0.3);
    if (armed !== st.el.classList.contains('armed')) {
      st.el.classList.toggle('armed', armed);
      if (armed) haptic(10);
    }
  };

  const up = (e) => {
    if (!st || e.pointerId !== st.id) return;
    clearTimeout(st.timer);
    const { el, mode } = st;
    if (mode === 'swipe') {
      suppressClick = true;
      const armed = el.classList.contains('armed');
      const dir = st.dx > 0 ? 'right' : 'left';
      const action = dir === 'right' ? 'left' : 'right';
      if (armed) {
        haptic(18);
        if (destructive[action]) {
          const fg = el.querySelector('.sw-fg');
          fg.style.transition = 'transform .22s ease-in';
          fg.style.transform = `translateX(${dir === 'right' ? '' : '-'}110%)`;
          el.style.transition = 'height .22s ease .18s, opacity .2s ease .18s';
          el.style.height = `${el.offsetHeight}px`;
          requestAnimationFrame(() => {
            el.style.height = '0px';
            el.style.opacity = '0';
          });
          setTimeout(() => onSwipe?.(el, action), 240);
        } else {
          reset(el);
          onSwipe?.(el, action);
        }
        // Quien ya usa el gesto no necesita la pista.
        el.dispatchEvent(new Event('gesture-used', { bubbles: true }));
      } else reset(el);
    }
    st = null;
  };

  const cancel = () => {
    if (!st) return;
    clearTimeout(st.timer);
    if (st.mode === 'swipe') reset(st.el);
    st = null;
  };

  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move, { passive: false });
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', cancel);
  // Tras deslizar o mantener pulsado no debe dispararse el clic de la fila.
  root.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  root.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.sw') && isTouch()) e.preventDefault();
  });
}

// Arrastrar para ordenar con un asa [data-grip]. Los elementos se pueden mover entre contenedores [data-drop].
export function enableDragSort(root, { item = '.sw', onDrop } = {}) {
  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || !root.contains(grip)) return;
    const el = grip.closest(item);
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const ph = document.createElement('div');
    ph.className = 'drag-ph';
    ph.style.height = `${r.height}px`;
    el.after(ph);
    el.classList.add('dragging');
    Object.assign(el.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, zIndex: 100, pointerEvents: 'none' });
    drag = { el, ph, offY: e.clientY - r.top, from: el.closest('[data-drop]'), id: e.pointerId, lastY: e.clientY };
    grip.setPointerCapture(e.pointerId);
    haptic(20);
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    drag.lastY = e.clientY;
    drag.el.style.top = `${e.clientY - drag.offY}px`;
    // Desplazamiento automático cerca de los bordes.
    if (e.clientY < 90) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 110) window.scrollBy(0, 12);
    const candidates = [...root.querySelectorAll(`[data-drop] > ${item}:not(.dragging), [data-drop] > .drag-ph`)];
    let target = null;
    for (const c of candidates) {
      if (c === drag.ph) continue;
      const cr = c.getBoundingClientRect();
      if (e.clientY < cr.top + cr.height / 2) {
        target = c;
        break;
      }
    }
    if (target) {
      if (target.previousElementSibling !== drag.ph) target.before(drag.ph);
    } else {
      // Al final del contenedor más cercano por debajo del puntero.
      const zones = [...root.querySelectorAll('[data-drop]')];
      const zone = zones.filter((z) => z.getBoundingClientRect().top < e.clientY).at(-1) || zones[0];
      if (zone && drag.ph.parentElement !== zone) zone.append(drag.ph);
      else if (zone && zone.lastElementChild !== drag.ph) zone.append(drag.ph);
    }
  }, { passive: false });
  const finish = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { el, ph } = drag;
    el.removeAttribute('style');
    el.classList.remove('dragging');
    ph.replaceWith(el);
    const zone = el.closest('[data-drop]');
    haptic(12);
    drag = null;
    onDrop?.(el, zone);
  };
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', finish);
}

// Guía de gestos la primera vez que se ve una lista en un móvil.
// Pista breve con una mini animación del gesto. Se deja de mostrar al cerrarla, al usar el gesto
// o tras verla unas cuantas veces.
export function gestureHint(host, key, text) {
  if (!isTouch()) return;
  const k = `gastosbyath.hint.${key}`;
  try {
    if (localStorage.getItem(k) === '1') return;
    const seen = Number(localStorage.getItem(`${k}.n`) || 0) + 1;
    localStorage.setItem(`${k}.n`, String(seen));
    if (seen > 4) return;
  } catch {
    return;
  }
  const el = document.createElement('div');
  el.className = 'gesture-hint';
  el.innerHTML = String(html`<span class="gh-demo" aria-hidden="true"><i></i></span><span class="gh-text">${text}</span>
    <button type="button" aria-label="Entendido">${icon('x', 'sm')}</button>`);
  const done = () => {
    try {
      localStorage.setItem(k, '1');
    } catch { /* nada */ }
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('button').addEventListener('click', done);
  // Quien ya desliza una fila no necesita la pista.
  host.addEventListener('gesture-used', done, { once: true });
  host.prepend(el);
}
