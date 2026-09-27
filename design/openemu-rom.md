# openemu: our own Android ROM

A plan, written after measuring. It supersedes `design/custom-image.md`, whose approach is kept
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
| `vbmeta` | 1 MiB | 1 MiB | the top-level AVB vbmeta (6144 bytes used) |
| `super` | 2 MiB | 3.08 GB | dynamic-partition container: `system`, `system_ext`, `product`, `vendor` |

The four logical partitions are ext4 with exactly these features, and nothing else:
`ext_attr dir_index filetype extent sparse_super large_file huge_file uninit_bg dir_nlink
extra_isize shared_blocks`. No `metadata_csum`, no `64bit`, no `flex_bg`, no journal. 4 KiB
blocks, 256-byte inodes, xattrs (SELinux labels) stored in the inode.

| Volume | Blocks free | Inodes free |
|---|---|---|
| `system` (mounted at `/`) | 16,391 (64 MB) | 56 |
| `system_ext` | 77 | 10 |
| `product` | 194 | 5 |
| `vendor` | 50 | 1 |

`e2fsck -fn` passes clean on all four stock volumes, so it is usable as an oracle.

## Why the previous attempt did not work, and what does

The previous attempt (`image-builder.ts`, committed in 2dee65b as found) edited the volumes with
`debugfs` in WSL. Booting that image today shows:

- `/product`, `/vendor`, `/system_ext` changes are live — they have no verity.
- **`/system` is stock.** `libfs_avb` sets up dm-verity *with forward error correction* on
  `/system`, and the kernel logs `verity-fec: corrected 1982 errors` as it quietly repairs every
  edit back to Google's bytes. `ro.product.system.model` still reads `mainline`; the debloated
  apps are all present.
- Patching vbmeta to disable verification boot-loops with
  `ERROR_VERIFICATION / PUBLIC_KEY_REJECTED isn't allowed`.

The missing piece is how first-stage init decides whether a modified vbmeta is acceptable: it
allows verification errors only when the device reports itself unlocked, and it reads that from
**`androidboot.verifiedbootstate=orange`** on the kernel command line. (`-writable-system` works
only because the emulator injects exactly that flag — but it also layers a qcow2 over `/system`,
and it does not disable verity by itself.) `androidboot.vbmeta.device_state=unlocked` alone is
**not** enough; tested and rejected.

**Proven on this machine**, against a copy of the old image:

1. Set `HASHTREE_DISABLED | VERIFICATION_DISABLED` in the top-level vbmeta flags.
2. Rewrite `androidboot.vbmeta.digest` in `VerifiedBootParams.textproto` to the new SHA-256.
3. Add `param: "androidboot.verifiedbootstate=orange"` to the same file — the emulator copies
   every `param` line onto the kernel command line.

Result: `libfs_avb: Returning avb_handle with status: VerificationDisabled`, `AVB HASHTREE
disabled on: /system`, no `system-verity` device, `ro.product.system.model=OpenEmulator One`,
the debloated apps gone, 130 packages instead of 151, boot to `sys.boot_completed` in ~40s from a
fresh AVD. No `-writable-system`.

That is precisely the state an LDPlayer-style ROM is in: an unlocked (orange) device whose
`/system` is theirs.

## What LDPlayer's Android is, and what we take from it

LDPlayer, BlueStacks and MEmu do not compile AOSP per release; they maintain a modified image and
ship it. The traits, and our equivalent:

| Their ROM | Ours | When |
|---|---|---|
| Derived from AOSP, not a stock image | `openemu`, derived from AOSP `default` | **A** |
| Unverified `/system` they control | vbmeta verification disabled, orange state | **A** |
| Their brand in Settings → About | `open-emulator` / `OpenEmulator One`, our build number | **A** |
| Debloated — no phone/SMS/calendar apps | Conservative debloat across all four partitions, space actually reclaimed | **A** |
| Tuned defaults | Props in the image; userdata settings at provision (already there) | **A** |
| Branded look | Default wallpaper shipped in the image (`ro.config.wallpaper`) | **A** |
| "Phone model" setting that really changes `Build.MODEL` | Identity stamped into `build.prop` from the device picker | **B** |
| In-guest services (input, clipboard, shared folder, GPS) and own launcher/store | A priv-app agent and launcher | C |
| Root toggle | Magisk (GPL-3.0) in the ramdisk | C |
| ARM translation (libhoudini) | Needs a licensable translator; see below | C |

