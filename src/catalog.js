// Catálogo de productos del hogar: secciones del súper y productos habituales.
import { one, run } from './db.js';

export const SECTIONS = [
  { id: 'fruta', name: 'Fruta y verdura', icon: '🥦' },
  { id: 'carne', name: 'Carne y pescado', icon: '🥩' },
  { id: 'lacteos', name: 'Lácteos y huevos', icon: '🧀' },
  { id: 'panaderia', name: 'Panadería', icon: '🥖' },
  { id: 'despensa', name: 'Despensa', icon: '🥫' },
  { id: 'bebidas', name: 'Bebidas', icon: '🥤' },
  { id: 'congelados', name: 'Congelados', icon: '🧊' },
  { id: 'limpieza', name: 'Limpieza', icon: '🧽' },
  { id: 'higiene', name: 'Higiene', icon: '🧴' },
  { id: 'mascotas', name: 'Mascotas', icon: '🐾' },
  { id: 'bebe', name: 'Bebé', icon: '🍼' },
  { id: 'otros', name: 'Otros', icon: '📦' },
];

const KEYWORDS = {
  fruta: 'manzana pera platano plátano naranja mandarina limon limón fresa uva melon melón sandia sandía kiwi piña mango aguacate tomate lechuga cebolla ajo patata zanahoria pimiento calabacin calabacín berenjena pepino espinaca brocoli brócoli coliflor judia judía champiñon champiñón seta fruta verdura perejil cilantro albahaca puerro calabaza alcachofa',
  carne: 'pollo pavo ternera cerdo cordero carne filete hamburguesa salchicha chorizo jamon jamón lomo pescado merluza salmon salmón atun atún gamba langostino calamar sepia bacalao dorada lubina mejillon mejillón almeja sardina boqueron boquerón embutido fuet bacon beicon pechuga muslo costilla',
  lacteos: 'leche yogur yogures queso mantequilla nata huevo huevos kefir kéfir cuajada natillas flan requeson requesón batido',
  panaderia: 'pan barra baguette chapata croissant cruasan magdalena bolleria bollería tostada pan de molde rosquilla bizcocho',
  despensa: 'arroz pasta macarron macarrón espagueti fideo harina azucar azúcar sal aceite vinagre legumbre lenteja garbanzo alubia cafe café te té infusion infusión cacao cereal galleta mermelada miel tomate frito conserva atún en lata especia pimienta oregano orégano caldo chocolate frutos secos almendra nuez pipas aceituna mayonesa ketchup mostaza tortilla',
  bebidas: 'agua refresco cola zumo cerveza vino cava tónica tonica gaseosa bebida isotónica isotonica leche de avena',
  congelados: 'congelado congelada helado pizza croqueta varitas guisantes congelados hielo',
  limpieza: 'detergente suavizante lejia lejía friegasuelos lavavajillas fregona estropajo bayeta bolsa basura papel de cocina servilleta limpiador amoniaco quitagrasas ambientador pastillas lavavajillas',
  higiene: 'champu champú gel jabon jabón desodorante pasta de dientes cepillo papel higienico papel higiénico compresa tampon tampón crema cuchilla maquinilla colonia algodon algodón toallita',
  mascotas: 'pienso comida perro comida gato arena gato snack perro premio perro latas gato collar antiparasitario',
  bebe: 'pañal pañales toallitas bebe toallitas bebé potito leche de continuacion leche de continuación chupete biberon biberón',
};
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const KEYWORD_INDEX = Object.entries(KEYWORDS).flatMap(([sec, words]) =>
  [...new Set(strip(words).split(' '))].filter((w) => w.length > 2).map((w) => [w, sec]));

// Adivina la sección del súper por palabras clave (el catálogo del hogar manda si ya existe).
export function guessSection(name) {
  const n = strip(name);
  const words = n.split(/[^a-zñ]+/).filter(Boolean);
  for (const [kw, sec] of KEYWORD_INDEX) {
    if (words.includes(kw) || words.some((w) => w.startsWith(kw) && kw.length > 4)) return sec;
  }
  return 'otros';
}

export function remember(hid, name, section, price) {
  run(
    `INSERT INTO shopping_catalog (household_id, name, section, last_price) VALUES (?, ?, ?, ?)
       ON CONFLICT (household_id, name) DO UPDATE SET times = times + 1, last_at = datetime('now'),
         section = excluded.section, last_price = COALESCE(excluded.last_price, last_price)`,
    hid, name, section, price ?? null,
  );
}


// Devuelve el id del producto en el catálogo (lo crea si no existe).
export function productId(hid, name, section) {
  const clean = String(name).trim().slice(0, 80);
  const found = one('SELECT id FROM shopping_catalog WHERE household_id = ? AND name = ?', hid, clean);
  if (found) return found.id;
  run('INSERT INTO shopping_catalog (household_id, name, section, times) VALUES (?, ?, ?, 0)', hid, clean, section || guessSection(clean));
  return one('SELECT id FROM shopping_catalog WHERE household_id = ? AND name = ?', hid, clean).id;
}
