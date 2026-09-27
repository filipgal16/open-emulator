# openemu: our own Android ROM

A plan, written after measuring, revised after Cursor Grok 4.7's review
(`design/openemu-rom.review.md`). It supersedes `design/custom-image.md`, whose approach is kept
where it was right and replaced where the boot log shows it was not.

## What we run today

| | |
|---|---|
| Guest | Android 11 (API 30), x86_64, on Google's SDK emulator (QEMU `ranchu` + goldfish devices) |
| Images | `default` — AOSP `sdk_phone_x86_64-userdebug 11 RSR1.210722.013.A2`, test-keys, Apache-2.0 userspace. `google_apis` and `google_apis_playstore` for the GMS profiles. |
| Runtime | Native Windows (`emulator.exe` + WHPX) by default; WSL still selectable |
| ABIs | `x86_64,x86` only. **No ARM translation** in the AOSP image — ARM-only apps will not install. |

`system.img` is a GPT disk:

| GPT partition | Offset | Size | Holds |
|---|---|---|---|
| `vbmeta` | 1 MiB | 1 MiB | the top-level AVB vbmeta: 4480 bytes, SHA256_RSA4096, chains to `system` |
| `super` | 2 MiB | 3.08 GB | LP metadata + four logical partitions, one linear extent each |

| Logical partition | Offset in `system.img` | Size | ext4 blocks free | inodes free |
|---|---|---|---|---|
| `system` | 3,145,728 | 1,078,669,312 | 16,391 (64 MB) | 56 |
| `system_ext` | 1,082,130,432 | 106,766,336 | 77 | 10 |
| `product` | 1,189,085,184 | 264,716,288 | 194 | 5 |
| `vendor` | 1,454,374,912 | 67,837,952 | 50 | 1 |

Each is ext4 with exactly `ext_attr dir_index filetype extent sparse_super large_file huge_file
uninit_bg dir_nlink extra_isize shared_blocks`: no journal, no `metadata_csum`, no `64bit`, no
`flex_bg`, no `resize_inode`. 4 KiB blocks, 256-byte inodes, `security.selinux` stored in the inode
with `e_hash` 0. **No directory on any of the four volumes is htree-indexed** (all `Flags:
0x80000`). `s_last_orphan` is 0. `e2fsck -fn` passes clean on all four.

`system`'s partition ends in an AVB footer whose vbmeta (1664 bytes, Google's 2048-bit key) holds
the dm-verity hashtree + FEC descriptor for `/system`. The emulator puts
`androidboot.vbmeta.{size=6144,hash_alg,digest}` on the kernel command line from
`VerifiedBootParams.textproto`; the digest is SHA-256 over the top-level vbmeta **followed by** the
chained `system` vbmeta. Recomputed that way from the stock image it reproduces Google's
`aa516f36…` exactly.

## Why the previous attempt did not work

`image-builder.ts` (committed in 2dee65b as found) edited the volumes with `debugfs` in WSL.
Booting that image shows:

- `/product`, `/vendor`, `/system_ext` changes are live — they have no dm-verity.
- **`/system` is stock.** libfs_avb sets up dm-verity with FEC on `/system`, and the kernel logs
  `verity-fec: corrected 1982 errors` as it repairs every edit back to Google's bytes.
- Patching the vbmeta flags breaks its signature: `ERROR_VERIFICATION / PUBLIC_KEY_REJECTED isn't
  allowed`, `Failed to mount /system`.
- It hashed a fixed 6144 bytes at 1 MiB, which is not how the digest is formed (see above).

## What works — measured on this machine

**Re-sign the top-level vbmeta with our own key.** libfs_avb in user space does not check *which*
key signed the top-level vbmeta — that is the bootloader's job, and its `validate_vbmeta_public_key`
is a no-op that trusts any key; what binds the image is the digest on the command line. So:

1. Set `HASHTREE_DISABLED` (flag 1) in the top-level vbmeta header.
2. Replace its public key with ours (RSA-4096, same encoding and size, so no offsets move).
3. Recompute the hash and the PKCS#1 v1.5 SHA-256 signature over header ‖ auxiliary block.
4. Write `androidboot.vbmeta.digest` = SHA-256(new top-level vbmeta ‖ unchanged `system` vbmeta)
   into `VerifiedBootParams.textproto`; size stays 6144.

