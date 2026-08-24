import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../../helpers.mjs';

const { parseStatus } = loadDist('guest/device-status.js');

/**
 * The seam between an engine and the UI.
 *
 * SdkEngine.status() synthesises these lines rather than shelling out, so nothing forces the two
 * sides to agree any more — a renamed key would compile fine and quietly leave the device panel
 * reporting "unknown" forever. These samples are copied from what SdkEngine emits.
 */
const RUNNING = [
  'avd=OpenEmulator_API30_fast',
  'emulator=running',
  'pid=4242',
  'adb_device=emulator-5554',
  'boot_completed=1',
  'android=11 api=30',
  'snapshot=booted present=yes',
  'provisioned_at=2026-08-24T10:00:00.000Z',
];

test('a fully running guest is read correctly', () => {
  const state = parseStatus(RUNNING);

  assert.equal(state.avd, 'OpenEmulator_API30_fast');
  assert.equal(state.phase, 'running');
  assert.equal(state.bootCompleted, true);
  assert.equal(state.androidVersion, '11');
  assert.equal(state.api, 30);
  assert.equal(state.snapshot, true);
  assert.equal(state.provisioned, true);
});

test('a stopped guest reports stopped, not unknown', () => {
  const state = parseStatus(['avd=OpenEmulator_API30_fast', 'emulator=stopped', 'adb_device=none', 'snapshot=booted present=no']);

  assert.equal(state.phase, 'stopped');
  assert.equal(state.snapshot, false);
  assert.equal(state.provisioned, false);
});

test('an unprovisioned guest is distinguishable from one that simply did not answer', () => {
  // The distinction matters: reporting "not provisioned" for a guest that was merely quiet sends
  // the user through a 20-minute re-provision they did not need.
  const quiet = parseStatus(['avd=A', 'emulator=stopped']);

  assert.equal(quiet.provisioned, false);
  assert.equal(quiet.androidVersion, undefined, 'absent lines leave fields at their default');
  assert.equal(quiet.api, undefined);
});

test('the android line carries both version and api on one line', () => {
  assert.equal(parseStatus(['android=11 api=30']).api, 30);
  assert.equal(parseStatus(['android=11 api=30']).androidVersion, '11');
  assert.equal(parseStatus(['android=unknown api=unknown']).androidVersion, undefined);
});
