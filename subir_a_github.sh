#!/usr/bin/env bash
# ------------------------------------------------------------------------------------------------------------
#  SUBIR «TORRECILLAS OS» (torrecillas.cat) A GITHUB
#  Te pregunta a qué repositorio de GitHub subir la web (o crea uno nuevo), hace el commit con TU identidad
#  (tu nombre y el email de tu cuenta, sin coautores ni firmas añadidas), lo sube y, si quieres, lo publica
#  como web con GitHub Pages.
#
#  Uso:   bash subir_a_github.sh
#
#  Necesita git. Usa whiptail para los menús si está instalado, y GitHub CLI ("gh"); si falta gh, ofrece
#  instalarlo o usar una clave SSH. La primera vez pide iniciar sesión en GitHub; las siguientes ya no.
# ------------------------------------------------------------------------------------------------------------
set -Eeuo pipefail

CARPETA_FIJA="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"   # la carpeta de la web (donde está este script)
REPO_POR_DEFECTO="torrecillas"                                     # nombre sugerido si creas un repositorio nuevo
BASE_BUSQUEDA="${BASE_BUSQUEDA:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
TITULO="Subir a GitHub"

# los commits llevan solo tu identidad: fuera cualquier variable heredada que la cambie
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_DIR GIT_WORK_TREE
DIR=""; REMOTO=origin; MODO=""; GH_USUARIO=""; NOMBRE=""; EMAIL=""; REPO=""; URL=""

# ------------------------------------------------------------------ interfaz
UI=0; if command -v whiptail >/dev/null 2>&1 && [ -t 0 ] && [ -t 1 ]; then UI=1; fi
info()  { printf '\033[1;36m» %s\033[0m\n' "$*" >&2; }
ok()    { printf '\033[1;32m✔ %s\033[0m\n' "$*" >&2; }
aviso() { printf '\033[1;33m! %b\033[0m\n' "$*" >&2; }
salir() { printf '\033[1;31m✘ %b\033[0m\n' "$*" >&2; exit 3; }
trap 'rc=$?; [ "$BASH_SUBSHELL" = 0 ] && [ "$rc" != 3 ] && printf "\033[1;31m✘ Algo ha fallado (línea %s). Revisa el mensaje de arriba.\033[0m\n" "$LINENO" >&2; exit "$rc"' ERR

