#!/usr/bin/env bash
# Sweeps cold-boot time across CPU/RAM allocations to find where the returns stop.
#
# detect_host_profile currently caps guest cores at 6 regardless of host size; ANDROID_CORES and
# ANDROID_MEMORY_MB override it, so the cap can be evaluated with data instead of guessed.
#
#   bench_sweep.sh [trials]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="cold"
TRIALS=2
PREFIX="sweep"

while (($# > 0)); do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --trials) TRIALS="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# cores:ram_mb
if [[ "$MODE" == "snapshot" ]]; then
  # Cores, not RAM, dominate warm start: at 12 cores warm was 15-17s regardless of RAM, while
  # 6 cores gave 11s. Snapshot restore is largely serial, so extra vCPU threads add contention
  # rather than parallelism — the opposite of cold boot, where more cores helped. So sweep cores
  # here and hold RAM fixed.
  CONFIGS=("2:3072" "4:3072" "6:3072" "8:3072" "12:3072")
else
  CONFIGS=("2:3072" "4:3072" "6:3782" "8:4096" "12:4096" "16:4096")
fi

echo "=== ${MODE} sweep: ${TRIALS} trial(s) per config ==="
for config in "${CONFIGS[@]}"; do
  cores="${config%%:*}"
  ram="${config##*:}"
  label="${PREFIX}-${MODE}-c${cores}-r${ram}"
  echo
  echo "--- cores=${cores} ram=${ram}MB ---"

  if [[ "$MODE" == "snapshot" ]]; then
    # Changing cores or hw.ramSize invalidates the existing snapshot, so re-provision at this
    # config first. Without this the emulator refuses the snapshot and bench.sh records a
    # COLD-FALLBACK.
    #
    # The stop is essential: bench.sh leaves the emulator running, and `start --cold` takes the
    # warm path when it finds a live process — so the guest would keep running at the *previous*
    # config while the snapshot got saved against the new one, guaranteeing a load mismatch.
    echo "    re-provisioning at cores=${cores} ram=${ram}MB"
    "$SCRIPT_DIR/../bin/open-emu" stop >/dev/null 2>&1 || true
    sleep 3
    ANDROID_HEADLESS=1 ANDROID_CORES="$cores" ANDROID_MEMORY_MB="$ram" \
      "$SCRIPT_DIR/../bin/open-emu" start --cold >/dev/null 2>&1 || true
    ANDROID_HEADLESS=1 ANDROID_CORES="$cores" ANDROID_MEMORY_MB="$ram" \
      "$SCRIPT_DIR/../bin/open-emu" provision >/dev/null 2>&1 || true
  fi

  ANDROID_HEADLESS=1 ANDROID_CORES="$cores" ANDROID_MEMORY_MB="$ram" \
    "$SCRIPT_DIR/bench.sh" --mode "$MODE" --trials "$TRIALS" \
    --label "$label" --timeout 300
done

echo
echo "=== sweep complete — summary from CSV ==="
awk -F, -v pfx="^${PREFIX}-${MODE}-" \
  '$2 ~ pfx && $5 != "" { sum[$2]+=$5; n[$2]++ }
   END { for (k in sum) printf "%-28s boot avg %.2fs (n=%d)\n", k, sum[k]/n[k], n[k] }' \
  "$SCRIPT_DIR/../logs/bench.csv" | sort
