import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { DESKTOP_ROOT, loadDist, withTempDir } from '../helpers.mjs';

const { Ext4Volume, BufferDisk, FileDisk } = loadDist('rom/ext4.js');

// A 24 MiB volume with the stock system volumes' exact feature set; see make-ext4-fixture.sh for
// what it contains and why. Decompressed fresh for every test so no test sees another's edits.
const FIXTURE = gunzipSync(readFileSync(path.join(DESKTOP_ROOT, 'test', 'fixtures', 'rom', 'ext4-fixture.img.gz')));
const LABEL = 'u:object_r:system_file:s0';
const BS = 4096;

const fresh = () => Buffer.from(FIXTURE);
const open = (buffer, options = {}) => Ext4Volume.open(new BufferDisk(buffer), { writable: true, ...options });

/** Flush, then check what was written through a brand-new reader — never the editor's own caches. */
function reopenAndVerify(buffer, volume) {
  volume.flush();
  const again = Ext4Volume.open(new BufferDisk(buffer));
  const report = again.verify();
  assert.deepEqual(report.problems, [], 'fsck-lite found problems');
  return again;
}

const bytes = (char, count) => Buffer.alloc(count, char);

test('the pristine fixture opens and verifies clean', () => {
  const volume = Ext4Volume.open(new BufferDisk(fresh()));
  assert.equal(volume.label, 'system');
  assert.equal(volume.blockSize, BS);
  assert.equal(volume.sharedBlocks, true);
  assert.deepEqual(volume.verify().problems, []);
});

test('reads files, a hashed directory, a symlink and labels', () => {
  const volume = Ext4Volume.open(new BufferDisk(fresh()));
  assert.match(volume.readFile('/system/build.prop').toString('utf8'), /^ro\.build\.display\.id=fixture-1\n/);
  assert.deepEqual(volume.readFile('/system/etc/large.bin'), bytes('L', 40 * BS));

  const many = volume.lookup('/system/etc/many');
  assert.ok(volume.stat(many).flags & 0x1000, 'fixture directory should be htree-indexed');
  const names = volume.readDir(many).map((e) => e.name);
  assert.equal(names.length, 302);
  assert.deepEqual(names.slice(0, 2), ['.', '..']);
  assert.ok(names.includes('a-deliberately-long-file-name-to-fill-directory-blocks-299.txt'));

  assert.equal(volume.readFile('/system/build.prop.link').toString(), '/system/build.prop');
  assert.equal(volume.selinuxLabel(volume.lookup('/system/build.prop')), LABEL);
  assert.equal(volume.lookup('/system/nope'), null);
});

test('removing a tree frees what it owned and keeps a block another file shares', () => {
  const buffer = fresh();
  const volume = open(buffer);
  const beforeBlocks = volume.freeBlocks;
  const beforeInodes = volume.freeInodes;
  const appLinks = volume.stat(volume.lookup('/system/app')).links;

  const report = volume.removeTree('/system/app/Bloat');

  // Bloat/, Bloat.apk, oat/, oat/x86_64/, Bloat.odex.
  assert.equal(report.inodesFreed, 5);
  // Bloat.apk's first two blocks are also Shared.apk's.
  assert.equal(report.blocksStillShared, 2);
  // Bloat.apk's third block, the odex, and one block for each of the three directories.
  assert.equal(report.blocksFreed, 5);

  const after = reopenAndVerify(buffer, volume);
  assert.equal(after.freeBlocks, beforeBlocks + 5);
  assert.equal(after.freeInodes, beforeInodes + 5);
  assert.equal(after.lookup('/system/app/Bloat'), null);
  assert.equal(after.stat(after.lookup('/system/app')).links, appLinks - 1);
  assert.deepEqual(after.readFile('/system/app/Keep/Shared.apk'), bytes('B', 2 * BS));

  // The last reference goes, so the shared blocks are finally freed.
  const again = open(buffer);
  const removed = again.removeTree('/system/app/Keep/Shared.apk');
  assert.equal(removed.blocksFreed, 2);
  assert.equal(reopenAndVerify(buffer, again).freeBlocks, beforeBlocks + 7);
});

test('an entry removed from a hashed directory leaves it valid', () => {
  const buffer = fresh();
  const volume = open(buffer);
  volume.removeTree('/system/etc/many/a-deliberately-long-file-name-to-fill-directory-blocks-150.txt');
  const after = reopenAndVerify(buffer, volume);
  assert.equal(after.readDir('/system/etc/many').length, 301);
});

