# GastosbyATH · Las cuentas de casa

Aplicación web para llevar los gastos de una casa y una familia, pensada para alojarla en un
contenedor de **Proxmox** y usarla desde cualquier dispositivo a través de **Tailscale**.
Cada persona tiene su usuario y contraseña, y los hogares se comparten con quien quieras.

## Qué hace

- **Movimientos**: gastos e ingresos en segundos (importe con calculadora: `12,40+3`), categorías con
  emoji, sugerencias que rellenan la categoría sola, persona, forma de pago y mascota. Búsqueda, filtros y
  exportación a CSV.
- **Foto del ticket**: haces la foto y se rellenan solos el total, la fecha, la tienda y la categoría; la foto
  queda adjunta al gasto. Se lee en el propio móvil (Tesseract en WebAssembly): la foto no sale para leerse.
  La primera vez descarga el lector (unos 12 MB, desde tu servidor) y después funciona incluso sin conexión.
- **Importar del banco**: CSV, XLS, XLSX u ODS de Santander, BBVA, CaixaBank, ING, Sabadell, Openbank,
  Bankinter, Unicaja, Kutxabank, Abanca, Ibercaja, Cajamar, Revolut, N26, EVO, MyInvestor… Reconoce el banco y
  las columnas (también cargos y abonos por separado), limpia los conceptos («COMPRA TARJ. 4B*1234 MERCADONA»
  → «Mercadona»), propone la categoría, marca lo que ya estaba anotado para no duplicarlo y aparta las
  retiradas de cajero y los traspasos. Se puede arrastrar el archivo sobre Movimientos.
- **Categorías que se aprenden**: cada vez que eliges o corriges una categoría se recuerda para ese comercio
  (y hay una lista de comercios españoles ya clasificados). Se ven y se ajustan en *Ajustes → Categorías*.
- **Sin cobertura**: la app se abre siempre al momento (la interfaz va guardada en el móvil) y, si el servidor no
  contesta en unos segundos, enseña lo último que se vio; se puede seguir anotando gastos (con su foto) y usando la
  lista de la compra, y en cuanto el servidor vuelve se envía todo solo, sin duplicar nada, y los datos se ponen al
  día sin recargar. Necesita HTTPS (Tailscale serve) para funcionar sin conexión.
- **Avisos que se adelantan**: la luz va un 20 % por encima de lo normal, un recibo ha subido de precio, una
  posible suscripción nueva (y pasarla a pagos fijos con un toque), categorías disparadas, presupuestos que se
  van a pasar, gastos poco habituales, semana cargada de recibos y rachas de ahorro. En Inicio, en la campana y
  como mucho una notificación al día.
- **Resumen del mes**: lo que entró y salió, en qué se fue, el gasto más grande, el día de más gasto, el súper,
  el presupuesto y quién gastó, con una imagen para compartir por WhatsApp. El día 1 llega como notificación.
- **Ingresos**: nómina, trabajos extra, devoluciones… como movimientos sueltos o como **ingresos fijos**
  que se anotan solos cada mes. Balance, tasa de ahorro y **balance previsto al cierre** se recalculan al momento.
  Si una nómina cambia de un mes a otro, el día que elijas la app pregunta si la de cada persona es igual que la
  anterior o cuánto es, y la previsión usa esa cantidad (*Ajustes → Hogar → Nóminas que cambian cada mes*).
- **Pagos fijos**: semanales, quincenales, mensuales, **bimestrales**, trimestrales, cuatrimestrales,
  semestrales y anuales. Automáticos o manuales, con importe variable, saltar cuota y pausar.
- **Compras a plazos**: precio, entrada, número de cuotas y fecha de la primera. Calcula la cuota
  (la última absorbe el redondeo), las anota cada mes hasta terminar y muestra el progreso, lo que
  queda, cuándo terminas y cuánto cuesta financiarlo. Gráfico de cómo baja la deuda.
- **Facturas**: luz, agua, gas, teléfono… con periodo, consumo (kWh, m³…), vencimiento, PDF adjunto y
  evolución por proveedor. Al pagarla se anota sola como gasto.
