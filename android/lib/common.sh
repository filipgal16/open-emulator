#!/usr/bin/env bash
# Shared helpers for open-emulator Android runtime.
# shellcheck disable=SC2034

android_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "$here"
}

# Loads android/profiles/<name>.env, which decides the system image (and therefore whether the
# guest carries Google Play Services). Selected with ANDROID_PROFILE; defaults to the lean one.
load_profile() {
  local root name file
  root="$(android_root)"
  name="${ANDROID_PROFILE:-fast}"
  file="$root/profiles/${name}.env"

  if [[ ! -f "$file" ]]; then
    echo "unknown profile '${name}' (expected $file)" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  source "$file"
}

# Loads android/devices/<name>.env — the guest's reported hardware identity. Selected with
# ANDROID_DEVICE; defaults to no spoofing.
load_device() {
  local root name file
  root="$(android_root)"
  name="${ANDROID_DEVICE:-generic}"
  file="$root/devices/${name}.env"

  if [[ ! -f "$file" ]]; then
    echo "unknown device '${name}' (expected $file)" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  source "$file"
}

# Builds the -prop arguments that make the guest report the selected device.
#
# These are boot-time properties, so they are baked into any snapshot taken afterwards — changing
# device requires a re-provision, same as changing cores or RAM. Empty fields are skipped, so the
# `generic` device adds no arguments at all.
device_prop_args() {
  local -a args=()
  local pair
  for pair in \
    "ro.product.brand=${DEVICE_BRAND:-}" \
    "ro.product.manufacturer=${DEVICE_MANUFACTURER:-}" \
    "ro.product.model=${DEVICE_MODEL:-}" \
    "ro.product.name=${DEVICE_PRODUCT:-}" \
    "ro.product.device=${DEVICE_DEVICE:-}" \
    "ro.build.fingerprint=${DEVICE_FINGERPRINT:-}" \
    "ro.build.id=${DEVICE_BUILD_ID:-}" \
    "ro.build.tags=${DEVICE_BUILD_TAGS:-}" \
    "ro.build.type=${DEVICE_BUILD_TYPE:-}"; do
    [[ "${pair#*=}" == "" ]] && continue
    args+=(-prop "$pair")
  done
  printf '%s\n' "${args[@]:-}"
}

