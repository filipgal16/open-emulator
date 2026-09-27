# Review: openemu ROM plan

## 1. Verdict

**AGREE WITH CHANGES.** Disabling the top-level hashtree and booting with `androidboot.verifiedbootstate=orange` is the right way to make `/system` edits stick on this image, and it is already measured. Phase A as written still specifies an ext4 writer that will fail `e2fsck` or hide files, a cmdline recipe that drops part of the combination that actually booted, and an image swap that Windows and the current AVD code will not perform safely.

## 2. Correctness challenges

### libfs_avb and orange

The mechanism in the plan is right: `libfs_avb` allows `ERROR_VERIFICATION` / `PUBLIC_KEY_REJECTED` only when `androidboot.verifiedbootstate` is `orange`. `androidboot.vbmeta.device_state=unlocked` does not flip that gate. Flags must be `HASHTREE_DISABLED | VERIFICATION_DISABLED` (`|= 3`); orange alone leaves dm-verity and FEC in place. Rewriting `androidboot.vbmeta.digest` to the SHA-256 of the vbmeta image is required. Dropping `-writable-system` is required once that sticks, or the emulator keeps a qcow2 over the base and the next edit is invisible again.

The numbered "Proven" recipe is not the combination that booted. The boot that reached `VerificationDisabled` was flags `|= 3`, updated digest, **`androidboot.vbmeta.device_state=unlocked`**, and `androidboot.verifiedbootstate=orange`. The numbered list omits `device_state`. Stock is `locked` or absent; shipping orange without the unlocked device state is an untested cmdline. Upsert those params. Appending a second `verifiedbootstate` when the file already has `green` leaves both, and the one the kernel keeps is not defined by this plan.

Hash length is the AVB header's `256 + authentication_data_block_size + auxiliary_data_block_size`. On this image that is 6144. Derive it from the header and fail the build if it is not 6144, so a later image cannot be hashed at the wrong width and then described as a digest mismatch.

Side effects, on this userdebug API 30 guest:

- `ro.boot.verifiedbootstate=orange` is world-readable. `keystore` attestation reports unlocked. Play Integrity is irrelevant on an image with no GMS; that sentence in the risk table is right. Apps that read the property or an attestation chain still see an unlocked bootloader. That is not how LDPlayer presents a device. LDPlayer spoofs a locked, green boot. Orange is the cost of an unsigned vbmeta, not a property of "our ROM".
- `ro.debuggable` stays `1`. Orange does not change it, and `adb root` keeps working. Nothing to do.
- `apexd` treats orange as unlocked and will accept unverified APEX sessions. Preinstalled APEXes keep verifying with their own keys as long as `/system/apex` is not edited. Do not edit it in phase A.
- `update_verifier` skips its check only when `ro.boot.veritymode` is not `enforcing`. This boot succeeded without the plan mentioning `veritymode`, so this image did not boot-loop. Read the value on the next successful boot. If it is still `enforcing`, set `androidboot.veritymode=disabled` in the same textproto. An enforcing cmdline with no dm-verity device is the state that makes `update_verifier` fail on a stricter image.
- This profile already has its own AVD, `OpenEmulator_API30_openemu`, so the first boot is born orange and keymaster creates its keys under orange. Later recipe bumps stay orange. Keeping userdata across those bumps does not repeat a bootloader-unlock wipe. Pointing a userdata directory that has booted green at this image can invalidate keystore-wrapped keys. Do not do that.

### ext4 editor

Right, and worth keeping: refuse a feature set this code does not implement; edit through a window, not a 3 GB copy in RAM; refcount every block reachable from in-use inodes before freeing; never write a block whose count is above 1; do not allocate from `BLOCK_UNINIT` / `INODE_UNINIT` without initialising the bitmap first; stage and rename.

These parts are wrong or incomplete.

**Feature check.** "No feature outside the measured set" accepts a subset. A volume without `extent` would pass and then be parsed as a block map. Require the feature bitmask to equal the measured set.

