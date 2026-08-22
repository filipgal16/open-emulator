#!/usr/bin/env bash
# Fetch Android 11 (API 30) emulator components into android/sdk.
# Large downloads (~1.5–2 GiB). Re-run safely; sdkmanager skips installed packages.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
SDK_ROOT="${ANDROID_SDK_ROOT:-$ROOT/sdk}"
CMDLINE_ZIP_URL="${CMDLINE_ZIP_URL:-https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip}"
API_LEVEL="${ANDROID_API_LEVEL:-30}"

# The image comes from the selected profile (android/profiles/<name>.env). ANDROID_PROFILE picks
# one; ANDROID_SYSTEM_IMAGE still wins if set explicitly.
PROFILE_FILE_PATH="$ROOT/profiles/${ANDROID_PROFILE:-fast}.env"
if [[ -f "$PROFILE_FILE_PATH" ]]; then
  # shellcheck disable=SC1090
  source "$PROFILE_FILE_PATH"
fi
SYSTEM_IMAGE="${ANDROID_SYSTEM_IMAGE:-${PROFILE_SYSTEM_IMAGE:-system-images;android-${API_LEVEL};google_apis;x86_64}}"
echo "==> profile '${PROFILE_NAME:-explicit}' image: ${SYSTEM_IMAGE}"

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

echo "==> accepting SDK licenses"
set +e
yes 2>/dev/null | "$SDKMANAGER" --sdk_root="$SDK_ROOT" --licenses >/dev/null
set -e

echo "==> installing platform-tools, emulator, platform android-${API_LEVEL}, ${SYSTEM_IMAGE}"
"$SDKMANAGER" --sdk_root="$SDK_ROOT" --install \
  "platform-tools" \
  "emulator" \
  "platforms;android-${API_LEVEL}" \
  "$SYSTEM_IMAGE"

# Record what we imported for the repo docs / CI.
cat > "$ROOT/VERSION.txt" <<EOF
android_api=${API_LEVEL}
android_version=11
system_image=${SYSTEM_IMAGE}
imported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sdk_root=android/sdk
notes=Google AOSP/Google APIs x86_64 system image for QEMU-based Android Emulator
EOF

echo "==> writing marker files"
mkdir -p "$ROOT/avd" "$ROOT/logs"
touch "$ROOT/sdk/.imported"

echo "Android ${API_LEVEL} imported under $SDK_ROOT"
echo "Next: $REPO_ROOT/android/scripts/setup_avd.sh && $REPO_ROOT/android/scripts/run_android.sh"
