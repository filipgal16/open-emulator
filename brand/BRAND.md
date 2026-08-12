# open-emulator brand

Mint identity for the **host-side** product surfaces (desktop shell, docs, CLI
chrome). The Android guest UI stays stock Android — this brand wraps everything
around it.

## Personality

Fresh, precise, open. Feels like cool air through a leaf canopy — calm enough
to live in all day, sharp enough for a developer tool.

## Name & voice

| Use | Form |
|-----|------|
| Product | `open-emulator` |
| Short | `OE` |
| Mark text | `oe` (lowercase in the monogram) |
| Tagline | Run Android openly. Control it in mint. |

Voice: direct, lowercase-friendly, no hype adjectives. Prefer “start”,
“install”, “keymap” over marketing fluff.

## Color

Primary family is **mint leaf** on a cool paper ground. Never default purple,
terracotta cream, or neon cyber-glow.

| Token | Hex | Role |
|-------|-----|------|
| `mint-500` | `#26B87A` | Primary actions, focus |
| `mint-300` | `#7FDCB3` | Soft fills, highlights |
| `mint-800` | `#115C42` | Deep brand ink accents |
| `ink` | `#0B241C` | Body text |
| `paper` | `#F4FBF8` | App canvas |
| `danger` | `#C23B52` | Destructive only |

Atmosphere: soft mint radial washes + a faint leaf-grid pattern — not a flat
fill, not a dark void.

## Typography

| Role | Family | Notes |
|------|--------|-------|
| Brand / display | **Fraunces** | Soft optical serif; wordmarks & hero titles |
| UI | **Sora** | Geometric sans for controls & body |
| Mono / logs | **IBM Plex Mono** | Status, shell output |

Weights: Fraunces 600–700 for brand; Sora 400/500/600 for UI. Avoid Inter,
Roboto, Arial, and system-ui as the primary face.

## Logo

Files live in `brand/logo/`:

- `mark.svg` — leaf-device monogram (preferred app icon / favicon source)
- `wordmark.svg` — mark + “open-emulator”
- `lockup-horizontal.svg` — wide lockup for headers
- `app-icon.svg` — rounded square for desktop/Electron

Clear space: at least half the mark width on all sides. Do not recolor the
leaf gradient to non-mint hues. On dark photography, use the inverted
wordmark (`wordmark-on-dark.svg`).

## UI rules (host shell)

1. Brand is visible in the first viewport without relying on nav alone.
2. Interaction surfaces may use soft panels; decorative “card stacks” are not
   the visual idea — the mint atmosphere and live Android preview are.
3. One primary CTA per view region (usually mint-filled).
4. Motion is sparse: brand mark breath, panel enter, status pulse — no glow
   storms or bouncing pills.
5. Ads, if present, sit in a quiet footer rail and never cover the guest
   screen.

## Non-goals

- Re-skinning Android system UI
- Purple/indigo gradient themes
- Heavy glassmorphism or multi-layer drop shadows
