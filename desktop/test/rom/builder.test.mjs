import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../helpers.mjs';

// The builder's own logic that the module tests do not reach: where images live, which manifests
// count as ours, and how an interrupted swap is repaired. Building a real ROM needs Google's 3 GB
// image, so that is covered by `npm run rom:build` / `rom:check` on a development machine instead.
const { romPaths, romKeyDir, readManifest, recoverInterruptedSwap, romState } = loadDist('rom/builder.js');

function makeImage(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'system.img'), 'x');
  if (manifest) writeFileSync(path.join(dir, 'openemu-manifest.json'), JSON.stringify(manifest));
}

test('images, staging and the key live where the layout says', () => {
  const paths = romPaths(path.join('C:', 'oe', 'sdk'));
  assert.equal(paths.baseDir, path.join('C:', 'oe', 'sdk', 'system-images', 'android-30', 'default', 'x86_64'));
  assert.equal(paths.imageDir, path.join('C:', 'oe', 'sdk', 'system-images', 'android-30', 'openemu', 'x86_64'));
  assert.equal(paths.stagingDir, `${paths.imageDir}.staging`);
  assert.equal(paths.prevDir, `${paths.imageDir}.prev`);
  assert.equal(romKeyDir({ root: path.join('C:', 'oe') }), path.join('C:', 'oe', 'rom'));
});

test("a manifest from the old debugfs builder is not ours, so it never counts as up to date", async () => {
  await withTempDir(async (dir) => {
    makeImage(dir, { imageDir: dir, removed: [], spec: { tag: 'openemu' } });
    assert.equal(readManifest(dir), null);
    makeImage(dir, { builder: 'openemu-rom', builderRevision: 1, romId: 'abc' });
    assert.equal(readManifest(dir).romId, 'abc');
  });
});

test('a crash between the two renames of a swap is repaired from .prev', async () => {
  await withTempDir(async (dir) => {
    const paths = romPaths(dir);
    makeImage(paths.prevDir, { builder: 'openemu-rom', romId: 'last-good' });

    assert.equal(recoverInterruptedSwap(paths), true);
    assert.ok(existsSync(path.join(paths.imageDir, 'system.img')));
    assert.ok(!existsSync(paths.prevDir));
    assert.equal(readManifest(paths.imageDir).romId, 'last-good');
  });
});

test('a leftover .prev beside a finished swap is removed, not restored', async () => {
  await withTempDir(async (dir) => {
    const paths = romPaths(dir);
    makeImage(paths.imageDir, { builder: 'openemu-rom', romId: 'new' });
    makeImage(paths.prevDir, { builder: 'openemu-rom', romId: 'old' });

    assert.equal(recoverInterruptedSwap(paths), false);
    assert.ok(!existsSync(paths.prevDir));
    assert.equal(JSON.parse(readFileSync(path.join(paths.imageDir, 'openemu-manifest.json'), 'utf8')).romId, 'new');
  });
});

test('state: nothing built, an old builder, a changed builder revision', async () => {
  await withTempDir(async (dir) => {
    const contents = { wallpaper: Buffer.from('png') };
    assert.equal(romState(dir, undefined, contents).reason, 'not built');

    const { imageDir } = romPaths(dir);
    makeImage(imageDir, { spec: {} });
    const old = romState(dir, undefined, contents);
    assert.equal(old.built, true);
    assert.equal(old.upToDate, false);
    assert.match(old.reason, /older builder/);

    makeImage(imageDir, { builder: 'openemu-rom', builderRevision: -1, recipeHash: 'x', baseDigest: 'y', romId: 'z' });
    assert.match(romState(dir, undefined, contents).reason, /builder changed/);
  });
});
