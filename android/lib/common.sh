#!/usr/bin/env bash
# Shared helpers for open-emulator Android runtime.
# shellcheck disable=SC2034

android_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "$here"
}

android_env() {
  ROOT="$(android_root)"
  SDK_ROOT="${ANDROID_SDK_ROOT:-$ROOT/sdk}"
  AVD_HOME="${ANDROID_AVD_HOME:-$ROOT/avd}"
  AVD_NAME="${ANDROID_AVD_NAME:-OpenEmulator_API30}"
  LOG_DIR="${ANDROID_LOG_DIR:-$ROOT/logs}"
  APPS_DIR="$ROOT/apps"
  STATE_DIR="$ROOT/state"
  SNAPSHOT_NAME="${ANDROID_SNAPSHOT_NAME:-booted}"
  EMULATOR_LOG="$LOG_DIR/emulator.log"
  RUNTIME_LOG="$LOG_DIR/runtime.log"
  PID_FILE="$STATE_DIR/emulator.pid"
  DEVICE_FILE="$STATE_DIR/device"
  PROFILE_FILE="$STATE_DIR/host_profile.env"
  BOOT_STAGE_FILE="$STATE_DIR/boot_stage"
  GUEST_TUNED_FILE="$STATE_DIR/guest_tuned"
  BOOT_WORKER_PID_FILE="$STATE_DIR/boot_worker.pid"

  export ANDROID_SDK_ROOT="$SDK_ROOT"
  export ANDROID_HOME="$SDK_ROOT"
  export ANDROID_AVD_HOME="$AVD_HOME"
  export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/emulator:$SDK_ROOT/platform-tools:$PATH"

  EMULATOR_BIN="$SDK_ROOT/emulator/emulator"
  ADB_BIN="$SDK_ROOT/platform-tools/adb"

  mkdir -p "$LOG_DIR" "$STATE_DIR" "$APPS_DIR" "$AVD_HOME"
}

log() {
  local msg="[$(date -u +%H:%M:%S)] $*"
  echo "$msg" | tee -a "$RUNTIME_LOG"
}

die() {
  log "ERROR: $*"
  exit 1
}

require_sdk() {
  [[ -x "$EMULATOR_BIN" ]] || die "emulator missing — run: make android-fetch"
  [[ -x "$ADB_BIN" ]] || die "adb missing — run: make android-fetch"
  [[ -d "$AVD_HOME/${AVD_NAME}.avd" ]] || die "AVD missing — run: make android-setup"
}

detect_host_profile() {
  local cpus ram_mb has_kvm gpu_mode accel cores ram_mb_guest
  cpus="$(nproc 2>/dev/null || echo 2)"
  ram_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  has_kvm=0
  [[ -e /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] && has_kvm=1

  if (( has_kvm )); then
    accel=on
    gpu_mode="${ANDROID_GPU_MODE:-auto}"
    # Leave headroom for host.
    cores=$(( cpus > 1 ? cpus - 1 : 1 ))
    (( cores > 6 )) && cores=6
    ram_mb_guest=$(( ram_mb / 2 ))
    (( ram_mb_guest < 3072 )) && ram_mb_guest=3072
    (( ram_mb_guest > 8192 )) && ram_mb_guest=8192
  else
    accel=off
    gpu_mode="${ANDROID_GPU_MODE:-swiftshader}"
    # TCG: 2 cores usually beats oversubscription; keep RAM modest for faster snapshots.
    cores=2
    ram_mb_guest=3072
    (( ram_mb < 5120 )) && ram_mb_guest=2048
  fi

  # Override hooks
  [[ -n "${ANDROID_CORES:-}" ]] && cores="$ANDROID_CORES"
  [[ -n "${ANDROID_MEMORY_MB:-}" ]] && ram_mb_guest="$ANDROID_MEMORY_MB"

  # Display profile: guest framebuffer resolution (Qt window scales freely on resize).
  # ANDROID_DISPLAY=hd|fhd|qhd|native  or ANDROID_LCD_WIDTH/HEIGHT/DENSITY
  local lcd_w lcd_h lcd_dpi
  # Until a Quick Boot snapshot exists, default to HD for faster first cold boot (TCG).
  local display_preset="${ANDROID_DISPLAY:-}"
  if [[ -z "$display_preset" && "${ANDROID_FAST_FIRST_BOOT:-1}" == "1" ]]; then
    local snap_dir="$AVD_HOME/${AVD_NAME}.avd/snapshots/${SNAPSHOT_NAME}"
    [[ -d "$snap_dir" ]] || display_preset=hd
  fi
  case "${display_preset:-fhd}" in
    hd)   lcd_w=720;  lcd_h=1280; lcd_dpi=320 ;;
    fhd)  lcd_w=1080; lcd_h=1920; lcd_dpi=420 ;;
    qhd)  lcd_w=1440; lcd_h=2560; lcd_dpi=560 ;;
    native)
      lcd_w="${ANDROID_LCD_WIDTH:-1080}"
      lcd_h="${ANDROID_LCD_HEIGHT:-1920}"
      lcd_dpi="${ANDROID_LCD_DENSITY:-420}"
      ;;
    *)
      lcd_w=1080; lcd_h=1920; lcd_dpi=420
      ;;
  esac
  [[ -n "${ANDROID_LCD_WIDTH:-}" ]] && lcd_w="$ANDROID_LCD_WIDTH"
  [[ -n "${ANDROID_LCD_HEIGHT:-}" ]] && lcd_h="$ANDROID_LCD_HEIGHT"
  [[ -n "${ANDROID_LCD_DENSITY:-}" ]] && lcd_dpi="$ANDROID_LCD_DENSITY"

  cat > "$PROFILE_FILE" <<EOF
