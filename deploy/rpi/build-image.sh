#!/bin/bash
#
# mbus2mqtt Raspberry Pi image — download base + embed setup
#
# Downloads Raspberry Pi OS Lite, embeds the mbus2mqtt setup script
# as a first-boot service so mbus2mqtt is installed automatically
# on first boot (requires internet on the Pi).
#
# Prerequisites:
#   - Docker Desktop running (for image manipulation)
#   - ~2GB free disk space
#   - Internet connection
#
# Usage:
#   bash deploy/rpi/build-image.sh [PROPERTY_NAME]
#   Example: bash deploy/rpi/build-image.sh M47
#
# Output:
#   deploy/rpi/output/mbus2mqtt-rpi.img.xz
#
set -e

PROPERTY="${1:-M47}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/output"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Convert MSYS/Git Bash paths to Docker-compatible paths on Windows
to_docker_path() {
  local p="$1"
  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    echo "$p" | sed 's|^/\([a-zA-Z]\)/|\1:/|'
  else
    echo "$p"
  fi
}

echo -e "${GREEN}=== mbus2mqtt Raspberry Pi Image Builder ===${NC}"
echo "  Property: $PROPERTY"
echo ""

if ! docker info &>/dev/null; then
  echo -e "${RED}Error: Docker is not running.${NC}"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

DOCKER_SCRIPT_DIR="$(to_docker_path "$SCRIPT_DIR")"
DOCKER_OUTPUT_DIR="$(to_docker_path "$OUTPUT_DIR")"

echo "Building image inside Docker..."
echo "  1. Download Raspberry Pi OS Lite"
echo "  2. Inject mbus2mqtt first-boot setup"
echo "  3. Enable SSH, set locale/timezone"
echo ""

# Register QEMU for ARM (needed to chroot into ARM image)
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes 2>/dev/null || true

MSYS_NO_PATHCONV=1 docker run --rm --privileged \
  -v "$DOCKER_SCRIPT_DIR:/mbus2mqtt-rpi:ro" \
  -v "$DOCKER_OUTPUT_DIR:/output" \
  -e "PROPERTY=$PROPERTY" \
  debian:bookworm bash -c '
set -e

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  wget xz-utils fdisk parted losetup kpartx mount e2fsprogs \
  qemu-user-static binfmt-support ca-certificates 2>&1 | tail -3

# Ensure binfmt is set up
mount binfmt_misc -t binfmt_misc /proc/sys/fs/binfmt_misc 2>/dev/null || true
update-binfmts --enable qemu-arm 2>/dev/null || true

# Download Raspberry Pi OS Lite (armhf = RPi 2/3/4)
IMG_URL="https://downloads.raspberrypi.com/raspios_lite_armhf/images/raspios_lite_armhf-2024-11-19/2024-11-19-raspios-bookworm-armhf-lite.img.xz"
IMG_FILE="/tmp/rpios.img.xz"
IMG="/tmp/rpios.img"

echo "=== Downloading Raspberry Pi OS Lite ==="
wget -q --show-progress -O "$IMG_FILE" "$IMG_URL"
echo "Extracting..."
xz -d "$IMG_FILE"

# Expand image by 500MB for mbus2mqtt
echo "=== Expanding image ==="
dd if=/dev/zero bs=1M count=500 >> "$IMG"

# Set up loop device
LOOP=$(losetup --find --show --partscan "$IMG")
echo "Loop device: $LOOP"

# Resize partition 2 (rootfs) to fill available space
parted -s "$LOOP" resizepart 2 100%

# Wait for partition devices
partprobe "$LOOP"
sleep 2

# Resize filesystem
e2fsck -f -y "${LOOP}p2" || true
resize2fs "${LOOP}p2"

# Mount
ROOTFS="/mnt/rootfs"
BOOTFS="/mnt/bootfs"
mkdir -p "$ROOTFS" "$BOOTFS"
mount "${LOOP}p2" "$ROOTFS"
mount "${LOOP}p1" "$BOOTFS"

echo "=== Configuring image ==="

# Enable SSH
touch "$BOOTFS/ssh"

# Set user (pi:mbus2mqtt) via userconf
echo "mbus2mqtt:$(echo "mbus2mqtt" | openssl passwd -6 -stdin)" > "$BOOTFS/userconf.txt"

# Copy setup script
cp /mbus2mqtt-rpi/setup-rpi.sh "$ROOTFS/opt/mbus2mqtt-setup.sh"
chmod +x "$ROOTFS/opt/mbus2mqtt-setup.sh"

# Create first-boot service that runs setup
cat > "$ROOTFS/etc/systemd/system/mbus2mqtt-firstboot.service" << SVCEOF
[Unit]
Description=mbus2mqtt first-boot setup
After=network-online.target
Wants=network-online.target
ConditionPathExists=/opt/mbus2mqtt-setup.sh

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/mbus2mqtt-setup.sh $PROPERTY
ExecStartPost=/bin/rm -f /opt/mbus2mqtt-setup.sh
ExecStartPost=/bin/systemctl disable mbus2mqtt-firstboot.service
RemainAfterExit=yes
StandardOutput=journal+console

[Install]
WantedBy=multi-user.target
SVCEOF

# Enable service
ln -sf /etc/systemd/system/mbus2mqtt-firstboot.service \
  "$ROOTFS/etc/systemd/system/multi-user.target.wants/mbus2mqtt-firstboot.service"

# Set timezone
ln -sf /usr/share/zoneinfo/Europe/Berlin "$ROOTFS/etc/localtime"
echo "Europe/Berlin" > "$ROOTFS/etc/timezone"

# Set hostname
echo "mbus2mqtt-${PROPERTY,,}" > "$ROOTFS/etc/hostname"
sed -i "s/127.0.1.1.*/127.0.1.1\tmbus2mqtt-${PROPERTY,,}/" "$ROOTFS/etc/hosts"

# Set German keyboard layout
mkdir -p "$ROOTFS/etc/default"
cat > "$ROOTFS/etc/default/keyboard" << KBEOF
XKBMODEL="pc105"
XKBLAYOUT="de"
XKBVARIANT=""
XKBOPTIONS=""
BACKSPACE="guess"
KBEOF

echo "=== Unmounting ==="
sync
umount "$BOOTFS"
umount "$ROOTFS"
losetup -d "$LOOP"

echo "=== Compressing image ==="
xz -T0 -3 "$IMG"
cp /tmp/rpios.img.xz /output/mbus2mqtt-rpi.img.xz

echo "=== Done ==="
'

echo ""
IMG="$OUTPUT_DIR/mbus2mqtt-rpi.img.xz"
if [ -f "$IMG" ]; then
  SIZE=$(du -h "$IMG" | cut -f1)
  echo -e "${GREEN}=== Image erstellt ===${NC}"
  echo ""
  echo "  Image: $IMG ($SIZE)"
  echo ""
  echo "  Flash mit:"
  echo "    Raspberry Pi Imager  (empfohlen)"
  echo "    balenaEtcher"
  echo ""
  echo "  Nach dem Booten:"
  echo "    - Erstes Boot dauert 5-10 Min (Setup läuft automatisch)"
  echo "    - SSH: ssh mbus2mqtt@mbus2mqtt-${PROPERTY,,}.local"
  echo "    - Passwort: mbus2mqtt"
  echo "    - USB-Adapter anschließen"
  echo "    - m2q setup"
  echo "    - sudo nano /etc/mbus2mqtt/config.yaml"
else
  echo -e "${RED}Image nicht gefunden. Prüfe die Logs oben.${NC}"
fi
