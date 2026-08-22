# Licensing and monetization

An audit of everything this project depends on, and what each piece means if you want to sell it.

**This is engineering research, not legal advice.** The facts below come from the licence files on
disk and the vendors' published terms; the conclusions are mine and worth a lawyer's hour before
you charge anyone money.

---

## The short version

**Your own code and everything in the installer is clean.** 321 npm packages, zero copyleft, and
only React ships. The Windows installer contains nothing you cannot sell.

**The problem is not in the installer — it is what the app downloads on first run.** The Android
runtime is Google's SDK emulator and Google's system images, and the Android SDK Terms say
(§3.3):

> you may not: (a) copy (except for backup purposes), modify, adapt, redistribute, decompile,
> reverse engineer, disassemble, or create derivative works of the SDK or any part of the SDK; or
> (b) … **combine any part of the SDK with other software, or distribute any software or device
> incorporating a part of the SDK**.

The product's whole runtime is "the SDK combined with other software". You do not redistribute it —
each user's machine downloads it and accepts Google's licence — which is the arrangement every
Android tooling vendor relies on. But "combine any part of the SDK with other software" is broad,
and it is the single clause that stands between this and a product you can sell without worrying.

**The three emulators that ship Google Play legally — BlueStacks, LDPlayer, Genymotion — all hold
GMS certification agreements with Google.** That is a commercial negotiation, not something that
can be coded around.

---

## What ships in the installer today

| Component | Licence | Sellable? |
|---|---|---|
| Your code (`src/`, `android/`, `desktop/src/`) | none declared → all rights reserved | Yes — you own it |
| React, React-DOM | MIT | Yes, with attribution |
| Electron runtime | MIT | Yes, with attribution |
| Chromium (inside Electron) | BSD-3-Clause + many | Yes — notices already shipped |
| `ffmpeg.dll` (inside Electron) | LGPL/GPL build, **patented codecs** | See note below |
| Dev toolchain (TypeScript, esbuild, electron-builder) | Apache-2.0 / MIT | Not distributed |

Full dependency scan: **252 MIT, 40 ISC, 8 Apache-2.0, 6 BSD-2, 5 BSD-3, 5 BlueOak, 1 Python-2.0**,
plus a few WTFPL/CC0 dual-licensed. **No GPL, LGPL, AGPL, MPL, SSPL, or non-commercial licences
anywhere.** electron-builder already ships `LICENSE.electron.txt` and `LICENSES.chromium.html` into
the output, which covers the attribution obligation for those.

> **ffmpeg**: Electron bundles a full FFmpeg with H.264/AAC. That is a *patent* question rather
> than a copyright one — commercial distribution of H.264 decoders has historically wanted an
> MPEG-LA/Via licence. If you never decode video in the shell UI, you can ship Electron's
> `ffmpeg.dll` built without proprietary codecs and remove the question entirely.

---

## What the app downloads, and what it costs you

Measured from the licence manifests in the fetched SDK (`emulator/NOTICE.csv`):

| Component | Licence | Monetization impact |
|---|---|---|
| **Android SDK emulator** | Apache-2.0 for Google's QEMU fork, but the package also contains **GPL-2.0-only** (`qemu`, `e2fs`), **GPL-2.0-or-later** (`ffmpeg`, `dtc`), **LGPL-3.0** (Qt 6 Core/Gui/Widgets/Svg), **LGPL-2.1** (glib), **LGPL-2.0** (bios) | You never redistribute it, so the copyleft obligations do not attach to you. The **SDK Terms** are the real constraint. |
| **`default` system image** (the `fast` profile) | AOSP, Apache-2.0 upstream — but distributed by Google under `android-sdk-license` | Cleanest of the three. Apache-2.0 is fully sellable *if you build the image yourself*. |
| **`google_apis` image** (the `full` profile) | `android-sdk-license` + **Google Mobile Services, proprietary** | Not redistributable. Commercial use needs an agreement with Google. |
| **`google_apis_playstore`** (the `play` profile) | same, plus the Play Store | Same, and Play certification is explicitly a per-vendor agreement. |
| **F-Droid catalogue** | `fdroiddata` metadata is **AGPL-3.0**; the client code here is yours | You consume a public API and cache it locally; you do not run a modified F-Droid server, so AGPL §13 does not bite. Low risk, worth confirming. |
| **The APKs users install** | whatever each app is under | Not your problem — you are a delivery mechanism, like any store. F-Droid's own `NonFreeAssets` flag already surfaces restricted ones, and the Store shows anti-features. |

---

## What you can sell today, honestly

- **The desktop shell on its own** — yes, unambiguously. It is your code plus MIT/BSD libraries.
- **The shell + the `fast` (AOSP) profile, with the user's machine fetching Google's SDK** — this
  is the grey area. Legally you distribute nothing of Google's; practically your product does not
  function without it, and §3.3 is written broadly.
- **Anything with `full` or `play`** — no, not commercially, without a Google agreement. Those
  images carry GMS.

---

## Making it genuinely clean

Three swaps, in increasing order of effort. Together they remove Google from the dependency chain
entirely and leave you with an Apache-2.0/BSD stack you own outright.

### 1. Replace the VMM — days to weeks

| Option | Licence | Notes |
|---|---|---|
| **crosvm** | **BSD-3-Clause** | Google's own VMM, written in Rust, and the thing that actually runs Android on ChromeOS (ARCVM). Permissive, so no source-offer obligation. Best fit. |
| **Upstream QEMU** | GPL-2.0 | Sellable — invoking it as a separate process does not make your app a derivative — but you must offer QEMU's source if you ship its binaries. |
| **`open-vmm`** (this repo) | yours | The stated long-term goal. Needs long mode + virtio/goldfish before it can boot Android. |

The repo is already structured for this: everything goes through `android/bin/open-emu`, so the
backend can be swapped without touching the store, the account, or any UI.

### 2. Replace the system image — weeks

Build your own from **AOSP** (Apache-2.0) or start from **Android-x86** (Apache-2.0 userspace,
GPL-2.0 kernel — redistributable with a source offer). `android/scripts/build_custom_image.sh`
already does in-place image surgery, so the tooling exists; what is missing is producing the base
image rather than consuming Google's.

This is the step that took BlueStacks and LDPlayer years, and it is the one that actually buys you
the right to sell.

### 3. Replace Google Play — a business decision, not a code one

- **microG** (Apache-2.0) — free GMS reimplementation. Covers push, location, and many Play
  Services APIs. Needs signature spoofing, so it wants a patched ROM — which you would have by
  step 2.
- **F-Droid + your own repo** — already built and working.
- **A GMS agreement with Google** — the only lawful route to a real Play Store, and what your three
  competitors did.

---

## What changed in the repo as a result

- Your own code has **no licence file**, which means all rights reserved. That is the right default
  for something you intend to sell, and adding an open-source licence would be hard to walk back —
  so nothing was added. Decide deliberately, and if the repo is public, decide soon.
- `THIRD-PARTY-NOTICES.md` records the attribution the MIT/BSD dependencies require.
- The `full` and `play` profiles now say plainly that they carry Google proprietary components and
  are not for commercial distribution.

## Sources

- Android SDK Terms and Conditions — <https://developer.android.com/studio/terms>
- Emulator component licences — `android/sdk/emulator/NOTICE.csv` in a fetched SDK
- crosvm — <https://github.com/google/crosvm>
- AOSP licensing — <https://source.android.com/license>