**`dir_index`.** Removing a directory entry from an htree leaf, and leaving that leaf block allocated, is safe without touching the index. Remaining names still fall in that leaf's hash range, which is what `e2fsck` and `lookup` check. Inserting is not. The leaf is chosen by hashing the name with the directory's `hash_version` and the superblock `s_hash_seed` (half-MD4 on these images). The plan says "splitting a record in an existing block" and does not mention the hash. An entry placed in the wrong leaf is a file the kernel will not find: `open` returns `ENOENT`, the package is absent, and nothing logs an ext4 error. A full split (new leaf, dx entry, possible new tree level) is out of scope for phase A. Insert only into the leaf whose interval contains the hash, and fail the build if that leaf has no slack. `/system/app`, `/system/priv-app`, and likely `/system/media` are indexed. The wallpaper add is one insert into `/system/media` plus a new linear directory; it still has to hit the right leaf.

Read directories by walking leaves, not by treating every extent block as a dirent list. Internal dx nodes are not leaves. `.` and `..` sit in the root block; `..`'s `rec_len` skips the index. A scanner that ignores `rec_len` will treat hash/block pairs as names and debloat the wrong entry.

**New directory entries.** With `filetype` set, `file_type` has to match the inode mode (`1` file, `2` directory) or `e2fsck` fails. A new directory needs `.` and `..`, mode `0755`, `nlink` 2, and the parent's `nlink` incremented. The plan fixes parent `nlink` on remove and says nothing about create. `dir_nlink`'s sentinel is `nlink == 1` ("do not trust the count"). Do not decrement that value. New files are mode `0644`, uid 0, gid 0.

**`shared_blocks` and links.** The refcount rule is right. Extend it: inodes are not shared; blocks are. On unlink, decrement `i_links_count` and release the inode and its blocks only at 0. `/system/bin/toybox` is a hard link farm. Debloat does not touch it, but a remove-tree that always frees the inode will corrupt `bin` the first time it is pointed at a linked file. Extent-index blocks and data blocks both count. Overlapping extents inside one inode must be a build error, not a double decrement.

**`uninit_bg`.** The checksum is the `uninit_bg` crc16 from `ext2fs_group_desc_csum`, not `metadata_csum`'s crc32c. Initial crc `0xFFFF`, then `s_uuid`, then the group number as a little-endian `uint32`, then the 32-byte descriptor with `bg_checksum` (offset `0x1E`) treated as zero. Copy that function. `bg_itable_unused` is the untouched tail of the inode table, not a free count. Allocating below the high-water mark must not change it. Allocating into the tail decrements it and the inode must be zeroed first. Freeing an inode never increases it. Clearing `INODE_UNINIT` or `BLOCK_UNINIT` without writing a real bitmap, or writing the bitmap without clearing the flag, both fail `e2fsck -fn`. Read `s_desc_size` and refuse anything other than 32. Read `s_inode_size` (256) and the inode's own `i_extra_isize` to find the xattr header; do not assume the xattr starts at a constant offset after zeroing the inode.

**In-inode xattrs.** `security.selinux` values include the trailing NUL (`u:object_r:system_file:s0` is 26 bytes). `e_value_size` includes that NUL. Each entry's `e_hash` and the header `h_hash` are the ext4 xattr hashes (`ext2fs_ext_attr_hash_entry` / `ext2fs_ext_attr_rehash`). The kernel checks magic and bounds, so a wrong hash still mounts; `e2fsck` reports it and `rom:check` fails. An unlabeled `build.prop` is `unlabeled`, and init on enforcing is not granted read of that type. Preserve the existing xattr region on replace. For a new file, copy the region from an existing `system_file` inode when the label bytes are identical; if they are not, compute the hash. `i_file_acl != 0` is an external xattr block the plan does not refcount. Refuse the volume if any in-use inode has one. `/system/media(/.*)?` is `system_file` in the platform file contexts, so that label is the right one for the wallpaper and its directory.

