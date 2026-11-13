#!/usr/bin/env bash
# Start-time benchmark. Measures ONE thing per run so results are comparable across configs,
# unlike bench_realtime.sh which lumped cold boot and provisioning into a single number.
#
# Metric (same definition as bench_ldplayer.ps1, so the two can be compared directly):
#   t1_boot_s    process spawn -> sys.boot_completed==1 AND `pm path android` answers
#   t2_usable_s  process spawn -> launcher window has focus
#
# Usage:
#   bench.sh --mode snapshot --trials 5 --label baseline-kvm
#   bench.sh --mode cold     --trials 3 --label baseline-kvm
#
# Every trial is appended to android/logs/bench.csv.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"
android_env

MODE="snapshot"
TRIALS=5
LABEL=""
TIMEOUT=600

while (($# > 0)); do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --trials) TRIALS="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$MODE" == "cold" || "$MODE" == "snapshot" ]] || die "--mode must be cold or snapshot"
require_sdk

CSV="$LOG_DIR/bench.csv"
# Must match bench_ldplayer.ps1, which writes to the same CSV. t3 (first mirrored frame) is not
# measured yet and stays empty; `note` flags rows that are not a clean measurement.
CSV_HEADER="timestamp,label,mode,trial,t1_boot_s,t2_usable_s,t3_frame_s,note"
mkdir -p "$LOG_DIR"
if [[ ! -f "$CSV" ]]; then
  echo "$CSV_HEADER" > "$CSV"
elif [[ "$(head -n1 "$CSV" | tr -d '\r')" == *",t3_frame_s" ]]; then
  # Written before the note column existed, when the note went into t3_frame_s instead. Widen the
  # header so new rows line up with it.
  sed -i "1s/.*/${CSV_HEADER}/" "$CSV"
fi

# Recompute so the label reflects what actually ran, not a stale profile file.
detect_host_profile >/dev/null
# shellcheck disable=SC1090
source "$PROFILE_FILE"

if [[ -z "$LABEL" ]]; then
  LABEL="kvm${HAS_KVM}-${GPU_MODE}-c${GUEST_CORES}-r${GUEST_RAM_MB}"
fi

log "benchmark: mode=$MODE trials=$TRIALS label=$LABEL"
log "profile: kvm=$HAS_KVM accel=$ACCEL gpu=$GPU_MODE cores=$GUEST_CORES ram=${GUEST_RAM_MB}MB"

if [[ "$MODE" == "snapshot" ]] && ! snapshot_exists; then
  die "no '$SNAPSHOT_NAME' snapshot yet — run 'open-emu provision' first, or use --mode cold"
fi

# Launcher focus is the honest "usable" signal: boot_completed fires well before anything is
# drawn, so stopping at t1 would flatter every configuration equally but tell us nothing about
# when a person could actually touch the thing.
launcher_focused() {
  local device="$1"
  local focus=""
  focus="$("$ADB_BIN" -s "$device" shell dumpsys window 2>/dev/null | grep -m1 'mCurrentFocus' || true)"
  [[ -n "$focus" && "$focus" != *"null"* ]]
}

# A snapshot run that silently falls back to a cold boot is not a snapshot measurement. open-emu
# logs the fallback and deletes the snapshot, so detect it and mark the trial rather than
# recording a cold-boot time under a snapshot label.
fell_back_to_cold() {
  grep -q 'snapshot load failed' "$RUNTIME_LOG" 2>/dev/null
}

t1_values=()
t2_values=()

for ((trial = 1; trial <= TRIALS; trial++)); do
  printf '[bench] trial %d/%d: ' "$trial" "$TRIALS"

  "$SCRIPT_DIR/../bin/open-emu" stop >/dev/null 2>&1 || true
  sleep 3
  : > "$RUNTIME_LOG"

  start_ns=$(date +%s%N)
  if [[ "$MODE" == "cold" ]]; then
    "$SCRIPT_DIR/../bin/open-emu" start --cold >/dev/null 2>&1 &
  else
    "$SCRIPT_DIR/../bin/open-emu" start >/dev/null 2>&1 &
  fi
  starter_pid=$!

  t1=""; t2=""; device=""
  deadline=$((SECONDS + TIMEOUT))

  # adb legitimately fails while the device is still coming up ("device offline", "not found").
  # Under `set -e` a failing command substitution aborts the whole run, so every probe below is
  # explicitly tolerated — a failed poll means "not ready yet", not "benchmark broken".
  while ((SECONDS < deadline)); do
    if [[ -z "$device" ]]; then
      device="$("$ADB_BIN" devices 2>/dev/null | awk '/^emulator-/{ if ($2 ~ /^device/) { print $1; exit } }' || true)"
    fi
    if [[ -n "$device" ]]; then
      if [[ -z "$t1" ]]; then
        boot="$("$ADB_BIN" -s "$device" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
        if [[ "$boot" == "1" ]] && "$ADB_BIN" -s "$device" shell pm path android >/dev/null 2>&1; then
          now_ns=$(date +%s%N)
          t1=$(awk -v a="$start_ns" -v b="$now_ns" 'BEGIN{printf "%.2f",(b-a)/1e9}')
        fi
      elif launcher_focused "$device"; then
        now_ns=$(date +%s%N)
        t2=$(awk -v a="$start_ns" -v b="$now_ns" 'BEGIN{printf "%.2f",(b-a)/1e9}')
        break
      fi
    fi
    sleep 0.25
  done

  wait "$starter_pid" 2>/dev/null || true

  note=""
  if [[ "$MODE" == "snapshot" ]] && fell_back_to_cold; then
    note="COLD-FALLBACK"
    t1=""; t2=""
  fi

  if [[ -n "$note" ]]; then
    echo "SNAPSHOT LOAD FAILED — fell back to cold boot (not a snapshot measurement)"
  elif [[ -n "$t1" ]]; then
    echo "boot=${t1}s usable=${t2:-timeout}s"
    t1_values+=("$t1")
    [[ -n "$t2" ]] && t2_values+=("$t2")
  else
    echo "TIMEOUT (no boot_completed within ${TIMEOUT}s)"
  fi

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ),$LABEL,$MODE,$trial,${t1},${t2},,${note}" >> "$CSV"

  # The cold-boot retry deletes the snapshot, so every later trial would silently measure a cold
  # boot too. Stop rather than fill the CSV with mislabelled rows.
  if [[ -n "$note" ]]; then
    log "aborting remaining trials: the snapshot was consumed by the cold-boot retry"
    break
  fi
done

median() {
  local -a sorted
  (($# == 0)) && { echo "n/a"; return; }
  mapfile -t sorted < <(printf '%s\n' "$@" | sort -n)
  echo "${sorted[$(($# / 2))]}"
}

echo
log "median boot:   $(median "${t1_values[@]:-}")s"
log "median usable: $(median "${t2_values[@]:-}")s"
log "appended to $CSV"
