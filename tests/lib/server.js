// Un GastosbyATH de usar y tirar para las pruebas: datos en una carpeta temporal y un puerto libre.
// Nunca toca los datos reales; al terminar se borra todo.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startServer({ env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gastosbyath-prueba-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', TZ: 'Europe/Madrid', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try {
      up = (await fetch(`${base}/api/health`)).ok;
    } catch { /* aún arrancando */ }
    if (!up) await sleep(100);
  }
  if (!up) {
    child.kill();
    throw new Error(`El servidor de pruebas no arranca:\n${log}`);
  }
  return {
    base,
    dataDir,
    db: path.join(dataDir, 'gastosbyath.db'),
    log: () => log,
    // Errores del servidor (las trazas «at …» no cuentan como líneas aparte).
    errors: () => log.split('\n').filter((l) => /error/i.test(l) && !/^\s+at /.test(l)),
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((r) => child.once('exit', r));
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