Result: `libfs_avb: Returning avb_handle with status: HashtreeDisabled`, `AVB HASHTREE disabled
on: /system`, no `system-verity` device, `/system` edits live, `ro.product.model=OpenEmulator
One`, boot in ~44 s on a fresh AVD. **`ro.boot.verifiedbootstate`, `ro.boot.vbmeta.device_state`
and `ro.boot.veritymode` are all empty — exactly as on the stock image.** The chained `system`
vbmeta still verifies with Google's key, untouched; its hashtree simply is not set up.

The alternative that also boots — `VERIFICATION_DISABLED` plus
`androidboot.verifiedbootstate=orange` and `device_state=unlocked` on the command line — is
rejected: orange is an unlocked bootloader to every app and to key attestation, the very tell
LDPlayer hides. `-writable-system` is not needed by either and is dropped.

The signing key is generated once per machine (RSA-4096, `%LOCALAPPDATA%\open-emulator\rom\`) and
reused, so rebuilds are byte-identical. It protects nothing and is not secret — the guest trusts any
key — so it is not committed to the repository, where it would look like a leaked secret.

## What LDPlayer's Android is, and what we take from it

LDPlayer, BlueStacks and MEmu do not compile AOSP per release; they maintain a modified image,
signed by themselves, and ship it.

| Their ROM | Ours | When |
|---|---|---|
| Derived from AOSP, not a stock image | `openemu`, derived from AOSP `default` | **A** |
| `/system` they control, signed with their key | re-signed vbmeta, verity off for `/system`, no unlocked state | **A** |
| Their brand in Settings → About | `open-emulator` / `OpenEmulator One`, our build number | **A** |
| Debloated — no phone/SMS/calendar apps | conservative debloat on all four volumes, space actually reclaimed | **A** |
| Branded look | default wallpaper shipped in the image (`ro.config.wallpaper`) | **A** |
| "Phone model" setting | today's `-prop` device picker is recorded, not changed (see DoD) | later |
| In-guest services, own launcher/store | priv-app agent and launcher | C |
| Root toggle | Magisk in the ramdisk (GPL-3.0) | C |
| ARM translation | needs a licensable translator | C |
| Hiding `qemu`/`ranchu`/`test-keys` tells | runtime property override after init | C |

## Architecture

### Built on the user's machine, from Google's download, by our code

- **Not hosted by us.** The base is Google's binary under the SDK licence, downloaded by the
  user's machine as today. We ship a recipe and the code that applies it.
- **No WSL at runtime.** The native runtime's promise is no Linux. The ROM toolchain is plain
  TypeScript in the main process (no electron import), like `cpio.ts` and `iso9660.ts`.
- **No AOSP build.** It needs a Linux box, ~400 GB and 32 GB+ RAM (this machine has 15 GB) and
  would reproduce `sdk_phone_x86_64`; nothing in this ROM needs recompiling.

### Modules — `desktop/src/main/rom/`, each unit-tested

| Module | Job |
|---|---|
| `gpt.ts` | GPT header + entries, CRC32-checked; `vbmeta` and `super` by name |
| `lp.ts` | LP geometry (+ backup) and metadata (slot 0, then other slots, then backup copies), SHA-256-checked. Extents in **512-byte sectors** relative to `super`. Refuses: more than one extent, a non-linear extent, a target other than `super`, `SLOT_SUFFIXED`, duplicate names |
| `avb.ts` | Parse vbmeta (size from `256 + auth + aux`, asserted against the footer and the 6144 total); read the `system` footer; set flags; AVB public-key encoding (`n0inv`, `rr`); sign; digest; rewrite `VerifiedBootParams.textproto` (upsert, never append duplicates) |
| `ext4.ts` | The editor, below |
| `build-prop.ts` | Upsert-based rewrite: identity keys in place, our keys upserted, byte-exact otherwise |
| `wallpaper.ts` | Draws the default wallpaper as a PNG (zlib only). Look from Cursor Grok |
| `recipe.ts` | The ROM definition and its version |
| `builder.ts` | Stage, edit, verify, sign, manifest, swap |

### The ext4 editor

Refuses any volume whose features are not a subset of the measured set, and requires `extent`,
`filetype`, `uninit_bg` and `ext_attr` explicitly; refuses `s_desc_size` other than 32/0, a
non-zero `s_last_orphan`, block-mapped files, and two extents mapping the same *logical* block.

Two things only the real volumes showed, both now handled rather than refused:

- **e2fsdroid deduplicates within a file too.** `/system/apex/com.android.adbd.apex` maps one
  physical block at two logical offsets. Each mapping is one reference; freeing the file frees the
  block exactly once, when its last reference goes.
- **External xattr blocks exist.** `/system/bin/run-as` carries `security.capability` beside its
  label, so its xattrs live in a separate block (`i_file_acl`). That block is counted like any
  other reference, its own `h_refcount` is kept equal to the number of inodes using it, it is freed
  with its last user, it stays in `i_blocks` across a replace, and `verify()` checks all of that.

- **Read**: superblock, group descriptors (crc16 verified on open), inodes, extent trees of any
  depth, directories, files, in-inode xattrs via the inode's own `i_extra_isize`. Directories are
  read by scanning every block: an htree's internal nodes are one empty record the size of a
  block and its root hides the index inside `..`, which is exactly the linear-compatibility ext4
  designed in.
- **Remove a tree**: unlink from the parent, then release. Every block reachable from every in-use
  inode is counted first (`shared_blocks`); a block is freed only at count zero. An inode is freed
  only when its link count reaches zero — hard links outside the tree keep it. Freed inodes are
  zeroed and never put on the orphan list; `bg_itable_unused` is not raised. The parent's link
  count drops for a removed directory unless it is the `dir_nlink` sentinel 1.
  *Unlinking without freeing is not an option*: it leaves allocated, unreachable inodes that
  `e2fsck -fn` reports, which is how the old builder would have failed the merge bar.
- **Create** a file or directory, only into a **linear** directory (a hashed one is refused — none
  exist on these volumes). Inode from the parent's group, else an initialised group, else an
  `INODE_UNINIT` group initialised first; `bg_itable_unused` lowered only when the inode is taken
  from the tail. Blocks in at most four runs (else fail), from initialised groups first, an
  `BLOCK_UNINIT` group's bitmap synthesised and written before use. Mode, uid/gid 0, fixed
  timestamps, `file_type` matching the mode, `.`/`..` and link counts for directories, the parent's
  link count raised, `security.selinux` in-inode laid out byte-for-byte as the stock images do.
- **Replace** a file: keep the inode (mode, owner, label). If every block it owns is referenced by
  it alone and the new content fits, write in place — the vendor volume has one free inode and 50
  blocks, so this is the normal path for `build.prop`. Otherwise allocate new blocks, then release
  the old ones through the refcount. A block that might be shared is never written.
- **Bookkeeping**: bitmaps, group descriptor counts, flags and crc16, superblock counts — and the
  **backup superblocks and GDTs** in groups 1 and powers of 3, 5, 7, as `ext2fs_flush` does, so a
  later `e2fsck -b` cannot resurrect the stock layout. `s_wtime`/`s_mtime` are left as they are.
- **Verify** (fsck-lite, always run by the builder): checksums; every allocated block is metadata
  or reachable and every reachable block is allocated; counts agree bitmap ↔ descriptor ↔
  superblock; bitmap padding; `i_blocks` matches what the extents own; `.`/`..` and `file_type`;
  every allocated inode reachable, with the right link count; nothing past `bg_itable_unused`;
  `s_last_orphan` 0.

**`e2fsck -fn` is the merge bar**, run through WSL on the image the build produced on this
machine. The user's build is checked by fsck-lite only, and nothing claims otherwise.

### Build flow

1. Refuse if the `openemu` AVD's emulator is running.
2. Resolve the base (`default/x86_64`). Its identity is the stock vbmeta digest — cheap, and it
   changes whenever Google republishes the image.
3. Copy it to `openemu/x86_64.staging`. The stock image is never touched.
4. GPT → LP → each logical partition as a bounded window onto the staged `system.img`.
5. Apply the recipe per volume, in this order: debloat (frees), identity (`build.prop`), new files
   (after the frees, so the inodes they returned are available).
6. `flush`, reopen, verify every touched volume; read every changed file back.
7. Re-sign vbmeta; write `VerifiedBootParams.textproto`, the sibling `build.prop`, and
   `source.properties` (`TagId=openemu`).
8. Write `openemu-manifest.json`: builder id, recipe hash, base digest, per-volume edits, output
   vbmeta digest.
9. Swap: `x86_64` → `x86_64.prev`, `x86_64.staging` → `x86_64`, delete `.prev`. On start, a missing
   `x86_64` with a `.prev` is restored first. (Windows cannot rename over a non-empty directory.)

Up to date only if the manifest was written by this builder **and** its recipe hash and base
digest both match. A manifest from `image-builder.ts` never counts.

### Keeping the AVD honest when the ROM changes

The engine stores the ROM id (the output vbmeta digest) in `state/<AVD>/rom_id` **after provision
succeeds**. Before a start, if the AVD has booted before and the stored id differs:

1. delete the whole `snapshots/` directory (not just `default_boot`);
2. delete `system.img.qcow2` and `vendor.img.qcow2` only — `userdata-qemu.img.qcow2` and
   `encryptionkey.img.qcow2` are the user's data and stay;
3. then sync `config.ini` (so it is not pointed at a snapshot just deleted);
4. clear `provisioned_at`, so the start cold-boots and provisions in the background.

Keeping userdata across later recipe bumps is an OTA in miniature: PackageManager drops system
packages whose APKs disappeared, the fingerprint change triggers the "Android is upgrading" dexopt
pass (slower than a fresh boot, once), and an existing wallpaper file is left alone — the branded
default shows on fresh AVDs.

### Engine and shell

- `openemu` is the default profile on the native runtime; its setup step downloads `default` and
  builds. No WSL.
- `-writable-system` is dropped.
- `status` reports `rom=openemu/<version>`; the shell shows it where the Android version is shown
  (UI from Grok, if any UI changes at all).
- WSL keeps the stock profiles; `openemu` is native-only.

## Recipe v1

**Identity**, upserted in place in all four `build.prop`s:

| Key (per file present) | Value |
|---|---|
| `ro.product.<p>.brand` / `.manufacturer` | `open-emulator` |
| `ro.product.<p>.model` | `OpenEmulator One` |
| `ro.product.<p>.name` / `.device` | `openemu_x86_64` / `openemu` |
| `ro.<p>.build.fingerprint`, `ro.product.build.fingerprint`, `ro.bootimage.build.fingerprint` | `open-emulator/openemu_x86_64/openemu:11/RSR1.210722.013.A2/10067904:userdebug/test-keys` |
| `ro.build.display.id` | `open-emulator Android 11 (openemu 1)` |
| `ro.build.description` | `openemu_x86_64-userdebug 11 RSR1.210722.013.A2 10067904 test-keys` |
| `ro.build.product` | `openemu` |
| `ro.build.flavor` | `openemu_x86_64-userdebug` |

`ro.build.fingerprint` is in none of the files; init derives it from the rebranded
`ro.product.*`. API 30's init lets a later definition of a key override an earlier one (it logs
"Overriding previous 'ro.' property"); rewriting every occurrence in place makes the order moot. Build id, type and tags are kept — the image is still a userdebug test-keys build,
and saying so is honest. `ro.setupwizard.mode=DISABLED` is already in `system_ext`.

**Our props**, upserted into `/system/build.prop`: `ro.openemu.rom=1`,
`ro.openemu.rom.version=<v>`, `ro.config.wallpaper=/system/media/openemu/wallpaper.png`.

**Debloat**:

| Volume | Removed |
|---|---|
| system `/system/app` | BasicDreams, BluetoothMidiService, EasterEgg, LiveWallpapersPicker, NfcNci, PartnerBookmarksProvider, PresencePolling, PrintRecommendationService, RcsService, SimAppDialog, Stk, Traceur |
| system `/system/priv-app` | BuiltInPrintService, CallLogBackup, CellBroadcastLegacyApp, DynamicSystemInstallationService, MusicFX, ONS, Tag |
| system_ext `/priv-app` | EmergencyInfo |
| product `/app` | Calendar, DeskClock, Gallery2, Music, PhotoTable, messaging |
| product `/priv-app` | Contacts, Dialer |

Kept on purpose: `BookmarkProvider` (Browser2 and QuickSearchBox query it), `PrintSpooler`,
`Camera2`, `WallpaperPicker`, `WallpaperCropper`, `WallpaperBackup`, every provider, TeleService,
Telecom. `NfcNci` goes because the stock image declares no `android.hardware.nfc` feature
(checked on a boot).

**Files**: `/system/media/` and `/system/media/openemu/` (dirs, 0755) and `wallpaper.png`
(0644), all `u:object_r:system_file:s0`, root:root. This image keeps its media under
`/product/media` and has no `/system/media` at all — an earlier revision of this plan said it was
empty, which was a misread `debugfs` listing — so the ROM creates it, in the linear `/system`.

## Definition of done

Unit tests (`npm test`):
- ext4 against a generated fixture (`test/fixtures/rom/make-ext4-fixture.sh`, committed with its
  32 KB output) that has `shared_blocks` with a block really shared by two files, an htree
  directory, `BLOCK_UNINIT` and `INODE_UNINIT` groups, backups in groups 1/3/5, in-inode labels:
  remove a tree that shares a block (the other file still reads), create into an uninitialised
  group, grow a directory, replace in place and by reallocation (label survives), refuse a hashed
  insert and an unsupported feature; fsck-lite clean after each; two identical runs give identical
  bytes.
- GPT/LP/AVB against the real stock header bytes (small excerpts) and synthetic corruptions.
- build-prop against the real stock `build.prop` texts.

On this machine, from the real `default` image:
- `e2fsck -fn` clean on all four volumes of the built image (WSL, dev only).
- Boot with no `-writable-system`: dmesg has `HashtreeDisabled` and `AVB HASHTREE disabled on:
  /system`, and no `verity-fec:` or `Failed to mount`.
- `getprop`: `ro.boot.vbmeta.digest` equals the manifest; `ro.boot.verifiedbootstate`,
  `vbmeta.device_state`, `veritymode` empty; `ro.product.model`, `ro.build.fingerprint`,
  `ro.build.display.id` ours. Recorded for the generic device *and* with the Pixel 5 picker, so the
  `-prop` interaction is a known result.
- `ls -Z` shows `system_file` on every rewritten `build.prop` and the new files; no new `avc`
  denial for them.
- Removed packages absent; `com.android.phone` installed; Settings opens; the wallpaper picker
  and `ACTION_IMAGE_CAPTURE` resolve; Browser2 launches; the wallpaper is ours on a fresh AVD.
- Measured against stock `fast`, same AVD settings: cold boot, warm start, `MemAvailable` after
  boot, process count, package count — reported whichever way it goes. No package-count target.
- Upgrade path: a provisioned `openemu` AVD with a user APK, then a recipe bump → snapshot not
  restored, user APK still installed, removed app gone, userdata overlay kept.
- Builder: twice in a row → byte-identical; with the emulator running → refused; killed after
  moving `x86_64` aside → next run recovers; a changed base digest → rebuild; an old manifest →
  rebuild; stock images untouched.
- The app's first run builds it with WSL **not running**, then provisions and embeds it.
- README, `documentation.md`, `android/MODIFICATIONS.md` say what the ROM is and is not.

## Risks

| Risk | Mitigation |
|---|---|
| A bug in the ext4 writer corrupts `/system` | Narrow feature gate; no write to a possibly-shared block; refcounted frees; fsck-lite every build; `e2fsck -fn` merge bar; staged build and atomic swap |
| Google republishes `default` with another layout | Partitions by name through checksummed LP; files by path; refusals name what differed; base digest forces a rebuild |
| Emulator detection | We remove `generic`/`sdk_phone` from identity but `ranchu`, `qemu`, `test-keys` remain; hiding them is phase C. Re-signing keeps us off the orange tell |
| Snapshot restored onto a changed ROM | ROM id check and ordered invalidation, above |
| Space | Frees reclaim what debloat removes; additions go in after them. Growing a partition (LP + resize) is later work |

## Phase C — written down, not built

- **ARM translation** — the biggest compatibility gap for games. `libndk_translation` ships only in
  Google's GMS images and `libhoudini` is Intel's; neither is redistributable, and grafting one into
  our image is the SDK-licence question in its sharpest form. Needs a legal answer first.
- **In-guest agent** (priv-app): persistent input, clipboard, shared folder, virtual GPS — the
  roadmap's 1.2 and 2.4 inside the ROM. Needs an APK toolchain at dev time.
- **Our launcher, store, and static RROs** in `/product/overlay` for framework and SettingsProvider
  defaults — the AOSP-sanctioned way vendors restyle a ROM.
- **Root toggle** via Magisk in the ramdisk (GPL-3.0). The repo already patches cpio ramdisks.
- **Hiding emulator tells** (`ro.kernel.qemu`, `ranchu`, `test-keys`) after init.
- **A real "phone model" picker** stamped into the image, if `-prop` proves unable to override
  `ro.product.*`.
- **A landscape, tablet-density default device** — a `devices/*.env` + UI decision, not an image
  change.
- **Branded boot animation.**

## Work plan

1. `gpt.ts`, `lp.ts`, `avb.ts` + tests — subagent, against this document and the probe scripts.
2. `ext4.ts` + fixture + tests — me.
3. `build-prop.ts`, `recipe.ts` + tests — subagent.
4. Wallpaper look from Cursor Grok; `wallpaper.ts`.
5. `builder.ts`, CLI (`npm run rom:build`, `rom:check`), manifest, swap — me.
6. Engine: setup step, `-writable-system` removal, ROM-id invalidation, status — me.
7. Verify on this machine; on failure, re-plan with Grok and retry.
8. Docs; retire `image-builder.ts` and `design/custom-image.md`; push.
