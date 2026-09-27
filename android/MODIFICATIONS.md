# Necessary modifications

Two kinds, and they are different in kind:

- **Our own ROM** (`openemu`, the default on the native runtime) changes the image itself: the
  AOSP `default` Android 11 image, rebuilt on the user's machine by the desktop app — debloated,
  rebranded, carrying its own files, and re-signed so `/system` boots without dm-verity putting
  Google's bytes back. The full account, with the measurements behind each choice, is
  [`design/openemu-rom.md`](../design/openemu-rom.md); the recipe itself is
  `desktop/src/main/rom/recipe.ts`.
- **Everything below** is AVD/runtime configuration that applies to every profile, the stock
  Google images included. No AOSP rebuild is involved in either.

## Our own ROM, in one table

| | Stock `default` | `openemu` |
|---|---|---|
| Identity | `Android SDK built for x86_64`, `generic`, `sdk_phone_x86_64` | `OpenEmulator One` by `open-emulator`, build `open-emulator Android 11 (openemu 1)` |
| `/system` verity | dm-verity + FEC — edits are repaired back at boot | `HASHTREE_DISABLED` in a vbmeta re-signed with our key; boot state stays locked-looking (no `orange`) |
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

- `openemu` — our own ROM, built from AOSP `default` on the user's machine. The default on the
  native runtime. See the table above and `design/openemu-rom.md`.
- `fast` — stock AOSP, no GMS. Untouched Google image.
- `full` — `google_apis`. GMS, but no Play Store app.
- `play` — `google_apis_playstore`. Google's own Play-enabled image; the only one that ships
  `com.android.vending`, and what the desktop Store's Play tab wraps. Not `adb root`-able, and
  spoofing its build fingerprint breaks Play certification — keep it on the stock `generic` device.

## Runtime (`bin/open-emu`)

- Host profile picks KVM vs TCG, core count, RAM
- **Warm path**: if the emulator is already running, `start` does not reboot
- **KVM**: `provision` saves snapshot `booted`; later starts load it
- The emulator is launched with `setsid`, not just `nohup`. `nohup` only ignores SIGHUP; the process
  stays in the calling session, and WSL tears a session down when the `wsl.exe` that created it
  exits. From an interactive shell that never happens, which is why this survived so long — but the
  desktop app starts the guest with a one-shot `wsl.exe` call, and the emulator was being killed a
  second after it finished booting.
- Runtime state (`provisioned_at`, pid, adb device) lives under `state/<AVD>/`, not `state/`.
  Sharing it across profiles made `demo` skip provisioning for a guest that had never been
  provisioned; host CPU/RAM detection stays shared, since it describes the machine.
- **TCG**: skip unloadable named snapshots; optimize cold boot; leave process up
- Setup wizard completed; network verified; third-party installs allowed
- APK install uses timeouts so TCG stalls cannot hang the control plane forever

## Verified (agent host, TCG)

See `imported/last_verified.txt`: Android 11 / API 30, Settings resumed,
F-Droid installed, guest network ok, cold boot ~3 minutes.

## Engine note

Android still runs on the Android Emulator QEMU (`ranchu`) machine model until
`open-vmm` grows long-mode + virtio/goldfish devices. The control plane and AVD
assets are structured so that backend can be swapped later without rewriting
APK install / launch / adb workflows.
