// IPC oficial (INE): índice general y de «Alimentos y bebidas no alcohólicas», para comparar con la inflación del hogar.
// Solo se descargan datos públicos; si no hay conexión se usa lo guardado y la pantalla funciona igual sin ellos.
import { all, one, run, tx } from './db.js';

// Series nacionales ECOICOP v2 (base 2025), tabla 76125 del INE.
const SERIES = {
  general: { idx: 'IPC290751', yoy: 'IPC290750' },
  food: { idx: 'IPC290755', yoy: 'IPC290754' },
};
const API = 'https://servicios.ine.es/wstempus/js/ES/DATOS_SERIE';
const FRESH = 12 * 3600 * 1000;
const RETRY = 30 * 60 * 1000;
let lastOk = 0;
let lastTry = 0;
let running = null;

async function fetchSeries(code) {
  const res = await fetch(`${API}/${code}?nult=180`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`INE ${res.status}`);
  const data = await res.json();
  return (data.Data || [])
    .filter((x) => x.Valor !== null && x.FK_Periodo >= 1 && x.FK_Periodo <= 12)
    .map((x) => ({ month: `${x.Anyo}-${String(x.FK_Periodo).padStart(2, '0')}`, value: Number(x.Valor) }));
}

async function refresh() {
  const got = {};
  for (const [name, codes] of Object.entries(SERIES)) {
    const [idx, yoy] = await Promise.all([fetchSeries(codes.idx), fetchSeries(codes.yoy)]);
    if (!idx.length) throw new Error('INE sin datos');
    got[name] = { idx, yoy };
  }
  tx(() => {
    for (const [name, { idx, yoy }] of Object.entries(got)) {
      const y = new Map(yoy.map((x) => [x.month, x.value]));
      for (const x of idx) {
        run('INSERT OR REPLACE INTO ipc (series, month, idx, yoy) VALUES (?, ?, ?, ?)', name, x.month, x.value, y.get(x.month) ?? null);
      }
    }
  })();
  lastOk = Date.now();
}

// Actualiza como mucho cada 12 h (y reintenta a la media hora si falla). Nunca lanza.
export async function ensureIpc({ wait = 8000 } = {}) {
  const have = one('SELECT COUNT(*) AS n FROM ipc').n > 0;
  if (have && Date.now() - lastOk < FRESH) return true;
  if (Date.now() - lastTry < RETRY) return have;
  if (!running) {
    lastTry = Date.now();
    running = refresh().catch(() => {}).finally(() => {
      running = null;
    });
  }
  // La primera vez se espera un poco; después basta con lo guardado mientras se actualiza.
  if (!have) await Promise.race([running, new Promise((r) => setTimeout(r, wait))]);
  return one('SELECT COUNT(*) AS n FROM ipc').n > 0;
}

export function ipcData(fromMonth) {
  const rows = all('SELECT series, month, idx, yoy FROM ipc WHERE month >= ? ORDER BY month', fromMonth);
  const out = { general: [], food: [] };
  for (const r of rows) out[r.series]?.push({ month: r.month, idx: r.idx, yoy: r.yoy });
  return out;
}
