#!/usr/bin/env node
// Builds one of open-emulator's Android ROMs from the downloaded stock image, exactly as the app
// does on first run. See design/openemu-rom.md.
//
//   npm run rom:build                               build `openemu` if missing or out of date
//   npm run rom:build -- --force                    rebuild from the stock image regardless
//   npm run rom:build -- --recipe openemu-compat    build the Google APIs ROM instead
//   npm run rom:build -- --recipe openemu-compat --cores 6
//                                                   …for a guest started with 6 cores (default:
//                                                   what the engine would give it on this machine)
//
// Runs against the compiled output; the npm script compiles first.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => require(path.join(here, '..', 'dist', 'main', rel));

const { createSdkLayout } = dist('engine/sdk/layout.js');
const { nativeRoot } = dist('engine/factory.js');
const { findQemuPid } = dist('engine/sdk/find-process.js');
const { tuneForHost } = dist('engine/sdk/host.js');
const { loadProfile } = dist('engine/env-file.js');
const { buildRom, romKeyDir } = dist('rom/builder.js');
const { ROM_RECIPES, recipeById } = dist('rom/recipes.js');

const args = process.argv.slice(2);
/** The value after `--name`, or null. A flag given without one is an error, not a silent default. */
function option(name) {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return null;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const force = args.includes('--force');
const recipeId = option('recipe') ?? 'openemu';
const recipe = recipeById(recipeId);
if (!recipe) {
  console.error(`unknown recipe '${recipeId}' — this build knows: ${Object.keys(ROM_RECIPES).join(', ')}`);
  process.exit(2);
}

// The same number the engine starts the guest with, so a ROM built by hand is the one the app
// would have built. The CLI cannot probe the hypervisor, so it assumes the accelerated case.
const coresArg = option('cores');
const cores = coresArg !== null
  ? Number(coresArg)
  : tuneForHost({ cpus: os.cpus().length, totalRamMb: Math.round(os.totalmem() / 1048576), accelerated: true, hasWindow: true }).cores;

const layout = createSdkLayout(nativeRoot(process.env.OPEN_EMULATOR_DOWNLOAD_ROOT ?? null));
// The profile of the same name carries the AVD whose emulator must not be running.
const profile = loadProfile(path.join(here, '..', '..', 'android'), recipe.id);

const started = Date.now();
buildRom({
  sdkRoot: layout.sdkRoot,
  keyDir: romKeyDir(layout),
  recipe,
  params: { armCpuCores: cores },
  force,
  isRunning: async () => (await findQemuPid(profile.avdName)) !== null,
  onLog: (line) => console.log(line),
})
  .then(({ manifest, imageDir, skipped }) => {
    console.log(`\n${skipped ? 'already up to date' : 'built'} in ${((Date.now() - started) / 1000).toFixed(1)}s — ${imageDir}`);
    console.log(`  ROM id ${manifest.romId}`);
    console.log(`  vbmeta digest ${manifest.vbmetaDigest}`);
    if (manifest.params) console.log(`  params ${JSON.stringify(manifest.params)}`);
    for (const [name, v] of Object.entries(manifest.volumes)) {
      console.log(
        `  ${name.padEnd(10)} removed ${String(v.removed.length).padStart(2)}  freed ${String(v.blocksFreed).padStart(6)} blocks` +
          `  props ${String(v.propsChanged.length).padStart(2)}  rewrote ${(v.edited ?? []).length}  added ${v.created.length}` +
          `  free now ${v.freeBlocks} blocks / ${v.freeInodes} inodes`,
      );
      if (v.notPresent.length > 0) console.log(`  ${''.padEnd(10)} not in this image: ${v.notPresent.join(', ')}`);
    }
  })
  .catch((err) => {
    console.error(`build failed: ${err.message}`);
    process.exit(1);
  });