- **Consumo de luz**: precio regulado (PVPC) de cada hora descargado de Red Eléctrica (con IVA e impuesto
  eléctrico), o tu tarifa fija o por tramos. Anotas cuándo usas cada electrodoméstico (hora y tiempo, o kWh) y
  calcula lo que cuesta con el precio de esa hora; te dice la hora más barata para ponerlo. Cada día se suma un
  gasto «Consumo de luz (estimado)» y, al registrar la factura de la luz, lo estimado en su periodo queda dentro
  de ella (solo se anota la diferencia). Con tus facturas anteriores, prevé cuánto será la próxima.
- **Home Assistant**: si tienes enchufes inteligentes con medición (Shelly, Tasmota, TP-Link, Zigbee…),
  GastosbyATH lee su consumo real y lo suma solo al consumo de luz. Detecta cada uso (la lavadora de 10:00 a
  11:30, 0,92 kWh) con su coste hora a hora, o mide el día entero (nevera, router). Cuadro con la potencia en
  directo, consumo por horas, vista previa para ajustar la detección y recuperación de los últimos días al
  enlazar. Lo anotado a mano antes de enlazar un aparato queda sustituido por lo medido (no cuenta dos veces).
- **Recordatorios**: pagos puntuales y fechas importantes (ITV, renovar el DNI, cumpleaños…), con
  repetición, aviso con antelación (o el mismo día) a la hora que elijas y «hecho y anotar el pago».
- **Calendario** de pagos del mes, **avisos** en la campana y **notificaciones push** en el móvil.
- **Lista de la compra** compartida en tiempo real, agrupada por secciones del súper, con sugerencias de
  lo que más compráis. «Terminar compra» anota el ticket como gasto.
- **Comparador de precios**: precio de los productos habituales en cada supermercado, con el más barato
  resaltado, precio por kg/litro, ofertas e historial de subidas. Se anotan de tres formas: un producto con su
  precio en varios súper a la vez (el desplegable muestra lo que hay en la lista de la compra y lo habitual),
  «Precios de la lista» (eliges el súper en el que estás y apuntas el precio de cada producto de la lista) o
  al editar un producto de la lista.
  **Precio por kilo**: la carne, el pescado o la fruta se anotan «al peso (€/kg)» y se comparan por kilo con
  los demás súper, también con las bandejas envasadas (500 g a 4,99 € = 9,98 €/kg). En la lista de la compra
  basta con poner el peso en la cantidad («800 g», «medio kilo») para que el precio pagado se guarde por kilo.
  Calcula dónde sale más barata la compra habitual (o una lista concreta), la compra repartida óptima y
  **cuánto ahorraríais al mes** según lo que gastáis en el súper. En la lista avisa: «Más barato en Lidl».
- **Histórico e inflación** (pestaña en Comparar precios): cuánto ha subido en un año lo que compráis, frente al
  IPC oficial de alimentos y al general (INE); evolución desde el primer precio anotado, lo que más ha subido y
  bajado, la subida en cada supermercado y **un año frente a otro** producto a producto. Para que cambiar de tienda
  o una oferta no parezcan inflación, cada producto se compara consigo mismo en el mismo súper y sin ofertas.
  La ficha de cada producto dice también cuánto ha cambiado su precio en un año.
- **Productos** (en la Compra, al lado de tus listas): el inventario de lo que soléis comprar, ordenado por secciones del
  súper, en lista o en cuadrícula con fotos, con filtros «en la lista» y «sin precio», buscador sin acentos y un «+» para
  añadirlo a la lista.
  Cada uno tiene su ficha con **foto**, marca o detalle, cómo se vende (por unidad, en paquete o al peso),
  su precio en cada supermercado (el más barato resaltado y cuánto más cuesta en los demás), la evolución
  del precio y un botón para añadirlo a la lista. Renombrar o cambiar de sección se aplica también a las
  listas; dos productos repetidos («Leche» y «Leche entera») se pueden **unir** sin perder precios. La foto
  aparece también en la lista de la compra.
