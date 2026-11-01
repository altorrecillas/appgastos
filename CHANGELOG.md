# Novedades

Cada mejora sube la versión (`npm run subir-version -- "Novedad" …`). La app la enseña en *Ajustes → Aplicación*
y avisa en los móviles cuando hay una nueva.

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
