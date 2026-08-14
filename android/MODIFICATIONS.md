# Necessary modifications

Stock Google **Android 11 (API 30)** `google_apis;x86_64` system image — no AOSP
rebuild. Adaptations are AVD/runtime only, aimed at **speed + real workloads**:

## Hardware profile (`config/avd_config.ini`)

- SwiftShader GPU (`swiftshader_indirect`) for software rendering hosts
- 720×1280 @ 240dpi (lighter than flagship skins; still usable)
- 8 GiB `/data` + 512 MB sdcard for installing real apps
- Audio, keyboard, GPS, cameras enabled for app compatibility
- Play Store left enabled
- Snapshot boot pointed at `booted` after provision (used on KVM)

## Runtime (`bin/open-emu`)

- Host profile picks KVM vs TCG, core count, RAM
- **Warm path**: if the emulator is already running, `start` does not reboot
- **KVM**: `provision` saves snapshot `booted`; later starts load it (target ≤30s — see [`docs/BOOT.md`](../docs/BOOT.md))
- **TCG**: skip unloadable named snapshots; optimize cold boot; leave process up
- `instance start` uses the same snapshot path as `start_emulator` (it used to force `-no-snapshot-load`)
- `config.ini` cores/RAM/GPU are not rewritten when they already match, so snapshots stay valid
- Setup wizard completed; network verified; third-party installs allowed
- APK install uses timeouts so TCG stalls cannot hang the control plane forever
- Isolated machines: `open-emu instance create|clone|start|stop|delete` copies AVD userdata onto unique console/adb ports; clones with matching cores/RAM keep the source snapshot

## Verified (agent host, TCG)

See `imported/last_verified.txt`: Android 11 / API 30, Settings resumed,
F-Droid installed, guest network ok, cold boot ~3 minutes.

## Engine note

Android still runs on the Android Emulator QEMU (`ranchu`) machine model until
`open-vmm` grows long-mode + virtio/goldfish devices. The control plane and AVD
assets are structured so that backend can be swapped later without rewriting
APK install / launch / adb workflows.
