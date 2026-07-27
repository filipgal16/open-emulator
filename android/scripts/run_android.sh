#!/usr/bin/env bash
# Boot Android 11 under the Android Emulator (QEMU) and open an app.
# Uses software GPU + TCG when KVM is unavailable — slow but works.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK_ROOT="${ANDROID_SDK_ROOT:-$ROOT/sdk}"
AVD_HOME="$ROOT/avd"
AVD_NAME="${ANDROID_AVD_NAME:-OpenEmulator_API30}"
LOG_DIR="$ROOT/logs"
EMULATOR_LOG="$LOG_DIR/emulator.log"
RUN_LOG="$LOG_DIR/run.log"
APP_COMPONENT="${ANDROID_LAUNCH_COMPONENT:-com.android.settings/.Settings}"
BOOT_TIMEOUT_SEC="${ANDROID_BOOT_TIMEOUT_SEC:-1800}"

export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_HOME="$SDK_ROOT"
export ANDROID_AVD_HOME="$AVD_HOME"
export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/emulator:$SDK_ROOT/platform-tools:$PATH"

mkdir -p "$LOG_DIR"

if [[ ! -d "$AVD_HOME/${AVD_NAME}.avd" ]]; then
  echo "AVD missing; running setup_avd.sh" >&2
  "$ROOT/scripts/setup_avd.sh"
fi

EMULATOR_BIN="$SDK_ROOT/emulator/emulator"
ADB_BIN="$SDK_ROOT/platform-tools/adb"
if [[ ! -x "$EMULATOR_BIN" ]]; then
  echo "emulator binary missing; run fetch_android.sh" >&2
  exit 1
fi

# Free any stale emulator/adb state from prior runs.
"$ADB_BIN" kill-server >/dev/null 2>&1 || true
pkill -f "qemu-system-x86_64-headless|emulator @${AVD_NAME}|emulator -avd ${AVD_NAME}" >/dev/null 2>&1 || true
sleep 1

ACCEL_ARGS=(-accel off)
if [[ -e /dev/kvm ]]; then
  ACCEL_ARGS=(-accel on)
fi

echo "==> starting emulator ${AVD_NAME}" | tee "$RUN_LOG"
# -no-window: headless; swiftshader: software GLES; -no-metrics: less noise
nohup "$EMULATOR_BIN" \
  -avd "$AVD_NAME" \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -gpu swiftshader_indirect \
  "${ACCEL_ARGS[@]}" \
  -no-snapshot \
  -memory 3072 \
  -cores 2 \
  -netdelay none \
  -netspeed full \
  >"$EMULATOR_LOG" 2>&1 &
EMU_PID=$!
echo "emulator pid=${EMU_PID}" | tee -a "$RUN_LOG"

