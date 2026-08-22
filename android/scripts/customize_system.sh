#!/usr/bin/env bash
# Strip system apps from the guest — the customization LDPlayer and BlueStacks ship as a
# purpose-built ROM.
#
# Two mechanisms, in increasing order of permanence:
#
#   disable  (default)  `pm disable-user` per package. Reversible, no writable system needed, and
#                       the effect lands in userdata so the snapshot keeps it. The app stays on
#                       disk but never starts.
#   strip    (--strip)  Deletes the APK directory from /system. Needs a boot with
#                       ANDROID_WRITABLE_SYSTEM=1 and `adb remount`; the change persists in the
#                       AVD's system qcow2 overlay. Reclaims space and guarantees the package
#                       cannot come back, but is undone by re-running setup_avd.sh.
#
# Run `provision` afterwards (or let this script re-save) so the snapshot reflects the new state —
# otherwise every warm boot restores the un-stripped guest.
#
#   ./android/scripts/customize_system.sh              # disable the default bloat list
#   ./android/scripts/customize_system.sh --strip      # delete them from /system
#   ./android/scripts/customize_system.sh --list       # show what is installed and its size
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"
android_env

MODE=disable
LIST_ONLY=0
while (($# > 0)); do
  case "$1" in
    --strip) MODE=strip; shift ;;
    --disable) MODE=disable; shift ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Packages that cost boot time and serve no purpose in an emulator used for running apps.
# Deliberately conservative: nothing here is required to boot, launch apps, or use the network.
# Kept OUT on purpose: com.android.vending / com.google.android.gms (the "full" profile needs
# them), the launcher, SystemUI, Settings, and anything under com.android.providers.
BLOAT_PACKAGES=(
  com.android.calendar
  com.android.deskclock
  com.android.email
  com.android.dialer
  com.android.contacts
  com.android.messaging
  com.android.music
  com.android.gallery3d
  com.android.camera2
  com.android.calculator2
  com.android.traceur
  com.android.bookmarkprovider
  com.android.wallpaper.livepicker
  com.android.dreams.basic
  com.android.printspooler
  com.android.bips
  com.android.wallpapercropper
)

require_sdk
device="$(adb_device)"
[[ -n "$device" ]] || die "Android is not running — start it first"

adb_t() { local s="$1"; shift; timeout "${s}s" "$ADB_BIN" -s "$device" "$@"; }

if (( LIST_ONLY )); then
  log "installed packages from the bloat list:"
  for pkg in "${BLOAT_PACKAGES[@]}"; do
    path="$(adb_t 15 shell pm path "$pkg" 2>/dev/null | tr -d '\r' | head -1)"
    if [[ -n "$path" ]]; then
      printf '  %-45s %s\n' "$pkg" "${path#package:}"
    else
      printf '  %-45s (not present)\n' "$pkg"
    fi
  done
  exit 0
fi

if [[ "$MODE" == "strip" ]]; then
  log "remounting /system read-write"
  adb_t 30 root >/dev/null 2>&1 || true
  sleep 2
  if ! adb_t 60 remount 2>&1 | grep -qi 'succe'; then
    die "adb remount failed — reboot with ANDROID_WRITABLE_SYSTEM=1 first:
    ANDROID_WRITABLE_SYSTEM=1 ./android/bin/open-emu start --cold"
  fi
fi

removed=0
skipped=0
for pkg in "${BLOAT_PACKAGES[@]}"; do
  path="$(adb_t 15 shell pm path "$pkg" 2>/dev/null | tr -d '\r' | head -1)"
  if [[ -z "$path" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  if [[ "$MODE" == "strip" ]]; then
    apk_dir="$(dirname "${path#package:}")"
    # Refuse anything outside /system — a package resolving into /data is user-installed and not
    # ours to delete here.
    if [[ "$apk_dir" != /system/* ]]; then
      log "  skip $pkg (not in /system: $apk_dir)"
      skipped=$((skipped + 1))
      continue
    fi
    adb_t 30 shell rm -rf "$apk_dir" >/dev/null 2>&1 && removed=$((removed + 1))
  else
    adb_t 30 shell pm disable-user --user 0 "$pkg" >/dev/null 2>&1 && removed=$((removed + 1))
  fi
done

log "${MODE}d ${removed} package(s), skipped ${skipped} not present"

if [[ "$MODE" == "strip" ]]; then
  log "rebooting so the package manager rescans /system"
  adb_t 30 shell stop >/dev/null 2>&1 || true
  adb_t 30 shell start >/dev/null 2>&1 || true
  sleep 5
  wait_for_boot "$device" 300 || log "WARNING: guest did not report boot_completed after restart"
fi

log "done — run 'open-emu provision' to fold this into the snapshot"
