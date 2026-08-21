#!/usr/bin/env node
// Builds and validates the campaign manifest that the shipped app fetches.
//
//   node scripts/ads-manifest.mjs check                 # validate the source, print what would serve
//   node scripts/ads-manifest.mjs build                 # write the publishable manifest
//
// Validation runs through the *same parser the client uses* (dist/main/ads/manifest.js), so a
// campaign that survives `check` is a campaign that will serve. There is no second schema to keep
// in sync and no way for the two to disagree.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let parseManifest;
try {
  ({ parseManifest } = require(path.join(root, 'dist/main/ads/manifest.js')));
} catch {
  console.error('Build first: npm run build:main');
  process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0] ?? 'check';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const srcPath = path.resolve(root, flag('src', 'ads/campaigns.json'));
const outPath = path.resolve(root, flag('out', 'ads/public/v1/manifest.json'));

let source;
try {
  source = JSON.parse(readFileSync(srcPath, 'utf8'));
} catch (err) {
  console.error(`Cannot read ${path.relative(root, srcPath)}: ${err.message}`);
  console.error('Start from ads/campaigns.example.json.');
  process.exit(1);
}

const campaigns = Array.isArray(source) ? source : (source.campaigns ?? []);
const manifest = {
  version: 1,
  updatedAt: new Date().toISOString(),
  ttlSeconds: source.ttlSeconds ?? 3600,
  campaigns,
};

const { manifest: parsed, dropped } = parseManifest(manifest);

console.log(`source:   ${path.relative(root, srcPath)}`);
console.log(`accepted: ${parsed.campaigns.length} campaign(s)`);
for (const c of parsed.campaigns) {
  const affiliates = [...c.clickUrl.matchAll(/\{\{\s*affiliate:([^{}]*?)\s*\}\}/g)].map((m) => m[1]);
  const notes = [
    c.slots.join('+'),
    c.regions ? `geo:${c.regions.join('/')}` : null,
    affiliates.length ? `needs:${affiliates.join(',')}` : null,
    c.packageName ? `cpi:${c.packageName}` : null,
  ].filter(Boolean);
  console.log(`  ✓ ${c.id}  (${notes.join('  ')})`);
}

if (dropped.length > 0) {
  console.log(`rejected: ${dropped.length}`);
  for (const id of dropped) console.log(`  ✗ ${id}`);
}

if (command === 'check') {
  // A rejected campaign is a publishing mistake, not a warning — fail so CI catches it.
  process.exit(dropped.length > 0 ? 1 : 0);
}

if (command !== 'build') {
  console.error(`Unknown command "${command}". Use check or build.`);
  process.exit(1);
}

if (dropped.length > 0) {
  console.error('Refusing to build a manifest with rejected campaigns. Fix them first.');
  process.exit(1);
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`\nwrote ${path.relative(root, outPath)} — publish this directory as static files.`);
