// Estado compartido de la sesión: usuario, hogares y datos básicos del hogar activo.
import { api, setApiHousehold } from './api.js';
import { applyTint } from './tint.js';
import { setCurrency } from './ui.js';

export const store = {
  me: null,
  households: [],
  invitations: [],
  hid: null,
  house: null, // { household, members, people, categories, pets, invitations }
};

const RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 };
const LS = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    return null;
  }
  return null;
};
export const pref = LS;

export function setSession(payload) {
  store.me = payload.user;
  store.households = payload.households || [];
  store.invitations = payload.invitations || [];
}

export function pickHousehold(preferred) {
  const ids = store.households.map((h) => h.id);
  const wanted = Number(preferred || LS('gastosbyath.hid') || store.me?.settings?.hid);
  const hid = ids.includes(wanted) ? wanted : ids[0] || null;
  store.hid = hid;
  setApiHousehold(hid);
  if (hid) LS('gastosbyath.hid', String(hid));
  return hid;
}

export async function loadHouse() {
  if (!store.hid) {
    store.house = null;
    return null;
  }
  const data = await api(`/h/${store.hid}`);
  setHouse(data);
  return data;
}
export function setHouse(data) {
  store.house = data;
  setCurrency(data.household.currency);
  applyTint(data.household);
  const h = store.households.find((x) => x.id === data.household.id);
  if (h) Object.assign(h, { name: data.household.name, icon: data.household.icon, color: data.household.color, role: data.household.role });
}

export const role = () => store.house?.household.role || 'viewer';
export const can = (what) => {
  const r = RANK[role()];
  if (what === 'edit') return r >= RANK.editor;
  if (what === 'admin') return r >= RANK.admin;
  if (what === 'owner') return r >= RANK.owner;
  return true;
};

export const categories = (kind, { all = false } = {}) =>
  (store.house?.categories || []).filter((c) => (!kind || c.kind === kind) && (all || !c.archived));
export const cat = (id) => store.house?.categories.find((c) => c.id === id) || null;
export const people = ({ all = false } = {}) => (store.house?.people || []).filter((p) => all || !p.archived);
export const person = (id) => store.house?.people.find((p) => p.id === id) || null;
export const pets = ({ all = false } = {}) => (store.house?.pets || []).filter((p) => all || !p.archived);
export const pet = (id) => store.house?.pets.find((p) => p.id === id) || null;
export const myPersonId = () => store.house?.people.find((p) => p.user_id === store.me?.id)?.id ?? null;
