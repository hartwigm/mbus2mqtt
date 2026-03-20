#!/bin/bash
set -e

INSTALL_DIR="/opt/mbus2mqtt"
CONFIG_DIR="/etc/mbus2mqtt"
STATE_DIR="/var/lib/mbus2mqtt"

echo "=== Installing mbus2mqtt ==="

# Create directories
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR"

# Copy application
cp -r dist/ package.json "$INSTALL_DIR/"

# Install production dependencies
cd "$INSTALL_DIR"
npm install --omit=dev

# Copy example config if none exists
if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
  cp config/config.example.yaml "$CONFIG_DIR/config.yaml"
  echo "Created $CONFIG_DIR/config.yaml - please edit before starting!"
fi

# Install systemd service
cp deploy/mbus2mqtt.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable mbus2mqtt

echo ""
echo "=== Installation complete ==="
echo "1. Edit config:    nano $CONFIG_DIR/config.yaml"
echo "2. Start service:  systemctl start mbus2mqtt"
echo "3. Check logs:     journalctl -u mbus2mqtt -f"
echo "4. CLI usage:      node $INSTALL_DIR/dist/index.js --help"
