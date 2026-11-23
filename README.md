# open-emulator

**Android on your PC.** A Windows desktop app that runs Google's Android emulator natively, embeds
the emulator's own GPU-rendered window in its own, installs apps into the guest from a built-in
store, and stays out of your way.

No terminal. No configuration. Double-click, wait once, use Android.

Written in Rust. Version 0.3.0.

---

## Download

### [Download open-emulator for Windows](https://github.com/filipgal16/open-emulator/releases/latest)

**`open-emulator-Setup-<version>.exe`**, on the
[latest release](https://github.com/filipgal16/open-emulator/releases/latest). Per-user install, no
administrator prompt. The installer asks where to put the app, and the app asks where to put
Android. After that, the app tells you when a newer version is out — see [Updates](#updates).

> **The installer is unsigned.** Windows SmartScreen will show *"Windows protected your PC"*.
> Click **More info → Run anyway**. Removing that warning requires a code-signing certificate —
> see [Code signing](PACKAGING.md#code-signing).

Prefer to build it yourself? See [Building from source](#building-from-source).

If you have the Electron version (0.2.x or older) installed, run this installer over it. It removes
the old files and the old Apps & features entry, keeps your shortcuts and your data, and the old
app's own updater can install it too. See [`PACKAGING.md`](PACKAGING.md#updating-from-the-electron-version).

### What you need

| | |
|---|---|
| **OS** | Windows 10 or 11, x64 |
| **Virtualization** | Enabled in BIOS, and the **Windows Hypervisor Platform** turned on in *Windows Features*. Without it the emulator runs in software and is far too slow to use |
| **Disk** | About 10 GB free, and you choose the drive. The installer is small; Android is the rest |
| **Network** | Required for the first run only |

No Linux, WSL, JDK or Android Studio is involved. The app downloads the Android SDK pieces it needs
(about 1.1 GB) itself.

---

## First run

Double-click and wait. There is nothing to configure and no terminal involved.

The app works out what this PC already has, downloads the emulator and a system image (resumable,
and checked against Google's published digests), creates a device, and, where needed, builds the
open-emulator ROM from Google's stock image on your machine.

**You are not made to wait on the first boot.** Once the download is banked, the app opens straight
away and Android's one-time preparation — the single cold boot it ever does — runs in the background
while you browse Apps and the Store. The Device tab shows "Starting Android" until it is ready.
Every start after that resumes from a snapshot in about five seconds.

**Where Android is downloaded is up to you.** It is by far the largest thing here, so if your system
drive is small, point it at another one — Settings → Storage. Moving it later relocates what has
already been downloaded rather than fetching it again.

**Setup does not require a restart.** If Windows needs one before hardware acceleration is
available, that is the last step rather than a gate at the beginning.

If something fails, the setup screen says what failed and offers **Try again**; **Details** shows
the step list and the full log. Nothing already downloaded is fetched twice.

---

## Using it

### Device

The Android display. This is the emulator's own GPU-rendered window, embedded directly in the app,
so it runs at the emulator's frame rate and mouse and keyboard reach Android without a round trip.
The device keeps its own aspect ratio and is centred in the pane, the way a phone sits on a desk.
Where there is no such window to embed, the screen is mirrored frame by frame instead.

A tool rail beside it holds back, home and recents, fullscreen, rotate, screenshot, volume and
power. The title bar holds the **Device / Apps / Store / Settings** tabs and the Android version
menu, with start and stop.

### Apps

Everything installed in the guest. Click one to launch it.

### Store

Three sources behind one search box:

| Source | What it is |
|---|---|
| **F-Droid** | About 4,300 open-source apps. The catalogue is downloaded once and searched locally, so results are instant and work offline. Every download is checked against the SHA-256 F-Droid publishes before it reaches the guest. |
| **Play** | The real Google Play Store, running inside the guest and steered with `market://` intents. Needs a Google guest version — the tab offers a switch. |
| **Local** | Press **Install from file…**, or drag a file onto the window. Takes `.apk`, and the `.xapk` / `.apks` bundles games are usually shipped as — the app picks the right split parts for the device's ABI and installs them together, including OBB data. |

Apps needing a newer Android than the guest are shown with the reason rather than hidden, so an
install never fails after a long download.

### Account

The account chip holds one account across every guest. It notices when a guest is already signed in
to Google, and can fill your address and password into Google's own sign-in screen — the same job a
password manager does. You complete the flow, including two-factor.

The password is optional, off by default, and sealed with Windows DPAPI for your Windows user. If
that fails the app stores nothing rather than falling back to a plain file. A password saved by the
old Electron version is migrated automatically.

### Settings

Everything is set in the app; there is no file to edit.

- **Appearance** — light, dark, or follow Windows.
- **Device identity** — which handset the guest reports as.
- **Display** — the screen follows the window, so its size is the resolution. A slider sets how
  large Android draws things inside it.
- **Performance** — processor cores and memory, each with an **Automatic** switch, a slider and a
  box to type a number into. Changes apply at the next start.
- **Storage** — where Android is downloaded, with a folder picker that moves what is already there.
- **Windows Defender** — an opt-in exclusion for the emulator's folder. Real-time scanning of the
  guest's disk writes slows boots; the exclusion is added only when you ask, with one UAC prompt.
- **Updates** — see below.

### Updates

The app looks for a newer version in the background by reading `latest.yml` on the latest GitHub
release, and when there is one puts a dot on **Settings**. Nothing downloads until you press
**Download** in Settings → Updates, the download is verified against the SHA-512 in `latest.yml`,
and nothing installs until you press **Restart to update** — or close the app, which installs it
then. It never offers an older version than the one you have.

### Android versions

The version menu switches guests. Each keeps its own device, apps, and snapshot, so switching never
disturbs the others. The guests are defined by `android/profiles/*.env`.

| Version | Profile | What it is | Ships? |
|---|---|---|---|
| **open-emulator Android** | `openemu` | Our own ROM, built on your PC from Google's stock AOSP image: debloated and rebranded. The default. | Derived from Apache-2.0 AOSP — see [`LICENSING.md`](LICENSING.md) |
| **open-emulator Android (Google APIs)** | `openemu-compat` | The same recipe applied to the Google APIs image, for games: runs apps made for ARM phones, with Google Play Services. | Built from Google's image on your PC — personal use |
| **Fast** | `fast` | Plain stock Android (AOSP). Boots quickest, no Google Play. | Apache-2.0 upstream |
| **Google apps** | `full` | Adds Google Play Services for apps that need them. | Google proprietary — personal use |
| **Play Store** | `play` | Google Play built in. | Google proprietary — personal use |

Everything marked personal use contains Google Mobile Services, which cannot be redistributed. Read
[`LICENSING.md`](LICENSING.md) before shipping anything based on them.

---

## Building from source

You need Rust 1.90 or newer with the **MSVC** toolchain (Visual Studio Build Tools with the C++
workload) on Windows.

```bash
cargo build --release -p oe-ui      # target/release/open-emulator.exe
cargo run --release -p oe-ui        # build and start it
cargo test --workspace              # the whole test suite
cargo xtask dist                    # release build + installer + latest.yml in target/dist/
```

`cargo xtask dist` needs [NSIS](https://nsis.sourceforge.io/)'s `makensis`; without it, use
`cargo xtask dist --stage-only` to produce the staged app folder only. Details are in
[`PACKAGING.md`](PACKAGING.md).

`oe-vmm` builds and tests on Linux and macOS too (its KVM backend is Linux only):
`cargo test -p oe-vmm`.

### Developer tasks

`cargo xtask <command>`:

| Command | Does |
|---|---|
| `dist` | Release build, NSIS installer and `latest.yml`. `--skip-build`, `--stage-only` |
| `rom-build` | Builds an open-emulator ROM from a downloaded stock image |
| `rom-check` | Checks a built ROM against its recipe |
| `wallpaper <out>` | Renders the default wallpaper to a PNG |
| `icon` | Regenerates the app icon (PNG and ICO) |
| `bench ...` | Timing runs against the emulator and other runtimes |
| `emu-compare ...` | Compares two emulator configurations |
| `start-game-avd` | Starts a game AVD the way the native engine does |

### Developer switches

Environment variables read by the app:

| Variable | Effect |
|---|---|
| `OPEN_EMULATOR_USER_DATA` | Use this folder instead of `%APPDATA%\open-emulator` |
| `OPEN_EMULATOR_SETUP` | `check`: setup only checks what is there. `skip`: go straight to the app, with no multi-gigabyte download |
| `OPEN_EMULATOR_VIEW` | Open on a screen: `apps`, `store`, `settings`, `account`, `setup` or `menu` |
| `OPEN_EMULATOR_ANDROID_ROOT` | Where `android/` (profiles, devices, AVD config) is, when running from a checkout |
| `ICED_BACKEND` | `tiny-skia` selects the software renderer instead of the GPU one |
| `ANDROID_ADB_SERVER_PORT` | The port of the adb server to use |

---

## How it works

```
  open-emulator.exe (oe-ui, iced)
        │
        ▼
  oe-core ── Core API and event stream: setup, settings, account, updates
        │
        ├── oe-engine ── emulator.exe, adb protocol, AVDs, SDK download ──► Android emulator ─► guest
        ├── oe-store  ── F-Droid, local files, installer, Play via intents
        ├── oe-formats ─ ext4, AVB, GPT, LP, build.prop, ROM builder (pure, no Win32)
        └── oe-win ───── every Win32 call: window embedding, UAC, registry, DPAPI, WMI
```

The app starts `emulator.exe` from the Android SDK as an ordinary Windows process and reparents its
window into the app's window (`SetParent`). The app talks to the guest through an adb client that
speaks adb's socket protocol directly; `adb.exe` is used only to start the server and for installs
and pushes. A persistent guest shell carries taps and key events.

Everything the interface shows, including app icons, is fetched by the Rust side. Images go through
an https-only cache that checks their magic bytes before they are drawn.

## Layout

```text
crates/
  oe-formats/       pure codecs: ext4 editor, AVB signing, GPT, LP (super partition), build.prop,
                    ROM recipes and builder, wallpaper PNG, cpio / iso9660 / initrd, zip reading
  oe-win/           every Win32 call: window embedding, process lookup, UAC elevation, registry,
                    services, WMI probes, DPAPI, Defender exclusion reads
  oe-engine/        SDK download/verify/extract, licences, AVD creation, adb client, guest shell,
                    the SDK engine (start/stop/status/provision, snapshots), screen mirror, Defender
  oe-store/         F-Droid catalogue, local app files and bundles, installer, Play via intents,
                    image cache
  oe-core/          first-run setup, settings, account, updater, the Core API and its event stream
  oe-ui/            the iced GUI; builds open-emulator.exe
  oe-vmm/           x86 real-mode interpreter and a KVM backend (Linux); builds open-vmm
xtask/              cargo xtask: dist, rom-build, rom-check, wallpaper, icon, bench, ...
packaging/windows/  installer.nsi, the NSIS installer script
android/            data the app reads: profiles/, devices/, config/avd_config.ini, apps/
design/             design notes, including the ROM (design/openemu-rom.md)
.github/workflows/  ci.yml (tests) and release.yml (installer and GitHub release)
```

## Data

Unchanged from the Electron version, so an upgrade finds everything where it was left:

| Where | What |
|---|---|
| `%LOCALAPPDATA%\Programs\open-emulator` | The installed app |
| `%APPDATA%\open-emulator` | `settings.json`, `device.json`, `account.json`, store caches |
| `%LOCALAPPDATA%\open-emulator`, or the folder chosen in Settings | The Android SDK, AVDs, state and ROMs |

Uninstalling removes the app and leaves all of the data.

## Documentation

| Document | Covers |
|---|---|
| [`documentation.md`](documentation.md) | The full reference |
| [`PACKAGING.md`](PACKAGING.md) | Building and shipping the installer, releases, updates |
| [`LICENSING.md`](LICENSING.md) | What every dependency means if you sell this |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | The Rust crates the app is built from, and their licences |
| [`android/MODIFICATIONS.md`](android/MODIFICATIONS.md) | What the guest is tuned for |
| [`design/`](design/) | Design notes: the ROM, the 60 fps display, the roadmap |

## Licence

No licence file is present, which means **all rights reserved**. This is deliberate while the
monetization path is open — see [`LICENSING.md`](LICENSING.md). Third-party attribution is recorded
in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
