import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from '../helpers.mjs';
import { fakeApk, makeZip } from './zip-fixture.mjs';

const { Installer } = loadDist('store/installer.js');
const { LocalSource } = loadDist('store/sources/local.js');

const opts = { timeout: 10_000 };

const MANIFEST = {
  package_name: 'com.example.game',
  name: 'Example Game',
  split_apks: [{ file: 'com.example.game.apk', id: 'base' }],
  expansions: [
    {
      file: 'Android/obb/com.example.game/main.7.com.example.game.obb',
      install_path: 'Android/obb/com.example.game/main.7.com.example.game.obb',
    },
  ],
};

function writeGame(dir, name = 'game.xapk') {
  const file = path.join(dir, name);
  writeFileSync(
    file,
    makeZip([
      ['com.example.game.apk', fakeApk('base')],
      ['config.arm64_v8a.apk', fakeApk('arm64')],
      ['config.x86_64.apk', fakeApk('x86_64')],
      ['config.en.apk', fakeApk('en')],
      ['manifest.json', JSON.stringify(MANIFEST)],
      ['Android/obb/com.example.game/main.7.com.example.game.obb', 'OBB DATA'.repeat(1000)],
    ]),
  );
  return file;
}

/**
 * Records what reached the "guest". The files handed to install-multiple are read *during* the
 * call, because the installer deletes its scratch directory as soon as the job ends.
 */
function fakeOpenEmu({ abilist = 'x86_64,arm64-v8a', installCode = 0, pushCode = 0, bundles = true } = {}) {
  const calls = { installMultiple: [], installed: [], pushes: [], single: [] };
  return {
    calls,
    canInstallBundles: bundles,
    async getprop(name) {
      return name === 'ro.product.cpu.abilist' ? abilist : null;
    },
    async install(apkPath) {
      calls.single.push(apkPath);
      return { code: 0, signal: null, stdout: ['Success'], stderr: [] };
    },
    async installMultiple(paths, _onLog, timeoutMs) {
      calls.installMultiple.push({ paths, timeoutMs });
      calls.installed.push(...paths.map((file) => readFileSync(file)));
      return installCode === 0
        ? { code: 0, signal: null, stdout: ['Success'], stderr: [] }
        : { code: installCode, signal: null, stdout: [], stderr: ['adb: failed to finalize session: INSTALL_FAILED_INSUFFICIENT_STORAGE'] };
    },
    async pushFile(hostPath, guestPath) {
      calls.pushes.push({ guestPath, bytes: readFileSync(hostPath) });
      return { code: pushCode, signal: null, stdout: [], stderr: pushCode === 0 ? [] : ['adb: error: failed to copy'] };
    },
  };
}

function fakeLibrary(...snapshots) {
  const queue = [...snapshots];
  return {
    async listPackageNames() {
      return queue.length > 1 ? queue.shift() : (queue[0] ?? []);
    },
  };
}

function localSpec(file) {
  return {
    packageName: path.basename(file),
    label: 'game',
    source: 'local',
    kind: 'file',
    location: file,
    sha256: null,
    sizeBytes: 0,
    versionName: '',
  };
}

function runJob(installer, spec, seen = []) {
  return new Promise((resolve) => {
    const off = installer.onUpdate((job) => {
      seen.push(job.state);
      if (job.state === 'done' || job.state === 'failed') {
        off();
        resolve(job);
      }
    });
    installer.enqueue(spec);
  });
}

test('a bundle installs its base, its other splits and one native split, then copies the OBB', opts, async () => {
  await withTempDir(async (dir) => {
    const file = writeGame(dir);
    const scratch = path.join(dir, 'scratch');
    const openEmu = fakeOpenEmu();
    const installer = new Installer(openEmu, fakeLibrary([], ['com.example.game']), path.join(dir, 'cache'), { scratchDir: scratch });

    const seen = [];
    const job = await runJob(installer, localSpec(file), seen);

    assert.equal(job.state, 'done', job.error ?? '');
    assert.equal(job.error, null);
    assert.equal(job.resolvedPackage, 'com.example.game');
    assert.ok(seen.includes('unpacking') && seen.includes('installing'), `saw ${seen.join(' → ')}`);

    assert.equal(openEmu.calls.single.length, 0, 'never sent as a single APK');
    assert.equal(openEmu.calls.installMultiple.length, 1, 'one session for every piece');
    assert.deepEqual(
      openEmu.calls.installed.map((bytes) => bytes.equals(fakeApk('base')) ? 'base' : bytes.equals(fakeApk('en')) ? 'en' : bytes.equals(fakeApk('x86_64')) ? 'x86_64' : 'other'),
      ['base', 'en', 'x86_64'],
      'the arm64 split was left out on a guest that prefers x86_64',
    );
    assert.ok(openEmu.calls.installMultiple[0].timeoutMs >= 10 * 60_000);

    assert.equal(openEmu.calls.pushes.length, 1);
    assert.equal(openEmu.calls.pushes[0].guestPath, '/sdcard/Android/obb/com.example.game/main.7.com.example.game.obb');
    assert.equal(openEmu.calls.pushes[0].bytes.toString(), 'OBB DATA'.repeat(1000));

    assert.deepEqual(existsSync(scratch) ? readdirSync(scratch) : [], [], 'the unpacked copies are gone');
  });
});

