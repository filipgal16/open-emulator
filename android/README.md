# Android guest (API 30 / Android 11)

This folder holds an **imported Android 11** system image and the minimal host-side
configuration needed to boot it and open an app on the current open-emulator host.

## Why not `open-vmm` alone?

`open-vmm` (step 1) is still a real-mode hello VMM. Android needs a full machine
model (long mode, virtio/goldfish devices, GPU, block). Until that lands in
`open-vmm`, Android runs on the **Android Emulator’s QEMU engine**, which is the
same class of Type-2 hypervisor stack we are building toward.

## Layout

```text
android/
  scripts/fetch_android.sh   Download SDK + Android 11 x86_64 image
  scripts/setup_avd.sh       Create AVD + apply config overlays
  scripts/run_android.sh     Boot headless, wait for boot, launch an app
  config/avd_config.ini      Necessary host adaptations (software GPU, RAM, …)
  sdk/                       Downloaded Android SDK + system image (gitignored)
  avd/                       Local AVD files (gitignored)
  logs/                      Boot / run logs (gitignored)
  apps/                      Optional APKs to sideload later
  VERSION.txt                Written by fetch (API / image identity)
```

## Necessary modifications (host only)

We do **not** patch AOSP sources. The only adaptations are AVD/emulator flags so
Android runs on this machine without KVM/GPU:

| Setting | Value | Why |
|---------|-------|-----|
| `hw.gpu.mode` | `swiftshader_indirect` | No host GPU passthrough |
| `-accel off` (when no `/dev/kvm`) | TCG | Nested virt unavailable here |
| `hw.audioInput/Output` | `no` | Avoid host audio device issues |
| `-no-window -no-boot-anim` | headless | Cloud/CI friendly |
| `fastboot.forceColdBoot` | `yes` | Deterministic boots |

## Quick start

```bash
make android-fetch   # ~1.5–2 GiB download, once
make android-setup
make android-run     # boots Android 11, opens Settings
```

Default launch component: `com.android.settings/.Settings`  
Override with `ANDROID_LAUNCH_COMPONENT=... make android-run`.

## Success criteria

`android/logs/last_success.txt` contains `ok=1` and reports Android version/API
after Settings (or fallback calculator) has been started via `adb`.
