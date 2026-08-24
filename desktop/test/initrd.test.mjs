import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { patchInitScript, patchInitrd, InitrdPatchError, ADB_TCP_PORT } = loadDist('engine/qemu/initrd.js');
const { buildCpio, parseCpio, findEntry } = loadDist('engine/qemu/cpio.js');

// A believable slice of the real Android-x86 init: the anchor sits inside a block that is already
// editing default.prop, which is exactly why it is the right place to insert.
const INIT = [
  '#!/bin/sh',
  'mount_data()',
  '{',
  '\techo "mounting data"',
  '}',
  '',
  'setup_wizard()',
  '{',
  '\techo ro.setupwizard.mode=DISABLED >> default.prop',
  '\techo "wizard disabled"',
  '}',
  '',
  'exec /init',
].join('\n');

const entry = (name, data, mode = 0o100755) => ({
  name, mode, data: Buffer.from(data),
  ino: 1, uid: 0, gid: 0, nlink: 1, mtime: 0,
  devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0,
});

const image = (entries) => gzipSync(buildCpio(entries));

test('the patch lands immediately after the anchor', () => {
  const out = patchInitScript(INIT).split('\n');
  const anchor = out.findIndex((l) => l.includes('ro.setupwizard.mode=DISABLED'));

  assert.ok(anchor !== -1);
  assert.match(out.slice(anchor, anchor + 8).join('\n'), /service\.adb\.tcp\.port=5555/);
});

test('adb authentication is disabled in the same edit', () => {
  // Otherwise the first connection waits for a key prompt on a screen nobody is looking at.
  const out = patchInitScript(INIT);

  assert.match(out, /ro\.adb\.secure=0/);
  assert.match(out, /ro\.secure=0/);
});

test('existing assignments are stripped before the new ones are appended', () => {
  // default.prop is read top to bottom and a later duplicate does not reliably win, so leaving the
  // original would make the result depend on Android's load order rather than on this edit.
  assert.match(patchInitScript(INIT), /grep -v -E .*service\\.adb\\.tcp\\.port/);
});

test('patching twice is a no-op rather than stacking duplicate blocks', () => {
  const once = patchInitScript(INIT);

  assert.equal(patchInitScript(once), once);
  assert.equal(once.match(/service\.adb\.tcp\.port=5555/g).length, 1);
});

test('a build without the anchor fails loudly, naming what it could not find', () => {
  // A silently unpatched initrd boots a guest that works perfectly and is simply unreachable —
  // a far worse failure than refusing here.
  assert.throws(() => patchInitScript('#!/bin/sh\nexec /init\n'),
    /could not find "ro\.setupwizard\.mode=DISABLED"/);
});

test('a custom port is honoured', () => {
  assert.match(patchInitScript(INIT, 5599), /service\.adb\.tcp\.port=5599/);
  assert.equal(ADB_TCP_PORT, 5555);
});

// ── The whole image ────────────────────────────────────────────────────────────────────────────

test('a real initrd round-trips, patched, with every other entry intact', () => {
  const result = patchInitrd(image([
    entry('init', INIT),
    entry('etc/fstab', 'none / rootfs\n', 0o100644),
    entry('sbin', '', 0o040755),
  ]));

  const entries = parseCpio(gunzipSync(result.image));
  assert.equal(result.entryCount, 3);
  assert.equal(result.alreadyPatched, false);
  assert.match(findEntry(entries, 'init').data.toString(), /service\.adb\.tcp\.port=5555/);
  assert.equal(findEntry(entries, 'etc/fstab').data.toString(), 'none / rootfs\n');
});

test("init keeps its executable bit, which the kernel requires", () => {
  const result = patchInitrd(image([entry('init', INIT, 0o100755)]));
  const init = findEntry(parseCpio(gunzipSync(result.image)), 'init');

  assert.equal(init.mode & 0o111, 0o111, 'an init without +x does not boot');
});

test('the output is gzip, so QEMU can load it directly', () => {
  const out = patchInitrd(image([entry('init', INIT)])).image;

  assert.equal(out[0], 0x1f);
  assert.equal(out[1], 0x8b);
});

test('re-patching an already-patched image is reported and stays valid', () => {
  const once = patchInitrd(image([entry('init', INIT)]));
  const twice = patchInitrd(once.image);

  assert.equal(twice.alreadyPatched, true);
  const init = findEntry(parseCpio(gunzipSync(twice.image)), 'init').data.toString();
  assert.equal(init.match(/service\.adb\.tcp\.port=5555/g).length, 1, 'no duplicate blocks');
});

test('an image with no init is refused', () => {
  assert.throws(() => patchInitrd(image([entry('etc/fstab', 'x')])), /contains no init/);
});

test('data that is not gzip is refused with a clear reason', () => {
  assert.throws(() => patchInitrd(Buffer.from('not compressed at all')), /not gzip-compressed/);
});

test('the error type is distinguishable, so callers can report it usefully', () => {
  try {
    patchInitrd(Buffer.from('nope'));
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof InitrdPatchError);
  }
});
