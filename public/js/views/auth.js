// Pantalla de acceso: entrar o crear cuenta.
import { api } from '../api.js';
import { $, html, icon, on, withBusy } from '../ui.js';
import { readForm, showFormError } from '../forms.js';
import { LOGO_ON_BLUE, NAME, SPOKEN, TAGLINE, WORDMARK } from '../brand.js';

function strength(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^\w]/.test(pw)) s++;
  return pw ? Math.max(1, s) : 0;
}

export async function render(root, { onLogin, notice }) {
  let config = { allowRegistration: true, firstRun: false };
  try {
    config = await api('/auth/config');
  } catch { /* valores por defecto */ }
  let mode = config.firstRun ? 'register' : 'login';
  document.title = `${NAME} · ${TAGLINE}`;

  const card = () => html`
    ${mode === 'login'
      ? html`<div><h1>Hola de nuevo</h1><p class="lead">Entra para ver las cuentas de casa.</p></div>`
      : config.firstRun
        ? html`<div><h1>Bienvenido a ${NAME}</h1><p class="lead">Crea la primera cuenta. Será la administradora de este servidor.</p></div>`
        : html`<div><h1>Crea tu cuenta</h1><p class="lead">Empezarás con tu propio hogar y podrás invitar a tu familia.</p></div>`}
    ${config.allowRegistration && !config.firstRun ? html`<div class="segmented block" data-mode>
      <button type="button" data-v="login" aria-pressed="${mode === 'login'}">Entrar</button>
      <button type="button" data-v="register" aria-pressed="${mode === 'register'}">Crear cuenta</button></div>` : ''}
    ${notice ? html`<div class="form-error" style="background:var(--amber-soft);color:var(--amber-ink)">${icon('info', 'sm')}<span>${notice}</span></div>` : ''}
    ${mode === 'login' ? html`
      <form class="form" id="auth-form" novalidate>
        <div class="field"><label for="a-user">Usuario</label>
          <input class="input" id="a-user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></div>
        <div class="field"><label for="a-pw">Contraseña</label>
          <div class="pw-wrap"><input class="input" id="a-pw" name="password" type="password" autocomplete="current-password" required>
          <button type="button" class="btn ghost sm icon-only" data-act="show-pw" aria-label="Mostrar contraseña">${icon('eye')}</button></div></div>
        <label class="switch"><input type="checkbox" name="remember" checked><span class="track"></span><span class="txt">Mantener la sesión iniciada</span></label>
        <button class="btn primary lg block" type="submit">Entrar</button>
      </form>
      <p class="small muted">¿Has olvidado la contraseña? Quien administra el servidor puede restablecerla con <code>npm run reset-password</code>.</p>`
    : html`
      <form class="form" id="auth-form" novalidate>
        <div class="grid-2 keep">
          <div class="field"><label for="r-name">Tu nombre</label><input class="input" id="r-name" name="display_name" autocomplete="given-name" required maxlength="40"></div>
          <div class="field"><label for="r-user">Usuario</label><input class="input" id="r-user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="32" placeholder="ana.garcia"></div>
        </div>
        <div class="field"><label for="r-pw">Contraseña</label>
          <div class="pw-wrap"><input class="input" id="r-pw" name="password" type="password" autocomplete="new-password" required minlength="8">
          <button type="button" class="btn ghost sm icon-only" data-act="show-pw" aria-label="Mostrar contraseña">${icon('eye')}</button></div>
          <div class="pw-meter" data-s="0" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
          <span class="hint">Mínimo 8 caracteres. Mejor si mezclas mayúsculas, números y símbolos.</span></div>
        <div class="field"><label for="r-email">Email <span class="muted">(opcional)</span></label><input class="input" id="r-email" name="email" type="email" autocomplete="email"></div>
        <div class="field"><label for="r-house">Nombre de tu hogar</label><input class="input" id="r-house" name="household_name" maxlength="60" placeholder="Casa de…"></div>
        <button class="btn primary lg block" type="submit">Crear cuenta</button>
      </form>`}`;

  root.innerHTML = String(html`
    <div class="auth">
      <section class="auth-art">
        <a class="brand" href="#" aria-label="${SPOKEN}">${LOGO_ON_BLUE}${WORDMARK}</a>
        <div>
          <p class="auth-claim">Las cuentas de casa, en orden.</p>
          <div class="auth-points">
            <div>${icon('wallet')}<span>Gastos e ingresos anotados en segundos, desde el móvil.</span></div>
            <div>${icon('calendar-clock')}<span>Pagos fijos, compras a plazos y facturas sin sustos.</span></div>
            <div>${icon('shopping-cart')}<span>Lista de la compra compartida que se actualiza al momento.</span></div>
            <div>${icon('paw-print')}<span>Vacunas, peso y gastos de tus mascotas.</span></div>
          </div>
        </div>
        <p class="small" style="color:rgba(255,255,255,.66)">Tus datos se guardan en tu propio servidor.</p>
      </section>
      <section class="auth-side"><div class="auth-card" id="auth-card">${card()}</div></section>
    </div>`);

  const cardEl = $('#auth-card', root);
  const draw = () => {
    cardEl.innerHTML = String(card());
    $('input', cardEl)?.focus();
  };
  on(cardEl, 'click', '[data-mode] [data-v]', (e, b) => {
    mode = b.dataset.v;
    notice = '';
    draw();
  });
  on(cardEl, 'click', '[data-act=show-pw]', (e, b) => {
    const input = b.previousElementSibling;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.innerHTML = String(icon(show ? 'eye-off' : 'eye'));
    b.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  });
  on(cardEl, 'input', '#r-pw', (e, input) => {
    $('.pw-meter', cardEl).dataset.s = String(strength(input.value));
  });
  on(cardEl, 'submit', '#auth-form', async (e, form) => {
    e.preventDefault();
    const v = readForm(form);
    const btn = $('button[type=submit]', form);
    await withBusy(btn, async () => {
      try {
        let payload;
        if (mode === 'login') {
          if (!v.username || !v.password) throw new Error('Escribe tu usuario y tu contraseña');
          payload = await api('/auth/login', { method: 'POST', body: { username: v.username.trim(), password: v.password, remember: v.remember } });
        } else {
          if (!v.display_name?.trim()) throw new Error('Escribe tu nombre');
          if (!/^[a-zA-Z0-9._-]{3,32}$/.test(v.username || '')) throw new Error('El usuario debe tener entre 3 y 32 letras, números, puntos o guiones, sin espacios');
          if ((v.password || '').length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
          payload = await api('/auth/register', { method: 'POST', body: v });
        }
        await onLogin(payload);
      } catch (err) {
        showFormError(form, err.message);
      }
    });
  });
  $('input', cardEl)?.focus();
}