android_env() {
  ROOT="$(android_root)"
  load_profile || exit 1
  load_device || exit 1
  SDK_ROOT="${ANDROID_SDK_ROOT:-$ROOT/sdk}"
  AVD_HOME="${ANDROID_AVD_HOME:-$ROOT/avd}"
  # Each profile gets its own AVD: the snapshot in one is not loadable by the other, and sharing a
  # name would surface as a mysterious "snapshot load failed" after switching profiles.
  AVD_NAME="${ANDROID_AVD_NAME:-${PROFILE_AVD_NAME:-OpenEmulator_API30}}"
  LOG_DIR="${ANDROID_LOG_DIR:-$ROOT/logs}"
  APPS_DIR="$ROOT/apps"
  STATE_DIR="$ROOT/state"
  # Runtime state is per-AVD, for the same reason the AVD itself is per-profile.
  #
  # Sharing it was wrong in a way that only became visible once there were three profiles: a
  # `provisioned_at` written while running one profile made `demo` skip provisioning for another,
  # and the pid/device files described whichever guest happened to run last. Switching to the play
  # profile would have launched an unprovisioned guest that claimed to be ready.
  AVD_STATE_DIR="$STATE_DIR/$AVD_NAME"
  SNAPSHOT_NAME="${ANDROID_SNAPSHOT_NAME:-booted}"
  EMULATOR_LOG="$LOG_DIR/emulator.log"
  RUNTIME_LOG="$LOG_DIR/runtime.log"
  PID_FILE="$AVD_STATE_DIR/emulator.pid"
  DEVICE_FILE="$AVD_STATE_DIR/device"
  # Host CPU/RAM/KVM detection describes the machine, not the guest, so it stays shared.
  PROFILE_FILE="$STATE_DIR/host_profile.env"

  # One-time move of state written before it was split per-AVD. Only the default profile's AVD can
  # claim it: that is the one those files were written by on any install that predates the split.
  if [[ -f "$STATE_DIR/provisioned_at" && "$AVD_NAME" == "${PROFILE_AVD_NAME:-}" && "${ANDROID_PROFILE:-fast}" == "fast" ]]; then
    mkdir -p "$AVD_STATE_DIR"
    for legacy in provisioned_at snapshot_name emulator.pid device; do
      [[ -f "$STATE_DIR/$legacy" && ! -f "$AVD_STATE_DIR/$legacy" ]] && mv "$STATE_DIR/$legacy" "$AVD_STATE_DIR/$legacy"
    done
  fi

  export ANDROID_SDK_ROOT="$SDK_ROOT"
  export ANDROID_HOME="$SDK_ROOT"
  export ANDROID_AVD_HOME="$AVD_HOME"
  export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/emulator:$SDK_ROOT/platform-tools:$PATH"

  EMULATOR_BIN="$SDK_ROOT/emulator/emulator"
  ADB_BIN="$SDK_ROOT/platform-tools/adb"

  # Under WSL, Mesa defaults to llvmpipe (pure software) even though the GPU is reachable through
  # /dev/dxg. Selecting the d3d12 Gallium driver is what turns `glxinfo` from "llvmpipe" into
  # "D3D12 (AMD Radeon(TM) Graphics)". Only set when both halves are actually present, so this is
  # a no-op on non-WSL hosts and on WSL installs without the Mesa d3d12 driver.
  if [[ -z "${OPEN_EMU_NO_GALLIUM:-}" && -z "${GALLIUM_DRIVER:-}" && -e /dev/dxg ]] \
     && [[ -e /usr/lib/x86_64-linux-gnu/dri/d3d12_dri.so ]]; then
    export GALLIUM_DRIVER=d3d12
    HAS_WSL_GPU=1
  else
    HAS_WSL_GPU=0
  fi

  mkdir -p "$LOG_DIR" "$STATE_DIR" "$AVD_STATE_DIR" "$APPS_DIR" "$AVD_HOME"
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

    # lavapipe (Mesa's Vulkan rasteriser) measured materially faster than swiftshader for cold
    # boot: 26.0s vs 29.6s at 12 cores. `-gpu host` is not an option — it hangs under -no-window.
    # Fall back to swiftshader when the lavapipe ICD is not installed.
    if [[ -n "${ANDROID_GPU_MODE:-}" ]]; then
      gpu_mode="$ANDROID_GPU_MODE"
    elif compgen -G "/usr/share/vulkan/icd.d/lvp_icd*.json" >/dev/null 2>&1; then
      gpu_mode=lavapipe
    else
      gpu_mode=swiftshader
    fi

    # Leave headroom for the host. The old ceiling of 6 was arbitrary: a cold-boot sweep across
    # 2/4/6/8/12/16 cores measured 28.0/25.1/26.5/24.9/24.1/25.0s, so returns flatten after ~4 and
    # the best point sits around 12.
    cores=$(( cpus > 1 ? cpus - 1 : 1 ))
    (( cores > 12 )) && cores=12

    # A measured constant, not a fraction of host RAM. Scaling with the host was actively harmful:
    # cold boot measured 22.9s at 3072MB, 25.9s at 3782MB and 38.6s at 4096MB, and warm start is
    # dominated by restoring the snapshot's ram.bin, which grows with this number. Bigger machines
    # were getting a *slower* emulator. Raise it only for apps that genuinely need the headroom.
    ram_mb_guest=3072
    (( ram_mb < 4096 )) && ram_mb_guest=2048
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

  cat > "$PROFILE_FILE" <<EOF
HOST_CPUS=${cpus}
HOST_RAM_MB=${ram_mb}
HAS_KVM=${has_kvm}
ACCEL=${accel}
GPU_MODE=${gpu_mode}
GUEST_CORES=${cores}
GUEST_RAM_MB=${ram_mb_guest}
EOF
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  log "host profile: kvm=${HAS_KVM} accel=${ACCEL} gpu=${GPU_MODE} cores=${GUEST_CORES} ram=${GUEST_RAM_MB}MB"
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

wait_for_adb_device() {
  local timeout="${1:-300}"
  local deadline=$((SECONDS + timeout))
  local d=""
  adb_start
  while (( SECONDS < deadline )); do
    d="$("$ADB_BIN" devices | awk '/^emulator-/{ if ($2 ~ /^device/) { print $1; exit } }')"
    if [[ -n "$d" ]]; then
      echo "$d" > "$DEVICE_FILE"
      echo "$d"
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_boot() {
  local device="$1"
  local timeout="${2:-1800}"
  local deadline=$((SECONDS + timeout))
  local boot=""
  while (( SECONDS < deadline )); do
    boot="$("$ADB_BIN" -s "$device" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    if [[ "$boot" == "1" ]]; then
      # Package manager must answer before real work.
      if "$ADB_BIN" -s "$device" shell pm path android >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 2
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
