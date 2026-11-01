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

# Este contenedor solo descarga: cualquier «git push» desde aquí falla (los datos nunca van a GitHub).
git config remote.origin.pushurl no-push
# Versión de un package.json («0.44.0» se enseña como «0.44»).
ver() { sed -n 's/^  "version": "\([^"]*\)".*/\1/p' | head -1 | sed 's/\.0$//'; }
BEFORE="$(git rev-parse HEAD)"
OLD_V="$(git show "$BEFORE:package.json" 2>/dev/null | ver)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "No se ha podido actualizar: hay cambios hechos a mano en $SRC_DIR (míralos con «git status»)."
  exit 1
fi
git fetch --quiet origin
# Siempre la versión de GitHub tal cual: también si se había vuelto a una anterior (git checkout <versión>)
# o si el historial de GitHub se ha reescrito.
git checkout -q -B main origin/main
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ] && [ "${1:-}" != "--forzar" ]; then
  echo "Ya tienes la última versión ($(git log -1 --date=short --format='%cd, %h'))."
  exit 0
fi
NEW_V="$(ver < package.json)"
if [ -n "$OLD_V" ] && [ "$OLD_V" != "$NEW_V" ] && [ -f CHANGELOG.md ]; then
  echo "Versión $OLD_V → $NEW_V. Novedades:"
  awk -v old="## $OLD_V " 'index($0, old) == 1 { exit } /^## / { print "  " substr($0, 4); next } /^- / { print "    •" substr($0, 2) }' CHANGELOG.md
elif [ "$BEFORE" != "$AFTER" ]; then
  echo "Novedades:"
  git log --no-merges --format='  • %s' "$BEFORE..$AFTER" | head -20
fi
exec bash deploy/install.sh
