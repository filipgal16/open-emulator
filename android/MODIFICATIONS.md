# Necessary modifications

We import a stock Google **Android 11 (API 30)** `google_apis;x86_64` system
image. AOSP sources are **not** rebuilt.

Only host/AVD adaptations are applied so the image runs on this project’s hosts
(often without `/dev/kvm` or a GPU):

1. `android/config/avd_config.ini` — software GPU (`swiftshader_indirect`),
   reduced display (720×1280 @ 240dpi), 2 vCPU / 3 GiB RAM, audio off,
   cold boot, full network.
2. Emulator CLI flags in `scripts/run_android.sh` — `-no-window`, `-no-audio`,
   `-no-boot-anim`, `-accel off` when KVM is missing.
3. After boot — mark device provisioned, disable noisy first-run packages
   (Messages / Play Store) that ANR under TCG, then `am start` Settings.

Runtime engine today: Android Emulator QEMU (`ranchu`). `open-vmm` remains the
in-tree hypervisor foundation for later replacement of this engine.
