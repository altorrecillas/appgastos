// Resumen del mes: lo que entró, lo que salió, en qué se fue y lo más destacado; con imagen para compartir.
import { get } from '../api.js';
import { $, html, icon, money, monthLabelFull, on, pct, plural, shiftMonth, toast, toastError, withBusy, skeletonPage } from '../ui.js';
import { NAME, TAGLINE } from '../brand.js';
import { avatar } from '../photo.js';

const WEEKDAYS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const mName = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];
const dayLong = (d) => new Date(`${d}T12:00`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const signed = (c) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${money(Math.abs(c))}`;

export default async function recapView(ctx) {
  let month = /^\d{4}-\d{2}$/.test(ctx.query.m || '') ? ctx.query.m : null;
  let d = null;

  const header = () => ctx.setHeader('Resumen del mes', d ? monthLabelFull(d.month) : '', html`
    ${d?.totals.count ? html`<button class="btn primary" data-act="share">${icon('share-2')}<span class="desktop-only">Compartir imagen</span></button>` : ''}`);

  async function load() {
    try {
      d = await get(`/stats/recap${month ? `?month=${month}` : ''}`);
      month = d.month;
      if (!ctx.isCurrent()) return;
      header();
      draw();
    } catch (e) {
      toastError(e);
    }
  }

  function draw() {
    const t = d.totals;
    const saved = t.income - t.expense;
    const rate = t.income ? saved / t.income : null;
    const vsPrev = d.prev.expense ? t.expense - d.prev.expense : null;
    const nav = html`<div class="recap-nav">
      <button class="btn ghost sm icon-only" data-m="${shiftMonth(d.month, -1)}" ${d.canPrev ? '' : 'disabled'} aria-label="Mes anterior">${icon('chevron-left')}</button>
      <b>${monthLabelFull(d.month)}</b>${d.complete ? '' : html`<span class="pill pending">en curso</span>`}
      <button class="btn ghost sm icon-only" data-m="${shiftMonth(d.month, 1)}" ${d.canNext ? '' : 'disabled'} aria-label="Mes siguiente">${icon('chevron-right')}</button></div>`;
    if (!t.count) {
      ctx.el.innerHTML = String(html`${nav}<div class="empty"><div class="art">🗓️</div><h3>Nada anotado en ${mName(d.month)}</h3>
        <p>Cuando haya movimientos de ese mes, aquí verás el resumen para compartirlo.</p></div>`);
      return;
    }
    const maxCat = Math.max(...d.categories.map((c) => c.total), 1);
    const maxPerson = Math.max(...d.people.map((p) => p.total), 1);
    ctx.el.innerHTML = String(html`${nav}<div class="recap">
      <section class="recap-hero">
        <div class="rh-month">${d.complete ? `Vuestro ${mName(d.month)}` : `Vuestro ${mName(d.month)}, hasta hoy`}</div>
        <div class="rh-amount">${money(t.expense)}</div>
        <div class="rh-label">gastados en ${plural(t.count, 'movimiento', 'movimientos')}</div>
        <p class="rh-sentence">${t.income ? (saved >= 0
          ? html`Ahorrasteis <b>${money(saved)}</b>, un ${pct(rate)} de lo que entró.`
          : html`Salió <b>${money(-saved)}</b> más de lo que entró.`) : html`Este mes no hay ingresos anotados.`}</p>
        ${vsPrev !== null ? html`<span class="rh-chip ${vsPrev <= 0 ? 'good' : 'bad'}">${icon(vsPrev <= 0 ? 'trending-down' : 'trending-up', 'sm')}
          ${signed(vsPrev)} frente a ${mName(d.prev.month)}</span>` : ''}
      </section>

      <section class="panel rc"><h2>Entró y salió</h2>
        ${[['Ingresos', t.income, 'var(--pine)'], ['Gastos', t.expense, 'var(--cobalt)']].map(([l, v, c]) => html`<div class="rc-bar">
          <span>${l}</span><div class="meter thick" style="--c:${c}"><div class="fill" style="width:${(v / Math.max(t.income, t.expense, 1)) * 100}%"></div></div><b>${money(v)}</b></div>`)}
        <p class="rc-foot">${saved >= 0 ? `Resultado: ${signed(saved)}` : `Resultado: ${signed(saved)}`}${d.avg6 ? ` · De media gastáis ${money(d.avg6, { decimals: 0 })} al mes` : ''}</p>
      </section>

      <section class="panel rc rc-wide"><h2>En qué se fue</h2>
        ${d.categories.map((c) => {
          const delta = c.prev ? (c.total - c.prev) / c.prev : null;
          return html`<div class="rc-cat"><span class="emoji">${c.icon}</span>
            <span class="n">${c.name}<small>${pct(c.share)}${delta !== null && Math.abs(delta) >= 0.1 ? ` · ${delta > 0 ? '+' : '−'}${pct(Math.abs(delta))} vs ${mName(d.prev.month)}` : ''}</small></span>
            <span class="b"><i style="width:${(c.total / maxCat) * 100}%;--c:${c.color}"></i></span><b>${money(c.total)}</b></div>`;
        })}
      </section>

      ${d.biggest ? html`<section class="panel rc"><h2>El gasto más grande</h2>
        <div class="rc-big">${money(d.biggest.amount)}</div>
        <p>${d.biggest.icon || ''} ${d.biggest.description || d.biggest.merchant || d.biggest.category || 'Sin concepto'} · ${dayLong(d.biggest.date)}</p></section>` : ''}

      ${d.busiest ? html`<section class="panel rc"><h2>El día de más gasto</h2>
        <div class="rc-big">${money(d.busiest.total)}</div>
        <p>El ${dayLong(d.busiest.date)}, en ${plural(d.busiest.n, 'compra', 'compras')}.</p>
        ${d.weekday && d.weekday.ratio >= 1.3 ? html`<p class="rc-note">${icon('sparkles', 'sm')}Los ${WEEKDAYS[d.weekday.day]} gastáis ${d.weekday.ratio >= 1.9 ? 'el doble' : `un ${pct(d.weekday.ratio - 1)} más`} que el resto de días.</p>` : ''}</section>` : ''}

      <section class="panel rc"><h2>El día a día</h2>
        <div class="rc-big">${money(d.daily)}<small> al día</small></div>
        <p>Sin contar recibos y pagos fijos (${money(d.fixed)}, un ${pct(t.expense ? d.fixed / t.expense : 0)} del total).</p></section>

      ${d.supermarket ? html`<section class="panel rc"><h2>En el súper</h2>
        <div class="rc-big">${plural(d.supermarket.n, 'compra', 'compras')}</div>
        <p>${money(d.supermarket.total)} en total, ${money(d.supermarket.avg)} de media por compra.</p></section>` : ''}

      ${d.budget ? html`<section class="panel rc"><h2>Presupuesto</h2>
        <div class="rc-big">${pct(t.expense / d.budget)}<small> usado</small></div>
        <div class="meter thick ${t.expense > d.budget ? 'over' : ''}" style="--c:var(--pine)"><div class="fill" style="width:${Math.min(1, t.expense / d.budget) * 100}%"></div></div>
        <p>${t.expense <= d.budget ? `Sobraron ${money(d.budget - t.expense)} de ${money(d.budget, { decimals: 0 })}.` : `Os pasasteis ${money(t.expense - d.budget)} de ${money(d.budget, { decimals: 0 })}.`}</p></section>` : ''}

      ${d.people.length > 1 ? html`<section class="panel rc"><h2>Quién gastó</h2>
        ${d.people.map((p) => html`<div class="rc-cat">${avatar(p, 'sm')}<span class="n">${p.name}</span>
          <span class="b"><i style="width:${(p.total / maxPerson) * 100}%;--c:${p.color}"></i></span><b>${money(p.total)}</b></div>`)}</section>` : ''}

      ${d.streak >= 2 ? html`<section class="panel rc rc-streak"><h2>Racha</h2>
        <div class="rc-big">${d.streak} meses</div><p>seguidos ahorrando. ¡Seguid así!</p></section>` : ''}
    </div>`);
  }

  // ---------- Imagen para compartir ----------
  async function shareImage(btn) {
    await withBusy(btn, async () => {
      try {
        const file = await renderImage(d);
        const text = `Nuestro ${mName(d.month)} en ${NAME}`;
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: text, text }).catch((e) => {
            if (e.name !== 'AbortError') throw e;
          });
        } else {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(file);
          a.download = file.name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          toast('Imagen descargada: ya puedes enviarla por WhatsApp o por donde quieras', { iconName: 'download' });
        }
      } catch (e) {
        toastError(e);
      }
    });
  }

  ctx.onCleanup(on(document.getElementById('page-actions'), 'click', '[data-act=share]', (e, b) => shareImage(b)));
  on(ctx.el, 'click', '[data-m]', (e, b) => {
    month = b.dataset.m;
    history.replaceState(null, '', `#/resumen?m=${month}`);
    load();
  });
  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  await load();
}

