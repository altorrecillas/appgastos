// Marca de la aplicación: nombre, lema y logotipo (en un solo sitio para que se escriba siempre igual).
import { raw } from './ui.js';

export const NAME = 'GastosbyATH';
export const TAGLINE = 'Las cuentas de casa';
export const SPOKEN = 'Gastos by ATH'; // cómo debe leerlo un lector de pantalla

// Logotipo: «Gastos» es el protagonista y «by ATH» va como firma de autor, a modo de sello de orfebre.
// Se lee «Gastos by ATH» con lector de pantalla y se copia como «GastosbyATH».
export const WORDMARK = raw(`<span class="brand-name" translate="no"><span class="bn-gastos">Gastos</span><span class="bn-by">by</span><span class="bn-ath">ATH</span></span>`);

// La casa con sus cuatro azulejos: azul cobalto sobre fondo claro…
export const LOGO = raw(`<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#2347C5"/><path d="M32 11.5 52.5 28v21.5a3 3 0 0 1-3 3h-35a3 3 0 0 1-3-3V28z" fill="#fff"/><rect x="22.5" y="28" width="8.5" height="8.5" rx="1.6" fill="#F2B232"/><rect x="33" y="28" width="8.5" height="8.5" rx="1.6" fill="#2347C5"/><rect x="22.5" y="38.5" width="8.5" height="8.5" rx="1.6" fill="#2347C5"/><rect x="33" y="38.5" width="8.5" height="8.5" rx="1.6" fill="#2347C5"/></svg>`);
// …y en blanco translúcido sobre el azul de la portada.
export const LOGO_ON_BLUE = raw(`<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#fff" fill-opacity=".14"/><path d="M32 11.5 52.5 28v21.5a3 3 0 0 1-3 3h-35a3 3 0 0 1-3-3V28z" fill="#fff"/><rect x="22.5" y="28" width="8.5" height="8.5" rx="1.6" fill="#F2B232"/><rect x="33" y="28" width="8.5" height="8.5" rx="1.6" fill="#1d3aa5"/><rect x="22.5" y="38.5" width="8.5" height="8.5" rx="1.6" fill="#1d3aa5"/><rect x="33" y="38.5" width="8.5" height="8.5" rx="1.6" fill="#1d3aa5"/></svg>`);
