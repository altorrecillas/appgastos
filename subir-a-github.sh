#!/usr/bin/env bash
# Sube los cambios del proyecto a GitHub, comprobando antes que no se cuela ningún dato personal.
# Uso, desde esta carpeta:
#   bash subir-a-github.sh "Qué ha cambiado"            revisa, pasa las pruebas, guarda y sube
#   bash subir-a-github.sh "Qué ha cambiado" --sin-pruebas
#   bash subir-a-github.sh --comprobar                  solo revisa; no guarda ni sube nada
# La primera vez crea el repositorio público «gastosbyath» en tu cuenta (hace falta haber hecho «gh auth login»).
#
# Qué revisa antes de subir:
#   - que los commits salen con tu usuario de GitHub y su correo anónimo (…@users.noreply.github.com), nunca con tu correo;
#   - que no va ningún dato de la app (bases de datos, fotos, copias, claves);
#   - que no aparece ninguna de las palabras de .datos-privados (tu nombre, correos, teléfono, dirección…).
#     Ese archivo es solo tuyo: no se sube nunca. La primera vez se crea con lo que ya sabe tu equipo; añade lo que quieras;
#   - que no hay correos electrónicos ni fotos con datos ocultos (EXIF: ubicación, móvil, fecha).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

REPO_NAME="${REPO_NAME:-gastosbyath}"
DESCRIPTION="Gastos del hogar autoalojados para un contenedor de Proxmox"
PRIVATE_WORDS=".datos-privados"

MSG=""
CHECK_ONLY=0
TESTS=1
for a in "$@"; do
  case "$a" in
    --comprobar) CHECK_ONLY=1 ;;
    --sin-pruebas) TESTS=0 ;;
    -*) echo "No conozco la opción $a"; exit 2 ;;
    *) MSG="$a" ;;
  esac
done