test('an ARM-only bundle on a guest without ARM support fails before unpacking anything', opts, async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'arm.apks');
    writeFileSync(file, makeZip([['base.apk', fakeApk('base')], ['split_config.arm64_v8a.apk', fakeApk('arm')]]));
    const scratch = path.join(dir, 'scratch');
    const openEmu = fakeOpenEmu({ abilist: 'x86_64,x86' });
    const installer = new Installer(openEmu, fakeLibrary([]), path.join(dir, 'cache'), { scratchDir: scratch });

    const seen = [];
    const job = await runJob(installer, localSpec(file), seen);

    assert.equal(job.state, 'failed');
    assert.match(job.error, /built for ARM phones/);
    assert.ok(!seen.includes('unpacking'));
    assert.equal(openEmu.calls.installMultiple.length, 0);
  });
});

test('a failed install keeps the guest’s reason and still removes the unpacked files', opts, async () => {
  await withTempDir(async (dir) => {
    const file = writeGame(dir);
    const scratch = path.join(dir, 'scratch');
    const openEmu = fakeOpenEmu({ installCode: 1 });
    const installer = new Installer(openEmu, fakeLibrary([]), path.join(dir, 'cache'), { scratchDir: scratch });

    const job = await runJob(installer, localSpec(file));

    assert.equal(job.state, 'failed');
    assert.match(job.error, /INSTALL_FAILED_INSUFFICIENT_STORAGE/);
    assert.equal(openEmu.calls.pushes.length, 0, 'no data copied for an app that is not there');
    assert.deepEqual(readdirSync(scratch), []);
  });
});

test('an OBB that will not copy is reported, but the install stands', opts, async () => {
  await withTempDir(async (dir) => {
    const file = writeGame(dir);
    const installer = new Installer(fakeOpenEmu({ pushCode: 1 }), fakeLibrary([]), path.join(dir, 'cache'), {
      scratchDir: path.join(dir, 'scratch'),
    });

    const job = await runJob(installer, localSpec(file));

    assert.equal(job.state, 'done');
    assert.match(job.error, /data files couldn’t be copied/);
    assert.equal(job.resolvedPackage, 'com.example.game', 'a reinstall falls back to the manifest’s name');
  });
});

test('a damaged bundle fails with a plain sentence', opts, async () => {
  await withTempDir(async (dir) => {
    const archive = makeZip([['base.apk', 'base apk bytes', { method: 'stored' }]]);
    archive[30 + 'base.apk'.length + 1] ^= 0xff;
    const file = path.join(dir, 'broken.apks');
    writeFileSync(file, archive);

    const installer = new Installer(fakeOpenEmu(), fakeLibrary([]), path.join(dir, 'cache'), { scratchDir: path.join(dir, 'scratch') });
    const job = await runJob(installer, localSpec(file));

    assert.equal(job.state, 'failed');
    assert.equal(job.error, 'This file is damaged. Download it again, then try again.');
  });
});

test('a runtime that cannot install bundles says so instead of trying', opts, async () => {
  await withTempDir(async (dir) => {
    const file = writeGame(dir);
    const openEmu = fakeOpenEmu({ bundles: false });
    const installer = new Installer(openEmu, fakeLibrary([]), path.join(dir, 'cache'), { scratchDir: path.join(dir, 'scratch') });

    const job = await runJob(installer, localSpec(file));

    assert.equal(job.state, 'failed');
    assert.match(job.error, /built-in Android runtime/);
  });
});

test('a refused file becomes a failed job carrying the reason', () => {
  const installer = new Installer(fakeOpenEmu(), fakeLibrary([]), 'unused');
  const seen = [];
  installer.onUpdate((job) => seen.push(job));

  const job = installer.refuse('holiday-photos', 'This file isn’t an Android app, or it is damaged.');

  assert.equal(job.state, 'failed');
  assert.equal(job.source, 'local');
  assert.equal(seen.length, 1, 'shown in the list straight away');
  assert.equal(installer.jobs()[0].id, job.id);
});

test('the Local list shows bundles beside APKs, named without their extension', async () => {
  await withTempDir(async (root) => {
    writeFileSync(path.join(root, 'Game One.xapk'), 'x');
    writeFileSync(path.join(root, 'Tool.apks'), 'x');
    writeFileSync(path.join(root, 'plain.apk'), 'x');
    writeFileSync(path.join(root, 'archive.zip'), 'x');

    const source = new LocalSource([root], path.join(root, 'imported'));
    const results = await source.search('', null, 10);

    assert.deepEqual(results.map((app) => app.name).sort(), ['Game One', 'Tool', 'plain']);
    const spec = await source.resolve('Game One.xapk');
    assert.equal(spec.label, 'Game One');
  });
});
