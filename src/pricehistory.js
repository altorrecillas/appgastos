// Histórico de precios del hogar: cuánto ha subido lo que compráis (índice propio), por año, por súper y por producto.
//
// Cómo se calcula, para que un cambio de tienda o una oferta no parezcan inflación:
// - Se sigue cada producto en cada supermercado por separado (y en su unidad: €/kg, €/l, €/ud…).
// - Solo cuentan los precios normales (las ofertas no).
// - Un precio vale hasta que se anota otro, como mucho seis meses.
// - Las variaciones de todos se combinan con una media geométrica ponderada por lo que más se compra.
import { all } from './db.js';
import { UNITS, unitPrice } from './routes/prices.js';
import { today } from './util.js';

const STALE = 6; // meses que vale un precio sin volver a anotarlo
const MAX_MONTHS = 60;

const ym = (d) => d.slice(0, 7);
const addM = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const monthsBetween = (a, b) => {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
};
// Media geométrica ponderada de razones de precio (descarta saltos absurdos, casi siempre errores de unidad).
const geo = (items) => {
  let s = 0;
  let w = 0;
  for (const it of items) {
    if (!(it.r > 0.33 && it.r < 3)) continue;
    s += it.w * Math.log(it.r);
    w += it.w;
  }
  return w ? Math.exp(s / w) : null;
};
const round = (x, d = 4) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

