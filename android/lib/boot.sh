#!/usr/bin/env bash
# Fast-boot helpers for the Android Emulator control plane.
# Sourced from lib/common.sh. Requires android_env() to have run before
# launch_and_wait(); the pure functions below only need SNAPSHOT_NAME /
# AVD_HOME when they touch disk.

_BOOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOFTWARE_GPU="${SOFTWARE_GPU:-swiftshader_indirect}"
BOOT_POLL_ADB="${BOOT_POLL_ADB:-0.2}"
BOOT_POLL_BOOT="${BOOT_POLL_BOOT:-0.4}"
# Snapshot restore should reach boot_completed well under 30s on KVM.
# These are failure timeouts, not the success target.
SNAPSHOT_BOOT_TIMEOUT="${SNAPSHOT_BOOT_TIMEOUT:-45}"
SNAPSHOT_ADB_TIMEOUT="${SNAPSHOT_ADB_TIMEOUT:-45}"
KVM_COLD_BOOT_TIMEOUT="${KVM_COLD_BOOT_TIMEOUT:-300}"
TCG_COLD_BOOT_TIMEOUT="${TCG_COLD_BOOT_TIMEOUT:-1800}"
COLD_ADB_TIMEOUT="${COLD_ADB_TIMEOUT:-180}"

avd_config_apply() {
  python3 "$_BOOT_DIR/avd_config.py" apply "$@"
}

avd_config_get() {
  python3 "$_BOOT_DIR/avd_config.py" get "$@"
}

normalize_gpu_mode() {
  local requested="${1:-}"
  case "$requested" in
    swiftshader|"") echo "$SOFTWARE_GPU" ;;
    swiftshader_indirect|host|auto|guest|angle_indirect|off) echo "$requested" ;;
    *) echo "$SOFTWARE_GPU" ;;
  esac
}

# Software GL on TCG (host GPU without KVM is unreliable). On KVM, honor
# the requested mode — including auto/host — so snapshot restore matches
# the GPU the snapshot was taken with.
launch_gpu_mode() {
  local requested
  requested="$(normalize_gpu_mode "${1:-${GPU_MODE:-}}")"
  if (( ${HAS_KVM:-0} == 0 )); then
    echo "$SOFTWARE_GPU"
    return 0
  fi
  echo "$requested"
}

emulator_is_headless() {
  [[ "${ANDROID_HEADLESS:-}" == "1" || -z "${DISPLAY:-}" ]]
}

avd_dir_for() {
  echo "$AVD_HOME/${1:-$AVD_NAME}.avd"
}

snapshot_dir_for() {
  echo "$(avd_dir_for "${1:-$AVD_NAME}")/snapshots/${SNAPSHOT_NAME}"
}

snapshot_exists() {
  [[ -d "$(snapshot_dir_for "${1:-$AVD_NAME}")" ]]
}

# 0 = load the named snapshot. Requires KVM: upstream QEMU/Emulator often
# rejects or segfaults named snapshots under TCG.
should_load_snapshot() {
  local cold="${1:-0}"
  local config_state="${2:-unchanged}"
  local avd="${3:-$AVD_NAME}"
  (( cold == 0 )) || return 1
  (( ${HAS_KVM:-0} == 1 )) || return 1
  [[ "$config_state" == "unchanged" ]] || return 1
  snapshot_exists "$avd"
}

# Print emulator flags, one per line (easy to assert from tests).
# Args: gpu accel headless(0|1) snapshot(0|1)
emulator_flags() {
  local gpu="$1" accel="$2" headless="$3" snapshot="$4"
  printf '%s\n' \
    -gpu "$gpu" \
    -accel "$accel" \
    -no-boot-anim \
    -no-metrics \
    -skip-adb-auth \
    -netdelay none \
    -netspeed full
  if (( headless )); then
    printf '%s\n' -no-window -no-audio
  fi
  if (( snapshot )); then
    printf '%s\n' -snapshot "$SNAPSHOT_NAME" -no-snapshot-save
  else
    printf '%s\n' -no-snapshot-load
  fi
}

boot_timeout_for() {
  local snapshot="${1:-0}"
  if (( snapshot )); then
    echo "$SNAPSHOT_BOOT_TIMEOUT"
  elif (( ${HAS_KVM:-0} )); then
    echo "$KVM_COLD_BOOT_TIMEOUT"
  else
    echo "$TCG_COLD_BOOT_TIMEOUT"
  fi
}

adb_timeout_for() {
  local snapshot="${1:-0}"
  if (( snapshot )); then
    echo "$SNAPSHOT_ADB_TIMEOUT"
  else
    echo "$COLD_ADB_TIMEOUT"
  fi
}

record_boot_path() {
  local path="$1"
  local file="${2:-}"
  LAST_BOOT_PATH="$path"
  if [[ -n "$file" ]]; then
    mkdir -p "$(dirname "$file")"
    echo "$path" > "$file"
  elif [[ -n "${PID_FILE:-}" ]]; then
    mkdir -p "$(dirname "$PID_FILE")"
    echo "$path" > "$(dirname "$PID_FILE")/last_boot_path"
  fi
}

