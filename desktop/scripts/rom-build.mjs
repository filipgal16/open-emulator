#!/usr/bin/env node
// Builds open-emulator Android — the `openemu` ROM — from the downloaded stock image, exactly as the
// app does on first run. See design/openemu-rom.md.
//
//   npm run rom:build              build if missing or out of date
//   npm run rom:build -- --force   rebuild from the stock image regardless
//
// Runs against the compiled output; the npm script compiles first.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => require(path.join(here, '..', 'dist', 'main', rel));

const { createSdkLayout } = dist('engine/sdk/layout.js');
const { nativeRoot } = dist('engine/factory.js');
const { findQemuPid } = dist('engine/sdk/find-process.js');
const { loadProfile } = dist('engine/env-file.js');
const { buildRom, romKeyDir } = dist('rom/builder.js');

const force = process.argv.includes('--force');
const layout = createSdkLayout(nativeRoot(process.env.OPEN_EMULATOR_DOWNLOAD_ROOT ?? null));
const profile = loadProfile(path.join(here, '..', '..', 'android'), 'openemu');

const started = Date.now();
buildRom({
  sdkRoot: layout.sdkRoot,
  keyDir: romKeyDir(layout),
  force,
  isRunning: async () => (await findQemuPid(profile.avdName)) !== null,
  onLog: (line) => console.log(line),
})
  .then(({ manifest, imageDir, skipped }) => {
    console.log(`\n${skipped ? 'already up to date' : 'built'} in ${((Date.now() - started) / 1000).toFixed(1)}s — ${imageDir}`);
    console.log(`  ROM id ${manifest.romId}`);
    for (const [name, v] of Object.entries(manifest.volumes)) {
      console.log(
        `  ${name.padEnd(10)} removed ${String(v.removed.length).padStart(2)}  freed ${String(v.blocksFreed).padStart(6)} blocks` +
          `  props ${String(v.propsChanged.length).padStart(2)}  added ${v.created.length}  free now ${v.freeBlocks} blocks / ${v.freeInodes} inodes`,
      );
    }
  })
  .catch((err) => {
    console.error(`build failed: ${err.message}`);
    process.exit(1);
  });
