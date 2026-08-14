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

## Relocating data (packaged desktop builds)

Everything under `sdk/`, `avd/`, `state/`, `logs/`, `apps/` is mutable
runtime data, not code. `android_env()` in [`lib/common.sh`](lib/common.sh)
lets each of those move independently via environment overrides, so an
installed app can keep the multi-GiB SDK/AVD data in a writable per-user
data directory instead of next to a possibly read-only install:

| Variable | Default |
|----------|---------|
| `ANDROID_SDK_ROOT` | `android/sdk` |
| `ANDROID_AVD_HOME` | `android/avd` |
| `ANDROID_LOG_DIR` | `android/logs` |
| `ANDROID_APPS_DIR` | `android/apps` |
| `ANDROID_STATE_DIR` | `android/state` |

The desktop shell sets all five automatically for packaged installs — see
[`desktop/lib/paths.js`](../desktop/lib/paths.js).

## Performance model

| Host | Accel | Boot strategy |
|------|-------|---------------|
| `/dev/kvm` usable (read+write) | KVM | Named snapshot `booted` after provision — **target ≤30s** to `boot_completed` |
| `/dev/kvm` missing or not accessible | TCG | Cold boot (~3 min here) + **keep emulator running** for warm reuse |

`open-emu status` reports `boot_path=warm|snapshot|cold`. See [`docs/BOOT.md`](../docs/BOOT.md) for the exact conditions.

Measured on this agent host (TCG, `/dev/kvm` not usable by this user):

- Cold boot to `sys.boot_completed`: **~175–180s** (down from ~310s)
- Warm `start` while running: **immediate** (no reboot)
- Guest network: **ok**
- F-Droid APK install + Settings launch: **verified**
- Snapshot-path helpers: **`make android-test`** (no system image in this sandbox, so a live ≤30s KVM number could not be taken here)

TCG cannot reliably load Emulator named snapshots (rejects / segfaults). That is
an upstream Emulator limitation without KVM — not papered over. On KVM hosts,
`provision` + snapshot load is the fast path, and it is the path `open-emu
instance start` actually uses (it used to pass `-no-snapshot-load` every time).

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
  lib/boot.sh            Fast-boot flags, snapshot policy, launch/wait
  lib/avd_config.py      config.ini edits that no-op when unchanged
  scripts/               fetch / setup / provision / bench / boot-helper tests
  config/avd_config.ini  AVD hardware profile
  apps/                  Drop APKs here
  sdk/                   Local SDK + system image (gitignored)
  avd/                   AVD + snapshots (gitignored)
  state/                 pid, profile, provision markers
  imported/              Image identity + last verified results
```