- **Notas** (al estilo de Joplin): cuadernos y subcuadernos, notas en Markdown con vista previa (o dividida en el
  ordenador), casillas que se marcan tocándolas, etiquetas, tareas con fecha, imágenes (pegar, arrastrar o hacer
  la foto), búsqueda sin tildes, fijar arriba, papelera de 30 días y descarga o importación en `.md`.
  Hay dos sitios: **«Del hogar»**, que ve toda la familia, y **«Solo para ti»**, notas privadas que nadie más
  puede ver (tampoco los administradores). Una persona con rol de lector puede escribir sus notas privadas.
  Si dos personas editan la misma nota a la vez, la segunda recibe un aviso y elige qué versión se queda.
  **Copia de seguridad de las notas** (en Notas o en Ajustes › Copias y datos): un `.zip` con las notas en Markdown
  por carpetas de cuaderno y sus imágenes (se lee sin la app y se importa en Joplin como «Markdown + Front
  Matter») más un `notas.json` para restaurarlo todo exacto. Restaurar no duplica lo que ya está y, si una nota
  cambió desde la copia, la de la copia entra aparte como «(restaurada)». También importa `.zip` de Joplin.
  La copia lleva las notas del hogar y las privadas de quien la descarga, nunca las de otras personas; si hace
  más de un mes de la última, la app lo recuerda. Se puede **proteger con contraseña** (cifrado AES-256 de ZIP,
  el de 7-Zip y WinZip): sin ella no se ven ni los títulos. Se abre con 7-Zip, Keka, The Unarchiver o ZArchiver
  (el explorador de Windows y la utilidad del Mac no admiten este cifrado) o restaurándola en la app.
- **Mascotas**: ficha, vacunas y desparasitaciones con recordatorio, peso con gráfico y gastos.
- **Presupuestos** por categoría y del hogar, con la marca de «dónde deberíais ir hoy».
- **Ahorro**: metas con anillo de progreso y cuánto apartar al mes.
- **Análisis**: flujo del dinero (ingresos → gastos → ahorro), reparto por categorías, evolución,
  calendario de calor, día de la semana, año contra año, quién gasta, comercios… con vista de tabla.
- **Para empezar**: un asistente deja la casa lista en dos minutos (ingresos, pagos fijos con plantillas de un
  toque, un presupuesto propuesto y la familia).
- **Para todos**: vista sencilla (botones grandes y solo lo esencial) y tamaño de letra grande o muy grande,
  por persona; un administrador puede activárselos a otro miembro. Fotos de cada persona, y el color del hogar
  tiñe toda la aplicación (con contraste comprobado en claro y oscuro).
- **Compartir**: varios hogares por usuario, invitaciones por nombre de usuario o con código,
  roles (propietario, administrador, editor, solo lectura) y registro de actividad.
- Tema claro y oscuro, instalable como app (PWA), atajos de teclado (`N`, `I`, `Ctrl+K`).

### En el móvil, con el pulgar

| Dónde | Gesto |
|---|---|
| Botón **+** | toque: anotar gasto · mantener pulsado: menú para añadir cualquier cosa |
| Lista de la compra | tocar = tachar · deslizar → editar · ← quitar · mantener pulsado = elegir varios (mover a otra lista, al carro, quitar) · asa ⋮⋮ = arrastrar a otro orden o sección · micrófono = dictar |
| Movimientos | deslizar → repetir hoy · ← borrar · mantener pulsado = elegir varios (categoría, persona, borrar) |
| Recordatorios | círculo = hecho · deslizar → hecho · ← posponer una semana |
| Pagos fijos y facturas | círculo = pagado al momento (con «Deshacer») · deslizar → pagar · ← editar |
| Formulario de gasto | los gastos habituales aparecen arriba: un toque y queda relleno |
| Hojas | se cierran deslizando hacia abajo |

## Probar en tu ordenador

Necesitas Node.js 20 o superior.

```bash
npm install
npm start            # http://localhost:8080
```

La primera cuenta que crees es la administradora. En *Ajustes → Copias y datos* (o en el inicio de un
hogar vacío) puedes cargar **datos de ejemplo** para ver la app llena.

### Pruebas automáticas

```bash
npm test             # unitarias, API y navegador (algo más de un minuto)
npm run test:api     # solo una tanda: test:unit, test:api o test:e2e
```

Cada prueba arranca su propio servidor con datos temporales: nunca toca los datos de verdad. Las de
navegador usan el Chromium del sistema (`apt install chromium`); si no está, se saltan.
Más detalles en [tests/README.md](tests/README.md).

## Instalar en un contenedor de Proxmox

Se tarda unos 10 minutos. Al final tendrás:

