#!/bin/bash
#
# Build mbus2mqtt Raspberry Pi image using pi-gen (Docker)
#
# Prerequisites:
#   - Docker Desktop running
#   - ~10GB free disk space
#   - Internet connection
#
# Usage:
#   bash deploy/rpi/build-image.sh
#
# Output:
#   deploy/rpi/output/mbus2mqtt-*.img.xz
#
# The image is based on Raspberry Pi OS Lite (Bookworm, armhf)
# and includes mbus2mqtt pre-installed with:
#   - Node.js 22
#   - mbus2mqtt service (enabled, starts on boot)
#   - CLI alias: m2q
#   - SSH enabled
#   - User: mbus2mqtt / mbus2mqtt
#   - Timezone: Europe/Berlin
#   - Locale: de_DE.UTF-8
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIGEN_DIR="$SCRIPT_DIR/pi-gen"
OUTPUT_DIR="$SCRIPT_DIR/output"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== mbus2mqtt Raspberry Pi Image Builder ===${NC}"
echo ""

# Check Docker
if ! docker info &>/dev/null; then
  echo -e "${RED}Error: Docker is not running. Start Docker Desktop first.${NC}"
  exit 1
fi

# Clone pi-gen if not present
if [ ! -d "$PIGEN_DIR" ]; then
  echo "Cloning pi-gen..."
  git clone --depth 1 https://github.com/RPi-Distro/pi-gen.git "$PIGEN_DIR"
fi

# Copy our config
cp "$SCRIPT_DIR/config" "$PIGEN_DIR/config"

# Skip stages 3-5 (desktop stuff)
touch "$PIGEN_DIR/stage3/SKIP" "$PIGEN_DIR/stage4/SKIP" "$PIGEN_DIR/stage5/SKIP"
touch "$PIGEN_DIR/stage3/SKIP_IMAGES" "$PIGEN_DIR/stage4/SKIP_IMAGES" "$PIGEN_DIR/stage5/SKIP_IMAGES"

# Don't export stage2 image (we only want our custom stage)
touch "$PIGEN_DIR/stage2/SKIP_IMAGES"

# Copy our custom stage into pi-gen
rm -rf "$PIGEN_DIR/stage-mbus2mqtt"
cp -r "$SCRIPT_DIR/stage-mbus2mqtt" "$PIGEN_DIR/stage-mbus2mqtt"
chmod +x "$PIGEN_DIR/stage-mbus2mqtt/00-install/01-run.sh"
chmod +x "$PIGEN_DIR/stage-mbus2mqtt/prerun.sh"

# Build with Docker
echo ""
echo "Building image (this takes 30-60 minutes)..."
echo ""
cd "$PIGEN_DIR"
./build-docker.sh

# Copy output
mkdir -p "$OUTPUT_DIR"
cp "$PIGEN_DIR/deploy/"*.img.xz "$OUTPUT_DIR/" 2>/dev/null || \
cp "$PIGEN_DIR/deploy/"*.img "$OUTPUT_DIR/" 2>/dev/null || true

echo ""
echo -e "${GREEN}=== Build complete ===${NC}"
echo ""

IMG=$(ls -1 "$OUTPUT_DIR/"*.img* 2>/dev/null | head -1)
if [ -n "$IMG" ]; then
  SIZE=$(du -h "$IMG" | cut -f1)
  echo "  Image: $IMG ($SIZE)"
  echo ""
  echo "  Flash with:"
  echo "    Raspberry Pi Imager  (recommended)"
  echo "    balenaEtcher"
  echo "    dd if=$IMG of=/dev/sdX bs=4M status=progress"
  echo ""
  echo "  After boot:"
  echo "    1. SSH: ssh mbus2mqtt@<ip>  (password: mbus2mqtt)"
  echo "    2. USB-Adapter anschließen"
  echo "    3. m2q setup"
  echo "    4. nano /etc/mbus2mqtt/config.yaml"
  echo "    5. sudo systemctl start mbus2mqtt"
else
  echo -e "${RED}  No image found in output directory.${NC}"
  echo "  Check pi-gen logs: $PIGEN_DIR/deploy/"
fi
