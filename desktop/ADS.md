# Ads

Monetization for the desktop shell. **Off unless explicitly configured** — a source checkout, a
fork, or a distro package ships no ads and renders no ad markup at all.

Only the Electron shell is involved. Nothing here touches `open-vmm` or the guest.

## Turning it on

```bash
cp desktop/ads.config.example.json desktop/ads.config.json   # gitignored
# set "enabled": true, then fill in the sections you have accounts for
```

For development, skip the file entirely:

```bash
OPEN_EMULATOR_ADS=1 npm run dev    # force on, house inventory only
OPEN_EMULATOR_ADS=0 npm run dev    # force off, overrides the config file
```

## What's wired to what

| You provide | In `ads.config.json` | Turns on |
|---|---|---|
| nothing | — | House ads (project promotion) |
| Affiliate program ids | `affiliates` + `manifestUrl` | Paid affiliate and CPI campaigns |
| An ad network's tag | `network.provider` + `network.tagHtml` | Third-party fill, plus the consent prompt |
| A licence keypair | `entitlement.publicKey` | Paid remove-ads |

## How a fill works

```
renderer  AdSlot ──ads:tag-plan──▶ third-party tag in an isolated view?
                                   └─ paints nothing within timeoutMs ──┐
                                                                        ▼
                  ──ads:request(slot)──▶ main  AdService
                                              ├─ 1. OfferProvider   affiliate + CPI, from manifest
                                              └─ 2. HouseProvider   always fills (inline slots)
                                              │
          Creative ◀───────────────────────────┘   (no URL in it)
             │
             ├─ viewable 1s ──ads:impression(token)──▶ frequency cap += 1
             └─ clicked ──────ads:click(token)───────▶ shell.openExternal(https url)
                                                       └─ CPI campaign? arm install attribution
```

Providers are consulted in registration order and the first fill wins, so the array built in
`src/main/ads/index.ts` *is* the monetization priority. A provider that returns null is normal; one
that throws is skipped so a partner outage can't blank a slot the house ad would have filled.

## Invariants

These are load-bearing. Breaking any of them is a security or revenue regression, not a style change.

- **No remote origin loads in the app window.** The main process fetches manifests and creative art,
  caches art to disk, and serves it back over the `oe-ad://` scheme. The renderer's CSP is
  `default-src 'self'` with `connect-src 'none'` — it issues no network request of its own and
  cannot be fingerprinted by an ad host.
- **The renderer never receives a destination URL.** It gets an opaque `token`; the main process
  resolves it. A compromised renderer can't turn the ad path into an open-any-URL primitive.
