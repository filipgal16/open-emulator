#!/usr/bin/env bash
# Create / refresh the OpenEmulator_API30 AVD with project-specific config.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"
android_env

API_LEVEL="${ANDROID_API_LEVEL:-30}"
# Image comes from the selected profile (android/profiles/<name>.env), loaded by android_env.
SYSTEM_PACKAGE="${PROFILE_SYSTEM_IMAGE:-system-images;android-${API_LEVEL};google_apis;x86_64}"
IMAGE_TAG="${PROFILE_IMAGE_TAG:-google_apis}"

echo "==> profile '${PROFILE_NAME:-?}' — ${PROFILE_DESC:-}"

if [[ ! -f "$SDK_ROOT/system-images/android-${API_LEVEL}/${IMAGE_TAG}/x86_64/system.img" ]]; then
  echo "Android system image '${IMAGE_TAG}' missing. Run android/scripts/fetch_android.sh first." >&2
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

# Point the config at the profile's image and match its Play Services claim. The template ships
# google_apis values; without this the "fast" AVD would be created against the wrong system image.
sed -i \
  -e "s|^image.sysdir.1=.*|image.sysdir.1=system-images/android-${API_LEVEL}/${IMAGE_TAG}/x86_64/|" \
  -e "s/^tag.id=.*/tag.id=${IMAGE_TAG}/" \
  -e "s/^PlayStore.enabled=.*/PlayStore.enabled=${PROFILE_PLAYSTORE:-false}/" \
  -e "s/^AvdId=.*/AvdId=${AVD_NAME}/" \
  "$AVD_DIR/config.ini"

if [[ "$IMAGE_TAG" == "default" ]]; then
  sed -i -e 's/^tag.display=.*/tag.display=AOSP/' "$AVD_DIR/config.ini"
fi

# If build_custom_image.sh has produced an image for this device, use it instead of the stock one.
# avdmanager will not create against an unregistered image, so the AVD is created normally and
# config.ini is then repointed — the emulator reads config.ini directly and does not care.
CUSTOM_DIR="$SDK_ROOT/system-images/android-${API_LEVEL}/oe_${ANDROID_DEVICE:-generic}/x86_64"
if [[ -f "$CUSTOM_DIR/system.img" ]]; then
  echo "==> using CUSTOM image for device '${ANDROID_DEVICE}' (identity baked into build.prop)"
  sed -i \
    -e "s|^image.sysdir.1=.*|image.sysdir.1=system-images/android-${API_LEVEL}/oe_${ANDROID_DEVICE}/x86_64/|" \
    "$AVD_DIR/config.ini"
fi

# Panel geometry comes from the selected device profile. This has to live in config.ini rather
# than a -prop: the framebuffer size is hardware, fixed when the AVD boots.
if [[ -n "${DEVICE_LCD_WIDTH:-}" ]]; then
  echo "==> device profile '${DEVICE_NAME}' — ${DEVICE_LCD_WIDTH}x${DEVICE_LCD_HEIGHT} @ ${DEVICE_LCD_DENSITY}dpi"
  sed -i \
    -e "s/^hw.lcd.width=.*/hw.lcd.width=${DEVICE_LCD_WIDTH}/" \
    -e "s/^hw.lcd.height=.*/hw.lcd.height=${DEVICE_LCD_HEIGHT}/" \
    -e "s/^hw.lcd.density=.*/hw.lcd.density=${DEVICE_LCD_DENSITY}/" \
    "$AVD_DIR/config.ini"
fi

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
EOF

# NOTE: no hardware-qemu.ini is written here on purpose.
#
# It used to be generated with hw.ramSize=4096 / hw.cpu.ncore=2 / swiftshader_indirect, which
# contradicted both config.ini (3072 / 2 / swiftshader) and the values open-emu patches in at
# launch. The emulator regenerates hardware-qemu.ini itself from config.ini plus the command line,
# so a hand-written one is a third source of truth that can only drift.

echo "AVD ready: $AVD_NAME"
echo "  config: $AVD_DIR/config.ini"
echo "Next: android/bin/open-emu start --cold && android/bin/open-emu provision"