export function priceHistory(hid, { a, b } = {}) {
  const rows = all(
    `SELECT p.product_id, p.store, p.price, p.qty, p.unit, p.date, p.offer, c.name, c.times
       FROM prices p JOIN shopping_catalog c ON c.id = p.product_id
      WHERE p.household_id = ? AND p.offer = 0 ORDER BY p.date, p.id`,
    hid,
  );
  if (!rows.length) return { empty: true };

  // Producto + súper + unidad: una serie de precios.
  const pairs = new Map();
  for (const r of rows) {
    const base = (UNITS[r.unit] || UNITS.ud)[0];
    const key = `${r.product_id}|${r.store.toLowerCase()}|${base}`;
    let p = pairs.get(key);
    if (!p) pairs.set(key, (p = { product: r.product_id, name: r.name, store: r.store, base, w: Math.max(1, r.times || 0), obs: [] }));
    p.obs.push({ month: ym(r.date), year: r.date.slice(0, 4), up: unitPrice(r) });
  }

  const last = ym(today());
  const first = ym(rows[0].date) < addM(last, -(MAX_MONTHS - 1)) ? addM(last, -(MAX_MONTHS - 1)) : ym(rows[0].date);
  const months = [];
  for (let m = first; m <= last; m = addM(m, 1)) months.push(m);

  // Precio vigente de cada serie en cada mes (el último anotado, si no tiene más de seis meses).
  for (const p of pairs.values()) {
    p.at = new Map();
    let i = 0;
    let cur = null;
    for (const m of months) {
      while (i < p.obs.length && p.obs[i].month <= m) cur = p.obs[i++];
      // El último precio del mes manda; antes del primer mes del gráfico se arrastra el anterior.
      if (cur && monthsBetween(cur.month, m) < STALE) p.at.set(m, cur.up);
    }
    // Para la variación anual hace falta también lo de hace un año aunque quede fuera del gráfico.
    p.valueAt = (m) => {
      if (p.at.has(m)) return p.at.get(m);
      let v = null;
      for (const o of p.obs) {
        if (o.month > m) break;
        v = o;
      }
      return v && monthsBetween(v.month, m) < STALE ? v.up : null;
    };
  }
  const list = [...pairs.values()];

  // Índice encadenado mes a mes (base 100 en el primer mes).
  const index = [100];
  const coverage = [list.filter((p) => p.at.has(months[0])).length];
  for (let i = 1; i < months.length; i++) {
    const ratios = list.filter((p) => p.at.has(months[i - 1]) && p.at.has(months[i])).map((p) => ({ r: p.at.get(months[i]) / p.at.get(months[i - 1]), w: p.w }));
    index.push(index[i - 1] * (geo(ratios) ?? 1));
    coverage.push(list.filter((p) => p.at.has(months[i])).length);
  }

  // Variación anual: cada serie con precio ahora y hace doce meses.
  const yoyAt = (m, filter = () => true, min = 3) => {
    const items = list.filter(filter).map((p) => {
      const now = p.valueAt(m);
      const before = p.valueAt(addM(m, -12));
      return now && before ? { r: now / before, w: p.w, p } : null;
    }).filter(Boolean);
    const g = items.length >= min ? geo(items) : null;
    return { yoy: g === null ? null : g - 1, n: items.length, items };
  };
  const yoy = months.map((m) => round(yoyAt(m).yoy));
  let latestM = null;
  for (let i = months.length - 1; i >= 0 && monthsBetween(months[i], last) <= 3; i--) {
    if (yoy[i] !== null) {
      latestM = months[i];
      break;
    }
  }
  const latest = latestM ? yoyAt(latestM) : null;

  // Por supermercado y por producto (en el mes de la última variación anual).
  const stores = [];
  const products = [];
  if (latestM) {
    const names = [...new Set(list.map((p) => p.store))];
    for (const st of names) {
      const r = yoyAt(latestM, (p) => p.store === st, 2);
      if (r.yoy !== null) stores.push({ store: st, yoy: round(r.yoy), n: r.n });
    }
    stores.sort((x, y) => y.yoy - x.yoy);
    const byProduct = new Map();
    for (const it of latest.items) {
      const k = `${it.p.product}|${it.p.base}`;
      if (!byProduct.has(k)) byProduct.set(k, []);
      byProduct.get(k).push(it);
    }
    for (const items of byProduct.values()) {
      const p0 = items[0].p;
      const g = geo(items.map((x) => ({ r: x.r, w: 1 })));
      if (g === null) continue;
      const avg = (f) => items.reduce((s, x) => s + f(x.p), 0) / items.length;
      products.push({
        id: p0.product, name: p0.name, base_unit: p0.base, change: round(g - 1), stores: items.length,
        from: Math.round(avg((p) => p.valueAt(addM(latestM, -12)))), to: Math.round(avg((p) => p.valueAt(latestM))),
      });
    }
    products.sort((x, y) => y.change - x.change);
  }

  // Un año frente a otro: precio medio de cada producto en las tiendas que tienen precios en los dos años.
  const years = [...new Set(rows.map((r) => r.date.slice(0, 4)))].sort();
  const yb = years.includes(String(b)) ? String(b) : years.at(-1);
  const ya = years.includes(String(a)) && String(a) !== yb ? String(a) : years.filter((y) => y < yb).at(-1) || null;
  let compare = null;
  if (ya) {
    const avgIn = (p, y) => {
      const o = p.obs.filter((x) => x.year === y);
      return o.length ? o.reduce((s, x) => s + x.up, 0) / o.length : null;
    };
    const byProduct = new Map();
    for (const p of list) {
      const pa = avgIn(p, ya);
      const pb = avgIn(p, yb);
      if (!pa || !pb) continue;
      const k = `${p.product}|${p.base}`;
      if (!byProduct.has(k)) byProduct.set(k, { id: p.product, name: p.name, base_unit: p.base, w: p.w, items: [] });
      byProduct.get(k).items.push({ pa, pb });
    }
    const cmp = [...byProduct.values()].map((x) => {
      const g = geo(x.items.map((i) => ({ r: i.pb / i.pa, w: 1 })));
      return g === null ? null : {
        id: x.id, name: x.name, base_unit: x.base_unit, w: x.w, stores: x.items.length, change: round(g - 1),
        a: Math.round(x.items.reduce((s, i) => s + i.pa, 0) / x.items.length), b: Math.round(x.items.reduce((s, i) => s + i.pb, 0) / x.items.length),
      };
    }).filter(Boolean).sort((x, y) => y.change - x.change);
    const total = geo(cmp.map((x) => ({ r: 1 + x.change, w: x.w })));
    compare = { a: ya, b: yb, total: total === null ? null : round(total - 1), n: cmp.length, products: cmp.map(({ w, ...x }) => x) };
  }

  return {
    months, index: index.map((x) => round(x, 3)), coverage, yoy,
    latest: latest && { month: latestM, yoy: round(latest.yoy), n: latest.n },
    cumulative: round(index.at(-1) / 100 - 1), since: months[0],
    stores, products, years, compare,
  };
}
