# Necessary modifications

Stock Google **Android 11 (API 30)** `google_apis;x86_64` system image — no AOSP
rebuild. Adaptations are AVD/runtime only, aimed at **speed + real workloads**:

## Hardware profile (`config/avd_config.ini`)

- SwiftShader GPU (`swiftshader`) for software rendering hosts
- 720×1280 @ 240dpi (lighter than flagship skins; still usable)
- 8 GiB `/data` + 512 MB sdcard for installing real apps
- Audio, keyboard, GPS, cameras enabled for app compatibility
- Play Store left enabled
- Snapshot boot pointed at `booted` after provision (used on KVM)

## Guest profiles (`profiles/`)

- `fast` — AOSP, no GMS. Fastest boot, the default.
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
