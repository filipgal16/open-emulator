# open-emulator marketing site

Zero-dependency static site: HTML fragments in `pages/` get dropped into
`layout.html`'s `{{CONTENT}}` slot and written to `dist/<slug>/index.html`.
No build tooling beyond Node's own `fs`/`http`.

```bash
node build.mjs                # build into dist/
node build.mjs --serve=8080   # build, then serve dist/ locally
```

`make web` from the repo root does the same build step.

## Layout

```text
web/
  layout.html     shared <head>, header, footer — {{TITLE}}/{{DESCRIPTION}}/{{CONTENT}}/{{NAV}}
  pages.json      page manifest (slug, source file, title, description, nav visibility)
  pages/*.html    per-page body fragments (no <html>/<head>, just content)
  public/         site-specific static assets, copied into dist/ as-is
  dist/           generated output (gitignored) — deploy this directory
```

`brand/` at the repo root (colors, fonts, logo) is copied into `dist/brand/`
at build time — it's the same source of truth the desktop app uses, not a
separate copy to keep in sync by hand.

## Adding a page

1. Add a fragment to `pages/your-page.html` (just the body content).
2. Add an entry to `pages.json` with a `slug` (`""` for the homepage,
   `"foo/bar"` for `/foo/bar/`), the fragment's `file`, `title`,
   `description`, and whether it belongs in the header nav.
3. Rebuild.

## Deploying

`dist/` is a plain static site — any static host works (GitHub Pages,
Netlify, Vercel, S3+CloudFront, nginx). `dist/updates/releases.json`
doubles as the desktop app's update-check feed; point
`desktop/config/update.json`'s `feedUrl` at wherever you deploy it.
