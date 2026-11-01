#!/usr/bin/env bash
# Actualiza GastosbyATH a la última versión publicada en GitHub. Ejecutar como root dentro del contenedor:
#   bash /root/gastosbyath/deploy/actualizar.sh
#   bash /root/gastosbyath/deploy/actualizar.sh --forzar    reinstala aunque no haya cambios
# Antes de cambiar nada se hace una copia de seguridad de los datos (la hace install.sh), y los datos no se tocan.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "Ejecuta este script como root"; exit 1; }
cd "$SRC_DIR"
[ -d .git ] || { echo "$SRC_DIR no viene de GitHub (falta .git): instálalo con git clone."; exit 1; }

BEFORE="$(git rev-parse HEAD)"
if ! git pull --ff-only --quiet; then
  echo "No se ha podido actualizar: hay cambios hechos a mano en $SRC_DIR (míralos con «git status»)."
  exit 1
fi
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ] && [ "${1:-}" != "--forzar" ]; then
  echo "Ya tienes la última versión ($(git log -1 --date=short --format='%cd, %h'))."
  exit 0
fi
if [ "$BEFORE" != "$AFTER" ]; then
  echo "Novedades:"
  git log --no-merges --format='  • %s' "$BEFORE..$AFTER"
fi
exec bash deploy/install.sh
