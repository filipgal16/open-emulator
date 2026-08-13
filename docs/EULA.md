# open-emulator end-user terms

_Last updated: 2026-08-13._

open-emulator's own source code is open source (Apache-2.0 — see
[`LICENSE`](../LICENSE)); you don't need to agree to anything beyond that
license to build or modify it. These terms cover using the **packaged app**
(AppImage / deb / installer) as a product, since it also sets up
third-party components this project doesn't own.

## 1. What you're getting

A desktop application that runs an isolated Android virtual machine (or
several, via the tab bar) on your own computer, using the official Android
Emulator and system images. The app itself is provided "as is," without
warranty of any kind, to the fullest extent the law allows — see Section 5.

## 2. Third-party components

- **Android SDK, Emulator, and system images.** These are downloaded
  directly from Google at setup time and are governed by Google's own
  [Android SDK License Agreement](https://developer.android.com/studio/terms),
  not by this project. The install wizard shows that agreement and requires
  you to accept it before any SDK download starts. This app does not
  bundle, modify the licensing of, or redistribute those components.
- **Electron / Node.js / Chromium.** Bundled under their own licenses
  (MIT) — see [`docs/NOTICES.md`](NOTICES.md).
- **Apps you install inside the emulator.** Are governed by their own
  publishers' terms. This project has no relationship with, and takes no
  responsibility for, third-party apps you choose to run.

## 3. Acceptable use

Use the emulator for lawful purposes on hardware and in jurisdictions
where doing so is permitted. Don't use it to violate another party's
terms of service, intellectual property rights, or applicable export
control laws (the Android SDK itself carries U.S. export restrictions —
see Google's license linked above).

## 4. No ads, no account, no telemetry (today)

The current build collects no telemetry and shows no advertising — see
[`docs/PRIVACY.md`](PRIVACY.md). If a future ad-supported or paid tier
ships (see [`docs/MONETIZATION.md`](MONETIZATION.md)), these terms will be
updated first and the "last updated" date above will change.

## 5. Warranty disclaimer and liability

THE APPLICATION IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED. TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE AUTHORS AND
CONTRIBUTORS ARE NOT LIABLE FOR ANY DAMAGES ARISING FROM USE OF THE
APPLICATION, INCLUDING DATA LOSS OR HARDWARE ISSUES CAUSED BY RUNNING
VIRTUAL MACHINES ON YOUR HOST. THIS MATCHES [SECTIONS 7–8 OF THE
APACHE-2.0 LICENSE](../LICENSE) THAT THE UNDERLYING CODE IS RELEASED UNDER.

## 6. Changes

These terms may change as the product grows (see
[`docs/ROADMAP.md`](ROADMAP.md)). Material changes — like introducing ads,
accounts, or paid tiers — will bump the "last updated" date and be called
out in release notes.
