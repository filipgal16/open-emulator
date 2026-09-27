#!/usr/bin/env node
// Builds the `openemu` system image from the downloaded stock one. See design/custom-image.md.
//
//   npm run build:image            build if missing
//   npm run build:image -- --force rebuild from the stock image
//
// Runs against the compiled output, so `npm run build:main` first.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (rel) => require(path.join(here, '..', 'dist', 'main', rel));

const { createSdkLayout } = dist('engine/sdk/layout.js');
const { nativeRoot } = dist('engine/factory.js');
const { buildImage } = dist('engine/sdk/image-builder.js');

const force = process.argv.includes('--force');
const layout = createSdkLayout(nativeRoot(process.env.OPEN_EMULATOR_DOWNLOAD_ROOT ?? null));

const started = Date.now();
buildImage({
  layout,
  force,
  onLog: (_stream, line) => console.log(line),
})
  .then((report) => {
    console.log(`\n${report.skipped ? 'already built' : 'built'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`  ${report.imageDir}`);
    console.log(`  volumes: ${report.volumes.length}, apps removed: ${report.removed.length}, build.prop rebranded: ${report.patchedProps.length}`);
  })
  .catch((err) => {
    console.error(`build failed: ${err.message}`);
    process.exit(1);
  });
