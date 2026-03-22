#!/bin/bash
#
# Build mbus2mqtt Raspberry Pi image using pi-gen inside Docker
#
# Works on Windows (Docker Desktop), macOS, and Linux.
# Uses a Linux container with QEMU for ARM cross-compilation.
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
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
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

# Register QEMU for ARM emulation (needed on x86 hosts)
echo "Registering QEMU for ARM emulation..."
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes 2>/dev/null || true

mkdir -p "$OUTPUT_DIR"

echo ""
echo "Building image inside Docker (this takes 30-60 minutes)..."
echo ""

# Run the entire pi-gen build inside a privileged Debian container
docker run --rm --privileged \
  -v "$SCRIPT_DIR:/mbus2mqtt-rpi:ro" \
  -v "$OUTPUT_DIR:/output" \
  debian:bookworm bash -c '
set -e

apt-get update -qq
apt-get install -y -qq git quilt parted qemu-user-static debootstrap \
  zerofree zip dosfstools libarchive-tools bc binfmt-support \
  file xxd rsync xz-utils kmod coreutils kpartx fdisk \
  ca-certificates curl 2>&1 | tail -5

echo "=== Cloning pi-gen ==="
git clone --depth 1 https://github.com/RPi-Distro/pi-gen.git /pi-gen
cd /pi-gen

# Copy config
cp /mbus2mqtt-rpi/config /pi-gen/config

# Skip stages 3-5
for s in stage3 stage4 stage5; do
  touch "/pi-gen/$s/SKIP" "/pi-gen/$s/SKIP_IMAGES"
done
touch /pi-gen/stage2/SKIP_IMAGES

# Copy custom stage
cp -r /mbus2mqtt-rpi/stage-mbus2mqtt /pi-gen/stage-mbus2mqtt
chmod +x /pi-gen/stage-mbus2mqtt/00-install/01-run.sh
chmod +x /pi-gen/stage-mbus2mqtt/prerun.sh

echo "=== Starting pi-gen build ==="
./build.sh

# Copy output
cp /pi-gen/deploy/*.img.xz /output/ 2>/dev/null || \
cp /pi-gen/deploy/*.img /output/ 2>/dev/null || \
cp /pi-gen/deploy/*.zip /output/ 2>/dev/null || true

echo "=== Build finished ==="
'

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
  echo "    dd if=IMAGE of=/dev/sdX bs=4M status=progress"
  echo ""
  echo "  After boot:"
  echo "    1. SSH: ssh mbus2mqtt@<ip>  (password: mbus2mqtt)"
  echo "    2. USB-Adapter anschließen"
  echo "    3. m2q setup"
  echo "    4. sudo nano /etc/mbus2mqtt/config.yaml"
  echo "    5. sudo systemctl start mbus2mqtt"
else
  echo -e "${RED}  No image found in output directory.${NC}"
  echo "  Check build logs above for errors."
fi
