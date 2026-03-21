#!/bin/sh
#
# mbus2mqtt update script (Alpine LXC)
# Downloads latest release from GitHub, rebuilds, and restarts the service.
#
# Usage: sh /opt/mbus2mqtt/deploy/update.sh
#
set -e

INSTALL_DIR="/opt/mbus2mqtt"
REPO_URL="https://github.com/hartwigm/mbus2mqtt"
BRANCH="main"
TARBALL_URL="${REPO_URL}/archive/refs/heads/${BRANCH}.tar.gz"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== mbus2mqtt update ===${NC}"

# Check current version
OLD_COMMIT=""
if [ -f "$INSTALL_DIR/.version" ]; then
  OLD_COMMIT=$(cat "$INSTALL_DIR/.version")
  echo "  Current: $OLD_COMMIT"
fi

# Download latest source
echo "Downloading latest from $BRANCH..."
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

wget -qO "$TMP_DIR/source.tar.gz" "$TARBALL_URL"
tar -xzf "$TMP_DIR/source.tar.gz" -C "$TMP_DIR"
SRC_DIR="$TMP_DIR/mbus2mqtt-${BRANCH}"

# Install build dependencies if needed
BUILD_DEPS_INSTALLED=false
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}Error: Node.js not installed${NC}"
  exit 1
fi

if ! command -v make >/dev/null 2>&1; then
  echo "Installing build dependencies..."
  apk add -q --virtual .build-deps python3 make g++ linux-headers
  BUILD_DEPS_INSTALLED=true
fi

# Stop service before updating
echo "Stopping service..."
rc-service mbus2mqtt stop 2>/dev/null || true

# Update source files (preserve config and state)
echo "Updating files..."
cp -r "$SRC_DIR/src" "$INSTALL_DIR/"
cp -r "$SRC_DIR/deploy" "$INSTALL_DIR/"
cp -r "$SRC_DIR/config" "$INSTALL_DIR/"
cp "$SRC_DIR/package.json" "$INSTALL_DIR/"
cp "$SRC_DIR/tsconfig.json" "$INSTALL_DIR/"

# Install dependencies and build
cd "$INSTALL_DIR"
echo "Installing dependencies..."
npm install --loglevel=warn

echo "Building..."
npm run build

# Save version info
NEW_COMMIT=$(wget -qO- "https://api.github.com/repos/hartwigm/mbus2mqtt/commits/${BRANCH}" 2>/dev/null \
  | grep -m1 '"sha"' | cut -d'"' -f4 | cut -c1-7) || true
if [ -n "$NEW_COMMIT" ]; then
  echo "$NEW_COMMIT" > "$INSTALL_DIR/.version"
fi

# Clean up build dependencies
if [ "$BUILD_DEPS_INSTALLED" = true ]; then
  echo "Removing build dependencies..."
  apk del -q .build-deps
fi

# Clean up dev files
rm -rf "$INSTALL_DIR/src" "$INSTALL_DIR/tsconfig.json" /root/.npm /tmp/*

# Start service
echo "Starting service..."
rc-service mbus2mqtt start

echo ""
if [ -n "$OLD_COMMIT" ] && [ -n "$NEW_COMMIT" ]; then
  echo -e "${GREEN}=== Updated: $OLD_COMMIT → $NEW_COMMIT ===${NC}"
else
  echo -e "${GREEN}=== Update complete ===${NC}"
fi
echo ""
echo "  Check logs: tail -f /var/log/mbus2mqtt.log"
