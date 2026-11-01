// Notas al estilo de Joplin: cuadernos del hogar y privados, Markdown, etiquetas, tareas, búsqueda y papelera.
// En el ordenador, tres columnas (cuadernos · lista · nota); en el móvil, la lista y la nota a pantalla completa.
import { ApiError, del, get, hapi, hurl, patch, post, uploadNoteImage } from '../api.js';
import {
  $, confirmDialog, download, esc, fmtDate, html, icon, on, openMenu, plural, promptDialog, raw, sheet, timeAgo, toast, toastError, today, withBusy, skeletonPage,
} from '../ui.js';
import { store } from '../store.js';
import { renderMarkdown, taskProgress, toggleTask } from '../markdown.js';

const wide = () => window.matchMedia('(min-width: 1024px)').matches;
const prefKey = () => `gastosbyath.notes.${store.hid}.${store.me.id}`;
const readPref = () => {
  try {
    return JSON.parse(localStorage.getItem(prefKey()) || '{}');
  } catch {
    return {};
  }
};
const writePref = (p) => {
  try {
    localStorage.setItem(prefKey(), JSON.stringify({ ...readPref(), ...p }));
  } catch { /* sin almacenamiento */ }
};
const SORTS = { updated: 'Última modificación', created: 'Fecha de creación', title: 'Título' };

// Fecha límite de una tarea: «hoy», «mañana a las 10:30», «vencida»…
function dueLabel(n) {
  if (!n.due_at) return null;
  const [d, t] = n.due_at.split('T');
  const days = Math.round((Date.parse(d) - Date.parse(today())) / 864e5);
  const when = days === 0 ? 'hoy' : days === 1 ? 'mañana' : days === -1 ? 'ayer' : fmtDate(d);
  return { text: `${when}${t ? ` a las ${t}` : ''}`, late: !n.done_at && (days < 0 || (days === 0 && t && t < new Date().toTimeString().slice(0, 5))), soon: days >= 0 && days <= 1 };
}

// Reduce una foto grande antes de subirla (las notas no necesitan 12 megapíxeles).
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 900 * 1024) return file;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) return file;
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
  return blob ? new File([blob], (file.name || 'imagen').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
}

