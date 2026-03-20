#!/bin/bash
#
# mbus2mqtt LXC container creation script (Alpine Linux)
# Run on the Proxmox host as root — requires NO git on the host.
#
# One-liner to download and run:
#   curl -fsSL https://raw.githubusercontent.com/hartwigm/mbus2mqtt/main/deploy/create-lxc.sh | bash -s -- 200 M47
#
# Usage: bash create-lxc.sh [CTID] [PROPERTY_NAME]
#
set -e

CTID="${1:-200}"
PROPERTY="${2:-M47}"
HOSTNAME="mbus2mqtt-${PROPERTY,,}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
MEMORY=256
SWAP=128
DISK=2
CORES=1
PASSWORD="mbus2mqtt"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== mbus2mqtt LXC installer (Alpine) ===${NC}"
echo "  CTID:     $CTID"
echo "  Property: $PROPERTY"
echo ""

# Verify we're on Proxmox
if ! command -v pct &>/dev/null; then
  echo -e "${RED}Error: pct not found. This script must run on a Proxmox host.${NC}"
  exit 1
fi

# Download Alpine template if missing
TEMPLATE=$(pveam list local 2>/dev/null | grep -o 'local:vztmpl/alpine-3[^ ]*' | sort -V | tail -1)
if [ -z "$TEMPLATE" ]; then
  echo "Downloading Alpine template..."
  pveam update
  LATEST=$(pveam available | grep 'alpine-3' | tail -1 | awk '{print $2}')
  pveam download local "$LATEST"
  TEMPLATE="local:vztmpl/$LATEST"
fi
echo "  Template: $TEMPLATE"

# Abort if CTID already exists
if pct status "$CTID" &>/dev/null; then
  echo -e "${RED}Error: Container $CTID already exists.${NC}"
  exit 1
fi

# Create container
echo "Creating container..."
pct create "$CTID" "$TEMPLATE" \
  --hostname "$HOSTNAME" \
  --memory "$MEMORY" \
  --swap "$SWAP" \
  --cores "$CORES" \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
  --ostype alpine \
  --unprivileged 0 \
  --features nesting=1 \
  --password "$PASSWORD" \
  --start 0

# USB serial passthrough
echo "Configuring USB passthrough..."
LXC_CONF="/etc/pve/lxc/${CTID}.conf"

cat >> "$LXC_CONF" << 'USBEOF'

# USB serial passthrough for M-Bus adapters (major 188 = ttyUSB)
lxc.cgroup2.devices.allow: c 188:* rwm
lxc.mount.entry: /dev/ttyUSB0 dev/ttyUSB0 none bind,optional,create=file
lxc.mount.entry: /dev/ttyUSB1 dev/ttyUSB1 none bind,optional,create=file
lxc.mount.entry: /dev/serial dev/serial none bind,optional,create=dir
USBEOF

# Udev rule on host for permissions
UDEV_RULE="/etc/udev/rules.d/99-mbus-usb.rules"
if [ ! -f "$UDEV_RULE" ]; then
  cat > "$UDEV_RULE" << 'UDEVEOF'
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", MODE="0666"
UDEVEOF
  udevadm control --reload-rules
  echo "  Created udev rule for FTDI devices"
fi

# Start container
echo "Starting container..."
pct start "$CTID"
sleep 5

# Everything below runs INSIDE the container — host stays clean
echo "Setting up inside container..."
pct exec "$CTID" -- sh -c '
  set -e

  apk update -q && apk upgrade -q

  # Runtime dependencies (stay installed)
  apk add -q nodejs npm

  # Build dependencies (removed after build)
  apk add -q --virtual .build-deps git python3 make g++ linux-headers

  # Clone and build
  git clone -q https://github.com/hartwigm/mbus2mqtt.git /opt/mbus2mqtt
  cd /opt/mbus2mqtt
  npm install --loglevel=warn
  npm run build

  # Config and state dirs
  mkdir -p /etc/mbus2mqtt /var/lib/mbus2mqtt
  cp config/config.example.yaml /etc/mbus2mqtt/config.yaml

  # OpenRC service
  cat > /etc/init.d/mbus2mqtt << '\''INITEOF'\''
#!/sbin/openrc-run

name="mbus2mqtt"
description="M-Bus to MQTT Gateway"
command="/usr/bin/node"
command_args="/opt/mbus2mqtt/dist/index.js run -c /etc/mbus2mqtt/config.yaml"
command_background=true
pidfile="/run/${RC_SVCNAME}.pid"
output_log="/var/log/mbus2mqtt.log"
error_log="/var/log/mbus2mqtt.err"

depend() {
    need net
    after firewall
}
INITEOF

  chmod +x /etc/init.d/mbus2mqtt
  rc-update add mbus2mqtt default

  # Remove build tools — only node + npm + compiled node-mbus remain
  apk del -q .build-deps
  rm -rf /opt/mbus2mqtt/.git /root/.npm /tmp/*
'

sleep 2
CTIP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | tr -d ' ')

echo ""
echo -e "${GREEN}=== mbus2mqtt ready ===${NC}"
echo ""
echo "  Container: $CTID ($HOSTNAME)"
echo "  IP:        $CTIP"
echo "  OS:        Alpine Linux (~${MEMORY}MB RAM, ${DISK}GB disk)"
echo ""
echo "  Configure:"
echo "    pct exec $CTID -- vi /etc/mbus2mqtt/config.yaml"
echo ""
echo "  Test:"
echo "    pct exec $CTID -- node /opt/mbus2mqtt/dist/index.js scan -c /etc/mbus2mqtt/config.yaml"
echo ""
echo "  Start:"
echo "    pct exec $CTID -- rc-service mbus2mqtt start"
echo ""
echo "  Logs:"
echo "    pct exec $CTID -- tail -f /var/log/mbus2mqtt.log"
