// Home Assistant simulado para las pruebas, con consumos fijos y conocidos (en hora local):
// - lavadora: 2 kW de 10:00 a 10:30 todos los días (1 kWh al día),
// - nevera: 100 W durante 15 minutos de cada 30, todo el día (1,2 kWh en un día de 24 horas),
// - un sensor de temperatura, que no debe salir como enchufe.
// Responde a lo que usa la app: /api/, /api/config, /api/states, /api/states/<id> y /api/history/period.
import http from 'node:http';

export const TOKEN = 'token-de-prueba-de-home-assistant-0123456789abcdef';
const MIN = 60e3;
const DEVICES = ['lavadora', 'nevera'];

export function powerAt(dev, ms) {
  const d = new Date(ms);
  const minute = d.getHours() * 60 + d.getMinutes();
  if (dev === 'lavadora') return minute >= 600 && minute < 630 ? 2000 : 0;
  if (dev === 'nevera') return minute % 30 < 15 ? 100 : 0;
  return 0;
}

const midnight = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const nextMidnight = (ms) => {
  const d = new Date(midnight(ms));
  d.setDate(d.getDate() + 1);
  return d.getTime();
};

// kWh que gasta un aparato en un día (local), contando bien los días de 23 o 25 horas.
export function expectedKwh(dev, date) {
  const [y, m, d] = date.split('-').map(Number);
  const from = new Date(y, m - 1, d).getTime();
  const to = Math.min(nextMidnight(from), Date.now());
  let wh = 0;
  for (let t = from; t < to; t += MIN) wh += powerAt(dev, t) / 60;
  return wh / 1000;
}

export async function startFakeHA() {
  // Contador de energía acumulada desde hace 20 días, minuto a minuto.
  const origin = midnight(Date.now() - 20 * 864e5);
  const energyAt = (dev, ms) => {
    let wh = 0;
    for (let t = origin; t < ms; t += MIN) wh += powerAt(dev, t) / 60;
    return wh;
  };
  const cache = new Map(); // energía en cada múltiplo de 5 minutos
  const energy5 = (dev, ms) => {
    const k = `${dev}|${ms}`;
    if (!cache.has(k)) {
      const prev = cache.get(`${dev}|${ms - 5 * MIN}`);
      let wh = prev ?? energyAt(dev, ms - 5 * MIN);
      for (let t = ms - 5 * MIN; t < ms; t += MIN) wh += powerAt(dev, t) / 60;
      cache.set(k, wh);
    }
    return cache.get(k);
  };
  const entities = () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    return [
      ...DEVICES.flatMap((dev) => [
        { entity_id: `sensor.${dev}_energy`, state: String(Math.round(energyAt(dev, now))), last_changed: iso,
          attributes: { friendly_name: `Enchufe ${dev} Energía`, unit_of_measurement: 'Wh', device_class: 'energy', state_class: 'total_increasing' } },
        { entity_id: `sensor.${dev}_power`, state: String(powerAt(dev, now)), last_changed: iso,
          attributes: { friendly_name: `Enchufe ${dev} Potencia`, unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement' } },
      ]),
      { entity_id: 'sensor.salon_temperatura', state: '21.5', last_changed: iso, attributes: { friendly_name: 'Temperatura salón', unit_of_measurement: '°C', device_class: 'temperature' } },
    ];
  };
  // Historial «mínimo»: el primer punto lleva entity_id; después solo estado y hora.
  const history = (id, from, to) => {
    const [, dev, kind] = id.match(/^sensor\.(\w+?)_(energy|power)$/) || [];
    if (!DEVICES.includes(dev)) return null;
    const out = [];
    const push = (t, v) => out.push(out.length ? { state: String(v), last_changed: new Date(t).toISOString() } : { entity_id: id, state: String(v), last_changed: new Date(t).toISOString() });
    if (kind === 'power') {
      let last = null;
      for (let t = from - (from % MIN); t <= to; t += MIN) {
        const v = powerAt(dev, t);
        if (v !== last) push(Math.max(t, from), v);
        last = v;
      }
    } else {
      const start = from - (from % (5 * MIN));
      let last = null;
      for (let t = start; t <= to; t += 5 * MIN) {
        const v = Math.round(energy5(dev, t));
        if (v !== last) push(Math.max(t, from), v);
        last = v;
      }
    }
    return out;
  };

  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Unauthorized' });
    const url = new URL(req.url, 'http://ha');
    if (url.pathname === '/api/') return send(200, { message: 'API running.' });
    if (url.pathname === '/api/config') return send(200, { version: '2026.10.1', location_name: 'Casa de pruebas', time_zone: 'Europe/Madrid' });
    if (url.pathname === '/api/states') return send(200, entities());
    if (url.pathname.startsWith('/api/states/')) {
      const e = entities().find((x) => x.entity_id === decodeURIComponent(url.pathname.slice(12)));
      return e ? send(200, e) : send(404, { message: 'Entity not found.' });
    }
    if (url.pathname.startsWith('/api/history/period/')) {
      const from = Date.parse(decodeURIComponent(url.pathname.slice(20)));
      const to = Math.min(Date.parse(url.searchParams.get('end_time') || new Date().toISOString()), Date.now());
      const ids = (url.searchParams.get('filter_entity_id') || '').split(',').filter(Boolean);
      return send(200, ids.map((id) => history(id, from, to)).filter(Boolean));
    }
    return send(404, { message: 'Not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((r) => server.close(r)) };
}
