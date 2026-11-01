# Novedades

Cada mejora sube la versión (`npm run subir-version -- "Novedad" …`). La app la enseña en *Ajustes → Aplicación*
y avisa en los móviles cuando hay una nueva.

## 0.49 — 2026-11-01

- Presupuestos por categoría: un límite de Restaurantes (o de lo que sea) ya no se convierte en el presupuesto de todo el mes. En el inicio sale ese límite con lo gastado en esa categoría («Restaurantes: 150 € de 200 €»), en vez de dar el mes por superado por la compra o el alquiler.
- Si ponéis límites a varias categorías, el inicio enseña los tres que van más justos y cuántos se han pasado. El presupuesto total, para todo el gasto, es solo el que se pone para el hogar (en Presupuestos o en Ajustes).
- Presupuestos lo explica: lo que lleváis en las categorías con límite y cuánto del gasto no cuenta para ninguno. Las categorías sin límite ya no salen en rojo.
- La previsión de cierre del mes ya no se dispara los primeros días: se apoya en lo que soléis gastar al día y, en un hogar sin meses anteriores, no sale hasta el día 7 (el día 1 multiplicaba lo gastado ese día por 30).

## 0.48 — 2026-11-01

- Mascotas en el móvil: la página ya no se sale por el lado. Los datos de la ficha (chip, veterinario, seguro, comida…) y la evolución del peso están ahora en el botón «Ficha y peso», y abajo quedan «Salud y cuidados» y «Gastos».
- El peso se escribe en «Editar ficha»: si lo cambias, queda en su gráfica con la fecha de hoy (si lo corriges el mismo día, no sale dos veces). Un peso mal escrito se arregla con el lápiz de la lista.
- Los avisos de cada mascota ya no repiten la fecha: «Rabia: 26 nov» en vez de «26 nov (26 nov)».
- La app se abre siempre, aunque el servidor no conteste o tarde (Tailscale apagado, el contenedor reiniciándose…): en unos segundos enseña lo último que se vio en el móvil, con el aviso «Conexión lenta» o «Sin conexión» arriba. Antes se quedaba en blanco esperando.
- En cuanto el servidor vuelve a contestar, todo se pone al día solo, sin recargar: se envía lo anotado sin conexión y se cargan los datos nuevos.
- Una sección que nunca se había abierto en ese móvil lo explica y se carga sola al volver la conexión. Y si el móvil aún no tiene nada guardado, la app espera y se abre sola.

## 0.47 — 2026-11-01

- Pagos fijos «Cada 4 semanas», como cobra Basic-Fit: son 13 cobros al año, algún mes caen dos, y el gasto al mes se calcula con eso (34,99 € cada 4 semanas son unos 38 € al mes).
- Nueva categoría de gasto «Gimnasio y deporte» 🏋️, también en los hogares que ya existían. Los gimnasios habituales (Basic-Fit, VivaGym, Altafit, GO fit…) se ponen solos en ella.
- Mascotas: se puede anotar la comida 🦴 (pienso, latas, premios) con su gasto y un aviso para volver a comprar. En la pestaña «Gastos» de cada mascota hay un botón «Anotar gasto», y la primera sugerencia es la comida que pone su ficha.
- Copia de las notas con contraseña: si escribías muy rápido en «Repítela», el texto podía acabar en la primera casilla y la copia no se descargaba. Arreglado.
- Recordatorios: eliges a qué hora te avisa (atajos de 9:00, 14:00, 18:00 y 21:00, o cualquier otra), también el mismo día. El aviso llega a esa hora en punto: antes salían todos a partir de las 9 y se miraba cada 15 minutos.
- En el móvil, pellizcar o tocar dos veces ya no amplía la página ni la descuadra. Para ver todo más grande, usa «Tamaño del texto» en Apariencia.

## 0.46 — 2026-11-01

- Compra en el móvil: la lista abierta y «Productos» van en una barra de dos mitades que nunca se corta, tengas las listas que tengas. Tocando la lista se abre «Tus listas», con todas (lo que falta en cada una, el súper y las terminadas) y el botón «Nueva lista».
- Al entrar en la Compra se abre la última lista que usaste en ese móvil.
- Debajo de la lista, una barra de progreso con lo que ya está en el carro («3 de 14 en el carro»).

## 0.45 — 2026-11-01

- Compra: botón «Productos» al lado de tus listas, también en el móvil. Es el inventario de lo que soléis comprar, con su precio en cada súper, sin salir de la sección.
- Productos: filtros «en la lista» y «sin precio», vista en cuadrícula con fotos, un «+» para añadirlo a la lista y búsqueda sin acentos.
- Notas: lo que escribes nada más crear una nota ya no puede acabar en el título.
- Buscar en Movimientos no distingue mayúsculas ni acentos: «nandu» encuentra «CAFÉ ÑANDÚ»; también las sugerencias al escribir.
- «Cargar más» en Movimientos ya no abre el menú «Más» y va igual de rápido aunque cargues miles de movimientos.
- Análisis: un comercio escrito de varias formas (Mercadona, MERCADONA…) cuenta como uno solo.
- El CSV se descarga cuatro veces más rápido con muchos datos y ningún texto puede convertirse en una fórmula al abrirlo en una hoja de cálculo.
- Más rápido con muchos años de datos (pagos fijos y listas de la compra).

## 0.44 — 2026-11-01

- Nóminas que cambian cada mes: desde el día que elijas (el 1 por defecto), el Inicio pregunta si la nómina de cada persona de casa es igual que la anterior o cuánto es, y la previsión del mes usa esa cantidad. Se configura en *Ajustes → Hogar*.
- Ese día llega también un aviso al móvil, si tienes las notificaciones activadas.
- Al cobrar una nómina que cambia, lo cobrado queda como referencia para el mes siguiente.

## 0.43 — 2026-11-01

- Versión de la app: se ve en *Ajustes → Aplicación*, con estas novedades, y la app avisa cuando hay una nueva para actualizarla.
- *Ajustes → Aplicación → Instalar*: instala la app en el móvil o explica qué lo impide (dirección sin HTTPS, permisos del móvil…).
- Precios por kilo, sección *Productos*, histórico de precios con la inflación oficial (IPC del INE).
- Notas al estilo de Joplin, con notas privadas y copias de seguridad (también con contraseña).
- Copia diaria que guarda cada foto una sola vez; instalación y actualización desde GitHub en un contenedor de Proxmox.
- Pruebas automáticas (`npm test`).
