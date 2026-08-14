#!/usr/bin/env bash
# Create / refresh the OpenEmulator_API30 AVD with project-specific config.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"
android_env

API_LEVEL="${ANDROID_API_LEVEL:-30}"
SYSTEM_PACKAGE="system-images;android-${API_LEVEL};google_apis;x86_64"

if [[ ! -f "$SDK_ROOT/system-images/android-${API_LEVEL}/google_apis/x86_64/system.img" ]]; then
  echo "Android system image missing. Run android/scripts/fetch_android.sh first." >&2
  exit 1
fi

mkdir -p "$AVD_HOME"

echo "==> creating AVD ${AVD_NAME}"
echo no | avdmanager --verbose create avd \
  --force \
  --name "$AVD_NAME" \
  --package "$SYSTEM_PACKAGE" \
  --device "pixel_4" \
  || true

AVD_DIR="$AVD_HOME/${AVD_NAME}.avd"
if [[ ! -d "$AVD_DIR" ]]; then
  if [[ -d "${HOME}/.android/avd/${AVD_NAME}.avd" ]]; then
    cp -a "${HOME}/.android/avd/${AVD_NAME}.avd" "$AVD_DIR"
    cp -a "${HOME}/.android/avd/${AVD_NAME}.ini" "$AVD_HOME/" 2>/dev/null || true
  else
    echo "AVD directory not found after create" >&2
    exit 1
  fi
fi

echo "==> applying open-emulator AVD config overlays"
cp "$ROOT/config/avd_config.ini" "$AVD_DIR/config.ini"

detect_host_profile
# shellcheck disable=SC1090
source "$PROFILE_FILE"
avd_config_apply "$AVD_DIR/config.ini" \
  "hw.cpu.ncore=${GUEST_CORES}" \
  "hw.ramSize=${GUEST_RAM_MB}" \
  "hw.gpu.enabled=yes" \
  "hw.gpu.mode=$(launch_gpu_mode)" >/dev/null

# First setup: force one cold boot path until provision saves 'booted'.
if [[ ! -d "$AVD_DIR/snapshots/booted" ]]; then
  sed -i \
    -e 's/^fastboot.forceColdBoot=.*/fastboot.forceColdBoot=yes/' \
    -e 's/^fastboot.forceFastBoot=.*/fastboot.forceFastBoot=no/' \
    -e 's/^fastboot.forceChosenSnapshotBoot=.*/fastboot.forceChosenSnapshotBoot=no/' \
    "$AVD_DIR/config.ini"
fi

cat > "$AVD_HOME/${AVD_NAME}.ini" <<EOF
avd.ini.encoding=UTF-8
path=${AVD_DIR}
path.rel=avd/${AVD_NAME}.avd
target=android-${API_LEVEL}
EOF

# SD card for real app storage / downloads.
MKSDCARD="$SDK_ROOT/emulator/mksdcard"
if [[ -x "$MKSDCARD" && ! -f "$AVD_DIR/sdcard.img" ]]; then
  echo "==> creating 512M sdcard.img"
  "$MKSDCARD" 512M "$AVD_DIR/sdcard.img"
fi

cat > "$AVD_DIR/advancedFeatures.ini" <<EOF
GLDirectMem = on
Vulkan = off
LogcatPipe = on
FastSnapshotV1 = on
EOF

echo "AVD ready: $AVD_NAME"
echo "  config: $AVD_DIR/config.ini"
echo "Next: android/bin/open-emu start --cold && android/bin/open-emu provision"
