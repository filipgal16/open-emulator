import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { localProfileNames } = loadDist('setup-wizard.js');

test('the guest profiles this build ships are discovered', () => {
  const names = localProfileNames();

  // These are what the shell and its docs refer to by name; the Store's Play tab is useless
  // without `play`, and the wizard uses this list to notice a distro synced by an older build.
  for (const expected of ['openemu', 'fast', 'full', 'play']) {
    assert.ok(names.includes(expected), `missing profile "${expected}" (found: ${names.join(', ')})`);
  }
});

test('profile names are safe to interpolate into a shell command', () => {
  // The names end up inside `test -f '<remote>/android/profiles/<name>.env'` on the far side of
  // wsl.exe, so a filename is not something to pass through unchecked.
  for (const name of localProfileNames()) {
    assert.match(name, /^[a-z0-9_-]{1,32}$/, `unsafe profile name: ${name}`);
  }
});

// ── runAuto and deferred fixes ───────────────────────────────────────────────────────────────────

const { SetupRunner } = loadDist('setup-wizard.js');

const failing = (over = {}) => ({
  id: 'x',
  label: 'X',
  blocking: false,
  check: async () => ({ pass: false, detail: 'not yet' }),
  ...over,
});

test('runAuto runs the fix of a failing step by default', async () => {
  let fixed = false;
  const runner = new SetupRunner([failing({ fix: async () => { fixed = true; } })]);

  await runner.runAuto(() => {}, () => {});

  assert.equal(fixed, true);
});

test('a deferred step is checked but its fix is left for the background', async () => {
  // This is what lets the wizard hand the user into the app in seconds: provisioning's one-time
  // cold boot is deferred out of the blocking run and started in the background afterwards.
  let fixed = false;
  const runner = new SetupRunner([
    failing({ id: 'provisioned', deferFix: true, fix: async () => { fixed = true; } }),
  ]);

  const results = await runner.runAuto(() => {}, () => {});

  assert.equal(fixed, false, 'the deferred fix did not run inline');
  assert.equal(results[0].status, 'fail', 'it was still checked and reported honestly');
});

test('runFix still runs a deferred step on demand', async () => {
  // Deferring only removes it from the auto-run; the background trigger and the device panel both
  // reach it through runFix.
  let fixed = false;
  const runner = new SetupRunner([
    failing({ id: 'provisioned', deferFix: true, fix: async () => { fixed = true; } }),
  ]);

  await runner.runFix('provisioned', () => {}, () => {});

  assert.equal(fixed, true);
});
