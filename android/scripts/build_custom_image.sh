#!/usr/bin/env bash
# Build a customised Android system image — the thing LDPlayer and BlueStacks ship as their own
# "version" of Android.
#
# Approach: the stock system.img is a GPT disk holding a `super` container with several ext4
# filesystems inside it. lpunpack/lpmake would be needed to change that layout, and they are not
# packaged for Ubuntu — but editing files *in place*, without resizing, leaves the layout alone.
# So each embedded ext4 is located by its superblock magic and loop-mounted directly.
#
# The stock image is never touched: it is copied under the SDK tree as oe_<device>, and the AVD's
# config.ini is pointed at the copy. Delete that directory to get back to stock.
#
#   ./android/scripts/build_custom_image.sh --device pixel_5
#   ./android/scripts/build_custom_image.sh --device pixel_5 --strip-apps
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

DEVICE=""
STRIP_APPS=0
while (($# > 0)); do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --strip-apps) STRIP_APPS=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$DEVICE" ]] || { echo "need --device <name> (see android/devices/)" >&2; exit 1; }

export ANDROID_DEVICE="$DEVICE"
android_env

API_LEVEL="${ANDROID_API_LEVEL:-30}"
SRC="$SDK_ROOT/system-images/android-${API_LEVEL}/${PROFILE_IMAGE_TAG}/x86_64"
DST="$SDK_ROOT/system-images/android-${API_LEVEL}/oe_${DEVICE}/x86_64"

[[ -f "$SRC/system.img" ]] || die "stock image missing at $SRC — run fetch_android.sh"
[[ -n "${DEVICE_BRAND:-}" ]] || die "device '$DEVICE' declares no identity; nothing to customise"

MNT=/mnt/oe_build
WORK_BP="$(mktemp)"

if [[ -d "$DST" ]]; then
  log "reusing existing custom image at $DST (delete it to rebuild from stock)"
else
  log "copying stock image → oe_${DEVICE} (~3 GiB, one-time per device)"
  mkdir -p "$(dirname "$DST")"
  cp -a "$SRC" "$DST"
fi

# Offset and size of every ext4 inside the container. Recomputed rather than hardcoded: they
# differ between system images and API levels.
mapfile -t VOLUMES < <(python3 - "$DST/system.img" <<'PY'
import struct, sys
path = sys.argv[1]
with open(path, "rb") as f:
    f.seek(0, 2); size = f.tell()
    off = 0
    while off < size:
        f.seek(off + 1024 + 56)
        if f.read(2) == b"\x53\xef":
            f.seek(off + 1024 + 4);  blocks = struct.unpack("<I", f.read(4))[0]
            f.seek(off + 1024 + 24); bs = 1024 << struct.unpack("<I", f.read(4))[0]
            print(f"{off} {blocks * bs}")
        off += 1024 * 1024
PY
)
(( ${#VOLUMES[@]} )) || die "no ext4 filesystems found inside $DST/system.img"
log "found ${#VOLUMES[@]} filesystem(s) inside the super container"

LOOPDEV=""
cleanup() {
  mountpoint -q "$MNT" && umount "$MNT" 2>/dev/null || true
  [[ -n "$LOOPDEV" ]] && losetup -d "$LOOPDEV" 2>/dev/null || true
  LOOPDEV=""
}
trap 'cleanup; rm -f "$WORK_BP"' EXIT

mkdir -p "$MNT"
patched=0
stripped=0

for vol in "${VOLUMES[@]}"; do
  off="${vol%% *}"
  len="${vol##* }"
  cleanup

  LOOPDEV="$(losetup --find --show --offset "$off" --sizelimit "$len" "$DST/system.img" 2>/dev/null)" || {
    LOOPDEV=""; continue
  }

  # build.prop is rewritten with debugfs rather than through a mount.
  #
  # These volumes carry ext4's `shared_blocks` feature (identical blocks deduplicated to shrink
  # the image) and the main one is 100% full, so the kernel refuses a read-write mount and
  # `e2fsck -E unshare_blocks` cannot help — un-deduplicating needs free blocks that do not exist.
  # debugfs edits an unmounted filesystem directly and is unaffected by both.
  for rel in build.prop system/build.prop system_ext/build.prop product/build.prop etc/build.prop; do
    debugfs -R "dump /$rel $WORK_BP" "$LOOPDEV" >/dev/null 2>&1 || true
    [[ -s "$WORK_BP" ]] || continue

    python3 - "$WORK_BP" <<PY
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

src = open(path, encoding="utf-8", errors="replace").read()
out = []
for line in src.splitlines():
    m = re.match(r"^(ro\.product\.(?:[a-z_]+\.)?)(brand|manufacturer|model|name|device)=", line)
    if m:
        out.append(f"{m.group(1)}{m.group(2)}={ident[m.group(2)]}"); continue
    if fingerprint and re.match(r"^ro\.[a-z_.]*build\.fingerprint=", line):
        out.append(re.sub(r"=.*\$", "=" + fingerprint, line)); continue
    if build_id and re.match(r"^ro\.[a-z_.]*build\.id=", line):
        out.append(re.sub(r"=.*\$", "=" + build_id, line)); continue
    out.append(line)

# Read-only properties keep their FIRST definition, so every line is rewritten in place and
# nothing is appended. The file is held at its original byte length: the volume is full, so a
# larger file would have no blocks to grow into.
data = ("\n".join(out) + "\n").encode()
orig = len(src.encode())
if len(data) < orig:
    data += b"#" + b"x" * (orig - len(data) - 2) + b"\n"
elif len(data) > orig:
    raise SystemExit(f"patched build.prop grew ({len(data)} > {orig}); refusing to write")
open(path, "wb").write(data)
PY

    if debugfs -w -R "rm /$rel" "$LOOPDEV" >/dev/null 2>&1 &&
       debugfs -w -R "write $WORK_BP $rel" "$LOOPDEV" >/dev/null 2>&1; then
      log "  patched ${rel}"
      patched=$((patched + 1))
    fi
    : > "$WORK_BP"
  done

  # App stripping still needs a real mount (recursive directory removal). Volumes that refuse a
  # writable mount are skipped rather than failing the build — identity is already applied above.
  if ! mount -o rw "$LOOPDEV" "$MNT" 2>/dev/null; then
    cleanup
    continue
  fi

  # build.prop can sit at the volume root or one level down, depending on which logical
  # partition this is.
  if (( STRIP_APPS )); then
    for d in app priv-app system/app system/priv-app product/app product/priv-app; do
      base="$MNT/$d"
      [[ -d "$base" ]] || continue
      for pkg in Calendar DeskClock Email Music Gallery2 Camera2 Calculator \
                 PrintSpooler BasicDreams LiveWallpapersPicker WallpaperCropper \
                 Traceur BookmarkProvider messaging; do
        if [[ -d "$base/$pkg" ]]; then
          rm -rf "$base/$pkg" && stripped=$((stripped + 1))
        fi
      done
    done
  fi

  sync
  cleanup
done

(( patched > 0 )) || die "no build.prop was patched — image layout may differ from expectations"

log "custom image ready: $DST"
log "  identity: ${DEVICE_BRAND} ${DEVICE_MODEL} (${DEVICE_DEVICE})"
log "  build.prop files patched: ${patched}"
(( STRIP_APPS )) && log "  system apps removed: ${stripped}"
log ""
log "point an AVD at it with:  ./android/scripts/setup_avd.sh   (ANDROID_DEVICE=${DEVICE})"