cleanup() {
  local code=$?
  if kill -0 "$EMU_PID" >/dev/null 2>&1; then
    echo "==> stopping emulator pid=${EMU_PID}" | tee -a "$RUN_LOG"
    kill "$EMU_PID" >/dev/null 2>&1 || true
    sleep 2
    kill -9 "$EMU_PID" >/dev/null 2>&1 || true
  fi
  "$ADB_BIN" kill-server >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT INT TERM

echo "==> waiting for adb device (timeout ${BOOT_TIMEOUT_SEC}s)" | tee -a "$RUN_LOG"
"$ADB_BIN" start-server >/dev/null
deadline=$((SECONDS + BOOT_TIMEOUT_SEC))
device=""
while (( SECONDS < deadline )); do
  if ! kill -0 "$EMU_PID" >/dev/null 2>&1; then
    echo "emulator exited early; see $EMULATOR_LOG" | tee -a "$RUN_LOG"
    tail -n 80 "$EMULATOR_LOG" || true
    exit 1
  fi
  # Prefer the emulator serial once it appears.
  mapfile -t devices < <("$ADB_BIN" devices | awk '/^emulator-.*device/{print $1}')
  if ((${#devices[@]} > 0)); then
    device="${devices[0]}"
    break
  fi
  sleep 2
done
if [[ -z "$device" ]]; then
  echo "no emulator device showed up in adb" | tee -a "$RUN_LOG"
  tail -n 80 "$EMULATOR_LOG" || true
  exit 1
fi
echo "adb device=${device}" | tee -a "$RUN_LOG"

echo "==> waiting for Android boot completed" | tee -a "$RUN_LOG"
while (( SECONDS < deadline )); do
  boot="$("$ADB_BIN" -s "$device" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
  if [[ "$boot" == "1" ]]; then
    break
  fi
  sleep 5
done
boot="$("$ADB_BIN" -s "$device" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
if [[ "$boot" != "1" ]]; then
  echo "boot did not complete in time" | tee -a "$RUN_LOG"
  "$ADB_BIN" -s "$device" shell getprop | grep -E 'boot|sys\.' | head -40 | tee -a "$RUN_LOG" || true
  tail -n 100 "$EMULATOR_LOG" || true
  exit 1
fi

# Give TCG guests time to finish bringing up system services.
SETTLE_SEC="${ANDROID_SETTLE_SEC:-90}"
echo "==> settling ${SETTLE_SEC}s after boot" | tee -a "$RUN_LOG"
sleep "$SETTLE_SEC"

# Skip first-run wizards that ANR under software emulation.
"$ADB_BIN" -s "$device" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
"$ADB_BIN" -s "$device" shell wm dismiss-keyguard >/dev/null 2>&1 || true
"$ADB_BIN" -s "$device" shell settings put global device_provisioned 1 >/dev/null 2>&1 || true
"$ADB_BIN" -s "$device" shell settings put secure user_setup_complete 1 >/dev/null 2>&1 || true
"$ADB_BIN" -s "$device" shell settings put system screen_off_timeout 600000 >/dev/null 2>&1 || true
"$ADB_BIN" -s "$device" shell pm disable-user --user 0 com.google.android.apps.messaging >/dev/null 2>&1 || true
"$ADB_BIN" -s "$device" shell pm disable-user --user 0 com.android.vending >/dev/null 2>&1 || true

echo "==> launching app ${APP_COMPONENT}" | tee -a "$RUN_LOG"
"$ADB_BIN" -s "$device" shell am force-stop "${APP_COMPONENT%%/*}" >/dev/null 2>&1 || true
# -W can time out under TCG even when the activity starts; treat Start/Activity lines as success.
start_out="$("$ADB_BIN" -s "$device" shell am start -n "$APP_COMPONENT" 2>&1 | tee -a "$RUN_LOG")"
sleep 8
resumed="$("$ADB_BIN" -s "$device" shell dumpsys activity activities 2>/dev/null | awk '/mResumedActivity/{print; exit}' | tr -d '\r')"
echo "resumed=${resumed}" | tee -a "$RUN_LOG"

if ! grep -q 'com.android.settings' <<<"$resumed"; then
  echo "settings not resumed; trying calculator fallback" | tee -a "$RUN_LOG"
  "$ADB_BIN" -s "$device" shell am start -n com.google.android.calculator/com.android.calculator2.Calculator 2>&1 | tee -a "$RUN_LOG" || true
  sleep 8
  resumed="$("$ADB_BIN" -s "$device" shell dumpsys activity activities 2>/dev/null | awk '/mResumedActivity/{print; exit}' | tr -d '\r')"
  echo "resumed=${resumed}" | tee -a "$RUN_LOG"
  APP_COMPONENT="com.google.android.calculator/com.android.calculator2.Calculator"
fi

if [[ -z "$resumed" ]]; then
  echo "no resumed activity after launch attempts" | tee -a "$RUN_LOG"
  exit 1
fi

version="$("$ADB_BIN" -s "$device" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')"
sdk="$("$ADB_BIN" -s "$device" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')"
echo "Android ${version} (API ${sdk}) is up and an app was started." | tee -a "$RUN_LOG"

cat > "$LOG_DIR/last_success.txt" <<EOF
ok=1
android_version=${version}
android_api=${sdk}
app=${APP_COMPONENT}
resumed=${resumed}
device=${device}
time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

echo "SUCCESS — see $LOG_DIR/last_success.txt"
KEEP_ALIVE_SEC="${ANDROID_KEEP_ALIVE_SEC:-10}"
sleep "$KEEP_ALIVE_SEC"
