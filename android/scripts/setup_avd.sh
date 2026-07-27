#!/usr/bin/env bash
# Create / refresh the OpenEmulator_API30 AVD with project-specific config.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK_ROOT="${ANDROID_SDK_ROOT:-$ROOT/sdk}"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_HOME="$SDK_ROOT"
export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/emulator:$SDK_ROOT/platform-tools:$PATH"

API_LEVEL="${ANDROID_API_LEVEL:-30}"
AVD_NAME="${ANDROID_AVD_NAME:-OpenEmulator_API30}"
SYSTEM_PACKAGE="system-images;android-${API_LEVEL};google_apis;x86_64"
AVD_HOME="$ROOT/avd"
export ANDROID_AVD_HOME="$AVD_HOME"

if [[ ! -f "$SDK_ROOT/system-images/android-${API_LEVEL}/google_apis/x86_64/system.img" ]]; then
  echo "Android system image missing. Run android/scripts/fetch_android.sh first." >&2
  exit 1
fi

mkdir -p "$AVD_HOME"

echo "==> creating AVD ${AVD_NAME}"
# echo no = no custom hardware profile prompt
echo no | avdmanager --verbose create avd \
  --force \
  --name "$AVD_NAME" \
  --package "$SYSTEM_PACKAGE" \
  --device "pixel_4" \
  || true

AVD_DIR="$AVD_HOME/${AVD_NAME}.avd"
if [[ ! -d "$AVD_DIR" ]]; then
  # avdmanager may place under ~/.android/avd when ANDROID_AVD_HOME is ignored by older tools
  if [[ -d "${HOME}/.android/avd/${AVD_NAME}.avd" ]]; then
    mkdir -p "$AVD_HOME"
    cp -a "${HOME}/.android/avd/${AVD_NAME}.avd" "$AVD_DIR"
    cp -a "${HOME}/.android/avd/${AVD_NAME}.ini" "$AVD_HOME/" 2>/dev/null || true
  else
    echo "AVD directory not found after create" >&2
    exit 1
  fi
fi

echo "==> applying open-emulator AVD config overlays"
cp "$ROOT/config/avd_config.ini" "$AVD_DIR/config.ini"

# Point ini at our avd home
cat > "$AVD_HOME/${AVD_NAME}.ini" <<EOF
avd.ini.encoding=UTF-8
path=${AVD_DIR}
path.rel=avd/${AVD_NAME}.avd
target=android-${API_LEVEL}
EOF

# Minimal boot-time property overrides (host adaptations only).
mkdir -p "$AVD_DIR"
cat > "$AVD_DIR/advancedFeatures.ini" <<EOF
GLDirectMem = on
Vulkan = off
EOF

# First-boot helper: launch Settings after boot completed (also done from run script).
cat > "$AVD_DIR/open_emulator_boot.sh" <<'EOF'
#!/system/bin/sh
# Optional guest-side helper (pushed/used later). Prefer host-side adb am start.
EOF

echo "AVD ready: $AVD_NAME"
echo "  config: $AVD_DIR/config.ini"
