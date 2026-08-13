# Monetization — examples and a plan, not yet implemented

**Current state: this product ships with zero ads and zero monetization
code.** No ad server, no ad rendering, no license/entitlement checks, no
paid tier. This document is deliberately forward-looking — it exists so
the next pass has a concrete menu to choose from instead of starting from
a blank page, and so nothing here gets mistaken for something already
wired up. Every code reference below describes a **future file that does
not exist yet**, not something shipping today.

For the "next steps" sequencing and effort/risk breakdown, see
[`docs/ROADMAP.md`](ROADMAP.md). This file is about *what the options are*
and *how each would technically hook in*.

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

## Example 1 — Self-hosted native ad rail (house + direct + affiliate)

The most LDPlayer/BlueStacks-like option, and the one with a working
reference to start from: a **native**, non-web ad unit rendered from your
own JSON feed, not a third-party script or iframe.

- **Server side (future `monetize/server/`):** `GET /v1/campaigns` returns
  weighted creatives (`title`, `body`, `imageUrl`, `cta`, `url`, `weight`);
  `POST /v1/events` logs impressions/clicks with a hashed install id;
  `GET /v1/click/:id` 302-redirects through a signed URL for attribution.
- **Client side (future `desktop/lib/ads.js`):** fetch the feed, cache
  with an ETag, respect frequency caps and a "remind me later" dismiss
  window, render creatives as plain DOM (title/image/CTA — never raw HTML
  or a `<webview>`), and open clicks with `shell.openExternal` so nothing
  loads inside the trusted renderer.
- **There's already a rough version of this** on the `cursor/ldplayer-parity-02a9`
  branch (`desktop/lib/ads.js` + `android/config/ads.json` in that branch's
  history) — a weighted campaign picker, a dismiss-until timestamp, and a
  local impression/click log. It's a reasonable starting skeleton, not
  something to merge as-is: it has no server, no consent gate, and no Pro
  bypass.
- **Placements that don't cover the guest screen:** a bottom rail in
  [`desktop/public/index.html`](../desktop/public/index.html), a boot
  interstitial (shown only while an instance is cold-booting — genuinely
  idle time, and the highest-attention placement since the user is
  waiting), and a "Game Center" sidebar panel of affiliate/CPI offers next
  to the existing `data-panel` tabs.
- **Pros:** full control, no ad-network approval process, works from day
  one with just direct/affiliate deals. **Cons:** you are the ad sales
  team until volume justifies a network; low fill without direct deals.

## Example 2 — Affiliate / CPI offer wall ("Game Center")

A dedicated sidebar panel listing other apps/games to install, cashback
offers, or partner promos — the actual core of how LDPlayer/BlueStacks
monetize an emulator, more than display ads. Each entry is a signed
redirect (`/v1/click/:id?subid=<hashed-install-id>`) so the affiliate
network can attribute installs back with a postback
(`POST /v1/postback`, HMAC-verified). This reuses the Example 1 server
and just adds an offer-list content type instead of banner creatives —
no separate infrastructure. eCPMs in this category are typically far
higher than passive display, but volume (active installs) is what makes
a network deal worth pursuing in the first place.

## Example 3 — Sponsored boot interstitial

A single direct-sold placement shown while an instance cold-boots (which
today takes on the order of a minute or more without KVM — see
[`android/README.md`](../android/README.md)'s performance table). No ad
network needed: this is something you'd sell directly once
`GET /v1/report` (impressions, CTR, an eCPM estimate) gives you a rate
card to sell from. Simplest to build (it's Example 1's rendering code with
one more slot), but depends on having enough daily active installs to be
worth a sponsor's time.

## Example 4 — Free/Pro tiers (not ads, but the usual complement)

- **Free:** capped at 2 concurrent running instances, ads shown per
  Example 1.
- **Pro (subscription or one-time unlock):** no ads, uncapped instances,
  maybe priority access to new features.
- **Mechanics:** a future `desktop/lib/entitlement.js` verifies an
  Ed25519-signed license key offline (keypair generated once, public key
  baked into the client, private key never leaves the server that issues
  keys after a Stripe/Paddle checkout on the website). No account system
  or server-side session needed — just "does this key verify," which also
  means it keeps working if the license server is ever down.
- **Pros:** recurring revenue, doesn't depend on ad fill or CPMs.
  **Cons:** needs a payment processor integration and a key-issuing
  service; conversion rates for a still-unsigned, early-access desktop
  app will be low until trust/polish catches up.

## Example 5 — Rewarded unlock

"Watch a 30-second sponsor spot to unlock a 3rd instance for today." A
bridge between Examples 1 and 4: monetizes the free tier while making the
Pro pitch concrete (this is literally what Pro removes). Technically it's
Example 1's creative renderer plus a timer and a temporary entitlement
grant — no new infrastructure, just a new consumption flow.

## Example 6 — Website display ads + affiliate content (policy-clean, separate surface)

The **only** place standard AdSense/Ad Manager tags are actually allowed.
[`web/`](../web/) is already structured for this: `web/pages.json` is a
manifest of static pages, so adding SEO-oriented "Play `<App>` on PC"
content pages (each with a download CTA and, optionally, an affiliate
link) is mechanical — write a fragment in `web/pages/`, add a manifest
entry, rebuild. This is where most of the *traffic-driven* revenue in this
space typically comes from (organic search into a landing page), not from
the app itself.

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
