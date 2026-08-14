#!/usr/bin/env bash
# Unit tests for fast-boot helpers — no SDK, no emulator, no KVM required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export ANDROID_SDK_ROOT="$TMP/sdk"
export ANDROID_AVD_HOME="$TMP/avd"
export ANDROID_LOG_DIR="$TMP/logs"
export ANDROID_STATE_DIR="$TMP/state"
export ANDROID_APPS_DIR="$TMP/apps"
export ANDROID_SNAPSHOT_NAME="booted"

# shellcheck disable=SC1091
source "$ROOT/lib/common.sh"
android_env

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

# --- avd_config.py: rewrite only when a value actually changes ---
cfg="$TMP/config.ini"
cat > "$cfg" <<'EOF'
hw.cpu.ncore=2
hw.ramSize=3072
hw.gpu.mode=swiftshader_indirect
# comment stays
runtime.network.latency=none
EOF
cp "$cfg" "$TMP/config.ini.orig"
state="$(avd_config_apply "$cfg" hw.cpu.ncore=2 hw.ramSize=3072 hw.gpu.mode=swiftshader_indirect)"
[[ "$state" == "unchanged" ]] || fail "identical apply should be unchanged (got $state)"
cmp -s "$cfg" "$TMP/config.ini.orig" || fail "unchanged apply must not rewrite the file"
state="$(avd_config_apply "$cfg" hw.cpu.ncore=4)"
[[ "$state" == "changed" ]] || fail "core change should be changed (got $state)"
[[ "$(avd_config_get "$cfg" hw.cpu.ncore)" == "4" ]] || fail "ncore not updated"
grep -q '^# comment stays$' "$cfg" || fail "comments must be preserved"
pass "avd_config apply/get"

# --- GPU selection ---
HAS_KVM=0
[[ "$(launch_gpu_mode host)" == "swiftshader_indirect" ]] || fail "TCG must force software GPU"
[[ "$(launch_gpu_mode swiftshader)" == "swiftshader_indirect" ]] || fail "swiftshader normalizes to _indirect"
HAS_KVM=1
[[ "$(launch_gpu_mode host)" == "host" ]] || fail "KVM host GPU should pass through"
[[ "$(launch_gpu_mode auto)" == "auto" ]] || fail "KVM auto GPU should pass through"
[[ "$(launch_gpu_mode swiftshader)" == "swiftshader_indirect" ]] || fail "KVM software GPU still normalizes"
[[ "$(normalize_gpu_mode "")" == "swiftshader_indirect" ]] || fail "empty GPU defaults to software"
pass "GPU selection"

# --- emulator flags: snapshot vs cold, headless audio ---
SNAPSHOT_NAME="booted"
mapfile -t snap_flags < <(emulator_flags auto on 1 1)
printf '%s\n' "${snap_flags[@]}" | grep -qx -- '-snapshot' || fail "snapshot flags missing -snapshot"
printf '%s\n' "${snap_flags[@]}" | grep -qx -- 'booted' || fail "snapshot flags missing name"
printf '%s\n' "${snap_flags[@]}" | grep -qx -- '-no-snapshot-save' || fail "snapshot path should not re-save"
printf '%s\n' "${snap_flags[@]}" | grep -qx -- '-no-snapshot-load' && fail "snapshot path must not pass -no-snapshot-load"
printf '%s\n' "${snap_flags[@]}" | grep -qx -- '-no-window' || fail "headless missing -no-window"
printf '%s\n' "${snap_flags[@]}" | grep -qx -- '-no-audio' || fail "headless missing -no-audio"
printf '%s\n' "${snap_flags[@]}" | grep -qx -- '-skip-adb-auth' || fail "missing -skip-adb-auth"
printf '%s\n' "${snap_flags[@]}" | grep -qx -- '-no-boot-anim' || fail "missing -no-boot-anim"

mapfile -t cold_flags < <(emulator_flags "$SOFTWARE_GPU" off 0 0)
printf '%s\n' "${cold_flags[@]}" | grep -qx -- '-no-snapshot-load' || fail "cold path missing -no-snapshot-load"
printf '%s\n' "${cold_flags[@]}" | grep -qx -- '-snapshot' && fail "cold path must not load a snapshot"
printf '%s\n' "${cold_flags[@]}" | grep -qx -- '-no-window' && fail "headed path should keep a window"
printf '%s\n' "${cold_flags[@]}" | grep -qx -- '-no-audio' && fail "headed path should keep audio"
pass "emulator flags"

