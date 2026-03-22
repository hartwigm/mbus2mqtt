#!/bin/bash -e
#
# mbus2mqtt installation inside pi-gen chroot
#

on_chroot << 'CHEOF'
set -e

INSTALL_DIR="/opt/mbus2mqtt"
CONFIG_DIR="/etc/mbus2mqtt"
STATE_DIR="/var/lib/mbus2mqtt"

echo "=== Installing mbus2mqtt ==="

# Node.js — official binary for armhf (NodeSource doesn't support armhf)
NODE_VER="v22.14.0"
curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-armv7l.tar.xz" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
rm -f /tmp/node.tar.xz

# Clone and build
git clone --depth 1 https://github.com/hartwigm/mbus2mqtt.git "$INSTALL_DIR"
cd "$INSTALL_DIR"
npm install --loglevel=warn
npm run build

# Config and state directories
mkdir -p "$CONFIG_DIR" "$STATE_DIR"
cp config/config.example.yaml "$CONFIG_DIR/config.yaml"

# systemd service
cp deploy/mbus2mqtt.service /etc/systemd/system/
systemctl enable mbus2mqtt

# CLI alias
cat > /etc/profile.d/mbus2mqtt.sh << 'ALIASEOF'
alias m2q="node /opt/mbus2mqtt/dist/index.js -c /etc/mbus2mqtt/config.yaml"
ALIASEOF

# udev rule for USB serial adapters (FTDI + Prolific + CH340)
cat > /etc/udev/rules.d/99-mbus-usb.rules << 'UDEVEOF'
# FTDI FT232R
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", MODE="0666"
# Prolific PL2303
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="2303", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="23a3", MODE="0666"
# CH340
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", MODE="0666"
UDEVEOF

# Login banner
cat > /etc/motd << 'MOTDEOF'
  ┌──────────────────────────────────────────────────┐
  │  mbus2mqtt - M-Bus to MQTT Gateway (Raspberry Pi)│
  ├──────────────────────────────────────────────────┤
  │                                                  │
  │  m2q setup           Detect USB adapters         │
  │  m2q scan            Scan ports for meters       │
  │  m2q scan -e         Extended scan (all bauds)   │
  │  m2q list            Show meters & values        │
  │  m2q read <id>       Read single meter           │
  │  m2q run             Start daemon                │
  │  m2q update          Update from GitHub          │
  │                                                  │
  │  sudo systemctl start|stop|status mbus2mqtt      │
  │  journalctl -u mbus2mqtt -f                      │
  │  sudo nano /etc/mbus2mqtt/config.yaml            │
  │                                                  │
  └──────────────────────────────────────────────────┘
MOTDEOF

# Clean up build artifacts
rm -rf "$INSTALL_DIR/.git" "$INSTALL_DIR/src" "$INSTALL_DIR/tsconfig.json"
rm -rf /root/.npm /tmp/*
apt-get purge -y git python3 make g++
apt-get autoremove -y
apt-get clean

echo "=== mbus2mqtt installed ==="
CHEOF
