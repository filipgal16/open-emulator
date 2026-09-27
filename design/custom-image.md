# openemu: our own build of Android

A plan, then the record of doing it. The goal is what LDPlayer, BlueStacks and MEmu each have: an
Android that exists only to run inside this emulator — debloated, tuned to the machine it runs on,
and carrying our name rather than "sdk_phone_x86_64".

## What "custom Android" means here, and what it does not

**Not** compiling AOSP. That is a Linux box, ~400 GB of disk and hours per build, and the result
would be a bit-identical `sdk_phone_x86_64` because the emulator's device tree *is* AOSP's. The
vendors above do not build from source for every release either; they maintain a tuned image.

**Yes**: take the open-source image we already download (`android-30;default;x86_64`, Apache-2.0
userspace), reshape it, and ship the result as the `openemu` image. Everything below is an edit to
an ext4 volume or a boot-time setting. The kernel is stock; the framework is stock. What changes is
what is *in* the image and how it presents itself.

## The image, and why it can be edited at all

`system.img` is a 3 GB dynamic-partition "super" container holding four ext4 volumes:

| Volume | Offset | Size | Holds |
|---|---|---|---|
| `/` (system) | 3145728 | 1012 MB | framework, `/system/app`, `/system/priv-app`, 64 MB free |
| `system_ext` | 1082130432 | 100 MB | Settings, SystemUI, Launcher3, full |
| `product` | 1189085184 | 248 MB | the bundled apps — where the bloat is, full |
| `vendor` | 1454374912 | 63 MB | HALs, full |

All four carry ext4's `shared_blocks` (identical blocks deduplicated) and three are 100% full, so a
read-write mount is refused and `e2fsck -E unshare_blocks` cannot help. Two operations are still
safe on an unmounted volume through `debugfs`, and they are the only two the build needs:

- **`unlink`** removes a directory entry without freeing the inode or its blocks. The app
  disappears from the package manager's view; nothing shared with another file is touched. Link
  counts end up off by one, which matters to `e2fsck` and to nothing that mounts `/system`
  read-only.
- **`rm` + `write`** of `build.prop`, held at its original byte length so the rewrite needs no
  blocks it does not already own. Comment lines are dropped first if the identity strings grow
  the file.

Verified boot: do **not** patch vbmeta. Setting `VERIFICATION_DISABLED` changes the signature;
this ramdisk then logs `ERROR_VERIFICATION / PUBLIC_KEY_REJECTED isn't allowed`, never mounts
`/system`, and boot-loops with adb stuck `offline`. The emulator already has the switch for a
modified `/system`: `-writable-system`. The first boot is the proof.

## What the build does

1. Copies `system-images/android-30/default/x86_64` → `system-images/android-30/openemu/x86_64`.
   The stock image is never modified; delete the copy to get back to it.
2. Finds the four volumes by scanning for the ext4 superblock magic (they move between releases).
3. **Debloats.** Unlinks the apps an emulator used to run other apps has no use for, from every
   partition. The list is conservative: nothing the framework, the launcher, Settings, the
   keyboard, WebView or telephony's own services depend on.
4. **Rebrands.** Rewrites `ro.product.<partition>.{brand,manufacturer,model,name,device}` and the
   per-partition fingerprints in all four `build.prop`s, so `getprop ro.product.model` reads
   `OpenEmulator One` and the About screen says open-emulator. Adds `ro.openemu.image` markers to
   `/system/build.prop` (the one volume with free space) so the shell can tell it is running its
   own image.
5. Rewrites `source.properties` (`TagId=openemu`) and writes a manifest of every edit.
6. Leaves vbmeta stock. A previous revision patched it and boot-looped; the emulator is started
   with `-writable-system` instead so verity is off for this guest only.

Runs from Node via `wsl.exe` and the distro's `debugfs` — a build-time toolchain, the way every
ROM is built on Linux. The output is what users get; they never run the build.

## Runtime tuning that belongs to the image

Baked in at provision rather than in `build.prop`, because Android keeps these in `userdata` and
the snapshot preserves them: animations at 0 (nothing to ease on a host-GPU window), Bluetooth
off (the stack is unlinked), screen never off, setup wizard complete, `pm compile -m
speed-profile` for Settings and SystemUI. `build.prop` changes that *claim* speed (`debug.hwui.*`,
`ro.hwui.*` cache sizes, `windowsmgr.max_events_per_sec`) are folklore on a host-GPU emulator and
are deliberately not added — the measured wins are fewer processes at boot, less RAM, and less
work for the package manager.

## Integration

- `android/profiles/openemu.env` — the profile. `PROFILE_BASE_IMAGE_TAG=default` says the image
  is derived: setup downloads the base, then builds.
- The shell's version picker gains **open-emulator**. Selecting it with no image present runs the
  build as the setup step's fix.
- Everything else — AVD creation, snapshots, provision, embedding — is unchanged; the profile is
  just another image tag.

## Verification

Against the stock `fast` guest on the same machine, same AVD settings:

- boots to `sys.boot_completed`, and the cold-boot time
- `getprop ro.product.model`, `ro.product.brand` (from `/product`; `/system` stays stock because
  of dm-verity — do not patch vbmeta, and do not `adb disable-verity` during provision, both
  boot-loop this ramdisk)
- `pm list packages` for the product apps that were unlinked
- Settings launches; animations at 0; the embedded window still renders at VSYNC

## Follow-ups this deliberately leaves

- **Host the built image** (~1.1 GB compressed) so users download `openemu` directly instead of
  the base plus a build step. Until then the profile builds locally, which needs WSL.
- A landscape, tablet-density device profile as the default panel, which is the other half of how
  LDPlayer's Android "feels" different — that is a `devices/*.env`, not an image change.
