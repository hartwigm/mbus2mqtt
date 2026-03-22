#!/bin/bash
#
# mbus2mqtt Raspberry Pi setup script
# Run on a fresh Raspberry Pi OS Lite (Bookworm)
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/hartwigm/mbus2mqtt/main/deploy/rpi/setup-rpi.sh | sudo bash
#
# Usage: sudo bash setup-rpi.sh [PROPERTY_NAME]
# Example: sudo bash setup-rpi.sh M47
#
set -e

PROPERTY="${1:-M47}"
INSTALL_DIR="/opt/mbus2mqtt"
CONFIG_DIR="/etc/mbus2mqtt"
STATE_DIR="/var/lib/mbus2mqtt"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

if [ "$(id -u)" -ne 0 ]; then
  echo -e "${RED}Error: Run as root (sudo)${NC}"
  exit 1
fi

echo -e "${GREEN}=== mbus2mqtt Raspberry Pi Setup ===${NC}"
echo "  Property: $PROPERTY"
echo ""

# Node.js — detect architecture and install accordingly
echo "Installing Node.js..."
ARCH=$(dpkg --print-architecture)
if ! command -v node &>/dev/null || [ "$(node --version | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  if [ "$ARCH" = "armhf" ]; then
    # NodeSource doesn't support armhf — use official Node.js armv7l binary
    NODE_VER="v22.14.0"
    echo "  Architecture: armhf — installing Node.js $NODE_VER from nodejs.org..."
    curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-armv7l.tar.xz" -o /tmp/node.tar.xz
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
    rm -f /tmp/node.tar.xz
  else
    # amd64/arm64 — use NodeSource
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
fi
echo "  Node.js $(node --version) ($(node -p process.arch))"

# Build dependencies
echo "Installing build dependencies..."
apt-get install -y git python3 make g++

# Clone and build
echo "Cloning mbus2mqtt..."
rm -rf "$INSTALL_DIR"
git clone --depth 1 https://github.com/hartwigm/mbus2mqtt.git "$INSTALL_DIR"
cd "$INSTALL_DIR"
echo "Installing dependencies..."
npm install --loglevel=warn
echo "Building..."
npm run build

# Config
mkdir -p "$CONFIG_DIR" "$STATE_DIR"
if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
  cp config/config.example.yaml "$CONFIG_DIR/config.yaml"
  sed -i "s/^property:.*/property: \"${PROPERTY}\"/" "$CONFIG_DIR/config.yaml"
  sed -i "s/mbus2mqtt-M47/mbus2mqtt-${PROPERTY}/" "$CONFIG_DIR/config.yaml"
fi

# systemd service
cp deploy/mbus2mqtt.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable mbus2mqtt

# CLI alias
cat > /etc/profile.d/mbus2mqtt.sh << 'EOF'
alias m2q="node /opt/mbus2mqtt/dist/index.js -c /etc/mbus2mqtt/config.yaml"
EOF

# udev rules for USB serial adapters
cat > /etc/udev/rules.d/99-mbus-usb.rules << 'EOF'
# FTDI FT232R
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", MODE="0666"
# Prolific PL2303
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="2303", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="23a3", MODE="0666"
# CH340
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", MODE="0666"
EOF
udevadm control --reload-rules

# Login banner
cat > /etc/motd << 'EOF'
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
EOF

# Hostname
hostnamectl set-hostname "mbus2mqtt-${PROPERTY,,}" 2>/dev/null || true

# Timezone
timedatectl set-timezone Europe/Berlin 2>/dev/null || true

# Clean up build tools
echo "Cleaning up..."
rm -rf "$INSTALL_DIR/.git" "$INSTALL_DIR/src" "$INSTALL_DIR/tsconfig.json"
rm -rf /root/.npm /tmp/npm-*
apt-get purge -y git python3 make g++
apt-get autoremove -y
apt-get clean

echo ""
echo -e "${GREEN}=== mbus2mqtt installed ===${NC}"
echo ""
echo "  Nächste Schritte:"
echo "  1. USB-Adapter anschließen"
echo "  2. source /etc/profile.d/mbus2mqtt.sh"
echo "  3. m2q setup"
echo "  4. sudo nano /etc/mbus2mqtt/config.yaml"
echo "  5. sudo systemctl start mbus2mqtt"
echo ""
echo "  Oder neu einloggen für m2q alias."
