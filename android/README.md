# Android guest runtime (API 30 / Android 11)

Production-oriented guest bring-up for open-emulator: host-aware performance,
warm-daemon reuse, working network, APK install/launch, and a real CLI.

## Quick start

```bash
make android-fetch          # once (~4 GiB)
make android-setup
make android-provision      # cold boot + tune (+ snapshot on KVM hosts)
make android-start          # subsequent calls reuse a running emulator
./android/bin/open-emu doctor
./android/bin/open-emu install path/to/app.apk
./android/bin/open-emu launch com.android.settings/.Settings
```

## CLI (`android/bin/open-emu`)

| Command | Purpose |
|---------|---------|
| `profile` | Detect KVM/cores/RAM → write performance profile |
| `start [--cold]` | Boot Android (**warm** if already running) |
| `stop` | Clean shutdown |
| `provision` | Real-workload tuning + snapshot save |
| `install <apk>` | `adb install -r -g` with timeout safety |
| `launch <comp>` | Start an activity |
| `shell` / `push` / `pull` / `logcat` / `screenshot` | Device I/O |
| `doctor` | Network, storage, package manager checks |
| `demo` | End-to-end verify path |

## Performance model

| Host | Accel | Boot strategy |
|------|-------|---------------|
| `/dev/kvm` present | KVM | Named snapshot `booted` after provision (fast relaunch) |
| no KVM (TCG) | off | Optimized cold boot (~3 min here) + **keep emulator running** for warm reuse |

### Display (scales with window)

Default guest framebuffer is **1080×1920 @ 420dpi (FHD)**. The emulator Qt
window is **not fixed-scale** — resize the window and the display scales with it.

```bash
./android/bin/open-emu display          # show current
./android/bin/open-emu display fhd      # 1080x1920 @ 420
./android/bin/open-emu display qhd      # 1440x2560 @ 560
./android/bin/open-emu display 1280x720 # custom landscape
# or: ANDROID_DISPLAY=qhd ./android/bin/open-emu start --cold
```

Presets: `hd` (720×1280), `fhd` (1080×1920), `qhd` (1440×2560).

## Real-world defaults

- Google APIs image (Play Store / GMS available)
- 8 GiB `/data` + 512 MB sdcard
- Full-speed network (`netdelay none`, `netspeed full`)
- Audio / keyboard / GPS / cameras enabled for app compatibility
- Setup wizard completed; third-party APK installs allowed
- Animations reduced for smoother interaction under software rendering
- Drop APKs in `android/apps/` for auto-install during provision

## Layout

```text
android/
  bin/open-emu           Control plane CLI
  lib/common.sh          Shared helpers
  scripts/               fetch / setup / provision / bench
  config/avd_config.ini  AVD hardware profile
  apps/                  Drop APKs here
  sdk/                   Local SDK + system image (gitignored)
  avd/                   AVD + snapshots (gitignored)
  state/                 pid, profile, provision markers
  imported/              Image identity + last verified results
```