**A** is this change. **B** follows directly from A's toolchain and is in scope if A lands clean.
**C** is written down, not built — see the end.

## Architecture

### Built on the user's machine, from Google's download, by our code

- **Not hosted by us.** The base image is Google's binary under the SDK licence. The user's
  machine downloads it (and the user accepts that licence, as today); we ship a *recipe* and the
  code that applies it. We redistribute none of Google's bytes.
- **No WSL.** The native runtime's whole promise is no Linux. The old builder needed `debugfs`
  in a distro at setup time, which a new user does not have. The ROM toolchain is plain
  TypeScript in the main process — the same call this codebase already made for cpio and ISO9660.
- **No AOSP build.** Compiling AOSP needs a Linux box, ~400 GB and 32 GB+ RAM (this machine has
  15 GB), and would produce a bit-identical `sdk_phone_x86_64` because the emulator's device tree
  *is* AOSP's. Nothing we want requires recompiling.

### Modules — `desktop/src/main/rom/`, pure Node (no electron import), each unit-tested

| Module | Job |
|---|---|
| `gpt.ts` | Read the GPT; find `vbmeta` and `super` by name |
| `lp.ts` | Read the super partition's LP metadata (geometry at +4096, header, partition table, extents); return each logical partition's name and byte range. Replaces the scan-for-magic, which cannot tell a partition from an ext4 image that happens to sit inside a file |
| `ext4.ts` | The editor. See below |
| `avb.ts` | Patch vbmeta flags; hash the 6144-byte vbmeta; rewrite `VerifiedBootParams.textproto` (digest + `verifiedbootstate=orange`) |
| `build-prop.ts` | Rewrite identity in place, append our props where the file lives on `system`, preserve mode/owner/label |
| `wallpaper.ts` | Draws the default wallpaper as a PNG (zlib, no image dependency — the `make-icon.mjs` approach). Look designed by Cursor Grok |
| `recipe.ts` | The ROM definition: identity, debloat list, props, files, version |
| `builder.ts` | Orchestration: stage, edit, verify, manifest, atomic install, idempotence |

### The ext4 editor

Narrow on purpose: it supports the feature set above and **refuses** any filesystem with a
feature outside it (`metadata_csum`, `64bit`, `flex_bg`, `has_journal`, `inline_data`,
`encrypt`, …) with an error that names the feature. A new Google image with a different layout
fails loudly at build time, never silently at boot.

Operations:

- **Read**: superblock, 32-byte group descriptors, inodes, extent trees (any depth), directories
  (linear and `dir_index` — hashed directories are read by scanning leaf blocks), files, in-inode
  xattrs.
- **Remove a tree** (debloat). Unlink the entry from its parent, then *free* what it owned — but
  only blocks nothing else references. `shared_blocks` means one block can back several files;
  the editor builds a reference count of every block reachable from every in-use inode first, and
  frees a block only when its count drops to zero. Inodes are freed and zeroed. Parent link counts
  fixed for removed directories. This is what reclaims space for additions, and what lets
  `e2fsck` stay clean (the old `unlink`-only approach left orphans).
- **Create** a file or directory: allocate an inode and a contiguous run of blocks from groups
  whose bitmaps are initialised (never from a `BLOCK_UNINIT`/`INODE_UNINIT` group without
  initialising it properly first), write an extent inode with mode, owner, fixed timestamps and
  its `security.selinux` label in-inode, add the directory entry (splitting a record in an existing
  block; allocating a new directory block only for linear directories).
- **Replace** a file's content: write the new content into *freshly allocated* blocks and repoint
  the inode, then release the old blocks through the same refcount. Never write into a block that
  might be shared.
- **Bookkeeping** on every mutation: block/inode bitmaps, group descriptor free counts,
  `bg_itable_unused`, the `uninit_bg` crc16 group checksum, superblock free counts.