# --- should_load_snapshot ---
mkdir -p "$AVD_HOME/OpenEmulator_API30.avd/snapshots/booted"
HAS_KVM=1
should_load_snapshot 0 unchanged OpenEmulator_API30 || fail "KVM + snapshot + unchanged should load"
should_load_snapshot 1 unchanged OpenEmulator_API30 && fail "--cold must not load snapshot"
should_load_snapshot 0 changed OpenEmulator_API30 && fail "hardware change must not load snapshot"
HAS_KVM=0
should_load_snapshot 0 unchanged OpenEmulator_API30 && fail "TCG must not load snapshot"
rm -rf "$AVD_HOME/OpenEmulator_API30.avd/snapshots"
HAS_KVM=1
should_load_snapshot 0 unchanged OpenEmulator_API30 && fail "missing snapshot dir must not load"
pass "should_load_snapshot"

# --- timeouts: snapshot is a short fuse, not a 5-minute wait ---
[[ "$(boot_timeout_for 1)" -le 60 ]] || fail "snapshot boot timeout should be ≤60s"
[[ "$(adb_timeout_for 1)" -le 60 ]] || fail "snapshot adb timeout should be ≤60s"
HAS_KVM=1
[[ "$(boot_timeout_for 0)" -ge 120 ]] || fail "KVM cold boot timeout too short"
HAS_KVM=0
[[ "$(boot_timeout_for 0)" -ge 600 ]] || fail "TCG cold boot timeout too short"
pass "timeouts"

# --- snapshot-failure log heuristic ---
printf 'qemu: Failed to load snapshot booted\n' > "$TMP/emu.log"
snapshot_load_failed_in_log "$TMP/emu.log" || fail "should detect snapshot failure"
printf 'emulator: info: started\n' > "$TMP/emu.log"
snapshot_load_failed_in_log "$TMP/emu.log" && fail "clean log is not a snapshot failure"
pass "snapshot log heuristic"

# --- sync_avd_runtime_config is a no-op when values already match ---
mkdir -p "$AVD_HOME/OpenEmulator_API30.avd"
cat > "$AVD_HOME/OpenEmulator_API30.avd/config.ini" <<'EOF'
hw.cpu.ncore=2
hw.ramSize=3072
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
runtime.network.latency=none
runtime.network.speed=full
EOF
cp "$AVD_HOME/OpenEmulator_API30.avd/config.ini" "$TMP/sync.orig"
state="$(sync_avd_runtime_config OpenEmulator_API30 2 3072 swiftshader_indirect)"
[[ "$state" == "unchanged" ]] || fail "matching sync should be unchanged"
cmp -s "$AVD_HOME/OpenEmulator_API30.avd/config.ini" "$TMP/sync.orig" || fail "matching sync rewrote config.ini"
state="$(sync_avd_runtime_config OpenEmulator_API30 4 3072 swiftshader_indirect)"
[[ "$state" == "changed" ]] || fail "core mismatch should be changed"
pass "sync_avd_runtime_config"

# --- instance start must go through boot.sh (regression: it used to force -no-snapshot-load) ---
grep -q -- '-no-snapshot-load' "$ROOT/lib/instances.sh" && fail "instances.sh must not hardcode -no-snapshot-load"
grep -q -- '-no-snapshot-load' "$ROOT/bin/open-emu" && fail "open-emu must not hardcode -no-snapshot-load"
grep -q 'launch_and_wait' "$ROOT/lib/instances.sh" || fail "instance_start should call launch_and_wait"
grep -q 'launch_and_wait' "$ROOT/bin/open-emu" || fail "start_emulator should call launch_and_wait"
pass "instance start uses shared snapshot path"

# --- host profile still writes a usable GPU ---
detect_host_profile
# shellcheck disable=SC1090
source "$PROFILE_FILE"
[[ "$GPU_MODE" == "swiftshader_indirect" || "$GPU_MODE" == "auto" || "$GPU_MODE" == "host" ]] || fail "unexpected GPU_MODE=$GPU_MODE"
pass "detect_host_profile"

echo "all boot helper tests passed"
