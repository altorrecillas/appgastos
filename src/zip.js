// ZIP mínimo (sin dependencias): escribir y leer los archivos de las copias de seguridad de las notas.
// Admite nombres en UTF-8, sin compresión o con «deflate», cifrado AES-256 (el de WinZip y 7-Zip),
// y se protege de archivos dañados o maliciosos.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- Cifrado AES de WinZip (AE-2) ----------
// Clave con PBKDF2-HMAC-SHA1 (1000 vueltas, lo que fija el estándar), AES en modo contador con el contador
// en little-endian empezando en 1, y HMAC-SHA1 del texto cifrado (10 bytes) para comprobar que no se ha tocado.
const AES_KEY = 32; // AES-256
const SALT = 16;
function aesKeys(password, salt) {
  const k = crypto.pbkdf2Sync(Buffer.from(String(password), 'utf8'), salt, 1000, AES_KEY * 2 + 2, 'sha1');
  return { enc: k.subarray(0, AES_KEY), mac: k.subarray(AES_KEY, AES_KEY * 2), check: k.subarray(AES_KEY * 2) };
}
// AES-CTR con contador little-endian (el de WinZip, distinto del de OpenSSL): se cifran los bloques del contador
// con AES-ECB y se mezclan con los datos. Cifrar y descifrar es la misma operación.
function aesCtr(key, data) {
  const out = Buffer.alloc(data.length);
  const CHUNK = 64 * 1024;
  let counter = 1n;
  for (let pos = 0; pos < data.length; pos += CHUNK) {
    const len = Math.min(CHUNK, data.length - pos);
    const blocks = Math.ceil(len / 16);
    const ctr = Buffer.alloc(blocks * 16);
    for (let b = 0; b < blocks; b++, counter++) {
      ctr.writeBigUInt64LE(counter & 0xffffffffffffffffn, b * 16);
      ctr.writeBigUInt64LE(counter >> 64n, b * 16 + 8);
    }
    const ecb = crypto.createCipheriv('aes-256-ecb', key, null);
    ecb.setAutoPadding(false);
    const stream = Buffer.concat([ecb.update(ctr), ecb.final()]);
    for (let i = 0; i < len; i++) out[pos + i] = data[pos + i] ^ stream[i];
  }
  return out;
}
function aesEncrypt(password, data) {
  const salt = crypto.randomBytes(SALT);
  const k = aesKeys(password, salt);
  const enc = aesCtr(k.enc, data);
  const mac = crypto.createHmac('sha1', k.mac).update(enc).digest().subarray(0, 10);
  return Buffer.concat([salt, k.check, enc, mac]);
}
const zipError = (msg, code) => {
  const e = new Error(msg);
  e.status = 400;
  e.extra = code ? { code } : undefined;
  return e;
};
function aesDecrypt(password, raw, name) {
  if (raw.length < SALT + 2 + 10) throw zipError(`El archivo «${name}» del .zip está dañado`);
  const salt = raw.subarray(0, SALT);
  const k = aesKeys(password, salt);
  if (!crypto.timingSafeEqual(k.check, raw.subarray(SALT, SALT + 2))) throw zipError('La contraseña no es correcta', 'wrong_password');
  const enc = raw.subarray(SALT + 2, raw.length - 10);
  const mac = crypto.createHmac('sha1', k.mac).update(enc).digest().subarray(0, 10);
  // Las 2 cifras de comprobación pueden coincidir por casualidad: el HMAC confirma la contraseña y que nada se ha alterado.
  if (!crypto.timingSafeEqual(mac, raw.subarray(raw.length - 10))) throw zipError('La contraseña no es correcta o el archivo está dañado', 'wrong_password');
  return aesCtr(k.enc, enc);
}

// Fecha y hora en el formato de MS-DOS que usa ZIP (hora local).
function dosTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