export default async function notesView(ctx) {
  const pref = readPref();
  let meta = null;
  let list = [];
  let filter = { view: pref.view || 'all', book: pref.book || null, tag: null };
  let q = '';
  let sort = pref.sort || 'updated';
  let note = null; // la nota abierta (id null mientras es un borrador sin guardar)
  let mode = pref.mode || (wide() ? 'split' : 'view');
  let dirty = false;
  let saving = null;
  let timer = null;
  let conflict = null;
  let status = '';
  let isWide = wide();
  let pushed = false; // en el móvil, abrir una nota añade un paso al historial para que «Atrás» vuelva a la lista
  const routeId = ctx.params[0];

  ctx.setHeader('Notas', 'Del hogar y privadas', html`
    <button class="btn" data-act="new-todo" aria-label="Nueva tarea">${icon('list-todo')}<span class="desktop-only">Tarea</span></button>
    <button class="btn primary" data-act="new-note" aria-label="Nueva nota">${icon('notebook-pen')}<span class="desktop-only">Nueva nota</span></button>`);

  const bookOf = (id) => meta?.books.find((b) => b.id === id);
  const canWriteBook = (b) => b && (b.private || meta.can_share);
  const defaultBook = () => {
    const sel = filter.book && bookOf(filter.book);
    if (sel && canWriteBook(sel)) return sel;
    return meta.books.find((b) => b.private) || meta.books[0];
  };
  const listTitle = () => {
    if (q) return `Buscar «${q}»`;
    if (filter.tag) return `#${filter.tag}`;
    if (filter.book) return bookOf(filter.book)?.name || 'Cuaderno';
    return { all: 'Todas las notas', todo: 'Tareas', trash: 'Papelera', private: 'Solo para ti' }[filter.view];
  };

  // ---------- Datos ----------
  async function loadMeta() {
    meta = await get('/notes/meta');
    if (filter.book && !bookOf(filter.book)) filter.book = null;
  }
  async function loadList() {
    const p = new URLSearchParams({ sort });
    if (q) p.set('q', q);
    else if (filter.tag) p.set('tag', filter.tag);
    else if (filter.book) p.set('book', filter.book);
    if (!q) p.set('view', filter.book || filter.tag ? 'all' : filter.view);
    list = await get(`/notes?${p}`);
  }
  async function load() {
    try {
      await Promise.all([loadMeta(), loadList()]);
      if (!ctx.isCurrent()) return;
      // Si alguien ha cambiado la nota abierta y aquí no hay nada pendiente, se trae la versión nueva.
      if (note?.id && !dirty && !saving) {
        const fresh = list.find((x) => x.id === note.id);
        if (fresh && fresh.updated_at !== note.updated_at) {
          const n = await get(`/notes/${note.id}`).catch(() => null);
          if (n && !dirty) note = n;
        }
      }
      drawShell();
    } catch (e) {
      toastError(e);
    }
  }

  // ---------- Pintado ----------
  function drawShell() {
    isWide = wide();
    const editing = !!note;
    ctx.el.innerHTML = String(html`<div class="notes ${isWide ? 'wide' : 'narrow'} ${editing ? 'has-note' : ''}">
      ${isWide ? html`<aside class="nb-pane" data-books>${booksPane()}</aside>` : ''}
      <section class="nl-pane" data-listpane>${listPane()}</section>
      <section class="ne-pane" data-editor></section>
    </div>`);
    drawEditor();
  }
  const redrawList = () => {
    const pane = $('[data-listpane]', ctx.el);
    if (!pane) return;
    const scroll = $('[data-list]', pane)?.scrollTop || 0;
    const input = $('[data-q]', pane);
    const focused = document.activeElement === input;
    const pos = input?.selectionStart;
    pane.innerHTML = String(listPane());
    const l = $('[data-list]', pane);
    if (l) l.scrollTop = scroll;
    if (focused) {
      const again = $('[data-q]', pane);
      again.focus();
      again.setSelectionRange(pos, pos);
    }
    const bp = $('[data-books]', ctx.el);
    if (bp) bp.innerHTML = String(booksPane());
  };

  function bookRows(priv) {
    const books = meta.books.filter((b) => !!b.private === priv);
    const ids = new Set(books.map((b) => b.id));
    const rows = (pid, depth) => books.filter((b) => (b.parent_id && ids.has(b.parent_id) ? b.parent_id : null) === pid)
      .flatMap((b) => [html`<div class="nb-row ${filter.book === b.id ? 'on' : ''}" style="--d:${depth}">
        <button type="button" class="nb-item" data-book="${b.id}"><span class="emoji">${b.icon}</span><span class="grow ellipsis">${b.name}</span><span class="n">${b.n || ''}</span></button>
        ${canWriteBook(b) ? html`<button type="button" class="nb-more" data-bookmenu="${b.id}" aria-label="Opciones de ${b.name}">${icon('ellipsis', 'sm')}</button>` : ''}
      </div>`, ...rows(b.id, depth + 1)]);
    return rows(null, 0);
  }

  function booksPane() {
    const c = meta.counts;
    const smart = (view, ic, label, n) => html`<button type="button" class="nb-item smart ${!filter.book && !filter.tag && !q && filter.view === view ? 'on' : ''}" data-view="${view}">
      ${icon(ic, 'sm')}<span class="grow">${label}</span><span class="n">${n || ''}</span></button>`;
    return html`<div class="nb-scroll">
      ${smart('all', 'notebook-tabs', 'Todas las notas', c.total)}
      ${smart('todo', 'list-todo', 'Tareas pendientes', c.todo)}
      <div class="nb-cap"><span>${icon('house', 'sm')}Del hogar</span>${meta.can_share ? html`<button type="button" data-newbook="shared" aria-label="Nuevo cuaderno del hogar">${icon('folder-plus', 'sm')}</button>` : ''}</div>
      <p class="nb-hint">Las ve toda la familia</p>
      ${bookRows(false)}
      <div class="nb-cap"><span>${icon('lock', 'sm')}Solo para ti</span><button type="button" data-newbook="private" aria-label="Nuevo cuaderno privado">${icon('folder-plus', 'sm')}</button></div>
      <p class="nb-hint">Nadie más puede verlas</p>
      ${bookRows(true)}
      ${meta.tags.length ? html`<div class="nb-cap"><span>${icon('tags', 'sm')}Etiquetas</span></div>
        <div class="nb-tags">${meta.tags.map((t) => html`<button type="button" class="chip sm" data-tag="${t.tag}" aria-pressed="${filter.tag === t.tag}">#${t.tag}<span class="n">${t.n}</span></button>`)}</div>` : ''}
      <div class="nb-sep"></div>
      ${smart('trash', 'trash-2', 'Papelera', c.trash)}
      ${backupRow()}
    </div>`;
  }

  // Cuándo fue la última copia (y un aviso discreto si hace más de un mes y ya hay unas cuantas notas).
  function backupDue() {
    const last = meta.last_backup;
    const days = last ? Math.floor((Date.now() - Date.parse(last)) / 864e5) : null;
    return meta.counts.total >= 5 && (days === null || days > 30);
  }
  function backupRow() {
    const last = meta.last_backup;
    const due = backupDue();
    return html`<button type="button" class="nb-item nb-backup ${due ? 'due' : ''}" data-act="backup">${icon('archive', 'sm')}
      <span class="grow">Copia de seguridad<small>${last ? `Última ${timeAgo(last)}` : 'Aún no has hecho ninguna'}</small></span>
      ${due ? html`<i class="nb-dot" aria-label="Conviene hacer una copia"></i>` : ''}</button>`;
  }

  function backupSheet() {
    const c = meta.counts;
    const shared = c.total - c.private;
    let scope = 'all';
    const opt = (v, label, sub) => html`<button type="button" class="bk-opt" role="radio" data-scope="${v}" aria-checked="${scope === v}">
      <i></i><span><b>${label}</b><small>${sub}</small></span></button>`;
    const s = sheet({
      title: 'Copia de seguridad de las notas',
      size: 'narrow',
      body: html`<div class="stack" style="gap:22px">
        <section class="bk-block">
          <div class="bk-head"><span class="bk-ico">${icon('download')}</span><div><h3>Descargar una copia</h3>
            <span class="small muted" data-last>${meta.last_backup ? `Última copia ${timeAgo(meta.last_backup)}` : 'Aún no has hecho ninguna'}</span></div></div>
          <p class="small ink-2">Un archivo .zip con las notas en Markdown, ordenadas por cuadernos y con sus imágenes. Se puede abrir sin la app
            (o importar en Joplin) y aquí se restaura tal cual: cuadernos, etiquetas, tareas y quién puede ver cada nota.</p>
          <div class="stack" style="gap:6px" role="radiogroup" aria-label="Qué incluir" data-scopes>
            ${opt('all', 'Todo lo que ves', `${plural(shared, 'nota', 'notas')} del hogar y ${plural(c.private, 'privada tuya', 'privadas tuyas')}`)}
            ${opt('private', 'Solo tus notas privadas', plural(c.private, 'nota', 'notas'))}
            ${opt('shared', 'Solo las del hogar', plural(shared, 'nota', 'notas'))}
          </div>
          <label class="switch"><input type="checkbox" data-images checked><span class="track"></span><span class="txt">Con las imágenes<small>Ocupa más, pero la copia queda completa.</small></span></label>
          <label class="switch"><input type="checkbox" data-protect><span class="track"></span><span class="txt">Proteger con contraseña<small>Cifrada con AES-256: sin la contraseña no se puede abrir ni ver los títulos.</small></span></label>
          <div class="bk-pw" data-pw hidden>
            <div class="field"><label for="bk-p1">Contraseña</label>
              <div class="input-group"><input class="input" id="bk-p1" type="password" data-p1 autocomplete="new-password" minlength="10" placeholder="Mínimo 10 caracteres">
                <button type="button" class="suffix bk-eye" data-act="eye" aria-label="Mostrar la contraseña">${icon('eye', 'sm')}</button></div>
              <span class="hint" data-pwhint>Mejor una frase fácil de recordar: «la bici roja de 2026».</span></div>
            <div class="field"><label for="bk-p2">Repítela</label><input class="input" id="bk-p2" type="password" data-p2 autocomplete="new-password"></div>
            <p class="bk-note warn">${icon('triangle-alert', 'sm')}<span>Si la olvidas no hay forma de abrir la copia: nadie puede recuperarla. Apúntala en un sitio seguro.</span></p>
          </div>
          <button type="button" class="btn primary block" data-act="download">${icon('download')}<span data-dltext>Descargar copia (.zip)</span></button>
          <p class="bk-note" data-plainnote>${icon('lock', 'sm')}<span>Sin contraseña, tus notas privadas van dentro sin cifrar: guarda el archivo en un sitio seguro. La copia nunca incluye las notas privadas de otras personas.</span></p>
        </section>
        <section class="bk-block">
          <div class="bk-head"><span class="bk-ico">${icon('upload')}</span><div><h3>Restaurar desde una copia</h3>
            <span class="small muted">Por ejemplo, después de reinstalar el servidor</span></div></div>
          <p class="small ink-2">Lo que ya esté en la app no se duplica. Si una nota ha cambiado desde que hiciste la copia, la de la copia entra aparte como «(restaurada)»: no se pierde nada.</p>
          <button type="button" class="btn block" data-act="restore-file">${icon('upload')}Elegir la copia (.zip)…</button>
          <div data-result aria-live="polite"></div>
          <p class="small muted">También vale una exportación de Joplin en «Markdown + Front Matter» comprimida en .zip.</p>
        </section>
      </div>`,
    });
    on(s.el, 'click', '[data-scope]', (e, b) => {
      scope = b.dataset.scope;
      s.el.querySelectorAll('[data-scope]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
    const protect = () => $('[data-protect]', s.el).checked;
    on(s.el, 'change', '[data-protect]', () => {
      $('[data-pw]', s.el).hidden = !protect();
      $('[data-plainnote]', s.el).hidden = protect();
      $('[data-dltext]', s.el).textContent = protect() ? 'Descargar copia protegida (.zip)' : 'Descargar copia (.zip)';
      if (protect()) setTimeout(() => $('[data-p1]', s.el).focus(), 50);
    });
    on(s.el, 'click', '[data-act=eye]', (e, b) => {
      const show = $('[data-p1]', s.el).type === 'password';
      for (const i of s.el.querySelectorAll('[data-p1], [data-p2]')) i.type = show ? 'text' : 'password';
      b.setAttribute('aria-label', show ? 'Ocultar la contraseña' : 'Mostrar la contraseña');
      b.innerHTML = String(icon(show ? 'eye-off' : 'eye', 'sm'));
    });
    on(s.el, 'input', '[data-p1]', (e, i) => {
      const n = i.value.length;
      const h = $('[data-pwhint]', s.el);
      h.textContent = n === 0 ? 'Mejor una frase fácil de recordar: «la bici roja de 2026».' : n < 10 ? `Faltan ${10 - n} caracteres.` : n < 16 ? 'Válida. Más larga sería más segura.' : 'Buena contraseña.';
      h.className = `hint ${n >= 16 ? 'pos' : ''}`;
    });
    const afterDownload = async () => {
      await loadMeta().catch(() => {});
      const l = $('[data-last]', s.el);
      if (l) l.textContent = `Última copia ${timeAgo(meta.last_backup)}`;
      redrawList();
      toast('Copia descargada. Guárdala fuera del servidor (en el ordenador, un disco o la nube).', { timeout: 6000 });
    };
    on(s.el, 'click', '[data-act=download]', (e, b) => {
      const images = $('[data-images]', s.el).checked;
      if (!protect()) {
        download(hurl(`/notes/backup.zip?scope=${scope}&images=${images ? 1 : 0}`));
        b.disabled = true;
        setTimeout(() => {
          b.disabled = false;
          afterDownload();
        }, 1500);
        return;
      }
      const p1 = $('[data-p1]', s.el).value;
      const p2 = $('[data-p2]', s.el).value;
      if (p1.length < 10) return toastError(new Error('La contraseña tiene que tener al menos 10 caracteres'));
      if (p1 !== p2) return toastError(new Error('Las dos contraseñas no coinciden'));
      // Con contraseña se pide por POST (la contraseña no va en la dirección) y se guarda el archivo recibido.
      withBusy(b, async () => {
        try {
          const res = await fetch(hurl('/notes/backup.zip'), {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gastosbyath' },
            body: JSON.stringify({ scope, images, password: p1 }),
          });
          if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Error ${res.status}`);
          const blob = await res.blob();
          const cd = res.headers.get('content-disposition') || '';
          const m = cd.match(/filename\*=UTF-8''([^;]+)/);
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = m ? decodeURIComponent(m[1]) : 'notas-protegida.zip';
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          for (const i of s.el.querySelectorAll('[data-p1], [data-p2]')) i.value = '';
          afterDownload();
        } catch (err) {
          toastError(err);
        }
      });
    });
    on(s.el, 'click', '[data-act=restore-file]', (e, b) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip,application/x-zip-compressed';
      input.onchange = () => {
        const file = input.files[0];
        if (!file) return;
        withBusy(b, async () => {
          const box = $('[data-result]', s.el);
          // Si la copia está protegida, se pide la contraseña antes de subirla (y otra vez si no es la buena).
          let password = (await isProtected(file)) ? await askPassword() : null;
          if (password === undefined) return;
          for (let tries = 0; ; tries++) {
            box.innerHTML = String(html`<p class="small muted">Restaurando «${file.name}»…</p>`);
            try {
              const headers = { 'Content-Type': 'application/zip' };
              if (password) headers['X-Backup-Password'] = encodeURIComponent(password);
              const r = await hapi('/notes/restore', { method: 'POST', body: file, headers });
              box.innerHTML = String(restoreSummary(r));
              box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              await load();
              return;
            } catch (err) {
              const code = err.data?.code;
              if ((code === 'password_required' || code === 'wrong_password') && tries < 4) {
                box.innerHTML = '';
                password = await askPassword(code === 'wrong_password' ? 'Esa no es la contraseña. Prueba otra vez.' : '');
                if (password === undefined) return;
                continue;
              }
              box.innerHTML = String(html`<p class="bk-res bad">${icon('triangle-alert', 'sm')}<span>${err.message}</span></p>`);
              box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              return;
            }
          }
        });
      };
      input.click();
    });
  }

  // ¿Es una copia protegida? Se mira el índice del .zip (al final del archivo) buscando el campo de cifrado AES.
  async function isProtected(file) {
    try {
      const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 1024 * 1024)).arrayBuffer());
      for (let i = 0; i + 4 < tail.length; i++) {
        if (tail[i] === 0x01 && tail[i + 1] === 0x99 && tail[i + 2] === 0x07 && tail[i + 3] === 0x00) return true;
      }
    } catch { /* si no se puede leer, ya lo dirá el servidor */ }
    return false;
  }
  async function askPassword(hint = '') {
    const pw = await promptDialog({
      title: 'Copia protegida', label: 'Contraseña de la copia', type: 'password', confirm: 'Restaurar',
      hint: hint || 'La que pusiste al descargarla.',
    });
    return pw ? pw : undefined;
  }

  function restoreSummary(r) {
    const lines = [];
    if (r.notes) {
      lines.push(html`<b>${r.notes === 1 ? 'Restaurada 1 nota' : `Restauradas ${r.notes} notas`}</b>${r.shared && r.private ? ` (${r.shared} del hogar y ${r.private} privadas)` : ''}${r.images ? `, con ${plural(r.images, 'imagen', 'imágenes')}` : ''}.`);
    } else lines.push(html`<b>No había nada que restaurar.</b>`);
    if (r.books) lines.push(`${plural(r.books, 'cuaderno nuevo', 'cuadernos nuevos')}.`);
    if (r.same) lines.push(`${plural(r.same, 'nota ya estaba', 'notas ya estaban')} y no se ${r.same === 1 ? 'ha' : 'han'} duplicado.`);
    if (r.renamed) lines.push(`${plural(r.renamed, 'nota había', 'notas habían')} cambiado: la de la copia está como «(restaurada)».`);
    if (r.skipped_shared) lines.push(`${plural(r.skipped_shared, 'nota del hogar no se ha', 'notas del hogar no se han')} restaurado: tu rol solo permite notas privadas.`);
    return html`<div class="bk-res ${r.notes ? 'good' : ''}">${icon(r.notes ? 'circle-check' : 'info', 'sm')}<div>${lines.map((l) => html`<p>${l}</p>`)}</div></div>`;
  }

  // Accesos rápidos del móvil (en el ordenador están en la columna de cuadernos).
  function quickChips() {
    const chip = (attr, val, label, on, extra = '') => html`<button type="button" class="chip" ${raw(attr)}="${val}" aria-pressed="${on}">${extra}${label}</button>`;
    const plain = !filter.book && !filter.tag && !q;
    return html`<div class="chips scroll nl-chips">
      ${chip('data-view', 'all', 'Todas', plain && filter.view === 'all')}
      ${chip('data-view', 'todo', 'Tareas', plain && filter.view === 'todo', meta.counts.todo ? html`<span class="badge">${meta.counts.todo}</span> ` : '')}
      ${meta.books.filter((b) => !b.parent_id).map((b) => chip('data-book', b.id, b.name, filter.book === b.id, html`<span class="emoji">${b.icon}</span>`))}
      <button type="button" class="chip" data-act="books-sheet">${icon('folder-open', 'sm')}Más</button>
    </div>`;
  }

  function itemRow(n) {
    const book = bookOf(n.book_id);
    const due = dueLabel(n);
    const text = n.hit ? raw(esc(n.hit).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>')) : n.snippet;
    const showBook = !filter.book;
    return html`<div class="nl-item ${note?.id === n.id ? 'on' : ''} ${n.done_at ? 'done' : ''}" data-item="${n.id}">
      ${n.is_todo ? html`<button type="button" class="nl-check" data-done="${n.id}" role="checkbox" aria-checked="${!!n.done_at}" aria-label="Hecha: ${n.title || 'tarea'}" ${n.can_edit && !n.deleted_at ? '' : 'disabled'}>
        <span>${icon('check')}</span></button>` : ''}
      <button type="button" class="nl-open" data-note="${n.id}">
        <span class="nl-title">${n.pinned ? icon('pin', 'sm') : ''}<span class="ellipsis">${n.title || 'Sin título'}</span></span>
        ${text ? html`<span class="nl-snip">${text}</span>` : ''}
        <span class="nl-meta">
          ${due ? html`<span class="pill ${due.late ? 'overdue' : due.soon ? 'pending' : 'plain'}">${icon('clock', 'sm')}${due.text}</span>` : ''}
          <span>${timeAgo(n.updated_at)}</span>
          ${showBook && book ? html`<span class="nl-book">${n.private ? icon('lock', 'sm') : ''}${book.name}</span>` : n.private ? html`<span class="nl-book">${icon('lock', 'sm')}Privada</span>` : ''}
          ${n.tags.slice(0, 3).map((t) => html`<span class="nl-tag">#${t}</span>`)}
        </span>
      </button>
    </div>`;
  }

  function listPane() {
    const empty = !list.length;
    const trash = filter.view === 'trash' && !filter.book && !filter.tag && !q;
    return html`<div class="nl-head">
        <div class="grow" style="min-width:0"><h2 class="ellipsis">${listTitle()}</h2>
          <span class="small muted">${list.length === 1 ? '1 nota' : `${list.length} notas`}${filter.book && bookOf(filter.book) ? (bookOf(filter.book).private ? ' · solo tú' : ' · todo el hogar') : ''}</span></div>
        ${trash && list.length ? html`<button type="button" class="btn sm danger" data-act="empty-trash">${icon('trash-2', 'sm')}Vaciar</button>` : ''}
      </div>
      <div class="nl-tools">
        <div class="input-group">${icon('search')}<input class="input" type="search" placeholder="Buscar en las notas…" value="${q}" data-q aria-label="Buscar en las notas"></div>
        <button type="button" class="btn icon-only" data-act="sort" aria-label="Ordenar: ${SORTS[sort]}">${icon('arrow-down-up')}</button>
      </div>
      ${isWide ? '' : quickChips()}
      ${!isWide && backupDue() ? html`<button type="button" class="nl-nudge" data-act="backup-nudge">${icon('archive', 'sm')}
        <span>${meta.last_backup ? `Tu última copia de las notas es de ${timeAgo(meta.last_backup)}` : 'Aún no tienes copia de tus notas'}. <b>Hacer una</b></span></button>` : ''}
      <div class="nl-list" data-list>
        ${empty ? emptyList() : list.map(itemRow)}
      </div>`;
  }

  function emptyList() {
    if (q) return html`<div class="nl-empty"><div class="art">🔍</div><p>Nada coincide con «${q}».</p></div>`;
    if (filter.view === 'trash' && !filter.book && !filter.tag) return html`<div class="nl-empty"><div class="art">🗑️</div><p>La papelera está vacía. Lo que se borra se puede recuperar durante 30 días.</p></div>`;
    if (filter.view === 'todo' && !filter.book && !filter.tag) {
      return html`<div class="nl-empty"><div class="art">✅</div><p>No hay tareas pendientes.</p>
        <button type="button" class="btn" data-act="new-todo">${icon('list-todo')}Nueva tarea</button></div>`;
    }
    return html`<div class="nl-empty"><div class="art">🗒️</div>
      <h3>Aquí van vuestras notas</h3>
      <p>La contraseña del wifi, recetas, ideas de regalos, lo que hay que llevar de viaje… En <b>Notas de casa</b> las ve toda la familia; en <b>Mis notas</b>, solo tú.</p>
      <div class="row" style="justify-content:center"><button type="button" class="btn primary" data-act="new-note">${icon('notebook-pen')}Nueva nota</button>
        <button type="button" class="btn" data-act="new-todo">${icon('list-todo')}Nueva tarea</button></div></div>`;
  }

  // ---------- Editor ----------
  function drawEditor() {
    const pane = $('[data-editor]', ctx.el);
    if (!pane) return;
    if (!note) {
      pane.innerHTML = isWide ? String(html`<div class="ne-none"><div class="art">📝</div><p>Elige una nota o crea una nueva.</p>
        <p class="small muted">Atajos: <kbd>Ctrl</kbd>+<kbd>B</kbd> negrita · <kbd>Ctrl</kbd>+<kbd>I</kbd> cursiva · <kbd>Ctrl</kbd>+<kbd>K</kbd> enlace</p></div>`) : '';
      return;
    }
    const book = bookOf(note.book_id);
    const ro = !note.can_edit || !!note.deleted_at;
    const m = ro ? 'view' : mode === 'split' && !isWide ? 'edit' : mode;
    const due = dueLabel(note);
    const prog = taskProgress(note.body || '');
    pane.innerHTML = String(html`<div class="ne ${ro ? 'ro' : ''}" data-m="${m}">
      <div class="ne-bar">
        ${isWide ? '' : html`<button type="button" class="btn ghost sm ne-back" data-act="back" aria-label="Volver a las notas">${icon('chevron-left', 'sm')}<span>Notas</span></button>`}
        <button type="button" class="ne-book ${note.private ? 'priv' : ''}" data-act="move" ${ro ? 'disabled' : ''} aria-label="Cuaderno: ${book?.name || ''} (${note.private ? 'solo tú' : 'todo el hogar'}). Cambiar">
          <span class="emoji">${book?.icon || '📒'}</span><span class="ellipsis">${book?.name || 'Cuaderno'}</span>
          <span class="ne-who">${note.private ? html`${icon('lock', 'sm')}Solo tú` : html`${icon('users', 'sm')}Todo el hogar`}</span></button>
        <span class="spacer"></span>
        ${ro ? '' : html`<div class="segmented ne-mode" role="group" aria-label="Modo">
          <button type="button" data-mode="edit" aria-pressed="${m === 'edit'}" aria-label="Escribir">${icon('pencil', 'sm')}<span>Escribir</span></button>
          ${isWide ? html`<button type="button" data-mode="split" aria-pressed="${m === 'split'}" aria-label="Escribir y ver">${icon('book-open', 'sm')}<span>Dividido</span></button>` : ''}
          <button type="button" data-mode="view" aria-pressed="${m === 'view'}" aria-label="Ver">${icon('eye', 'sm')}<span>Ver</span></button></div>`}
        <button type="button" class="btn ghost sm icon-only" data-act="pin" aria-pressed="${!!note.pinned}" aria-label="${note.pinned ? 'Desfijar' : 'Fijar arriba'}" ${ro ? 'disabled' : ''}>${icon(note.pinned ? 'pin-off' : 'pin', 'sm')}</button>
        <button type="button" class="btn ghost sm icon-only" data-act="note-menu" data-menu-anchor aria-label="Más opciones">${icon('ellipsis-vertical', 'sm')}</button>
      </div>
      ${note.deleted_at ? html`<div class="ne-banner">${icon('trash-2', 'sm')}<span>Está en la papelera.</span>
        ${note.can_edit ? html`<button type="button" class="btn sm" data-act="restore">Recuperar</button>` : ''}</div>`
        : !note.can_edit ? html`<div class="ne-banner">${icon('eye', 'sm')}<span>Solo lectura: tu rol en este hogar no permite cambiar las notas compartidas.</span></div>` : ''}
      ${conflict ? html`<div class="ne-banner warn">${icon('triangle-alert', 'sm')}<span>${conflict.error}.</span>
        <button type="button" class="btn sm" data-act="take-theirs">Ver la suya</button><button type="button" class="btn sm primary" data-act="keep-mine">Guardar la mía</button></div>` : ''}
      <input class="ne-title" data-title value="${note.title || ''}" placeholder="${note.is_todo ? 'Qué hay que hacer' : 'Título'}" maxlength="200" ${ro ? 'readonly' : ''} aria-label="Título">
      ${note.is_todo ? html`<div class="ne-todo">
        <button type="button" class="nl-check big" data-act="toggle-done" role="checkbox" aria-checked="${!!note.done_at}" ${ro ? 'disabled' : ''}><span>${icon('check')}</span></button>
        <span class="grow">${note.done_at ? `Hecha ${timeAgo(note.done_at)}` : 'Pendiente'}</span>
        <label class="ne-due">${icon('clock', 'sm')}<input type="date" data-due value="${(note.due_at || '').slice(0, 10)}" aria-label="Fecha límite" ${ro ? 'disabled' : ''}>
          ${note.due_at ? html`<input type="time" data-duet value="${(note.due_at || '').slice(11, 16)}" aria-label="Hora" ${ro ? 'disabled' : ''}>` : ''}</label>
        ${due?.late ? html`<span class="pill overdue">Vencida</span>` : ''}
      </div>` : ''}
      <div class="ne-tags" data-tags>${(note.tags || []).map((t) => html`<span class="ne-tag">#${t}${ro ? '' : html`<button type="button" data-untag="${t}" aria-label="Quitar ${t}">${icon('x', 'sm')}</button>`}</span>`)}
        ${ro ? '' : html`<input class="ne-taginput" data-taginput list="note-tags" placeholder="${note.tags?.length ? '+ etiqueta' : 'Añadir etiquetas…'}" aria-label="Añadir etiqueta" enterkeyhint="done">
          <datalist id="note-tags">${meta.tags.map((t) => html`<option value="${t.tag}">`)}</datalist>`}
        ${prog.total ? html`<span class="ne-prog" title="Casillas marcadas">${icon('square-check-big', 'sm')}${prog.done}/${prog.total}</span>` : ''}</div>
      <div class="ne-work">
        ${m !== 'view' ? html`<div class="ne-edit">
          <div class="ne-tools" role="toolbar" aria-label="Formato">${toolbar()}</div>
          <textarea class="ne-text" data-body placeholder="Escribe aquí… (admite Markdown: **negrita**, - listas, - [ ] casillas)" spellcheck="true">${note.body || ''}</textarea>
        </div>` : ''}
        ${m !== 'edit' ? html`<article class="md ne-view" data-preview>${note.body ? '' : html`<p class="muted">${ro ? 'Nota vacía.' : 'Nota vacía. Toca «Escribir» para empezar.'}</p>`}</article>` : ''}
      </div>
      <div class="ne-foot"><span data-status>${status}</span>
        <span class="muted">${note.id ? `${note.updated_by_name ? `Editada por ${note.updated_by_name}` : 'Editada'} ${timeAgo(note.updated_at)}` : 'Nota nueva'}</span></div>
    </div>`);
    const ta = $('[data-body]', pane);
    if (ta) autogrow(ta);
    renderPreview();
  }

  const TOOLS = [
    ['bold', 'Negrita (Ctrl+B)', 'bold'], ['italic', 'Cursiva (Ctrl+I)', 'italic'], ['strike', 'Tachado', 'strikethrough'], 'sep',
    ['h', 'Título', 'heading'], ['ul', 'Lista', 'list'], ['ol', 'Lista numerada', 'list-ordered'], ['task', 'Casilla', 'square-check-big'], 'sep',
    ['quote', 'Cita', 'quote'], ['code', 'Código', 'code'], ['link', 'Enlace (Ctrl+K)', 'link'], ['image', 'Imagen', 'image'], ['table', 'Tabla', 'table'],
  ];
  const toolbar = () => html`${TOOLS.map((t) => (t === 'sep' ? html`<i class="ne-sep"></i>` : html`<button type="button" data-tool="${t[0]}" title="${t[1]}" aria-label="${t[1]}">${icon(t[2], 'sm')}</button>`))}`;

  function autogrow(ta) {
    if (isWide && $('.notes.wide')) return; // en el ordenador la nota tiene su propio scroll
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }

  let previewTimer = null;
  function renderPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const box = $('[data-preview]', ctx.el);
      if (!box || !note?.body) return;
      const htmlOut = await renderMarkdown(note.body);
      if (!box.isConnected) return;
      box.innerHTML = htmlOut;
      // Las casillas se pueden marcar al ver la nota (si se puede editar).
      box.querySelectorAll('input[type=checkbox]').forEach((cb, i) => {
        cb.disabled = !note.can_edit || !!note.deleted_at;
        cb.dataset.task = i;
        cb.closest('li')?.classList.add('task');
      });
    }, 60);
  }

  // ---------- Guardar ----------
  const setStatus = (s) => {
    status = s;
    const el = $('[data-status]', ctx.el);
    if (el) el.innerHTML = String(s);
  };
  function touch(fields) {
    Object.assign(note, fields);
    dirty = true;
    setStatus(html`<span class="muted">Sin guardar…</span>`);
    clearTimeout(timer);
    timer = setTimeout(() => save(), 800);
  }
  async function save({ force = false } = {}) {
    clearTimeout(timer);
    if (!note || !dirty) return saving;
    if (saving) {
      await saving;
      return save({ force });
    }
    const n = note;
    // Un borrador vacío no se guarda.
    if (!n.id && !n.title.trim() && !n.body.trim() && !n.tags.length) return null;
    dirty = false;
    const body = {
      title: n.title, body: n.body, tags: n.tags, pinned: !!n.pinned, is_todo: !!n.is_todo, done: !!n.done_at, due_at: n.due_at || null, book_id: n.book_id,
    };
    setStatus(html`<span class="muted">Guardando…</span>`);
    saving = (async () => {
      try {
        if (!n.id) {
          const r = await post('/notes', body);
          n.id = r.id;
          n.updated_at = r.updated_at;
          n.updated_by_name = store.me.display_name;
          if (note === n) history.replaceState(null, '', `#/notas/${n.id}`);
        } else {
          const r = await patch(`/notes/${n.id}`, { ...body, base: n.updated_at, force });
          n.updated_at = r.updated_at;
          n.updated_by_name = store.me.display_name;
        }
        conflict = null;
        if (note === n) setStatus(html`${icon('check', 'sm')}Guardado`);
        refreshListSoon();
      } catch (e) {
        dirty = true;
        if (e instanceof ApiError && e.status === 409) {
          conflict = { error: e.message, theirs: e.data.conflict };
          status = String(html`<span class="neg">Sin guardar</span>`);
          if (note === n) drawEditor();
        } else if (note === n) {
          setStatus(html`<span class="neg">No se ha guardado: ${e.message}</span> <button type="button" class="linkish" data-act="retry">Reintentar</button>`);
        }
      } finally {
        saving = null;
      }
    })();
    return saving;
  }
  let listTimer = null;
  const refreshListSoon = () => {
    clearTimeout(listTimer);
    listTimer = setTimeout(async () => {
      await Promise.all([loadMeta(), loadList()]).catch(() => {});
      if (ctx.isCurrent()) redrawList();
    }, 300);
  };

  // ---------- Abrir y crear ----------
  async function openNote(id, { push = false } = {}) {
    await save();
    try {
      note = await get(`/notes/${id}`);
    } catch (e) {
      toastError(e);
      return;
    }
    conflict = null;
    status = '';
    dirty = false;
    if (!isWide && pref.mode !== 'edit') mode = note.body ? 'view' : 'edit';
    if (push) {
      history.pushState(null, '', `#/notas/${id}`);
      pushed = true;
    } else history.replaceState(null, '', `#/notas/${id}`);
    if (isWide) {
      redrawList();
      drawEditor();
    } else drawShell();
    window.scrollTo({ top: 0 });
  }
  async function newNote({ todo = false } = {}) {
    await save();
    const book = defaultBook();
    if (!book) return;
    note = {
      id: null, title: '', body: '', tags: filter.tag ? [filter.tag] : [], pinned: 0, is_todo: todo ? 1 : 0, done_at: null, due_at: null,
      book_id: book.id, private: book.private ? 1 : 0, can_edit: true, deleted_at: null, updated_at: null,
    };
    conflict = null;
    status = '';
    dirty = false;
    if (mode === 'view') mode = 'edit';
    if (!isWide) {
      history.pushState(null, '', '#/notas/nueva');
      pushed = true;
    }
    if (isWide) {
      redrawList();
      drawEditor();
    } else drawShell();
    setTimeout(() => $('[data-title]', ctx.el)?.focus(), 60);
  }
  async function closeNote() {
    await save();
    note = null;
    if (!isWide && pushed && location.hash.startsWith('#/notas/')) history.back();
    else {
      history.replaceState(null, '', '#/notas');
      drawShell();
    }
  }

  // ---------- Herramientas de escritura ----------
  function insertText(ta, text, selectFrom = null, selectTo = null) {
    ta.focus();
    const start = ta.selectionStart;
    // execCommand conserva el deshacer del navegador; si no existe, se cambia el texto directamente.
    if (!document.execCommand?.('insertText', false, text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    if (selectFrom !== null) ta.setSelectionRange(start + selectFrom, start + (selectTo ?? selectFrom));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function wrap(ta, before, after = before, placeholder = 'texto') {
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || placeholder;
    insertText(ta, `${before}${sel}${after}`, before.length, before.length + sel.length);
  }
  // Pone o quita un prefijo al principio de cada línea seleccionada.
  function linePrefix(ta, prefix, numbered = false) {
    const v = ta.value;
    const from = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let to = v.indexOf('\n', ta.selectionEnd);
    if (to < 0) to = v.length;
    const lines = v.slice(from, to).split('\n');
    const all = lines.every((l) => (numbered ? /^\d+\.\s/.test(l) : l.startsWith(prefix)));
    const out = lines.map((l, i) => (all ? l.replace(numbered ? /^\d+\.\s/ : prefix, '') : `${numbered ? `${i + 1}. ` : prefix}${l.replace(/^(#{1,6}\s|>\s|[-*+]\s(\[[ xX]\]\s)?|\d+\.\s)/, '')}`)).join('\n');
    ta.setSelectionRange(from, to);
    insertText(ta, out);
  }
  async function tool(name, ta) {
    if (name === 'bold') return wrap(ta, '**');
    if (name === 'italic') return wrap(ta, '_');
    if (name === 'strike') return wrap(ta, '~~');
    if (name === 'code') {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      return sel.includes('\n') ? insertText(ta, `\n\`\`\`\n${sel}\n\`\`\`\n`) : wrap(ta, '`', '`', 'código');
    }
    if (name === 'h') return linePrefix(ta, '## ');
    if (name === 'ul') return linePrefix(ta, '- ');
    if (name === 'ol') return linePrefix(ta, '', true);
    if (name === 'task') return linePrefix(ta, '- [ ] ');
    if (name === 'quote') return linePrefix(ta, '> ');
    if (name === 'table') return insertText(ta, '\n| Columna | Columna |\n| --- | --- |\n| | |\n');
    if (name === 'link') {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      const url = await promptDialog({ title: 'Añadir enlace', label: 'Dirección', placeholder: 'https://…', value: /^https?:\/\//.test(sel) ? sel : '', confirm: 'Añadir' });
      if (!url) return ta.focus();
      const href = /^[a-z]+:/i.test(url) ? url : `https://${url}`;
      const text = sel && !/^https?:\/\//.test(sel) ? sel : href.replace(/^https?:\/\//, '');
      return insertText(ta, `[${text}](${href})`);
    }
    if (name === 'image') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = () => addImages([...input.files], ta);
      input.click();
    }
    return null;
  }
  async function addImages(files, ta) {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    setStatus(html`<span class="muted">Subiendo ${imgs.length === 1 ? 'la imagen' : `${imgs.length} imágenes`}…</span>`);
    for (const f of imgs) {
      try {
        const a = await uploadNoteImage(await shrinkImage(f), !!note.private);
        insertText(ta, `\n![${(f.name || 'imagen').replace(/\.\w+$/, '').replace(/[[\]]/g, '')}](${hurl(`/attachments/${a.id}`)})\n`);
      } catch (e) {
        toastError(e);
      }
    }
  }
  // Intro dentro de una lista continúa la lista (y en un elemento vacío, la termina).
  function continueList(e, ta) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const v = ta.value;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    const line = v.slice(start, ta.selectionStart);
    const m = line.match(/^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)\. |> )/);
    if (!m) return;
    e.preventDefault();
    if (line.trim() === m[2].trim()) {
      // Elemento vacío: se quita la viñeta y queda una línea en blanco que cierra la lista.
      ta.setRangeText('\n', start, ta.selectionStart, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const next = m[3] ? `${Number(m[3]) + 1}. ` : m[2].replace(/\[[xX]\]/, '[ ]');
    insertText(ta, `\n${m[1]}${next}`);
  }

  // ---------- Cuadernos ----------
  async function bookForm(b = null, { priv = true, parent = null } = {}) {
    const name = await promptDialog({
      title: b ? 'Cambiar nombre del cuaderno' : priv ? 'Nuevo cuaderno privado' : 'Nuevo cuaderno del hogar',
      label: 'Nombre', value: b?.name || '', placeholder: priv ? 'Diario, ideas, trabajo…' : 'Recetas, viajes, la casa…', confirm: b ? 'Guardar' : 'Crear',
      hint: b ? '' : priv ? 'Solo lo verás tú.' : 'Lo verá todo el hogar.',
    });
    if (!name?.trim()) return;
    try {
      if (b) await patch(`/notes/books/${b.id}`, { name: name.trim() });
      else {
        const r = await post('/notes/books', { name: name.trim(), private: priv, parent_id: parent });
        filter = { view: 'all', book: r.id, tag: null };
        writePref({ book: r.id, view: 'all' });
      }
      await load();
    } catch (e) {
      toastError(e);
    }
  }
  const ICONS = ['📒', '📓', '📔', '📕', '📗', '📘', '📙', '🗂️', '🏠', '🍳', '✈️', '🎁', '💡', '🛠️', '🧾', '🩺', '🐾', '🎓', '💼', '❤️', '🌱', '🎵', '🔒', '⭐'];
  function bookMenu(b, anchor) {
    openMenu(anchor, [
      { label: 'Cambiar nombre', icon: 'pencil', onClick: () => bookForm(b) },
      { label: 'Cambiar icono', icon: 'sticky-note', onClick: () => iconPicker(b) },
      { label: 'Nuevo subcuaderno', icon: 'folder-plus', onClick: () => bookForm(null, { priv: !!b.private, parent: b.id }) },
      { label: 'Importar archivos .md', icon: 'file-text', onClick: () => importMd(b) },
      'sep',
      { label: 'Borrar cuaderno', icon: 'trash-2', danger: true, onClick: async () => {
        const ok = await confirmDialog({ title: `¿Borrar «${b.name}»?`, text: b.n ? `Sus ${b.n} notas (y las de sus subcuadernos) irán a la papelera.` : 'Está vacío.', confirm: 'Borrar', danger: true });
        if (!ok) return;
        try {
          await del(`/notes/books/${b.id}`);
          if (filter.book === b.id) filter.book = null;
          if (note && note.book_id === b.id) note = null;
          await load();
        } catch (e) {
          toastError(e);
        }
      } },
    ]);
  }
  function iconPicker(b) {
    const s = sheet({
      title: 'Icono del cuaderno', size: 'narrow',
      body: html`<div class="emoji-grid">${ICONS.map((e) => html`<button type="button" data-ico="${e}" aria-pressed="${b.icon === e}"><span class="emoji">${e}</span></button>`)}</div>`,
    });
    on(s.el, 'click', '[data-ico]', async (e, btn) => {
      s.close();
      await patch(`/notes/books/${b.id}`, { icon: btn.dataset.ico }).catch(toastError);
      load();
    });
  }
  function importMd(b) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
    input.multiple = true;
    input.onchange = async () => {
      let n = 0;
      for (const f of input.files) {
        const text = (await f.text()).replace(/\r\n/g, '\n');
        const m = text.match(/^#\s+(.+)\n+/);
        const title = (m ? m[1] : f.name.replace(/\.(md|markdown|txt)$/i, '')).slice(0, 200);
        try {
          await post('/notes', { book_id: b.id, title, body: m ? text.slice(m[0].length) : text });
          n++;
        } catch (e) {
          toastError(e);
        }
      }
      if (n) toast(n === 1 ? '1 nota importada' : `${n} notas importadas`);
      filter = { view: 'all', book: b.id, tag: null };
      load();
    };
    input.click();
  }
  function booksSheet() {
    const s = sheet({ title: 'Cuadernos y etiquetas', className: 'nb-sheet', body: html`<div class="nb-pane in-sheet">${booksPane()}</div>` });
    on(s.el, 'click', '[data-view], [data-book], [data-tag]', () => setTimeout(() => s.close(), 0));
    bindBookPane(s.el, () => s.close());
  }

  // Mover la nota a otro cuaderno (avisando si cambia quién la ve).
  function moveMenu(anchor) {
    const item = (b) => ({
      label: `${b.icon}  ${b.name}`, checked: b.id === note.book_id, onClick: async () => {
        if (b.id === note.book_id) return;
        // Una nota recién empezada se mueve sin preguntar; una con contenido, avisando de quién la verá.
        const started = note.id || note.title || note.body;
        if (started && !b.private && note.private) {
          const ok = await confirmDialog({ title: '¿Compartir esta nota con el hogar?', text: `En «${b.name}» la podrá ver toda la familia, también sus imágenes.`, confirm: 'Compartir' });
          if (!ok) return;
        } else if (started && b.private && !note.private) {
          const ok = await confirmDialog({ title: '¿Hacerla privada?', text: 'Dejará de verla el resto del hogar.', confirm: 'Hacer privada' });
          if (!ok) return;
        }
        touch({ book_id: b.id, private: b.private ? 1 : 0 });
        await save();
        drawEditor();
        toast(b.private ? `Movida a «${b.name}» (solo tú)` : `Movida a «${b.name}» (todo el hogar)`);
      },
    });
    const shared = meta.books.filter((b) => !b.private && meta.can_share);
    const mine = meta.books.filter((b) => b.private);
    openMenu(anchor, [
      ...(shared.length ? [{ cap: 'Del hogar · lo ve toda la familia' }, ...shared.map(item)] : []),
      { cap: 'Solo para ti' }, ...mine.map(item),
    ]);
  }

  function noteMenu(anchor) {
    const ro = !note.can_edit;
    const items = [];
    if (!note.deleted_at && !ro) {
      items.push({ label: note.is_todo ? 'Convertir en nota' : 'Convertir en tarea', icon: 'list-todo', onClick: () => {
        touch({ is_todo: note.is_todo ? 0 : 1, done_at: null });
        drawEditor();
      } });
      items.push({ label: 'Mover a otro cuaderno…', icon: 'folder-open', onClick: () => moveMenu(anchor) });
    }
    items.push({ label: 'Descargar como .md', icon: 'file-down', onClick: () => {
      const blob = new Blob([`# ${note.title || 'Sin título'}\n\n${note.body || ''}\n`], { type: 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(note.title || 'nota').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'nota'}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } });
    items.push({ label: 'Copiar el texto', icon: 'copy', onClick: () => navigator.clipboard?.writeText(note.body || '').then(() => toast('Texto copiado'), () => toastError(new Error('No se ha podido copiar'))) });
    if (!ro && note.id) {
      items.push('sep');
      if (note.deleted_at) {
        items.push({ label: 'Recuperar', icon: 'rotate-ccw', onClick: () => restore() });
        items.push({ label: 'Borrar para siempre', icon: 'trash-2', danger: true, onClick: async () => {
          if (!(await confirmDialog({ title: '¿Borrar para siempre?', text: 'No se podrá recuperar.', confirm: 'Borrar', danger: true }))) return;
          await del(`/notes/${note.id}`).catch(toastError);
          note = null;
          load();
        } });
      } else {
        items.push({ label: 'Enviar a la papelera', icon: 'trash-2', danger: true, onClick: () => trash() });
      }
    }
    openMenu(anchor, items, { align: 'end' });
  }
  async function trash() {
    const n = note;
    await save();
    if (!n.id) {
      note = null;
      return drawShell();
    }
    try {
      await post(`/notes/${n.id}/trash`);
      note = null;
      if (!isWide && location.hash.startsWith('#/notas/')) history.replaceState(null, '', '#/notas');
      await load();
      toast(`«${n.title || 'Sin título'}» a la papelera`, { action: { label: 'Deshacer', fn: async () => {
        await post(`/notes/${n.id}/restore`).catch(toastError);
        load();
      } } });
    } catch (e) {
      toastError(e);
    }
  }
  async function restore() {
    await post(`/notes/${note.id}/restore`).catch(toastError);
    note = await get(`/notes/${note.id}`);
    await load();
  }

  // ---------- Eventos ----------
  function bindBookPane(root, done = () => {}) {
    on(root, 'click', '[data-view]', (e, b) => {
      filter = { view: b.dataset.view, book: null, tag: null };
      q = '';
      writePref({ view: filter.view, book: null });
      changeList();
    });
    on(root, 'click', '[data-book]', (e, b) => {
      filter = { view: 'all', book: Number(b.dataset.book), tag: null };
      q = '';
      writePref({ view: 'all', book: filter.book });
      changeList();
    });
    on(root, 'click', '[data-tag]', (e, b) => {
      filter = { view: 'all', book: null, tag: filter.tag === b.dataset.tag ? null : b.dataset.tag };
      q = '';
      changeList();
    });
    on(root, 'click', '[data-bookmenu]', (e, b) => {
      e.stopPropagation();
      bookMenu(bookOf(Number(b.dataset.bookmenu)), b);
    });
    on(root, 'click', '[data-newbook]', (e, b) => {
      done();
      bookForm(null, { priv: b.dataset.newbook === 'private' });
    });
    on(root, 'click', '[data-act=backup]', () => {
      done();
      backupSheet();
    });
  }
  async function changeList() {
    try {
      await loadList();
      if (!isWide && note) {
        await save();
        note = null;
        history.replaceState(null, '', '#/notas');
        drawShell();
      } else redrawList();
    } catch (e) {
      toastError(e);
    }
  }

  bindBookPane(ctx.el);
  on(ctx.el, 'click', '[data-act=books-sheet]', booksSheet);
  on(ctx.el, 'click', '[data-act=backup-nudge]', backupSheet);
  on(ctx.el, 'click', '[data-note]', (e, b) => openNote(Number(b.dataset.note), { push: !isWide }));
  on(ctx.el, 'click', '[data-done]', async (e, b) => {
    const n = list.find((x) => x.id === Number(b.dataset.done));
    const done = !n.done_at;
    b.setAttribute('aria-checked', String(done));
    b.closest('.nl-item')?.classList.toggle('done', done);
    try {
      await patch(`/notes/${n.id}`, { done });
      if (note?.id === n.id) note = await get(`/notes/${n.id}`);
      refreshListSoon();
      if (done) toast(`Hecha: ${n.title || 'tarea'}`);
    } catch (err) {
      toastError(err);
    }
  });
  const search = (() => {
    let t = null;
    return (value) => {
      q = value.trim();
      clearTimeout(t);
      t = setTimeout(() => loadList().then(() => ctx.isCurrent() && redrawList()).catch(toastError), 220);
    };
  })();
  on(ctx.el, 'input', '[data-q]', (e, input) => search(input.value));
  on(ctx.el, 'click', '[data-act=sort]', (e, b) => openMenu(b, Object.entries(SORTS).map(([k, label]) => ({
    label, checked: sort === k, onClick: () => {
      sort = k;
      writePref({ sort });
      changeList();
    },
  })), { align: 'end' }));
  on(ctx.el, 'click', '[data-act=empty-trash]', async () => {
    if (!(await confirmDialog({ title: '¿Vaciar la papelera?', text: 'Las notas se borrarán para siempre.', confirm: 'Vaciar', danger: true }))) return;
    await del('/notes/trash').catch(toastError);
    load();
  });
  on(ctx.el, 'click', '[data-act=new-note]', () => newNote());
  on(ctx.el, 'click', '[data-act=new-todo]', () => newNote({ todo: true }));
  ctx.onCleanup(on(document.getElementById('page-actions'), 'click', '[data-act=new-note]', () => newNote()));
  ctx.onCleanup(on(document.getElementById('page-actions'), 'click', '[data-act=new-todo]', () => newNote({ todo: true })));

  // Editor
  on(ctx.el, 'click', '[data-act=back]', () => closeNote());
  on(ctx.el, 'input', '[data-title]', (e, i) => touch({ title: i.value }));
  on(ctx.el, 'keydown', '[data-title]', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('[data-body]', ctx.el)?.focus();
    }
  });
  on(ctx.el, 'input', '[data-body]', (e, ta) => {
    touch({ body: ta.value });
    autogrow(ta);
    renderPreview();
    const p = $('.ne-prog', ctx.el);
    const prog = taskProgress(ta.value);
    if (p && prog.total) p.lastChild.textContent = `${prog.done}/${prog.total}`;
  });
  on(ctx.el, 'keydown', '[data-body]', (e, ta) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'i' || k === 'k') {
        e.preventDefault();
        tool({ b: 'bold', i: 'italic', k: 'link' }[k], ta);
        return;
      }
    }
    continueList(e, ta);
  });
  on(ctx.el, 'paste', '[data-body]', (e, ta) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      addImages(files, ta);
    }
  });
  on(ctx.el, 'drop', '[data-body]', (e, ta) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) {
      e.preventDefault();
      addImages(files, ta);
    }
  });
  on(ctx.el, 'mousedown', '[data-tool]', (e) => e.preventDefault()); // no quitar la selección del texto
  on(ctx.el, 'click', '[data-tool]', (e, b) => tool(b.dataset.tool, $('[data-body]', ctx.el)));
  on(ctx.el, 'click', '[data-mode]', (e, b) => {
    mode = b.dataset.mode;
    writePref({ mode });
    drawEditor();
    if (mode !== 'view') $('[data-body]', ctx.el)?.focus({ preventScroll: true });
  });
  on(ctx.el, 'change', '[data-preview] input[data-task]', (e, cb) => {
    touch({ body: toggleTask(note.body, Number(cb.dataset.task)) });
    cb.closest('li')?.classList.toggle('checked', cb.checked);
    const p = $('.ne-prog', ctx.el);
    const prog = taskProgress(note.body);
    if (p) p.lastChild.textContent = `${prog.done}/${prog.total}`;
  });
  on(ctx.el, 'click', '[data-act=pin]', () => {
    touch({ pinned: note.pinned ? 0 : 1 });
    drawEditor();
  });
  on(ctx.el, 'click', '[data-act=toggle-done]', () => {
    touch({ done_at: note.done_at ? null : new Date().toISOString() });
    drawEditor();
  });
  on(ctx.el, 'change', '[data-due], [data-duet]', () => {
    const d = $('[data-due]', ctx.el).value;
    const t = $('[data-duet]', ctx.el)?.value;
    touch({ due_at: d ? (t ? `${d}T${t}` : d) : null });
    drawEditor();
  });
  const addTag = (input) => {
    const t = input.value.trim().replace(/^#/, '').replace(/,$/, '').toLowerCase();
    if (!t) return;
    if (!note.tags.includes(t)) touch({ tags: [...note.tags, t] });
    input.value = '';
    drawTags();
  };
  const drawTags = () => {
    drawEditor();
    $('[data-taginput]', ctx.el)?.focus();
  };
  on(ctx.el, 'keydown', '[data-taginput]', (e, i) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(i);
    } else if (e.key === 'Backspace' && !i.value && note.tags.length) {
      touch({ tags: note.tags.slice(0, -1) });
      drawTags();
    }
  });
  on(ctx.el, 'change', '[data-taginput]', (e, i) => addTag(i));
  on(ctx.el, 'click', '[data-untag]', (e, b) => {
    touch({ tags: note.tags.filter((t) => t !== b.dataset.untag) });
    drawEditor();
  });
  on(ctx.el, 'click', '[data-act=move]', (e, b) => moveMenu(b));
  on(ctx.el, 'click', '[data-act=note-menu]', (e, b) => noteMenu(b));
  on(ctx.el, 'click', '[data-act=restore]', () => restore());
  on(ctx.el, 'click', '[data-act=retry]', () => {
    dirty = true;
    save();
  });
  on(ctx.el, 'click', '[data-act=keep-mine]', (e, b) => withBusy(b, async () => {
    dirty = true;
    await save({ force: true });
    drawEditor();
  }));
  on(ctx.el, 'click', '[data-act=take-theirs]', async () => {
    const ok = await confirmDialog({ title: '¿Quedarte con su versión?', text: 'Se perderán tus últimos cambios en esta nota.', confirm: 'Usar la suya' });
    if (!ok) return;
    dirty = false;
    conflict = null;
    note = await get(`/notes/${note.id}`);
    drawEditor();
  });

  // Al salir (o al ocultar la app) no se pierde nada de lo escrito.
  const flush = () => {
    if (dirty) save();
  };
  const onHide = () => document.visibilityState === 'hidden' && flush();
  document.addEventListener('visibilitychange', onHide);
  ctx.onCleanup(() => {
    document.removeEventListener('visibilitychange', onHide);
    flush();
  });
  const mq = window.matchMedia('(min-width: 1024px)');
  const onResize = () => {
    if (mq.matches !== isWide) drawShell();
  };
  mq.addEventListener('change', onResize);
  ctx.onCleanup(() => mq.removeEventListener('change', onResize));

  ctx.setRefresh(load);
  ctx.el.innerHTML = skeletonPage();
  try {
    await Promise.all([loadMeta(), loadList()]);
  } catch (e) {
    toastError(e);
    return;
  }
  if (ctx.query.copia) {
    history.replaceState(null, '', '#/notas');
    drawShell();
    backupSheet();
    return;
  }
  if (routeId === 'nueva' || ctx.query.nueva) {
    drawShell();
    newNote({ todo: ctx.query.tarea === '1' });
    return;
  }
  if (routeId && Number(routeId)) {
    try {
      note = await get(`/notes/${Number(routeId)}`);
      if (!isWide) mode = pref.mode === 'edit' ? 'edit' : note.body ? 'view' : 'edit';
    } catch {
      note = null;
      history.replaceState(null, '', '#/notas');
    }
  } else if (isWide && list.length) {
    // En el ordenador, como en Joplin, se abre la primera nota en vez de dejar la columna vacía.
    note = await get(`/notes/${list[0].id}`).catch(() => null);
    if (note) history.replaceState(null, '', `#/notas/${note.id}`);
  }
  drawShell();
}