| Dónde | Qué |
|---|---|
| `/root/gastosbyath` | el código descargado de GitHub (de aquí salen las actualizaciones) |
| `/opt/gastosbyath` | la aplicación instalada |
| `/var/lib/gastosbyath` | **tus datos**: base de datos, fotos y copias de seguridad |
| `/etc/gastosbyath.env` | los ajustes (puerto, registro abierto…); las actualizaciones no lo tocan |
| servicio `gastosbyath` | arranca solo al encender el contenedor |
| `gastosbyath-backup.timer` | copia de seguridad cada noche a las 3:30 |

### 1. Crear el contenedor

En la web de Proxmox, *Create CT*:

| Pestaña | Valor |
|---|---|
| General | Hostname `gastosbyath` (será su nombre en Tailscale), contraseña de root, ✔ *Unprivileged container*, ✔ *Nesting* |
| Template | `debian-13-standard` o `debian-12-standard` |
| Disks | 8 GB (las copias guardan cada foto una sola vez; se puede ampliar después) |
| CPU | 2 núcleos |
| Memory | 1024 MB de RAM y 512 MB de swap |
| Network | IPv4 por DHCP (o una IP fija) |
| Confirm | desmarca *Start after created* |

Apunta el número que le da Proxmox (por ejemplo `120`): se usa en el paso 2.

### 2. Permitir Tailscale (en la *Shell* del host)

Es lo único que se hace fuera del contenedor. Cambia `120` por el número del tuyo:

```bash
cat >> /etc/pve/lxc/120.conf <<'EOF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF
pct start 120
```

### 3. Instalar la app (en la consola del contenedor)

En Proxmox, el contenedor → *Console*, entra como `root` y ejecuta:

```bash
apt update && apt install -y git
git clone --config remote.origin.pushurl=no-push https://github.com/altorrecillas/appgastos.git /root/gastosbyath
bash /root/gastosbyath/deploy/install.sh
```

Tarda unos minutos (más con una conexión lenta) y termina con `==> GastosbyATH está funcionando en el puerto 8080`
y la dirección para abrirla (`http://<IP>:8080`). Si se corta a medias (por ejemplo, por la conexión), vuelve a
ejecutar la última orden: retoma donde se quedó.

Si parece parado en un paso de instalación de paquetes, casi seguro está descargando. **No lo canceles** (cortar
`apt` a medias deja paquetes a medio instalar). Para verlo, abre otra consola del contenedor (en la *Shell* del
host, `pct enter 120`) y ejecuta `tail -f /var/log/dpkg.log`: si van saliendo líneas, está trabajando
(`Ctrl+C` cierra solo esa vista). Si de verdad no se mueve nada en 15 minutos, cancélalo con `Ctrl+C`, ejecuta
`dpkg --configure -a` y vuelve a lanzar el instalador.

Avisos que puedes ignorar:

- `W: Failed to fetch http://security.debian.org/… Network is unreachable`: tu red no tiene IPv6. El instalador
  hace que `apt` use solo IPv4 a partir de ese momento; para descargar ya los parches de seguridad, ejecuta
  después `apt update && apt upgrade -y`.
- `WARNING: apt does not have a stable CLI interface`: lo escribe siempre el instalador de Node.js.
- `npm WARN tar TAR_ENTRY_ERROR EINVAL: invalid argument, fchown`: en un contenedor sin privilegios npm no puede
  poner a los archivos el dueño que traían de origen; se instalan bien igual.
- `npm WARN deprecated prebuild-install`: es la herramienta que descarga SQLite ya compilado; funciona.
- Un bloque de `npm ERR!` seguido de `==> Instalando herramientas de compilación y reintentando`: con una conexión
  lenta, la descarga de SQLite ya compilado puede caducar (`Request timed out`). El instalador lo reintenta solo;
  lo que cuenta es que termine con `GastosbyATH está funcionando en el puerto 8080`.

El contenedor solo **descarga** de GitHub: no tiene ninguna clave de GitHub y `pushurl=no-push` hace que cualquier
`git push` falle. Los datos viven en `/var/lib/gastosbyath`, fuera de la carpeta de git, así que no pueden acabar
en GitHub.

### 4. Acceso con Tailscale (y HTTPS)