**Extents, `huge_file`, orphans.** Set `i_size` and `i_blocks` in 512-byte units (`i_blocks_lo` / `i_blocks_high`). Do not set the unwritten bit (`0x8000` in `ee_len`); reads then return zeros. The in-inode extent header holds four extents. "A contiguous run" is not guaranteed after debloat punches holes. If the allocation needs more than four extents, build a depth-1 tree or fail the build. Do not leave `s_last_orphan` non-zero. Freed inodes are zeroed and their bitmap bit cleared; they are not parked on the orphan list. There is no journal, so a crash mid-edit is fine only because the staging file is thrown away.

**`sparse_super` backups.** The kernel uses the primary superblock and group-descriptor table. `e2fsck -fy` will restore a stale backup over the primary and undo the ROM. Update every sparse-super copy (groups 0, 1, and powers of 3, 5, and 7) whenever free counts or descriptors change, the way `ext2fs_flush` does. Also freeze `s_wtime` and `s_mtime`. Fixed inode timestamps do not make the image deterministic if the superblock still stamps the wall clock.

**Replace vs vendor.** Vendor has one free inode. Replace must repoint the existing inode. Allocating a new inode before the old one is freed fails the vendor `build.prop` edit even though the net inode count is unchanged. System has 56 free inodes only before debloat; create the wallpaper after the frees, not before.

**Paths.** Each logical volume is its own ext4. On the system volume the roots are `/system/app`, `/system/priv-app`, `/system/build.prop`, `/system/media/...`. On `product`, `system_ext`, and `vendor` they are `/app`, `/priv-app`, and `/build.prop`. The debloat table is written as `product/app`. An editor that opens the product window and looks up `/product/app` removes nothing and still writes a manifest that says it did.

**fsck-lite, as specified, passes the old bug.** "Every reachable block is marked" and "popcounts match the descriptors" are both true of an unlink that frees nothing, if the inode stays allocated. Also require the converse: every allocated block is metadata or reachable; every allocated inode has `nlink > 0` and a directory entry; `i_blocks` matches the extent; htree intervals contain the names in the leaf; xattr hashes match; `.` / `..` and `file_type` are valid; `s_last_orphan == 0`; no unwritten extents. The unit-test fixture has to be a filesystem with `shared_blocks`, an htree, `uninit_bg`, and an in-inode xattr. A small linear image will not exercise the code that corrupts the real volumes.

`ro.*` keeps the first definition. Identity has to be rewritten in place in all four `build.prop`s, including the unsuffixed `ro.product.model` / `brand` / `manufacturer` / `name` / `device`, `ro.build.fingerprint`, `ro.build.display.id`, `ro.build.description`, and `ro.build.product`. Appending `ro.config.wallpaper` or `ro.setupwizard.mode` does nothing when the key is already in the file. Upsert. The SDK directory also has a sibling `build.prop` next to `system.img`; `image-builder.ts` patches it and this plan does not. `getprop ro.product.model` is the About value. `ro.product.system.model` is not, and it is the property the last failed boot happened to print.

`emulatorArgs` already appends the device profile as `-prop`. `generic.env` sends nothing, so the image identity is what that profile shows. `pixel_5.env` and `redmi_note_11.env` send `ro.product.*`, `ro.build.fingerprint`, `ro.build.tags=release-keys`, and `ro.build.type=user`. Phase B ("stamp the picker into `build.prop`") rebuilds a 3 GB image to do what that `-prop` list is already trying to do, and the two writers will disagree. One image identity, OpenEmulator One. The picker stays a runtime override. The definition of done has to say which one `getprop` returns when the picker is Pixel 5.

`ro.hardware=ranchu` staying is correct. The claim that dropping `generic` / `sdk_phone` removes the common emulator checks is not. `ro.kernel.qemu`, `ro.boot.qemu`, `ranchu`, `goldfish`, `test-keys` or `dev-keys`, and now `verifiedbootstate=orange`, all remain. `android/imported/build.prop` is a `sdk_gphone` `dev-keys` fragment, not this image; do not take ABI or tag facts from it. The brief's image is `sdk_phone_x86_64` `test-keys` `RSR1.210722.013.A2`. Fingerprints keep that build id, type, and tags.

