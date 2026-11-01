// Categorías automáticas: «COMPRA TARJ. 4B*1234 MERCADONA VALENCIA» → Supermercado.
// Por orden: reglas del hogar (las que se aprenden al anotar y las puestas a mano),
// lo que el hogar suele hacer con ese comercio y, si no hay nada, una lista de comercios españoles.
import { all, one, run } from './db.js';

// Palabras que los bancos añaden y no dicen nada del comercio.
const NOISE = new Set(`COMPRA COMPRAS TARJ TARJETA TARJETAS TJ PAGO PAGOS MOVIL CONTACTLESS EN DE DEL LA EL LOS LAS LO Y E A AL CON POR PARA
  SA SL SLU SAU SC CB SCOOP COOP RECIBO RECIBOS ADEUDO ADEUDOS DOMICILIACION DOMICILIADO CARGO CARGOS TRANSF TRANSFERENCIA TRANSFERENCIAS
  OPERACION OPER OP BIZUM INTERNET APPLE GOOGLE PAY VISA MASTERCARD MASTER DEBITO CREDITO REF REFERENCIA NUM NO NRO CONCEPTO ES ESP SPAIN
  ESPANA EUR EUROS FECHA VALOR COMERCIO TPV ONLINE WWW COM NET HTTPS HTTP RECIBIDA RECIBIDO EMITIDA EMITIDO ENVIADO ENVIADA ORDEN FAVOR
  CUOTA CTA CUENTA TITULAR IMPORTE MOV MOVIMIENTO DISPOSICION AUTORIZACION AUT SEPA INMEDIATA PERIODICA ABONO`.split(/\s+/).filter(Boolean));
NOISE.delete('APPLE');
NOISE.delete('GOOGLE');

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

