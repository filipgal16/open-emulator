import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { loadDist } from '../helpers.mjs';

const { readGpt, findPartition } = loadDist('rom/gpt.js');

/** Any non-zero partition type GUID marks an entry as used; this is Microsoft basic data. */
const TYPE_GUID = Buffer.from('a2a0d0ebe5b9334487c068b6b72699c7', 'hex');

/** The two partitions of Google's API 30 `system.img`, as measured. */
const REAL = [
  { name: 'vbmeta', firstLba: 2048, lastLba: 4095 },
  { name: 'super', firstLba: 4096, lastLba: 6311935 },
];

/**
 * A disk laid out the way sgdisk does it: protective MBR, header at LBA 1, 128 entries of 128
 * bytes from LBA 2, CRCs computed for real. Only the table is materialised — the partitions' own
 * sectors are never read, so the buffer ends at the first usable LBA.
 */
function buildDisk(partitions, { sectorSize = 512, numEntries = 128, entrySize = 128, lastUsable = 6313950 } = {}) {
  const entriesLba = 2;
  const firstUsable = entriesLba + Math.ceil((numEntries * entrySize) / sectorSize);
  const disk = Buffer.alloc(firstUsable * sectorSize);

  disk[446 + 4] = 0xee;
  disk.writeUInt32LE(1, 446 + 8);
  disk.writeUInt32LE(0xffffffff, 446 + 12);
  disk.writeUInt16LE(0xaa55, 510);

  const entries = Buffer.alloc(numEntries * entrySize);
  partitions.forEach((part, i) => {
    const slot = part.slot ?? i;
    const entry = entries.subarray(slot * entrySize, (slot + 1) * entrySize);
    TYPE_GUID.copy(entry, 0);
    entry.writeUInt32LE(i + 1, 16);
    entry.writeBigUInt64LE(BigInt(part.firstLba), 32);
    entry.writeBigUInt64LE(BigInt(part.lastLba), 40);
    Buffer.from(part.name, 'utf16le').copy(entry, 56);
  });
  entries.copy(disk, entriesLba * sectorSize);

  const header = disk.subarray(sectorSize, sectorSize + 92);
  header.write('EFI PART', 0, 'latin1');
  header.writeUInt32LE(0x00010000, 8);
  header.writeUInt32LE(92, 12);
  header.writeBigUInt64LE(1n, 24);
  header.writeBigUInt64LE(BigInt(lastUsable + 33), 32);
  header.writeBigUInt64LE(BigInt(firstUsable), 40);
  header.writeBigUInt64LE(BigInt(lastUsable), 48);
  header.fill(0x5a, 56, 72);
  header.writeBigUInt64LE(BigInt(entriesLba), 72);
  header.writeUInt32LE(numEntries, 80);
  header.writeUInt32LE(entrySize, 84);
  header.writeUInt32LE(crc32(entries), 88);
  header.writeUInt32LE(crc32(header), 16);
  return disk;
}

const reader = (disk) => (offset, length) => Buffer.from(disk.subarray(offset, offset + length));

test('finds vbmeta and super at their byte offsets', () => {
  const parts = readGpt(reader(buildDisk(REAL)));

  assert.equal(parts.length, 2);
  const vbmeta = findPartition(parts, 'vbmeta');
  const superPart = findPartition(parts, 'super');
  assert.deepEqual(vbmeta, { name: 'vbmeta', offset: 1048576, size: 1048576, firstLba: 2048, lastLba: 4095 });
  assert.equal(superPart.offset, 2097152);
  assert.equal(superPart.size, (6311935 - 4096 + 1) * 512, 'lastLba is inclusive');
});

test('unused entries between used ones are skipped', () => {
  const parts = readGpt(reader(buildDisk([
    { ...REAL[0], slot: 0 },
    { ...REAL[1], slot: 7 },
  ])));

  assert.deepEqual(parts.map((part) => part.name), ['vbmeta', 'super']);
});

test('byte offsets follow the sector size', () => {
  const parts = readGpt(reader(buildDisk([{ name: 'super', firstLba: 256, lastLba: 511 }], { sectorSize: 4096, lastUsable: 100000 })), 4096);

  assert.equal(parts[0].offset, 256 * 4096);
  assert.equal(parts[0].size, 256 * 4096);
});

test('a flipped byte in the header is refused', () => {
  const disk = buildDisk(REAL);
  disk[512 + 60] ^= 0x01; // inside the disk GUID, covered by the header CRC

  assert.throws(() => readGpt(reader(disk)), /GPT header CRC32 mismatch/);
});

test('a flipped byte in the entry array is refused', () => {
  // The dangerous case: a changed LBA in an entry would move every write the builder makes.
  const disk = buildDisk(REAL);
  disk[2 * 512 + 128 + 32] ^= 0x01; // super's first LBA

  assert.throws(() => readGpt(reader(disk)), /GPT partition entry array CRC32 mismatch/);
});

test('a disk without the EFI PART signature is refused', () => {
  const disk = buildDisk(REAL);
  disk.write('NOT PART', 512, 'latin1');

  assert.throws(() => readGpt(reader(disk)), /no GPT/);
});

test('a truncated disk is refused rather than read short', () => {
  const disk = buildDisk(REAL);

  assert.throws(() => readGpt(reader(disk.subarray(0, 4 * 512))), /short read of the GPT partition entry array/);
});

test('overlapping partitions are refused', () => {
  const disk = buildDisk([
    { name: 'vbmeta', firstLba: 2048, lastLba: 4096 },
    { name: 'super', firstLba: 4096, lastLba: 8191 },
  ]);

  assert.throws(() => readGpt(reader(disk)), /"vbmeta".*"super".*overlap/);
});

test('a partition outside the usable range is refused', () => {
  const disk = buildDisk([{ name: 'super', firstLba: 4096, lastLba: 7000000 }]);

  assert.throws(() => readGpt(reader(disk)), /"super".*outside the usable range/);
});

test('a duplicated name is refused rather than resolved by position', () => {
  const parts = readGpt(reader(buildDisk([
    { name: 'super', firstLba: 2048, lastLba: 4095 },
    { name: 'super', firstLba: 4096, lastLba: 8191 },
  ])));

  assert.equal(parts.length, 2, 'the table itself is valid');
  assert.throws(() => findPartition(parts, 'super'), /2 partitions named "super"/);
});

test('a missing partition names what is there', () => {
  const parts = readGpt(reader(buildDisk(REAL)));

  assert.throws(() => findPartition(parts, 'userdata'), /no GPT partition named "userdata" \(partitions: "vbmeta", "super"\)/);
});
