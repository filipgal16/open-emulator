import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { decideAcceleration } = loadDist('engine/acceleration.js');

const probes = (over = {}) => ({
  windows: true,
  aehdRunning: false,
  whpxEnabled: false,
  firmwareVirtualization: true,
  rebootPending: false,
  hypervisorRunning: false,
  ...over,
});

test('WHPX enabled is accelerated and needs no fix', () => {
  const state = decideAcceleration(probes({ whpxEnabled: true }));

  assert.equal(state.available, true);
  assert.equal(state.method, 'whpx');
  assert.equal(state.fixable, false);
});

test('AEHD is reported even though WHPX is off — the two are mutually exclusive', () => {
  // Reporting "enable WHPX" on a machine already accelerated by Google's driver would be wrong,
  // and following that advice would break the driver it already has.
  const state = decideAcceleration(probes({ aehdRunning: true, whpxEnabled: false }));

  assert.equal(state.available, true);
  assert.equal(state.method, 'aehd');
  assert.equal(state.fixable, false);
});

test('a missing Windows feature is offered as fixable', () => {
  const state = decideAcceleration(probes({ whpxEnabled: false, firmwareVirtualization: true }));

  assert.equal(state.available, false);
  assert.equal(state.fixable, true, 'this one the app can actually fix');
  assert.match(state.detail, /Hypervisor Platform/);
});

test('virtualization off in firmware is NOT offered as fixable', () => {
  // The distinction that matters: showing a button that cannot possibly help is worse than showing
  // instructions for the thing that actually needs doing.
  const state = decideAcceleration(probes({ firmwareVirtualization: false }));

  assert.equal(state.available, false);
  assert.equal(state.fixable, false);
  assert.match(state.detail, /BIOS|UEFI/);
});

test('a non-Windows host is simply unaccelerated, not broken', () => {
  const state = decideAcceleration(probes({ windows: false }));

  assert.equal(state.available, false);
  assert.equal(state.fixable, false);
});

test('every outcome carries a sentence the setup screen can show', () => {
  for (const p of [
    probes({ whpxEnabled: true }),
    probes({ aehdRunning: true }),
    probes(),
    probes({ firmwareVirtualization: false }),
    probes({ windows: false }),
  ]) {
    assert.ok(decideAcceleration(p).detail.length > 0);
  }
});

test('a feature enabled but not yet live is NOT reported as available', () => {
  // The trap this exists for: DISM flips the feature's state the moment it finishes and reports
  // success, but nothing changes until the machine restarts. Believing the flag would have the app
  // pass -accel whpx to an emulator that then refuses to start, and blame the emulator.
  const state = decideAcceleration(probes({ whpxEnabled: true, rebootPending: true }));

  assert.equal(state.available, false);
  assert.match(state.detail, /restart/i);
  assert.equal(state.fixable, false, 'a restart is the user’s to perform, not a button');
});

test('once restarted, the same feature reads as available', () => {
  const state = decideAcceleration(probes({ whpxEnabled: true, rebootPending: false }));

  assert.equal(state.available, true);
  assert.equal(state.method, 'whpx');
});

test('a pending reboot with the hypervisor already running is a working WHPX', () => {
  // Windows Update leaves the reboot flag set for days. On a machine whose hypervisor is loaded,
  // WHPX has nothing to wait for — reading the flag as "not live yet" put a working machine on TCG.
  const state = decideAcceleration(probes({ whpxEnabled: true, rebootPending: true, hypervisorRunning: true }));

  assert.equal(state.available, true);
  assert.equal(state.method, 'whpx');
});

test('a pending reboot does not mask acceleration that is already working', () => {
  // A Windows update can leave a reboot pending on a machine whose acceleration is fine. Reporting
  // that as unavailable would send someone to restart for no reason.
  const state = decideAcceleration(probes({ aehdRunning: true, rebootPending: true }));

  assert.equal(state.available, true);
  assert.equal(state.method, 'aehd');
});