### LP metadata

GPT-by-name for `vbmeta` and `super` is right, and scanning for ext4 magic is wrong for the reason the plan gives. Geometry at byte 4096 of `super` is right. The rest is underspecified.

Extent `target_data` and `num_sectors` are in **512-byte** sectors (`LP_SECTOR_SIZE`), not `geometry.logical_block_size` (4096). Using the logical block size places every volume eight times too far into `super` and the editor then "repairs" whatever bytes sit there. Byte offset is `super_start + target_data * 512`, length `num_sectors * 512`.

A logical partition is a list of extents, not one byte range. Phase A should refuse `num_extents != 1`, a zero-fill extent, or a `target_source` other than the super device. `SLOT_SUFFIXED` means the name in the table is not the name init mounts. This emulator image is not A/B; if that attribute is set, or both `system` and `system_a` exist, fail the build instead of picking one. Read a metadata slot only when the header magic is `0x414C5030` and the header and table checksums match. Slot 0 is the one to try first; on failure try the other slots and the backup copy at the end of `super` (`GetPrimaryMetadataOffset` / `GetBackupMetadataOffset` in liblp). Backup geometry is the 4096 bytes after the primary geometry. A checksum failure is a build error, not a reason to fall through to a magic scan.

### Snapshots and userdata

The failure mode is right: Quick Boot restores RAM captured against the old `/system`, and a leftover `-writable-system` qcow2 masks the new base. `sdk-engine.ts` treats "snapshot restore failed" as a cold retry that **keeps** the snapshot, and the warm path passes no snapshot flags so Quick Boot loads `default_boot` whenever that directory exists. Deleting the snapshot has to happen before `start`, not as a flag.

The procedure the plan describes is not safe on this tree:

- Windows `rename` does not replace a non-empty directory. The second build's "rename staging over `openemu/x86_64`" fails. Move `x86_64` to `x86_64.prev`, move staging to `x86_64`, then delete `.prev`. If the process dies in the middle, the next launch has to boot `.prev` rather than a missing image.
- Refuse the swap while `OpenEmulator_API30_openemu` is running. The emulator has `system.img` mapped; the replace fails or the guest keeps the old file handle.
- Idempotence that looks only at the recipe hash will skip a rebuild when Google's `default` image changes underneath, and a manifest written by `image-builder.ts` has no recipe hash. Rebuild unless the manifest has this recipe hash **and** the recorded base digest matches the current `default` image.
- Delete the whole `snapshots/` directory. `avd.ts` still defaults a snapshot name of `booted`; deleting only `default_boot` leaves another one for a later config to load. Delete `system.img.qcow2` and `vendor.img.qcow2` when present. Do not glob `*.qcow2`: `userdata-qemu.img.qcow2` and `encryptionkey.img.qcow2` are the user's data.
- `syncAvdConfig` sets `fastboot.forceFastBoot=yes` when the snapshot directory exists. Delete first, then sync, or the AVD is pointed at a snapshot that was just removed.
- Record the ROM id in the AVD only after provision succeeds. If it is written before the delete, a crash leaves the new id beside the old snapshot and the mismatch never fires again.
- Clear `provisioned_at` so the next start cold-boots and provisions. That part is right.

Keeping userdata on this AVD across a later orange-to-orange recipe change is reasonable. PackageManager drops system packages whose APKs disappeared, including a data-app update of one of those packages, and ART discards odex whose APK checksum changed. Nothing in this recipe changes framework jars, so `system_server`'s odex stays valid. A fingerprint change still makes the next boot run the "Android is upgrading" dexopt pass; it will not be the 40 s fresh boot. `ro.config.wallpaper` applies only when `/data/system/users/0/wallpaper` is absent, so an existing AVD will not show the new wallpaper. That is normal, and the definition of done should not require it on the upgrade path.

