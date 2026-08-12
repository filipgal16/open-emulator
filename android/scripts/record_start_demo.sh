#!/usr/bin/env bash
# Record a timed cold-start demo of open-emulator (desktop UI + Android boot).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
OUT_DIR="${1:-/opt/cursor/artifacts/demo}"
mkdir -p "$OUT_DIR" "$ROOT/logs"

export ANDROID_HEADLESS=0
export DISPLAY="${DISPLAY:-:1}"

OPEN_EMU="$ROOT/bin/open-emu"
DESKTOP_PORT=8787
TIMING="$OUT_DIR/start_timing.txt"
VIDEO_RAW="$OUT_DIR/start_demo_raw.mp4"
VIDEO="$OUT_DIR/start_demo.mp4"
SCREEN="$OUT_DIR/start_demo_frames"

rm -f "$TIMING"
: > "$TIMING"
mkdir -p "$SCREEN"

logt() {
  local now
  now="$(date -u +%H:%M:%S)"
  echo "[$now] $*" | tee -a "$TIMING"
}

require() {
  [[ -x "$OPEN_EMU" ]] || { echo "missing open-emu"; exit 1; }
  [[ -x "$ROOT/sdk/emulator/emulator" ]] || { echo "missing SDK — run fetch_android.sh"; exit 1; }
}

stop_all() {
  "$OPEN_EMU" stop >/dev/null 2>&1 || true
  pkill -f "node server.js" >/dev/null 2>&1 || true
  pkill -f "qemu-system-x86_64" >/dev/null 2>&1 || true
  sleep 1
}

start_desktop() {
  cd "$REPO/desktop"
  if [[ ! -d node_modules ]]; then
    npm install --no-fund --no-audit >/dev/null 2>&1
  fi
  nohup npm run server >"$ROOT/logs/desktop_demo.log" 2>&1 &
  echo $! > "$ROOT/state/desktop.pid"
  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${DESKTOP_PORT}/api/status" >/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# Record X11 display while the start runs.
start_recorder() {
  # 1280x720 crop from top-left; 5 fps keeps file small for a long boot.
  nohup ffmpeg -y -f x11grab -video_size 1280x720 -framerate 5 -i "${DISPLAY}.0+0,0" \
    -c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 28 \
    "$VIDEO_RAW" >"$ROOT/logs/ffmpeg_demo.log" 2>&1 &
  echo $! > "$ROOT/state/ffmpeg_demo.pid"
}

stop_recorder() {
  if [[ -f "$ROOT/state/ffmpeg_demo.pid" ]]; then
    kill "$(cat "$ROOT/state/ffmpeg_demo.pid")" >/dev/null 2>&1 || true
    sleep 1
    kill -9 "$(cat "$ROOT/state/ffmpeg_demo.pid")" >/dev/null 2>&1 || true
    rm -f "$ROOT/state/ffmpeg_demo.pid"
  fi
}

open_browser() {
  nohup google-chrome --no-first-run --disable-gpu \
    --window-size=1280,720 --window-position=0,0 \
    "http://127.0.0.1:${DESKTOP_PORT}/" >"$ROOT/logs/chrome_demo.log" 2>&1 &
  echo $! > "$ROOT/state/chrome_demo.pid"
  sleep 2
}

cleanup_browser() {
  if [[ -f "$ROOT/state/chrome_demo.pid" ]]; then
    kill "$(cat "$ROOT/state/chrome_demo.pid")" >/dev/null 2>&1 || true
    rm -f "$ROOT/state/chrome_demo.pid"
  fi
  pkill -f "google-chrome.*8787" >/dev/null 2>&1 || true
}

main() {
  require
  mkdir -p "$ROOT/state"
  stop_all
  cleanup_browser

  # Ensure AVD exists.
  if [[ ! -d "$ROOT/avd/OpenEmulator_API30.avd" ]]; then
    logt "setup AVD"
    "$ROOT/scripts/setup_avd.sh"
  fi

  T0=$(date +%s)
  logt "T0 absolute_start epoch=$T0"

  start_recorder
  sleep 1

  TD0=$(date +%s)
  logt "desktop_server_start"
  start_desktop
  TD1=$(date +%s)
  logt "desktop_server_ready elapsed_s=$((TD1 - TD0))"

  open_browser
  logt "browser_opened url=http://127.0.0.1:${DESKTOP_PORT}/"

  # Trigger Android start via CLI (same path the UI uses).
  TE0=$(date +%s)
  logt "android_cold_start_begin"
  # Force cold path: ensure stopped, then start.
  ANDROID_HEADLESS=1 "$OPEN_EMU" start --cold
  TE1=$(date +%s)
  logt "android_boot_completed elapsed_s=$((TE1 - TE0))"

  # Capture a screenshot frame via open-emu for the artifact set.
  "$OPEN_EMU" screenshot "$SCREEN/booted.png" || true
  curl -sf "http://127.0.0.1:${DESKTOP_PORT}/api/status" > "$OUT_DIR/status_after_start.json" || true

  T1=$(date +%s)
  TOTAL=$((T1 - T0))
  logt "TOTAL_cold_start_to_ready_s=$TOTAL"
  logt "breakdown desktop_s=$((TD1 - TD0)) android_s=$((TE1 - TE0))"

  # Hold a few seconds of "ready" UI for the video ending.
  sleep 5
  stop_recorder
  cleanup_browser

  # Remux/faststart for playback.
  if [[ -f "$VIDEO_RAW" ]]; then
    ffmpeg -y -i "$VIDEO_RAW" -c copy -movflags +faststart "$VIDEO" >/dev/null 2>&1 || cp "$VIDEO_RAW" "$VIDEO"
  fi

  echo
  echo "=== DEMO TIMING ==="
  cat "$TIMING"
  echo "video=$VIDEO"
}

main "$@"
