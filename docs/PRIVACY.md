# Privacy

_Last updated: 2026-08-13._

This covers both the **open-emulator desktop app** and the **marketing
website**. Short version: neither collects analytics, telemetry, or
advertising data today. This document will be updated, with a new "last
updated" date, if that ever changes — see
[`docs/MONETIZATION.md`](MONETIZATION.md) for what a future ad-supported
build would add and how it would be disclosed here first.

## Desktop app

The app does not run any analytics, crash reporting, or advertising SDK,
and does not phone home to any server operated by this project. Network
activity a user can trigger:

| Action | Destination | Why |
|--------|--------------|-----|
| Install wizard's "Download SDK" step | Google's Android SDK servers (`dl.google.com`, `sdkmanager` repositories) | Fetches the Android SDK/Emulator/system image — see [`android/scripts/fetch_android.sh`](../android/scripts/fetch_android.sh). Only runs after the SDK license step is explicitly accepted. |
| Emulated Android guest's own network access | Whatever the guest OS/apps reach | The emulator is a real virtual machine; apps you install inside it behave like they would on a physical device. |
| Update check (sidebar footer) | A static JSON feed URL, only if one is configured in [`desktop/config/update.json`](../desktop/config/update.json) | Off by default (`feedUrl: ""`) until a real release feed exists — see [`desktop/lib/updater.js`](../desktop/lib/updater.js). Sends nothing but a plain HTTP GET; no identifiers attached. |

Everything else — keymaps, macros, instance list, GPS spoofing values,
performance settings, the SDK license-acceptance flag — is stored **only**
on the local machine (see [`desktop/lib/paths.js`](../desktop/lib/paths.js)
for exactly where) and is never transmitted anywhere.

## Website

The static site under [`web/`](../web/) ships with no analytics script, no
third-party font/script CDN beyond what's declared in each page, and no
cookies. If that changes (e.g. adding privacy-respecting analytics, or the
programmatic display ads described in
[`docs/MONETIZATION.md`](MONETIZATION.md)), this page and a cookie/consent
notice will be updated first.

## Contact

Open an issue on the project's GitHub repository for privacy questions.
