# monetize/

The ad + license infrastructure described in
[`docs/MONETIZATION.md`](../docs/MONETIZATION.md). Two independent pieces:

```text
monetize/
  server/       Ad + license HTTP server (Node built-ins only, no deps)
  licensing/    Offline Ed25519 keypair + license issuance CLI tools
```

Nothing here runs automatically, and the desktop app ships with an empty
ad-server URL by default (see [`desktop/config/ads.json`](../desktop/config/ads.json))
— this is genuinely off until an operator deploys `server/` and points the
app at it.

## Running the server locally

```bash
cd monetize/server
node index.mjs                 # listens on :8787 by default
curl localhost:8787/v1/campaigns
curl localhost:8787/v1/report
```

No `npm install` needed — it's Node built-ins only. See
[`server/.env.example`](server/.env.example) for the two things worth
setting before exposing this to the internet (`CLICK_SIGNING_SECRET`,
`PORT`).

## Issuing a Pro license

```bash
node monetize/licensing/keygen.mjs                 # once per deployment — writes
                                                     # monetize/licensing/keys/ (gitignored)
                                                     # and desktop/config/license-public-key.json
node monetize/licensing/issue-license.mjs --email buyer@example.com
```

The printed license string is what a person pastes into the desktop app's
Activate field — [`desktop/lib/entitlement.js`](../desktop/lib/entitlement.js)
verifies it entirely offline against the public key baked in at
`desktop/config/license-public-key.json`. The server's own
`POST /v1/license/verify` endpoint does the same check remotely, useful for
a future support tool, but the app itself never needs to call it.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/campaigns` | Per-slot creatives with pre-signed click URLs. ETag-cached. |
| `POST` | `/v1/events` | Batched impression/click events. |
| `GET` | `/v1/click/:id?t=<token>` | Verifies the signed token, logs the click, 302s to the partner URL. |
| `POST` | `/v1/postback?partner=<name>` | HMAC-verified affiliate conversion postback. |
| `POST` | `/v1/license/verify` | Server-side license check (the client verifies offline instead). |
| `GET` | `/v1/report?days=30` | Impressions/clicks/CTR/estimated revenue per creative — the rate card. |

## Deploying

It's a single `node index.mjs` process behind any reverse proxy (nginx,
Caddy, Cloudflare) — no database, no build step. `data/` (event JSONL
files) and `licensing/keys/` are gitignored; back up `keys/` somewhere
safe, since losing the private key means re-issuing every outstanding
license under a new keypair (and updating
`desktop/config/license-public-key.json` in a new app release).
