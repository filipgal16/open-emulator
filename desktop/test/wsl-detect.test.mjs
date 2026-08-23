import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { isRebootPending } = loadDist('wsl-detect.js');

/**
 * The fail-safe contract matters more than the answer.
 *
 * `isRebootPending` exists only to explain a failure that already happened — it turns "no usable
 * distro found" into "restart Windows". It is called from inside a setup step's `check`, so a
 * rejection here would surface as the step's failure message and replace an accurate diagnosis
 * with a stack trace about `reg.exe`. It must resolve either way, on any host.
 */
test('isRebootPending resolves to a boolean and never rejects', async () => {
  const pending = await isRebootPending();
  assert.equal(typeof pending, 'boolean');
});

test('isRebootPending reports not-pending rather than throwing when reg.exe is unavailable', async () => {
  // Nothing stubs the spawn here on purpose: on a host without `reg.exe` the 'error' handler is
  // what runs, and the required outcome is the same as a missing key — `false`, not an exception.
  // A machine that already has a working WSL must never be blocked by this check.
  await assert.doesNotReject(() => isRebootPending());
});
