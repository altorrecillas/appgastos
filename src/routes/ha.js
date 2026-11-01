// Integración con Home Assistant: conexión, enchufes enlazados, sincronización y potencia en directo.
import express from 'express';
import { all, insert, one, run, update } from '../db.js';
import { addDays, bad, idParam, notFound, today, v, validate } from '../util.js';
import { changed } from '../events.js';
import { atLeast, ensureRef } from './household.js';
import { decrypt, encrypt } from '../secret.js';
import {
  HaError, discoverSensors, haConfig, isConfigured, livePower, normalizeUrl, previewLink, publicConfig, saveHaConfig, syncHousehold,
  testConnection,
} from '../ha.js';
import { syncPowerDay } from '../power.js';

const r = express.Router();
const haErr = (e) => (e instanceof HaError ? bad(e.message) : e);

r.get('/status', (req, res) => {
  const cfg = haConfig(req.hid);
  res.json({
    ...publicConfig(cfg),
    links: one('SELECT COUNT(*) AS n FROM ha_links WHERE household_id = ?', req.hid).n,
    log: all('SELECT at, ok, message, cycles, kwh, ms FROM ha_sync_log WHERE household_id = ? ORDER BY id DESC LIMIT 12', req.hid),
  });
});

// Guardar la conexión (se prueba antes). Sin token nuevo, se mantiene el guardado.
r.put('/connection', atLeast('admin'), async (req, res) => {
  const cfg = haConfig(req.hid);
  try {
    const url = normalizeUrl(req.body?.url);
    const token = String(req.body?.token || '').trim() || decrypt(cfg.token_enc);
    if (!token) throw new HaError('Pega el token de acceso de larga duración');
    if (token.length < 20) throw new HaError('Ese token parece incompleto. Cópialo entero desde Home Assistant.');
    const info = await testConnection(url, token);
    const next = { ...cfg, url, token_enc: encrypt(token), version: info.version, location: info.location, last_error: null, enabled: cfg.enabled !== false };
    saveHaConfig(req.hid, next);
    changed(req, 'ha', 'connect', null, `${req.user.display_name} ha conectado Home Assistant${info.location ? ` (${info.location})` : ''}`);
    res.json({ ...publicConfig(next), info });
  } catch (e) {
    throw haErr(e);
  }
});

r.post('/connection/test', atLeast('admin'), async (req, res) => {
  const cfg = haConfig(req.hid);
  try {
    const url = req.body?.url ? normalizeUrl(req.body.url) : cfg.url;
    const token = String(req.body?.token || '').trim() || decrypt(cfg.token_enc);
    if (!url || !token) throw new HaError('Falta la dirección o el token');
    const started = Date.now();
    const info = await testConnection(url, token);
    res.json({ ok: true, ...info, ms: Date.now() - started, url });
  } catch (e) {
    throw haErr(e);
  }
});

r.patch('/settings', atLeast('admin'), (req, res) => {
  const d = validate(req.body, {
    enabled: [v.bool(), 'Sincronización automática'],
    interval: [v.int({ min: 5, max: 60 }), 'Intervalo'],
    backfill: [v.int({ min: 1, max: 10 }), 'Días hacia atrás'],
  }, { partial: true });
  if (d.interval !== undefined && ![5, 15, 30, 60].includes(d.interval)) throw bad('El intervalo debe ser 5, 15, 30 o 60 minutos');
  const cfg = { ...haConfig(req.hid), ...d };
  if (d.enabled !== undefined) cfg.enabled = !!d.enabled;
  saveHaConfig(req.hid, cfg);
  changed(req, 'ha', 'settings', null);
  res.json(publicConfig(cfg));
});

r.delete('/connection', atLeast('admin'), (req, res) => {
  run('UPDATE households SET ha = ? WHERE id = ?', '{}', req.hid);
  run('UPDATE ha_links SET enabled = 0 WHERE household_id = ?', req.hid);
  changed(req, 'ha', 'disconnect', null, `${req.user.display_name} ha desconectado Home Assistant`);
  res.json({ ok: true });
});

// ---------- Sensores y enchufes ----------
r.get('/sensors', async (req, res) => {
  try {
    const cfg = haConfig(req.hid);
    if (!isConfigured(cfg)) throw new HaError('Primero conecta Home Assistant');
    const out = await discoverSensors(cfg);
    const linked = all('SELECT id, name, energy_entity, power_entity FROM ha_links WHERE household_id = ?', req.hid);
    res.json({ ...out, linked });
  } catch (e) {
    throw haErr(e);
  }
});

