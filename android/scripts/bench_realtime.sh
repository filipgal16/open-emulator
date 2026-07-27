#!/usr/bin/env bash
# Benchmark cold vs snapshot boot and verify install + launch + network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OE="$ROOT/bin/open-emu"
export ANDROID_HEADLESS=1

log() { echo "[bench] $*"; }

"$OE" stop >/dev/null 2>&1 || true
"$ROOT/scripts/setup_avd.sh"

log "cold start + provision (one-time)"
t0=$SECONDS
"$OE" start --cold
"$OE" provision
cold_provision=$((SECONDS - t0))
"$OE" stop
sleep 2

log "snapshot start"
t1=$SECONDS
"$OE" start
snap_boot=$((SECONDS - t1))

log "doctor"
"$OE" doctor

log "fetch + install sample APK"
"$ROOT/scripts/fetch_sample_apk.sh"
"$OE" install "$ROOT/apps/F-Droid.apk"
"$OE" launch "org.fdroid.fdroid/.views.main.MainActivity" || \
  "$OE" shell monkey -p org.fdroid.fdroid -c android.intent.category.LAUNCHER 1

"$OE" launch "com.android.settings/.Settings"

mkdir -p "$ROOT/logs"
cat > "$ROOT/logs/bench.txt" <<EOF
cold_provision_s=${cold_provision}
snapshot_boot_s=${snap_boot}
time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
cp "$ROOT/logs/bench.txt" "$ROOT/imported/bench.txt"
log "results:"
cat "$ROOT/logs/bench.txt"
log "done"