HOST_CPUS=${cpus}
HOST_RAM_MB=${ram_mb}
HAS_KVM=${has_kvm}
ACCEL=${accel}
GPU_MODE=${gpu_mode}
GUEST_CORES=${cores}
GUEST_RAM_MB=${ram_mb_guest}
LCD_WIDTH=${lcd_w}
LCD_HEIGHT=${lcd_h}
LCD_DENSITY=${lcd_dpi}
EOF
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  log "host profile: kvm=${HAS_KVM} accel=${ACCEL} gpu=${GPU_MODE} cores=${GUEST_CORES} ram=${GUEST_RAM_MB}MB display=${LCD_WIDTH}x${LCD_HEIGHT}@${LCD_DENSITY}"
}

adb_start() {
  "$ADB_BIN" start-server >/dev/null
}

adb_device() {
  if [[ -f "$DEVICE_FILE" ]]; then
    local d
    d="$(cat "$DEVICE_FILE")"
    if "$ADB_BIN" devices | awk '{print $1}' | grep -qx "$d"; then
      echo "$d"
      return 0
    fi
  fi
  "$ADB_BIN" devices | awk '/^emulator-/{ if ($2 ~ /^device/) { print $1; exit } }'
}

adb_sh() {
  local d
  d="$(adb_device)"
  [[ -n "$d" ]] || die "no emulator device; start Android first"
  "$ADB_BIN" -s "$d" "$@"
}

set_boot_stage() {
  local stage="$1"
  mkdir -p "$STATE_DIR"
  echo "$stage" > "$BOOT_STAGE_FILE"
}

get_boot_stage() {
  if [[ -f "$BOOT_STAGE_FILE" ]]; then
    cat "$BOOT_STAGE_FILE"
    return 0
  fi
  echo "stopped"
}

detect_boot_stage() {
  if ! emulator_running; then
    echo "stopped"
    return 0
  fi
  local d boot
  d="$(adb_device || true)"
  if [[ -z "$d" ]]; then
    if [[ -f "$BOOT_STAGE_FILE" ]]; then
      cat "$BOOT_STAGE_FILE"
    else
      echo "spawning"
    fi
    return 0
  fi
  boot="$("$ADB_BIN" -s "$d" shell -n getprop sys.boot_completed </dev/null 2>/dev/null | tr -d '\r')"
  if [[ "$boot" != "1" ]]; then
    echo "booting"
    return 0
  fi
  if [[ -f "$GUEST_TUNED_FILE" ]]; then
    echo "ready"
  else
    echo "booted"
  fi
}

wait_for_adb_device() {
  local timeout="${1:-300}"
  local deadline=$((SECONDS + timeout))
  local d=""
  adb_start
  while (( SECONDS < deadline )); do
    d="$("$ADB_BIN" devices 2>/dev/null | awk '/^emulator-/{ if ($2 ~ /^device/) { print $1; exit } }')"
    if [[ -n "$d" ]]; then
      echo "$d" > "$DEVICE_FILE"
      set_boot_stage "adb"
      echo "$d"
      return 0
    fi
    sleep 0.2
  done
  return 1
}

wait_for_boot() {
  local device="$1"
  local timeout="${2:-1800}"
  local deadline=$((SECONDS + timeout))
  local boot=""
  set_boot_stage "booting"
  while (( SECONDS < deadline )); do
    boot="$("$ADB_BIN" -s "$device" shell -n getprop sys.boot_completed </dev/null 2>/dev/null | tr -d '\r')"
    if [[ "$boot" == "1" ]]; then
      set_boot_stage "booted"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

wait_for_network() {
  local device="$1"
  local timeout="${2:-120}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    # DNS + HTTP reachability from the guest.
    if "$ADB_BIN" -s "$device" shell ping -c 1 -W 2 8.8.8.8 >/dev/null 2>&1; then
      return 0
    fi
    if "$ADB_BIN" -s "$device" shell ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

emulator_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill -0 "$pid" 2>/dev/null && return 0
  fi
  pgrep -f "qemu-system-x86_64.*${AVD_NAME}|emulator -avd ${AVD_NAME}" >/dev/null 2>&1
}

snapshot_exists() {
  local snap_dir="$AVD_HOME/${AVD_NAME}.avd/snapshots/${SNAPSHOT_NAME}"
  [[ -d "$snap_dir" ]]
}