// Palabras significativas en mayúsculas y sin acentos («H&M» → «HM», «McDonald's» → «MCDONALDS»).
// Se descartan números, tarjetas enmascaradas y fechas, salvo marcas cortas como «O2».
export function tokens(text) {
  return strip(text).toUpperCase()
    .replace(/\b(APPLE|GOOGLE|SAMSUNG)\s*PAY\b/g, ' ')
    .replace(/([A-Z])[&'’]([A-Z])/g, '$1$2')
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 2 && !NOISE.has(t) && (!/\d/.test(t) || (/^[A-Z]+\d+$/.test(t) && t.length <= 3)));
}

// Clave con la que se recuerda un comercio: su primera palabra significativa
// (o la marca de varias palabras con la que empieza: «UBER EATS» no es lo mismo que «UBER»).
export function keyOf(text) {
  const toks = tokens(text);
  if (!toks.length) return null;
  const multi = MULTI.find((p) => p.every((w, i) => toks[i] === w));
  return multi ? multi.join(' ') : toks[0];
}

// Normaliza un patrón escrito a mano («El Corte Inglés» → «CORTE INGLES»).
export const normalizePattern = (p) => tokens(p).join(' ');

const contains = (toks, pattern) => {
  const p = pattern.split(' ');
  for (let i = 0; i + p.length <= toks.length; i++) {
    if (p.every((w, j) => toks[i + j] === w)) return true;
  }
  return false;
};

// Comercios habituales en España (por nombre de las categorías que trae un hogar nuevo).
const BUILTIN = {
  expense: {
    Supermercado: `MERCADONA LIDL CARREFOUR DIA ALCAMPO AUCHAN ALDI EROSKI CONSUM AHORRAMAS HIPERCOR BONAREA GADIS FROIZ SUPERCOR CONDIS CAPRABO
      SPAR COVIRAN LUPA MASYMAS HIPERUSERA SIMPLY ALIMERKA AMETLLER VEGALSA HIBER CHARTER PRIMAPRIX SUPERMERCADO SUPERMERCADOS HIPERMERCADO
      CARNICERIA FRUTERIA PANADERIA PESCADERIA ULTRAMARINOS ECOMARKET`,
    Transporte: `REPSOL CEPSA MOEVE BP GALP SHELL PETRONOR BALLENOIL PLENOIL PETROPRIX AVIA GASOLINERA GASOLINA GASOIL GASOLEO DIESEL CARBURANTE
      RENFE CABIFY UBER BOLT FREENOW TAXI METRO EMT TMB ALSA AVANZA IRYO OUIGO VUELING IBERIA RYANAIR PARKING APARCAMIENTO TELPARK EASYPARK
      ELPARKING AUTOPISTA PEAJE ITV TALLER NEUMATICOS NORAUTO MIDAS|ESTACION SERVICIO`,
    'Ocio y suscripciones': `NETFLIX SPOTIFY HBO DISNEY DAZN FILMIN ITUNES YOUTUBE PLAYSTATION NINTENDO STEAM XBOX CINE CINES YELMO CINESA KINEPOLIS
      TEATRO TICKETMASTER ENTRADAS AUDIBLE KINDLE CRUNCHYROLL TWITCH PATREON|PRIME VIDEO|AMAZON PRIME|APPLE COM BILL|GOOGLE PLAY|MOVISTAR PLUS`,
    'Gimnasio y deporte': `GIMNASIO GIMNASIOS GYM BASICFIT MCFIT VIVAGYM ALTAFIT SYNERGYM DREAMFIT FITNESS CROSSFIT PADEL PISCINA POLIDEPORTIVO
      YOGA PILATES|BASIC FIT|HOLMES PLACE|ANYTIME FITNESS|GO FIT|FITNESS PARK|SNAP FITNESS|CLUB DEPORTIVO|SPORT CLUB|METROPOLITAN SPA`,
    'Teléfono e internet': `MOVISTAR VODAFONE ORANGE YOIGO MASMOVIL DIGI PEPEPHONE O2 LOWI SIMYO JAZZTEL FINETWORK EUSKALTEL TELECABLE ADAMO AVATEL
      GUUK PTV`,
    'Luz, agua y gas': `IBERDROLA ENDESA NATURGY TOTALENERGIES HOLALUZ OCTOPUS CURENERGIA EDP LUCERA AUDAX AQUALIA EMASESA EMACSA AGBAR AIGUES
      AGUAS BUTANO GASNATURAL|TOTAL ENERGIES|CANAL ISABEL|REPSOL ELECTRICIDAD|REPSOL LUZ`,
    Salud: `FARMACIA FARMA CLINICA DENTAL DENTISTA HOSPITAL OPTICA MULTIOPTICAS FISIOTERAPIA FISIO PODOLOGO PODOLOGIA LABORATORIO QUIRON
      QUIRONSALUD VITHAS PARAFARMACIA PSICOLOGO|GENERAL OPTICA`,
    Seguros: `MAPFRE MUTUA ALLIANZ AXA GENERALI OCASO SANTALUCIA ZURICH REALE PELAYO LIBERTY CASER SANITAS ADESLAS ASISA DKV VERTI
      QUALITAS SEGURO SEGUROS ASEGURADORA|LINEA DIRECTA|SANTA LUCIA`,
    'Ropa y calzado': `ZARA PRIMARK HM PULLBEAR BERSHKA STRADIVARIUS MANGO OYSHO LEFTIES KIABI SPRINGFIELD CORTEFIEL SHEIN ZALANDO VINTED
      DECATHLON SKECHERS MAYORAL ZAPATERIA UNIQLO|MASSIMO DUTTI|FOOT LOCKER|JD SPORTS`,
    'Hogar y reparaciones': `IKEA LEROY BRICOMART BRICODEPOT BAUHAUS AKI BRICOR FERRETERIA CONFORAMA JYSK MEDIAMARKT PCCOMPONENTES WORTEN FONTANERO
      ELECTRICISTA CERRAJERO TINTORERIA LAVANDERIA|MEDIA MARKT|MAISONS DU MONDE`,
    Restaurantes: `MCDONALDS KFC TELEPIZZA DOMINOS GLOVO JUSTEAT DELIVEROO RESTAURANTE REST BAR CAFETERIA CAFE STARBUCKS TABERNA MESON
      CERVECERIA PIZZERIA KEBAB SUSHI VIPS GINOS FOSTERS MONTADITOS GOIKO TGB RODILLA ASADOR MARISQUERIA CHURRERIA HELADERIA BRASERIA
      TAPERIA|BURGER KING|PIZZA HUT|PAPA JOHNS|JUST EAT|UBER EATS|FIVE GUYS|TACO BELL`,
    Mascotas: `KIWOKO TIENDANIMAL ZOOPLUS VETERINARIO VETERINARIA MASCOTAS PIENSO|TIENDA ANIMAL|CLINICA VETERINARIA`,
    'Educación': `COLEGIO ACADEMIA UNIVERSIDAD UNED ESCUELA GUARDERIA LIBRERIA MATRICULA IDIOMAS AUTOESCUELA|CASA LIBRO`,
    'Impuestos y tasas': `AEAT HACIENDA AYUNTAMIENTO AYTO DGT IBI IVTM TASA TASAS DIPUTACION MULTA NOTARIA GESTORIA|AGENCIA TRIBUTARIA|SUMA GESTION`,
    Vivienda: `ALQUILER HIPOTECA COMUNIDAD INMOBILIARIA|COMUNIDAD PROPIETARIOS`,
    Regalos: `REGALO REGALOS FLORISTERIA JUGUETERIA IMAGINARIUM JUGUETTOS PANDORA JOYERIA`,
  },
  income: {
    'Nómina': 'NOMINA NOMINAS SALARIO SUELDO PAGA',
    'Devoluciones e intereses': 'DEVOLUCION REEMBOLSO INTERESES REINTEGRO BONIFICACION CASHBACK',
  },
};
// Patrones de varias palabras van separados por «|» y se miran antes que los de una.
const BUILTIN_RULES = Object.fromEntries(Object.entries(BUILTIN).map(([kind, cats]) => [kind,
  Object.entries(cats).flatMap(([cat, spec]) => {
    const [single, ...multi] = spec.split('|');
    return [...multi.map((m) => ({ pattern: normalizePattern(m), cat })), ...single.split(/\s+/).filter(Boolean).map((p) => ({ pattern: p, cat }))];
  }).sort((a, b) => b.pattern.split(' ').length - a.pattern.split(' ').length),
]));

const MULTI = Object.values(BUILTIN_RULES).flat().filter((b) => b.pattern.includes(' ')).map((b) => b.pattern.split(' '));

const catKey = (name) => strip(name).toLowerCase().replace(/[^a-z]/g, '');

// Lo que suele hacer el hogar con cada comercio (se recalcula como mucho una vez por minuto).
const history = new Map();
export const forgetHistory = (hid) => history.delete(hid);
function historyIndex(hid) {
  const cached = history.get(hid);
  if (cached && Date.now() - cached.at < 60000) return cached.index;
  const index = new Map();
  const rows = all(
    `SELECT kind, description, merchant, category_id FROM transactions
      WHERE household_id = ? AND category_id IS NOT NULL AND estimate = 0 AND recurring_id IS NULL
      ORDER BY date DESC, id DESC LIMIT 3000`,
    hid,
  );
  for (const r of rows) {
    const key = keyOf(r.merchant) || keyOf(r.description);
    if (!key) continue;
    const k = `${r.kind}|${key}`;
    if (!index.has(k)) index.set(k, new Map());
    const m = index.get(k);
    m.set(r.category_id, (m.get(r.category_id) || 0) + 1);
  }
  history.set(hid, { at: Date.now(), index });
  return index;
}

export function categorizer(hid) {
  const cats = all('SELECT id, kind, name FROM categories WHERE household_id = ? AND archived = 0', hid);
  const byName = new Map(cats.map((c) => [`${c.kind}|${catKey(c.name)}`, c.id]));
  const valid = new Set(cats.map((c) => `${c.kind}|${c.id}`));
  const rules = all('SELECT * FROM category_rules WHERE household_id = ?', hid)
    .filter((r) => valid.has(`${r.kind}|${r.category_id}`))
    .sort((a, b) => (b.source === 'manual') - (a.source === 'manual') || b.pattern.split(' ').length - a.pattern.split(' ').length || b.hits - a.hits);
  const hist = historyIndex(hid);
  return (text, kind = 'expense') => {
    const toks = tokens(text);
    if (!toks.length) return null;
    for (const r of rules) {
      if (r.kind === kind && contains(toks, r.pattern)) {
        return { category_id: r.category_id, source: r.source === 'manual' ? 'manual' : 'learned', pattern: r.pattern, confidence: r.source === 'manual' ? 0.98 : r.hits >= 2 ? 0.9 : 0.8 };
      }
    }
    const key = keyOf(text);
    const counts = hist.get(`${kind}|${key}`);
    if (counts) {
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (valid.has(`${kind}|${best}`) && n / total >= 0.6) return { category_id: best, source: 'history', pattern: key, confidence: Math.min(0.9, 0.55 + 0.35 * (n / total)) };
    }
    for (const b of BUILTIN_RULES[kind] || []) {
      if (contains(toks, b.pattern)) {
        const id = byName.get(`${kind}|${catKey(b.cat)}`);
        if (id) return { category_id: id, source: 'builtin', pattern: b.pattern, confidence: 0.7 };
      }
    }
    return null;
  };
}

// Aprende de lo que anota alguien. Una corrección (cambiar la categoría de un movimiento) manda;
// un uso normal que contradice una regla muy repetida solo la debilita.
export function learn(hid, kind, text, categoryId, { correction = false } = {}) {
  const key = keyOf(text);
  if (!key || !categoryId) return;
  const cur = one('SELECT * FROM category_rules WHERE household_id = ? AND kind = ? AND pattern = ?', hid, kind, key);
  if (!cur) {
    run('INSERT INTO category_rules (household_id, kind, pattern, category_id) VALUES (?, ?, ?, ?)', hid, kind, key, categoryId);
  } else if (cur.category_id === categoryId) {
    run(`UPDATE category_rules SET hits = hits + 1, updated_at = datetime('now') WHERE id = ?`, cur.id);
  } else if (cur.source !== 'manual') {
    if (correction || cur.hits <= 2) run(`UPDATE category_rules SET category_id = ?, hits = 1, updated_at = datetime('now') WHERE id = ?`, categoryId, cur.id);
    else run(`UPDATE category_rules SET hits = hits - 1 WHERE id = ?`, cur.id);
  }
  forgetHistory(hid);
}
