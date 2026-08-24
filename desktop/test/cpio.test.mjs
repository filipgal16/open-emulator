import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { parseCpio, buildCpio, replaceEntry, findEntry, isFile, isDirectory, isSymlink } =
  loadDist('engine/qemu/cpio.js');

const entry = (over = {}) => ({
  name: 'init', mode: 0o100755, data: Buffer.from('#!/bin/sh\n'),
  ino: 1, uid: 0, gid: 0, nlink: 1, mtime: 0,
  devmajor: 0, devminor: 0, rdevmajor: 0, rdevminor: 0, ...over,
});

test('an archive round-trips byte-for-byte in content', () => {
  const original = [
    entry(),
    entry({ name: 'etc/fstab', mode: 0o100644, data: Buffer.from('none / rootfs\n'), ino: 2 }),
    entry({ name: 'dev', mode: 0o040755, data: Buffer.alloc(0), ino: 3 }),
  ];

  const parsed = parseCpio(buildCpio(original));

  assert.equal(parsed.length, 3);
  for (let i = 0; i < original.length; i += 1) {
    assert.equal(parsed[i].name, original[i].name);
    assert.equal(parsed[i].mode, original[i].mode, `${original[i].name} mode`);
    assert.deepEqual(parsed[i].data, original[i].data);
  }
});

test('file modes survive, including the executable bit on init', () => {
  // The whole point of editing in memory rather than unpacking to disk: a round trip through the
  // filesystem loses modes unless every flag is right, and an init without +x does not boot.
  const parsed = parseCpio(buildCpio([entry({ mode: 0o100755 })]));

  assert.equal(parsed[0].mode & 0o777, 0o755);
  assert.ok(isFile(parsed[0]));
});

test('directories and symlinks keep their type bits', () => {
  const parsed = parseCpio(buildCpio([
    entry({ name: 'sbin', mode: 0o040755, data: Buffer.alloc(0) }),
    entry({ name: 'bin/sh', mode: 0o120777, data: Buffer.from('busybox') }),
  ]));

  assert.ok(isDirectory(parsed[0]), 'a directory must not become a regular file');
  assert.ok(isSymlink(parsed[1]), 'a symlink target is its data — losing the type breaks the link');
  assert.equal(parsed[1].data.toString(), 'busybox');
});

test('names of every length are handled, which is where padding goes wrong', () => {
  // The header is padded to a 4-byte boundary counting from its own start, so a name whose length
  // lands on each residue exercises all four cases. Getting this wrong misaligns everything after.
  const names = ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg'];
  const parsed = parseCpio(buildCpio(names.map((name, i) => entry({ name, ino: i, data: Buffer.from(name) }))));

  assert.deepEqual(parsed.map((e) => e.name), names);
  for (const e of parsed) assert.equal(e.data.toString(), e.name, `${e.name} data misaligned`);
});

test('data of every length is handled too', () => {
  const parsed = parseCpio(buildCpio(
    [0, 1, 2, 3, 4, 5].map((n, i) => entry({ name: `f${n}`, ino: i, data: Buffer.alloc(n, 0x41) })),
  ));

  for (let n = 0; n <= 5; n += 1) {
    assert.equal(parsed[n].data.length, n, `entry with ${n} bytes`);
  }
});

test('the archive is terminated so the kernel stops reading', () => {
  // Without the TRAILER entry the kernel's unpacker runs past the end and reports a corrupt
  // initramfs — which presents as a guest that will not boot, with no mention of cpio anywhere.
  const built = buildCpio([entry()]);

  assert.ok(built.includes(Buffer.from('TRAILER!!!')));
  assert.equal(parseCpio(built).length, 1, 'and the trailer is not returned as an entry');
});

test('the result is padded to a 512-byte block', () => {
  assert.equal(buildCpio([entry()]).length % 512, 0);
});

test('editing an entry leaves every other entry untouched', () => {
  const entries = parseCpio(buildCpio([
    entry({ name: 'init', data: Buffer.from('line1\nro.setupwizard.mode=DISABLED\nline3\n') }),
    entry({ name: 'other', mode: 0o100644, data: Buffer.from('unchanged'), ino: 2 }),
  ]));

  const edited = replaceEntry(entries, 'init', (prev) =>
    Buffer.from(prev.toString().replace('DISABLED\n', 'DISABLED\nservice.adb.tcp.port=5555\n')));

  assert.equal(edited, true);
  const round = parseCpio(buildCpio(entries));
  assert.match(findEntry(round, 'init').data.toString(), /service\.adb\.tcp\.port=5555/);
  assert.equal(findEntry(round, 'other').data.toString(), 'unchanged');
  assert.equal(findEntry(round, 'other').mode, 0o100644);
});

test('editing an absent entry reports failure rather than inventing one', () => {
  const entries = parseCpio(buildCpio([entry()]));

  assert.equal(replaceEntry(entries, 'nope', () => Buffer.from('x')), false);
  assert.equal(findEntry(entries, 'nope'), null);
  assert.equal(entries.length, 1);
});

test('a non-cpio buffer is rejected with a useful message', () => {
  assert.throws(() => parseCpio(Buffer.from('this is not an archive at all, not even close')),
    /not a newc cpio archive/);
});

test('an empty buffer yields no entries rather than throwing', () => {
  assert.deepEqual(parseCpio(Buffer.alloc(0)), []);
});

test('a truncated archive is rejected rather than read as empty', () => {
  // The dangerous case: a failed gunzip yields a short buffer, and returning [] would repack an
  // empty initrd that boots to nothing with no error pointing at the cause.
  const built = buildCpio([entry()]);

  assert.throws(() => parseCpio(built.subarray(0, 40)), /not a newc cpio archive/);
});
