import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { readLpMetadata, findLogical } = loadDist('rom/lp.js');

const sha256 = (data) => createHash('sha256').update(data).digest();

/** `super` of Google's API 30 image, as measured: size, and each volume's byte offset and size. */
const SUPER_SIZE = 3229614080;
const REAL = [
  { name: 'system', offset: 1048576, size: 1078669312 },
  { name: 'system_ext', offset: 1080033280, size: 106766336 },
  { name: 'product', offset: 1186988032, size: 264716288 },
  { name: 'vendor', offset: 1452277760, size: 67837952 },
];

const realPartitions = () => REAL.map((part) => ({
  name: part.name,
  attributes: 1,
  extents: [{ sectors: part.size / 512, data: part.offset / 512 }],
}));

const PRIMARY = 12288;
const MAX_SIZE = 65536;
const SLOTS = 2;
const BACKUP = PRIMARY + MAX_SIZE * SLOTS;

/**
 * The metadata area of a `super` partition, built the way lpmake writes it: geometry and its
 * backup, then every slot's primary copy, then every slot's backup, with real SHA-256 checksums.
 * Only the metadata is materialised — the logical partitions' bytes are never read.
 */
function buildSuper({
  partitions = realPartitions(),
  metadataMaxSize = MAX_SIZE,
  slotCount = SLOTS,
  logicalBlockSize = 4096,
  minor = 0,
  firstLogicalSector = 2048,
} = {}) {
  const buffer = Buffer.alloc(PRIMARY + 2 * metadataMaxSize * slotCount);

  const geometry = Buffer.alloc(52);
  geometry.writeUInt32LE(0x616c4467, 0);
  geometry.writeUInt32LE(52, 4);
  geometry.writeUInt32LE(metadataMaxSize, 40);
  geometry.writeUInt32LE(slotCount, 44);
  geometry.writeUInt32LE(logicalBlockSize, 48);
  sha256(geometry).copy(geometry, 8);
  geometry.copy(buffer, 4096);
  geometry.copy(buffer, 8192);

  const partitionTable = Buffer.alloc(52 * partitions.length);
  const extents = [];
  partitions.forEach((part, i) => {
    const entry = partitionTable.subarray(i * 52, (i + 1) * 52);
    entry.write(part.name, 0, 36, 'latin1');
    entry.writeUInt32LE(part.attributes ?? 1, 36);
    entry.writeUInt32LE(extents.length, 40);
    entry.writeUInt32LE(part.extents.length, 44);
    entry.writeUInt32LE(0, 48);
    extents.push(...part.extents);
  });

  const extentTable = Buffer.alloc(24 * extents.length);
  extents.forEach((extent, i) => {
    extentTable.writeBigUInt64LE(BigInt(extent.sectors), i * 24);
    extentTable.writeUInt32LE(extent.type ?? 0, i * 24 + 8);
    extentTable.writeBigUInt64LE(BigInt(extent.data), i * 24 + 12);
    extentTable.writeUInt32LE(extent.source ?? 0, i * 24 + 20);
  });

  const groupTable = Buffer.alloc(48);
  groupTable.write('default', 0, 'latin1');

  const deviceTable = Buffer.alloc(64);
  deviceTable.writeBigUInt64LE(BigInt(firstLogicalSector), 0);
  deviceTable.writeUInt32LE(1048576, 8);
  deviceTable.writeBigUInt64LE(BigInt(SUPER_SIZE), 16);
  deviceTable.write('super', 24, 'latin1');

  const tables = Buffer.concat([partitionTable, extentTable, groupTable, deviceTable]);
  const headerSize = minor >= 2 ? 256 : 128;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(0x414c5030, 0);
  header.writeUInt16LE(10, 4);
  header.writeUInt16LE(minor, 6);
  header.writeUInt32LE(headerSize, 8);
  header.writeUInt32LE(tables.length, 44);
  sha256(tables).copy(header, 48);
  const descriptor = (at, offset, count, size) => {
    header.writeUInt32LE(offset, at);
    header.writeUInt32LE(count, at + 4);
    header.writeUInt32LE(size, at + 8);
  };
  descriptor(80, 0, partitions.length, 52);
  descriptor(92, partitionTable.length, extents.length, 24);
  descriptor(104, partitionTable.length + extentTable.length, 1, 48);
  descriptor(116, partitionTable.length + extentTable.length + groupTable.length, 1, 64);
  sha256(header).copy(header, 12);

  const slot = Buffer.concat([header, tables]);
  for (let s = 0; s < slotCount; s += 1) {
    slot.copy(buffer, PRIMARY + s * metadataMaxSize);
    slot.copy(buffer, PRIMARY + (slotCount + s) * metadataMaxSize);
  }
  return buffer;
}

const reader = (buffer) => (offset, length) => Buffer.from(buffer.subarray(offset, offset + length));
const read = (buffer, superSize = SUPER_SIZE) => readLpMetadata(reader(buffer), superSize);

test('reads the four volumes at their measured offsets', () => {
  const metadata = read(buildSuper());

  assert.equal(metadata.slotCount, SLOTS);
  assert.equal(metadata.metadataMaxSize, MAX_SIZE);
  assert.equal(metadata.source, 'primary');
  assert.deepEqual(metadata.skipped, []);
  assert.deepEqual(metadata.partitions, REAL.map((part) => ({ ...part, attributes: 1 })));
  // 2 MiB is where super starts in system.img; the design's table is in file offsets.
  assert.equal(2097152 + findLogical(metadata.partitions, 'system').offset, 3145728);
});

