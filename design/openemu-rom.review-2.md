# Review: openemu ROM plan, round two

## 1. Verdict

**DISAGREE.** The re-sign, the debloat frees, the linear directory scans, wallpaper in phase A, and the backup superblocks are the right phase A. The ext4 gate as written still refuses this system volume, so the image in the definition of done is never produced.

## 2. Blocking issues

**External xattr blocks are on the system volume, and the plan refuses them.**

`/system/bin/run-as` keeps `security.capability` in an external block (`i_file_acl`); the in-inode region already holds `security.selinux`. The plan opens a volume only if every in-use inode has `i_file_acl == 0`. The system image fails that check, the build stops, and nothing boots or reaches `e2fsck -fn`.

Count the block with the other references. Free it when the count hits zero. While another inode still points at it, decrement `h_refcount` in the block header (32-byte header, count at offset 4) so it stays equal to the number of inodes. `h_blocks` is 1 and `h_hash` does not cover the count. `ext4.ts` already does this; the plan should say that, and drop the volume-wide refusal.

## 3. Non-blocking notes

- The five departures from the previous review hold. Unlink-without-free fails `e2fsck` pass 4. A linear scan is the right reader, including for an htree. Wallpaper stays in phase A. Orange stays out. Backups stay in.
- Re-sign with `HASHTREE_DISABLED` only, digest over the 4480-byte top-level vbmeta followed by the 1664-byte system vbmeta, is the boot that was measured. Empty `ro.boot.verifiedbootstate`, `ro.boot.vbmeta.device_state`, and `ro.boot.veritymode` match stock.
- `ro.build.fingerprint` is derived after the product props are resolved, from `ro.product.brand`, `ro.product.name`, `ro.product.device`, and the unchanged release, id, incremental, type, and tags. Rewriting those keys in all four files produces the fingerprint in the recipe. The same boot already showed `ro.product.model`.
- The feature gate allows a subset. This image has the full measured set. A later image without `ext_attr` would still pass and the new labels would not stick.
- A new file that needs a fifth extent fails the build. After debloat that should be a contiguous run; the failure is loud.
- fsck-lite does not check that `..` names the parent, that xattr entry hashes match, or that backup superblocks match the primary. `e2fsck -fn` on the built image remains the merge bar.

## 4. ext4.ts findings

`mkdir`: a parent whose `i_links_count` is already the `dir_nlink` sentinel 1 is rewritten to 2 (`links + 1 >= 65000 ? 1 : links + 1`). `e2fsck` and `verify()` then report a link-count mismatch, because a count of 1 is accepted only when the real number of links is at least 65000. No directory here is at the sentinel, so phase A does not hit it. Leave 1 as 1.

The rest of the editor matches the image. In-place replace keeps the inode and its label, frees a tail only through the refcount, and puts `i_blocks` back in 512-byte units with `HUGE_FILE` clear, including one block for an external xattr. `removeTree` drops a parent link only while the count is a real tally (`> 2` and below 65000), so a sentinel 1 stays. Overlap inside one inode, a non-zero `s_last_orphan`, and `h_refcount` are checked. Backup superblocks are written at group 1 and the powers of 3, 5, and 7, with `s_block_group_nr` set, and the group checksum is the uninit_bg crc16 over the uuid, the group number, and the descriptor up to `bg_checksum`.
