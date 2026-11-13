# open-emulator

**Android on your PC.** A Windows desktop app that runs a real Android guest, installs apps into it
from a built-in store, and stays out of your way.

No terminal. No configuration. Double-click, wait once, use Android.

---

## Download

### [⬇ Download open-emulator for Windows](https://github.com/filipgal16/open-emulator/releases/latest)

**`open-emulator-Setup-<version>.exe`** — about 80 MB, on the
[latest release](https://github.com/filipgal16/open-emulator/releases/latest). Per-user install, no
administrator prompt. The installer asks where to put the app, and the app asks where to put
Android. After that, the app tells you when a newer version is out — see [Updates](#updates).

> **The installer is unsigned.** Windows SmartScreen will show *"Windows protected your PC"*.
> Click **More info → Run anyway**. Removing that warning requires a code-signing certificate —
> see [Code signing](documentation.md#code-signing).

Prefer to build it yourself? See [Building from source](#building-from-source) — it drops the same
file in `desktop/release/`.

### What you need

| | |
|---|---|
| **OS** | Windows 10 or 11, x64 |
| **Virtualization** | Enabled in BIOS — almost always already on |
| **Disk** | **~10 GB free**, and you choose the drive. The installer is small; Android is the rest |
| **Network** | Required for the first run only |

---

## First run

Double-click and wait. There is nothing to configure and no terminal involved.

The installer asks where to install — it defaults to your user folder and never needs an
administrator prompt. Everything after that happens by itself: the app works out what this PC
already has, downloads Android, and prepares a device.

**You are not made to wait on the first boot.** Once the download is banked, the app opens straight
away and Android's one-time preparation — the single cold boot it ever does — runs in the background
while you browse Apps and the Store. The Device tab shows "Starting Android" until it is ready; by
the time you look, it is live. Every start after that resumes from a snapshot in about five seconds.

**Where Android is downloaded is up to you.** It is by far the largest thing here, so if your system
drive is small, point it at another one — Settings → Storage → *Change folder*. Moving it later
relocates what has already been downloaded rather than fetching it again.

**Setup does not require a restart.** Everything downloads and completes in one go. Windows may need
a restart before hardware acceleration is available, and without it the device cannot start — but
that is the last step rather than a gate you hit at the beginning, and the download is already
banked by then.

If something fails, the setup screen says what failed and offers **Try again**; **Details** shows
the step list and the full log. Nothing already downloaded is fetched twice.

---

## Using it

### Screen

The Android display. On the native Windows runtime this is the emulator's own GPU-rendered window,
embedded directly in the app — so it runs at the emulator's frame rate (measured at the guest's
60 Hz VSYNC with zero dropped frames), and mouse and keyboard reach Android without a round trip.
The device keeps its own aspect ratio and is centred in the pane, the way a phone sits on a desk.

Where no such window exists — the WSL runtime, which runs Android headless inside the distro — the
screen is mirrored frame by frame instead, and clicking taps and dragging swipes.

**Start** and **Stop** are in the toolbar above it, next to a status light and the Android version.

### Apps

Everything installed in the guest. Click one to launch it.

### Store

Three sources behind one search box:

| Source | What it is |
|---|---|
| **F-Droid** | ~4,300 open-source apps. The catalogue is downloaded once and searched locally, so results are instant and work offline. Every download is checked against the digest F-Droid publishes before it reaches the guest. |
| **Play** | The real Google Play Store, running inside the guest and framed in the app. Needs the Play guest version — the tab offers a button to switch. |
| **Local** | Drag an `.apk` onto the window. |

Apps needing a newer Android than the guest are shown with the reason rather than hidden, so an
install never fails after a long download.

### Account

The chip in the top-right holds one account across every guest. It notices when a guest is already
signed in to Google, and can fill your address and password into Google's own sign-in screen — the
same job a password manager does. You complete the flow, including two-factor.

The password is optional, off by default, and stored in the Windows credential store. If that is
unavailable the app stores nothing rather than falling back to a plain file.

### Settings

Theme, which handset the guest reports as, how many cores and how much memory it gets, and where
Android is downloaded. The performance defaults are measured rather than obvious — more memory
makes the guest *slower* to resume, because a warm start is dominated by restoring the snapshot's
memory image — so the automatic answer is shown beside every override.

### Updates

The app looks for a newer version in the background and, when there is one, puts a dot on
**Settings**. Nothing downloads until you press **Download** in Settings → Updates, and nothing
installs until you press **Restart to update** — or close the app, which installs it then. It never
offers an older version than the one you have.

### Android versions

The toolbar's version picker switches guests. Each keeps its own device, apps, and snapshot, so
switching never disturbs the others.

| Version | What it is | Ships? |
|---|---|---|
| **Fast** | Plain Android (AOSP). Boots quickest, no Google Play. | Apache-2.0 — yes |
| **Google apps** | Adds Google Play Services for apps that need them. | Google proprietary — personal use |
| **Play Store** | Google Play built in. | Google proprietary — personal use |

The last two bundle Google Mobile Services, which cannot be redistributed. Read
[`LICENSING.md`](LICENSING.md) before shipping anything based on them.

---

## Command line

The GUI drives the same tool you can run yourself. It lives in the WSL distro, in the synced
checkout.

```bash
./android/bin/open-emu start          # boot (snapshot if there is one)
./android/bin/open-emu stop
./android/bin/open-emu status
./android/bin/open-emu install app.apk
./android/bin/open-emu launch com.android.settings/.Settings
./android/bin/open-emu shell          # adb shell
./android/bin/open-emu doctor         # connectivity and readiness checks
```

`ANDROID_PROFILE=openemu|fast|full|play` picks the guest; `ANDROID_DEVICE=pixel_5` makes it report as a
real handset. Make targets wrap the common sequences:

```bash
make android-fetch       # download the SDK + system image
make android-setup       # create the AVD
make android-provision   # first boot, then save a fast-start snapshot
make android-start
```

Full command reference: [`documentation.md`](documentation.md#the-open-emu-cli).

---

## Building from source

```bash
cd desktop
npm install
npm run build        # compile main, typecheck renderer, bundle
npm test             # 351 tests
npm run dev          # build and launch
npm run dist:win     # -> desktop/release/open-emulator-Setup-<version>.exe
```

Set `OPEN_EMULATOR_WSL_DISTRO` if your distro is not named `OpenEmulator`, and
`OPEN_EMULATOR_ANDROID_PROFILE` to pin a guest version.

If `dist:win` fails with *"A required privilege is not held by the client"*, see
[Known packaging snag](documentation.md#known-packaging-snag).

---

## How it works

```
  Windows                              WSL2 (Linux)
  ┌────────────────────────┐           ┌──────────────────────────┐
  │ Electron shell         │  wsl.exe  │ android/bin/open-emu     │
  │  main ── IPC ── render │ ────────► │   └─ Android emulator    │
  │  store · account · UI  │           │        └─ Android guest  │
  └────────────────────────┘   adb ◄───┴──────────────────────────┘
```

The desktop shell never talks to Android directly. It runs `open-emu` inside the distro, which owns
the emulator and adb; the screen arrives as a stream of PNG frames over that same channel.

The renderer is sandboxed with no network access at all (`connect-src 'none'`) — every byte it
shows, including app icons, is fetched by the main process and handed over through a private
protocol. Nothing it displays can phone home.

## Layout

```text
desktop/          Electron app — store, account, GUI, installer
  src/main/         engine (runtimes), guest, store, account, platform, wsl
  src/renderer/     UI
  src/shared/       types crossing the IPC boundary
android/          Android runtime
  bin/open-emu      control plane (Google SDK)
  foss/             licence-clean runtime (QEMU + Android-x86)
  profiles/         guest versions
  devices/          device identities
src/, include/    open-vmm — a minimal type-2 hypervisor, the long-term backend
guest/            demo guest assembly
```

## Documentation

**[`documentation.md`](documentation.md) — the complete reference.** Architecture, every CLI
command, the store and account internals, packaging, configuration, and troubleshooting in one file.

| Document | Covers |
|---|---|
| [`documentation.md`](documentation.md) | The full reference |
| [`LICENSING.md`](LICENSING.md) | What every dependency means if you sell this |
| [`desktop/STORE.md`](desktop/STORE.md) | How the store and account work |
| [`desktop/PACKAGING.md`](desktop/PACKAGING.md) | Building and shipping the installer |
| [`android/MODIFICATIONS.md`](android/MODIFICATIONS.md) | What the guest is tuned for |

## Two runtimes

The shell drives Android through one narrow interface, so the runtime underneath is swappable.

| | |
|---|---|
| **Native Windows** (default) | `emulator.exe` and `adb.exe` as ordinary Windows processes, no Linux involved. The only runtime with a window to embed, and therefore the only one that shows the guest at full frame rate. |
| **WSL2** | Google's SDK emulator inside a Linux distro, headless, mirrored at ~3 fps. The original arrangement. Set `OPEN_EMULATOR_ENGINE=wsl`. Costs a ~4 GB distro install on top of Android itself. |

The native runtime is **verified working** — cold boot 37s, snapshot restore **4.9s**, on a Ryzen 7 6800H
with the Windows Hypervisor Platform enabled — and downloads roughly **1.1 GB instead of 4.5–6.5 GB**
because it needs no distro, no JDK, and no command-line tools.

## Status

**Working** — guest boot and snapshot restore, the guest's own GPU-rendered window embedded in the
app on the native runtime (frame-by-frame mirroring where there is no such window), a display that
resizes with the window rather than stretching, Android navigation, the store across all three
sources, the device-wide account, settings, and a Windows installer.

**In progress** — the native Windows runtime (above), and a licence-clean runtime that replaces
Google's SDK with stock QEMU and an Android-x86 image so the product can be shipped commercially.
The Windows-hostile parts of that — reading an ISO without mounting it, and patching a gzipped cpio
initrd — are done and tested.

**Next** — embedding the emulator's own window instead of streaming frames, `open-vmm` grown far
enough to replace QEMU, key mapping, and audio routing.

## Licence

No licence file is present, which means **all rights reserved**. This is deliberate while the
monetization path is open — see [`LICENSING.md`](LICENSING.md). Third-party attribution is recorded
in [`desktop/THIRD-PARTY-NOTICES.md`](desktop/THIRD-PARTY-NOTICES.md).