### Debloat

Keeping `PrintSpooler`, `Camera2`, `WallpaperPicker`, and `WallpaperCropper` is right. `PrintManagerService` binds the spooler; `ACTION_IMAGE_CAPTURE` needs a handler; the launcher's wallpaper entry needs the picker and the cropper. `WallpaperBackup` is harmless and not worth a fight. `CalendarProvider`, `ContactsProvider`, `TeleService`, `Telecom`, `TelephonyProvider`, LatinIME, WebView, Settings, SystemUI, and Launcher3 are correctly absent from the remove list. Removing the `Contacts` and `Calendar` apps does not remove those providers; the directory names differ.

`BookmarkProvider` is the weak removal. Browser2 and QuickSearchBox stay, and both query that provider. The failure is a broken browser or search suggestion, not a boot loop. Keep it until a boot has launched Browser2, or delete it and add that launch to the definition of done. `PartnerBookmarksProvider` can go.

`NfcNci` is the other one. If the stock image has the `android.hardware.nfc` feature, `SystemServer` starts `com.android.nfc.NfcService` by class name. Check `pm has-feature android.hardware.nfc` on a stock boot before deleting it. If the feature is present, delete the feature xml in the same recipe or keep the apk.

`Dialer` and `messaging` are product choices. `Telecom` logs a missing default dialer and keeps running; there is no in-call UI and no default SMS role. That is acceptable on this emulator. It needs one boot where `system_server` stays up and `com.android.phone` is still installed, not an assertion that "telephony's providers" are the only dependency.

The "130 packages instead of 151" figure is the old list, which also removed `Camera2`, `PrintSpooler`, `WallpaperPicker`, `WallpaperCropper`, and `WallpaperBackup`. This list keeps those. Do not use 130 as a target. `shared_blocks` means bytes freed will be less than the APK sizes; the check is the free-block delta, then `e2fsck`.

## 3. What the plan is missing

This image does not make the product LDPlayer-class. The roadmap's window embed and the persistent input channel do that. Ranked by what a user of *this Android* would notice, against the cost of doing it inside the image:

1. **A boot that actually runs the modified `/system`.** Highest value, and it is the measured cmdline, not the writer. Phase A.
2. **One identity that About and `getprop ro.product.model` show on the generic device.** Already in the plan. Phase A. The device picker overriding it is existing product behaviour, not ROM work.
3. **Debloat of apps that are safe to remove, with the two checks above.** Moderate value (disk, and maybe a few processes; many of these packages are not running at boot). Phase A, after the verity fix, not before the writer is trustworthy.
4. **`ro.setupwizard.mode=DISABLED`.** Cheap, and it belongs in the image. Phase A. Upsert it.
5. **A landscape, tablet-density device profile.** This is the other half of "feels like LDPlayer", it lives in `devices/*.env` and `config.ini`, and the previous plan had it. High value, low cost, not an ext4 change. Do it beside this work. Do not block the ROM on it, and do not bury it in phase C.
6. **Hiding `orange`, `qemu`, `ranchu`, and `test-keys`.** High value for apps that refuse emulators, and orange makes the tell worse. Doing it properly is a runtime property override after init has read the cmdline, which is phase C (the same class of work as Magisk). Not phase A.
7. **Wallpaper in the image, boot animation, branded launcher, in-guest agent, root, ARM translation.** The plan's phase C assignment is right. ARM stays blocked on the licence. The agent duplicates the roadmap's gRPC input channel and should not be pulled forward to justify the writer.

## 4. Scope

Cut from phase A:

- `wallpaper.ts` and any new file. A hand-rolled PNG plus an htree insert is the riskiest edit in the milestone, and an existing userdata will not show it.
- Block freeing, htree splits, and allocating from uninitialised groups. Phase A does not need a new inode or a new block if it does not add a file.
- Phase B. The picker is already `-prop` in `emulatorArgs`.