const linkSpec = {
  name: [v.str({ required: true, max: 40 }), 'Nombre'],
  icon: [v.emoji(), 'Icono'],
  energy_entity: [v.str({ max: 120, pattern: /^sensor\.[a-z0-9_]+$/ }), 'Sensor de energía'],
  power_entity: [v.str({ max: 120, pattern: /^sensor\.[a-z0-9_]+$/ }), 'Sensor de potencia'],
  appliance_id: [v.int(), 'Electrodoméstico'],
  mode: [v.oneOf(['cycles', 'continuous'], { required: true }), 'Modo'],
  threshold_w: [v.num({ min: 0.5, max: 5000 }), 'Umbral'],
  min_kwh: [v.num({ min: 0, max: 50 }), 'Consumo mínimo'],
  gap_min: [v.int({ min: 0, max: 240 }), 'Pausa'],
  enabled: [v.bool(), 'Activo'],
};

const LINK_SELECT = `
  SELECT l.*, a.name AS appliance_name, a.icon AS appliance_icon,
         (SELECT COALESCE(SUM(kwh), 0) FROM ha_hourly h WHERE h.link_id = l.id AND h.date = ?) AS today_kwh,
         (SELECT ROUND(COALESCE(SUM(cost), 0)) FROM ha_hourly h WHERE h.link_id = l.id AND h.date = ?) AS today_cost,
         (SELECT COALESCE(SUM(kwh), 0) FROM ha_hourly h WHERE h.link_id = l.id AND h.date >= ?) AS week_kwh,
         (SELECT ROUND(COALESCE(SUM(cost), 0)) FROM ha_hourly h WHERE h.link_id = l.id AND h.date >= ?) AS week_cost,
         (SELECT COUNT(*) FROM power_usages u WHERE u.link_id = l.id AND u.source = 'ha' AND u.date >= ?) AS week_uses
    FROM ha_links l LEFT JOIN appliances a ON a.id = l.appliance_id`;
const linkArgs = () => {
  const t = today();
  const w = addDays(t, -6);
  return [t, t, w, w, w];
};

r.get('/links', (req, res) => {
  const links = all(`${LINK_SELECT} WHERE l.household_id = ? ORDER BY l.enabled DESC, l.name`, ...linkArgs(), req.hid);
  const last = all(
    `SELECT u.* FROM power_usages u WHERE u.household_id = ? AND u.source = 'ha' AND u.id IN (
       SELECT MAX(id) FROM power_usages WHERE household_id = ? AND source = 'ha' GROUP BY link_id)`,
    req.hid, req.hid,
  );
  res.json(links.map((l) => ({ ...l, last_usage: last.find((u) => u.link_id === l.id) || null })));
});

// Los campos con valor por defecto que lleguen vacíos se quitan para que se use ese valor (o se conserve el actual).
const LINK_DEFAULTS = { icon: '🔌', threshold_w: 15, min_kwh: 0.05, gap_min: 15, enabled: 1 };
function cleanLink(d, body) {
  if (d.energy_entity === '') d.energy_entity = null;
  if (d.power_entity === '') d.power_entity = null;
  for (const k of Object.keys(LINK_DEFAULTS)) if ([undefined, null, ''].includes(body?.[k])) delete d[k];
  return d;
}

// Si se pide, se crea el electrodoméstico para que aparezca en «Consumo de luz» con lo que se ha medido
// (potencia, duración y consumo por uso), así las anotaciones a mano de ese aparato también salen bien.
function createAppliance(req, d) {
  if (d.appliance_id || !req.body.create_appliance) return;
  const m = validate(req.body, {
    watts: [v.num({ min: 1, max: 30000 }), 'Potencia'],
    minutes: [v.int({ min: 1, max: 1440 }), 'Duración'],
    kwh_per_use: [v.num({ min: 0, max: 100 }), 'Consumo por uso'],
  });
  d.appliance_id = insert('appliances', {
    household_id: req.hid, name: d.name, icon: d.icon || '🔌', watts: Math.round(m.watts || 1000), minutes: m.minutes || 60,
    kwh_per_use: m.kwh_per_use ? Math.round(m.kwh_per_use * 1000) / 1000 : null,
    sort: one('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM appliances WHERE household_id = ?', req.hid).n,
  });
}

r.post('/links', async (req, res) => {
  const d = cleanLink(validate(req.body, linkSpec), req.body);
  if (!d.energy_entity && !d.power_entity) throw bad('Elige el sensor de energía o el de potencia del enchufe');
  ensureRef('appliances', d.appliance_id, req.hid, 'Electrodoméstico');
  if (one('SELECT 1 FROM ha_links WHERE household_id = ? AND (energy_entity = ? OR power_entity = ?)', req.hid, d.energy_entity || '-', d.power_entity || '-')) {
    throw bad('Ese sensor ya está enlazado');
  }
  createAppliance(req, d);
  const id = insert('ha_links', { ...d, household_id: req.hid });
  changed(req, 'ha', 'link', id, `${req.user.display_name} ha enlazado el enchufe de ${d.name}`);
  // Primera lectura (recupera los días anteriores) sin hacer esperar a la persona si tarda.
  const sync = syncHousehold(req.hid, { force: true, userId: req.user.id }).catch((e) => ({ error: e.message }));
  const result = await Promise.race([sync, new Promise((r2) => setTimeout(() => r2({ pending: true }), 8000))]);
  res.status(201).json({ link: one(`${LINK_SELECT} WHERE l.id = ?`, ...linkArgs(), id), sync: result });
});

