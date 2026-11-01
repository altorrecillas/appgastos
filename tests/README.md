# Pruebas de GastosbyATH

```bash
npm test                     # todo: unitarias, API y navegador
npm run test:unit            # solo una tanda (también test:api y test:e2e)
npm test -- api e2e          # varias tandas
npm test -- api --test-name-pattern=privada     # solo las pruebas cuyo nombre encaje
TZ=Europe/Madrid node --test tests/api/notes.test.js   # un archivo suelto
```

Al final sale un resumen por tanda. Si algo falla, el comando termina con error (sirve para usarlo antes de
desplegar: `npm test && bash deploy/install.sh`).

## No tocan tus datos

Cada archivo de prueba arranca **su propio servidor** (`node server.js`) con una carpeta de datos temporal y
un puerto libre en `127.0.0.1`, crea sus cuentas (`ana`, `beto`, `lucia`…) y lo borra todo al terminar.
Puedes lanzarlas con el servidor de verdad funcionando: no se cruzan.

Las fechas se calculan siempre en hora de Madrid (`TZ=Europe/Madrid`, lo pone `npm test`), así que
los días de cambio de hora (23 o 25 horas) también se prueban bien.

## Qué hay en cada carpeta

| Carpeta | Qué comprueba | Tarda |
|---|---|---|
| `unit/` | Piezas sueltas: el `.zip` de las copias (también con contraseña AES-256, archivos dañados, «bombas zip» y que 7-Zip lo abra si está instalado), leer cantidades («1,2 kg», «2 x 500 g») y leer tickets (Mercadona, Lidl, gasolineras, bares). | 2 s |
| `api/` | La API de verdad: permisos (lectores, editores, administradores, otros hogares, CSRF), que todos los importes cuadren al céntimo con un año de datos, la compra y los precios por kilo, el histórico e inflación, las fichas de producto, las notas privadas, sus copias, la copia completa del hogar restaurada en otro servidor, la copia diaria (`scripts/backup.js`: cada foto una sola vez y restaurable), las nóminas que cambian cada mes (varias personas), la versión de la app (página, service worker, novedades y `npm run subir-version`) y Home Assistant (contra uno simulado). | 15 s |
| `e2e/` | La app en Chromium, en móvil y escritorio: todas las secciones cargan sin errores, anotar un gasto, la lista de la compra en directo entre tres personas, notas privadas y su copia con contraseña restaurada en un servidor nuevo, productos al peso y su precio por kilo, la tarjeta de las nóminas del mes y el aviso de versión nueva. | 1 min |
| `lib/` | Ayudantes: el servidor de usar y tirar, un cliente de la API con su sesión, el navegador y el Home Assistant simulado. | |

Cada prueba termina comprobando que **el servidor no ha escrito ningún error** en su registro y, en las de
navegador, que la página no ha tenido errores de JavaScript.

## Lo que necesitan

- Node.js 20 o superior y las dependencias de desarrollo (`npm install`, sin `--omit=dev`).
- Para las de navegador, Chromium del sistema (`apt install chromium`). Se usa con `playwright-core`, que no
  descarga navegadores. Si tienes otro Chrome, indícalo con `CHROMIUM_PATH=/ruta/al/chrome`. Si no hay
  ninguno, esas pruebas salen como «saltadas» y el resto funciona igual.
- Opcional: `7z` (`apt install p7zip-full`) para comprobar que las copias se abren con 7-Zip.

Las pruebas no necesitan internet. Si el servidor no puede consultar el IPC del INE, el histórico de precios
se prueba igual, sin la línea de la inflación oficial.

## Escribir una prueba nueva

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../lib/server.js';
import { newUser, join } from '../lib/client.js';

let srv;
let ana;
before(async () => {
  srv = await startServer();
  ana = await newUser(srv.base, 'ana', 'Ana');     // crea la cuenta y su hogar (el 1)
});
after(() => srv?.stop());

test('algo que debe pasar', async () => {
  const r = await ana.post('/api/h/1/transactions', { kind: 'expense', amount: 1234, date: '2026-10-30' });
  assert.equal(r.status, 201);
});
```

- `ana.get/post/patch/put/del(ruta, cuerpo)` devuelven `{ status, data, headers }`; `ana.ok(método, ruta, cuerpo)`
  devuelve los datos directamente y falla si la respuesta no es correcta.
- `join(ana, beto, 'editor')` mete a Beto en el hogar de Ana (`'viewer'` para solo lectura, `'admin'`).
- Para el navegador: `launch()`, `openApp(navegador, srv.base, 'ana')` (móvil; pasa `DESKTOP` para escritorio) y
  `show(página, srv.base, 'notas')` para ir a una sección y esperar a que cargue. Mira `e2e/` para ejemplos.
