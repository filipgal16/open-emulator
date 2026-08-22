import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { localProfileNames } = loadDist('setup-wizard.js');

test('the guest profiles this build ships are discovered', () => {
  const names = localProfileNames();

  // These are what the shell and its docs refer to by name; the Store's Play tab is useless
  // without `play`, and the wizard uses this list to notice a distro synced by an older build.
  for (const expected of ['fast', 'full', 'play']) {
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
