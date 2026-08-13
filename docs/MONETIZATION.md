# Monetization — what's implemented and how it's used

**Current state: the code for all six options below exists and is wired
up, but ships off by default.** No repo clone or fresh install shows an
ad, calls an ad server, or enforces a paid tier until an operator
explicitly deploys [`monetize/server/`](../monetize/server/) and points
the app at it, and even then, a person has to accept the wizard's ads
consent step before anything renders. This document doubles as the
implementation map (what hooks into what) and the deployment guide
(what to turn on, in what order) — see [`docs/ROADMAP.md`](ROADMAP.md)
for what's still genuinely unbuilt (real checkout automation, a signed
public rate card).

## The two constraints that shaped the design

1. **No Google AdSense/Ad Manager inside the desktop app.** Google's ad
   placement policy is explicit: "Publishers are not permitted to
   distribute Google ads or AdSense for search boxes through software
   applications including, but not limited to ... desktop applications."
   The mobile-only "WebView API for Ads" doesn't cover desktop Electron
   apps either. This is why every in-app option below is self-served or a
   direct/affiliate integration through [`monetize/server/`](../monetize/server/)
   — never a Google tag loaded in a hidden webview. Programmatic Google
   ads are, however, fine on the **website** ([`web/`](../web/)), since
   that's an ordinary browser-served page — see `web/public/ads.js`.
2. **The Android SDK can't be bundled**, so monetization can't be tied to
   "faster setup" or "premium SDK access" — see [`docs/LEGAL.md`](LEGAL.md).
   Every option below is about the product experience around the
   emulator, never the SDK itself.

## The two constraints that shape every option

1. **No Google AdSense/Ad Manager inside the desktop app.** Google's ad
   placement policy is explicit: "Publishers are not permitted to
   distribute Google ads or AdSense for search boxes through software
   applications including, but not limited to ... desktop applications."
   The mobile-only "WebView API for Ads" doesn't cover desktop Electron
   apps either. This is why every in-app option below is either
   self-served or a direct/affiliate integration — never a Google tag
   loaded in a hidden webview. Programmatic Google ads are, however, fine
   on the **website** ([`web/`](../web/)), since that's an ordinary
   browser-served page.
2. **The Android SDK can't be bundled**, so any monetization tied to
   "faster setup" or "premium SDK access" is off the table — see
   [`docs/LEGAL.md`](LEGAL.md). Monetization has to be about the product
   experience around the emulator, not the SDK itself.

## Example 1 — Self-hosted native ad rail (house + direct + affiliate) — implemented

A **native**, non-web ad unit rendered from a JSON feed, not a
third-party script or iframe.

- **Server side ([`monetize/server/`](../monetize/server/)):**
  `GET /v1/campaigns` returns weighted creatives per slot with a
  pre-signed, per-creative click URL; `POST /v1/events` logs
  impressions/clicks with a hashed install id; `GET /v1/click/:id?t=token`
  verifies the signed token and 302-redirects for attribution;
  `GET /v1/report` aggregates impressions/CTR/estimated revenue. See
  [`monetize/README.md`](../monetize/README.md) for the full endpoint
  list and how to run it — end-to-end tested against a live instance via
  curl (campaigns, ETag 304s, click resolution, tamper rejection, events,
  postback, report).
- **Client side ([`desktop/lib/ads.js`](../desktop/lib/ads.js)):** fetches
  the feed with ETag caching, falls back to a bundled house config
  ([`desktop/config/ads.json`](../desktop/config/ads.json), `serverUrl`
  empty by default) when no server is configured or reachable, respects a
  per-slot session cap and a 24h dismiss window (the persistent rail is
  cap-exempt — see the comment in `ads.js` for why), and hard
  short-circuits to no ads at all on Pro tier or without explicit
  consent. Creatives are rendered via `textContent`/`img.src` only —
  never `innerHTML` — and clicks resolve through `oe:ads-click` →
  `shell.openExternal`, never loaded inside the trusted renderer.
- **Placements that never cover the guest screen:** a bottom rail and a
  boot-time interstitial in
  [`desktop/public/index.html`](../desktop/public/index.html), and the
  Game Center panel below.
- **Pros:** full control, no ad-network approval process, works from day
  one with just direct/affiliate deals. **Cons:** you are the ad sales
  team until volume justifies a network; low fill without direct deals.

## Example 2 — Affiliate / CPI offer wall ("Game Center") — implemented