snapshot_load_failed_in_log() {
  local log="$1"
  [[ -f "$log" ]] || return 1
  grep -qiE 'Failed to load snapshot|cannot load snapshot|incompatible snapshot|SnapshotError|error while loading snapshot' "$log"
}

kill_emulator_pid() {
  local pid="${1:-}"
  local avd="${2:-$AVD_NAME}"
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  pkill -f "qemu-system-x86_64.*${avd}" 2>/dev/null || true
  pkill -f "emulator .* -avd ${avd}" 2>/dev/null || true
  pkill -f "emulator.*-avd ${avd}" 2>/dev/null || true
}

# Apply cores/RAM/GPU/network only when they differ from config.ini.
# Prints "changed" or "unchanged". Changing cores/RAM/GPU invalidates
# the named snapshot — caller must skip snapshot load in that case.
sync_avd_runtime_config() {
  local avd="$1" cores="$2" ram="$3" gpu="$4"
  local config
  config="$(avd_dir_for "$avd")/config.ini"
  [[ -f "$config" ]] || { echo "unchanged"; return 0; }
  avd_config_apply "$config" \
    "hw.cpu.ncore=${cores}" \
    "hw.ramSize=${ram}" \
    "hw.gpu.enabled=yes" \
    "hw.gpu.mode=${gpu}" \
    "runtime.network.latency=none" \
    "runtime.network.speed=full"
}

# Spawn the emulator and wait until sys.boot_completed=1.
# Args: avd port cores ram cold pid_file log_file device_file [retry_snapshot]
launch_and_wait() {
  local avd="$1"
  local port="$2"
  local cores="$3"
  local ram="$4"
  local cold="${5:-0}"
  local pid_file="$6"
  local log_file="$7"
  local device_file="$8"
  local retry_snapshot="${9:-1}"

  local avd_dir gpu headless=0 config_state=unchanged use_snapshot=0
  avd_dir="$(avd_dir_for "$avd")"
  gpu="$(launch_gpu_mode "${GPU_MODE:-}")"
  if emulator_is_headless; then
    headless=1
  fi

  if (( cold )); then
    rm -rf "${avd_dir}/snapshots/${SNAPSHOT_NAME}"
  fi

  config_state="$(sync_avd_runtime_config "$avd" "$cores" "$ram" "$gpu")"
  if [[ "$config_state" == "changed" ]]; then
    log "AVD hardware changed (cores/RAM/GPU) — snapshot skipped"
  fi

  if should_load_snapshot "$cold" "$config_state" "$avd"; then
    use_snapshot=1
    log "fast boot from snapshot '${SNAPSHOT_NAME}' (KVM, target ≤30s)"
  else
    if (( ${HAS_KVM:-0} == 0 )) && (( cold == 0 )); then
      log "TCG host: cold boot (named snapshots are not reliable without KVM); keep the process alive for instant reuse"
    else
      log "cold boot"
    fi
  fi

  local flags=()
  mapfile -t flags < <(emulator_flags "$gpu" "${ACCEL:-off}" "$headless" "$use_snapshot")
  local args=(-avd "$avd" -port "$port" "${flags[@]}")

  mkdir -p "$(dirname "$log_file")" "$(dirname "$pid_file")" "$(dirname "$device_file")"
  : > "$log_file"
  log "starting emulator: ${args[*]}"
  nohup "$EMULATOR_BIN" "${args[@]}" >>"$log_file" 2>&1 &
  local pid=$!
  echo "$pid" > "$pid_file"
  echo "emulator-${port}" > "$device_file"
  log "emulator pid=${pid}"

  if (( use_snapshot )); then
    record_boot_path "snapshot" "$(dirname "$pid_file")/last_boot_path"
  else
    record_boot_path "cold" "$(dirname "$pid_file")/last_boot_path"
  fi

  local device=""
  local adb_to boot_to
  adb_to="$(adb_timeout_for "$use_snapshot")"
  boot_to="$(boot_timeout_for "$use_snapshot")"

  # EXPECTED_SERIAL is used by wait_for_adb_device.
  local saved_serial="${EXPECTED_SERIAL:-}"
  EXPECTED_SERIAL="emulator-${port}"
  DEVICE_FILE="$device_file"

  device="$(wait_for_adb_device "$adb_to")" || {
    EXPECTED_SERIAL="$saved_serial"
    tail -n 100 "$log_file" || true
    die "adb device did not appear"
  }
  log "adb device=${device}"

  if (( use_snapshot )) && (( retry_snapshot )); then
    if snapshot_load_failed_in_log "$log_file" || ! kill -0 "$pid" 2>/dev/null; then
      log "snapshot load failed — falling back to cold boot"
      kill_emulator_pid "$pid" "$avd"
      rm -f "$pid_file"
      sleep 1
      EXPECTED_SERIAL="$saved_serial"
      launch_and_wait "$avd" "$port" "$cores" "$ram" 1 "$pid_file" "$log_file" "$device_file" 0
      return $?
    fi
  fi

  wait_for_boot "$device" "$boot_to" || {
    EXPECTED_SERIAL="$saved_serial"
    tail -n 100 "$log_file" || true
    die "Android boot_completed not reached"
  }
  EXPECTED_SERIAL="$saved_serial"
  log "Android boot_completed=1"
}
