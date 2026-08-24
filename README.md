# open-emulator

**Android on your PC.** A Windows desktop app that runs a real Android guest, installs apps into it
from a built-in store, and stays out of your way.

No terminal. No configuration. Double-click, wait once, use Android.

---

## Download

### [⬇ Download open-emulator for Windows](https://github.com/filipgal16/open-emulator/releases/latest)

**`open-emulator-Setup-0.0.1.exe`** — about 75 MB. One click, per-user install, no options to pick.

Direct link to the current build:
<https://github.com/filipgal16/open-emulator/releases/latest/download/open-emulator-Setup-0.0.1.exe>

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
| **Disk** | **~15 GB free.** The installer is small; Android itself is ~4 GB and lives inside WSL |
| **Network** | Required for the first run only |

---

## First run

Double-click and wait. There is nothing to configure and no terminal involved.

The app installs Windows Subsystem for Linux (one Windows permission prompt), sets up a Linux
environment, installs the packages Android needs, downloads the Android system image, and boots the
guest once to save a snapshot so later starts are quick.

Budget **20–40 minutes**, most of it the 4 GB download. It happens once. If Windows asks you to
restart after the WSL step, restart and reopen the app — it picks up where it left off.

After that, starting Android takes about **10 seconds**.

If something fails, the setup screen says what failed and offers **Try again**; **Details** shows
the step list and the full log.

---

## Using it

### Screen

The Android display, mirrored. Click to tap, drag to swipe. **Start** and **Stop** are in the
toolbar above it, next to a status light and the Android version.

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

`ANDROID_PROFILE=fast|full|play` picks the guest; `ANDROID_DEVICE=pixel_5` makes it report as a
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
npm test             # 124 tests
npm run dev          # build and launch
npm run dist:win     # -> desktop/release/open-emulator-Setup-0.0.1.exe
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
  src/main/         privileged side: WSL bridge, store, account, setup
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

## Status

**Working** — guest boot and snapshot restore, screen mirroring with touch input, the store across
all three sources, the device-wide account, and a Windows installer.

**In progress** — a licence-clean runtime (`android/foss/`) that replaces Google's SDK with stock
QEMU and an Android-x86 image, so the product can be shipped commercially.

**Next** — `open-vmm` grown far enough to replace QEMU entirely, key mapping, and audio routing.

## Licence

No licence file is present, which means **all rights reserved**. This is deliberate while the
monetization path is open — see [`LICENSING.md`](LICENSING.md). Third-party attribution is recorded
in [`desktop/THIRD-PARTY-NOTICES.md`](desktop/THIRD-PARTY-NOTICES.md).
