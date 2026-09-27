#!/bin/sh
# Builds ext4-fixture.img.gz: a small ext4 volume with the exact feature set of the logical
# partitions inside Google's API 30 system.img, for the ROM toolchain's tests.
#
# The fixture is committed (it gzips to a few KB); this script is the recipe, so it can be read,
# changed and regenerated rather than trusted as an opaque blob. Needs e2fsprogs — run it in WSL:
#
#   wsl -e sh desktop/test/fixtures/rom/make-ext4-fixture.sh
#
# What it has to exercise:
#   - the stock feature set, and nothing else (see FEATURES)
#   - more than one block group, with small groups so the image stays tiny
#   - a hashed (dir_index) directory, which only happens past one block of entries
#   - an app-shaped tree to remove (app/Bloat/Bloat.apk + oat/x86_64/…), a build.prop to replace,
#     an empty media/ directory to add into, and a file big enough to need several blocks
#   - security.selinux on every inode, in the inode, as Android's images carry it
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SRC="$WORK/src"
IMG="$WORK/ext4-fixture.img"

mkdir -p "$SRC/system/app/Bloat/oat/x86_64" "$SRC/system/app/Keep" "$SRC/system/priv-app/Other" \
         "$SRC/system/media" "$SRC/system/etc/many"

printf 'ro.build.display.id=fixture-1\nro.product.system.brand=Android\nro.product.system.model=mainline\nro.product.system.name=sdk_phone_x86_64\nro.product.system.device=generic_x86_64\nro.system.build.fingerprint=Android/sdk_phone_x86_64/generic_x86_64:11/RSR1.210722.013.A2/10067904:userdebug/test-keys\n' \
  > "$SRC/system/build.prop"

# Deterministic "APK" contents: several blocks each, distinct per file.
dd if=/dev/zero bs=4096 count=3 2>/dev/null | tr '\0' 'B' > "$SRC/system/app/Bloat/Bloat.apk"
dd if=/dev/zero bs=4096 count=1 2>/dev/null | tr '\0' 'O' > "$SRC/system/app/Bloat/oat/x86_64/Bloat.odex"
dd if=/dev/zero bs=4096 count=2 2>/dev/null | tr '\0' 'K' > "$SRC/system/app/Keep/Keep.apk"
dd if=/dev/zero bs=4096 count=1 2>/dev/null | tr '\0' 'P' > "$SRC/system/priv-app/Other/Other.apk"
# Spans more than one extent-worth of blocks for the reader.
dd if=/dev/zero bs=4096 count=40 2>/dev/null | tr '\0' 'L' > "$SRC/system/etc/large.bin"

# 300 entries with long names: several blocks of directory, so mke2fs builds an htree index.
i=0
while [ "$i" -lt 300 ]; do
  printf 'entry %s\n' "$i" > "$SRC/system/etc/many/a-deliberately-long-file-name-to-fill-directory-blocks-$i.txt"
  i=$((i + 1))
done

ln -s /system/build.prop "$SRC/system/build.prop.link"

# Exactly the stock volumes' features. -t ext2 starts from an empty feature set, so nothing
# arrives by default (no journal, no metadata_csum, no 64bit, no flex_bg, no resize_inode).
FEATURES="ext_attr,dir_index,filetype,extent,sparse_super,large_file,huge_file,uninit_bg,dir_nlink,extra_isize,^resize_inode"

# 4 KiB blocks and 1024 blocks per group: 6 groups in 24 MiB, so there are backup superblocks
# (groups 1, 3, 5) and groups with nothing in them (BLOCK_UNINIT).
E2FSPROGS_FAKE_TIME=1230768000 \
mke2fs -q -F -t ext2 -O "$FEATURES" -b 4096 -I 256 -g 1024 -N 512 -L system \
  -E root_owner=0:0 -U 5f1b0d6e-5e3a-4a4e-9a55-0e2c0a9b7f10 -d "$SRC" "$IMG" 6144

# The label every file on /system carries. ea_set per inode, in-inode (256-byte inodes have room).
LABEL="u:object_r:system_file:s0"
{
  echo "ea_set / security.selinux $LABEL"
  (cd "$SRC" && find . -mindepth 1) | sed 's#^\.##' | while read -r p; do
    echo "ea_set \"$p\" security.selinux $LABEL"
  done
  # shared_blocks, as e2fsdroid sets it on Android images. Our tests create a real shared block
  # themselves, because nothing in e2fsprogs will make one.
  echo "feature shared_blocks"
} > "$WORK/cmds"
debugfs -w -f "$WORK/cmds" "$IMG" >/dev/null 2>&1

# mke2fs -d writes every directory linear. -D rebuilds the multi-block ones as htree indexes, so
# etc/many becomes a real dir_index directory. Exit status 1 means "fixed something", which here
# is the point.
E2FSPROGS_FAKE_TIME=1230768000 e2fsck -fyD "$IMG" >/dev/null 2>&1 || [ $? -eq 1 ]

e2fsck -fn "$IMG"

gzip -9 -n -c "$IMG" > "$HERE/ext4-fixture.img.gz"
echo "wrote $HERE/ext4-fixture.img.gz ($(wc -c < "$HERE/ext4-fixture.img.gz") bytes)"