A sidebar panel (`#panel-gamecenter` in `index.html`, populated by
`oe:ads-list` → `ads.js`'s `listCreativesForSlot("gamecenter")`) listing
other apps/games to install, cashback offers, or partner promos — the
actual core of how LDPlayer/BlueStacks monetize an emulator, more than
display ads. Each entry resolves through the same signed-click path as
Example 1; conversions come back via `POST /v1/postback`
(`monetize/server/lib/hmac.mjs`'s `verifyBodySignature`, HMAC over the
raw request body, one secret per partner in
[`monetize/server/config/partners.json`](../monetize/server/config/partners.json)).
No separate infrastructure from Example 1 — same server, same client.

## Example 3 — Sponsored boot interstitial — implemented

A single direct-sold placement (`#boot-ad` in `index.html`, shown via
`app.js`'s `showBootAd()`) while an instance cold-boots. `GET /v1/report`
gives the impressions/CTR/estimated-revenue numbers to sell this slot
from once there's real traffic.

## Example 4 — Free/Pro tiers — implemented

- **Free:** capped at 2 concurrent running instances (enforced in
  [`desktop/lib/openemu.js`](../desktop/lib/openemu.js)'s `start()` via
  `entitlement.assertCanStartInstance`), ads shown per Example 1.
- **Pro:** no ads, uncapped instances.
- **Mechanics ([`desktop/lib/entitlement.js`](../desktop/lib/entitlement.js)):**
  a license string is a base64url-encoded `{payload, signature}` object,
  verified fully offline with `node:crypto`'s Ed25519 `verify()` against
  the public key baked into
  [`desktop/config/license-public-key.json`](../desktop/config/license-public-key.json)
  at build time. [`monetize/licensing/keygen.mjs`](../monetize/licensing/keygen.mjs)
  generates the keypair (private half gitignored, never committed);
  [`monetize/licensing/issue-license.mjs`](../monetize/licensing/issue-license.mjs)
  issues a key by hand after a sale, standing in for a real checkout
  webhook until one exists (see ROADMAP). No account system or
  server-side session — Pro keeps working even if `monetize/server`
  disappears entirely. Verified directly: activation, tamper rejection,
  expiry, and deactivation all round-trip correctly (see the commit that
  introduced this file for the exact test transcript).
- **Pros:** recurring revenue, doesn't depend on ad fill or CPMs.
  **Cons:** still needs real checkout automation (Stripe/Paddle) to not
  require a manual key-issuing step per sale — see ROADMAP.

## Example 5 — Rewarded unlock — implemented

"Watch a 30-second sponsor spot to unlock a 3rd instance for today,"
exposed as the rewarded card in the Game Center panel and as the
fallback offered when `openemu.js` blocks a 3rd concurrent start on free
tier. `desktop/lib/entitlement.js`'s `grantRewardedUnlock(hours)` sets a
temporary expiring bonus slot; `ads.js`'s click resolver
(`open-emulator://reward/instance-slot`) is what triggers it. No separate
sponsor-video infrastructure exists yet — the current house creative is
explicitly labeled "no real sponsor spot wired up yet" so this isn't
mistaken for something it's not.

## Example 6 — Website display ads + affiliate content (policy-clean, separate surface) — implemented

The **only** place standard AdSense/Ad Manager tags are actually allowed.
[`web/public/ads.js`](../web/public/ads.js) loads a standard AdSense unit
into a site-wide slot, gated on both a real publisher id in
`web/public/ad-config.json` (empty by default) and the consent banner
(`web/public/consent.js`) being accepted. The `/games/<slug>` SEO template
([`web/pages/games-example.html`](../web/pages/games-example.html), via
`web/public/game-offers.js`) pulls a sponsored offer from the same
`monetize/server` the desktop app's Game Center uses — one ad server, two
surfaces. Adding more SEO pages is mechanical: write a fragment in
`web/pages/`, add a `web/pages.json` entry, rebuild. This is where most of
the *traffic-driven* revenue in this space typically comes from (organic
search into a landing page), not from the app itself.

## Turning it on

1. Deploy [`monetize/server/`](../monetize/server/) somewhere reachable
   (`node index.mjs` behind any reverse proxy — no build step, no
   database). Set a real `CLICK_SIGNING_SECRET`.
2. Run `node monetize/licensing/keygen.mjs` once to generate the license
   keypair (this also writes the public half into
   `desktop/config/license-public-key.json` for the next build).
3. Point `desktop/config/ads.json`'s `serverUrl` at the deployed server.
4. Fill in real campaigns in `monetize/server/config/campaigns.json`
   (direct-sold or affiliate) and real partner secrets in
   `monetize/server/config/partners.json`.
5. Issue Pro keys by hand with `monetize/licensing/issue-license.mjs`
   until real checkout automation exists (see ROADMAP).
6. Watch `GET /v1/report` — that's the rate card. Impressions × slot
   position tells you what a direct sponsor's boot-interstitial or rail
   placement is actually worth once there's real traffic; nothing here
   fabricates numbers to sell from before that traffic exists.

## What none of this should ever do

- Never put a third-party `<iframe>`, remote script, or unsandboxed HTML
  blob inside the Electron renderer — that's both an AdSense policy
  violation waiting to happen and a real security surface (remote code
  effectively running with access to `window.oe`'s IPC bridge). Creatives
  are data (JSON), rendered by code in this repo, always.
- Never cover, delay, or gate the guest screen itself behind an ad —
  every placement above is a rail, a panel, or a boot-time interstitial
  shown before the guest is interactive, not a wall in front of it.
- Never ship telemetry/ad event collection without updating
  [`docs/PRIVACY.md`](PRIVACY.md) and the consent step this would add to
  the wizard *first*.