Phase A becomes: the tested vbmeta and cmdline change, unlink (no free) of the debloat list on all four volumes, in-place `build.prop` upserts, sibling `build.prop` and `source.properties`, manifest, and the AVD invalidation. Unlink-without-free was the wrong plan only because FEC put `/system` back. With the hashtree disabled, those unlinks stay. Product, vendor, and system_ext already had no verity; they are not the new risk.

Pull into phase A:

- The full tested cmdline, including `device_state=unlocked`, as upserts.
- The Windows directory swap and the running-emulator refusal.
- Idempotence on recipe hash plus base digest.
- The snapshot and qcow2 deletion order in section 2.
- `e2fsck -fn` as a required check on the image that ships, not "via WSL when present". A user build whose only checker is fsck-lite is checked by the same code that wrote the bytes.

Leave ARM, the priv-app agent, the launcher, Magisk, and the boot animation where the plan put them.

## 5. Better alternatives

**Unlink and in-place props, then a writer.** The alternative above. Trade-off: system free space stays 64 MB and 56 inodes, so phase A cannot add a file. That is the right trade until a real `e2fsck` has passed on a writer that only deletes. The refcount-and-create design is the right design for the day something has to be added. It is the wrong first cut.

**Re-sign vbmeta and stay green.** This image is test-keys. If `avbtool info_image` shows the public AOSP test key, re-sign the flag change with `external/avb/test/data`'s matching private key (it is published for this use). A valid signature plus `HASHTREE_DISABLED` skips dm-verity without `allow_verification_error`, and `verifiedbootstate` can stay `green`. That avoids the keystore and "unlocked device" tells. Trade-off: it is untested on this image. If the emulator pins a different key, re-signing fails the same `PUBLIC_KEY_REJECTED` the unsigned patch failed, and orange remains the door that has actually opened. Spend one boot on it before freezing orange into the recipe. Do not block phase A on it if the key does not match.

**Check the image with e2fsprogs, not with a second copy of the writer.** fsck-lite is a unit-test aid. The gate is `e2fsck -fn`. CI that skips it when WSL is absent will pass a dirty image. Vendoring `e2fsck.exe` makes the user build honest and pulls in GPL plus a Windows port that this repo would then own. Mandatory WSL `e2fsck` in development, and no claim that a user's machine verified the filesystem, is the smaller commitment. I would not vendor GPL e2fsprogs in phase A.

## 6. Test plan gaps

The definition of done does not prove:

- `dmesg` contains `VerificationDisabled` and `AVB HASHTREE disabled on: /system`, and does not contain `verity-fec:` or `Failed to mount /system`. Package absence alone misses a FEC repair of a file that is not a package.
- `getprop ro.boot.verifiedbootstate`, `ro.boot.vbmeta.device_state`, `ro.boot.veritymode`, `ro.boot.vbmeta.digest` (must equal the hash written into the textproto), `ro.product.model`, `ro.build.fingerprint`, `ro.build.display.id`. `ro.product.system.model` is not sufficient.
- The same `getprop` set with the generic device and with Pixel 5, so the `-prop` interaction is a recorded result.
- `ls -Z` on every rewritten `build.prop` still shows `system_file`, and a boot `avc` log has no new denial on those files.
- `com.android.phone` is installed, Settings opens, the wallpaper picker resolves, and `ACTION_IMAGE_CAPTURE` resolves. Browser2 launches if `BookmarkProvider` was removed. `pm has-feature android.hardware.nfc` was checked before `NfcNci` was removed.
- A second boot on an already provisioned openemu AVD: user apk still installed, removed system app gone, `snapshots/` was not restored (no Quick Boot of the old RAM), userdata qcow2 still present.
- Crash and lock behaviour: kill the builder after moving `x86_64` aside; start the emulator during a build; run the builder twice and get a byte-identical image; replace `default` and confirm a rebuild; an `image-builder.ts` manifest does not count as up to date.
- The stock `google_apis` / playstore image bytes are untouched.
- The ext4 fixture includes a shared block referenced by two inodes (delete one, the other still reads), an htree insert of a name whose hash is not in the first leaf, an `INODE_UNINIT` group that the allocator must not touch, and an in-inode xattr that survives a replace. `e2fsck -fn` on the real image is part of the merge bar, including on a machine where WSL was not already running.
- `ro.boot.veritymode` and a `dumpsys` or log line showing `keystore` and `apexd` finished. The 40 s figure is a fresh AVD. The upgrade boot is allowed to be slower. There is no package-count target.

