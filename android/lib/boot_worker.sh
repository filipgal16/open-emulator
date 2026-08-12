#!/usr/bin/env bash
# Background boot finalizer: wait for boot_completed, tune guest, optional snapshot save.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/connectivity.sh"
android_env

device="${1:-}"
save_snap="${2:-0}"
fps="${3:-}"

[[ -n "$device" ]] || exit 1

boot_timeout=1800
if [[ -f "$PROFILE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  (( HAS_KVM )) && boot_timeout=300
fi

if wait_for_boot "$device" "$boot_timeout"; then
  log "boot worker: boot_completed=1"
else
  log "boot worker: boot_completed timeout"
  set_boot_stage "booting"
  exit 1
fi

apply_guest_tuning "$device"
if [[ -n "${fps:-}" && "$fps" =~ ^(30|60|90|120)$ ]]; then
  "$ADB_BIN" -s "$device" shell -n settings put system peak_refresh_rate "$fps" </dev/null >/dev/null 2>&1 || true
  "$ADB_BIN" -s "$device" shell -n settings put global peak_refresh_rate "$fps" </dev/null >/dev/null 2>&1 || true
fi
touch "$GUEST_TUNED_FILE"
set_boot_stage "ready"
log "boot worker: guest ready"

if (( save_snap )) && ! snapshot_exists; then
  log "boot worker: saving first snapshot '${SNAPSHOT_NAME}'"
  if timeout 180s "$ADB_BIN" -s "$device" emu avd snapshot save "$SNAPSHOT_NAME" </dev/null >/dev/null 2>&1; then
    log "boot worker: snapshot saved"
  else
    log "boot worker: snapshot save skipped/failed"
  fi
fi

rm -f "$BOOT_WORKER_PID_FILE"
