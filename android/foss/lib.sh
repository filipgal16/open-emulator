#!/usr/bin/env bash
# Shared setup for the FOSS runtime.
#
# This is the licence-clean half of the project: stock QEMU (GPL-2.0), Debian's adb (Apache-2.0,
# built from AOSP source rather than Google's SDK binary), and an Android-x86 image (Apache-2.0
# userspace over a GPL-2.0 kernel). Nothing here is downloaded from Google or governed by the
# Android SDK Terms, so a product built on it can be sold — see LICENSING.md.
#
# The Google-SDK runtime in ../bin/open-emu still exists and still works; it is simply not the one
# you can ship.

FOSS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_ROOT="$(cd "$FOSS_ROOT/.." && pwd)"

IMAGES_DIR="${OPEN_EMU_IMAGES_DIR:-$ANDROID_ROOT/images}"
FOSS_STATE_DIR="${OPEN_EMU_FOSS_STATE:-$ANDROID_ROOT/state/foss}"
FOSS_LOG_DIR="${OPEN_EMU_FOSS_LOGS:-$ANDROID_ROOT/logs}"

# The guest image. Android-x86 9.0-r2 is the default because it is the build most reliably
# bootable under plain QEMU; ANDROID_X86_ISO points at any other Android-x86/Bliss ISO.
ISO_NAME="${ANDROID_X86_ISO_NAME:-android-x86_64-9.0-r2.iso}"
ISO_PATH="${ANDROID_X86_ISO:-$IMAGES_DIR/$ISO_NAME}"
ISO_URL="${ANDROID_X86_URL:-https://archive.org/download/sjarb_android_9.0r2/android-x86_64-9.0-r2.iso}"
# The directory the ISO unpacks its payload into; the initrd looks for it by name.
ISO_SRC_DIR="${ANDROID_X86_SRC:-/android-9.0-r2}"

DATA_DISK="$FOSS_STATE_DIR/data.qcow2"
# The data disk is the only virtio block device attached, so it always lands here. Android-x86's
# initrd takes `DATA=` as the device to mount at /data.
DATA_DEVICE="${OPEN_EMU_DATA_DEVICE:-/dev/vda}"
DATA_SIZE="${OPEN_EMU_DATA_SIZE:-8G}"
PID_FILE="$FOSS_STATE_DIR/qemu.pid"
MONITOR_SOCK="$FOSS_STATE_DIR/monitor.sock"
QEMU_LOG="$FOSS_LOG_DIR/qemu.log"

# adb reaches the guest over TCP through a QEMU port forward — there is no USB to emulate, and it
# keeps the guest reachable without any Google tooling.
ADB_PORT="${OPEN_EMU_ADB_PORT:-5555}"
ADB_TARGET="localhost:${ADB_PORT}"

QEMU_BIN="${QEMU_BIN:-qemu-system-x86_64}"
ADB_BIN="${ADB_BIN:-adb}"

foss_log() {
  mkdir -p "$FOSS_LOG_DIR"
  local msg="[$(date -u +%H:%M:%S)] $*"
  echo "$msg" | tee -a "$FOSS_LOG_DIR/foss.log"
}

foss_die() {
  echo "error: $*" >&2
  exit 1
}

foss_env() {
  mkdir -p "$IMAGES_DIR" "$FOSS_STATE_DIR" "$FOSS_LOG_DIR"

  command -v "$QEMU_BIN" >/dev/null 2>&1 || foss_die "$QEMU_BIN not found — install qemu-system-x86"
  command -v "$ADB_BIN" >/dev/null 2>&1 || foss_die "$ADB_BIN not found — install adb"

  # KVM turns a 10-minute boot into a 30-second one. Without it QEMU still works via TCG, which is
  # worth saying out loud rather than letting someone conclude the thing is broken.
  if [[ -w /dev/kvm ]]; then
    ACCEL_ARGS=(-enable-kvm -cpu host)
    HAS_KVM=1
  else
    ACCEL_ARGS=(-cpu qemu64)
    HAS_KVM=0
  fi

  GUEST_CORES="${OPEN_EMU_CORES:-$(nproc 2>/dev/null || echo 2)}"
  (( GUEST_CORES > 8 )) && GUEST_CORES=8
  GUEST_RAM_MB="${OPEN_EMU_RAM_MB:-3072}"
}

foss_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)" || return 1
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# adb over TCP needs an explicit connect; it is not discovered the way a USB device is.
foss_adb_connect() {
  "$ADB_BIN" connect "$ADB_TARGET" >/dev/null 2>&1 || true
}

foss_adb() {
  foss_adb_connect
  "$ADB_BIN" -s "$ADB_TARGET" "$@"
}

foss_wait_for_adb() {
  local timeout="${1:-180}" waited=0
  while (( waited < timeout )); do
    foss_adb_connect
    if "$ADB_BIN" -s "$ADB_TARGET" shell true >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

foss_wait_for_boot() {
  local timeout="${1:-240}" waited=0 v
  while (( waited < timeout )); do
    v="$(foss_adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    [[ "$v" == "1" ]] && return 0
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}
