# open-emulator: Documentation

The complete reference. [`README.md`](README.md) is the short version; this is everything.

---

## Contents

- [What this is](#what-this-is)
- [Architecture](#architecture)
- [Installing](#installing)
- [The app](#the-app)
- [The Android runtime](#the-android-runtime)
- [The ROM](#the-rom)
- [open-vmm](#open-vmm)
- [Building from source](#building-from-source)
- [Packaging and shipping](#packaging-and-shipping)
- [Licensing and monetization](#licensing-and-monetization)
- [Configuration reference](#configuration-reference)
- [Repository layout](#repository-layout)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## What this is

open-emulator runs a real Android guest on a Windows PC and puts a consumer-grade GUI in front of
it. It is aimed at the same job LDPlayer and BlueStacks do: install an Android app on your desktop
and use it, with the difference that the runtime is assembled from parts you can inspect, and the
project is working toward a stack it can ship commercially.

Three layers:

1. **The app** (`crates/oe-ui`, `oe-core`, `oe-store`), a native Rust GUI built with iced: the
   emulator's window embedded in ours, an app library, a three-source store, a device-wide account,
   settings, and a Windows installer.
2. **The Android runtime** (`crates/oe-engine`, `oe-win`, `oe-formats`, and the data in `android/`),
   which is Google's SDK emulator driven natively on Windows, with our own ROM built from Google's stock
   image.
3. **`open-vmm`** (`crates/oe-vmm`): a minimal VMM, the long-term backend. It cannot boot Android
   yet.

The app was an Electron/TypeScript program that drove the emulator through WSL until version 0.2.
Version 0.3.0 is a rewrite in Rust. The WSL engine was dropped; only the native Windows engine
remains.

---

## Architecture

```
  open-emulator.exe  (oe-ui: iced)
        │
        ▼
  oe-core ─ Core API + event stream: setup runner, settings, account, updater
        │
        ├─ oe-engine ─ SDK download, AVDs, adb client, guest shell, SDK engine ─► emulator.exe ─► guest
        ├─ oe-store ── F-Droid, local files, installer, Play via intents, image cache
        ├─ oe-formats  ext4 · AVB · GPT · LP · build.prop · ROM builder · cpio/iso9660/initrd · zip
        └─ oe-win ──── SetParent, process lookup, UAC, registry, services, WMI, DPAPI
```

The app starts `emulator.exe` from the Android SDK as an ordinary Windows process and reparents its
GPU-rendered window into the app's window with `SetParent`. All Win32 calls live in `oe-win`, so the
other crates stay portable and testable.

The engine talks to the guest through an adb client that speaks adb's socket protocol directly.
`adb.exe` is used only to start the server and for installs and pushes. A persistent guest shell
carries taps and key events without a process spawn per input.

`oe-core` is the app without a window. The UI holds a `Core`, sends it commands and receives an event
stream, which is what lets the same logic be tested and driven without a GUI.

**Trust boundaries**

| Piece | Network access |
|---|---|
| The app | Yes; it is the only thing that fetches: the SDK, the F-Droid catalogue and APKs, icons, update checks |
| Android guest | Isolated VM; reaches the network through the emulator's NAT |

---

## Installing

### System requirements

| | |
|---|---|
| **OS** | Windows 10 or 11, x64 |
| **Virtualization** | Enabled in BIOS, and the Windows Hypervisor Platform turned on in Windows Features |
| **Disk** | About 10 GB free. Installer is small; the SDK and system image are roughly 1.1 GB to download and grow with use |
| **RAM** | 8 GB workable, 16 GB comfortable |
| **Network** | First run only; after setup the app works offline, except for the store |

No WSL, JDK or Android Studio is needed.

### The installer

`open-emulator-Setup-<version>.exe`, built with NSIS by `cargo xtask dist`. One click, per user, no
UAC prompt, installed to `%LOCALAPPDATA%\Programs\open-emulator`. It is unsigned: SmartScreen shows
*"Windows protected your PC"* and the user clicks **More info → Run anyway**. See
[`PACKAGING.md`](PACKAGING.md).

It takes over from an installed Electron version (0.2.x and older) in the same folder: it removes
that version's files and its Apps & features entry and keeps the shortcuts and the data.

### First run and the setup wizard

The setup runner (in `oe-core`) is unattended and resumable. It works out what the machine already
has, then:

1. Checks acceleration (Windows Hypervisor Platform).
2. Downloads the SDK pieces (the emulator, platform tools and the system image) resumably, checking
   each against Google's published SHA digests, and extracts them.
3. Accepts the SDK licences recorded in the app's data folder.
4. Creates the AVD from `android/config/avd_config.ini` and the chosen profile and device.
5. Builds the open-emulator ROM from the stock image (see [The ROM](#the-rom)), for the profiles
   that use it.
6. Provisions: a first cold boot, guest tuning, then a snapshot so later starts are quick.

The provision step runs in the background after the download is banked, so the app is usable at
once. The Device tab shows "Starting Android" until the guest is up. Afterwards a start resumes from
the snapshot in about five seconds.

On failure the setup screen names the failed step and offers **Try again**; **Details** shows the
step list and the full log. Nothing already downloaded is fetched twice.

`OPEN_EMULATOR_SETUP=check` makes setup only check; `skip` goes straight to the app. Both avoid the
multi-gigabyte download during development.

---

## The app

### Window and tools

The title bar holds the **Device / Apps / Store / Settings** tabs, the account chip, the Android
version menu, and start and stop. A tool rail beside the screen holds back, home and recents,
fullscreen, rotate, screenshot, volume and power.

### Device

The emulator's own window, embedded. It keeps its own aspect ratio and is centred rather than
stretched: the emulator's Qt window corrects any other size, and when it does it can misplace a child
window by its parent's origin. The window is handed back to the emulator when the app closes, rather
than being destroyed with the app's window. Where there is no window to embed, the engine's screen
mirror shows the guest frame by frame instead, and clicks are sent as taps.

### Apps

Everything installed in the guest, from `pm list packages`. Click one to launch it.

### Store

Three sources behind one search box.

| Source | Where apps come from | How it renders |
|---|---|---|
| **F-Droid** | The published `index-v2.json` catalogue, distilled and searched locally | Native tiles |
| **Play** | The real Google Play app, running inside the guest | The guest's own window, steered by intents |
| **Local** | An `.apk`, `.xapk` or `.apks` chosen with **Install from file…** or dropped onto the window | Native tiles |

#### F-Droid

The whole catalogue is fetched once, distilled to the fields the UI renders, cached under
`%APPDATA%\open-emulator`, and refreshed with an ETag-conditional GET. Searching locally rather than
per keystroke is faster, works with the network down, and means F-Droid's servers see one
conditional request instead of one per character.

Every download is verified against the SHA-256 the index publishes for that exact APK, **before**
the file is offered to the guest. A mismatch deletes it and fails the install. An APK is executable
code: "came from the right URL" is a weaker claim than "is the artefact the catalogue published".

> Not yet done: verifying the index's *own* signature (`entry.jar` is JAR-signed and names the
> index digest). Today the index is trusted over TLS and each APK is checked against it.

#### Play

There is no Play API client in this codebase and no scraped listings. Google's own client runs in the
guest; the app steers it with `market://` intents. Wrapping the real client means Play's UI, account
handling and installs are exactly current because they are Play's, nothing breaks when Google
changes an interface we were never calling, and no one's Google account is at risk for automating an
endpoint that forbids it.

It needs the `play` profile: `google_apis_playstore`, the only image shipping `com.android.vending`.
The Store's Play tab offers a switch to it.

**Play certification and device spoofing are mutually exclusive.** The Play image is certified
against its own build fingerprint. Rewriting `build.prop` to impersonate a Pixel produces *"device
is not Play Protect certified"* and blocks sign-in. The Play tab detects a spoofed fingerprint and
says so. The Play image is also a user build: `adb root` is refused on it.

#### Local files

A plain `.apk` is installed as is. For `.xapk` and `.apks` bundles the app reads the bundle's
manifest, picks the split APKs that match the guest's ABI and density, installs them together, and
pushes OBB data to where the game expects it.

#### Compatibility

Apps needing a newer API level than the guest are shown with the reason rather than hidden, so an
install never fails after a long download.

#### Images

App icons and screenshots come through an image cache in `oe-store`: https only, size-limited, and
the bytes are checked against image magic numbers before they are drawn.

### Account

One profile spanning every AVD and profile the app manages, rather than living inside one guest.

Sign-in is a ladder, each rung falling through to the next:

1. **Already signed in.** `dumpsys account` finds a `com.google` account. Accounts live in userdata
   and the provision step snapshots it, so once you have signed in, every later start comes back
   signed in.
2. **Assisted sign-in.** Opens Google's own add-account screen in the guest and offers to type the
   stored address and password into the focused field. You complete the flow, including any
   two-factor or verification step.
3. **Manual.** The flow is on screen; drive it yourself.

**This cannot silently log you into Google.** Google's sign-in is deliberately resistant to
automation. Rung 2 is autofill in the sense a password manager is: your own credential, into
Google's real UI, with every challenge left to you.

#### Where the password goes

- It is **opt-in and off by default**; rungs 1 and 3 work without it.
- It is sealed with **Windows DPAPI** for the current Windows user and stored in `account.json`. If
  sealing fails, nothing is stored; there is no fallback to plain text.
- It never goes back out to the UI. The UI asks for the *action*, not the value.
- A password stored by the Electron version (sealed with Electron's `safeStorage`) is migrated
  automatically on first run.

### Settings

- **Appearance**: light, dark, or follow Windows.
- **Device identity**: which handset the guest reports as (see [Device identities](#device-identities)).
- **Display**: the screen follows the window; a slider sets how large Android draws things.
- **Performance**: cores and memory, each Automatic or set by slider or typed number. Applied at the
  next start, which boots fresh once.
- **Storage**: the folder holding the SDK, AVDs, state and ROMs. Changing it moves what is there.
- **Windows Defender**: an opt-in exclusion for the emulator's folder. Real-time scanning of the
  guest's disk writes is a likely cost of the roughly 37 s cold boot against about 24 s with KVM.
  It changes a security setting, so it is applied only on an explicit action, in one elevated
  PowerShell call (one UAC prompt), and removes exactly what it added.
- **Updates**: see below.

Settings are stored in `%APPDATA%\open-emulator\settings.json`; the chosen device in `device.json`.

### Updates

The updater (`oe-core`) reads `latest.yml` from the latest GitHub release. Checks run in the
background and only report. Downloading and installing are each a button in Settings → Updates; the
download is checked against the SHA-512 in `latest.yml`; installing runs the installer silently, and
closing the app after a download installs it too. It never offers a version that is not higher than
the running one. See [`PACKAGING.md`](PACKAGING.md#how-the-app-updates-itself) for what is and is
not proven.

### Security model

- **The app fetches everything itself.** Icons, screenshots, the catalogue and APKs are all fetched
  by Rust code and verified (digest for APKs, magic bytes for images) before use.
- **Downloads are verified before they are used.** SDK components against Google's digests, APKs
  against F-Droid's, updates against `latest.yml`.
- **Secrets are sealed with DPAPI** and never written as plain text.
- **Elevation is explicit.** The only elevated action is the Defender exclusion, started by the user.
- **Pure crates stay pure.** `oe-formats` and `oe-vmm` call no Win32 API and can be tested anywhere;
  every Win32 call is in `oe-win`.

---

## The Android runtime

Guest bring-up for **Android 11 (API 30)**, x86_64, on Google's SDK emulator, driven natively.

### The engine

`oe-engine` owns it:

- **SDK**: download, verify and extract the emulator, platform tools and the system image; record
  licence acceptance.
- **AVDs**: create them from `android/config/avd_config.ini` plus the profile and device, and
  rewrite their config when settings change.
- **adb**: a client for adb's socket protocol (device lists, shell, port forwards, sync), with
  `adb.exe` only to start the server and for installs and pushes.
- **Guest shell**: one persistent shell for taps, keys and text.
- **Engine**: start (resuming a snapshot, or `cold`), stop, status, provision.
- **Screen mirror**: the fallback when there is no window to embed.
- **Defender**: the opt-in exclusion described above.

`ANDROID_ADB_SERVER_PORT` selects a different adb server, so the app does not fight one you already
run.

### Guest profiles

`android/profiles/*.env`. Each profile gets its **own AVD name**, so switching never reuses another
profile's snapshot (which would fail to load and force a re-provision), and its own state directory.

| Profile | Menu name | System image | GMS | Play Store |
|---|---|---|---|---|
| **`openemu`** (default) | open-emulator Android | `default`, rebuilt by our recipe | No | No |
| **`openemu-compat`** | open-emulator Android (Google APIs) | `google_apis`, rebuilt by our recipe | Yes | No |
| **`fast`** | Fast | `system-images;android-30;default;x86_64`, as shipped | No | No |
| **`full`** | Google apps | `google_apis` | Yes | No |
| **`play`** | Play Store | `google_apis_playstore` | Yes | Yes |

The profiles without GMS drop the single biggest cold-boot saving available; most apps run fine
without it. `play` is the only image shipping `com.android.vending`. `openemu-compat` exists because
the Google APIs image carries an ARM translator, without which games that ship only ARM libraries do
not install.

### Device identities

`android/devices/*.env`. Stock AVD images identify as brand `Android`, model `mainline`, device
`generic`; plenty of apps treat that as an emulator and refuse to run. Presenting a real device is a
compatibility feature, not cosmetics.

| Device | Identifies as |
|---|---|
| `generic` | Stock emulator identity |
| `pixel_5` | `google/redfin/redfin:11/RQ3A.211001.001/…:user/release-keys`, 1080×2340 @ 440dpi |
| `redmi_note_11` | Xiaomi identity |

Do not combine a spoofed device with the `play` profile: a rewritten fingerprint breaks Play
certification.

### Performance

Measured on a Ryzen 7 6800H with the Windows Hypervisor Platform enabled, `fast` guest:

| | |
|---|---|
| Cold boot | about 37 s |
| Start from the snapshot | about 4.9 s |
| First-time provision | about 49 s, once |
| Download | about 1.1 GB |
| Frame pacing (embedded window, scrolling Settings) | guest 60 Hz VSYNC, no janky frames, no missed VSYNC |

The warm figure depends on Quick Boot being left to manage its own `default_boot` snapshot. Naming a
snapshot and passing it back as `-snapshot <name>` is silently ignored by the emulator, which
cold-boots instead.

A from-scratch cold boot of this image is inherently 30–37 s, so the app moves it off the critical
path: the one-time provision runs in the background after the download, while the user browses Apps
and the Store.

### Guest tuning

**Hardware profile** (`android/config/avd_config.ini`): 8 GiB `/data` and a 512 MB sdcard so real apps
fit; audio, keyboard, GPS and cameras enabled for compatibility; snapshot boot enabled.

**At runtime**: full-speed network, setup wizard pre-completed, third-party APK installs allowed,
animations reduced. APKs placed in `android/apps/` are installed during provision.

---

## The ROM

`openemu` is our own Android ROM. The app downloads Google's stock `default` (AOSP) image and builds
the ROM from it on your machine, through `oe-formats`: the ext4 editor changes the filesystem
(debloat, rebrand, our own files and wallpaper), `build.prop` is rewritten, and the images are
re-signed with AVB so `/system` boots without dm-verity restoring Google's bytes. The recipes live in
`oe-formats`; what they do and why is in [`design/openemu-rom.md`](design/openemu-rom.md).

`cargo xtask rom-build` runs the build by hand against a downloaded image, and `cargo xtask rom-check`
checks a built ROM against its recipe. `cargo xtask wallpaper <out>` renders the default wallpaper.

---

## open-vmm

`crates/oe-vmm` is a small VMM, the original step 1 of the project and the intended long-term
replacement for the SDK emulator. Binary: `open-vmm`.

| Backend | When used | How it works |
|---|---|---|
| **soft** | everywhere | An x86 real-mode software interpreter |
| **kvm** | Linux with `/dev/kvm` | Linux KVM: hardware virtualization (Intel VT-x / AMD-V) |

It allocates guest memory, loads a flat guest binary, runs until the guest executes `HLT`, and
emulates a serial port (`COM1`, `0x3f8`) so the guest can print. The guest assembler is part of the
crate, and test guests live under `crates/oe-vmm/testdata`.

```bash
cargo test -p oe-vmm
```

It **cannot boot Android yet**; that needs long mode plus virtio/goldfish devices.

---

## Building from source

Rust 1.90 or newer with the MSVC toolchain (Visual Studio Build Tools, C++ workload).

```bash
cargo build --release -p oe-ui     # target/release/open-emulator.exe
cargo run --release -p oe-ui
cargo test --workspace
cargo xtask help
```

`ICED_BACKEND=tiny-skia` selects the software renderer, which helps where the GPU renderer cannot
start (a remote desktop, a virtual machine).

The `[profile.dev]` in `Cargo.toml` builds our own code at `opt-level = 0` and dependencies at `2`,
and `oe-formats` at `2`, because RSA key generation, ext4 checksums and image decoding are unusably
slow unoptimised and the tests run them.

---

## Packaging and shipping

[`PACKAGING.md`](PACKAGING.md) covers it: `cargo xtask dist`, the NSIS installer, `latest.yml`, the
release workflow, taking over from Electron installs, code signing, and how the app updates itself.

In short: bump the version in `Cargo.toml`, push a `v<version>` tag, and `release.yml` tests, builds
the installer and publishes the release with `open-emulator-Setup-<version>.exe` and `latest.yml`.
The tag must equal the workspace version.

---

## Licensing and monetization

Full audit in [`LICENSING.md`](LICENSING.md). **Engineering research, not legal advice.**

**Your own code and everything in the installer is clean.** The app is built from Rust crates whose
licences are permissive or offer a permissive choice; the list is in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

**The problem is what the app downloads on first run.** The runtime is Google's SDK emulator and
Google's system images, and the Android SDK Terms §3.3 forbid combining "any part of the SDK" with
other software or distributing software incorporating it. You do not redistribute it: each user's
machine downloads it and accepts Google's licence, but the clause is broad, and it is the one thing
standing between this and a product you can sell without worrying.

BlueStacks, LDPlayer and Genymotion all ship Google Play under **GMS certification agreements with
Google**. That is a commercial negotiation, not something that can be coded around.

| What you'd sell | Verdict |
|---|---|
| The app alone | **Yes**: your code plus permissively licensed crates |
| App + `fast` or `openemu`, user's machine fetches Google's SDK | **Grey area**: you distribute nothing of Google's, but §3.3 is broad |
| `openemu-compat` | **Unresolved**: a modified copy of a Google image, built on the user's machine |
| Anything with `full` or `play` | **No**, not without a Google agreement; those carry GMS |

The route out, in increasing effort: replace the VMM (crosvm is BSD-3-Clause; upstream QEMU is
GPL-2.0 and sellable with a source offer; `open-vmm` is the stated goal), then replace the system
image (AOSP or Android-x86), then replace Play (microG, your own F-Droid repo, or a GMS agreement).

The repo has no licence file, which means all rights reserved. Decide deliberately, and if the repo
is public, decide soon.

---

## Configuration reference

### The app

| Variable | Effect |
|---|---|
| `OPEN_EMULATOR_USER_DATA` | Use this folder instead of `%APPDATA%\open-emulator` |
| `OPEN_EMULATOR_SETUP` | `check` or `skip`: see [First run](#first-run-and-the-setup-wizard) |
| `OPEN_EMULATOR_VIEW` | Open on `apps`, `store`, `settings`, `account`, `setup` or `menu` |
| `OPEN_EMULATOR_ANDROID_ROOT` | Where `android/` (profiles, devices, config) is |
| `ICED_BACKEND` | `tiny-skia` for the software renderer |
| `ANDROID_ADB_SERVER_PORT` | Port of the adb server to use |

### Data locations

| Where | What |
|---|---|
| `%LOCALAPPDATA%\Programs\open-emulator` | The installed app, with the `android\` data it reads |
| `%APPDATA%\open-emulator` | `settings.json`, `device.json`, `account.json`, the F-Droid and image caches |
| `%LOCALAPPDATA%\open-emulator`, or the folder chosen in Settings | SDK, AVDs, state, ROMs |

### Build

The installer has no build-time secrets today. When code signing is added, its certificate details
belong in the environment of `release.yml`.

---

## Repository layout

```text
crates/
  oe-formats/               pure codecs, no Win32
    src/                      ext4, avb, gpt, lp, build.prop, rom recipes + builder, wallpaper,
                              cpio, iso9660, initrd, zip
    testdata/
  oe-win/                   every Win32 call
  oe-engine/                the SDK engine, adb client, guest shell, AVDs, SDK download
  oe-store/                 F-Droid, local bundles, installer, Play intents, image cache
  oe-core/                  setup runner, settings, account, updater, the Core API
  oe-ui/                    the iced GUI -> open-emulator.exe
  oe-vmm/                   open-vmm: interpreter, KVM backend, guest assembler
xtask/                      cargo xtask commands
packaging/windows/          installer.nsi
android/                    data the app reads
  profiles/                   openemu, openemu-compat, fast, full, play
  devices/                    generic, pixel_5, redmi_note_11
  config/avd_config.ini       AVD hardware profile
  apps/                       drop APKs here for auto-install during provision
design/                     design notes: ROM, 60 fps display, shell, roadmap
.github/workflows/          ci.yml, release.yml
```

**Gitignored and never committed:** `target/`, generated SDK, AVD, state and log folders, `*.img`,
`*.qcow2`, `android/apps/*.apk`.

---

## Testing

```bash
cargo test --workspace
cargo test -p oe-vmm        # also what CI runs on Linux, where the KVM backend compiles
```

The suite does not need an emulator, a guest or elevation. CI (`.github/workflows/ci.yml`) runs the
whole workspace on Windows and `oe-vmm` on Linux for every push and pull request. Set
`OPEN_EMULATOR_USER_DATA` to a scratch folder to keep a manual run away from your real data.

---

## Troubleshooting

**Setup fails partway.** The setup screen names the step and offers **Try again**; **Details** shows
the full log. Steps are resumable: nothing already downloaded is fetched twice.

**The device is very slow, or will not start.** Windows Hypervisor Platform is probably off. Turn it
on in *Windows Features* (and reboot), and check that virtualization is enabled in BIOS:

```powershell
(Get-CimInstance Win32_ComputerSystem).HypervisorPresent
```

`False` means virtualization is disabled in BIOS, which is a different problem.

**Boots feel slow.** Windows Defender scanning the guest's disk writes is a likely cause. Settings →
Windows Defender offers an exclusion for the emulator's folder.

**The window shows nothing or is blank.** Try `ICED_BACKEND=tiny-skia`. If the emulator's window is
the problem, stop and start the device from the title bar.

**"Device is not Play Protect certified", or Play sign-in refuses.** A spoofed device fingerprint on
the `play` profile. Use the stock `generic` device with `play`, or the `full` profile for spoofing
work.

**`adb root` refused.** Expected on the `play` image; it is a user build.

**Port conflicts with another adb.** Set `ANDROID_ADB_SERVER_PORT` to a free port.

**SmartScreen blocks the installer.** Expected; it is unsigned. **More info → Run anyway**, or sign
it: see [`PACKAGING.md`](PACKAGING.md#code-signing).

**Store shows nothing / search is empty.** The F-Droid catalogue downloads once on first use. Check
the network, then reopen the tab.

**An install fails digest verification.** Working as intended: the downloaded APK did not match the
digest F-Droid published. The file is deleted. Retry; if it persists, the mirror is serving something
else.

**Updating says nothing is available while the repository is private.** GitHub answers 404 to
unauthenticated requests for private release assets; updating starts working once the repository is
public.
