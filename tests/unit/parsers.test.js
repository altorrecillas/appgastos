// Lectores de texto: cantidades de la lista de la compra («800 g», «medio kilo») y el lector de tickets.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReceipt } from '../../public/js/receipt.js';

// prices.js abre la base de datos al cargarse: que sea una de usar y tirar, nunca la real.
let parseQty;
before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gastosbyath-unit-'));
  ({ parseQty } = await import('../../src/routes/prices.js'));
});

test('cantidades de la lista de la compra', () => {
  const cases = {
    '': { n: 1, unit: null },
    '800 g': { n: 800, unit: 'g' },
    '800g': { n: 800, unit: 'g' },
    '1,5 kg': { n: 1.5, unit: 'kg' },
    '0.8kg': { n: 0.8, unit: 'kg' },
    '2': { n: 2, unit: null },
    x3: { n: 3, unit: null },
    '6 bricks': { n: 6, unit: null },
    'medio kilo': { n: 0.5, unit: 'kg' },
    '1/2 kg': { n: 0.5, unit: 'kg' },
    '75 cl': { n: 750, unit: 'ml' },
    '1 l': { n: 1, unit: 'l' },
    '500 gr.': { n: 500, unit: 'g' },
    'un par': { n: 1, unit: null },
    '3 latas grandes': { n: 3, unit: null },
  };
  for (const [input, want] of Object.entries(cases)) assert.deepEqual(parseQty(input), want, `«${input}»`);
});

const TODAY = '2026-10-26';
const tickets = [
  {
    name: 'Mercadona',
    text: `MERCADONA, S.A. A-46103834
C/ COLON 12 VALENCIA
TELEFONO: 963 000 000
24/10/2026 18:42 OP: 123456
FACTURA SIMPLIFICADA: 2345-012-123456
1 LECHE SEMIDESNATADA 0,95
2 PAN DE MOLDE 2,70
1 TOMATE RAMA 2,29
TOTAL (€) 12,34
TARJETA BANCARIA 12,34
IVA BASE IMPONIBLE (€) CUOTA (€)
4% 5,63 0,23`,
    want: { total: 1234, date: '2026-10-24', merchant: 'Mercadona' },
  },
  {
    name: 'Lidl con «TOTA1» mal leído',
    text: `LIDL Supermercados S.A.U.
Avda. de la Paz 5
Leche entera 0,89 A
Plátanos 1,76 A
TOTA1 7,15
Entregado 10,00
Cambio 2,85
23.10.26 19:02`,
    want: { total: 715, date: '2026-10-23', merchant: 'Lidl' },
  },
  {
    name: 'Gasolinera: importe sin «total»',
    text: `REPSOL ESTACION DE SERVICIO
GASOLINA 95 E5
LITROS 35,21
PRECIO 1,498
IMPORTE: 52,74 €
VISA ****1234
FECHA 22/10/2026`,
    want: { total: 5274, date: '2026-10-22', merchant: 'Repsol' },
  },
  {
    name: 'Bar sin cadena conocida',
    text: `CAFETERIA LA PLAZA
Plaza Mayor 3
2 CAFE CON LECHE 3,20
1 TOSTADA 2,10
TOTAL A PAGAR 5,30
21 de octubre de 2026`,
    want: { total: 530, date: '2026-10-21', merchant: 'Cafeteria La Plaza' },
  },
];
for (const t of tickets) {
  test(`ticket: ${t.name}`, () => {
    const r = parseReceipt(t.text, { today: TODAY });
    assert.equal(r.total, t.want.total);
    assert.equal(r.date, t.want.date);
    assert.equal(r.merchant, t.want.merchant);
  });
}

test('ticket: una fecha del futuro o de hace años no vale', () => {
  assert.equal(parseReceipt('TIENDA\nTOTAL 3,00\n05/03/2021', { today: TODAY }).date, null);
  assert.equal(parseReceipt('TIENDA\nTOTAL 3,00\n30/12/2026', { today: TODAY }).date, null);
});
