import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { LocalSource } = loadDist('store/sources/local.js');

function dirs(root) {
  const repoApps = path.join(root, 'android-apps');
  const imported = path.join(root, 'imported');
  mkdirSync(repoApps, { recursive: true });
  return { repoApps, imported };
}

test('APK files in the watched directories are listed', async () => {
  await withTempDir(async (root) => {
    const { repoApps, imported } = dirs(root);
    writeFileSync(path.join(repoApps, 'F-Droid.apk'), 'x');
    writeFileSync(path.join(repoApps, 'notes.txt'), 'ignored');

    const source = new LocalSource([repoApps], imported);
    const results = await source.search('', null, 10);

    assert.equal(results.length, 1, 'only .apk files count');
    assert.equal(results[0].source, 'local');
    assert.equal(results[0].packageName, 'F-Droid.apk');
    assert.equal(results[0].name, 'F Droid');
    assert.equal(results[0].minSdk, 0, 'the guest decides compatibility, not us');
  });
});

test('a dropped APK is copied into the managed directory so it survives the drag', async () => {
  await withTempDir(async (root) => {
    const { repoApps, imported } = dirs(root);
    const dropped = path.join(root, 'Downloaded.apk');
    writeFileSync(dropped, 'x');

    const source = new LocalSource([repoApps], imported);
    const stored = source.import(dropped);

    assert.ok(existsSync(stored));
    assert.equal(path.dirname(stored), imported);
    assert.equal((await source.search('', null, 10)).length, 1);
  });
});

test('importing the same file twice is a no-op rather than an error', async () => {
  await withTempDir(async (root) => {
    const { repoApps, imported } = dirs(root);
    const dropped = path.join(root, 'Twice.apk');
    writeFileSync(dropped, 'x');

    const source = new LocalSource([repoApps], imported);
    const first = source.import(dropped);
    const second = source.import(first);

    assert.equal(first, second);
    assert.equal((await source.search('', null, 10)).length, 1);
  });
});

test('non-APK files are refused on import', async () => {
  await withTempDir(async (root) => {
    const { repoApps, imported } = dirs(root);
    const notAnApk = path.join(root, 'photo.png');
    writeFileSync(notAnApk, 'x');

    const source = new LocalSource([repoApps], imported);
    assert.throws(() => source.import(notAnApk), /not an \.apk/);
  });
});

test('a missing directory is skipped instead of throwing', async () => {
  await withTempDir(async (root) => {
    const source = new LocalSource([path.join(root, 'does-not-exist')], path.join(root, 'also-missing'));
    assert.deepEqual(await source.search('', null, 10), []);
  });
});

test('search filters by filename', async () => {
  await withTempDir(async (root) => {
    const { repoApps, imported } = dirs(root);
    writeFileSync(path.join(repoApps, 'Signal.apk'), 'x');
    writeFileSync(path.join(repoApps, 'NewPipe.apk'), 'x');

    const source = new LocalSource([repoApps], imported);
    const hits = await source.search('pipe', null, 10);

    assert.equal(hits.length, 1);
    assert.equal(hits[0].packageName, 'NewPipe.apk');
  });
});

test('resolve points at the file on disk with no digest to check', async () => {
  await withTempDir(async (root) => {
    const { repoApps, imported } = dirs(root);
    const apk = path.join(repoApps, 'Thing.apk');
    writeFileSync(apk, 'x');

    const source = new LocalSource([repoApps], imported);
    const resolved = await source.resolve('Thing.apk');

    assert.equal(resolved.kind, 'file');
    assert.equal(resolved.location, apk);
    // Nothing upstream published a digest for a file the user supplied, so there is nothing to
    // compare against — the installer must not demand one for local files.
    assert.equal(resolved.sha256, null);
    assert.equal(resolved.source, 'local');

    assert.equal(await source.resolve('Nope.apk'), null);
  });
});

test('the imported copy shadows a same-named file in the repo directory', async () => {
  await withTempDir(async (root) => {
    const { repoApps, imported } = dirs(root);
    mkdirSync(imported, { recursive: true });
    writeFileSync(path.join(repoApps, 'Dup.apk'), 'old');
    writeFileSync(path.join(imported, 'Dup.apk'), 'new');

    const source = new LocalSource([repoApps], imported);
    const results = await source.search('', null, 10);

    assert.equal(results.length, 1, 'listed once, not twice');
    assert.equal(results[0].summary, path.join(imported, 'Dup.apk'), 'the imported one wins');
  });
});
