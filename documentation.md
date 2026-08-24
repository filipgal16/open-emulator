# open-emulator — Documentation

The complete reference. [`README.md`](README.md) is the short version; this is everything.

---

## Contents

- [What this is](#what-this-is)
- [Architecture](#architecture)
- [Installing](#installing)
  - [System requirements](#system-requirements)
  - [The installer](#the-installer)
  - [First run and the setup wizard](#first-run-and-the-setup-wizard)
- [The desktop shell](#the-desktop-shell)
  - [Screen](#screen)
  - [Apps](#apps)
  - [Store](#store)
  - [Account](#account)
  - [Security model](#security-model)
- [The Android runtime](#the-android-runtime)
  - [The open-emu CLI](#the-open-emu-cli)
  - [Make targets](#make-targets)
  - [Guest profiles](#guest-profiles)
  - [Device identities](#device-identities)
  - [Performance model](#performance-model)
  - [Guest tuning](#guest-tuning)
- [The licence-clean runtime](#the-licence-clean-runtime)
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
it. It is aimed at the same job LDPlayer and BlueStacks do — install an Android app on your desktop
and use it — with the difference that the runtime is assembled from parts you can inspect, and the
project is working toward a stack it can ship commercially without Google's SDK in it.

Three layers, developed in that order:

1. **`open-vmm`** — a minimal type-2 hypervisor in C. The long-term backend, not yet able to boot
   Android.
2. **The Android runtime** (`android/`) — today, Google's SDK emulator driven by a shell control
   plane. A licence-clean QEMU + Android-x86 alternative is in progress.
3. **The desktop shell** (`desktop/`) — an Electron app: screen mirroring, an app library, a
   three-source store, a device-wide account, and a Windows installer.

---

## Architecture

```
  Windows                              WSL2 (Linux)
  ┌────────────────────────┐           ┌──────────────────────────┐
  │ Electron shell         │  wsl.exe  │ android/bin/open-emu     │
  │  main ── IPC ── render │ ────────► │   └─ Android emulator    │
  │  store · account · UI  │           │        └─ Android guest  │
  └────────────────────────┘   adb ◄───┴──────────────────────────┘
```

The shell never speaks to Android directly. Every operation is a `wsl.exe` invocation of
`android/bin/open-emu` inside the distro, which owns the emulator process and adb. The screen
arrives as a stream of PNG frames over that same channel.

That indirection is the reason the backend is swappable: the store, the account, and the whole UI
talk to one shell script's command surface, so replacing Google's SDK emulator with QEMU (see
[the licence-clean runtime](#the-licence-clean-runtime)) does not touch anything above it.

**Process boundaries**

| Process | Trust | Can reach the network? |
|---|---|---|
| Electron **main** | privileged; spawns `wsl.exe`, reads the credential vault | Yes — it is the only thing that fetches |
| Electron **renderer** | sandboxed, `default-src 'self'`, `connect-src 'none'` | **No** |
| `open-emu` in WSL | owns emulator + adb | Yes — downloads the SDK and images |
| Android guest | isolated VM | Yes, through the emulator's NAT |

---

## Installing

### System requirements

| | |
|---|---|
| **OS** | Windows 10 or 11, x64 |
| **Virtualization** | Enabled in BIOS. Almost always already on; WSL2 will not start without it |
| **Disk** | **~15 GB free.** Installer is ~75 MB; the Android system image is ~4 GB and lives inside WSL, plus an 8 GiB `/data` partition |
| **RAM** | 8 GB workable, 16 GB comfortable |
| **Network** | First run only — after setup the app works offline |

### The installer

`open-emulator-Setup-0.0.1.exe`, about 75 MB, built by electron-builder's NSIS target.

- **One click, per user, no UAC prompt**, launches when it finishes — the flow LDPlayer and
  BlueStacks use.
- Nothing large lands in the install directory, so there is no drive-selection step. The Android
  images live inside WSL.
- The version comes from `desktop/package.json`. Bump it before a release or each build overwrites
  the previous artifact name.

**It is unsigned.** Windows SmartScreen shows *"Windows protected your PC"* and the user must click
**More info → Run anyway**. See [Code signing](#code-signing).

### First run and the setup wizard

The wizard runs unattended and is resumable. Its steps:

1. **WSL2 present** — installs Windows Subsystem for Linux if missing. One Windows permission
   prompt. May require a reboot; the app resumes where it left off after you reopen it.
2. **Distro present** — creates the `OpenEmulator` distro.
3. **Linux dependencies** — installs the packages the emulator needs inside the distro.
4. **Backend synced into distro** — copies `android/`, `scripts/`, and `Makefile` from
   `resources/backend/` into the distro. This step verifies every profile the build ships, not just
   that `open-emu` exists, so re-running it refreshes a stale copy.
5. **SDK and system image fetched** — roughly 4 GB. The bulk of the wait.
6. **AVD created**.
7. **Provisioned** — first cold boot, tuning, then a snapshot save so later starts are quick.

Budget **20–40 minutes** total. Afterwards a start takes about **10 seconds**.

On failure the setup screen names the failed step and offers **Try again**; **Details** expands the
step list and the full log.

> The backend sync normalises line endings, and has to. Git's `core.autocrlf=true` — the usual
> Windows default — checks these scripts out with CRLF, and bash cannot parse that: `open-emu` fails
> with `/usr/bin/env: 'bash\r': No such file or directory`. `.gitattributes` pins LF for fresh
> clones; the sync's `sed` covers working copies that already have CRLF on disk.

---

## The desktop shell

### Screen

The Android display, mirrored as a stream of PNG frames pulled over the WSL channel. Click to tap,
drag to swipe. **Start** and **Stop** sit in the toolbar with a status light and the Android
version.

Input is built by `src/main/guest-input.ts`, which constructs tap/swipe/key/text commands and
escapes them for the two shells between the app and the guest
(`src/main/shell-quote.ts`).

### Apps

Everything installed in the guest, from `pm list packages`. Click one to launch it.

### Store

Three sources behind one search box.

| Source | Where apps come from | How it renders |
|---|---|---|
| **F-Droid** | The published `index-v2.json` catalogue, downloaded once and searched locally | Native tiles |
| **Play** | The real Google Play app, running inside the guest | Mirrored guest surface in our chrome |
| **Local** | APKs in `android/apps/`, plus anything dropped onto the window | Native tiles |

#### F-Droid

The whole catalogue is fetched once, distilled to the fields the UI renders
(`src/main/store/fdroid-index.ts`), cached under `userData`, and refreshed with a conditional GET at
most every 12 hours.

Searching locally rather than per-keystroke is not only faster — no request leaves the machine while
you type, the store works with the network down, and F-Droid's servers see one conditional GET a day
instead of one per character.

Every download is verified against the `sha256` the index publishes for that exact APK, **before**
the file is offered to the guest. A mismatch deletes it and fails the job. An APK is executable
code: "came from the right URL" is a weaker claim than "is the artefact the catalogue published",
and only the second is worth acting on.

> Not yet done: verifying the index's *own* signature (`entry.jar` is JAR-signed and names the index
> digest). Today the index is trusted over pinned TLS and each APK is checked against it.

#### Play

There is no Play API client anywhere in this codebase, and no scraped listings. Google's own client
runs in the guest; the store mirrors it, frames it, and steers it with `market://` intents. Input is
forwarded through the same `GuestSurface` the Screen tab uses.

That is deliberate over reimplementing Play's private protobuf API (what Aurora Store does).
Wrapping the real client means Play's UI, account handling, and installs are exactly current because
they are Play's; nothing here breaks when Google changes an interface we were never calling; and no
one's Google account is at risk for automating an endpoint that forbids it.

It requires the `play` profile — `google_apis_playstore`, the only image shipping
`com.android.vending`:

```bash
ANDROID_PROFILE=play make android-fetch
ANDROID_PROFILE=play make android-setup
ANDROID_PROFILE=play make android-provision
```

Then start the shell with `OPEN_EMULATOR_ANDROID_PROFILE=play`.

**Play certification and device spoofing are mutually exclusive.** The Play image is certified
against its own build fingerprint. Rewriting `build.prop` to impersonate a Pixel produces *"device
is not Play Protect certified"* and blocks sign-in. The Play tab detects a spoofed fingerprint and
says so rather than letting you fight a login that cannot succeed. Use `full` for device-spoofing
work. The Play image is also a user build: `adb root` is refused on it.

#### Local

Drag an APK onto the window. The package name is deliberately **not** parsed out of the file —
`installer.ts` diffs `pm list packages -3` across the install and learns the real package from the
guest, which knows the answer exactly and for free.

#### Compatibility

Apps needing a newer API level than the guest are shown with the reason rather than hidden, so an
install never fails after a long download. Guest facts — API level, Play presence, spoofed identity,
AVD name — come from `src/main/store/guest-facts.ts`.

### Account

One profile spanning every AVD and device profile the shell manages, rather than living inside one
guest. It sits in the tab bar, so "the account" means one thing across the whole shell.

Sign-in is a ladder, each rung falling through to the next:

1. **Already signed in.** `dumpsys account` finds a `com.google` account. This is the usual state:
   accounts live in userdata and `open-emu provision` snapshots userdata, so once you have signed in,
   every later start comes back signed in.
2. **Assisted sign-in.** Opens Google's own add-account screen in the guest and offers to type a
   stored address and password into the focused field. You complete the flow, including any
   two-factor or verification step.
3. **Manual.** The flow is on screen; drive it yourself.

**This cannot silently log you into Google.** Google's sign-in is deliberately resistant to
automation, and a helper app cannot add a Google account either — `addAccountExplicitly` is
signature-gated to GMS. Rung 2 is autofill in the sense a password manager is: your own credential,
into Google's real UI, with every challenge left to you.

#### Where the password goes

Storing a Google password locally is a real risk, so:

- It is **opt-in and off by default**; rungs 1 and 3 work without it.
- It is encrypted by the OS keychain via Electron's `safeStorage`. With no working keychain the
  vault stores **nothing** rather than falling back to a file — a password manager that silently
  degrades to plaintext is worse than none, because you would believe the first one.
- It crosses IPC exactly once, inbound, when you type it into the dialog. Nothing reads it back out
  to the renderer: the renderer asks for the *action*, not the value.
- Typing it does not put it in a command line. It is handed to WSL as an environment variable
  (`WslBridge.runOpenEmuWithEnv`) rather than interpolated into the `wsl.exe` argv, where any
  process listing could read it.

### Security model

These are load-bearing invariants, not style choices:

- **The renderer issues no network requests.** CSP is `default-src 'self'` with
  `connect-src 'none'`. No repository or store page can fingerprint or track it.
- **Every byte the renderer displays is fetched by main.** Icons and screenshots arrive over the
  private `oe-app://` scheme, served from an on-disk cache after the bytes have been sniffed.
- **No "open this URL" primitive is reachable from the renderer.** An app's website and source links
  render as selectable text rather than clickable links; a store page is not a good enough reason to
  add one.
- **The renderer never receives a destination URL** for an ad. It gets an opaque token; main
  resolves it.
- Everything under `store/` and `account/` except the two `index.ts` files is plain Node with no
  electron import — which is what lets the logic be tested against compiled output with
  `node --test`.

---

## The Android runtime

Guest bring-up for **Android 11 (API 30)**, x86_64, on Google's SDK emulator.

### The open-emu CLI

`android/bin/open-emu` is the control plane. Everything the GUI does, it does through this.

| Command | Purpose |
|---|---|
| `profile` | Detect KVM / cores / RAM → write a performance profile |
| `start [--cold]` | Boot Android. **Warm** if already running — no reboot |
| `stop` | Clean shutdown |
| `status` | Runtime status |
| `provision` | Real-workload tuning, then a snapshot save |
| `install <apk>` | `adb install -r -g` with timeout safety |
| `launch <component>` | Start an activity |
| `shell [args...]` | `adb shell` |
| `push` / `pull` | File transfer |
| `logcat [args...]` | Guest log |
| `screenshot [file]` | Capture a PNG |
| `doctor` | Network, storage, package-manager checks |
| `demo` | End-to-end verification path |

```bash
./android/bin/open-emu start
./android/bin/open-emu install path/to/app.apk
./android/bin/open-emu launch com.android.settings/.Settings
./android/bin/open-emu doctor
```

### Make targets

```bash
make android-fetch       # download the SDK + system image (~4 GiB, once)
make android-setup       # create the AVD
make android-provision   # cold boot + tune (+ snapshot on KVM hosts)
make android-start       # subsequent calls reuse a running emulator
make android-stop
make android-status
make android-doctor
make android-bench
make android             # fetch + setup + provision + start

make desktop-install     # npm install in desktop/
make desktop-dev
make desktop-build
make desktop-test

make                     # build open-vmm + the demo guest
make run
make test
make clean
```

### Guest profiles

`android/profiles/*.env`. Each profile gets its **own AVD name**, so switching never silently reuses
another profile's snapshot (which would fail to load and force a re-provision), and its own state
directory under `state/<AVD>/`.

| Profile | System image | GMS | Play Store | Redistributable |
|---|---|---|---|---|
| **`fast`** (default) | `system-images;android-30;default;x86_64` | No | No | Apache-2.0 upstream — yes |
| **`full`** | `google_apis` | Yes | No | **No** — Google proprietary |
| **`play`** | `google_apis_playstore` | Yes | Yes | **No** — Google proprietary |

`fast` drops GMS, which is the single biggest cold-boot saving available; most apps run fine without
it. `play` is the only image shipping `com.android.vending`, and the only one the store's Play tab
can wrap.

Select with `ANDROID_PROFILE=fast|full|play`, or `OPEN_EMULATOR_ANDROID_PROFILE` for the shell.

### Device identities

`android/devices/*.env`. Stock AVD images identify as brand `Android`, model `mainline`, device
`generic`; plenty of apps treat that as an emulator and refuse to run. Presenting a real device is a
compatibility feature, not cosmetics — LDPlayer and BlueStacks both ship exactly this kind of picker.

| Device | Identifies as |
|---|---|
| `generic` | Stock emulator identity |
| `pixel_5` | `google/redfin/redfin:11/RQ3A.211001.001/…:user/release-keys`, 1080×2340 @ 440dpi |
| `redmi_note_11` | Xiaomi identity |

Select with `ANDROID_DEVICE=pixel_5`. **Do not use with the `play` profile** — a rewritten
fingerprint breaks Play certification.

### Performance model

| Host | Acceleration | Boot strategy |
|---|---|---|
| `/dev/kvm` present | KVM | Named snapshot `booted` saved by `provision`; later starts load it |
| No KVM | TCG (software) | Optimized cold boot, then **keep the emulator running** for warm reuse |

Measured on a TCG host with no KVM:

- Cold boot to `sys.boot_completed`: **~175–180 s** (down from ~310 s)
- Warm `start` while running: **immediate**, no reboot
- Guest network: ok
- F-Droid APK install + Settings launch: verified

TCG cannot reliably load emulator named snapshots — it rejects them or segfaults. That is an
upstream emulator limitation without KVM, and it is skipped rather than papered over.

### Guest tuning

Stock Google Android 11 `google_apis;x86_64` image; no AOSP rebuild. All adaptations are AVD/runtime
only, aimed at speed and real workloads.

**Hardware profile** (`android/config/avd_config.ini`)

- SwiftShader GPU for software-rendering hosts
- 720×1280 @ 240dpi — lighter than flagship skins, still usable
- 8 GiB `/data` + 512 MB sdcard, so real apps fit
- Audio, keyboard, GPS, cameras enabled for app compatibility
- Snapshot boot pointed at `booted` after provision

**Runtime** (`android/bin/open-emu`)

- Host profile picks KVM vs TCG, core count, RAM
- Full-speed network (`netdelay none`, `netspeed full`)
- Setup wizard pre-completed; third-party APK installs allowed
- Animations reduced for smoother interaction under software rendering
- APK install uses timeouts so TCG stalls cannot hang the control plane
- Drop APKs in `android/apps/` for auto-install during provision

**Two fixes worth knowing about**

- The emulator is launched with `setsid`, not `nohup`. `nohup` only ignores SIGHUP; the process stays
  in the calling session, and WSL tears a session down when the `wsl.exe` that created it exits.
  From an interactive shell that never happens — which is why it survived so long — but the desktop
  app starts the guest with a one-shot `wsl.exe` call, and the emulator was being killed a second
  after it finished booting.
- Runtime state (`provisioned_at`, pid, adb device) lives under `state/<AVD>/`, not `state/`.
  Sharing it across profiles made `demo` skip provisioning for a guest that had never been
  provisioned. Host CPU/RAM detection stays shared, since it describes the machine.

---

## The licence-clean runtime

`android/foss/` — an Android runtime built only from software this project can ship. **In progress.**

```
QEMU          GPL-2.0      stock distro package, invoked as a separate process
adb           Apache-2.0   Debian's build from AOSP source, not Google's SDK binary
Android-x86   Apache-2.0   userspace over a GPL-2.0 kernel
```

Nothing in it comes from Google's SDK, so none of the Android SDK Terms apply — which is the entire
point. See [Licensing](#licensing-and-monetization).

```
open-emu-foss fetch            # download the Android-x86 image (~920 MB, once)
open-emu-foss prepare          # create the data disk, enable adb over TCP
open-emu-foss start
open-emu-foss stop
open-emu-foss status
open-emu-foss shell [args...]
open-emu-foss install <apk>
open-emu-foss logcat [args...]
open-emu-foss screenshot [file]
open-emu-foss doctor
```

The command surface deliberately mirrors `open-emu`, so the shell can be pointed at it without
changes above the control plane.

---

## open-vmm

A minimal **type-2 virtual machine monitor** in C — the original step 1 of the project, and the
intended long-term replacement for QEMU.

What it does today:

1. Allocates guest physical memory
2. Loads a flat guest binary into it
3. Runs a virtual CPU until the guest executes `HLT`
4. Emulates a serial port (`COM1` / `0x3f8`) so the guest can print

| Backend | When used | How it works |
|---|---|---|
| **kvm** | `/dev/kvm` present | Linux KVM — hardware virtualization (Intel VT-x / AMD-V) |
| **soft** | fallback, or `--backend=soft` | Tiny in-process 16-bit instruction interpreter |

`auto` (the default) picks KVM when available.

```bash
make                                              # -> build/open-vmm, build/guest/hello.bin
make run                                          # software backend
./build/open-vmm --backend=kvm build/guest/hello.bin
make test
```

Expected guest serial output: `open-emulator: guest is alive`

It **cannot boot Android yet** — that needs long mode plus virtio/goldfish devices. Sources are in
`src/` and `include/`; the demo guest is `guest/hello.asm`, assembled by
`scripts/assemble_guest.py`.

---

## Building from source

```bash
cd desktop
npm install

npm run build            # compile main, typecheck renderer, bundle renderer, copy static
npm run build:main       # tsc only
npm run typecheck:renderer
npm run build:renderer   # esbuild bundle
npm test                 # 227 tests, node --test against compiled output
npm run dev              # build, then launch electron
npm start                # launch without rebuilding
npm run icon             # regenerate build/icon.png
npm run dist:win         # full installer  -> release/open-emulator-Setup-<version>.exe
npm run dist:dir         # unpacked only   -> release/win-unpacked/   (faster)
```

---

## Packaging and shipping

### The backend ships outside the asar

`extraResources` copies `android/`, `scripts/`, and `Makefile` to `resources/backend/`, and
`repoRootWinPath()` (`src/main/win-paths.ts`) looks there first.

**This is not optional.** The app copies that tree into the WSL distro on first run, and an asar is
a single file — a path inside it is not a real directory, so `tar` and `cp` cannot read it. Packaged
without this, every install would look fine and fail the moment it tried to reach its own backend.

Generated trees are excluded from the copy (`sdk`, `avd`, `state`, `logs`, `*.img`, `*.qcow2`): they
belong to the distro, not the installer, and shipping them would add gigabytes to a file whose
useful payload is about 100 KB.

### What a user still has to download

The installer is ~75 MB. On first run the app needs WSL2 plus roughly 4 GB of Android system image,
which the setup screen fetches by itself. **Say this on the download page.** It is not a
"download and run" app, and finding that out after double-clicking is a bad first impression.

### Code signing

The installer is unsigned, so SmartScreen shows *"Windows protected your PC"* and users click
through **More info → Run anyway**. There is no way around this except a certificate:

- A standard **OV** certificate (~$200–400/yr) works immediately but builds SmartScreen reputation
  slowly — early downloaders still see the warning.
- An **EV** certificate costs more and carries reputation from the first signature.

With a certificate, set `CSC_LINK` (path or base64 of the `.pfx`) and `CSC_KEY_PASSWORD` in the
environment; electron-builder picks them up with no config change.

### Icon

`build/icon.png` is generated by `scripts/make-icon.mjs` rather than checked in — the repo carries
the recipe instead of an opaque binary. `npm run icon` regenerates it; `dist:win` does so
automatically.

### Publishing a release

`desktop/release/` is gitignored, so the installer is **not** in the repository — a ~75 MB binary
does not belong in git history. Attach it to a GitHub Release instead, which is what the README's
download link points at:

```bash
gh release create v0.0.1 \
  "desktop/release/open-emulator-Setup-0.0.1.exe" \
  --title "open-emulator 0.0.1" \
  --notes "First packaged build."
```

Without the `gh` CLI, do the same from **Releases → Draft a new release** on GitHub and drag the
`.exe` into the assets box.

The README's direct link resolves through `releases/latest/download/<asset-name>`, so it keeps
working as long as each release keeps the same asset filename.

> **While the repository is private, release assets are private too** — a download link only works
> for people with repo access. To hand the installer to someone outside, either add them as a
> collaborator, make the repository public, or share the file another way.

### Known packaging snag

electron-builder unpacks a code-signing toolchain into
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign`, and that archive contains two macOS symlinks.
Windows refuses to create symlinks without Developer Mode or elevation, so extraction fails with
*"A required privilege is not held by the client"* — even though a Windows build never uses those
files.

Either enable Developer Mode, or pre-extract the archive without them once:

```powershell
$cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
& .\node_modules\7zip-bin\win\x64\7za.exe x -bd -y "$cache\winCodeSign-2.6.0.7z" `
    "-o$cache\winCodeSign-2.6.0" "-xr!darwin"
```

electron-builder finds the populated directory and skips the download.

---

## Licensing and monetization

Full audit in [`LICENSING.md`](LICENSING.md). **Engineering research, not legal advice.**

**Your own code and everything in the installer is clean.** 321 npm packages, zero copyleft, only
React ships. Breakdown: 252 MIT, 40 ISC, 8 Apache-2.0, 6 BSD-2, 5 BSD-3, 5 BlueOak, 1 Python-2.0.
**No GPL, LGPL, AGPL, MPL, SSPL, or non-commercial licences anywhere.**

**The problem is what the app downloads on first run.** The runtime is Google's SDK emulator and
Google's system images, and the Android SDK Terms §3.3 forbid combining "any part of the SDK with
other software" or distributing software incorporating it. You do not redistribute it — each user's
machine downloads it and accepts Google's licence, the arrangement every Android tooling vendor
relies on — but the clause is broad, and it is the one thing standing between this and a product you
can sell without worrying.

BlueStacks, LDPlayer and Genymotion all ship Google Play under **GMS certification agreements with
Google**. That is a commercial negotiation, not something that can be coded around.

| What you'd sell | Verdict |
|---|---|
| The desktop shell alone | **Yes** — your code plus MIT/BSD libraries |
| Shell + `fast` profile, user's machine fetches Google's SDK | **Grey area** — you distribute nothing of Google's, but §3.3 is broad |
| Anything with `full` or `play` | **No**, not without a Google agreement — those carry GMS |

The route out, in increasing effort: replace the VMM (crosvm is BSD-3-Clause and is what actually
runs Android on ChromeOS; upstream QEMU is GPL-2.0 and sellable with a source offer; `open-vmm` is
the stated goal), then replace the system image (AOSP or Android-x86 — this is the step that took
BlueStacks and LDPlayer years and the one that buys the right to sell), then replace Play (microG,
your own F-Droid repo, or a GMS agreement).

Also worth knowing:

- **ffmpeg** inside Electron carries H.264/AAC — a *patent* question, not copyright. If the shell
  never decodes video, ship an Electron `ffmpeg.dll` built without proprietary codecs and the
  question disappears.
- **The repo has no licence file**, which means all rights reserved. That is the right default for
  something you intend to sell, and adding an open-source licence is hard to walk back. Decide
  deliberately, and if the repo is public, decide soon.
- Attribution obligations for the MIT/BSD dependencies are recorded in
  [`desktop/THIRD-PARTY-NOTICES.md`](desktop/THIRD-PARTY-NOTICES.md); electron-builder already ships
  `LICENSE.electron.txt` and `LICENSES.chromium.html`.

---

## Configuration reference

### Desktop shell

| Variable | Default | Effect |
|---|---|---|
| `OPEN_EMULATOR_WSL_DISTRO` | `OpenEmulator` | Which WSL distro to drive |
| `OPEN_EMULATOR_ANDROID_PROFILE` | `fast` | Guest profile the shell starts |
| `OPEN_EMULATOR_REMOTE_PATH` | — | Path to the backend checkout inside the distro |
| `OPEN_EMULATOR_ENGINE` | `wsl` | Which runtime drives the guest — `wsl` or `sdk` (native Windows, in progress) |

> **The native Windows runtime is not the default yet.** `OPEN_EMULATOR_ENGINE=sdk` runs
> `emulator.exe` and `adb.exe` as ordinary Windows processes with no WSL involved, downloading the
> SDK to `%LOCALAPPDATA%\open-emulator` instead of into a distro. It has been verified as far as
> starting the emulator and having adb see the guest; it has **not** yet booted Android to a usable
> state, because that needs the Windows Hypervisor Platform enabled. Until it has, `wsl` remains the
> default — shipping an untested runtime as the default would trade a slow product for a broken one.

### Android runtime

| Variable | Effect |
|---|---|
| `ANDROID_PROFILE` | `fast` \| `full` \| `play` |
| `ANDROID_DEVICE` | `generic` \| `pixel_5` \| `redmi_note_11` |
| `ANDROID_AVD_NAME` | Override the AVD name |
| `ANDROID_AVD_HOME` | Override the AVD location |
| `ANDROID_CORES` | vCPU count |
| `ANDROID_MEMORY_MB` | Guest RAM |
| `ANDROID_GPU_MODE` | e.g. `swiftshader_indirect` |
| `ANDROID_HEADLESS` | Run with no emulator window |
| `ANDROID_SNAPSHOT_NAME` | Snapshot to save/load (default `booted`) |
| `ANDROID_WRITABLE_SYSTEM` | Mount `/system` writable — needed for image surgery |

### Build

| Variable | Effect |
|---|---|
| `CSC_LINK` | Path or base64 of the code-signing `.pfx` |
| `CSC_KEY_PASSWORD` | Its password |

---

## Repository layout

```text
desktop/                    Electron app
  src/main/                   privileged side
    index.ts                    entry, IPC registration
    wsl-bridge.ts               every wsl.exe call goes through here
    wsl-detect.ts               is WSL2 installed?
    setup-wizard.ts             the first-run step machine
    open-emu-client.ts          typed wrapper over the CLI
    screen-mirror.ts            PNG frame stream
    guest-input.ts              tap/swipe/key/text builders
    shell-quote.ts              POSIX quoting across two shells
    app-library.ts              installed-app list
    device-status.ts            status light, version
    image-cache.ts              https-only, byte-sniffed, hex ids
    win-paths.ts                repoRootWinPath() — asar-aware
    store/                      catalog, fdroid-index, installer, play, guest-facts, sources/
    account/                    profile, vault, guest-account, signin-driver
  src/renderer/               UI (React)
    App.tsx, components/{Store,Account,SetupWizard,…}
  src/preload/                context bridge
  src/shared/                 types crossing IPC
  test/                       node --test suites (251)
  scripts/                    build-renderer, copy-static, make-icon

android/                    Android runtime
  bin/open-emu                control plane CLI (Google SDK)
  foss/                       licence-clean runtime (QEMU + Android-x86)
  lib/common.sh               shared helpers
  scripts/                    fetch / setup / provision / bench / image surgery
  config/avd_config.ini       AVD hardware profile
  profiles/                   fast.env, full.env, play.env
  devices/                    generic, pixel_5, redmi_note_11
  apps/                       drop APKs here for auto-install
  sdk/ avd/ state/ logs/      generated, gitignored
  imported/                   image identity + last verified results

src/, include/              open-vmm — main.c, vmm.c, x86_soft.c, serial.c
guest/hello.asm             demo real-mode guest
scripts/                    assemble_guest.py, smoke_test.sh
Makefile                    open-vmm, android-*, desktop-* targets
```

**Gitignored and never committed:** `android/sdk`, `android/avd`, `android/state`, `android/logs`,
`android/images`, `*.iso`, `*.img`, `*.qcow2`, `android/apps/*.apk`, `build/`,
`desktop/node_modules`, `desktop/dist`, `desktop/release`, `desktop/build`.

---

## Testing

```bash
cd desktop && npm test
```

251 tests, `node --test` over the compiled output in `dist/`. The suite runs in about a second
because nothing in it needs Electron, WSL, or a guest: everything under `store/` and `account/` is
plain Node except the `index.ts` files that own the IPC surface, and those are the only files
importing `electron`.

`open-vmm` has its own path:

```bash
make test              # builds, then scripts/smoke_test.sh
```

---

## Troubleshooting

**Setup fails partway.** The setup screen names the step and offers **Try again**; **Details** shows
the full log. Steps are resumable — nothing already downloaded is fetched twice.

**Windows asked to restart during WSL install.** Restart, reopen the app. It resumes.

**Setup fails at "Linux environment: no usable distro found", with step 1 green.** Restart Windows
and reopen the app. `wsl --install` enables the Virtual Machine Platform optional feature, reports
success, and registers no distro until the machine reboots — while `wsl --status` keeps exiting 0
throughout, so the WSL step passes and its own restart hint never renders. The wizard now checks
for staged feature changes and names the restart directly. If a restart does not clear it, confirm
virtualization is actually on:

```powershell
"Hypervisor present: $((Get-CimInstance Win32_ComputerSystem).HypervisorPresent)"
"Reboot pending: $(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')"
wsl --status
wsl -l -v
```

`Hypervisor present: False` means virtualization is disabled in BIOS, which is a different problem.

**`/usr/bin/env: 'bash\r': No such file or directory`.** The backend copy in the distro has CRLF
line endings. Re-run the *Backend synced into distro* setup step, which normalises them.

**`unknown profile 'play'`.** The backend copy inside the distro predates this build. Re-run the
backend sync step.

**"Device is not Play Protect certified", or Play sign-in refuses.** A spoofed device fingerprint on
the `play` profile. Play certification and device spoofing are mutually exclusive — use the stock
`generic` device with `play`, or switch to the `full` profile for spoofing work.

**`adb root` refused.** Expected on the `play` image; it is a user build.

**Snapshot fails to load, guest cold-boots every time.** No KVM on the host. TCG cannot reliably
load emulator named snapshots — an upstream limitation. The runtime detects this, skips the
snapshot, and keeps the emulator running so the next `start` is warm instead.

**The emulator dies about a second after boot.** Fixed — the guest is launched with `setsid`. If you
see it on an older backend copy inside the distro, re-run the backend sync.

**SmartScreen blocks the installer.** Expected; it is unsigned. **More info → Run anyway**, or sign
it — see [Code signing](#code-signing).

**`dist:win` fails with "A required privilege is not held by the client".** See
[Known packaging snag](#known-packaging-snag).

**Store shows nothing / search is empty.** The F-Droid catalogue downloads once on first use. Check
the network, then reopen the tab; the index refreshes at most every 12 hours.

**An install fails digest verification.** Working as intended — the downloaded APK did not match the
digest F-Droid published. The file is deleted. Retry; if it persists, the mirror is serving
something else.
