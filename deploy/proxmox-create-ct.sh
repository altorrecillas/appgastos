#!/usr/bin/env bash
# Crea un contenedor LXC en Proxmox preparado para GastosbyATH + Tailscale e instala la aplicación.
# Ejecutar como root EN EL HOST PROXMOX, desde la carpeta del proyecto:
#   bash deploy/proxmox-create-ct.sh
# Variables opcionales: CTID, CT_NAME, STORAGE, BRIDGE, MEMORY, DISK, PASSWORD
set -euo pipefail

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
CT_NAME="${CT_NAME:-gastosbyath}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
MEMORY="${MEMORY:-1024}"
DISK="${DISK:-8}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v pct >/dev/null || { echo "Este script se ejecuta en el host Proxmox (falta pct)."; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Ejecuta como root."; exit 1; }

echo "==> Buscando plantilla Debian 12"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort | tail -1)"
[ -n "$TEMPLATE" ] || { echo "No encuentro la plantilla debian-12-standard"; exit 1; }
pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE" || pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"

echo "==> Creando el contenedor $CTID ($CT_NAME)"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_NAME" --memory "$MEMORY" --cores 2 --rootfs "$STORAGE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" --unprivileged 1 --features nesting=1 \
  --onboot 1 --timezone host ${PASSWORD:+--password "$PASSWORD"}

# Tailscale necesita /dev/net/tun dentro del contenedor.
cat >> "/etc/pve/lxc/$CTID.conf" <<CONF
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
CONF

pct start "$CTID"
echo "==> Esperando a que arranque la red"
for _ in $(seq 1 30); do pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break; sleep 2; done

echo "==> Copiando GastosbyATH al contenedor"
TMP="$(mktemp -d)"
tar -C "$SRC_DIR" --exclude node_modules --exclude data --exclude .git --exclude tests -czf "$TMP/gastosbyath.tgz" .
pct exec "$CTID" -- mkdir -p /root/gastosbyath-src
pct push "$CTID" "$TMP/gastosbyath.tgz" /root/gastosbyath.tgz
pct exec "$CTID" -- tar -xzf /root/gastosbyath.tgz -C /root/gastosbyath-src
rm -rf "$TMP"

echo "==> Instalando"
pct exec "$CTID" -- bash /root/gastosbyath-src/deploy/install.sh

cat <<INFO

Listo. Para el acceso por Tailscale entra en el contenedor y ejecuta:
  pct enter $CTID
  curl -fsSL https://tailscale.com/install.sh | sh
  tailscale up
  tailscale serve --bg 8080
INFO
