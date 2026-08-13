#!/usr/bin/env node
// Zero-dependency static site builder: pages/*.html fragments get dropped
// into layout.html's {{CONTENT}} slot and written to dist/<slug>/index.html.
// Run: node web/build.mjs [--serve[=PORT]]
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const WEB = __dirname;
const DIST = path.join(WEB, "dist");

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : ""));
}

function urlFor(slug) {
  return slug ? `/${slug}/` : "/";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function build() {
  const manifest = JSON.parse(readFileSync(path.join(WEB, "pages.json"), "utf8"));
  const layout = readFileSync(path.join(WEB, "layout.html"), "utf8");

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  cpSync(path.join(WEB, "public"), DIST, { recursive: true });
  cpSync(path.join(REPO_ROOT, "brand"), path.join(DIST, "brand"), { recursive: true });

  const nav = manifest.pages
    .filter((page) => page.nav)
    .map((page) => `<a href="${urlFor(page.slug)}">${escapeHtml(page.navLabel || page.title)}</a>`)
    .join("\n          ");

  for (const page of manifest.pages) {
    const body = readFileSync(path.join(WEB, "pages", page.file), "utf8");
    const html = render(layout, {
      TITLE: escapeHtml(page.title),
      DESCRIPTION: escapeHtml(page.description),
      CONTENT: body,
      NAV: nav
    });
    const outDir = page.slug ? path.join(DIST, page.slug) : DIST;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "index.html"), html);
    console.log(`built ${urlFor(page.slug)}`);
  }

  // 404 fallback used by the tiny dev server below and by static hosts
  // (Netlify/Vercel/GitHub Pages) that look for a top-level 404.html.
  if (existsSync(path.join(WEB, "pages", "404.html"))) {
    const body = readFileSync(path.join(WEB, "pages", "404.html"), "utf8");
    writeFileSync(
      path.join(DIST, "404.html"),
      render(layout, { TITLE: "Not found — open-emulator", DESCRIPTION: "", CONTENT: body, NAV: nav })
    );
  }

  console.log(`\n${manifest.pages.length} pages -> ${path.relative(REPO_ROOT, DIST)}/`);
}

function serve(port) {
  const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split("?")[0]);
    if (reqPath.endsWith("/")) reqPath += "index.html";
    let filePath = path.join(DIST, reqPath);
    if (!existsSync(filePath) && !path.extname(filePath)) {
      filePath = path.join(DIST, reqPath, "index.html");
    }
    let status = 200;
    if (!existsSync(filePath)) {
      filePath = path.join(DIST, "404.html");
      status = 404;
    }
    if (!existsSync(filePath)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(status, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(readFileSync(filePath));
  });
  server.listen(port, () => console.log(`serving ${DIST} on http://localhost:${port}`));
}

build();

const serveArg = process.argv.find((arg) => arg.startsWith("--serve"));
if (serveArg) {
  const port = Number(serveArg.split("=")[1]) || 8080;
  serve(port);
}