- **https only, checked twice.** At manifest-parse time and again at click time. A placeholder
  cannot smuggle a scheme past validation (there's a test for exactly that).
- **Creative art is sniffed, not trusted.** `Content-Type` is ignored; magic bytes decide. A CDN
  that labels a script `image/png` gets refused.
- **Third-party tags are fully isolated.** Own session partition, no preload, sandboxed, no bridge
  back to the app. Fill detection is a main-process DOM measurement, so no API is exposed to
  partner script at all.
- **Impressions count on viewability, not on fill.** Window focused, slot ≥50% on screen, held for
  one second. Unviewable impressions get clawed back as invalid traffic.
- **The guest's screen is never covered.** Shell chrome is monetizable; the emulated display is not.
- **Package names are allowlisted, not escaped.** They cross into WSL and then `adb shell`; an
  allowlist is the only defence that survives three layers of quoting.

## Slots

| Slot | Where | Rotation | House floor |
|------|-------|----------|-------------|
| `wizard-footer` | Setup wizard, during the SDK fetch and AVD provision | 30 s | yes |
| `rail` | Beside the mirrored Android screen | 45 s | yes |
| `boot-interstitial` | Over the boot wait; skip at 5 s, auto-dismiss on first frame | never | **no** |
| `library-tile` | Spliced into the app library grid | 120 s | yes |

`houseFloor: false` on the interstitial is deliberate. Inline slots have already reserved their
space, so a house ad there costs nothing. An interstitial that appears on every boot to promote our
own GitHub is pure annoyance at zero revenue — it only shows up when paid demand exists.

Add a slot in `src/shared/ads-types.ts` (`SLOTS`), then render `<AdSlot slot="…" />`. A slot that
declares a house floor but has no house inventory fails the test suite.

## Campaigns

Live campaigns are a static JSON manifest — no ad server to run.

```bash
cp ads/campaigns.example.json ads/campaigns.json   # gitignored
npm run ads:check                                  # validate; prints what would serve
npm run ads:build                                  # writes ads/public/v1/manifest.json
```

Publish `ads/public/` as static files (Cloudflare Pages, GitHub Pages) and point `manifestUrl` at
it. `ads:check` runs the **same parser the client uses**, so a campaign that passes is a campaign
that will serve — there is no second schema to keep in sync.

Click and conversion URLs support `{{affiliate:slug}}`, `{{subid}}`, `{{campaign}}`, `{{slot}}`.
An unresolved placeholder skips the campaign rather than sending untracked traffic that earns
nothing.

`{{subid}}` is `oe-<campaign>-<slot>-<YYYYMMDD>`. There is **no per-install or per-user identifier
in it** — campaign, slot and date are all a network needs to attribute a conversion, and none of it
identifies a person. That is what keeps the affiliate path free of consent obligations.

## Consent

`resolveConsent()` returns `not-required` unless a third-party tag is actually configured. Native
creatives set no cookies, transmit no identifier, and derive region from the OS locale rather than
an IP lookup, so there is nothing to consent to.

When a tag *is* configured, EEA/UK/CH (and unknown region) get a prompt before it loads. Declining
disables the tag rung only — affiliate and house ads keep running, because they never needed
consent. Refusing is not a revenue cliff.

## Remove-ads licences

Verified offline with an Ed25519 signature. No licence server, no activation call, nothing to host.

```bash
npm run ads:keygen                                  # once; writes ads-license-private.pem
node scripts/ads-license.mjs issue --sub "order_1"  # per sale; send the key to the customer
```

Paste the printed public key into `entitlement.publicKey`. Keep the private key safe — anyone
holding it can mint licences. This is anti-casual-copying, not anti-tamper: someone determined can
patch the check out of an open-source Electron app, and pretending otherwise would mean building
DRM that punishes legitimate users to slightly inconvenience the rest.

## Install attribution (CPI)

A sponsored campaign with `packageName` + `conversionUrl` arms attribution on click. The guest's
installed package list is polled (only while something is pending — each poll costs an adb round
trip), and when the package appears the postback fires once. The package list is read locally,
matched locally, and discarded; only the campaign's own conversion URL leaves the machine.

## State

Under `app.getPath('userData')`:

| File | Holds |
|---|---|
| `ads-frequency.json` | Per-campaign daily counts. 12/campaign/day, 5 min between repeats. |
| `ads-prefs.json` | Opt-out, consent answer, licence key. |
| `ads-attribution.json` | Pending and credited sponsored installs. |
| `ads-manifest.json` | Cached campaigns. Served through outages, expired after 7 days. |
| `ads-creatives/` | Downloaded art, keyed by URL hash. |

The ✕ on any slot opts out immediately and permanently, with no confirmation step.

## Tests

```bash
npm test        # builds dist/main, then node --test
```

The ad core imports no electron, which is what lets `node --test` exercise it directly against the
compiled output with no harness and no extra dependencies. Keep it that way — `src/main/ads/index.ts`
is the only file in `ads/` allowed to import electron.

## Not implemented, deliberately

Ads over the running Android screen; injection into guest apps; decoy close buttons; background
impression counting; creatives styled as system dialogs; any per-user identifier. Each one
terminates an ad account for policy violation, and an emulator is software people install
specifically because they trust it isn't adware.

AdSense is not an option — its terms prohibit app-wrapper and non-browser inventory, and Electron is
squarely that.

## Known gap

The third-party tag path (`network-tag-host.ts`) is built and isolated but has never been run
against a real ad network tag, because that needs an account. Expect to validate rendering,
click-through, and the fill probe's area threshold against the first real tag.
