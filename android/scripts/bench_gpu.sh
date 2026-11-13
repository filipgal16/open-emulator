#!/usr/bin/env bash
# Compares GPU renderer settings for warm start at a fixed cores/RAM point.
#
# Motivation: warm start measured 11.0s with `-gpu auto` and ~17s after the default was changed to
# `-gpu swiftshader`, with cores and RAM ruled out by separate sweeps. `auto` is not a renderer —
# the emulator resolves it, and it may pick swiftshader_indirect (multi-threaded) over plain
# swiftshader. This isolates that.
#
#   bench_gpu.sh [trials]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRIALS="${1:-3}"
CORES=6
RAM=3072

# gpu_mode:gallium_driver ("-" = leave GALLIUM_DRIVER unset)
CONFIGS=(
  "auto:-"
  "swiftshader_indirect:-"
  "swiftshader:-"
  "auto:d3d12"
)

echo "=== GPU renderer sweep (warm start, cores=${CORES} ram=${RAM}MB, ${TRIALS} trials) ==="

for config in "${CONFIGS[@]}"; do
  gpu="${config%%:*}"
  gallium="${config##*:}"
  label="gpu-${gpu}-$( [[ "$gallium" == "-" ]] && echo nogallium || echo "$gallium" )"

  echo
  echo "--- gpu=${gpu} gallium=${gallium} ---"

  # Renderer choice can be baked into the snapshot, so re-provision per config. The stop matters:
  # a running emulator makes `start --cold` take the warm path and skip the reboot entirely.
  "$SCRIPT_DIR/../bin/open-emu" stop >/dev/null 2>&1 || true
  sleep 3

  if [[ "$gallium" == "-" ]]; then
    unset GALLIUM_DRIVER
    export OPEN_EMU_NO_GALLIUM=1
  else
    export GALLIUM_DRIVER="$gallium"
    unset OPEN_EMU_NO_GALLIUM
  fi

  ANDROID_HEADLESS=1 ANDROID_CORES="$CORES" ANDROID_MEMORY_MB="$RAM" ANDROID_GPU_MODE="$gpu" \
    "$SCRIPT_DIR/../bin/open-emu" start --cold >/dev/null 2>&1 || true
  ANDROID_HEADLESS=1 ANDROID_CORES="$CORES" ANDROID_MEMORY_MB="$RAM" ANDROID_GPU_MODE="$gpu" \
    "$SCRIPT_DIR/../bin/open-emu" provision >/dev/null 2>&1 || true

  ANDROID_HEADLESS=1 ANDROID_CORES="$CORES" ANDROID_MEMORY_MB="$RAM" ANDROID_GPU_MODE="$gpu" \
    "$SCRIPT_DIR/bench.sh" --mode snapshot --trials "$TRIALS" --label "$label" --timeout 300

  echo "    renderer actually used:"
  grep -m1 'Graphics Adapter Android' "$SCRIPT_DIR/../logs/emulator.log" 2>/dev/null | sed 's/^/      /' || true
done

echo
echo "=== summary ==="
awk -F, '$2 ~ /^gpu-/ && $5 != "" { sum[$2]+=$5; n[$2]++ }
         END { for (k in sum) printf "%-28s warm boot avg %.2fs (n=%d)\n", k, sum[k]/n[k], n[k] }' \
  "$SCRIPT_DIR/../logs/bench.csv" | sort -k4 -n
