import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { Installer } = loadDist('store/installer.js');

// Platform-agnostic since path translation moved into the engine: the installer hands over the
// host path and the runtime converts it if it has to.
/** Every case here is bounded work; a hang is a bug, so it should fail rather than block. */
const opts = (extra = {}) => ({ timeout: 10_000, ...extra });

const APK = Buffer.from('PK pretend this is an apk');
const APK_SHA = createHash('sha256').update(APK).digest('hex');

function streamOf(buffer, chunkSize = 8) {
  let offset = 0;
  return {
    getReader: () => ({
      async read() {
        if (offset >= buffer.length) return { done: true, value: undefined };
        const value = new Uint8Array(buffer.subarray(offset, offset + chunkSize));
        offset += chunkSize;
        return { done: false, value };
      },
    }),
  };
}

function fakeFetch(buffer, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (!ok) return { ok: false, status };
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-length', String(buffer.length)]]),
      body: streamOf(buffer),
    };
  };
  impl.calls = calls;
  return impl;
}

function fakeOpenEmu({ code = 0, stdout = ['Success'], stderr = [] } = {}) {
  const calls = [];
  return {
    calls,
    async install(apkPath) {
      calls.push(apkPath);
      return { code, signal: null, stdout, stderr };
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

function spec(overrides = {}) {
  return {
    packageName: 'com.example.app',
    label: 'Example',
    source: 'fdroid',
    kind: 'url',
    location: 'https://f-droid.org/repo/com.example.app_1.apk',
    sha256: APK_SHA,
    sizeBytes: APK.length,
    versionName: '1.0',
    ...overrides,
  };
}

/**
 * Subscribes *before* enqueueing, then runs the job to a terminal state.
 *
 * The ordering is load-bearing: a spec that fails its precondition (a missing local file) is
 * rejected synchronously inside `enqueue`, so a listener attached afterwards would never see the
 * only update that matters.
 */
function runJob(installer, jobSpec) {
  const done = new Promise((resolve) => {
    const off = installer.onUpdate((job) => {
      if (job.state === 'done' || job.state === 'failed') {
        off();
        resolve(job);
      }
    });
  });
  installer.enqueue(jobSpec);
  return done;
}

test('a verified download is installed and cached under its own digest', opts(), async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch(APK);
    const openEmu = fakeOpenEmu();
    const installer = new Installer(openEmu, fakeLibrary([]), dir, { fetchImpl });

    const job = await runJob(installer, spec());

    assert.equal(job.state, 'done', job.error ?? '');
    assert.equal(job.resolvedPackage, 'com.example.app');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(openEmu.calls.length, 1);
    assert.equal(
      openEmu.calls[0],
      path.join(dir, `${APK_SHA}.apk`),
      'the engine is handed the host path untranslated — converting it is the runtime’s job',
    );
    assert.ok(existsSync(path.join(dir, `${APK_SHA}.apk`)), 'cached under its digest');
  });
});

test('a digest mismatch fails the job and the APK never reaches the guest', opts(), async () => {
  await withTempDir(async (dir) => {
    const openEmu = fakeOpenEmu();
    const installer = new Installer(openEmu, fakeLibrary([]), dir, { fetchImpl: fakeFetch(APK) });

    const job = await runJob(installer, spec({ sha256: 'a'.repeat(64) }));

    assert.equal(job.state, 'failed');
    assert.match(job.error, /digest mismatch/);
    assert.equal(openEmu.calls.length, 0, 'adb was never called');
    assert.deepEqual(readdirSync(dir), [], 'the bad download was deleted, not cached');
  });
});