En la consola del contenedor:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
tailscale serve --bg 8080
```

`tailscale up` te da un enlace para autorizar el contenedor en tu cuenta. Si es la primera vez que usas HTTPS en
tu tailnet, `tailscale serve` te dará otro para activarlo. Después entra desde cualquier dispositivo de tu
tailnet en `https://gastosbyath.<tu-tailnet>.ts.net` (con el hostname que pusiste en el paso 1).

### 5. Primeros pasos

1. Abre la app y crea tu cuenta: la primera es la administradora. Un asistente te ayuda a preparar el hogar.
2. Invita a la familia en *Ajustes → Miembros → Invitar con un código*: cada persona se registra en la misma
   dirección y pulsa «Unirme con un código».
3. Cuando todos tengan cuenta, cierra el registro: en la consola del contenedor, `nano /etc/gastosbyath.env`,
   pon `ALLOW_REGISTRATION=false`, guarda y ejecuta `systemctl restart gastosbyath`. Los códigos de
   invitación siguen funcionando.
4. En el móvil, instálala como app (con HTTPS funcionan además las **notificaciones**):
   - Android: menú del navegador → *Instalar aplicación*.
   - iPhone: Safari → Compartir → *Añadir a pantalla de inicio* (en iOS las notificaciones solo funcionan con
     la app añadida a la pantalla de inicio).

   Después activa los avisos en *Recordatorios* o *Ajustes → Notificaciones* en cada dispositivo.

### Otras formas de instalar

- **Todo automático desde el host:** copia esta carpeta al host y ejecuta `bash deploy/proxmox-create-ct.sh`
  (opcional: `CTID=120 CT_NAME=gastosbyath STORAGE=local-lvm MEMORY=1024 DISK=8`). Crea el contenedor, hace el
  paso 2 e instala la app copiando la carpeta (sin GitHub; para actualizar hay que volver a copiarla).
- **Sin GitHub, en un contenedor que ya tengas:** copia esta carpeta dentro y ejecuta `bash deploy/install.sh`.
  Para actualizar, copia la versión nueva encima y vuelve a ejecutarlo.

### Conectar Home Assistant

1. En Home Assistant crea un usuario solo para GastosbyATH (sin permisos de administrador) y, con él, un
   token: *perfil → Seguridad → Tokens de acceso de larga duración → Crear token*.
2. En GastosbyATH, *Home Assistant* (en el menú) → dirección tal como la ve el contenedor
   (`http://192.168.1.20:8123` o el nombre de Tailscale) y el token → *Probar conexión* → *Conectar*.
3. Elige los enchufes que quieres medir. Para cada uno: «cada vez que se enciende» (lavadora, horno…) o
   «todo el día» (nevera, router…), el umbral de encendido y la pausa máxima dentro de un uso. La vista previa
   enseña lo que se habría detectado los últimos días con esos ajustes.

Solo lectura: GastosbyATH consulta la API REST (`/api/states` y `/api/history`) y nunca acciona nada. El token se
guarda cifrado (AES-256-GCM, clave en `DATA_DIR/secret.key`) y no se envía nunca al navegador; solo los
administradores del hogar pueden cambiar la conexión. Se lee cada 15 minutos (configurable) y los días ya
incluidos en una factura de la luz no se tocan. Si el enchufe pierde la wifi, ese hueco no suma consumo.

## Actualizar

### 1. Subir los cambios a GitHub (en tu ordenador)

En la carpeta del proyecto:

```bash
bash subir_a_github.sh
```

Te pide un mensaje que describa el cambio (es lo que verás como «novedades» al actualizar), hace el commit y lo sube.

### 2. Actualizar el contenedor (en su consola)

```bash
bash /root/gastosbyath/deploy/actualizar.sh
```

Lo que hace, en orden:

1. Descarga lo nuevo de GitHub. Si no hay nada nuevo, te lo dice y no toca nada.
2. Te enseña las novedades (los mensajes de los commits).
3. Hace una copia de seguridad de la base de datos y de las fotos, por si la versión nueva cambia la base de datos.
4. Instala la versión nueva en `/opt/gastosbyath`, reinicia el servicio y comprueba que responde.

Tus datos (`/var/lib/gastosbyath`) y tus ajustes (`/etc/gastosbyath.env`) no se tocan. En los móviles, la app
se pone al día la próxima vez que se abre; si ves algo raro, ciérrala del todo y vuelve a abrirla.

