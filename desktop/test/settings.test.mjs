import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { SettingsStore, storageUsage } = loadDist('settings.js');
const { DEFAULT_SETTINGS } = loadDist('../shared/settings-types.js');

const file = (dir) => path.join(dir, 'settings.json');

test('a fresh install gets the defaults', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(new SettingsStore(file(dir)).get(), DEFAULT_SETTINGS);
  });
});

test('settings round-trip through disk', async () => {
  await withTempDir(async (dir) => {
    new SettingsStore(file(dir)).set({ theme: 'light', device: 'pixel_5' });

    const reopened = new SettingsStore(file(dir)).get();
    assert.equal(reopened.theme, 'light');
    assert.equal(reopened.device, 'pixel_5');
  });
});

test('a partial update leaves the other fields alone', async () => {
  await withTempDir(async (dir) => {
    const store = new SettingsStore(file(dir));
    store.set({ theme: 'dark' });
    store.set({ device: 'redmi_note_11' });

    assert.equal(store.get().theme, 'dark', 'the earlier change survived');
    assert.equal(store.get().device, 'redmi_note_11');
  });
});

test('a corrupt file falls back to defaults instead of stopping the app', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(file(dir), '{ not json at all');

    // A settings file is the last thing that should be able to prevent startup.
    assert.deepEqual(new SettingsStore(file(dir)).get(), DEFAULT_SETTINGS);
  });
});

test('hand-edited nonsense is corrected, not honoured', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(file(dir), JSON.stringify({ theme: 'neon', device: '../../etc', cores: 'lots' }));
    const s = new SettingsStore(file(dir)).get();

    assert.equal(s.theme, 'system');
    assert.equal(s.device, 'generic', 'a path traversal must never reach a filename');
    assert.equal(s.cores, null, 'unparseable means "decide automatically"');
  });
});

test('overrides are clamped to values that produce a working guest', async () => {
  await withTempDir(async (dir) => {
    const store = new SettingsStore(file(dir));

    // Above the host count oversubscribes a virtual CPU and makes the guest slower; below 1 GB
    // will not boot Android at all. Both are corrected rather than obeyed.
    assert.equal(store.set({ cores: 9999 }).cores, 32);
    assert.equal(store.set({ cores: 0 }).cores, 1);
    assert.equal(store.set({ ramMb: 128 }).ramMb, 1024);
    assert.equal(store.set({ ramMb: 999999 }).ramMb, 16384);
  });
});

test('null means "decide from this machine", and survives a round trip', async () => {
  await withTempDir(async (dir) => {
    const store = new SettingsStore(file(dir));
    store.set({ cores: 8 });
    assert.equal(store.set({ cores: null }).cores, null);
    assert.equal(new SettingsStore(file(dir)).get().cores, null);
  });
});

test('the write is atomic — no .tmp file is left behind', async () => {
  await withTempDir(async (dir) => {
    new SettingsStore(file(dir)).set({ theme: 'dark' });

    assert.ok(JSON.parse(readFileSync(file(dir), 'utf8')));
    assert.throws(() => readFileSync(`${file(dir)}.tmp`, 'utf8'));
  });
});

test('storage separates what can be freed from what must not be', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(path.join(dir, 'downloads'), { recursive: true });
    mkdirSync(path.join(dir, 'sdk', 'platform-tools'), { recursive: true });
    writeFileSync(path.join(dir, 'downloads', 'a.zip'), Buffer.alloc(4096));
    writeFileSync(path.join(dir, 'sdk', 'platform-tools', 'adb.exe'), Buffer.alloc(8192));

    const usage = storageUsage(dir, [path.join(dir, 'downloads')]);

    assert.ok(usage.totalBytes >= 12_288, 'total covers everything');
    assert.equal(usage.reclaimableBytes, 4096, 'only the archives — never the extracted SDK');
    assert.ok(usage.reclaimableBytes < usage.totalBytes);
  });
});

test('a missing root reports zero rather than throwing', async () => {
  await withTempDir(async (dir) => {
    const usage = storageUsage(path.join(dir, 'nope'), [path.join(dir, 'also-nope')]);
    assert.equal(usage.totalBytes, 0);
    assert.equal(usage.reclaimableBytes, 0);
  });
});