r.patch('/links/:id', (req, res) => {
  const id = idParam(req.params.id);
  const cur = one('SELECT * FROM ha_links WHERE id = ? AND household_id = ?', id, req.hid);
  if (!cur) throw notFound('Enchufe');
  const d = cleanLink(validate(req.body, linkSpec, { partial: true }), req.body);
  ensureRef('appliances', d.appliance_id, req.hid, 'Electrodoméstico');
  const merged = { ...cur, ...d };
  if (!merged.energy_entity && !merged.power_entity) throw bad('El enchufe necesita al menos un sensor');
  const taken = (col, val) => val && val !== cur[col]
    && one(`SELECT 1 FROM ha_links WHERE household_id = ? AND id != ? AND (energy_entity = ? OR power_entity = ?)`, req.hid, id, val, val);
  if (taken('energy_entity', d.energy_entity) || taken('power_entity', d.power_entity)) throw bad('Ese sensor ya está enlazado a otro enchufe');
  const draft = { ...d, name: merged.name, icon: merged.icon };
  createAppliance(req, draft);
  if (draft.appliance_id) d.appliance_id = draft.appliance_id;
  // Cambiar cómo se detecta obliga a recalcular los días recientes.
  const recalc = ['mode', 'threshold_w', 'min_kwh', 'gap_min', 'energy_entity', 'power_entity', 'appliance_id'].some((k) => k in d && d[k] !== cur[k]);
  update('ha_links', id, req.hid, { ...d, ...(recalc ? { backfilled: 0 } : {}) });
  changed(req, 'ha', 'link', id);
  if (recalc) syncHousehold(req.hid, { force: true, userId: req.user.id }).catch(() => {});
  res.json(one(`${LINK_SELECT} WHERE l.id = ?`, ...linkArgs(), id));
});

r.delete('/links/:id', (req, res) => {
  const id = idParam(req.params.id);
  const l = one('SELECT * FROM ha_links WHERE id = ? AND household_id = ?', id, req.hid);
  if (!l) throw notFound('Enchufe');
  const dates = all(`SELECT DISTINCT date FROM power_usages WHERE (link_id = ? AND source = 'ha') OR superseded_by = ?`, id, id).map((x) => x.date);
  run('DELETE FROM ha_links WHERE id = ?', id);
  if (req.query.purge === '1') {
    // Quita lo medido en días aún no facturados.
    for (const d of dates) {
      if (one('SELECT 1 FROM transactions WHERE household_id = ? AND estimate = 1 AND date = ? AND bill_id IS NOT NULL', req.hid, d)) continue;
      run(`DELETE FROM power_usages WHERE household_id = ? AND link_id = ? AND date = ? AND source = 'ha'`, req.hid, id, d);
      run('UPDATE power_usages SET superseded_by = NULL WHERE household_id = ? AND superseded_by = ? AND date = ?', req.hid, id, d);
      syncPowerDay(req.hid, d, req.user.id);
    }
  }
  changed(req, 'ha', 'unlink', id, `${req.user.display_name} ha quitado el enchufe de ${l.name}`);
  res.json({ ok: true });
});

r.post('/links/preview', async (req, res) => {
  const d = cleanLink(validate(req.body, linkSpec), req.body);
  if (!d.energy_entity && !d.power_entity) throw bad('Elige un sensor');
  const days = Math.min(Math.max(Number(req.body.days) || 3, 1), 7);
  try {
    res.json(await previewLink(req.hid, { ...LINK_DEFAULTS, ...d }, days));
  } catch (e) {
    throw haErr(e);
  }
});

// ---------- Sincronización y datos ----------
r.post('/sync', async (req, res) => {
  try {
    const result = await syncHousehold(req.hid, { force: true, userId: req.user.id });
    if (!result) throw new HaError('Home Assistant no está configurado');
    if (result.busy) return res.json({ busy: true });
    res.json({ ...result, status: publicConfig(haConfig(req.hid)) });
  } catch (e) {
    throw haErr(e);
  }
});

r.get('/live', async (req, res) => {
  try {
    if (!isConfigured(haConfig(req.hid))) return res.json([]);
    res.json(await livePower(req.hid));
  } catch (e) {
    throw haErr(e);
  }
});

r.get('/hourly', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  res.json(all(
    `SELECT h.link_id, h.hour, h.kwh, h.cost FROM ha_hourly h JOIN ha_links l ON l.id = h.link_id
      WHERE l.household_id = ? AND h.date = ? ORDER BY h.hour`,
    req.hid, date,
  ));
});

export default r;
