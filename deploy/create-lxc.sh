#!/bin/bash
#
# mbus2mqtt LXC container creation script (Alpine Linux)
# Run on the Proxmox host as root — requires NO git on the host.
#
# One-liner to download and run:
#   curl -fsSL https://raw.githubusercontent.com/hartwigm/mbus2mqtt/main/deploy/create-lxc.sh | bash -s -- 200 M47 vmbr0
#
# Usage: bash create-lxc.sh [CTID] [PROPERTY_NAME] [BRIDGE]
# Example: bash create-lxc.sh 200 M47 vmbr1
#
set -e

CTID="${1:-200}"
PROPERTY="${2:-M47}"
BRIDGE="${3:-vmbr0}"
HOSTNAME="mbus2mqtt-${PROPERTY,,}"
STORAGE="${STORAGE:-local-lvm}"
MEMORY=512
SWAP=256
DISK=2
CORES=1
PASSWORD="mbus2mqtt"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== mbus2mqtt LXC installer (Alpine) ===${NC}"
echo "  CTID:     $CTID"
echo "  Property: $PROPERTY"
echo "  Bridge:   $BRIDGE"
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

# Detect USB serial adapters on host
echo "Scanning for USB serial adapters on host..."
USB_DEVICES=()
if [ -d /dev/serial/by-id ]; then
  for dev in /dev/serial/by-id/*; do
    [ -e "$dev" ] || continue
    REAL_DEV=$(readlink -f "$dev")
    DEV_NAME=$(basename "$dev")
    echo "  Found: $DEV_NAME → $REAL_DEV"
    USB_DEVICES+=("$REAL_DEV")
  done
fi

if [ ${#USB_DEVICES[@]} -eq 0 ]; then
  echo -e "${RED}  Warning: No USB serial adapters found on host!${NC}"
  echo "  Plug in M-Bus adapter and re-run, or manually add to /etc/pve/lxc/${CTID}.conf"
fi

# USB serial passthrough
echo "Configuring USB passthrough..."
LXC_CONF="/etc/pve/lxc/${CTID}.conf"

cat >> "$LXC_CONF" << 'USBEOF'

# USB serial passthrough for M-Bus adapters (major 188 = ttyUSB)
lxc.cgroup2.devices.allow: c 188:* rwm
lxc.mount.entry: /dev/serial dev/serial none bind,optional,create=dir
USBEOF

# Add mount entries for each detected device
for dev in "${USB_DEVICES[@]}"; do
  DEV_SHORT="${dev#/dev/}"
  echo "lxc.mount.entry: $dev dev/$DEV_SHORT none bind,optional,create=file" >> "$LXC_CONF"
  echo "  Passthrough: $dev"
done

# Udev rule on host for permissions (FTDI, Prolific, CH340)
UDEV_RULE="/etc/udev/rules.d/99-mbus-usb.rules"
if [ ! -f "$UDEV_RULE" ]; then
  cat > "$UDEV_RULE" << 'UDEVEOF'
# FTDI FT232R
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", MODE="0666"
# Prolific PL2303
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="2303", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="23a3", MODE="0666"
# CH340
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", MODE="0666"
UDEVEOF
  udevadm control --reload-rules
  echo "  Created udev rules for USB serial adapters"
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

  # Timezone
  apk add -q tzdata
  cp /usr/share/zoneinfo/Europe/Berlin /etc/localtime
  echo "Europe/Berlin" > /etc/timezone
  apk del -q tzdata

  # Runtime dependencies (stay installed)
  apk add -q nodejs npm nano

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
'

# Set property name in config (preserving case from command line)
pct exec "$CTID" -- sed -i "s/^property:.*/property: \"${PROPERTY}\"/" /etc/mbus2mqtt/config.yaml
pct exec "$CTID" -- sed -i "s/mbus2mqtt-M47/mbus2mqtt-${PROPERTY}/" /etc/mbus2mqtt/config.yaml

pct exec "$CTID" -- sh -c '

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

  # CLI alias so "mbus2mqtt" works directly
  cat > /etc/profile.d/mbus2mqtt.sh << '\''ALIASEOF'\''
alias m2q="node /opt/mbus2mqtt/dist/index.js -c /etc/mbus2mqtt/config.yaml"
ALIASEOF

  # Login banner
  cat > /etc/motd << '\''MOTDEOF'\''
  ┌──────────────────────────────────────────────────┐
  │  mbus2mqtt - M-Bus to MQTT Gateway              │
  ├──────────────────────────────────────────────────┤
  │                                                  │
  │  m2q setup           Detect USB adapters          │
  │  m2q scan            Scan ports for meters       │
  │  m2q list            Show meters & values        │
  │  m2q read <id>       Read single meter           │
  │  m2q run             Start daemon                │
  │  m2q update          Update from GitHub          │
  │                                                  │
  │  rc-service mbus2mqtt start|stop|status          │
  │  tail -f /var/log/mbus2mqtt.log                  │
  │  nano /etc/mbus2mqtt/config.yaml                 │
  │                                                  │
  └──────────────────────────────────────────────────┘
MOTDEOF

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
echo "  USB:       ${#USB_DEVICES[@]} serial adapter(s) passed through"
echo ""
echo "  Login:     pct enter $CTID"
echo "  Then type: m2q setup"
