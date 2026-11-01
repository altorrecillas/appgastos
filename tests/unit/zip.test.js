// ZIP de las copias de las notas: ida y vuelta, cifrado AES-256 (compatible con 7-Zip), archivos dañados y «bombas».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createZip, isEncryptedZip, readZip } from '../../src/zip.js';

const SEVENZIP = ['/usr/bin/7z', '/usr/bin/7za', '/usr/bin/7zz'].find((p) => fs.existsSync(p));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gastosbyath-zip-'));
const big = crypto.randomBytes(3 * 1024 * 1024 + 7); // varios bloques y un final que no cuadra
const text = 'Contraseña del wifi: pepito123 · ñandú\n'.repeat(400);
const PW = 'Cañón del Sil 2026!';

test('ida y vuelta sin cifrar, con nombres en UTF-8', () => {
  const z = createZip([{ name: 'Del hogar/Notas de casa/Wifi y contraseñas.md', data: text }, { name: 'datos.bin', data: big }]);
  const back = readZip(z);
  assert.equal(back[0].name, 'Del hogar/Notas de casa/Wifi y contraseñas.md');
  assert.equal(back[0].data.toString(), text);
  assert.ok(back[1].data.equals(big));
  assert.equal(isEncryptedZip(z), false);
});

test('cifrado AES-256: ida y vuelta, contraseña mala y archivo alterado', () => {
  const z = createZip([{ name: 'LEEME.txt', data: 'sin secreto' }, { name: 'notas.md', data: text, password: PW }, { name: 'grande.bin', data: big, password: PW }]);
  assert.equal(isEncryptedZip(z), true);
  const back = readZip(z, { password: PW });
  assert.equal(back.find((e) => e.name === 'notas.md').data.toString(), text);
  assert.ok(back.find((e) => e.name === 'grande.bin').data.equals(big));
  assert.throws(() => readZip(z), (e) => e.extra?.code === 'password_required');
  assert.throws(() => readZip(z, { password: 'otra' }), (e) => e.extra?.code === 'wrong_password');
  assert.throws(() => readZip(z, { password: PW.toUpperCase() }), (e) => e.extra?.code === 'wrong_password');
  const bad = Buffer.from(z);
  bad[200] ^= 1;
  assert.throws(() => readZip(bad, { password: PW }), /dañado|contraseña/);
});

test('archivos que no son un ZIP válido', () => {
  const z = createZip([{ name: 'a.txt', data: 'hola'.repeat(100) }]);
  assert.throws(() => readZip(Buffer.from('no soy un zip')), /no es un \.zip válido/);
  assert.throws(() => readZip(z.subarray(0, z.length - 30)), /zip/);
  assert.throws(() => readZip(Buffer.concat([z.subarray(0, 20), Buffer.alloc(30), z.subarray(50)])), /dañado/);
});

test('«bomba» de compresión: se rechaza por tamaño', () => {
  const bomb = createZip([{ name: 'ceros.bin', data: Buffer.alloc(150 * 1024 * 1024) }]);
  assert.ok(bomb.length < 1024 * 1024);
  assert.throws(() => readZip(bomb, { maxTotal: 50 * 1024 * 1024 }), /demasiado grande/);
});

test('compatibilidad con 7-Zip (en los dos sentidos)', { skip: !SEVENZIP && 'No está 7-Zip instalado' }, () => {
  const dir = tmp();
  try {
    const z = createZip([{ name: 'notas.md', data: text, password: PW }, { name: 'grande.bin', data: big, password: PW }]);
    fs.writeFileSync(path.join(dir, 'ours.zip'), z);
    assert.match(execFileSync(SEVENZIP, ['t', `-p${PW}`, path.join(dir, 'ours.zip')]).toString(), /Everything is Ok/);
    assert.match(execFileSync(SEVENZIP, ['l', '-slt', `-p${PW}`, path.join(dir, 'ours.zip')]).toString(), /AES-256/);
    assert.throws(() => execFileSync(SEVENZIP, ['t', '-pmala', path.join(dir, 'ours.zip')], { stdio: 'pipe' }));
    // 7-Zip no admite tildes en la contraseña al crear un ZIP: se usa una sin tildes.
    const pw2 = 'Rio Sil 2026';
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'nota.md'), text);
    fs.writeFileSync(path.join(dir, 'src', 'grande.bin'), big);
    execFileSync(SEVENZIP, ['a', '-tzip', '-mem=AES256', `-p${pw2}`, path.join(dir, 'theirs.zip'), '.'], { cwd: path.join(dir, 'src'), stdio: 'pipe' });
    const back = readZip(fs.readFileSync(path.join(dir, 'theirs.zip')), { password: pw2 });
    assert.equal(back.find((e) => e.name === 'nota.md').data.toString(), text);
    assert.ok(back.find((e) => e.name === 'grande.bin').data.equals(big));
    // El cifrado ZIP antiguo (inseguro) se rechaza con una explicación.
    execFileSync(SEVENZIP, ['a', '-tzip', '-mem=ZipCrypto', `-p${pw2}`, path.join(dir, 'old.zip'), 'nota.md'], { cwd: path.join(dir, 'src'), stdio: 'pipe' });
    assert.throws(() => readZip(fs.readFileSync(path.join(dir, 'old.zip')), { password: pw2 }), /antiguo e inseguro/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