test('creates a labelled directory and file the way the stock images lay them out', () => {
  const buffer = fresh();
  const volume = open(buffer);
  const mediaLinks = volume.stat(volume.lookup('/system/media')).links;
  const content = Buffer.concat([bytes('W', 3 * BS), Buffer.from('tail')]);

  volume.mkdir('/system/media/openemu', { mode: 0o755, selinux: LABEL });
  const ino = volume.createFile('/system/media/openemu/wallpaper.png', content, { mode: 0o644, selinux: LABEL });

  const after = reopenAndVerify(buffer, volume);
  assert.deepEqual(after.readFile('/system/media/openemu/wallpaper.png'), content);
  const stat = after.stat(ino);
  assert.equal(stat.mode, 0o100644);
  assert.equal(stat.links, 1);
  assert.equal(stat.uid, 0);
  assert.equal(after.stat(after.lookup('/system/media/openemu')).links, 2);
  assert.equal(after.stat(after.lookup('/system/media')).links, mediaLinks + 1);
  assert.equal(after.selinuxLabel(ino), LABEL);

  // Byte-for-byte what e2fsdroid wrote for /system/build.prop on Google's image: extra_isize 32,
  // the magic, one entry (name_len 7, index 6, value at 64, size 26, hash 0), "selinux", the
  // terminator, and the value packed against the end of the inode.
  const raw = after.rawInode(ino);
  assert.equal(raw.readUInt16LE(0x80), 32);
  const expected = Buffer.alloc(96);
  expected.writeUInt32LE(0xea020000, 0);
  expected.writeUInt8(7, 4);
  expected.writeUInt8(6, 5);
  expected.writeUInt16LE(64, 6);
  expected.writeUInt32LE(26, 12);
  expected.write('selinux', 20, 'latin1');
  expected.write(`${LABEL}\0`, 68, 'latin1');
  assert.deepEqual(raw.subarray(160, 256), expected);
});

test('allocates from a BLOCK_UNINIT group and an INODE_UNINIT group correctly', () => {
  const buffer = fresh();
  const volume = open(buffer);
  // More than any initialised group has free in one run, so it has to come from an uninitialised one.
  const big = bytes('Z', 1015 * BS);
  const ino = volume.createFile('/system/media/big.bin', big, { mode: 0o644, selinux: LABEL });
  const [extent] = volume.extents(ino).extents;
  assert.equal(extent.length, 1015);
  // Groups 1, 2 and 4 are the BLOCK_UNINIT ones in the fixture.
  assert.ok([1, 2, 4].includes(Math.floor(extent.start / 1024)), `landed in group ${Math.floor(extent.start / 1024)}`);

  // Group 3 has 55 free inodes; the 56th onward come from INODE_UNINIT groups.
  volume.mkdir('/system/media/lots', { mode: 0o755, selinux: LABEL });
  const inodes = [];
  for (let i = 0; i < 60; i += 1) {
    inodes.push(volume.createFile(`/system/media/lots/f${i}`, Buffer.alloc(0), { mode: 0o644, selinux: LABEL }));
  }
  assert.ok(inodes.some((n) => Math.floor((n - 1) / 96) >= 4), 'expected some inodes from groups 4-5');

  const after = reopenAndVerify(buffer, volume);
  assert.deepEqual(after.readFile('/system/media/big.bin'), big);
  assert.equal(after.readDir('/system/media/lots').length, 62);
});

test('a directory grows by a block when its entries no longer fit', () => {
  const buffer = fresh();
  const volume = open(buffer);
  volume.mkdir('/system/media/wide', { mode: 0o755, selinux: LABEL });
  for (let i = 0; i < 40; i += 1) {
    volume.createFile(`/system/media/wide/${String(i).padStart(3, '0')}-${'n'.repeat(190)}`, Buffer.from(`${i}`), {
      mode: 0o644,
      selinux: LABEL,
    });
  }
  const after = reopenAndVerify(buffer, volume);
  const dir = after.lookup('/system/media/wide');
  assert.ok(after.stat(dir).size > BS, 'directory should span more than one block');
  assert.equal(after.readDir(dir).length, 42);
  assert.equal(after.readFile(`/system/media/wide/007-${'n'.repeat(190)}`).toString(), '7');
});

test('replace rewrites an exclusively owned file in place, and keeps its label', () => {
  const buffer = fresh();
  const volume = open(buffer);
  const ino = volume.lookup('/system/build.prop');
  const [before] = volume.extents(ino).extents;
  const freeBefore = volume.freeBlocks;

  volume.replaceFile('/system/build.prop', Buffer.from('ro.build.display.id=openemu\n'));

  const after = reopenAndVerify(buffer, volume);
  assert.equal(after.lookup('/system/build.prop'), ino);
  assert.equal(after.readFile(ino).toString(), 'ro.build.display.id=openemu\n');
  assert.equal(after.extents(ino).extents[0].start, before.start, 'should have been written in place');
  assert.equal(after.freeBlocks, freeBefore, 'in place allocates nothing');
  assert.equal(after.selinuxLabel(ino), LABEL);
});