test('extents are 512-byte sectors, whatever logical_block_size says', () => {
  // The geometry's 4096-byte logical block is the allocation granule, not the extent unit. Using it
  // would put every volume eight times further in — into the next volume, or off the disk.
  const metadata = read(buildSuper({ logicalBlockSize: 4096 }));

  assert.equal(findLogical(metadata.partitions, 'system').offset, 2048 * 512);
});

test('the expanded 10.2 header is read too', () => {
  assert.equal(read(buildSuper({ minor: 2 })).partitions.length, 4);
});

test('a corrupt primary header falls back to the backup, and says so', () => {
  const buffer = buildSuper();
  buffer[PRIMARY + 44] ^= 0x01; // tables_size, covered by the header checksum

  const metadata = read(buffer);

  assert.equal(metadata.source, 'backup');
  assert.equal(metadata.partitions.length, 4);
  assert.match(metadata.skipped.join('\n'), /header checksum mismatch in primary slot 0/);
});

test('corrupt primary tables fall back to the backup', () => {
  const buffer = buildSuper();
  buffer[PRIMARY + 128] ^= 0x01; // first letter of "system"

  const metadata = read(buffer);

  assert.equal(metadata.source, 'backup');
  assert.equal(findLogical(metadata.partitions, 'system').size, 1078669312);
  assert.match(metadata.skipped.join('\n'), /tables checksum mismatch in primary slot 0/);
});

test('both copies corrupt throws both reasons', () => {
  const buffer = buildSuper();
  buffer[PRIMARY + 44] ^= 0x01;
  buffer[BACKUP + 128] ^= 0x01;

  assert.throws(
    () => read(buffer),
    /header checksum mismatch in primary slot 0.*tables checksum mismatch in backup slot 0/,
  );
});

test('a corrupt primary geometry falls back to the backup geometry', () => {
  const buffer = buildSuper();
  buffer[4096 + 40] ^= 0x01; // metadata_max_size

  const metadata = read(buffer);

  assert.equal(metadata.metadataMaxSize, MAX_SIZE);
  assert.match(metadata.skipped.join('\n'), /primary geometry checksum mismatch/);
});

test('both geometries corrupt is refused', () => {
  const buffer = buildSuper();
  buffer[4096 + 40] ^= 0x01;
  buffer.writeUInt32LE(0, 8192);

  assert.throws(() => read(buffer), /primary geometry checksum mismatch.*backup geometry magic/);
});

test('a partition with no extents is returned with size 0', () => {
  const partitions = [...realPartitions(), { name: 'odm', attributes: 1, extents: [] }];

  assert.deepEqual(findLogical(read(buildSuper({ partitions })).partitions, 'odm'), { name: 'odm', attributes: 1, offset: 0, size: 0 });
});

test('a missing logical partition names what is there', () => {
  const metadata = read(buildSuper());

  assert.throws(() => findLogical(metadata.partitions, 'odm'), /no logical partition named "odm".*"vendor"/);
});

// ── Refusals: each is a layout a single byte window cannot describe ─────────────────────────────

const withSystem = (change) => realPartitions().map((part) => (part.name === 'system' ? change(part) : part));

test('more than one extent is refused', () => {
  const partitions = withSystem((part) => ({
    ...part,
    extents: [{ sectors: 1024, data: 2048 }, { sectors: 1024, data: 4096 }],
  }));

  assert.throws(() => read(buildSuper({ partitions })), /"system" has 2 extents/);
});

test('a zero-fill extent is refused', () => {
  const partitions = withSystem((part) => ({ ...part, extents: [{ ...part.extents[0], type: 1 }] }));

  assert.throws(() => read(buildSuper({ partitions })), /"system" is a zero-fill extent/);
});

test('an extent on another block device is refused', () => {
  const partitions = withSystem((part) => ({ ...part, extents: [{ ...part.extents[0], source: 1 }] }));

  assert.throws(() => read(buildSuper({ partitions })), /"system" lives on block device 1/);
});

test('a SLOT_SUFFIXED partition is refused', () => {
  const partitions = withSystem((part) => ({ ...part, attributes: 1 | 2 }));

  assert.throws(() => read(buildSuper({ partitions })), /"system" is SLOT_SUFFIXED/);
});

test('attribute bits the metadata version does not define are refused', () => {
  const partitions = withSystem((part) => ({ ...part, attributes: 1 | 0x10 }));

  assert.throws(() => read(buildSuper({ partitions })), /"system" has attribute bits 0x00000010/);
});

test('a duplicated name is refused', () => {
  const partitions = [...realPartitions(), { name: 'vendor', attributes: 1, extents: [] }];

  assert.throws(() => read(buildSuper({ partitions })), /"vendor" is listed twice/);
});

test('an extent reaching past the end of super is refused', () => {
  assert.throws(() => read(buildSuper(), 1452277760 + 67837952 - 512), /"vendor" extent .* reaches past the end of super/);
});

test('overlapping partitions are refused', () => {
  const partitions = realPartitions();
  const systemEnd = REAL[0].offset + REAL[0].size;
  partitions[1].extents[0].data = (systemEnd - 4096) / 512; // system_ext now starts 4 KiB inside system

  assert.throws(() => read(buildSuper({ partitions })), /"system" .* and "system_ext" .* overlap/);
});

test('an extent inside the metadata area is refused', () => {
  const partitions = withSystem((part) => ({ ...part, extents: [{ sectors: 8, data: 0 }] }));

  assert.throws(() => read(buildSuper({ partitions })), /"system" starts at byte 0, inside the LP metadata area/);
});
