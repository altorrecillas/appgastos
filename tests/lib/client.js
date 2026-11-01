// Cliente de la API para las pruebas: guarda la cookie de sesión y manda la cabecera anti-CSRF como la app.
export class Client {
  constructor(base, name = '') {
    this.base = base;
    this.name = name;
    this.cookies = new Map();
  }

  async req(method, path, body, { raw, headers = {}, csrf = true } = {}) {
    const h = { ...(csrf ? { 'X-Requested-With': 'gastosbyath' } : {}), ...headers };
    let data;
    if (raw !== undefined) data = raw;
    else if (body !== undefined) {
      data = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const send = () => fetch(this.base + path, { method, headers: h, body: data, redirect: 'manual' });
    let res;
    try {
      res = await send();
    } catch (e) {
      // Una conexión reutilizada que el servidor cerraba por inactiva justo entonces: el navegador repite la lectura
      // él solo y fetch no. Se repite igual, y solo si es una lectura.
      if (method !== 'GET' || e.cause?.code !== 'UND_ERR_SOCKET') throw e;
      res = await send();
    }
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const [k, v] = [kv.slice(0, i), kv.slice(i + 1)];
      if (!v || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const type = res.headers.get('content-type') || '';
    const out = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data: out, headers: res.headers };
  }

  get(path, opts) { return this.req('GET', path, undefined, opts); }
  post(path, body, opts) { return this.req('POST', path, body ?? {}, opts); }
  patch(path, body, opts) { return this.req('PATCH', path, body, opts); }
  put(path, body, opts) { return this.req('PUT', path, body, opts); }
  del(path, body, opts) { return this.req('DELETE', path, body, opts); }

  // Como get, pero falla si la respuesta no es 2xx (para preparar datos sin ruido).
  async ok(method, path, body) {
    const r = await this.req(method, path, body ?? (method === 'GET' ? undefined : {}));
    if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
}

export const PASSWORD = 'secreto-de-prueba-123';

// Crea una cuenta (con su propio hogar) y devuelve el cliente ya dentro.
export async function newUser(base, username, displayName = username) {
  const c = new Client(base, username);
  const r = await c.post('/api/auth/register', { username, display_name: displayName, password: PASSWORD });
  if (r.status >= 300) throw new Error(`No se puede registrar ${username}: ${JSON.stringify(r.data)}`);
  return c;
}

// owner invita a member al hogar hid con un rol y member acepta.
export async function join(owner, member, role, hid = 1) {
  const r = await owner.post(`/api/h/${hid}/invitations`, { username: member.name, role });
  if (r.status >= 300) throw new Error(`Invitación: ${JSON.stringify(r.data)}`);
  const me = await member.ok('GET', '/api/auth/me');
  const inv = me.invitations.find((i) => i.household_id === hid) || me.invitations[0];
  await member.ok('POST', `/api/auth/invitations/${inv.id}/accept`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