test('replace reallocates when the content grows, and never writes a shared block', () => {
  const buffer = fresh();
  const volume = open(buffer);

  const grown = bytes('g', 3 * BS + 10);
  volume.replaceFile('/system/build.prop', grown);

  // Shared.apk's blocks also back Bloat.apk: replacing it must leave Bloat.apk's bytes alone.
  const replacement = bytes('R', 2 * BS);
  volume.replaceFile('/system/app/Keep/Shared.apk', replacement);

  const after = reopenAndVerify(buffer, volume);
  assert.deepEqual(after.readFile('/system/build.prop'), grown);
  assert.deepEqual(after.readFile('/system/app/Keep/Shared.apk'), replacement);
  assert.deepEqual(after.readFile('/system/app/Bloat/Bloat.apk'), bytes('B', 3 * BS));
});

test('backup superblocks and descriptor tables follow the primary', () => {
  const buffer = fresh();
  const volume = open(buffer);
  volume.removeTree('/system/app/Bloat');
  volume.flush();

  const primary = buffer.subarray(1024, 2048);
  for (const group of [1, 3, 5]) {
    const backup = buffer.subarray(group * 1024 * BS, group * 1024 * BS + 1024);
    assert.equal(backup.readUInt16LE(0x5a), group, `group ${group} records its own number`);
    assert.equal(backup.readUInt32LE(0x0c), primary.readUInt32LE(0x0c), `group ${group} free blocks`);
    assert.equal(backup.readUInt32LE(0x10), primary.readUInt32LE(0x10), `group ${group} free inodes`);
    assert.deepEqual(buffer.subarray((group * 1024 + 1) * BS, (group * 1024 + 1) * BS + 6 * 32), buffer.subarray(BS, BS + 6 * 32));
  }
});

test('the same edits on the same input produce the same bytes', () => {
  const run = () => {
    const buffer = fresh();
    const volume = open(buffer, { epoch: 1234567890 });
    volume.removeTree('/system/app/Bloat');
    volume.replaceFile('/system/build.prop', Buffer.from('x=1\n'));
    volume.mkdir('/system/media/openemu', { mode: 0o755, selinux: LABEL });
    volume.createFile('/system/media/openemu/a', bytes('a', 5000), { mode: 0o644, selinux: LABEL });
    volume.flush();
    return buffer;
  };
  assert.ok(run().equals(run()));
});

test('refuses what it cannot do safely', () => {
  const volume = open(fresh());
  assert.throws(() => volume.createFile('/system/etc/many/new.txt', Buffer.from('x'), { mode: 0o644, selinux: LABEL }), /hashed/);
  assert.throws(() => volume.createFile('/system/build.prop', Buffer.from('x'), { mode: 0o644, selinux: LABEL }), /already exists/);
  assert.throws(() => volume.createFile('/system/media/x', Buffer.from('x'), { mode: 0o644, selinux: '' }), /selinux/);
  assert.throws(() => volume.removeTree('/'), /root/);
  assert.throws(() => volume.removeTree('/system/../system'), /normalised/);

  const readOnly = Ext4Volume.open(new BufferDisk(fresh()));
  assert.throws(() => readOnly.removeTree('/system/app/Bloat'), /read-only/);
});

test('refuses volumes with features outside the stock set', () => {
  const withFeature = (offset, bit) => {
    const buffer = fresh();
    buffer.writeUInt32LE(buffer.readUInt32LE(1024 + offset) | bit, 1024 + offset);
    return buffer;
  };
  assert.throws(() => Ext4Volume.open(new BufferDisk(withFeature(0x60, 0x80))), /64bit/);
  assert.throws(() => Ext4Volume.open(new BufferDisk(withFeature(0x5c, 0x4))), /has_journal/);
  assert.throws(() => Ext4Volume.open(new BufferDisk(withFeature(0x64, 0x400))), /metadata_csum/);

  const orphaned = fresh();
  orphaned.writeUInt32LE(12, 1024 + 0xe8);
  assert.throws(() => Ext4Volume.open(new BufferDisk(orphaned)), /orphan/);

  const damaged = fresh();
  damaged[BS + 0x0c] ^= 0xff;
  assert.throws(() => Ext4Volume.open(new BufferDisk(damaged)), /checksum/);
});

test('a file window keeps every access inside the partition', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'disk.img');
    const fd = openSync(file, 'w+');
    try {
      // The volume sits 1 MiB into the file, like a partition inside system.img.
      writeSync(fd, Buffer.alloc(1024 * 1024, 0xaa), 0, 1024 * 1024, 0);
      writeSync(fd, FIXTURE, 0, FIXTURE.length, 1024 * 1024);
      const disk = new FileDisk(fd, 1024 * 1024, FIXTURE.length, true);
      const volume = Ext4Volume.open(disk, { writable: true });
      assert.equal(volume.readFile('/system/build.prop.link').toString(), '/system/build.prop');
      assert.throws(() => disk.write(FIXTURE.length - 1, Buffer.alloc(2)), /outside/);
      assert.throws(() => disk.read(-1, 1), /outside/);
    } finally {
      closeSync(fd);
    }
  });
});
