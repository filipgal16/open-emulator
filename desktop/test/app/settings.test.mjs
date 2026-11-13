import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../helpers.mjs';

const { SettingsStore, storageUsage, moveDownloadRoot } = loadDist('settings.js');
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
    assert.equal(store.set({ density: 40 }).density, 120);
    assert.equal(store.set({ density: 5000 }).density, 640);
    assert.equal(store.set({ density: 320 }).density, 320);
    assert.equal(store.set({ density: null }).density, null, "null goes back to the device's own");
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

// ── Download location ──────────────────────────────────────────────────────────────────────────

test('a download folder must be absolute, or it means "use the default"', async () => {
  await withTempDir(async (dir) => {
    const store = new SettingsStore(file(dir));

    const absolute = process.platform === 'win32' ? 'D:\\Games\\Android' : '/mnt/games/android';
    assert.equal(store.set({ downloadRoot: absolute }).downloadRoot, absolute);

    // A relative path resolves against whatever working directory the app inherited, which is how
    // a packaged build once created a folder beside itself and downloaded gigabytes into it.
    assert.equal(store.set({ downloadRoot: 'somewhere' }).downloadRoot, null);
    // `D:Android` looks absolute and is not — it is drive-relative, resolving against the current
    // directory *on that drive*. Exactly the shape that would land gigabytes somewhere surprising.
    assert.equal(store.set({ downloadRoot: 'D:Android' }).downloadRoot, null);
    assert.equal(store.set({ downloadRoot: '   ' }).downloadRoot, null);
    assert.equal(store.set({ downloadRoot: null }).downloadRoot, null);
  });
});

test('moving to the same folder is a no-op, not a destructive round trip', async () => {
  await withTempDir(async (dir) => {
    const from = path.join(dir, 'root');
    mkdirSync(from, { recursive: true });
    writeFileSync(path.join(from, 'keep.bin'), Buffer.alloc(64));

    const result = moveDownloadRoot(from, from);

    assert.equal(result.ok, true);
    assert.ok(existsSync(path.join(from, 'keep.bin')), 'the files must survive');
  });
});

test('moving an existing download relocates it rather than orphaning it', async () => {
  await withTempDir(async (dir) => {
    const from = path.join(dir, 'old');
    const to = path.join(dir, 'new');
    mkdirSync(path.join(from, 'sdk'), { recursive: true });
    writeFileSync(path.join(from, 'sdk', 'system.img'), Buffer.alloc(4096));

    const result = moveDownloadRoot(from, to);

    // Leaving the old copy behind would silently re-download several gigabytes and strand the
    // original — the worst of both outcomes.
    assert.equal(result.ok, true, result.message);
    assert.ok(existsSync(path.join(to, 'sdk', 'system.img')));
    assert.ok(!existsSync(from), 'the old location must not be left behind');
    assert.ok(result.movedBytes >= 4096);
  });
});

test('moving into a folder that already has files is refused', async () => {
  await withTempDir(async (dir) => {
    const from = path.join(dir, 'old');
    const to = path.join(dir, 'occupied');
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(path.join(from, 'a.bin'), Buffer.alloc(16));
    writeFileSync(path.join(to, 'someone-elses-file.txt'), 'important');

    const result = moveDownloadRoot(from, to);

    assert.equal(result.ok, false, 'half-merging into someone else’s directory is worse than refusing');
    assert.match(result.message, /already contains files/);
    assert.equal(readFileSync(path.join(to, 'someone-elses-file.txt'), 'utf8'), 'important');
    assert.ok(existsSync(path.join(from, 'a.bin')), 'and the source is untouched');
  });
});

test('moving before anything is downloaded succeeds quietly', async () => {
  await withTempDir(async (dir) => {
    const result = moveDownloadRoot(path.join(dir, 'never-existed'), path.join(dir, 'new'));

    assert.equal(result.ok, true);
    assert.equal(result.movedBytes, 0);
  });
});
