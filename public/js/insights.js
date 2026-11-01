// Avisos que se adelantan («la luz va un 20 % por encima», «Netflix ha subido»…): tarjetas y descarte.
import { post } from './api.js';
import { html, icon, on, toast } from './ui.js';

export const TONES = { warn: 'Ojo', info: 'Dato útil', good: 'Buenas noticias' };

export function insightCards(list, { limit = 3, all = false } = {}) {
  const shown = all ? list : list.slice(0, limit);
  return html`<div class="insights">${shown.map((x) => html`<article class="insight ${x.tone}" data-insight="${x.key}">
    <span class="in-ico">${icon(x.icon || 'info')}</span>
    <div class="in-body">
      <span class="in-tone">${TONES[x.tone]}</span>
      <h3>${x.title}</h3>
      <p>${x.text}</p>
      <div class="in-actions">
        ${x.action ? html`<a class="btn sm" href="${x.action.href}">${x.action.label}</a>` : ''}
        ${x.url ? html`<a class="btn ghost sm" href="${x.url}">Ver</a>` : ''}
      </div>
    </div>
    <button type="button" class="in-x" data-dismiss="${x.key}" aria-label="Entendido, no volver a mostrar">${icon('x', 'sm')}</button>
  </article>`)}</div>`;
}

// «Entendido»: el aviso desaparece para esta persona (los demás del hogar lo siguen viendo).
export function bindInsights(root, onDismiss) {
  return on(root, 'click', '[data-dismiss]', async (e, b) => {
    const card = b.closest('[data-insight]');
    card?.classList.add('leaving');
    try {
      await post('/stats/insights/dismiss', { key: b.dataset.dismiss });
    } catch {
      card?.classList.remove('leaving');
      return toast('No se ha podido descartar ahora', { type: 'err' });
    }
    setTimeout(() => onDismiss?.(b.dataset.dismiss), 180);
    window.dispatchEvent(new Event('gastosbyath:alerts'));
  });
}
