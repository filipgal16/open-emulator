# open-emulator

**Android on your PC.** A Windows desktop app that runs Google's Android emulator natively, embeds
the emulator's own GPU-rendered window in its own, installs apps into the guest from a built-in
store, and stays out of your way.

No terminal. No configuration. Double-click, wait once, use Android.

> **Status: this is 0.3.0, the Rust rewrite, and it is not released yet.** It lives on the
> `rust-rewrite` branch. The [latest release](https://github.com/filipgal16/open-emulator/releases/latest)
> is still 0.2.0, the Electron app.
>
> CI runs the whole test suite on Windows and the `oe-vmm` tests on Linux, and both pass. Not yet
> done with this build: booting Android end to end on real hardware, building the installer, and
> upgrading an Electron install to it.

---

## Download

0.3.0 has no installer yet. To try it, [build it from source](#building-from-source).

From 0.3.0 on, each [release](https://github.com/filipgal16/open-emulator/releases) carries
**`open-emulator-Setup-<version>.exe`**:

- It installs for your Windows user only, so there is no administrator prompt. The app goes to
  `%LOCALAPPDATA%\Programs\open-emulator` unless you pick another folder in the installer.
- Run over the Electron version (0.2.x or older), it removes the old files and the old Apps &
  features entry and keeps your data. The Electron app's own updater is meant to install it as well.
  See [`PACKAGING.md`](PACKAGING.md#updating-from-the-electron-version).
- From then on the app tells you when a newer version is out. See [Updates](#updates).

> **The installer is unsigned.** Windows SmartScreen will show *"Windows protected your PC"*.
> Click **More info → Run anyway**. Removing that warning requires a code-signing certificate.
> See [Code signing](PACKAGING.md#code-signing).

### What you need

| | |
|---|---|
| **OS** | Windows 10 or 11, x64 |
| **Virtualization** | Turned on in the PC's firmware (BIOS/UEFI). If the **Windows Hypervisor Platform** is off, setup turns it on; Windows asks for permission, then needs a restart. Without acceleration the emulator falls back to running in software, which is very slow |
| **Disk** | About 10 GB free. The app itself is about 15 MB; Android takes the rest |
| **Network** | Needed for the first run and to download apps |

No Linux, WSL, JDK or Android Studio is involved. The app downloads the Android SDK parts it needs
(about 1.2 GB) by itself.

---

## First run

Double-click and wait. There is nothing to configure and no terminal involved.

Setup checks three things and fixes what it can:

1. **Hardware acceleration.** If the Windows Hypervisor Platform is off but this PC can run it,
   setup turns it on, and Windows asks for permission. Windows needs a restart to finish turning it
   on, and setup tells you so. Setup carries on without acceleration, because the emulator can fall
   back to running in software, only much more slowly.
2. **Android system image.** Downloads the emulator and the system image. The download resumes
   after an interruption, and each file is checked against the digest Google publishes. For an
   open-emulator version of Android, setup also builds that ROM from Google's stock image on your
   PC. This is the only step setup waits for.
3. **Preparing your device.** Setup creates the device, and Android boots once from cold and saves
   a snapshot. Every later start resumes from that snapshot.

**You don't have to wait for the first boot.** Once the download is done, the app opens. Android's
first boot runs in the background while you browse Apps and the Store, and the Device tab says
"Preparing your device" until it is ready. Without hardware acceleration the first boot does not
start on its own; press **Prepare device** in the title bar to start it anyway.

**Setup never stops for a restart.** If Windows needs one to finish turning on acceleration, the
download goes ahead anyway, and only the first boot waits until acceleration works.

**You choose where Android is stored.** It is by far the largest thing the app downloads. It goes
to `%LOCALAPPDATA%\open-emulator` at first. If your system drive is small, choose another folder in
Settings → Storage. What is already downloaded moves to the new folder instead of being downloaded
again, and the change takes effect when the app restarts.

If something fails, the setup screen says what failed and offers **Try again**. **Details** shows
the step list and the full log. Nothing already downloaded is fetched twice.

---

## Using it

### The title bar

The title bar holds:

- The **Device / Apps / Store / Settings** tabs.
- The device's state. Once Android is running, this includes its version and API level.
- **Start** and **Stop**.
- The Android version menu.
- The **Account** chip.

### Device

The Android display is the emulator's own GPU-rendered window, embedded in the app. So it runs at
the emulator's frame rate, and your mouse and keyboard go straight to Android. The display keeps
its own aspect ratio and is centred in the pane, the way a phone sits on a desk. When it rotates,
the app fits it to the pane again.

If the app can't embed the emulator's window, it mirrors the screen frame by frame instead, and
resizes Android's display to fit the pane.

A tool rail beside the display holds Back, Home, Recents, Fullscreen, Rotate, Screenshot,
Volume down and up, and Power.

### Apps

Everything installed on the device, as tiles. Click one to launch it.

### Store

One search box covers three sources. Pick one with the chips above the results, or leave it on
**All**:

| Source | What it is |
|---|---|
| **F-Droid** | About 5,000 open-source apps. The catalogue is downloaded once and searched on your PC, so results are instant and work offline. An app's page lists F-Droid's warnings about it, such as ads, tracking or non-free parts. Every download is checked against the SHA-256 F-Droid publishes before it reaches the device. |
| **Play** | The real Google Play Store, running on the device and controlled with `market://` intents. Search results show on the device screen. Needs the **Play Store** Android version; if the current one has no Play Store, the Play tab tells you to switch. |
| **On this PC** | Press **Install from file**, or drag a file onto the window. It takes `.apk`, plus the `.xapk` and `.apks` bundles that games usually come in. For a bundle, the app picks the parts that match the device's processor and installs them together, OBB game data included. |

An app that needs a newer Android than the device runs is still listed, marked **Unavailable**, and
its page says why. So you never wait through a long download only to have the install fail.

### Account

The **Account** chip opens one account that every Android version shares: your name, your Google
address and, if you choose, your password.

The page shows whether the device is signed in to Google, and as whom. **Sign in on the device**
opens Google's own sign-in screen on the device. Tap a field there, then press **Type my address**
or **Type my password**, and the app types it in for you, the way a password manager would. You
finish signing in yourself, two-factor included.

Storing a password is optional and off by default. A stored password is typed only into the
device, and only when **Let assisted sign-in type it** is on. It is encrypted with Windows' DPAPI,
so only your Windows user can read it. If DPAPI isn't available, the app doesn't store the password
at all; it never saves it as plain text. A password saved by the Electron version is moved over
automatically.

### Settings

Everything is set in the app; there is no file to edit. If hardware acceleration is missing, a
banner at the top says what is left to do.

- **Appearance**: System (follows Windows), Light or Dark.
- **Device identity**: which phone model the device reports itself as.
- **Display**: **Interface size**, which sets how large Android draws things (its density, in dpi).
- **Performance**: sliders for **Processor** cores and **Memory**. Next to them are this PC's
  processors and memory, the graphics mode, and whether acceleration is working.
- **Storage**: where Android is stored.
  - **Change folder** moves what is already there.
  - **Free** deletes downloaded archives and temporary files. It never touches the installed SDK
    or a device.
- **Antivirus**: an optional Windows Defender exclusion for the emulator's folder. Defender scans
  everything the device writes to disk, which slows starts down. The exclusion is added only when
  you turn it on, and Windows asks for permission.
- **Updates**: see [Updates](#updates).
- **Keyboard**: the shortcuts, as in the table below.

The Interface size, Processor and Memory sliders each have an **Automatic** switch, which picks the
value for this PC. Changes to them and to Device identity take effect the next time the device
starts.

### Keyboard

| Keys | Does |
|---|---|
| Alt+1 to Alt+4 | Device, Apps, Store, Settings |
| Alt+S | Starts or stops the device |
| Alt+← | Android Back |
| Esc | Closes the open panel or menu, or leaves fullscreen |

### Updates

The app checks for a newer version 30 seconds after it starts, then every six hours. It reads
`latest.yml` from the latest GitHub release, and it never offers a version older than yours.

Nothing downloads until you press **Download** in Settings → Updates. The download is checked
against the SHA-512 in `latest.yml`. Nothing installs until you press **Restart to update**, or
until you close the app, which installs it then.

### Android versions

The version menu switches between Android versions; the device must be stopped first. Each version
keeps its own device, apps and snapshot, so switching never disturbs the others. The versions are
defined in `android/profiles/*.env`.

| Version | Profile | Android | What it is | Ships? |
|---|---|---|---|---|
| **open-emulator** | `openemu` | 11 | Our own ROM, built on your PC from Google's stock AOSP image: debloated, tuned and rebranded. No Google Play. The default. | Derived from Apache-2.0 AOSP; see [`LICENSING.md`](LICENSING.md) |
| **open-emulator Android (Google APIs)** | `openemu-compat` | 14 | The same recipe applied to the Google APIs image, for games. It runs apps made for ARM phones, and has Google Play Services for signing in, but no Play Store app. | Built from Google's image on your PC; personal use only |
| **Fast** | `fast` | 11 | Plain stock Android (AOSP). Boots quickest. No Google Play. | Apache-2.0 upstream |
| **Google apps** | `full` | 11 | Adds Google Play Services for apps that need them. No Play Store app. | Google proprietary; personal use only |
| **Play Store** | `play` | 11 | Google Play built in. Slowest to start. | Google proprietary; personal use only |

Every version marked "personal use only" contains Google Mobile Services, which cannot be
redistributed. Read [`LICENSING.md`](LICENSING.md) before shipping anything based on one of them.

---

## Building from source

You need Rust 1.90 or newer with the **MSVC** toolchain on Windows. The MSVC toolchain needs Visual
Studio Build Tools with the C++ workload.

```bash
cargo build --release -p oe-ui      # target/release/open-emulator.exe
cargo run --release -p oe-ui        # build and start it
cargo test --workspace              # the whole test suite
cargo xtask dist                    # release build + installer + latest.yml in target/dist/
```

`cargo xtask dist` needs `makensis` from [NSIS](https://nsis.sourceforge.io/). Without it, run
`cargo xtask dist --stage-only`, which builds only the folder the installer would be made from.
[`PACKAGING.md`](PACKAGING.md) has the details.

`oe-vmm` also builds and tests on Linux, where its KVM backend runs: `cargo test -p oe-vmm`.

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

Environment variables the app reads:

| Variable | Effect |
|---|---|
| `OPEN_EMULATOR_USER_DATA` | Use this folder instead of `%APPDATA%\open-emulator` |
| `OPEN_EMULATOR_SETUP` | `check`: setup only checks what is there. `skip`: go straight to the app, without the multi-gigabyte download |
| `OPEN_EMULATOR_VIEW` | Open on a screen: `apps`, `store`, `settings`, `account`, `setup` or `menu` |
| `OPEN_EMULATOR_ANDROID_ROOT` | Where `android/` (profiles, devices, AVD config) is, when running from a checkout |
| `ICED_BACKEND` | `tiny-skia` makes iced use its software renderer instead of the GPU one |
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

The app starts `emulator.exe` from the Android SDK as an ordinary Windows process. It then moves the
emulator's window inside its own (`SetParent`). The app talks to the guest through its own adb
client, which speaks adb's socket protocol directly. It starts `adb.exe` only to start the adb
server, to install apps and to copy files to the device. Taps and key presses go through one shell
session on the guest that stays open.

Everything the interface shows, app icons included, is downloaded by the Rust code. Images come
only over https, through a size-capped cache. The cache checks each file's first bytes to make sure
it really is an image before it is drawn.

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
docs/               the 60 fps display plan and its review
.github/workflows/  ci.yml (tests) and release.yml (installer and GitHub release)
```

## Data

Unchanged from the Electron version, so an upgrade finds everything where it was left:

| Where | What |
|---|---|
| `%LOCALAPPDATA%\Programs\open-emulator` | The installed app |
| `%APPDATA%\open-emulator` | `settings.json`, `device.json`, `account.json`, store caches |
| `%LOCALAPPDATA%\open-emulator`, or `open-emulator` in the folder chosen in Settings | The Android SDK, AVDs, state and ROMs |

Uninstalling removes the app and leaves all of the data.

## Documentation

| Document | Covers |
|---|---|
| [`documentation.md`](documentation.md) | The full reference |
| [`PACKAGING.md`](PACKAGING.md) | Building and shipping the installer, releases, updates |
| [`LICENSING.md`](LICENSING.md) | What every dependency means if you sell this |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | The Rust crates the app is built from, and their licences |
| [`android/MODIFICATIONS.md`](android/MODIFICATIONS.md) | What the guest is tuned for |
| [`design/`](design/) | Design notes: the ROM, the 60 fps display, the shell redesign, the roadmap |
| [`docs/`](docs/) | The 60 fps display plan and its review |

## Licence

No licence file is present, which means **all rights reserved**. This is deliberate while the
monetization path is open; see [`LICENSING.md`](LICENSING.md). Third-party attribution is recorded
in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
