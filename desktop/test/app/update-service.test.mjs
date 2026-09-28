import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { UpdateService, describeUpdateError, scheduleChecks } = loadDist('update/update-service.js');

/**
 * Stands in for electron-updater's autoUpdater: same fields, same events, and a script for what
 * each check and download should do. Emits in the order the real one does — `checking-for-update`
 * first, then the outcome, then the promise settles.
 */
function fakeUpdater({ check = 'none', download = 'ok', latest = '0.2.0' } = {}) {
  const emitter = new EventEmitter();
  const calls = { check: 0, download: 0, install: [] };
  return Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    allowPrerelease: true,
    calls,
    async checkForUpdates() {
      calls.check += 1;
      await null;
      if (check === 'inactive') return null;
      emitter.emit('checking-for-update');
      if (check === 'available') {
        emitter.emit('update-available', { version: latest });
        return { updateInfo: { version: latest } };
      }
      if (check === 'none') {
        emitter.emit('update-not-available', { version: '0.1.0' });
        return { updateInfo: { version: '0.1.0' } };
      }
      const err = Object.assign(new Error(`${check} failed`), { code: check });
      emitter.emit('error', err);
      throw err;
    },
    async downloadUpdate() {
      calls.download += 1;
      await null;
      if (download === 'ok') {
        emitter.emit('download-progress', { percent: 41.6 });
        emitter.emit('update-downloaded', { version: latest });
        return [];
      }
      const err = Object.assign(new Error('bad download'), { code: download });
      emitter.emit('error', err);
      throw err;
    },
    quitAndInstall(isSilent, isForceRunAfter) {
      calls.install.push([isSilent, isForceRunAfter]);
    },
  });
}

function service(updater, seen = []) {
  return new UpdateService({
    updater,
    currentVersion: '0.1.0',
    now: () => 1_700_000_000_000,
    onChange: (state) => seen.push(state.phase),
  });
}

test('a development run says it cannot update, and a check does nothing', async () => {
  const s = service(null);
  assert.equal(s.get().phase, 'unsupported');
  assert.match(s.get().message, /installed app/);
  assert.equal((await s.check()).phase, 'unsupported');
});

test('the updater is configured to ask first and never go backwards', () => {
  const u = fakeUpdater();
  service(u);
  assert.equal(u.autoDownload, false, 'nothing may download without a click');
  assert.equal(u.allowDowngrade, false);
  assert.equal(u.allowPrerelease, false);
  assert.equal(u.autoInstallOnAppQuit, true);
});

test('a check with nothing newer ends up to date and records when', async () => {
  const seen = [];
  const s = service(fakeUpdater({ check: 'none' }), seen);
  const state = await s.check();
  assert.equal(state.phase, 'up-to-date');
  assert.equal(state.checkedAt, 1_700_000_000_000);
  assert.equal(state.latestVersion, null);
  assert.deepEqual(seen, ['checking', 'checking', 'up-to-date']);
});

test('finding an update offers it but does not download it', async () => {
  const u = fakeUpdater({ check: 'available', latest: '0.2.0' });
  const state = await service(u).check();
  assert.equal(state.phase, 'available');
  assert.equal(state.latestVersion, '0.2.0');
  assert.equal(u.calls.download, 0);
});

test('download, then install: silent, and the app reopens afterwards', async () => {
  const u = fakeUpdater({ check: 'available' });
  const seen = [];
  const s = service(u, seen);
  await s.check();
  const done = await s.download();
  assert.equal(done.phase, 'ready');
  assert.equal(done.percent, 100);
  assert.ok(seen.includes('downloading'));
  assert.equal(s.install(), true);
  assert.deepEqual(u.calls.install, [[true, true]]);
});

test('download progress is reported as a whole percentage', async () => {
  const u = fakeUpdater({ check: 'available' });
  const percents = [];
  const s = new UpdateService({
    updater: u,
    currentVersion: '0.1.0',
    onChange: (state) => state.phase === 'downloading' && percents.push(state.percent),
  });
  await s.check();
  await s.download();
  assert.deepEqual(percents, [0, 42]);
});

