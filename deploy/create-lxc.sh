#!/bin/bash
#
# mbus2mqtt LXC container creation script (Alpine Linux)
# Run on the Proxmox host as root
#
# Usage: ./create-lxc.sh [CTID] [PROPERTY_NAME]
# Example: ./create-lxc.sh 200 M47
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
NC='\033[0m'

echo -e "${GREEN}=== Creating mbus2mqtt LXC (Alpine) ===${NC}"
echo "  CTID:     $CTID"
echo "  Hostname: $HOSTNAME"
echo "  Property: $PROPERTY"
echo ""

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

# USB passthrough
echo "Configuring USB passthrough..."
LXC_CONF="/etc/pve/lxc/${CTID}.conf"

cat >> "$LXC_CONF" << 'USBEOF'

# USB serial passthrough for M-Bus adapters
lxc.cgroup2.devices.allow: c 188:* rwm
lxc.mount.entry: /dev/ttyUSB0 dev/ttyUSB0 none bind,optional,create=file
lxc.mount.entry: /dev/ttyUSB1 dev/ttyUSB1 none bind,optional,create=file
lxc.mount.entry: /dev/serial dev/serial none bind,optional,create=dir
USBEOF

# Udev rule on host
UDEV_RULE="/etc/udev/rules.d/99-mbus-usb.rules"
if [ ! -f "$UDEV_RULE" ]; then
  cat > "$UDEV_RULE" << 'UDEVEOF'
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", MODE="0666"
UDEVEOF
  udevadm control --reload-rules
fi

# Start container
echo "Starting container..."
pct start "$CTID"
sleep 5

# Setup inside Alpine container
echo "Running setup inside container..."
pct exec "$CTID" -- sh -c "
  echo '=== Updating Alpine ==='
  apk update && apk upgrade

  echo '=== Installing dependencies ==='
  apk add nodejs npm git python3 make g++ linux-headers

  echo '=== Cloning mbus2mqtt ==='
  git clone https://github.com/hartwigm/mbus2mqtt.git /opt/mbus2mqtt
  cd /opt/mbus2mqtt
  npm install
  npm run build

  echo '=== Setting up directories ==='
  mkdir -p /etc/mbus2mqtt /var/lib/mbus2mqtt
  cp config/config.example.yaml /etc/mbus2mqtt/config.yaml

  echo '=== Creating OpenRC service ==='
  cat > /etc/init.d/mbus2mqtt << 'INITEOF'
#!/sbin/openrc-run

name=\"mbus2mqtt\"
description=\"M-Bus to MQTT Gateway\"
command=\"/usr/bin/node\"
command_args=\"/opt/mbus2mqtt/dist/index.js run -c /etc/mbus2mqtt/config.yaml\"
command_background=true
pidfile=\"/run/\${RC_SVCNAME}.pid\"
output_log=\"/var/log/mbus2mqtt.log\"
error_log=\"/var/log/mbus2mqtt.err\"

depend() {
    need net
    after firewall
}
INITEOF

  chmod +x /etc/init.d/mbus2mqtt
  rc-update add mbus2mqtt default

  echo '=== Cleanup build dependencies ==='
  apk del make g++ linux-headers python3
  rm -rf /root/.npm /tmp/*

  echo '=== Done ==='
"

sleep 2
CTIP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | tr -d ' ')

echo ""
echo -e "${GREEN}=== LXC container ready ===${NC}"
echo ""
echo "  Container: $CTID ($HOSTNAME)"
echo "  IP:        $CTIP"
echo "  OS:        Alpine Linux"
echo "  RAM:       ${MEMORY}MB"
echo "  Disk:      ${DISK}GB"
echo ""
echo "  Next steps:"
echo "  1. Edit config:"
echo "     pct exec $CTID -- vi /etc/mbus2mqtt/config.yaml"
echo ""
echo "  2. Test read:"
echo "     pct exec $CTID -- node /opt/mbus2mqtt/dist/index.js read -c /etc/mbus2mqtt/config.yaml <DEVICE_ID>"
echo ""
echo "  3. Start service:"
echo "     pct exec $CTID -- rc-service mbus2mqtt start"
echo ""
echo "  4. Check logs:"
echo "     pct exec $CTID -- tail -f /var/log/mbus2mqtt.log"
