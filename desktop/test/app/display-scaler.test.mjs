import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { DisplayScaler } = loadDist('guest/display-scaler.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A guest that answers `wm size` / `wm density` and records everything it is asked. */
function fakeGuest({ failOn = null, size = 'Physical size: 1080x1920', density = 'Physical density: 440' } = {}) {
  const calls = [];
  return {
    calls,
    applied: () => calls.filter((c) => c.startsWith('wm size ') || c.startsWith('wm density ')),
    shell: async (command) => {
      calls.push(command);
      if (failOn && failOn(command)) return { code: 1, stdout: [], stderr: ['failed'] };
      if (command === 'wm size') return { code: 0, stdout: [size], stderr: [] };
      if (command === 'wm density') return { code: 0, stdout: [density], stderr: [] };
      return { code: 0, stdout: [], stderr: [] };
    },
  };
}

const scalerFor = (guest, over = {}) =>
  new DisplayScaler({ shell: guest.shell, settleMs: 5, ...over });

// ── Debounce ───────────────────────────────────────────────────────────────────────────────────

test('a drag applies once, when it settles — not once per frame', () => {
  // wm size reconfigures the display and every visible activity re-lays out. One per frame would
  // make the drag stutter and the guest thrash.
  const guest = fakeGuest();
  const scaler = scalerFor(guest);

  for (const width of [1000, 1200, 1400, 1600]) scaler.request({ width, height: 900 });

  return sleep(40).then(() => {
    assert.deepEqual(guest.applied(), ['wm size 1600x900', 'wm density 367']);
  });
});

test('the size the drag ended on is the one applied', async () => {
  const guest = fakeGuest();
  const scaler = scalerFor(guest);

  scaler.request({ width: 1600, height: 900 });
  scaler.request({ width: 1280, height: 720 });
  await sleep(40);

  assert.ok(guest.calls.includes('wm size 1280x720'));
  assert.ok(!guest.calls.includes('wm size 1600x900'));
});

// ── The compounding bug this class exists to prevent ───────────────────────────────────────────

test('the panel is read once, never re-read after an override is set', async () => {
  // `wm size` reports the override once one exists. Re-reading it as the baseline would compute
  // each resize against the last result, and the display would shrink a little on every drag.
  const guest = fakeGuest();
  const scaler = scalerFor(guest);

  scaler.request({ width: 1600, height: 900 });
  await sleep(40);
  scaler.request({ width: 1280, height: 720 });
  await sleep(40);
  scaler.request({ width: 1024, height: 768 });
  await sleep(40);

  assert.equal(guest.calls.filter((c) => c === 'wm size').length, 1);
  assert.equal(guest.calls.filter((c) => c === 'wm density').length, 1);
});

test('forgetting the guest makes the next resize read the panel again', async () => {
  // A different profile boots a different panel; reusing the old one computes densities against a
  // device that no longer exists.
  const guest = fakeGuest();
  const scaler = scalerFor(guest);

  scaler.request({ width: 1600, height: 900 });
  await sleep(40);
  scaler.forget();
  scaler.request({ width: 1600, height: 900 });
  await sleep(40);

  assert.equal(guest.calls.filter((c) => c === 'wm size').length, 2);
});

// ── Not doing unnecessary work ─────────────────────────────────────────────────────────────────

test('a drag that ends where it started costs no reconfiguration', async () => {
  const guest = fakeGuest();
  const scaler = scalerFor(guest);

  scaler.request({ width: 1600, height: 900 });
  await sleep(40);
  const after = guest.calls.length;

  scaler.request({ width: 1600, height: 900 });
  await sleep(40);

  assert.equal(guest.calls.length, after, 'the identical geometry issued no further commands');
});

test('a resize arriving mid-apply still lands', async () => {
  // Otherwise the guest is left at the second-to-last size the user dragged to, which looks like
  // the feature simply lagging one step behind forever.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const guest = fakeGuest();
  const slow = {
    calls: guest.calls,
    shell: async (command) => {
      if (command === 'wm size 1600x900') await gate;
      return guest.shell(command);
    },
  };
  const scaler = new DisplayScaler({ shell: slow.shell, settleMs: 5 });

  scaler.request({ width: 1600, height: 900 });
  await sleep(20);
  scaler.request({ width: 1280, height: 720 });
  release();
  await sleep(60);

  assert.ok(guest.calls.includes('wm size 1280x720'), 'the later size was not dropped');
});

// ── Failure and teardown ───────────────────────────────────────────────────────────────────────

test('an unreadable panel is not guessed at, and the next resize retries', async () => {
  const guest = fakeGuest({ size: 'error: no devices/emulators found' });
  const scaler = scalerFor(guest);

  scaler.request({ width: 1600, height: 900 });
  await sleep(40);

  assert.equal(guest.applied().length, 0, 'nothing was applied against an unknown panel');

  scaler.request({ width: 1600, height: 900 });
  await sleep(40);
  assert.equal(guest.calls.filter((c) => c === 'wm size').length, 2, 'it tried again');
});

test('a rejected wm size does not record itself as applied', async () => {
  const guest = fakeGuest({ failOn: (c) => c.startsWith('wm size ') });
  const scaler = scalerFor(guest);

  scaler.request({ width: 1600, height: 900 });
  await sleep(40);
  scaler.request({ width: 1600, height: 900 });
  await sleep(40);

  assert.equal(
    guest.calls.filter((c) => c === 'wm size 1600x900').length,
    2,
    'a failed apply is retried rather than assumed to have worked',
  );
});

test('reset hands the panel back and forgets the applied geometry', async () => {
  const guest = fakeGuest();
  const scaler = scalerFor(guest);

  scaler.request({ width: 1600, height: 900 });
  await sleep(40);
  await scaler.reset();

  assert.deepEqual(guest.calls.slice(-2), ['wm size reset', 'wm density reset']);
});

test('a resize scheduled before reset does not fire after it', async () => {
  const guest = fakeGuest();
  const scaler = scalerFor(guest);

  scaler.request({ width: 1600, height: 900 });
  await scaler.reset();
  await sleep(40);

  assert.ok(!guest.calls.includes('wm size 1600x900'));
});

test('disabled, it touches the guest not at all', async () => {
  const guest = fakeGuest();
  const scaler = scalerFor(guest);

  scaler.setEnabled(false);
  scaler.request({ width: 1600, height: 900 });
  await sleep(40);

  assert.equal(guest.calls.length, 0);
  assert.equal(scaler.isEnabled(), false);
});