`bash /root/gastosbyath/deploy/actualizar.sh --forzar` reinstala aunque no haya nada nuevo: por ejemplo, después
de cambiar el puerto o la carpeta de datos en `/etc/gastosbyath.env`.

### Si algo sale mal

| Mensaje | Qué hacer |
|---|---|
| `hay cambios hechos a mano en /root/gastosbyath` | Alguien ha editado archivos ahí. Míralos con `git -C /root/gastosbyath status`; para descartarlos, `git -C /root/gastosbyath reset --hard` y vuelve a actualizar. |
| `El servicio no responde` | Mira el motivo con `journalctl -u gastosbyath -n 50`. |
| La versión nueva funciona mal | Vuelve a la anterior (abajo) mientras se arregla. |

Para volver a la versión anterior:

```bash
cd /root/gastosbyath
git log --oneline -5          # la primera línea es la versión actual; la segunda, la anterior
git checkout 1a2b3c4          # el código de la versión a la que quieres volver
bash deploy/install.sh
```

Si la versión nueva había cambiado la base de datos, restaura también la copia que se hizo justo antes de
actualizar (ver *Copias de seguridad*: es la `gastosbyath-….db` más reciente de antes de la actualización).
Para volver después a la última versión, basta con `bash /root/gastosbyath/deploy/actualizar.sh`.

## Versiones

La versión de la app está en `package.json` (por ejemplo `0.44.0`, que se enseña como **0.44**) y sus novedades
en [CHANGELOG.md](CHANGELOG.md). Se ve en *Ajustes → Aplicación* y al pie del menú *Más*.

Cada mejora sube la versión:

```bash
npm run subir-version -- "Qué hay de nuevo" "Otra novedad"     # 0.44 → 0.45
npm run subir-version -- arreglo "Qué se ha arreglado"          # 0.45 → 0.45.1
```

Así, al subirla a GitHub y actualizar el contenedor:

- `actualizar.sh` enseña `Versión 0.44 → 0.45` y sus novedades;
- los móviles con la app abierta muestran «Hay una versión nueva» con un botón para actualizar, y la próxima
  vez que se abre ya carga la nueva (el service worker lleva la versión: al cambiar, se renueva solo).

## Copias de seguridad

- Automáticas, cada noche a las 3:30, en `/var/lib/gastosbyath/backups`: la base de datos entera (se guardan las
  30 últimas, `gastosbyath-AAAA-MM-DD-HH-MM-SS.db`) y la carpeta `adjuntos/`, donde cada foto o PDF se copia una
  sola vez. Así las copias ocupan poco: lo que ocupen tus fotos, más 30 veces la base de datos (que es pequeña).
  Una foto que borres en la app se queda en `adjuntos/` mientras alguna de esas 30 copias la use.
- Manual: `runuser -u gastosbyath -- env DATA_DIR=/var/lib/gastosbyath node /opt/gastosbyath/scripts/backup.js`
- Por hogar: *Ajustes → Copias y datos → Descargar copia (JSON)*, que también sirve para pasar los
  datos a otro servidor (*Cargar una copia*).

Las copias hechas cuando la aplicación se llamaba «Cuartos» siguen valiendo: el JSON se carga igual y, si en la
carpeta de datos solo está `cuartos.db`, al arrancar se renombra sola a `gastosbyath.db`.

Para restaurar una copia completa (elige la fecha en el nombre del archivo; la hora va en UTC):

```bash
systemctl stop gastosbyath
cd /var/lib/gastosbyath
ls backups/                    # elige la copia por su fecha
runuser -u gastosbyath -- cp backups/gastosbyath-2026-11-01-02-30-00.db gastosbyath.db
runuser -u gastosbyath -- rm -f gastosbyath.db-wal gastosbyath.db-shm
runuser -u gastosbyath -- cp -r backups/adjuntos/. uploads/
systemctl start gastosbyath
```

Si restauras en un contenedor nuevo, copia también `secret.key` y `vapid.json` de la carpeta de datos antigua
si los conservas. No van en las copias a propósito: `secret.key` descifra el token de Home Assistant y no debe
viajar junto a él. Sin ellos todo funciona, pero hay que volver a conectar Home Assistant y activar otra vez los
avisos en cada móvil.