test('download and install are refused unless the previous step happened', async () => {
  const u = fakeUpdater({ check: 'none' });
  const s = service(u);
  assert.equal((await s.download()).phase, 'idle');
  assert.equal(u.calls.download, 0);
  assert.equal(s.install(), false);
  await s.check();
  assert.equal((await s.download()).phase, 'up-to-date');
  assert.equal(u.calls.download, 0);
  assert.deepEqual(u.calls.install, []);
});

test('a timed check cannot discard an update that is downloaded and waiting', async () => {
  const u = fakeUpdater({ check: 'available' });
  const s = service(u);
  await s.check();
  await s.download();
  const after = await s.check();
  assert.equal(after.phase, 'ready');
  assert.equal(u.calls.check, 1);
});

test('two checks at once make one request', async () => {
  const u = fakeUpdater({ check: 'none' });
  const s = service(u);
  const [a, b] = await Promise.all([s.check(), s.check()]);
  assert.equal(u.calls.check, 1);
  assert.equal(a.phase, 'up-to-date');
  assert.equal(b.phase, 'up-to-date');
});

test('an updater that decides it is inactive does not leave the state on "checking"', async () => {
  const state = await service(fakeUpdater({ check: 'inactive' })).check();
  assert.equal(state.phase, 'unsupported');
});

test('a private repository is explained, not reported as a raw 404', async () => {
  const state = await service(fakeUpdater({ check: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })).check();
  assert.equal(state.phase, 'error');
  assert.match(state.message, /private/);
});

test('a failed download can be retried after checking again', async () => {
  const u = fakeUpdater({ check: 'available', download: 'ERR_CHECKSUM_MISMATCH' });
  const s = service(u);
  await s.check();
  const failed = await s.download();
  assert.equal(failed.phase, 'error');
  assert.match(failed.message, /checksum/);
  assert.equal((await s.check()).phase, 'available');
});

test('errors are described in terms a person can act on', () => {
  const coded = (code, message = 'x') => Object.assign(new Error(message), { code });
  // Verbatim from electron-updater 6.8.9 checking this (private) repository.
  assert.match(describeUpdateError(coded('HTTP_ERROR_404', '404 Not Found')), /repository is private/);
  assert.match(describeUpdateError(coded('HTTP_ERROR_403')), /limiting requests/);
  assert.match(describeUpdateError(coded('ERR_UPDATER_NO_PUBLISHED_VERSIONS')), /No published release/);
  assert.match(describeUpdateError(coded('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')), /No published release/);
  assert.match(describeUpdateError(coded('ENOTFOUND')), /Couldn't reach GitHub/);
  assert.match(describeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED')), /Couldn't reach GitHub/);
  // What Electron actually reported when a proxy re-signed the connection, verbatim.
  assert.match(describeUpdateError(new Error('net::ERR_CERT_AUTHORITY_INVALID')), /certificate wasn't trusted/);
  assert.equal(describeUpdateError(new Error('first line\nstack line')), 'first line');
  assert.equal(describeUpdateError(new Error('')), 'Updating failed for an unknown reason.');
  assert.equal(describeUpdateError(new Error('y'.repeat(300))).length, 201);
});

test('scheduled checks wait first, then repeat, and stop cleanly — they never download', async () => {
  const u = fakeUpdater({ check: 'available' });
  const s = service(u);
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => pending.push({ kind: 'timeout', fn, ms }) - 1,
    setInterval: (fn, ms) => pending.push({ kind: 'interval', fn, ms }) - 1,
    clearTimeout: (h) => (pending[h].cleared = true),
    clearInterval: (h) => (pending[h].cleared = true),
  };
  const stop = scheduleChecks(s, { firstDelayMs: 30_000, everyMs: 21_600_000, timers });
  assert.equal(u.calls.check, 0, 'nothing at startup');
  assert.deepEqual(pending.map((p) => [p.kind, p.ms]), [['timeout', 30_000]]);

  pending[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(u.calls.check, 1);
  assert.deepEqual(pending.map((p) => [p.kind, p.ms]), [['timeout', 30_000], ['interval', 21_600_000]]);
  assert.equal(u.calls.download, 0);

  stop();
  assert.ok(pending.every((p) => p.cleared));
});
