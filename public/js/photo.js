// Fotos de las personas del hogar: elegir o hacer la foto, recortarla en círculo y mostrarla como avatar.
import { hurl, upload } from './api.js';
import { $, html, icon, initials, on, raw, sheet, toastError, withBusy } from './ui.js';

// Avatar de una persona: su foto si tiene; si no, su emoji o sus iniciales sobre su color.
export function avatar(p, cls = '') {
  if (!p) return raw('');
  if (p.photo_id) return html`<span class="avatar photo ${cls}"><img src="${hurl(`/attachments/${p.photo_id}`)}" alt="" loading="lazy"></span>`;
  if (p.emoji) return html`<span class="avatar ${cls}" style="--c:${p.color || '#8A8F98'}"><span class="emoji">${p.emoji}</span></span>`;
  return html`<span class="avatar ${cls}" style="--c:${p.color || 'var(--cobalt)'}">${initials(p.display_name || p.name)}</span>`;
}

export function pickImage({ camera = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.setAttribute('capture', 'user');
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// Recorte circular (personas) o cuadrado (productos): arrastrar para encuadrar y ampliar con la barra, la rueda o dos dedos.
// Devuelve una foto cuadrada de 512 × 512 lista para subir (o null si se cancela).
export async function cropPhoto(file, { square = false } = {}) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) throw new Error('No se puede abrir esa imagen. Prueba con una foto en JPG o PNG.');
  const SIZE = 300;
  const st = { zoom: 1, x: 0, y: 0 };
  const base = Math.max(SIZE / bmp.width, SIZE / bmp.height);
  const s = sheet({
    title: 'Encuadra la foto', size: 'narrow',
    body: html`<div class="crop"><canvas width="${SIZE * 2}" height="${SIZE * 2}" data-crop aria-label="Arrastra para encuadrar"></canvas></div>
      <label class="crop-zoom">${icon('minus', 'sm')}<input type="range" min="1" max="4" step="0.01" value="1" data-zoom aria-label="Zoom">${icon('plus', 'sm')}</label>
      <p class="small muted" style="text-align:center">${square ? 'Arrastra para encuadrar el producto.' : 'Arrastra para encuadrar la cara dentro del círculo.'}</p>`,
    foot: html`<span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" data-ok>Usar esta foto</button>`,
  });
  const canvas = $('[data-crop]', s.el);
  const ctx = canvas.getContext('2d');
  const clamp = () => {
    const w = bmp.width * base * st.zoom;
    const h = bmp.height * base * st.zoom;
    st.x = Math.min(0, Math.max(SIZE - w, st.x));
    st.y = Math.min(0, Math.max(SIZE - h, st.y));
  };
  const centre = () => {
    st.x = (SIZE - bmp.width * base * st.zoom) / 2;
    st.y = (SIZE - bmp.height * base * st.zoom) / 2;
  };
  const draw = () => {
    clamp();
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(bmp, st.x, st.y, bmp.width * base * st.zoom, bmp.height * base * st.zoom);
    // Velo fuera del círculo (o del cuadrado redondeado).
    const frame = () => {
      ctx.beginPath();
      if (square) ctx.roundRect(6, 6, SIZE - 12, SIZE - 12, 22);
      else ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 6, 0, Math.PI * 2);
    };
    ctx.fillStyle = 'rgba(10,15,29,.55)';
    frame();
    ctx.rect(0, 0, SIZE, SIZE);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 2;
    frame();
    ctx.stroke();
  };
  const zoomTo = (z, cx = SIZE / 2, cy = SIZE / 2) => {
    const nz = Math.min(4, Math.max(1, z));
    // Se amplía alrededor del punto indicado (el centro, el ratón o entre los dos dedos).
    st.x = cx - ((cx - st.x) * nz) / st.zoom;
    st.y = cy - ((cy - st.y) * nz) / st.zoom;
    st.zoom = nz;
    $('[data-zoom]', s.el).value = String(nz);
    draw();
  };
  centre();
  draw();
  const pointers = new Map();
  let pinch = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * SIZE, y: ((e.clientY - r.top) / r.height) * SIZE };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const now = local(e);
    pointers.set(e.pointerId, now);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoomTo(st.zoom * (dist / pinch), (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = dist;
      return;
    }
    st.x += now.x - prev.x;
    st.y += now.y - prev.y;
    draw();
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    zoomTo(st.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), p.x, p.y);
  }, { passive: false });
  on(s.el, 'input', '[data-zoom]', (e, r) => zoomTo(Number(r.value)));
  on(s.el, 'click', '[data-ok]', () => {
    const out = document.createElement('canvas');
    out.width = 512;
    out.height = 512;
    const k = 512 / SIZE;
    out.getContext('2d').drawImage(bmp, st.x * k, st.y * k, bmp.width * base * st.zoom * k, bmp.height * base * st.zoom * k);
    out.toBlob((blob) => s.close(new File([blob], 'foto.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.86);
  });
  return s.done;
}

// Campo de foto para un formulario: muestra el avatar y deja hacer, elegir o quitar la foto.
export function photoField(p) {
  return html`<div class="field" data-photo-field><span class="label">Foto</span>
    <div class="photo-field"><span data-photo-preview>${avatar(p, 'xl')}</span>
      <div class="row wrap" style="gap:6px">
        <button type="button" class="btn sm" data-photo="camera">${icon('camera', 'sm')}Hacer foto</button>
        <button type="button" class="btn sm" data-photo="pick">${icon('image', 'sm')}Elegir</button>
        <button type="button" class="btn ghost sm" data-photo="remove" ${p?.photo_id ? '' : 'hidden'}>${icon('trash-2', 'sm')}Quitar</button></div></div>
    <input type="hidden" name="photo_id" value="${p?.photo_id ?? ''}"></div>`;
}
export function bindPhotoField(form, person, onChange) {
  const field = $('[data-photo-field]', form);
  if (!field) return;
  const hidden = $('input[name=photo_id]', field);
  const preview = $('[data-photo-preview]', field);
  const removeBtn = $('[data-photo=remove]', field);
  const show = (id) => {
    hidden.value = id ?? '';
    preview.innerHTML = String(avatar({ ...person, photo_id: id }, 'xl'));
    removeBtn.hidden = !id;
    onChange?.(id);
  };
  on(field, 'click', '[data-photo]', async (e, b) => {
    if (b.dataset.photo === 'remove') return show(null);
    try {
      const file = await pickImage({ camera: b.dataset.photo === 'camera' });
      if (!file) return;
      const cropped = await cropPhoto(file);
      if (!cropped) return;
      await withBusy(b, async () => {
        const a = await upload(cropped);
        show(a.id);
      });
    } catch (err) {
      toastError(err);
    }
  });
}