ok() { printf '\033[32m✔\033[0m %s\n' "$*"; }
stop() { printf '\n\033[31m✘ %s\033[0m\n' "$*"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

command -v git >/dev/null || stop "Falta git (apt install git)."
command -v gh >/dev/null || stop "Falta gh, la herramienta de GitHub (https://cli.github.com)."
gh auth status >/dev/null 2>&1 || stop "gh no tiene sesión abierta: ejecuta «gh auth login»."
[ -d .git ] || git init -q -b main

# ---------- 1. Quién firma los commits ----------
step "1. Identidad de los commits"
LOGIN="$(gh api user --jq .login)"
NOREPLY="$(gh api user --jq .id)+$LOGIN@users.noreply.github.com"
if [ "$(git config --local user.email || true)" != "$NOREPLY" ] || [ "$(git config --local user.name || true)" != "$LOGIN" ]; then
  git config --local user.name "$LOGIN"
  git config --local user.email "$NOREPLY"
fi
ok "Los commits salen como $LOGIN <$NOREPLY>"
# Commits aún sin subir hechos con otra identidad (por ejemplo, antes de existir este script).
if git rev-parse -q --verify HEAD >/dev/null; then
  RANGE="HEAD"
  git rev-parse -q --verify origin/main >/dev/null && RANGE="origin/main..HEAD"
  BAD="$(git log --format='%h %ae %ce' "$RANGE" | awk -v e="$NOREPLY" '$2 != e || $3 != e')"
  [ -z "$BAD" ] || stop "Hay commits sin subir firmados con otro correo:
$BAD
Arréglalo con: git rebase -r --exec 'git commit --amend --no-edit --reset-author' $( [ "$RANGE" = HEAD ] && echo --root || echo origin/main )"
fi

# ---------- 2. Palabras privadas (archivo local, nunca se sube) ----------
grep -qxF "$PRIVATE_WORDS" .gitignore 2>/dev/null || printf '\n# Palabras que nunca deben llegar a GitHub (solo en tu equipo)\n%s\n' "$PRIVATE_WORDS" >> .gitignore
if [ ! -f "$PRIVATE_WORDS" ]; then
  {
    echo "# Palabras que nunca deben aparecer en lo que se sube a GitHub: una por línea (no distingue mayúsculas)."
    echo "# Añade tus apellidos, otros correos, teléfono, dirección, nombres de tu familia… Este archivo no se sube."
    name="$(git config --global user.name || true)"; [ -n "$name" ] && echo "$name"
    mail="$(git config --global user.email || true)"; [ -n "$mail" ] && { echo "$mail"; echo "${mail%%@*}"; }
    echo "$HOME"
    for ip in $(hostname -I 2>/dev/null); do echo "$ip"; done
  } > "$PRIVATE_WORDS"
  echo "Creado $PRIVATE_WORDS con tu nombre y correo de git, tu carpeta personal y la IP de este equipo. Revísalo y añade lo que quieras."
fi

# ---------- 3. Lo que se va a subir ----------
step "2. Revisión de lo que se va a subir"
git add -A
FAIL=0
# Datos de la app: nunca (aunque el .gitignore ya los deja fuera).
DATA="$(git ls-files | grep -iE '(^|/)(data|uploads|backups)/|\.(db|db-wal|db-shm|sqlite|zip|tar\.gz)$|(^|/)(secret\.key|vapid\.json|\.env.*)$' || true)"
if [ -n "$DATA" ]; then echo "Archivos de datos:"; echo "$DATA" | sed 's/^/  /'; FAIL=1; else ok "Ningún dato de la app (bases de datos, fotos, copias, claves)"; fi
# Palabras privadas, como palabra entera (tu usuario de GitHub puede aparecer: ya es público).
HITS=""
while IFS= read -r w || [ -n "$w" ]; do
  w="${w%$'\r'}"
  [ -z "${w// /}" ] || [ "${w:0:1}" = "#" ] && continue
  h="$(git grep --cached -I -n -i -w -F -e "$w" -- . ":!$PRIVATE_WORDS" 2>/dev/null | cut -c1-160 || true)"
  [ -n "$h" ] && HITS+="«$w»:"$'\n'"$(echo "$h" | sed 's/^/    /')"$'\n'
done < "$PRIVATE_WORDS"
if [ -n "$HITS" ]; then echo "Aparecen palabras de $PRIVATE_WORDS:"; printf '%s' "$HITS" | sed 's/^/  /'; FAIL=1; else ok "Ninguna palabra de $PRIVATE_WORDS"; fi
# Correos electrónicos (los anónimos de GitHub y los de ejemplo sí pueden ir). Las librerías de terceros de
# public/vendor, minificadas y copiadas de npm, no se miran aquí (líneas de varios MB); las palabras privadas, sí.
MAILS="$(git grep --cached -I -n -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' -- . ':!package-lock.json' ':!public/vendor' 2>/dev/null \
  | grep -viE '@users\.noreply\.github\.com|noreply@anthropic\.com|@example\.(com|org)' || true)"
if [ -n "$MAILS" ]; then echo "Correos electrónicos:"; echo "$MAILS" | sed 's/^/  /'; FAIL=1; else ok "Ningún correo electrónico"; fi
# Fotos con EXIF (pueden llevar la ubicación, el móvil y la fecha).
EXIF=""
while IFS= read -r f; do
  git show ":$f" 2>/dev/null | head -c 65536 | LC_ALL=C grep -qai 'exif' && EXIF+="  $f"$'\n'
done < <(git ls-files | grep -iE '\.(jpe?g|heic|heif|tiff?|webp)$' || true)
if [ -n "$EXIF" ]; then echo "Fotos con datos EXIF (quítalos antes, por ejemplo con «exiftool -all= foto.jpg»):"; printf '%s' "$EXIF"; FAIL=1; else ok "Ninguna foto con datos ocultos"; fi
# Archivos enormes (GitHub no admite más de 100 MB).
BIG="$(git ls-files -z | xargs -0 -r du -k 2>/dev/null | awk '$1 > 20480 {print "  " $2 " (" int($1/1024) " MB)"}')"
if [ -n "$BIG" ]; then echo "Archivos de más de 20 MB:"; echo "$BIG"; FAIL=1; else ok "Ningún archivo enorme"; fi

if [ "$FAIL" = 1 ]; then
  git reset -q
  stop "No se sube nada. Quita o arregla lo de arriba y vuelve a intentarlo."
fi
CHANGES="$(git diff --cached --name-only | wc -l)"
if [ "$CHECK_ONLY" = 1 ]; then
  git reset -q
  ok "Todo correcto. $CHANGES archivos cambiados sin guardar (con --comprobar no se guarda ni se sube nada)."
  exit 0
fi

# ---------- 4. Pruebas ----------
if [ "$TESTS" = 1 ] && [ "$CHANGES" -gt 0 ]; then
  step "3. Pruebas (npm test)"
  npm test || { git reset -q; stop "Las pruebas fallan: no se sube nada. (Para subir igualmente: --sin-pruebas)"; }
fi

# ---------- 5. Guardar y subir ----------
step "4. Guardar y subir"
if [ "$CHANGES" -gt 0 ]; then
  git commit -q -m "${MSG:-Actualización del $(date +%Y-%m-%d)}"
  ok "Guardado: $(git log -1 --format='%h %s')"
fi
if git remote get-url origin >/dev/null 2>&1; then
  git push -q origin HEAD:main
elif gh repo view "$LOGIN/$REPO_NAME" >/dev/null 2>&1; then
  git remote add origin "https://github.com/$LOGIN/$REPO_NAME.git"
  git push -q -u origin HEAD:main
else
  gh repo create "$REPO_NAME" --public --source . --remote origin --push --description "$DESCRIPTION" >/dev/null
fi
ok "Subido a https://github.com/$LOGIN/$REPO_NAME"
echo
echo "Para actualizar el contenedor, en su consola:  bash /root/gastosbyath/deploy/actualizar.sh"
