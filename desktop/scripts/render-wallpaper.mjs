// Writes build/wallpaper-preview.png from the compiled wallpaper renderer.
//
// Run after `npx tsc -p tsconfig.json`. The renderer stays pure Node; this script only
// loads it and times one call.

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { renderWallpaper } = require('../dist/main/rom/wallpaper.js');

const started = process.hrtime.bigint();
const png = renderWallpaper();
const ms = Number(process.hrtime.bigint() - started) / 1e6;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, 'build', 'wallpaper-preview.png');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, png);
console.log(`wrote ${dest} (${png.length} bytes, ${ms.toFixed(1)} ms)`);
