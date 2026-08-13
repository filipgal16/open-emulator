#!/usr/bin/env bash
# Fetch Android 11 (API 30) emulator components into android/sdk.
# Large downloads (~1.5–2 GiB). Re-run safely; sdkmanager skips installed packages.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
SDK_ROOT="${ANDROID_SDK_ROOT:-$ROOT/sdk}"
AVD_HOME="${ANDROID_AVD_HOME:-$ROOT/avd}"
LOG_DIR="${ANDROID_LOG_DIR:-$ROOT/logs}"
CMDLINE_ZIP_URL="${CMDLINE_ZIP_URL:-https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip}"
API_LEVEL="${ANDROID_API_LEVEL:-30}"
SYSTEM_IMAGE="${ANDROID_SYSTEM_IMAGE:-system-images;android-${API_LEVEL};google_apis;x86_64}"

mkdir -p "$SDK_ROOT/cmdline-tools"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_HOME="$SDK_ROOT"

if [[ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]]; then
  echo "==> downloading Android command-line tools"
  tmp="$(mktemp -d)"
  zip="$tmp/cmdline-tools.zip"
  curl -L --fail --retry 3 -o "$zip" "$CMDLINE_ZIP_URL"
  unzip -q "$zip" -d "$tmp"
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mkdir -p "$SDK_ROOT/cmdline-tools/latest"
  # Zip contains a top-level cmdline-tools/ directory.
  if [[ -d "$tmp/cmdline-tools" ]]; then
    mv "$tmp/cmdline-tools"/* "$SDK_ROOT/cmdline-tools/latest/"
  else
    mv "$tmp"/* "$SDK_ROOT/cmdline-tools/latest/" 2>/dev/null || true
  fi
  rm -rf "$tmp"
fi

SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
if [[ ! -x "$SDKMANAGER" ]]; then
  echo "sdkmanager missing after install" >&2
  exit 1
fi

# The SDK license agreement (developer.android.com/studio/terms) forbids
# redistributing or bundling the SDK/system images; this product never does
# that — every install downloads its own copy here, straight from Google.
# It still requires *informed* acceptance, so the desktop wizard shows the
# terms and only sets this flag once a person actually checks the box.
# `yes | sdkmanager --licenses` below is just the standard non-interactive
# way to answer sdkmanager's own per-license prompts on their behalf.
if [[ "${ANDROID_SDK_LICENSE_ACCEPTED:-0}" != "1" ]]; then
  cat >&2 <<'EOF'
Android SDK License Agreement not accepted yet.

Read it at: https://developer.android.com/studio/terms
Then either:
  - run the desktop wizard's "Android SDK" step and check the license box, or
  - re-run this script with ANDROID_SDK_LICENSE_ACCEPTED=1 once you have
    read and agree to Google's terms yourself.
EOF
  exit 1
fi

echo "==> recording acceptance of the Android SDK License Agreement"
set +e
yes 2>/dev/null | "$SDKMANAGER" --sdk_root="$SDK_ROOT" --licenses >/dev/null
set -e

echo "==> installing platform-tools, emulator, platform android-${API_LEVEL}, ${SYSTEM_IMAGE}"
"$SDKMANAGER" --sdk_root="$SDK_ROOT" --install \
  "platform-tools" \
  "emulator" \
  "platforms;android-${API_LEVEL}" \
  "$SYSTEM_IMAGE"

# Record what we imported for the repo docs / CI. $ROOT is the code
# directory — writable in a dev checkout, but read-only inside a packaged
# install (AppImage mount, /opt deb install), so fall back to the (always
# writable) SDK data root there instead of failing after a multi-GiB fetch.
VERSION_FILE="$ROOT/VERSION.txt"
[[ -w "$ROOT" ]] || VERSION_FILE="$SDK_ROOT/VERSION.txt"
cat > "$VERSION_FILE" <<EOF
android_api=${API_LEVEL}
android_version=11
system_image=${SYSTEM_IMAGE}
imported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sdk_root=android/sdk
notes=Google AOSP/Google APIs x86_64 system image for QEMU-based Android Emulator
EOF

echo "==> writing marker files"
mkdir -p "$AVD_HOME" "$LOG_DIR"
touch "$SDK_ROOT/.imported"

echo "Android ${API_LEVEL} imported under $SDK_ROOT"
echo "Next: $REPO_ROOT/android/scripts/setup_avd.sh && $REPO_ROOT/android/scripts/run_android.sh"
