#!/usr/bin/env bash
# Provision a freshly booted Android guest for real-world use, then save snapshot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"
android_env
require_sdk
adb_start

device="$(adb_device)"
[[ -n "$device" ]] || die "Android is not running; start it first"

adb_t() {
  local secs="$1"; shift
  timeout "${secs}s" "$ADB_BIN" -s "$device" "$@"
}

log "provisioning device ${device} for real workloads"

adb_t 60 wait-for-device
wait_for_boot "$device" 600 || die "boot incomplete during provision"

# --- Setup wizard / lockscreen ---
adb_t 30 shell settings put global device_provisioned 1
adb_t 30 shell settings put secure user_setup_complete 1
adb_t 30 shell settings put global package_verifier_enable 0
adb_t 30 shell settings put global verifier_verify_adb_installs 0
adb_t 30 shell settings put global install_non_market_apps 1 2>/dev/null || true
adb_t 30 shell settings put secure install_non_market_apps 1 2>/dev/null || true
adb_t 30 shell locksettings set-disabled true 2>/dev/null || true
adb_t 30 shell input keyevent KEYCODE_WAKEUP || true
adb_t 30 shell wm dismiss-keyguard || true

# --- Snappy UI ---
adb_t 30 shell settings put global window_animation_scale 0.5
adb_t 30 shell settings put global transition_animation_scale 0.5
adb_t 30 shell settings put global animator_duration_scale 0.5
adb_t 30 shell settings put system screen_off_timeout 600000
adb_t 30 shell settings put global stay_on_while_plugged_in 3

# --- Networking ---
adb_t 30 shell settings put global airplane_mode_on 0
adb_t 30 shell svc wifi enable 2>/dev/null || true
adb_t 30 shell svc data enable 2>/dev/null || true
adb_t 30 shell cmd wifi set-wifi-enabled enabled 2>/dev/null || true
adb_t 30 shell settings put global mobile_data 1 2>/dev/null || true
adb_t 30 shell settings put global wifi_on 1 2>/dev/null || true
adb_t 30 shell settings put global private_dns_mode opportunistic 2>/dev/null || \
  adb_t 30 shell settings put global private_dns_mode off 2>/dev/null || true

# --- Audio ---
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/connectivity.sh"
apply_guest_audio "$device"

# --- Bluetooth (virtual adapter in the emulator) ---
apply_guest_bluetooth "$device"

# Keep Play / GMS available for real apps.
adb_t 60 shell pm enable com.android.vending >/dev/null 2>&1 || true
adb_t 60 shell pm enable com.google.android.gms >/dev/null 2>&1 || true
adb_t 30 shell am force-stop com.google.android.apps.messaging 2>/dev/null || true

adb_t 30 shell sm set-force-adoptable true 2>/dev/null || true

if wait_for_network "$device" 90; then
  log "guest network OK"
else
  log "WARNING: guest network not confirmed yet"
fi

if [[ -e /dev/kvm ]]; then
  log "running speed-profile compile (KVM host)"
  adb_t 300 shell cmd package compile -m speed-profile -f com.android.settings >/dev/null 2>&1 || true
  adb_t 300 shell cmd package compile -m speed-profile -f com.android.systemui >/dev/null 2>&1 || true
else
  log "skipping dexopt on TCG host"
fi

# --- Snapshot first so APK install stalls cannot block the fast-boot path ---
adb_t 30 shell input keyevent KEYCODE_HOME || true
sleep 3

log "saving snapshot '${SNAPSHOT_NAME}'"
if ! adb_t 180 emu avd snapshot save "$SNAPSHOT_NAME"; then
  log "adb emu snapshot failed; trying emulator console via nc"
  token_file="$HOME/.emulator_console_auth_token"
  token=""
  [[ -f "$token_file" ]] && token="$(cat "$token_file")"
  {
    echo "auth ${token}"
    echo "avd snapshot save ${SNAPSHOT_NAME}"
    echo "quit"
  } | timeout 60s nc 127.0.0.1 5554 || die "snapshot save failed"
fi

for _ in $(seq 1 60); do
  snapshot_exists && break
  sleep 2
done
snapshot_exists || die "snapshot directory missing after save"

AVD_DIR="$AVD_HOME/${AVD_NAME}.avd"
sed -i \
  -e 's/^fastboot.forceColdBoot=.*/fastboot.forceColdBoot=no/' \
  -e 's/^fastboot.forceFastBoot=.*/fastboot.forceFastBoot=yes/' \
  -e "s/^fastboot.chosenSnapshotFile=.*/fastboot.chosenSnapshotFile=${SNAPSHOT_NAME}/" \
  -e 's/^fastboot.forceChosenSnapshotBoot=.*/fastboot.forceChosenSnapshotBoot=yes/' \
  "$AVD_DIR/config.ini"

# --- Install APKs (best-effort), then refresh snapshot ---
shopt -s nullglob
apk_count=0
for apk in "$APPS_DIR"/*.apk; do
  log "installing $(basename "$apk")"
  set +e
  out="$(adb_t 600 install -r -g -d "$apk" 2>&1)"
  rc=$?
  set -e
  echo "$out" | tee -a "$RUNTIME_LOG"
  if grep -qi Success <<<"$out" || (( rc == 0 )); then
    apk_count=$((apk_count + 1))
  else
    log "WARNING: install of $(basename "$apk") failed (rc=${rc})"
  fi
done
log "installed ${apk_count} apk(s) from android/apps"

if (( apk_count > 0 )); then
  log "refreshing snapshot '${SNAPSHOT_NAME}' with installed apps"
  adb_t 30 shell input keyevent KEYCODE_HOME || true
  sleep 2
  adb_t 180 emu avd snapshot save "$SNAPSHOT_NAME" || log "WARNING: snapshot refresh failed"
  sleep 5
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/provisioned_at"
echo "$SNAPSHOT_NAME" > "$STATE_DIR/snapshot_name"
log "provision complete — snapshot '${SNAPSHOT_NAME}' ready"
