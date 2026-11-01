// Datos iniciales de un hogar nuevo: categorías habituales de una casa española.
import { insert, one } from './db.js';

export const CATEGORY_COLORS = [
  '#2A78D6', '#1BAF7A', '#EDA100', '#6250D6', '#EB6834', '#E34948', '#0E9AA7', '#8C6D46',
  '#E87BA4', '#9333EA', '#B5487A', '#5B6B82', '#C2410C', '#008300', '#7FA81E', '#6B7280',
];

export const DEFAULT_CATEGORIES = [
  { kind: 'expense', name: 'Vivienda', icon: '🏠', color: '#2A78D6' },
  { kind: 'expense', name: 'Supermercado', icon: '🛒', color: '#1BAF7A' },
  { kind: 'expense', name: 'Luz, agua y gas', icon: '💡', color: '#EDA100' },
  { kind: 'expense', name: 'Teléfono e internet', icon: '📶', color: '#6250D6' },
  { kind: 'expense', name: 'Transporte', icon: '🚗', color: '#EB6834' },
  { kind: 'expense', name: 'Salud', icon: '🩺', color: '#E34948' },
  { kind: 'expense', name: 'Educación', icon: '🎓', color: '#0E9AA7' },
  { kind: 'expense', name: 'Mascotas', icon: '🐾', color: '#8C6D46' },
  { kind: 'expense', name: 'Restaurantes', icon: '🍽️', color: '#E87BA4' },
  { kind: 'expense', name: 'Ocio y suscripciones', icon: '🎬', color: '#9333EA' },
  { kind: 'expense', name: 'Ropa y calzado', icon: '👕', color: '#B5487A' },
  { kind: 'expense', name: 'Seguros', icon: '🛡️', color: '#5B6B82' },
  { kind: 'expense', name: 'Impuestos y tasas', icon: '🧾', color: '#C2410C' },
  { kind: 'expense', name: 'Hogar y reparaciones', icon: '🔧', color: '#008300' },
  { kind: 'expense', name: 'Regalos', icon: '🎁', color: '#7FA81E' },
  { kind: 'expense', name: 'Otros gastos', icon: '📦', color: '#6B7280' },
  { kind: 'income', name: 'Nómina', icon: '💼', color: '#0F7B5F' },
  { kind: 'income', name: 'Trabajos extra', icon: '🧰', color: '#0E9AA7' },
  { kind: 'income', name: 'Devoluciones e intereses', icon: '🏦', color: '#2A78D6' },
  { kind: 'income', name: 'Otros ingresos', icon: '✨', color: '#6B7280' },
];

export function seedHousehold(hid, user) {
  DEFAULT_CATEGORIES.forEach((c, i) => insert('categories', { household_id: hid, sort: i, ...c }));
  addPersonForUser(hid, user);
  insert('shopping_lists', { household_id: hid, name: 'Compra de la semana', icon: '🛒', created_by: user.id });
}

// Cada usuario del hogar aparece también como "persona" para poder asignarle gastos.
export function addPersonForUser(hid, user) {
  const exists = one('SELECT id FROM people WHERE household_id = ? AND user_id = ?', hid, user.id);
  if (exists) return exists.id;
  const sort = one('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM people WHERE household_id = ?', hid).n;
  return insert('people', {
    household_id: hid, name: user.display_name, emoji: '🙂', color: user.color || '#2347C5', user_id: user.id, sort,
  });
}
