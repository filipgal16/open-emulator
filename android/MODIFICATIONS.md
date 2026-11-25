# Necessary modifications

Two kinds, and they are different in kind:

- **Our own ROM** (`openemu`, the default) changes the image itself: the AOSP `default` Android 11
  image, rebuilt on the user's machine by the app, debloated, rebranded, carrying its own files,
  and re-signed so `/system` boots without dm-verity putting Google's bytes back. The full
  account, with the measurements behind each choice, is
  [`design/openemu-rom.md`](../design/openemu-rom.md); the recipe itself is
  `crates/oe-formats/src/recipes.rs`.
- **Everything below** is AVD/runtime configuration that applies to every profile, the stock
  Google images included. No AOSP rebuild is involved in either.

## Our own ROM, in one table

| | Stock `default` | `openemu` |
|---|---|---|
| Identity | `Android SDK built for x86_64`, `generic`, `sdk_phone_x86_64` | `OpenEmulator One` by `open-emulator`, build `open-emulator Android 11 (openemu 1)` |
| `/system` verity | dm-verity + FEC: edits are repaired back at boot | `HASHTREE_DISABLED` in a vbmeta re-signed with our key; boot state stays locked-looking (no `orange`) |
| Bundled apps | 28 phone apps and services an emulator has no use for | removed from all four partitions, ~84 MB reclaimed; every provider and telephony service kept |
| Default wallpaper | AOSP's | ours, shipped in `/system/media/openemu/` |
| Signing | Google's key | a per-machine RSA-4096 key; the guest trusts any key for the top-level vbmeta, what binds is the digest on the kernel command line |

The rest of this file is the runtime configuration every profile shares.

## Hardware profile (`config/avd_config.ini`)

- SwiftShader GPU (`swiftshader`) for software rendering hosts
- 720×1280 @ 240dpi (lighter than flagship skins; still usable)
- 8 GiB `/data` + 512 MB sdcard for installing real apps
- Audio, keyboard, GPS, cameras enabled for app compatibility
- Play Store left enabled
- Snapshot boot pointed at `booted` after provision (used on KVM)

## Guest profiles (`profiles/`)

- `openemu`: our own ROM, built from AOSP `default` on the user's machine. The default on the
  native runtime. See the table above and `design/openemu-rom.md`.
- `openemu-compat`: our second ROM, built from `google_apis` (Android 14) on the user's machine,
  for ARM games: the Google image is the one with an ARM translator. Google apps an emulator
  does not need are removed, Play services and Google's device identity are left as shipped, and
  ARM apps are shown every guest core instead of one. Contains Google software; see
  `design/openemu-rom.md` ("openemu-compat") and `LICENSING.md` before shipping it.
- `fast`: stock AOSP, no GMS. Untouched Google image.
- `full`: `google_apis`. GMS, but no Play Store app.
- `play`: `google_apis_playstore`. Google's own Play-enabled image; the only one that ships
  `com.android.vending`, and what the desktop Store's Play tab wraps. Not `adb root`-able, and
  spoofing its build fingerprint breaks Play certification; keep it on the stock `generic` device.

## Runtime (`crates/oe-engine`)

The app drives Google's emulator natively on Windows, accelerated by the Windows Hypervisor
Platform. No Linux and no WSL are involved.

- The host's processors, memory and graphics pick the core count, RAM and renderer.
- The emulator runs with no window of its own (`-qt-hide-window`). The app draws Android from its
  gRPC screen stream and sends input back the same way.
- **Warm path**: an emulator that is already running is adopted, not rebooted.
- **First start** (`provision`): the setup wizard is completed, third-party installs are allowed,
  networking is checked, Settings and SystemUI are compiled ahead of time, and the `default_boot`
  snapshot is saved. Later starts resume from it.
- Runtime state (`provisioned_at`, `rom_id`, pid) lives under `state/<AVD>/`, one folder per
  profile, so one guest's state never stands in for another's.
- APK installs use timeouts, so a stalled guest cannot hang the app.

## Verified

On a Windows laptop with WHPX (i5-10210U, 8 GB): Android 11 / API 30 cold-boots in about 43 s
from emulator start, and the gRPC display delivers 60 frames a second at 720×1280.

## Engine note

Android still runs on the Android Emulator QEMU (`ranchu`) machine model until
`open-vmm` grows long-mode + virtio/goldfish devices. The control plane and AVD
assets are structured so that backend can be swapped later without rewriting
APK install / launch / adb workflows.