// entries: [{ name: 'carpeta/archivo.md', data: Buffer | string, date?: Date, password?: string }]
export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(data);
    // Se comprime solo si merece la pena (las fotos ya vienen comprimidas).
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length * 0.95;
    const packed = useDeflate ? deflated : data;
    // Con contraseña: método 99 y un campo extra que dice que es AES-256 y cómo iba comprimido (AE-2: sin CRC).
    const aes = !!e.password;
    const body = aes ? aesEncrypt(e.password, packed) : packed;
    const extra = aes ? Buffer.from([0x01, 0x99, 7, 0, 2, 0, 0x41, 0x45, 3, useDeflate ? 8 : 0, 0]) : Buffer.alloc(0);
    const method = aes ? 99 : useDeflate ? 8 : 0;
    const flags = 0x0800 | (aes ? 0x1 : 0); // nombres en UTF-8 (y cifrado)
    const version = aes ? 51 : 20;
    const crcField = aes ? 0 : crc;
    const { date, time } = dosTime(e.date || new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(version, 4); // versión necesaria
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crcField, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    locals.push(local, name, extra, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x033f, 4); // hecho en Unix, versión 6.3
    central.writeUInt16LE(version, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crcField, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // permisos rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);
    offset += local.length + name.length + extra.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ¿Está cifrado algún archivo del .zip? (para pedir la contraseña antes de leerlo)
export function isEncryptedZip(buf) {
  try {
    readZip(buf, { probe: true });
    return false;
  } catch (e) {
    return e.extra?.code === 'password_required';
  }
}

// Lee un ZIP y devuelve [{ name, data }]. Lanza un error legible si no es un ZIP válido, es demasiado grande
// o hace falta contraseña (code: password_required / wrong_password).
export function readZip(buf, { maxEntries = 5000, maxTotal = 400 * 1024 * 1024, password = null, probe = false } = {}) {
  const fail = (msg, code) => {
    throw zipError(msg, code);
  };
  if (!Buffer.isBuffer(buf) || buf.length < 22) fail('El archivo no es un .zip válido');
  // El directorio central se localiza desde el final (puede haber un comentario de hasta 64 KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('El archivo no es un .zip válido');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) fail('El .zip tiene demasiados archivos');
  if (cdOffset + cdSize > buf.length) fail('El .zip está incompleto o dañado');
  const out = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('El .zip está dañado');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString(flags & 0x0800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue; // carpeta
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) fail('El .zip está dañado');
    const lname = buf.readUInt16LE(lho + 26);
    const lextra = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lname + lextra;
    if (start + csize > buf.length) fail('El .zip está incompleto o dañado');
    total += usize;
    if (total > maxTotal) fail('El contenido del .zip es demasiado grande');
    let raw = buf.slice(start, start + csize);
    let realMethod = method;
    let checkCrc = true;
    if (flags & 0x1) {
      // Cifrado: solo se sabe leer el AES de WinZip / 7-Zip (el cifrado ZIP antiguo es inseguro).
      if (method !== 99) fail('El .zip usa un cifrado antiguo e inseguro que no se admite. Vuelve a comprimirlo con AES-256 (7-Zip) o sin contraseña');
      const ex = buf.slice(lho + 30 + lname, start);
      let aesInfo = null;
      for (let q = 0; q + 4 <= ex.length;) {
        const id = ex.readUInt16LE(q);
        const size = ex.readUInt16LE(q + 2);
        if (id === 0x9901 && size >= 7) aesInfo = { vendorVersion: ex.readUInt16LE(q + 4), strength: ex[q + 8], method: ex.readUInt16LE(q + 9) };
        q += 4 + size;
      }
      if (!aesInfo || aesInfo.strength !== 3) fail('El .zip usa un cifrado que no se admite (hace falta AES-256)');
      if (!password) fail('Esta copia está protegida con contraseña', 'password_required');
      if (probe) continue;
      raw = aesDecrypt(password, raw, name);
      realMethod = aesInfo.method;
      checkCrc = aesInfo.vendorVersion === 1; // AE-1 guarda el CRC; AE-2 no (el HMAC ya lo protege)
    } else if (probe) continue;
    let data;
    if (realMethod === 0) data = Buffer.from(raw);
    else if (realMethod === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
      } catch {
        fail(`El archivo «${name}» del .zip está dañado`);
      }
    } else fail('El .zip usa una compresión que no se puede leer');
    if (data.length !== usize || (checkCrc && crc32(data) !== crc)) fail(`El archivo «${name}» del .zip está dañado`);
    out.push({ name, data });
  }
  return out;
}