- **Verify**: an fsck-lite pass the builder always runs — every reachable block marked in the
  bitmap, no block referenced by a freed inode, bitmap popcounts equal descriptor counts equal
  superblock counts, every group checksum valid, every directory entry pointing at an in-use
  inode. The real `e2fsck -fn` is the dev-time oracle (`npm run rom:check`, via WSL when present).

Deterministic: fixed timestamps (`SOURCE_DATE_EPOCH`-style), so the same recipe on the same base
produces the same bytes, and the manifest's digest means something.

### Build flow

1. Resolve the base image (`system-images/android-30/default/x86_64`); refuse if missing.
2. Copy it to `openemu/x86_64.staging` (~3.3 GB, seconds on an SSD). The stock image is never
   touched.
3. Locate partitions via GPT + LP. Open each ext4 volume through a window onto the file.
4. Apply the recipe: debloat → identity → props → files. Edits go straight to the staged file;
   no volume is ever loaded whole into memory.
5. Verify every touched volume. Read every changed file back.
6. vbmeta flags, digest, `VerifiedBootParams.textproto`; `source.properties` (`TagId=openemu`).
7. Write `openemu-manifest.json` — recipe version, base digest, what changed, output digest.
8. Rename staging over `openemu/x86_64`. A crash anywhere before this leaves the old ROM (or none)
   intact.

Idempotent: if the manifest's recipe hash matches, nothing is rebuilt.

### Keeping the AVD honest when the ROM changes

A Quick Boot snapshot restores RAM captured against the *old* `/system`. Restoring it onto a new
one is undefined. So the engine records the ROM build id beside the AVD, and on mismatch:

- deletes `snapshots/default_boot` and the `system`/`vendor` qcow2 overlays (the old
  `-writable-system` runs left a 70 MB one that would mask the new base),