test('a network APK with no expected digest is refused before any request', opts(), async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch(APK);
    const installer = new Installer(fakeOpenEmu(), fakeLibrary([]), dir, { fetchImpl });

    const job = await runJob(installer, spec({ sha256: null }));

    assert.equal(job.state, 'failed');
    assert.match(job.error, /no expected digest/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('a non-https download is refused', opts(), async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = fakeFetch(APK);
    const installer = new Installer(fakeOpenEmu(), fakeLibrary([]), dir, { fetchImpl });

    const job = await runJob(installer, spec({ location: 'http://f-droid.org/repo/x.apk' }));

    assert.equal(job.state, 'failed');
    assert.match(job.error, /non-https/);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('an already-cached digest is not downloaded twice', opts(), async () => {
  await withTempDir(async (dir) => {
    writeFileSync(path.join(dir, `${APK_SHA}.apk`), APK);
    const fetchImpl = fakeFetch(APK);
    const installer = new Installer(fakeOpenEmu(), fakeLibrary([]), dir, { fetchImpl });

    const job = await runJob(installer, spec());

    assert.equal(job.state, 'done', job.error ?? '');
    assert.equal(fetchImpl.calls.length, 0, 'served from the digest-named cache');
  });
});

test('a local APK is installed from disk and its real package learnt from the guest', opts(), async () => {
  await withTempDir(async (dir) => {
    const apkPath = path.join(dir, 'MyApp.apk');
    writeFileSync(apkPath, APK);

    const fetchImpl = fakeFetch(APK);
    // Before the install the guest has one app; afterwards it has two.
    const library = fakeLibrary(['com.already.there'], ['com.already.there', 'com.discovered.pkg']);
    const installer = new Installer(fakeOpenEmu(), library, dir, { fetchImpl });

    const job = await runJob(
      installer,
      spec({ source: 'local', kind: 'file', location: apkPath, sha256: null, packageName: 'MyApp.apk' }),
    );

    assert.equal(job.state, 'done', job.error ?? '');
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(job.packageName, 'MyApp.apk', 'the id it was started with is stable');
    assert.equal(job.resolvedPackage, 'com.discovered.pkg', 'the guest supplied the real name');
  });
});

test('an ambiguous package diff is left unresolved rather than guessed', opts(), async () => {
  await withTempDir(async (dir) => {
    const apkPath = path.join(dir, 'MyApp.apk');
    writeFileSync(apkPath, APK);

    const library = fakeLibrary([], ['com.one', 'com.two']);
    const installer = new Installer(fakeOpenEmu(), library, dir, { fetchImpl: fakeFetch(APK) });

    const job = await runJob(
      installer,
      spec({ source: 'local', kind: 'file', location: apkPath, sha256: null, packageName: 'MyApp.apk' }),
    );

    assert.equal(job.state, 'done');
    assert.equal(job.resolvedPackage, null);
  });
});

test('a missing local file fails cleanly', opts(), async () => {
  await withTempDir(async (dir) => {
    const installer = new Installer(fakeOpenEmu(), fakeLibrary([]), dir, { fetchImpl: fakeFetch(APK) });

    const job = await runJob(
      installer,
      spec({ source: 'local', kind: 'file', location: path.join(dir, 'gone.apk'), sha256: null }),
    );

    assert.equal(job.state, 'failed');
    assert.match(job.error, /no longer there/);
  });
});

test('a failing adb install surfaces the guest’s own reason', opts(), async () => {
  await withTempDir(async (dir) => {
    const openEmu = fakeOpenEmu({
      code: 1,
      stdout: ['Performing Streamed Install'],
      stderr: ['adb: failed to install: INSTALL_FAILED_NO_MATCHING_ABIS'],
    });
    const installer = new Installer(openEmu, fakeLibrary([]), dir, { fetchImpl: fakeFetch(APK) });

    const job = await runJob(installer, spec());

    assert.equal(job.state, 'failed');
    assert.match(job.error, /INSTALL_FAILED_NO_MATCHING_ABIS/);
  });
});

test('a failed HTTP response fails the job rather than installing nothing silently', opts(), async () => {
  await withTempDir(async (dir) => {
    const openEmu = fakeOpenEmu();
    const installer = new Installer(openEmu, fakeLibrary([]), dir, {
      fetchImpl: fakeFetch(APK, { ok: false, status: 404 }),
    });

    const job = await runJob(installer, spec());

    assert.equal(job.state, 'failed');
    assert.match(job.error, /404/);
    assert.equal(openEmu.calls.length, 0);
  });
});

test('enqueueing the same app twice returns the job already in flight', opts(), async () => {
  await withTempDir(async (dir) => {
    const installer = new Installer(fakeOpenEmu(), fakeLibrary([]), dir, { fetchImpl: fakeFetch(APK) });

    const settled = new Promise((resolve) => {
      const off = installer.onUpdate((job) => {
        if (job.state === 'done' || job.state === 'failed') {
          off();
          resolve(job);
        }
      });
    });

    const first = installer.enqueue(spec());
    const second = installer.enqueue(spec());
    assert.equal(first.id, second.id);
    assert.equal(installer.jobs().length, 1);

    await settled;
  });
});

test('progress moves through every stage', opts(), async () => {
  await withTempDir(async (dir) => {
    const installer = new Installer(fakeOpenEmu(), fakeLibrary([]), dir, { fetchImpl: fakeFetch(APK) });

    const seen = [];
    installer.onUpdate((job) => seen.push(job.state));

    await runJob(installer, spec());

    for (const state of ['downloading', 'verifying', 'installing', 'done']) {
      assert.ok(seen.includes(state), `never reported "${state}" (saw ${seen.join(' → ')})`);
    }
  });
});
