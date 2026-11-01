// Activar o desactivar las notificaciones push en este dispositivo.
import { api } from './api.js';
import { NAME } from './brand.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const secure = () => window.isSecureContext;

function b64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return reg;
}

export async function pushStatus() {
  if (!pushSupported() || !secure()) return { supported: pushSupported(), secure: secure(), subscribed: false, permission: 'default' };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return { supported: true, secure: true, subscribed: !!sub, permission: Notification.permission };
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('Este navegador no admite notificaciones push');
  if (!secure()) throw new Error(`Las notificaciones necesitan HTTPS. Abre ${NAME} con la dirección https de Tailscale (tailscale serve).`);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('No se ha dado permiso para mostrar notificaciones. Puedes activarlo en los ajustes del navegador.');
  const { publicKey } = await api('/push/key');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(publicKey) });
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  return true;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
}

export const testPush = () => api('/push/test', { method: 'POST', body: {} });
