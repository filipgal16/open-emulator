import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { expandHome } = loadDist('wsl-bridge.js');

/**
 * These guard two bugs that both failed *silently*, which is what made them expensive.
 *
 *   `cd '~/open-emulator'`     single quotes switch off tilde expansion, so bash looks for a
 *                              directory literally named `~`. With `mkdir -p` it creates one,
 *                              relative to whatever directory the process inherited. A packaged
 *                              build made `…/win-unpacked/~/open-emulator` beside the installed
 *                              app and started re-downloading the Android SDK into it — 2.2 GB
 *                              across two junk trees before anyone noticed.
 *
 *   `cd "$HOME/open-emulator"` `$HOME` is empty in the login shell WSL spawns, and `cd ""`
 *                              returns success without moving. Every later command then ran in
 *                              the wrong directory while reporting no error at all.
 *
 * So the home directory is resolved out of band (from the passwd database, not the environment)
 * and substituted here, leaving an ordinary absolute path.
 */
test('a tilde path resolves against the real home directory', () => {
  assert.equal(expandHome('~/open-emulator', '/root'), '/root/open-emulator');
  assert.equal(expandHome('~', '/root'), '/root');
  assert.equal(expandHome('~/a/b', '/home/filip'), '/home/filip/a/b');
});

test('a trailing slash on home does not double up', () => {
  assert.equal(expandHome('~/open-emulator', '/root/'), '/root/open-emulator');
  assert.equal(expandHome('~', '/root//'), '/root');
});

test('an absolute path is returned untouched', () => {
  assert.equal(expandHome('/root/open-emulator', '/home/other'), '/root/open-emulator');
  assert.equal(expandHome('/opt/oe', '/root'), '/opt/oe');
});

test('a path that merely contains a tilde is not a home path', () => {
  assert.equal(expandHome('/opt/~backup/oe', '/root'), '/opt/~backup/oe');
  assert.equal(expandHome('~user/oe', '/root'), '~user/oe', 'other-user tilde is unsupported, left alone');
});

test('the result is always absolute, which is what makes it safe to single-quote', () => {
  for (const input of ['~', '~/open-emulator', '/root/open-emulator']) {
    assert.ok(expandHome(input, '/root').startsWith('/'), `not absolute: ${input}`);
  }
});