## 7. Concrete edits

1. In "Proven", list the four changes that booted: vbmeta flags `|= 3`, digest rewritten to the header-derived length (assert 6144), `androidboot.vbmeta.device_state=unlocked` upserted, `androidboot.verifiedbootstate=orange` upserted. State that the gate is `verifiedbootstate`, and that `device_state` is included because it was part of the tested cmdline.
2. Replace "precisely the state an LDPlayer-style ROM is in" with: orange is the unlocked state this unsigned vbmeta requires; LDPlayer hides that state. Add the side effects from section 2 (attestation, apexd, do not edit `/system/apex`, pin `veritymode`, `ro.debuggable` unchanged, do not reuse a green userdata).
3. In the ext4 section, require an exact feature match; hash-correct htree insert with no splits in phase A; `file_type`, `.` and `..`, and `nlink` on create; the hard-link free rule; `ext2fs_group_desc_csum`; the `bg_itable_unused` suffix rule; backup superblock and GDT updates; frozen `s_wtime`/`s_mtime`; `i_blocks` and no unwritten extents; refuse `i_file_acl != 0`; xattr NUL and hashes; reuse the inode on replace. State the in-volume paths for system versus the other three.
4. Extend fsck-lite with the converse checks in section 2, and require the fixture features listed in section 6.
5. In `lp.ts`, specify 512-byte extent sectors, one linear extent or fail, no `SLOT_SUFFIXED`, and checksummed primary-then-backup metadata. Drop any wording that a logical partition is a single byte range.
6. Change idempotence to "recipe hash and base digest both match, and the manifest was written by this builder". Describe the Windows `x86_64` → `x86_64.prev` swap and recovery. Refuse to build while the openemu AVD is running.
7. Replace the invalidation paragraph with the order in section 2: stop, delete all of `snapshots/`, delete only the system and vendor qcow2 overlays, then sync `config.ini`, clear `provisioned_at`, store the ROM id only after provision. Name `userdata-qemu.img.qcow2` and `encryptionkey.img.qcow2` as kept.
8. Narrow "keeps userdata (like an OTA)" to later recipe bumps on `OpenEmulator_API30_openemu`, which has only ever booted orange. Note the upgrading dexopt pass and that an existing wallpaper file is left alone.
9. Delete phase B from this plan. Say that `emulatorArgs` already passes device `-prop`s, and that the definition of done records `getprop` for generic and for Pixel 5.
10. Make `build-prop.ts` upsert, including `ro.config.wallpaper` and `ro.setupwizard.mode`, and patch the sibling `build.prop`. DoD asserts `ro.product.model` and `ro.build.fingerprint`.
11. In the debloat section, keep `BookmarkProvider` unless Browser2 is in the test plan; gate `NfcNci` on the NFC feature; note that 130 was the old list.
12. Move wallpaper, block freeing, and uninit-group allocation out of phase A. Phase A is the tested cmdline, unlink-only debloat, and in-place props. Say explicitly that free space stays at the stock numbers until a later change.
13. Add the test-plan items in section 6 to Definition of done, and make `e2fsck -fn` a merge bar rather than "when WSL is present".
14. In Risks, replace the Play Integrity row with the orange tells, and replace "64 MB limits additions" with "phase A does not add files; growing or filling the image is a later change that depends on `e2fsck` of the writer".
