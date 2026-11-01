#!/usr/bin/env bash
# Instala o actualiza GastosbyATH en un contenedor LXC de Proxmox (Debian 12/13 o Ubuntu 22.04+).
# Ejecutar como root DENTRO del contenedor, desde la carpeta del proyecto:
#   bash deploy/install.sh
# Variables opcionales, solo la primera vez: PORT (8080), APP_DIR (/opt/gastosbyath), DATA_DIR (/var/lib/gastosbyath),
# TZ (Europe/Madrid). Quedan guardadas en /etc/gastosbyath.env; después se cambian ahí y las actualizaciones las respetan.
set -euo pipefail

CONF=/etc/gastosbyath.env
SERVICE=/etc/systemd/system/gastosbyath.service
# Ajuste guardado: el de /etc/gastosbyath.env o, en instalaciones de antes de ese archivo, el que había en el servicio.
saved() {
  if [ -f "$CONF" ]; then sed -n "s/^$1=//p" "$CONF" | tail -1
  elif [ -f "$SERVICE" ]; then
    if [ "$1" = APP_DIR ]; then sed -n 's/^WorkingDirectory=//p' "$SERVICE" | tail -1; else sed -n "s/^Environment=$1=//p" "$SERVICE" | tail -1; fi
  fi
  return 0
}
if [ -f "$CONF" ]; then
  PORT="$(saved PORT)"; APP_DIR="$(saved APP_DIR)"; DATA_DIR="$(saved DATA_DIR)"; TZ_NAME="$(saved TZ)"
else
  PORT="${PORT:-$(saved PORT)}"; APP_DIR="${APP_DIR:-$(saved APP_DIR)}"; DATA_DIR="${DATA_DIR:-$(saved DATA_DIR)}"; TZ_NAME="${TZ:-$(saved TZ)}"
fi
PORT="${PORT:-8080}"
APP_DIR="${APP_DIR:-/opt/gastosbyath}"
DATA_DIR="${DATA_DIR:-/var/lib/gastosbyath}"
TZ_NAME="${TZ_NAME:-Europe/Madrid}"
REGISTRATION="$(saved ALLOW_REGISTRATION)"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Ejecuta este script como root (sudo bash deploy/install.sh)"; exit 1; }

say "Instalando dependencias del sistema"
export DEBIAN_FRONTEND=noninteractive
# Sin salida a internet por IPv6 (lo normal en casa), apt intenta IPv6 primero y falla: que use solo IPv4.
if ! ip -6 route show default 2>/dev/null | grep -q .; then
  echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99gastosbyath-ipv4
fi
apt-get update -qq
apt-get install -y -qq curl ca-certificates rsync tar python3 make g++ >/dev/null

# Node.js 20 o superior (better-sqlite3 trae binarios precompilados para estas versiones).
NODE_MAJOR=0
command -v node >/dev/null && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "Instalando Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
# El Node.js de Debian viene sin npm (el de NodeSource ya lo trae).
if ! command -v npm >/dev/null; then
  say "Instalando npm"
  apt-get install -y -qq npm >/dev/null
fi
command -v node >/dev/null && command -v npm >/dev/null \
  || { echo "No se ha podido instalar Node.js y npm. Revisa la conexión a internet y vuelve a ejecutar este script."; exit 1; }
echo "Node.js $(node -v), npm $(npm -v)"

say "Creando usuario y carpetas"
id gastosbyath >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin gastosbyath
mkdir -p "$APP_DIR" "$DATA_DIR/uploads" "$DATA_DIR/backups"

# Si ya estaba instalada, copia de seguridad antes de cambiar nada: la versión nueva puede actualizar la base de datos.
if [ -f "$DATA_DIR/gastosbyath.db" ] && [ -d "$APP_DIR/node_modules" ]; then
  say "Copia de seguridad antes de actualizar"
  runuser -u gastosbyath -- env DATA_DIR="$DATA_DIR" node "$APP_DIR/scripts/backup.js" "$DATA_DIR/backups" 30
fi

say "Copiando la aplicación a $APP_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude .git --exclude tests "$SRC_DIR/" "$APP_DIR/"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R gastosbyath:gastosbyath "$DATA_DIR"
chown -R root:root "$APP_DIR"

if [ ! -f "$CONF" ]; then
  say "Guardando los ajustes en $CONF"
  cat > "$CONF" <<ENV
# Ajustes de GastosbyATH. Las actualizaciones no tocan este archivo.
# Después de cambiar algo:  bash $SRC_DIR/deploy/actualizar.sh --forzar   (o vuelve a ejecutar install.sh)
PORT=$PORT
DATA_DIR=$DATA_DIR
APP_DIR=$APP_DIR
TZ=$TZ_NAME
# Ponlo a false cuando toda la familia tenga cuenta (los códigos de invitación siguen funcionando).
ALLOW_REGISTRATION=${REGISTRATION:-true}
# Otros ajustes posibles (quita la # para usarlos):
#PUSH_HOUR=9
#VAPID_SUBJECT=mailto:tu@correo
ENV
  chmod 644 "$CONF"
fi

say "Configurando el servicio systemd"
cat > "$SERVICE" <<UNIT
[Unit]
Description=GastosbyATH - gastos del hogar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gastosbyath
Group=gastosbyath
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/server.js
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
# Puerto, carpeta de datos, zona horaria, registro abierto…: en $CONF
EnvironmentFile=$CONF
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/gastosbyath-backup.service <<UNIT
[Unit]
Description=Copia de seguridad de GastosbyATH

[Service]
Type=oneshot
User=gastosbyath
Environment=DATA_DIR=$DATA_DIR
ExecStart=$(command -v node) $APP_DIR/scripts/backup.js $DATA_DIR/backups 30
UNIT

cat > /etc/systemd/system/gastosbyath-backup.timer <<UNIT
[Unit]
Description=Copia de seguridad diaria de GastosbyATH

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now gastosbyath.service gastosbyath-backup.timer >/dev/null
systemctl restart gastosbyath.service
# La primera vez (o tras actualizar la base de datos) puede tardar unos segundos en arrancar.
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  say "GastosbyATH está funcionando en el puerto $PORT"
else
  echo "El servicio no responde. Revisa: journalctl -u gastosbyath -n 50"
  exit 1
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<INFO

  Abre en el navegador:   http://$IP:$PORT
  La primera cuenta que crees será la administradora.

  Acceso con Tailscale (recomendado, da HTTPS y permite notificaciones en el móvil):
    curl -fsSL https://tailscale.com/install.sh | sh
    tailscale up
    tailscale serve --bg $PORT
  y entra desde cualquier dispositivo de tu tailnet en https://<nombre-del-contenedor>.<tu-tailnet>.ts.net

  Útil:
    systemctl status gastosbyath           estado del servicio
    journalctl -u gastosbyath -f           registro en directo
    runuser -u gastosbyath -- env DATA_DIR=$DATA_DIR node $APP_DIR/scripts/reset-password.js <usuario>   contraseña olvidada
    nano $CONF                       ajustes (puerto, registro abierto…)
    Copias diarias en $DATA_DIR/backups (30 días de base de datos; cada foto se copia una sola vez)

  Para actualizar (los datos no se tocan):
    instalado desde GitHub:  bash $SRC_DIR/deploy/actualizar.sh
    copiado a mano:          copia la nueva versión y vuelve a ejecutar este script
INFO