// Imagen vertical (1080 × 1350, la que mejor se ve en WhatsApp e Instagram) dibujada a mano en un canvas.
export async function renderImage(d) {
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  await Promise.all(['760 120px Bricolage', '600 40px Bricolage', '480 34px Bricolage'].map((f) => document.fonts.load(f).catch(() => {})));
  const FONT = (w, size) => `${w} ${size}px Bricolage, system-ui, sans-serif`;
  const fit = (text, maxW, w, size) => {
    let s = size;
    x.font = FONT(w, s);
    while (x.measureText(text).width > maxW && s > 20) x.font = FONT(w, --s);
  };
  const narrow = () => {
    if ('fontStretch' in x) x.fontStretch = 'semi-condensed';
  };
  const wide = () => {
    if ('fontStretch' in x) x.fontStretch = 'normal';
  };
  const round = (rx, ry, rw, rh, r, fill) => {
    x.beginPath();
    x.roundRect(rx, ry, rw, rh, r);
    x.fillStyle = fill;
    x.fill();
  };
  const t = d.totals;
  const saved = t.income - t.expense;
  const hero = getComputedStyle(document.documentElement).getPropertyValue('--hero-bg').trim() || '#1d3aa5';

  x.fillStyle = '#f2f4f8';
  x.fillRect(0, 0, W, H);
  round(40, 40, W - 80, 610, 48, hero);
  // Marca
  x.fillStyle = '#fff';
  narrow();
  x.font = FONT(760, 40);
  x.fillText('Gastos', 96, 128);
  const gw = x.measureText('Gastos').width;
  wide();
  x.font = FONT(480, 22);
  x.fillStyle = 'rgba(255,255,255,.75)';
  x.fillText('by', 96 + gw + 10, 128);
  x.strokeStyle = '#F2B232';
  x.lineWidth = 3;
  x.beginPath();
  x.roundRect(96 + gw + 44, 98, 74, 38, 9);
  x.stroke();
  x.fillStyle = '#F2B232';
  x.font = FONT(720, 22);
  x.fillText('ATH', 96 + gw + 56, 125);
  // Mes y total
  x.fillStyle = 'rgba(255,255,255,.78)';
  x.font = FONT(600, 40);
  x.fillText(`Nuestro ${mName(d.month)} ${d.month.slice(0, 4)}${d.complete ? '' : ' (hasta hoy)'}`, 96, 232);
  x.fillStyle = '#fff';
  narrow();
  fit(money(t.expense).replace(/ /g, ' '), W - 200, 760, 150);
  x.fillText(money(t.expense).replace(/ /g, ' '), 92, 390);
  wide();
  x.font = FONT(480, 34);
  x.fillStyle = 'rgba(255,255,255,.78)';
  x.fillText(`gastados en ${plural(t.count, 'movimiento', 'movimientos')}`, 96, 446);
  if (t.income) {
    x.font = FONT(650, 40);
    x.fillStyle = saved >= 0 ? '#F2B232' : '#ff9aa5';
    const line = saved >= 0 ? `Ahorrado: ${money(saved)} (${pct(saved / t.income)})` : `${money(-saved)} más de lo que entró`;
    fit(line.replace(/ /g, ' '), W - 200, 650, 40);
    x.fillText(line.replace(/ /g, ' '), 96, 540);
  }
  if (d.prev.expense) {
    const diff = t.expense - d.prev.expense;
    x.font = FONT(500, 30);
    x.fillStyle = 'rgba(255,255,255,.78)';
    x.fillText(`${diff <= 0 ? '▼' : '▲'} ${money(Math.abs(diff)).replace(/ /g, ' ')} ${diff <= 0 ? 'menos' : 'más'} que en ${mName(d.prev.month)}`, 96, 598);
  }
  // En qué se fue
  round(40, 690, W - 80, 520, 48, '#ffffff');
  x.fillStyle = '#111a30';
  x.font = FONT(680, 40);
  x.fillText('En qué se fue', 96, 772);
  const cats = d.categories.slice(0, 5);
  const max = Math.max(...cats.map((cc) => cc.total), 1);
  cats.forEach((cc, i) => {
    const y = 840 + i * 74;
    x.font = '34px "Apple Color Emoji","Noto Color Emoji","Segoe UI Emoji",sans-serif';
    x.fillText(cc.icon, 96, y + 12);
    x.fillStyle = '#111a30';
    x.font = FONT(600, 30);
    fit(cc.name, 300, 600, 30);
    x.fillText(cc.name, 150, y + 10);
    round(470, y - 14, 330, 22, 11, '#eceff5');
    round(470, y - 14, Math.max(22, (cc.total / max) * 330), 22, 11, cc.color);
    x.fillStyle = '#111a30';
    x.font = FONT(700, 30);
    const v = money(cc.total, { decimals: 0 }).replace(/ /g, ' ');
    x.fillText(v, W - 96 - x.measureText(v).width, y + 10);
  });
  // Pie
  x.fillStyle = '#737d93';
  x.font = FONT(500, 26);
  const foot = `Hecho con ${NAME} · ${TAGLINE}`;
  x.fillText(foot, (W - x.measureText(foot).width) / 2, H - 70);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([blob], `resumen-${mName(d.month)}-${d.month.slice(0, 4)}.png`, { type: 'image/png' });
}

