# Necessary modifications

Stock Google **Android 11 (API 30)** `google_apis;x86_64` system image — no AOSP
rebuild. Adaptations are AVD/runtime only, aimed at **speed + real workloads**:

## Hardware profile (`config/avd_config.ini`)

- SwiftShader GPU (`swiftshader`) for software rendering hosts
- **1080×1920 @ 420dpi (FHD)** guest framebuffer by default (was 720×1280)
- `skin.dynamic=yes`, no `-fixed-scale` — emulator window scales with resize
- `open-emu display hd|fhd|qhd|WxH` for live + next-boot resolution changes
- Audio input/output enabled; PulseAudio host backend when available
- Virtio Wi-Fi + full-speed networking + public DNS servers
- Guest Bluetooth virtual adapter enabled at boot/provision
- `open-emu audio|network|bluetooth` control commands
- 8 GiB `/data` + 512 MB sdcard for installing real apps
- Audio, keyboard, GPS, cameras enabled for app compatibility
- Play Store left enabled
- Snapshot boot pointed at `booted` after provision (used on KVM)

## Runtime (`bin/open-emu`)

- Host profile picks KVM vs TCG, core count, RAM
- **Warm path**: if the emulator is already running, `start` does not reboot
- **KVM**: `provision` saves snapshot `booted`; later starts load it
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