Las copias de versiones anteriores (`adjuntos-*.tar.gz`, con todos los adjuntos de cada día) se van borrando
solas a medida que caducan sus copias de la base de datos.

## Mantenimiento

| Tarea | Orden |
|---|---|
| Estado | `systemctl status gastosbyath` |
| Registro | `journalctl -u gastosbyath -f` |
| Actualizar | `bash /root/gastosbyath/deploy/actualizar.sh` (ver *Actualizar*) |
| Ajustes | `nano /etc/gastosbyath.env` y `systemctl restart gastosbyath` |
| Olvido de contraseña | `runuser -u gastosbyath -- env DATA_DIR=/var/lib/gastosbyath node /opt/gastosbyath/scripts/reset-password.js <usuario>` |
| Parches del sistema | `apt update && apt upgrade -y` |

## Configuración (variables de entorno)

En el contenedor van en `/etc/gastosbyath.env` (después de cambiarlas, `systemctl restart gastosbyath`; si cambias
`PORT`, `DATA_DIR` o `APP_DIR`, mejor `bash /root/gastosbyath/deploy/actualizar.sh --forzar`).

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `8080` | Puerto HTTP |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `DATA_DIR` | `./data` | Base de datos, adjuntos, claves push y copias |
| `TZ` | la del sistema | Zona horaria para fechas y pagos automáticos |
| `ALLOW_REGISTRATION` | `true` | Ponlo a `false` cuando la familia ya tenga cuenta |
| `PUSH_HOUR` | `9` | A partir de qué hora se envían las notificaciones del día |
| `VAPID_SUBJECT` | `mailto:gastosbyath@localhost` | Contacto para el servicio de notificaciones |
| `TRUST_PROXY` | `loopback` | Proxies de confianza (Tailscale serve ya va por loopback) |

## Docker (alternativa)

```bash
docker compose up -d
```

## Seguridad

- Contraseñas con `scrypt` y sal; sesiones opacas guardadas como hash y cookie `httpOnly`.
- Protección CSRF, límite de intentos de acceso y cabeceras de seguridad (CSP incluida).
- Cada consulta comprueba que el usuario pertenece al hogar y que su rol permite la acción.
- Las notas privadas (y sus imágenes) solo las puede abrir su autor: no aparecen en búsquedas, avisos en tiempo
  real, actividad del hogar ni en la copia de seguridad que exporte otra persona. El Markdown se limpia con
  DOMPurify y solo se muestran imágenes guardadas en la propia app.
- El servidor solo descarga datos públicos: los precios de la luz de Red Eléctrica y el IPC del INE
  (`servicios.ine.es`, como mucho cada 12 horas). No se envía nada del hogar; sin internet, todo lo demás funciona.
- La foto del ticket se lee en el propio dispositivo; por eso la política de seguridad permite WebAssembly
  (`'wasm-unsafe-eval'`), y nada más.
- El token de Home Assistant se guarda cifrado en el servidor y nunca sale hacia el navegador. Si copias la
  base de datos a otro servidor sin `secret.key`, habrá que volver a pegar el token.
- Pensada para una red privada como Tailscale: no la publiques directamente en internet.

## Estructura

```
server.js            servidor Express (API + archivos estáticos)
src/                 base de datos, autenticación, tiempo real, notificaciones y rutas de la API
public/              la aplicación web (HTML, CSS y módulos JS sin compilación)
  js/views/          una vista por sección
  vendor/ fonts/ icons/   ECharts, tipografía Bricolage Grotesque e iconos Lucide servidos en local
scripts/             copias de seguridad, cambio de contraseña y preparación de recursos
tests/               pruebas automáticas (npm test); no se copian al servidor
deploy/              instalación en Proxmox (LXC) y servicio systemd
```

Tecnología: Node.js + Express + SQLite (better-sqlite3), Server-Sent Events para el tiempo real,
Web Push para notificaciones y ECharts para los gráficos. `npm run vendor` regenera los recursos de
`public/vendor`, `public/fonts` y `public/icons` desde `node_modules`.

Licencias de terceros: ECharts (Apache-2.0), Bricolage Grotesque (SIL OFL 1.1), Lucide (ISC).
