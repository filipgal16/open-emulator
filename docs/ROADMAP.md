# Roadmap

Status snapshot, then what's next, roughly in the order it makes sense to
build it. Nothing below is time-estimated in calendar terms — the notes
describe which subsystems change and how invasive each is instead.

## Shipped so far

- Native Electron shell: mint sidebar, top tab bar over isolated AVD
  instances, themed first-run wizard (host check → **explicit Android SDK
  license acceptance** → SDK fetch → first machine → optional shortcut).
- Real multi-instance isolation (`android/lib/instances.sh`): independent
  userdata, sdcard, console/adb ports per named machine.
- Packageable build: [`desktop/lib/paths.js`](../desktop/lib/paths.js)
  splits code from mutable data so a packaged install's SDK/AVD/state/logs
  live in the OS's per-user data dir, not inside a read-only install.
  [`desktop/electron-builder.yml`](../desktop/electron-builder.yml) builds
  a real AppImage/deb today (verified — see the commit that introduced
  it), with nsis/dmg targets declared for CI. A lightweight update
  *notifier* ([`desktop/lib/updater.js`](../desktop/lib/updater.js)) exists
  but is off by default (no feed deployed yet).
- Marketing/download site ([`web/`](../web/)): static, zero-dependency,
  templated for adding more pages later.
- Legal groundwork: [`LICENSE`](../LICENSE) (Apache-2.0),
  [`docs/EULA.md`](EULA.md), [`docs/PRIVACY.md`](PRIVACY.md),
  [`docs/NOTICES.md`](NOTICES.md), [`docs/LEGAL.md`](LEGAL.md).
- **Zero ads, zero monetization code** — by design, for now. Options are
  written up in [`docs/MONETIZATION.md`](MONETIZATION.md) but nothing
  there is wired in.

## Phase A — Real distribution

The CI workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
builds unsigned installers on every platform and stops at uploading them
as workflow artifacts. To turn that into something a stranger will
actually run:

1. **Code signing.** A Windows EV/OV certificate (kills most SmartScreen
   warnings) and an Apple Developer ID + notarization (required for macOS
   Gatekeeper to allow it at all without a manual override). Linux doesn't
   need this. Wire signing secrets into `electron-builder.yml`'s
   `win.certificateFile`/`mac.notarize` once obtained.
2. **Actually publish.** Switch `publish: null` in
   [`desktop/electron-builder.yml`](../desktop/electron-builder.yml) to a
   real provider (GitHub Releases is the path of least resistance —
   `electron-builder`'s built-in `github` publisher) once signing is in
   place, so tagging a version produces a public release instead of a
   CI-only artifact.
3. **Turn on the update feed.** Regenerate
   `web/dist/updates/releases.json` from the release step and point
   [`desktop/config/update.json`](../desktop/config/update.json)'s
   `feedUrl` at the deployed copy. Consider moving from the current
   plain-notify check to `electron-updater`'s full auto-download flow —
   safe to do only once builds are signed.
4. **Deploy `web/`.** Any static host works — see
   [`web/README.md`](../web/README.md). Update the hardcoded
   `https://github.com/...` links in `web/pages/*.html` if the canonical
   home becomes the deployed site instead of the repo.

## Phase B — Monetization

Sequencing recommendation, building on [`docs/MONETIZATION.md`](MONETIZATION.md):

1. **`monetize/server/`** — the smallest possible Node service:
   `GET /v1/campaigns`, `POST /v1/events`, `GET /v1/click/:id`. JSONL
   storage is enough at first; no database needed yet.
2. **`desktop/lib/ads.js` + a bottom-rail slot** in
   [`desktop/public/index.html`](../desktop/public/index.html) — ship
   with a bundled house-ad fallback so it still renders something with
   zero direct deals sold yet. Add the consent step to the wizard
   ([`desktop/public/wizard.html`](../desktop/public/wizard.html)) in the
   same change, not after.
3. **`desktop/lib/entitlement.js`** — offline license verification, free
   vs. Pro instance caps. This can ship *before* a real payment flow
   exists (default everyone to free tier) so the plumbing is in place
   when checkout is ready.
4. **Game Center panel** (Example 2 in MONETIZATION.md) once there's
   enough install volume to make an affiliate network deal worth
   pursuing.
5. **SEO content pages** in [`web/pages/`](../web/pages/) — mechanical
   once the manifest-driven site exists, but needs actual product
   screenshots/GIFs to be worth publishing, which argues for doing this
   after Phase C (mirroring) makes the product look like the real thing.

## Phase C — Live screen mirroring (the honest long pole)

Today the guest view is a screenshot polled every 9 seconds
([`desktop/public/app.js`](../desktop/public/app.js)) and input goes
through `adb shell input`
([`desktop/lib/openemu.js`](../desktop/lib/openemu.js)'s `fireKey`). That
is the single biggest gap between this and an actual "LDPlayer-class"
feel — no amount of monetization work changes that. The fix:

- Fetch scrcpy-server (Apache-2.0, redistributable) at setup time, same
  pattern as the Android SDK fetch.
- Push it over adb, open its video + control sockets, decode H.264 with
  `VideoDecoder` (WebCodecs) into a `<canvas>`, and forward
  pointer/keyboard events over the control socket instead of shelling out
  to `adb` per keystroke.
- Keep the screenshot path only as a fallback when scrcpy isn't
  available. This replaces the polling loop in `app.js` and the
  `fireKey`/tap paths in `openemu.js`, and is the change most worth
  prioritizing over any monetization work above.

## Phase D — Cross-platform control plane

The control plane (`android/bin/open-emu`, `android/lib/*.sh`) is bash.
That's fine for Linux/macOS but not Windows, which is most of this
product's actual target audience (LDPlayer/BlueStacks users are
overwhelmingly on Windows). Porting the control plane to a cross-platform
Node module (reusing the same `sdkmanager`/`avdmanager`/`emulator`/`adb`
binaries, which are cross-platform already) is the real unlock for a
Windows-first audience — more impactful than the `nsis` packaging target
already declared in `electron-builder.yml`, which only gets you an
installer for a Linux-only backend.

## Phase E — Stop depending on Google's SDK

Long-term: grow [`src/`](../src/)'s `open-vmm` toward a self-built
AOSP/android-x86 guest image. This is the only way to remove the Android
SDK License Agreement constraint entirely (see
[`docs/LEGAL.md`](LEGAL.md)) instead of working around it. Substantial —
bootloader, kernel, goldfish/virtio device support — and not a near-term
item, but worth tracking since every "fetch, don't bundle" design
decision upstream of it is a workaround for not having this yet.