medidas() {     # tamaño de los diálogos según el terminal
  local r c; read -r r c < <(stty size </dev/tty 2>/dev/null || echo "24 80")
  [ "${r:-0}" -gt 12 ] 2>/dev/null || r=24; [ "${c:-0}" -gt 50 ] 2>/dev/null || c=80
  H=$(( r > 34 ? 30 : r - 4 )); W=$(( c > 104 ? 100 : c - 4 )); L=$(( H - 9 > 3 ? H - 9 : 3 ))
}
preguntar() {   # preguntar "texto" "valor por defecto" → respuesta
  local r
  if [ $UI = 1 ]; then medidas
    r=$(whiptail --title "$TITULO" --ok-button "Aceptar" --cancel-button "Cancelar" --inputbox "$1" 12 "$W" "${2:-}" 3>&1 1>&2 2>&3) || salir "Cancelado."
  else printf '%b [%s]: ' "$1" "${2:-}" >&2; read -r r || salir "Cancelado."; r=${r:-${2:-}}; fi
  printf '%s' "$r"
}
confirmar() {   # confirmar "pregunta" → 0 si la respuesta es sí
  if [ $UI = 1 ]; then medidas; whiptail --title "$TITULO" --yes-button "Sí" --no-button "No" --yesno "$1" 15 "$W"
  else local r; printf '%b [s/N]: ' "$1" >&2; read -r r || r=""; [[ "$r" =~ ^[sSyY] ]]; fi
}
menu() {        # menu "texto" etiqueta descripción [etiqueta descripción…] → etiqueta elegida
  local txt="$1"; shift
  if [ $UI = 1 ]; then medidas
    whiptail --title "$TITULO" --ok-button "Elegir" --cancel-button "Cancelar" --menu "$txt" "$H" "$W" "$L" "$@" 3>&1 1>&2 2>&3 || salir "Cancelado."
  else
    local -a tags=(); local i=1 n
    printf '\n%b\n' "$txt" >&2
    while [ $# -gt 1 ]; do tags+=("$1"); printf '  %3d) %s  %s\n' "$i" "$1" "$2" >&2; shift 2; i=$((i + 1)); done
    printf 'Elige un número: ' >&2; read -r n || salir "Cancelado."
    [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le ${#tags[@]} ] || salir "Opción no válida."
    printf '%s' "${tags[$((n - 1))]}"
  fi
}

# ------------------------------------------------------------------ 1. carpeta
MARCAS=(.git index.html package.json pyproject.toml requirements.txt Cargo.toml go.mod composer.json pom.xml build.gradle CMakeLists.txt '*.sln' '*.uproject' project.godot pubspec.yaml)
es_proyecto() { local m; for m in "${MARCAS[@]}"; do compgen -G "$1/$m" >/dev/null && return 0; done; return 1; }
repo_de_url() { sed -E 's#^(git@github\.com:|ssh://git@github\.com/|https://([^@/]+@)?github\.com/)##; s#/$##; s#\.git$##' <<<"$1"; }
es_github() { [[ "$1" =~ ^(git@github\.com:|ssh://git@github\.com/|https://([^@/]+@)?github\.com/) ]]; }

proyectos() {   # carpetas con pinta de proyecto bajo BASE_BUSQUEDA (sin repetir las que van dentro de otro)
  find "$BASE_BUSQUEDA" -mindepth 1 -maxdepth 5 \
    \( -name .git -printf '%h\n' -prune \) -o \
    \( \( -name '.*' -o -name node_modules -o -name vendor -o -name venv -o -name __pycache__ -o -name _sin_usar -o -name dist -o -name build \) -prune \) -o \
    \( -type f \( -name index.html -o -name package.json -o -name pyproject.toml -o -name requirements.txt -o -name Cargo.toml -o -name go.mod \
       -o -name composer.json -o -name pom.xml -o -name build.gradle -o -name CMakeLists.txt -o -name '*.sln' -o -name '*.uproject' \
       -o -name project.godot -o -name pubspec.yaml \) -printf '%h\n' \) 2>/dev/null |
  LC_ALL=C sort -u | awk -v base="$BASE_BUSQUEDA" '$0 == base { next } { for (i = 0; i < n; i++) if (index($0, r[i] "/") == 1) next; r[n++] = $0; print }' | head -100
}

navegar() {     # explorador de carpetas
  local dir="${1:-$HOME}" c s
  while true; do
    local -a it=("[USAR]" "✔ Usar esta carpeta" "[ARRIBA]" "⬆ Subir un nivel")
    while IFS= read -r s; do it+=("$s" "$(es_proyecto "$dir/$s" && echo '· proyecto' || true)"); done \
      < <(find "$dir" -mindepth 1 -maxdepth 1 -type d ! -name '.*' ! -name node_modules -printf '%f\n' 2>/dev/null | LC_ALL=C sort -f | head -300)
    c=$(menu "Carpeta actual:\n$dir" "${it[@]}")
    case "$c" in
      "[USAR]") printf '%s' "$dir"; return ;;
      "[ARRIBA]") dir=$(dirname "$dir") ;;
      *) dir="${dir%/}/$c" ;;
    esac
  done
}

elegir_carpeta() {
  local -a it=("[NAVEGAR]" "🔎 Buscar la carpeta navegando por el equipo…" "[RUTA]" "✎ Escribir la ruta a mano")
  local d r desc c
  info "Buscando proyectos en $BASE_BUSQUEDA…"
  while IFS= read -r d; do
    if [ -d "$d/.git" ]; then
      r=$(git -C "$d" config --get remote.origin.url 2>/dev/null || true)
      if [ -n "$r" ]; then desc="→ $(repo_de_url "$r")"; else desc="git, aún sin GitHub"; fi
    else desc="sin git"; fi
    it+=("${d#"$BASE_BUSQUEDA"/}" "$desc")
  done < <(proyectos)
  c=$(menu "¿Qué carpeta quieres subir a GitHub?\n(proyectos encontrados en $BASE_BUSQUEDA)" "${it[@]}")
  case "$c" in
    "[NAVEGAR]") DIR=$(navegar "$BASE_BUSQUEDA") ;;
    "[RUTA]") DIR=$(preguntar "Ruta de la carpeta:" "$HOME") ;;
    *) DIR="$BASE_BUSQUEDA/$c" ;;
  esac
}

# ------------------------------------------------------------------ 2. identidad: los commits salen a tu nombre
identidad() {
  local n e a
  n=$(git config --global user.name 2>/dev/null || true); e=$(git config --global user.email 2>/dev/null || true)
  if [ -n "$n" ] && [ -n "$e" ] && confirmar "Los commits se harán a tu nombre como:\n\n    $n <$e>\n\n¿Es correcto?"; then
    NOMBRE="$n"; EMAIL="$e"; return
  fi
  if [ -z "$n" ] || [ -z "$e" ]; then
    # sugerencia: la identidad que más se repite en tus otros repositorios de este equipo
    a=$(find "$HOME" -maxdepth 6 \( -name node_modules -o -name .cache -o -name .local -o -name .npm -o -name .cargo -o -name .rustup \) -prune \
          -o -type d -name .git -print 2>/dev/null | head -80 |
        while IFS= read -r r; do git -C "${r%/.git}" log -1 --format='%an|%ae' 2>/dev/null || true; done |
        grep -E '^[^|]+\|[^|@]+@[^|]+$' | grep -viE 'anthropic|claude' | sort | uniq -c | sort -rn | head -1 | sed -E 's/^ *[0-9]+ //' || true)
    [ -n "$n" ] || n=${a%%|*}; [ -n "$e" ] || e=${a##*|}
  fi
  n=$(preguntar "Tu nombre tal y como quieres que salga en tus commits:" "$n")
  e=$(preguntar "El email de tu cuenta de GitHub (así GitHub sabe que los commits son tuyos):" "$e")
  [ -n "$n" ] && [[ "$e" == ?*@?*.?* ]] || salir "Hacen falta tu nombre y un email válido."
  git config --global user.name "$n"; git config --global user.email "$e"
  NOMBRE="$n"; EMAIL="$e"
}
g() { git -c user.name="$NOMBRE" -c user.email="$EMAIL" "$@"; }   # git con tu identidad, pase lo que pase

# ------------------------------------------------------------------ 3. acceso a GitHub
instalar_gh() {
  info "Instalando GitHub CLI (puede pedirte tu contraseña de sudo)…"
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y gh
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y gh
  elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm github-cli
  elif command -v brew >/dev/null 2>&1; then brew install gh
  else false; fi || { aviso "No he podido instalar gh (se puede instalar a mano: https://cli.github.com)."; return 1; }
}
ssh_github() { ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 -T git@github.com 2>&1 || true; }
modo_ssh() {
  local key="$HOME/.ssh/id_ed25519" out
  if [ ! -f "$key" ]; then
    mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
    ssh-keygen -q -t ed25519 -C "$EMAIL" -f "$key" -N ""
    ok "Clave SSH creada en $key"
  fi
  out=$(ssh_github)
  if [[ "$out" != *"successfully authenticated"* ]]; then
    aviso "Añade esta clave pública en https://github.com/settings/ssh/new (título: $(hostname)) y pulsa «Add SSH key»:"
    printf '\n%s\n\n' "$(cat "$key.pub")"
    read -r -p "Pulsa Enter cuando la hayas guardado en GitHub… " _ || true
    out=$(ssh_github)
    [[ "$out" == *"successfully authenticated"* ]] || salir "GitHub todavía no acepta la clave:\n$out"
  fi
  MODO=ssh; GH_USUARIO=$(sed -n 's/^Hi \([^!]*\)!.*/\1/p' <<<"$out")
}
preparar_acceso() {
  if command -v gh >/dev/null 2>&1; then
    if ! gh auth status -h github.com >/dev/null 2>&1; then
      info "Inicia sesión en GitHub: se abrirá el navegador, o abre https://github.com/login/device y escribe el código que salga."
      gh auth login -h github.com -p https -w || salir "No se ha podido iniciar sesión en GitHub."
    fi
    gh auth setup-git -h github.com >/dev/null 2>&1 || true
    GH_USUARIO=$(gh api user -q .login 2>/dev/null) || salir "No puedo leer tu usuario de GitHub (prueba:  gh auth login)."
    MODO=gh; return
  fi
  # ¿ya hay una clave SSH que GitHub acepta?
  if compgen -G "$HOME/.ssh/id_*" >/dev/null; then
    local out; out=$(ssh_github)
    if [[ "$out" == *"successfully authenticated"* ]]; then MODO=ssh; GH_USUARIO=$(sed -n 's/^Hi \([^!]*\)!.*/\1/p' <<<"$out"); return; fi
  fi
  local c; c=$(menu "Para subir a GitHub hay que conectar este equipo con tu cuenta (solo la primera vez).\n¿Cómo prefieres hacerlo?" \
    gh "Instalar GitHub CLI y entrar con el navegador (recomendado)" \
    ssh "Crear una clave SSH y pegarla en GitHub")
  if [ "$c" = gh ] && instalar_gh; then preparar_acceso; return; fi
  modo_ssh
}

# ------------------------------------------------------------------ 4. repositorio
url_de() { if [ "$MODO" = gh ]; then printf 'https://github.com/%s.git' "$1"; else printf 'git@github.com:%s.git' "$1"; fi; }
crear_repo() {
  local nombre vis desc sugerido
  sugerido=${REPO_POR_DEFECTO:-$(basename "$DIR")}
  sugerido=$(tr ' ' '-' <<<"$sugerido" | iconv -f utf-8 -t ascii//TRANSLIT 2>/dev/null | tr -cd '[:alnum:]._-' || true)
  nombre=$(preguntar "Nombre del repositorio nuevo (sin espacios ni acentos):" "$sugerido")
  [[ "$nombre" =~ ^[A-Za-z0-9._-]+$ ]] || salir "Nombre no válido: usa letras sin acentos, números, guiones o puntos."
  vis=$(menu "¿Quién puede ver el repositorio?" \
    private "Privado: solo tú (y quien invites)" \
    public "Público: cualquiera (necesario para publicar una web gratis con GitHub Pages)")
  desc=$(preguntar "Descripción corta (opcional):" "")
  REPO="$GH_USUARIO/$nombre"
  if [ "$MODO" = gh ]; then
    local -a args=("$REPO" "--$vis"); [ -n "$desc" ] && args+=(--description "$desc")
    gh repo create "${args[@]}" >/dev/null || salir "No se ha podido crear el repositorio (¿ya existe uno con ese nombre?)."
    ok "Repositorio creado: https://github.com/$REPO"
  else
    aviso "Sin GitHub CLI no puedo crearlo yo. Créalo VACÍO (sin README) en https://github.com/new"
    aviso "con el nombre «$nombre» y visibilidad «$vis»."
    read -r -p "Pulsa Enter cuando esté creado… " _ || true
  fi
  URL=$(url_de "$REPO")
}
elegir_repo() {
  local actual c r v
  actual=$(git -C "$DIR" config --get remote.origin.url 2>/dev/null || true)
  if [ -n "$actual" ] && ! es_github "$actual"; then   # origin es de otro servidor: no se toca, GitHub va aparte
    REMOTO=github; actual=$(git -C "$DIR" config --get remote.github.url 2>/dev/null || true)
  fi
  local -a it=()
  [ -n "$actual" ] && it+=("[ACTUAL]" "Seguir con el de siempre: $(repo_de_url "$actual")")
  it+=("[NUEVO]" "➕ Crear un repositorio nuevo")
  if [ "$MODO" = gh ]; then
    while IFS=$'\t' read -r r v; do [ -n "$r" ] && it+=("$r" "$v"); done \
      < <(gh repo list "$GH_USUARIO" --limit 300 --json nameWithOwner,visibility -q '.[] | [.nameWithOwner, (.visibility | ascii_downcase)] | @tsv' 2>/dev/null || true)
  elif command -v curl >/dev/null 2>&1; then
    while IFS= read -r r; do [ -n "$r" ] && it+=("$r" "public"); done \
      < <(curl -fsS "https://api.github.com/users/$GH_USUARIO/repos?per_page=100&sort=updated" 2>/dev/null | grep -o '"full_name": *"[^"]*"' | cut -d'"' -f4 || true)
  fi
  it+=("[OTRO]" "✎ Escribir otro (usuario/repositorio)")
  c=$(menu "¿A qué repositorio de GitHub quieres subir\n$DIR ?" "${it[@]}")
  case "$c" in
    "[ACTUAL]") REPO=$(repo_de_url "$actual") ;;
    "[NUEVO]") crear_repo; return ;;
    "[OTRO]") REPO=$(preguntar "Repositorio (usuario/nombre):" "$GH_USUARIO/$(basename "$DIR")")
              [[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || salir "Escríbelo como usuario/nombre." ;;
    *) REPO="$c" ;;
  esac
  URL=$(url_de "$REPO")
}

# ------------------------------------------------------------------ 5. commit y subida
gitignore_basico() {
  cat > .gitignore <<'EOF'
# dependencias y entornos
node_modules/
venv/
.venv/
__pycache__/
*.pyc
# compilados y temporales
dist/
build/
*.log
*.tmp
# sistema, editores y Dropbox
.DS_Store
Thumbs.db
.vscode/
.idea/
.dropbox*
*conflicted copy*
*Copia en conflicto*
# secretos
.env
.env.*
# configuración local del asistente de IA
.claude/
CLAUDE.md
EOF
  ok "Creado un .gitignore básico (ábrelo si quieres dejar fuera algo más)."
}
subir() {
  cd "$DIR"
  [ -d .git ] || { git init -q -b main; ok "Git preparado en la carpeta."; }
  [ -f .gitignore ] || gitignore_basico
  # web estática: GitHub Pages la sirve tal cual, sin pasarla por Jekyll
  if [ -f index.html ] && [ ! -e _config.yml ] && [ ! -e .nojekyll ]; then : > .nojekyll; fi
  if git remote get-url "$REMOTO" >/dev/null 2>&1; then git remote set-url "$REMOTO" "$URL"; else git remote add "$REMOTO" "$URL"; fi

  # ¿existe el repositorio y tengo acceso? (y cuál es su rama principal)
  local remoto; remoto=$(GIT_TERMINAL_PROMPT=0 git ls-remote --symref "$REMOTO" HEAD 2>/dev/null) \
    || salir "No puedo entrar en https://github.com/$REPO: comprueba que existe y que tu cuenta tiene acceso."
  local rprin; rprin=$(awk '/^ref:/ { sub("refs/heads/", "", $2); print $2 }' <<<"$remoto")
  if [ -n "$rprin" ] && ! git rev-parse -q --verify HEAD >/dev/null; then git symbolic-ref HEAD "refs/heads/$rprin"; fi

  git add -A
  # ficheros del asistente de IA: fuera, si quieres (la subida es tuya)
  local claude; claude=$(git diff --cached --name-only | grep -E '(^|/)(\.claude/|CLAUDE\.md$|\.mcp\.json$)' || true)
  if [ -n "$claude" ] && confirmar "Hay ficheros de configuración de Claude (asistente de IA):\n\n$(head -6 <<<"$claude")\n\n¿Los dejo fuera del repositorio? (recomendado)"; then
    printf '\n# configuración local del asistente de IA\n.claude/\nCLAUDE.md\n.mcp.json\n' >> .gitignore
    while IFS= read -r f; do git rm -q --cached -- "$f"; done <<<"$claude"
    git add .gitignore
  fi
  # GitHub no acepta ficheros de 100 MB o más (y avisa a partir de 50 MB)
  local tam; tam=$(git diff --cached --name-only --diff-filter=d -z | xargs -0 -r stat -c '%s %n' 2>/dev/null || true)
  local enormes grandes
  enormes=$(awk '$1 >= 104857600 { sub(/^[0-9]+ /, ""); print }' <<<"$tam")
  grandes=$(awk '$1 >= 52428800 && $1 < 104857600 { sub(/^[0-9]+ /, ""); print }' <<<"$tam")
  if [ -n "$enormes" ]; then git reset -q; salir "Estos ficheros pasan de 100 MB y GitHub no los acepta. Añádelos a .gitignore (o usa Git LFS) y repite:\n$enormes"; fi
  [ -z "$grandes" ] || aviso "Ficheros de más de 50 MB (GitHub los acepta, pero avisa):\n$grandes"

  local n; n=$(git diff --cached --name-only | wc -l)
  if [ "$n" -gt 0 ]; then
    local def; def="Actualización $(date '+%d/%m/%Y %H:%M')"
    git rev-parse -q --verify HEAD >/dev/null || def="Primera versión"
    local cuantos="$n ficheros"; [ "$n" = 1 ] && cuantos="1 fichero"
    local msg; msg=$(preguntar "Describe el cambio (mensaje del commit, $cuantos):" "$def")
    g commit -q -m "${msg:-$def}"
    ok "Commit hecho a tu nombre: $(git log -1 --format='%h  %an <%ae>')"
  else
    info "No hay cambios nuevos desde el último commit."
  fi
  git rev-parse -q --verify HEAD >/dev/null || salir "La carpeta está vacía: no hay nada que subir."
  local rama; rama=$(git symbolic-ref --short HEAD 2>/dev/null) || salir "No estás en ninguna rama (detached HEAD): cambia a una rama y repite."

  # ¿GitHub tiene commits que aquí no están?
  local forzar=""
  info "Comprobando lo que ya hay en GitHub…"
  git fetch -q "$REMOTO" 2>/dev/null || true
  if git rev-parse -q --verify "refs/remotes/$REMOTO/$rama" >/dev/null && ! git merge-base --is-ancestor "$REMOTO/$rama" HEAD; then
    local c; c=$(menu "GitHub tiene cambios en «$rama» que no están en esta carpeta. ¿Qué hago?" \
      unir "Unirlos con los tuyos (si un fichero choca, gana el de esta carpeta)" \
      sustituir "Sustituir lo de GitHub por esta carpeta (lo de allí se pierde)" \
      cancelar "Cancelar sin subir nada")
    case "$c" in
      unir) g merge -q --no-edit -m "Unir los cambios de GitHub" --allow-unrelated-histories -X ours "$REMOTO/$rama" >/dev/null 2>&1 \
              || { git merge --abort 2>/dev/null || true; salir "No se han podido unir automáticamente. Resuélvelo en $DIR (git pull) y repite."; }
            ok "Cambios de GitHub unidos." ;;
      sustituir) confirmar "¿Seguro? Lo que hay en GitHub en la rama «$rama» se perderá." || salir "Cancelado."; forzar="--force-with-lease" ;;
      *) salir "Cancelado." ;;
    esac
  fi

  info "Subiendo a https://github.com/$REPO (rama $rama)…"
  git config http.postBuffer 524288000   # subidas grandes por HTTPS
  git push --progress -u ${forzar:+"$forzar"} "$REMOTO" "$rama" || salir "No se ha podido subir (mira el mensaje de git de arriba)."
  ok "Subido: https://github.com/$REPO"

  # webs estáticas: publicarlas gratis con GitHub Pages
  if [ "$MODO" = gh ] && [ -f index.html ]; then
    local web; web=$(gh api "repos/$REPO/pages" -q .html_url 2>/dev/null || true)
    if [ -n "$web" ]; then ok "Web publicada (se actualiza en 1-2 minutos): $web"
    elif confirmar "Esta carpeta es una web. ¿La publico con GitHub Pages para abrirla desde cualquier navegador?\n\n(Gratis en repositorios públicos. Tarda un par de minutos en estar lista.)"; then
      if gh api -X POST "repos/$REPO/pages" -f "source[branch]=$rama" -f "source[path]=/" >/dev/null 2>&1; then
        web=$(gh api "repos/$REPO/pages" -q .html_url 2>/dev/null || true)
        ok "Web publicada en: ${web:-https://github.com/$REPO/settings/pages}"
      else
        aviso "No he podido activar GitHub Pages (en cuentas gratuitas el repositorio tiene que ser público)."
        aviso "Puedes hacerlo en: https://github.com/$REPO/settings/pages"
      fi
    fi
  fi
}

# ------------------------------------------------------------------ programa
command -v git >/dev/null 2>&1 || salir "Falta git. Instálalo con:  sudo apt install git"
if [ -n "${1:-}" ]; then DIR="$1"; elif [ -n "$CARPETA_FIJA" ]; then DIR="$CARPETA_FIJA"; else elegir_carpeta; fi
DIR=$(cd "$DIR" 2>/dev/null && pwd -P) || salir "La carpeta no existe: $DIR"
top=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || true)
if [ -n "$top" ] && [ "$top" != "$DIR" ] && confirmar "Esta carpeta está dentro de otro repositorio git:\n$top\n\n¿Subo ese repositorio entero? (No = uno nuevo solo para esta carpeta)"; then DIR="$top"; fi
info "Carpeta: $DIR"
identidad
preparar_acceso
ok "Conectado a GitHub como: $GH_USUARIO"
elegir_repo
subir
