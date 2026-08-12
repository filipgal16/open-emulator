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
| `host-check` | KVM / RAM / disk without requiring the SDK |
| `instance …` | Isolated VMs: `list`, `create`, `clone`, `start`, `stop`, `delete` |

Target a machine with `--instance name` or `ANDROID_INSTANCE=name`. Each
instance is a separate AVD (own `/data`, sdcard, console/adb ports).

## Performance model

| Host | Accel | Boot strategy |
|------|-------|---------------|
| `/dev/kvm` present | KVM | Named snapshot `booted` after provision (fast relaunch) |
| no KVM (TCG) | off | Optimized cold boot (~3 min here) + **keep emulator running** for warm reuse |

Measured on this agent host (TCG, no KVM):

- Cold boot to `sys.boot_completed`: **~175–180s** (down from ~310s)
- Warm `start` while running: **immediate** (no reboot)
- Guest network: **ok**
- F-Droid APK install + Settings launch: **verified**

TCG cannot reliably load Emulator named snapshots (rejects / segfaults). That is
an upstream Emulator limitation without KVM — not papered over. On KVM hosts,
`provision` + snapshot load is the fast path.

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
