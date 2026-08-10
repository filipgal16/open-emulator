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
| `keymap …` | Map host keys → on-screen taps/holds (LDPlayer-style) |
| `instance …` | Create, clone, start, stop, delete, and batch-control AVD instances |
| `macro …` | List, record, show, and run JSON tap/wait macros |
| `fps [30\|60\|90\|120\|show]` | Save/apply guest refresh-rate preference |
| `performance show\|set` | Save cores, memory, GPU, and FPS preferences |
| `gpu [swiftshader\|host\|auto\|guest]` | Shortcut for GPU mode preference |
| `share push\|pull\|open` | Move files through `/sdcard/OpenEmulator/` |
| `gps <lat> <lng>` / `gps show` | Set emulator location through `geo fix <lng> <lat>` |

## Performance model

| Host | Accel | Boot strategy |
|------|-------|---------------|
| `/dev/kvm` present | KVM | Named snapshot `booted` after provision (fast relaunch) |
| no KVM (TCG) | off | Optimized cold boot (~3 min here) + **keep emulator running** for warm reuse |

### Keyboard → on-screen buttons

Map host keys, mouse JSON events, or a gamepad to touch points (LDPlayer-style):

```bash
open-emu keymap use default
open-emu keymap set j 940 1550 tap Attack
open-emu keymap fire j          # test one binding
open-emu keymap run             # press keys in this terminal
# On a Linux desktop with a real keyboard:
open-emu keymap run --backend evdev
# Fan out to multiple adb devices:
open-emu keymap run --devices emulator-5554,emulator-5556
open-emu keymap sync on emulator-5556
```

The default profile uses one joystick binding (`cx`, `cy`, `radius`) for WASD
movement, including diagonals, plus taps for keyboard and gamepad buttons.
Backends are `auto`, `evdev`, `tty`, `line`, `mouse` (JSON lines), and
`gamepad` (left stick + A/B/X/Y). Profiles live in
`android/config/keymaps/`; active edits go to `android/state/custom_keymap.json`,
and follower sync state is saved in `android/state/keymap_sync.json`.

### LDPlayer-style instances

Create named AVD clones from the API 30 base image:

```bash
./android/bin/open-emu instance list
./android/bin/open-emu instance create game1 --cores 2 --memory 3072
./android/bin/open-emu instance clone game1 game2
./android/bin/open-emu instance start game1
./android/bin/open-emu instance batch start game1 game2
./android/bin/open-emu instance stop game1
./android/bin/open-emu instance delete game2
```

Instance state is stored in `android/state/instances.json` and each clone is named
`OpenEmulator_<name>`. Console/adb ports are allocated in emulator pairs:
`5554/5555`, `5556/5557`, and so on.

### Macros

Macros live in `android/config/macros/*.json`:

```bash
./android/bin/open-emu macro list
./android/bin/open-emu macro show demo-tap
./android/bin/open-emu macro record my-flow
./android/bin/open-emu macro run demo-tap --loop 3
./android/bin/open-emu macro run demo-tap --device emulator-5556
```

Supported steps include `tap`, `wait`, `swipe`, `keyevent`, and `text`.

### Performance, FPS, GPU, sharing, and GPS

```bash
./android/bin/open-emu performance show
./android/bin/open-emu performance set --cores 4 --memory 4096 --gpu host --fps 60
./android/bin/open-emu fps show
./android/bin/open-emu fps 90
./android/bin/open-emu gpu swiftshader

./android/bin/open-emu share push ./file.txt
./android/bin/open-emu share pull file.txt .
./android/bin/open-emu share open

./android/bin/open-emu gps 37.7749 -122.4194
./android/bin/open-emu gps show
```

Preferences are saved in `android/state/performance.env` and applied to the base
AVD `config.ini` when set. Live FPS updates use Android `settings put` where the
guest permits it. TCG/software acceleration can cap real-world FPS even when a
higher preference is saved.

```bash
./android/bin/open-emu audio          # status + max volumes
./android/bin/open-emu audio test     # play a short UI sound
./android/bin/open-emu network        # wifi/data/DNS reachability
./android/bin/open-emu network on     # enable wifi + mobile data
./android/bin/open-emu network redir tcp:8080:8080
./android/bin/open-emu bluetooth      # virtual BT adapter status
./android/bin/open-emu bluetooth on
```

- **Audio**: PulseAudio when available (`-audio pulse -allow-host-audio`); null sink on headless hosts
- **Network**: Virtio Wi-Fi, `netspeed full`, DNS `8.8.8.8,1.1.1.1`
- **Bluetooth**: guest virtual adapter enabled (host HCI passthrough is optional / BlueZ)

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
  lib/instances.sh       Multi-instance manager
  scripts/               fetch / setup / provision / bench
  scripts/macro_engine.py Macro record/run helper
  config/android_tracks.json  API 30 current + API 33/34 planned tracks
  config/macros/         JSON macros
  config/avd_config.ini  AVD hardware profile
  apps/                  Drop APKs here
  sdk/                   Local SDK + system image (gitignored)
  avd/                   AVD + snapshots (gitignored)
  state/                 pid, profile, provision markers
  imported/              Image identity + last verified results
```
