#!/usr/bin/env bash
# Rewrite the guest's hardware identity to match the selected device profile.
#
# Why this exists rather than the emulator's -prop flag: ro.* properties are immutable once init
# has set them from build.prop, so a boot-time -prop cannot override an identity the image already
# declares. Changing it for real means editing build.prop inside the image — which is precisely
# what LDPlayer and BlueStacks do by shipping a modified ROM.
#
# On API 30 identity is split per partition (ro.product.<partition>.<key>) and init resolves a
# winner across odm > vendor > product > system_ext > system, so every present build.prop is
# patched rather than guessing which one wins.
#
# Requires a boot with a writable system:
#   ANDROID_WRITABLE_SYSTEM=1 ANDROID_DEVICE=pixel_5 ./android/bin/open-emu start --cold
#   ANDROID_DEVICE=pixel_5 ./android/scripts/customize_device.sh
#   ./android/bin/open-emu provision      # fold into the snapshot
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"
android_env
require_sdk

[[ -n "${DEVICE_BRAND:-}" ]] || die "device profile '${ANDROID_DEVICE:-generic}' sets no identity — nothing to apply"

device="$(adb_device)"
[[ -n "$device" ]] || die "Android is not running — start it with ANDROID_WRITABLE_SYSTEM=1 first"

adb_t() { local s="$1"; shift; timeout "${s}s" "$ADB_BIN" -s "$device" "$@"; }

log "applying device profile '${DEVICE_NAME}' to the guest image"

adb_t 30 root >/dev/null 2>&1 || true
sleep 3
device="$(wait_for_adb_device 60)" || die "device vanished after adb root"

# dm-verity protects /system, and `adb remount` reports success while writes still silently fail.
# Verity can only be turned off across a reboot, so disable → reboot → root → remount is the only
# sequence that actually yields a writable system on an API 30 image.
verity="$(adb_t 20 shell getprop ro.boot.veritymode 2>/dev/null | tr -d '\r')"
if [[ "$verity" != "disabled" ]]; then
  log "disabling dm-verity (requires a reboot)"
  adb_t 60 disable-verity 2>&1 | sed 's/^/    /' | head -4
  adb_t 30 reboot >/dev/null 2>&1 || true
  sleep 8
  device="$(wait_for_adb_device 180)" || die "guest did not return after the verity reboot"
  wait_for_boot "$device" 300 || die "guest did not reach boot_completed after the verity reboot"
  adb_t 30 root >/dev/null 2>&1 || true
  sleep 3
  device="$(wait_for_adb_device 60)" || die "device vanished after adb root"
fi

adb_t 90 remount >/dev/null 2>&1 || true

# Trust a real write, not remount's exit status — it reports success on a still-read-only system.
if ! adb_t 20 shell 'touch /system/.oe_rw_probe 2>/dev/null && echo ok' | grep -q ok; then
  die "/system is still read-only after remount — boot with ANDROID_WRITABLE_SYSTEM=1:
    ANDROID_WRITABLE_SYSTEM=1 ./android/bin/open-emu start --cold"
fi
adb_t 20 shell rm -f /system/.oe_rw_probe >/dev/null 2>&1 || true
log "/system is writable"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

patched=0
for prop_file in /system/build.prop /vendor/build.prop /product/build.prop \
                 /system/system_ext/build.prop /odm/etc/build.prop; do
  if ! adb_t 20 shell test -f "$prop_file" 2>/dev/null; then
    continue
  fi

  local_copy="$WORK/$(echo "$prop_file" | tr '/' '_')"
  adb_t 60 pull "$prop_file" "$local_copy" >/dev/null 2>&1 || continue
  [[ -s "$local_copy" ]] || continue

  # Replace only keys that already exist. Appending is useless for read-only properties: init
  # keeps the FIRST definition it sees, so a duplicate at the end would be ignored.
  python3 - "$local_copy" <<PY
import re, sys
path = sys.argv[1]
ident = {
    "brand":        "${DEVICE_BRAND}",
    "manufacturer": "${DEVICE_MANUFACTURER}",
    "model":        "${DEVICE_MODEL}",
    "name":         "${DEVICE_PRODUCT}",
    "device":       "${DEVICE_DEVICE}",
}
fingerprint = "${DEVICE_FINGERPRINT}"
build_id = "${DEVICE_BUILD_ID}"

out = []
for line in open(path, encoding="utf-8", errors="replace").read().splitlines():
    m = re.match(r"^(ro\.product\.(?:[a-z_]+\.)?)(brand|manufacturer|model|name|device)=", line)
    if m and m.group(2) in ident:
        out.append(f"{m.group(1)}{m.group(2)}={ident[m.group(2)]}")
        continue
    if re.match(r"^ro\.[a-z_.]*build\.fingerprint=", line) and fingerprint:
        out.append(re.sub(r"=.*$", "=" + fingerprint, line))
        continue
    if re.match(r"^ro\.[a-z_.]*build\.id=", line) and build_id:
        out.append(re.sub(r"=.*$", "=" + build_id, line))
        continue
    out.append(line)

open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY

  if adb_t 60 push "$local_copy" "$prop_file" >/dev/null 2>&1; then
    adb_t 20 shell chmod 644 "$prop_file" >/dev/null 2>&1 || true
    log "  patched $prop_file"
    patched=$((patched + 1))
  else
    log "  WARNING: could not write $prop_file (still read-only?)"
  fi
done

(( patched > 0 )) || die "no build.prop could be written — is the system actually writable?"

log "rebooting the guest so init re-reads the properties"
adb_t 30 reboot >/dev/null 2>&1 || true
sleep 8
device="$(wait_for_adb_device 180)" || die "guest did not come back after reboot"
wait_for_boot "$device" 300 || die "guest did not reach boot_completed after reboot"

log "guest now reports:"
for p in ro.product.brand ro.product.manufacturer ro.product.model ro.product.device ro.build.fingerprint; do
  printf '  %-28s %s\n' "$p" "$("$ADB_BIN" -s "$device" shell getprop "$p" 2>/dev/null | tr -d '\r')"
done

log "run 'open-emu provision' to bake this into the snapshot"
