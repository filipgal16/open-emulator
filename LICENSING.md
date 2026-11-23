# Licensing and monetization

An audit of everything this project depends on, and what each piece means if you want to sell it.

**This is engineering research, not legal advice.** The facts below come from the licence files on
disk and the vendors' published terms; the conclusions are mine and worth a lawyer's hour before
you charge anyone money.

---

## The short version

**Your own code and everything in the installer is clean.** The app is Rust, built from crates whose
declared licences are all permissive or offer a permissive choice (MIT, Apache-2.0, BSD, ISC, Zlib,
Unicode, and similar). They are listed, with versions, in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). The installer contains the app's one executable,
a few data files from `android/`, and the licence files. There is no bundled browser engine, media
codec library or JavaScript runtime.

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
| Your code (`crates/`, `xtask/`, `android/`) | none declared → all rights reserved | Yes — you own it |
| Rust crates compiled into `open-emulator.exe` (iced, wgpu, tokio, reqwest, windows-sys, RustCrypto and the rest) | MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0 and similar | Yes, with attribution |
| Dev tools (`xtask`, `open-vmm`) | same | Not distributed in the installer |

The full list, generated from `cargo metadata`, is in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
A few crates are dual-licensed with a copyleft option (`MIT OR Apache-2.0 OR LGPL-2.1-or-later`,
`Apache-2.0 OR GPL-2.0-only`); the project uses those under the permissive option, so no copyleft
obligation attaches. Re-check the list when `Cargo.lock` changes.

The installer does not ship `ffmpeg` or any other codec library, so the patent question that comes
with bundling H.264 decoders does not arise. Android's own video, inside the guest, is Google's.

---

## What the app downloads, and what it costs you

Measured from the licence manifests in the fetched SDK (`emulator/NOTICE.csv`):

| Component | Licence | Monetization impact |
|---|---|---|
| **Android SDK emulator** | Apache-2.0 for Google's QEMU fork, but the package also contains **GPL-2.0-only** (`qemu`, `e2fs`), **GPL-2.0-or-later** (`ffmpeg`, `dtc`), **LGPL-3.0** (Qt 6 Core/Gui/Widgets/Svg), **LGPL-2.1** (glib), **LGPL-2.0** (bios) | You never redistribute it, so the copyleft obligations do not attach to you. The **SDK Terms** are the real constraint. |
| **`default` system image** (the `fast` profile, and the base of `openemu`) | AOSP, Apache-2.0 upstream — but distributed by Google under `android-sdk-license` | Cleanest of the three. Apache-2.0 is fully sellable *if you build the image yourself*. |
| **`google_apis` image** (the `full` profile) | `android-sdk-license` + **Google Mobile Services, proprietary** | Not redistributable. Commercial use needs an agreement with Google. |
| **`google_apis_playstore`** (the `play` profile) | same, plus the Play Store | Same, and Play certification is explicitly a per-vendor agreement. |
| **`openemu-compat`** (our ROM built *from* `google_apis`; `openemu` is the same recipe applied to the AOSP `default` image, which is a smaller version of the same question) | everything the `google_apis` row says, **plus** it is a modified copy of that image: apps removed, two files rewritten, vbmeta re-signed | The hardest case here, and **unresolved**. SDK Terms §3.3 forbid modifying or making derivative works of the SDK; this ROM is one, made on the user's machine from their own download and never redistributed. Fine to develop and measure with. Do not make it a shipped default, or sell a build that produces it, before a lawyer has read §3.3 against it. |
| **F-Droid catalogue** | `fdroiddata` metadata is **AGPL-3.0**; the client code here is yours | You consume a public API and cache it locally; you do not run a modified F-Droid server, so AGPL §13 does not bite. Low risk, worth confirming. |
| **The APKs users install** | whatever each app is under | Not your problem — you are a delivery mechanism, like any store. F-Droid's own `NonFreeAssets` flag already surfaces restricted ones, and the Store shows anti-features. |

---

## What you can sell today, honestly

- **The desktop app on its own** — yes, unambiguously. It is your code plus permissively licensed Rust crates.
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
| **`open-vmm`** (`crates/oe-vmm`) | yours | The stated long-term goal. A real-mode interpreter and a Linux KVM backend today; it needs long mode + virtio/goldfish before it can boot Android. |

The repo is already structured for this: the app drives the guest through one engine interface in
`oe-engine`, so the backend can be swapped without touching the store, the account, or the UI.

### 2. Replace the system image — weeks

Build your own from **AOSP** (Apache-2.0) or start from **Android-x86** (Apache-2.0 userspace,
GPL-2.0 kernel — redistributable with a source offer). `oe-formats` already does in-place image
surgery (an ext4 editor, AVB re-signing, super-partition editing) for the `openemu` ROM, so the
tooling exists; what is missing is producing the base image rather than consuming Google's.

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
- `THIRD-PARTY-NOTICES.md` records every Rust crate the app is built from, with its declared licence.
- The `full` and `play` profiles now say plainly that they carry Google proprietary components and
  are not for commercial distribution.

## Sources

- Android SDK Terms and Conditions — <https://developer.android.com/studio/terms>
- Emulator component licences — `android/sdk/emulator/NOTICE.csv` in a fetched SDK
- crosvm — <https://github.com/google/crosvm>
- AOSP licensing — <https://source.android.com/license>