- keeps userdata (like an OTA: the user's apps survive),
- clears `provisioned_at`, so the next start cold-boots and provisions — in the background, as
  first run already does.

### Engine and shell

- `openemu` is the default profile on the native runtime; its setup step downloads `default` and
  builds (the stash already wired this; it now runs natively and needs no WSL).
- `-writable-system` is dropped. It is no longer what makes the ROM work, and it put a writable
  qcow2 over `/system`.
- `status` reports `rom=openemu/<version>`; the shell shows it in Settings → About (UI: Grok).
- The WSL runtime keeps the stock profiles; `openemu` is native-only, as before.

## Recipe v1

**Identity** (all four `build.prop`s, every `ro.product.<partition>.*`, per-partition
fingerprints rebuilt with the original build id/type/tags):
brand/manufacturer `open-emulator`, model `OpenEmulator One`, name `openemu_x86_64`, device
`openemu`, `ro.build.display.id=open-emulator Android 11 (openemu 1)`.

Dropping `generic`/`sdk_phone` from brand, product, device and fingerprint also removes the most
common naive emulator checks. `ro.hardware=ranchu` stays — it comes from the kernel command line
and HAL loading depends on it.

**Debloat** — apps an emulator used to run other apps has no use for. Nothing the framework,
launcher, Settings, keyboard, WebView, downloads, storage, or telephony's providers depend on.

| Partition | Removed |
|---|---|
| system/app | BasicDreams, BluetoothMidiService, BookmarkProvider, EasterEgg, LiveWallpapersPicker, NfcNci, PartnerBookmarksProvider, PresencePolling, PrintRecommendationService, RcsService, SimAppDialog, Stk, Traceur |
| system/priv-app | BuiltInPrintService, CallLogBackup, CellBroadcastLegacyApp, DynamicSystemInstallationService, MusicFX, ONS, Tag |
| system_ext/priv-app | EmergencyInfo |
| product/app | Calendar, DeskClock, Gallery2, Music, PhotoTable, messaging |
| product/priv-app | Contacts, Dialer |

Deliberately **kept**, against the old list: `PrintSpooler` (PrintManagerService binds to it;
apps that print would hang), `WallpaperPicker` and `WallpaperCropper` (the launcher's "Wallpapers"
entry needs them — a branded default is no reason to take away changing it), `Camera2` (apps
that request a photo through `ACTION_IMAGE_CAPTURE` need a handler, and the AVD has emulated
cameras), `WallpaperBackup`.

**Props** appended to `/system/build.prop`: `ro.openemu.rom=1`, `ro.openemu.rom.version=<v>`,
`ro.config.wallpaper=/system/media/openemu/wallpaper.png`, `ro.setupwizard.mode=DISABLED`. No
performance "tweak" props: on a host-GPU emulator the usual `debug.hwui.*` / `windowsmgr.*`
folklore has no measured effect, and we only claim what we measure.

**Files**: `/system/media/openemu/wallpaper.png` (`system_file` label, 0644).

**Boot**: vbmeta verification disabled, `verifiedbootstate=orange`.

## Definition of done

- Unit tests: ext4 editor against a small generated fixture (create/remove/replace, then re-read
  and fsck-lite); GPT/LP/AVB against fixture bytes; recipe and build-prop rewrites against the real
  stock `build.prop` text. Full suite stays green.
- `npm run rom:check`: `e2fsck -fn` clean on all four volumes of the built image.
- On this machine, the real build from `default`:
  - boots with no `-writable-system`; `libfs_avb` status `VerificationDisabled`
  - `getprop` shows our identity from `/system` down; removed packages absent; wallpaper shown
  - measured against stock `fast`, same AVD settings: cold boot, warm start, `MemAvailable` after
    boot, process count, package count — reported as measured, whichever way it goes
  - the app's first run builds it with **WSL stopped**, then provisions and embeds it
- README, `documentation.md`, `android/MODIFICATIONS.md` describe what the ROM is and is not.

## Risks

| Risk | Mitigation |
|---|---|
| A bug in the ext4 writer corrupts `/system` | Refuse unknown features; never write a shared block; allocate only from initialised groups; fsck-lite on every build; e2fsck oracle in dev; staged build with atomic rename |
| Google republishes `default` with another layout | Partitions found by name through LP, files by path; unknown layout is a build error naming what differed |
| `verifiedbootstate=orange` is visible to apps | It is what every unlocked phone reports. It fails Play Integrity — irrelevant on an image with no GMS. The Play profile stays stock |
| Snapshot restored onto a changed ROM | Build-id check in the engine, above |
| 64 MB free on `system` limits additions | Debloat reclaims space via refcounted frees. Growing the partition (LP metadata + resize) is phase C work if additions outgrow it |

## Phase C — written down, not built

- **ARM translation.** The single biggest compatibility gap for games. Google's
  `libndk_translation` ships only in its GMS images and Intel's `libhoudini` is proprietary;
  neither can be redistributed, and grafting one from another image into ours is the SDK-licence
  question in its sharpest form. Needs a legal answer before code.
- **In-guest agent** (priv-app): a persistent input channel, clipboard, shared folder, virtual GPS
  — the roadmap's 1.2 and 2.4 done inside the ROM. Needs an APK toolchain (build-tools + a JDK at
  dev time).
- **Our launcher and store in the image**, and static RROs in `/product/overlay` for framework and
  SettingsProvider defaults — the AOSP-sanctioned way vendors restyle a ROM. Same toolchain.
- **Root toggle**: Magisk in the ramdisk (GPL-3.0, so source offer). The repo already patches
  gzipped cpio ramdisks in TypeScript.
- **Branded boot animation** in `/system/media/bootanimation.zip`.

## Work plan

1. `gpt.ts`, `lp.ts`, `avb.ts` + tests — subagent.
2. `ext4.ts` + fixture recipe + tests — me; it is the part that can corrupt a disk.
3. `build-prop.ts`, `recipe.ts` + tests — subagent, against the stock text.
4. Wallpaper: look from Cursor Grok; `wallpaper.ts` encoder — me/subagent.
5. `builder.ts`, CLI (`npm run rom:build`, `rom:check`), manifest, idempotence — me.
6. Engine integration: setup step, `-writable-system` removal, build-id invalidation, status —
   me; any UI through Grok.
7. On-machine verification and measurements; fix, re-plan with Grok if it fails.
8. Docs; retire `image-builder.ts` and `design/custom-image.md`; push.
