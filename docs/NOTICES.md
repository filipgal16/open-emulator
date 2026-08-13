# Third-party notices

This project's own code ([`src/`](../src/), [`android/bin/`](../android/bin/),
[`android/lib/`](../android/lib/), [`android/scripts/`](../android/scripts/),
[`desktop/`](../desktop/)) is licensed under Apache-2.0 — see
[`LICENSE`](../LICENSE). Two categories of third-party material are used
alongside it and are **not** covered by that license.

## Bundled at build time

[`desktop/lib/`](../desktop/lib/) and [`desktop/public/`](../desktop/public/)'s
own code has no third-party dependencies of its own — the only third-party
pieces that ship inside an installer are:

| Component | License | Notes |
|-----------|---------|-------|
| [Electron](https://www.electronjs.org/) | MIT | Provides the app runtime (Chromium + Node.js) |
| Node.js | MIT | Bundled inside Electron |
| [electron-updater](https://www.electron.build/auto-update) | MIT | Update-check only — `autoDownload` is off; see [`desktop/lib/updater.js`](../desktop/lib/updater.js) and [`docs/ROADMAP.md`](ROADMAP.md) |

`electron-builder` (used to build installers) and `electron` itself are
`devDependencies` — see [`desktop/package.json`](../desktop/package.json) —
and are not distributed as part of any installer beyond what Electron
itself packages. The `monetize/server/` side has zero dependencies at all
(Node built-ins only).

## Downloaded by the app at setup time, never bundled

| Component | Source | License | How it's used |
|-----------|--------|---------|----------------|
| Android SDK, Emulator, platform-tools, system image | Google, via `sdkmanager` | [Android SDK License Agreement](https://developer.android.com/studio/terms) | Downloaded directly from Google's servers by [`android/scripts/fetch_android.sh`](../android/scripts/fetch_android.sh) after a person explicitly accepts the license in the install wizard. Never copied into this repository or into any installer this project builds. |
| [scrcpy-server](https://github.com/Genymobile/scrcpy) | Genymobile, GitHub releases | Apache-2.0 | Downloaded and SHA-256-verified by [`desktop/lib/mirror.js`](../desktop/lib/mirror.js) the first time live mirroring is used, then pushed per-device over adb. Apache-2.0 permits redistribution — it's fetched rather than bundled purely to keep the installer small and updates independent of app releases, not because of a license restriction (contrast with the SDK row above). |

The Android SDK License Agreement prohibits redistributing, bundling, or
sublicensing the SDK. This project is built around that constraint: every
install fetches its own copy from Google, under the installing user's own
acceptance of Google's terms (see [`docs/LEGAL.md`](LEGAL.md) for the
compliance reasoning, and the wizard's License step in
[`desktop/public/wizard.html`](../desktop/public/wizard.html)).

## Trademarks

Apache-2.0 covers the code; it does not grant rights to the `open-emulator`
name, wordmark, or the mint leaf-device mark in [`brand/logo/`](../brand/logo/)
(Apache-2.0 §6 says the same). Forks and derivatives are welcome to reuse the
code under its license, but should use their own name and mark rather than
this project's branding.

"Android" is a trademark of Google LLC. This project is not affiliated with,
endorsed by, or sponsored by Google.
