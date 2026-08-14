# Roadmap

Status snapshot, then what's next, roughly in the order it makes sense to
build it. Nothing below is time-estimated in calendar terms — the notes
describe which subsystems change and how invasive each is instead.

## Shipped so far

- Native Electron shell: mint sidebar, top tab bar over isolated AVD
  instances, themed first-run wizard (host check → **explicit Android SDK
  license acceptance** → SDK fetch → first machine → optional shortcut →
  **ads/telemetry consent**).
- Real multi-instance isolation (`android/lib/instances.sh`): independent
  userdata, sdcard, console/adb ports per named machine.
- Packageable build: [`desktop/lib/paths.js`](../desktop/lib/paths.js)
  splits code from mutable data so a packaged install's SDK/AVD/state/logs
  live in the OS's per-user data dir, not inside a read-only install.
  [`desktop/electron-builder.yml`](../desktop/electron-builder.yml) builds
  a real AppImage/deb today (verified), with nsis/dmg targets declared for
  CI and `electron-updater` wired for update *checks* (`autoDownload`
  off — see Phase A).
- Marketing/download site ([`web/`](../web/)): static, zero-dependency,
  now including `/pricing/`, a `/games/<slug>` SEO template, `/press/`,
  and a working cookie-consent-gated ad slot.
- Legal groundwork: [`LICENSE`](../LICENSE) (Apache-2.0),
  [`docs/EULA.md`](EULA.md), [`docs/PRIVACY.md`](PRIVACY.md),
  [`docs/NOTICES.md`](NOTICES.md), [`docs/LEGAL.md`](LEGAL.md).
- **Monetization is implemented, off by default.** See
  [`docs/MONETIZATION.md`](MONETIZATION.md) for the full map:
  [`monetize/server/`](../monetize/server/) (ad + license server, Node
  built-ins only, end-to-end tested against a live instance),
  [`desktop/lib/entitlement.js`](../desktop/lib/entitlement.js) (offline
  Ed25519 license verification, free/Pro tiers), and
  [`desktop/lib/ads.js`](../desktop/lib/ads.js) plus the rail/boot/Game
  Center/modal placements in `desktop/public/`. A fresh clone makes zero
  ad-server network calls and shows zero ads until an operator deploys
  the server and a person accepts the consent step.
- **Live screen mirroring is implemented** —
  [`desktop/lib/mirror.js`](../desktop/lib/mirror.js) speaks scrcpy's real
  wire protocol (verified with unit tests against hand-derived expected
  bytes for every control-message type and the video frame demuxer,
  including simulated TCP fragmentation; the real scrcpy-server v4.1
  binary downloads and checksum-verifies correctly; a real H.264 clip
  decodes and renders through the exact WebCodecs path used here). What
  is **not** yet verified: a live end-to-end run against a real booted
  emulator, since this sandbox has no system image or `adb` installed —
  see "Verifying live mirroring" below for the one remaining step.
- **Fast boot (KVM snapshot, target ≤30s)** —
  [`android/lib/boot.sh`](../android/lib/boot.sh) is the shared launch
  path for both `open-emu start` and `open-emu instance start`. Isolated
  machines used to pass `-no-snapshot-load` on every launch, which made
  the provisioned `booted` snapshot dead code. Snapshot restore is now
  the default on a usable `/dev/kvm` when cores/RAM/GPU have not changed;
  `config.ini` is left alone when those already match; software GL is
  `swiftshader_indirect`; headless starts pass `-no-audio`. TCG still
  cold-boots (~3 min) and relies on warm process reuse. Helper logic is
  covered by `make android-test`. A live ≤30s number still needs a KVM
  host with a real system image — see [`docs/BOOT.md`](BOOT.md).

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

## Phase B — What's left for monetization

The plumbing (Examples 1-6 in [`docs/MONETIZATION.md`](MONETIZATION.md))
is done; what remains is operating it:

1. **Real checkout automation.** `monetize/licensing/issue-license.mjs`
   is a manual CLI standing in for a Stripe/Paddle webhook. Wiring an
   actual `checkout.session.completed` (or equivalent) webhook to call
   the same `issue-license.mjs` logic removes the manual step per sale.
   No endpoint for this exists in `monetize/server/` yet — it's a
   deliberate gap, not an oversight (see MONETIZATION.md's constraints).
2. **Real campaigns.** `monetize/server/config/campaigns.json` ships
   house-only creatives. Direct deals or an affiliate network account are
   what actually put revenue-bearing entries in there.
3. **A rewarded-video source.** The rewarded-unlock creative is
   explicitly a placeholder ("no real sponsor spot wired up yet"). A real
   version needs either a direct sponsor willing to supply a short clip
   asset, or a desktop-compatible rewarded-ad network (rare; most
   rewarded-video SDKs target mobile only).
4. **SEO content volume.** `web/pages/games-example.html` is one template
   instance. Writing more `/games/<slug>` pages is mechanical (manifest
   entry + fragment) but is a content task, not a code one.

## Phase C — Verifying live mirroring end to end

[`desktop/lib/mirror.js`](../desktop/lib/mirror.js)'s protocol layer
(control-message encoding, video frame demuxing) is unit-tested against
byte-exact expected output and a real, checksum-verified scrcpy-server
binary downloads correctly. The WebCodecs decode path is proven against a
real H.264 clip end to end (decoded and rendered through the exact same
`VideoDecoder`/canvas code this app uses). The one thing that could not be
exercised here: a live run against a **real booted emulator**, because
this sandbox has no system image or `adb` binary installed (only a bare
`emulator` binary with no AVD backing it). Before relying on this in
production:

1. `make android-fetch && make android-setup && make android-provision`
   on a machine with `/dev/kvm` (TCG hosts can't reliably load Emulator
   snapshots at all — see [`android/README.md`](../android/README.md) —
   so mirroring should be validated on KVM first).
2. Start a machine, click the sidebar's "Live" toggle, and confirm: the
   canvas shows a moving picture (not just one static frame — proves
   delta-frame decoding, not just the keyframe path this environment
   could test), and clicking/typing on the canvas actually reaches the
   guest (proves the control-socket path, which had zero live coverage
   here).
3. If frames stall or the decoder errors, the likely culprits, in order:
   a codec-string mismatch (log the derived `avc1.xxxxxx` string and
   compare against what a real scrcpy client negotiates for the same
   device), a dropped config packet (the keyframe-prepend logic in
   `app.js`'s `onMirrorEvent` depends on having seen exactly one config
   packet before the first keyframe), or an adb reverse binding that
   didn't clean up from a previous run (`adb reverse --list`).

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
