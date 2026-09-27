import { createHash } from 'crypto';

/**
 * Android dynamic partitions — liblp metadata, format 10.x — read from the `super` partition.
 *
 * `system`, `system_ext`, `product` and `vendor` are not GPT partitions. They are regions of
 * `super` that first-stage init maps with device-mapper from this metadata, and the ROM builder
 * edits each one as a bounded window onto the image file. A wrong window means ext4 edits land in
 * the neighbouring volume or on the metadata itself, so everything is SHA-256-checked the way liblp
 * checks it before a single offset is used.
 *
 * Anything a single window cannot represent is refused by name rather than approximated: a
 * partition in several pieces, a zero-fill or non-linear target, an extent on a block device other
 * than `super`, and A/B slot suffixes (the emulator is a single-slot device; a suffixed partition
 * means a different image from the one this was measured on).
 *
 * Layout, from liblp's `metadata_format.h`: 4 KiB reserved, the geometry and its backup in 4 KiB
 * each, then `metadata_slot_count` primary metadata copies of `metadata_max_size` bytes, then as
 * many backups. Extents are always in 512-byte sectors, whatever `logical_block_size` says.
 */

const LP_SECTOR_SIZE = 512;
const RESERVED_BYTES = 4096;
const GEOMETRY_SLOT_BYTES = 4096;
const GEOMETRY_OFFSET = RESERVED_BYTES;
const BACKUP_GEOMETRY_OFFSET = RESERVED_BYTES + GEOMETRY_SLOT_BYTES;
const METADATA_OFFSET = RESERVED_BYTES + 2 * GEOMETRY_SLOT_BYTES;

const GEOMETRY_MAGIC = 0x616c4467;
const GEOMETRY_STRUCT_SIZE = 52;

const HEADER_MAGIC = 0x414c5030;
const MAJOR_VERSION = 10;
const MINOR_VERSION_MAX = 2;
/** Minor 0 and 1 have a 128-byte header; minor 2 expanded it to 256 (adding header flags). */
const HEADER_SIZE_V1_0 = 128;
const HEADER_SIZE_V1_2 = 256;

const ENTRY_SIZES = { partitions: 52, extents: 24, groups: 48, blockDevices: 64 } as const;

export const LP_PARTITION_ATTR_READONLY = 0x1;
export const LP_PARTITION_ATTR_SLOT_SUFFIXED = 0x2;
const LP_PARTITION_ATTR_UPDATED = 0x4;
const LP_PARTITION_ATTR_DISABLED = 0x8;
/** The attribute bits each minor version defines; liblp refuses any others, and so does this. */
const ATTRIBUTE_MASK_V0 = LP_PARTITION_ATTR_READONLY | LP_PARTITION_ATTR_SLOT_SUFFIXED;
const ATTRIBUTE_MASK_V1 = ATTRIBUTE_MASK_V0 | LP_PARTITION_ATTR_UPDATED | LP_PARTITION_ATTR_DISABLED;

const TARGET_TYPE_LINEAR = 0;
const TARGET_TYPE_ZERO = 1;

export interface LogicalPartition {
  name: string;
  attributes: number;
  /** Bytes from the start of `super`. 0 for a partition with no extents. */
  offset: number;
  /** Bytes. 0 for a partition with no extents. */
  size: number;
}

export interface LpMetadata {
  partitions: LogicalPartition[];
  slotCount: number;
  metadataMaxSize: number;
  /** Which metadata copy was used. */
  source: 'primary' | 'backup';
  /**
   * Why any copy (geometry or metadata) tried before the one used was rejected. Empty on a healthy
   * image; anything here is worth a log line, because the guest's liblp is falling back too.
   */
  skipped: string[];
}

interface Geometry {
  metadataMaxSize: number;
  slotCount: number;
  logicalBlockSize: number;
}

interface TableDescriptor {
  offset: number;
  count: number;
  entrySize: number;
}

interface ValidatedMetadata {
  minor: number;
  tables: Buffer;
  partitions: TableDescriptor;
  extents: TableDescriptor;
  groups: TableDescriptor;
  blockDevices: TableDescriptor;
}

type Reader = (offset: number, length: number, what: string) => Buffer;

/**
 * Reads the partition table out of `super`.
 *
 * `read` is relative to the start of `super`; `superSize` is its size in bytes (from the GPT), which
 * every extent must fit inside. Tries the primary copy of slot 0, then the backup. A copy that fails
 * its checksums is skipped with its reason kept; if none validates, every reason is thrown. A copy
 * that validates but describes something unsupported is refused outright — the backup of a valid
 * table is not a second opinion.
 */
export function readLpMetadata(read: (offset: number, length: number) => Buffer, superSize: number): LpMetadata {
  if (!Number.isSafeInteger(superSize) || superSize <= 0) {
    throw new Error(`super size ${superSize} is not a positive byte count`);
  }

  const readExactly: Reader = (offset, length, what) => {
    if (offset < 0 || offset + length > superSize) {
      throw new Error(`${what} at [${offset}, +${length}) lies outside super (${superSize} bytes)`);
    }
    const data = read(offset, length);
    if (data.length !== length) {
      throw new Error(`short read of ${what}: ${data.length} of ${length} bytes at offset ${offset}`);
    }
    return data;
  };

  const skipped: string[] = [];
  const geometry = readGeometry(readExactly, superSize, skipped);
  const { metadataMaxSize, slotCount } = geometry;

  // The metadata area ends after every slot's primary and backup copy; logical data starts after.
  const metadataEnd = METADATA_OFFSET + 2 * metadataMaxSize * slotCount;

  const copies = [
    { source: 'primary' as const, label: 'primary slot 0', offset: METADATA_OFFSET },
    { source: 'backup' as const, label: 'backup slot 0', offset: METADATA_OFFSET + metadataMaxSize * slotCount },
  ];

  const failures: string[] = [];
  for (const copy of copies) {
    let metadata: ValidatedMetadata;
    try {
      metadata = validateMetadata(readExactly(copy.offset, metadataMaxSize, `LP metadata ${copy.label}`), metadataMaxSize, copy.label);
    } catch (error) {
      failures.push((error as Error).message);
      continue;
    }
    const partitions = resolvePartitions(metadata, superSize, metadataEnd);
    return { partitions, slotCount, metadataMaxSize, source: copy.source, skipped: [...skipped, ...failures] };
  }

  throw new Error(`no valid LP metadata in super: ${failures.join('; ')}`);
}

/** The logical partition called `name`. Names are unique — `readLpMetadata` refuses duplicates. */
export function findLogical(parts: LogicalPartition[], name: string): LogicalPartition {
  const found = parts.find((part) => part.name === name);
  if (!found) {
    const names = parts.map((part) => `"${part.name}"`).join(', ') || 'none';
    throw new Error(`no logical partition named "${name}" in super (partitions: ${names})`);
  }
  return found;
}

// ── Geometry ──────────────────────────────────────────────────────────────────────────────────

/** The primary geometry, or the backup if the primary fails its checks — as liblp reads it. */
function readGeometry(read: Reader, superSize: number, skipped: string[]): Geometry {
  const failures: string[] = [];
  for (const [label, offset] of [['primary', GEOMETRY_OFFSET], ['backup', BACKUP_GEOMETRY_OFFSET]] as const) {
    try {
      const geometry = parseGeometry(read(offset, GEOMETRY_STRUCT_SIZE, `LP ${label} geometry`), label);
      const metadataEnd = METADATA_OFFSET + 2 * geometry.metadataMaxSize * geometry.slotCount;
      if (metadataEnd > superSize) {
        throw new Error(
          `LP ${label} geometry puts ${geometry.slotCount} slots of ${geometry.metadataMaxSize} bytes (twice) past the end of super (${superSize} bytes)`,
        );
      }
      skipped.push(...failures);
      return geometry;
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  throw new Error(`no valid LP geometry in super: ${failures.join('; ')}`);
}

function parseGeometry(raw: Buffer, label: string): Geometry {
  const magic = raw.readUInt32LE(0);
  if (magic !== GEOMETRY_MAGIC) {
    throw new Error(`LP ${label} geometry magic is ${hex32(magic)}, expected ${hex32(GEOMETRY_MAGIC)}`);
  }
  const structSize = raw.readUInt32LE(4);
  if (structSize !== GEOMETRY_STRUCT_SIZE) {
    throw new Error(`LP ${label} geometry struct_size is ${structSize}, expected ${GEOMETRY_STRUCT_SIZE}`);
  }
  if (!checksumMatches(raw.subarray(0, structSize), 8)) {
    throw new Error(`LP ${label} geometry checksum mismatch`);
  }

  const metadataMaxSize = raw.readUInt32LE(40);
  const slotCount = raw.readUInt32LE(44);
  const logicalBlockSize = raw.readUInt32LE(48);
  if (slotCount === 0) throw new Error(`LP ${label} geometry has no metadata slots`);
  if (metadataMaxSize < HEADER_SIZE_V1_0 || metadataMaxSize % LP_SECTOR_SIZE !== 0) {
    throw new Error(`LP ${label} geometry metadata_max_size ${metadataMaxSize} is not a whole number of sectors large enough for a header`);
  }
  return { metadataMaxSize, slotCount, logicalBlockSize };
}

// ── Metadata ──────────────────────────────────────────────────────────────────────────────────

/**
 * Checks one metadata copy the way liblp's reader does: magic and version, header checksum before
 * any other header field is believed, then the tables' checksum and every table's bounds.
 */
function validateMetadata(slot: Buffer, metadataMaxSize: number, label: string): ValidatedMetadata {
  const magic = slot.readUInt32LE(0);
  if (magic !== HEADER_MAGIC) {
    throw new Error(`LP metadata header magic in ${label} is ${hex32(magic)}, expected ${hex32(HEADER_MAGIC)}`);
  }
  const major = slot.readUInt16LE(4);
  const minor = slot.readUInt16LE(6);
  if (major !== MAJOR_VERSION || minor > MINOR_VERSION_MAX) {
    throw new Error(`LP metadata version in ${label} is ${major}.${minor}; only ${MAJOR_VERSION}.0 to ${MAJOR_VERSION}.${MINOR_VERSION_MAX} are understood`);
  }
  const headerSize = slot.readUInt32LE(8);
  const expectedHeaderSize = minor >= 2 ? HEADER_SIZE_V1_2 : HEADER_SIZE_V1_0;
  if (headerSize !== expectedHeaderSize) {
    throw new Error(`LP metadata header_size in ${label} is ${headerSize}; version ${major}.${minor} uses ${expectedHeaderSize}`);
  }
  if (headerSize > metadataMaxSize) {
    throw new Error(`LP metadata header in ${label} (${headerSize} bytes) does not fit the ${metadataMaxSize}-byte slot`);
  }
  if (!checksumMatches(slot.subarray(0, headerSize), 12)) {
    throw new Error(`LP metadata header checksum mismatch in ${label}`);
  }

  const tablesSize = slot.readUInt32LE(44);
  if (headerSize + tablesSize > metadataMaxSize) {
    throw new Error(`LP metadata tables in ${label} (${tablesSize} bytes after a ${headerSize}-byte header) overrun the ${metadataMaxSize}-byte slot`);
  }
  const tables = slot.subarray(headerSize, headerSize + tablesSize);
  const tablesChecksum = createHash('sha256').update(tables).digest();
  if (!tablesChecksum.equals(slot.subarray(48, 80))) {
    throw new Error(`LP metadata tables checksum mismatch in ${label}`);
  }

  const descriptor = (at: number, what: keyof typeof ENTRY_SIZES): TableDescriptor => {
    const table = { offset: slot.readUInt32LE(at), count: slot.readUInt32LE(at + 4), entrySize: slot.readUInt32LE(at + 8) };
    if (table.entrySize !== ENTRY_SIZES[what]) {
      throw new Error(`LP ${what} table in ${label} has ${table.entrySize}-byte entries, expected ${ENTRY_SIZES[what]}`);
    }
    if (table.offset + table.count * table.entrySize > tablesSize) {
      throw new Error(`LP ${what} table in ${label} (${table.count} entries at ${table.offset}) overruns the ${tablesSize}-byte tables area`);
    }
    return table;
  };

  return {
    minor,
    tables,
    partitions: descriptor(80, 'partitions'),
    extents: descriptor(92, 'extents'),
    groups: descriptor(104, 'groups'),
    blockDevices: descriptor(116, 'blockDevices'),
  };
}

/** Turns validated tables into byte windows, refusing anything one window cannot describe. */
function resolvePartitions(metadata: ValidatedMetadata, superSize: number, metadataEnd: number): LogicalPartition[] {
  const { tables } = metadata;
  const entry = (table: TableDescriptor, index: number): Buffer =>
    tables.subarray(table.offset + index * table.entrySize, table.offset + (index + 1) * table.entrySize);

  if (metadata.blockDevices.count === 0) throw new Error('LP metadata lists no block devices, not even super');
  const superDevice = entry(metadata.blockDevices, 0);
  const dataStart = superDevice.readBigUInt64LE(0) * BigInt(LP_SECTOR_SIZE);
  if (dataStart < BigInt(metadataEnd)) {
    throw new Error(`LP block device "${cString(superDevice.subarray(24, 60))}" starts its data at byte ${dataStart}, inside the metadata area that ends at ${metadataEnd}`);
  }

  const validAttributes = metadata.minor >= 1 ? ATTRIBUTE_MASK_V1 : ATTRIBUTE_MASK_V0;
  const seen = new Set<string>();
  const partitions: LogicalPartition[] = [];

  for (let i = 0; i < metadata.partitions.count; i += 1) {
    const raw = entry(metadata.partitions, i);
    const name = cString(raw.subarray(0, 36));
    if (name === '') throw new Error(`LP partition ${i} has an empty name`);
    const label = `LP partition "${name}"`;

    if (seen.has(name)) throw new Error(`${label} is listed twice in the metadata`);
    seen.add(name);

    const attributes = raw.readUInt32LE(36);
    const firstExtent = raw.readUInt32LE(40);
    const numExtents = raw.readUInt32LE(44);
    const groupIndex = raw.readUInt32LE(48);

    if (attributes & ~validAttributes) {
      throw new Error(`${label} has attribute bits ${hex32(attributes & ~validAttributes)} that metadata version 10.${metadata.minor} does not define`);
    }
    if (attributes & LP_PARTITION_ATTR_SLOT_SUFFIXED) {
      throw new Error(`${label} is SLOT_SUFFIXED — an A/B layout, not the single-slot emulator image this reads`);
    }
    if (groupIndex >= metadata.groups.count) {
      throw new Error(`${label} is in group ${groupIndex}, but the metadata has ${metadata.groups.count} groups`);
    }
    if (firstExtent + numExtents > metadata.extents.count) {
      throw new Error(`${label} claims ${numExtents} extents from index ${firstExtent}, but the metadata has ${metadata.extents.count}`);
    }
    if (numExtents > 1) {
      throw new Error(`${label} has ${numExtents} extents; only a single linear extent can be edited as one window`);
    }
    if (numExtents === 0) {
      partitions.push({ name, attributes, offset: 0, size: 0 });
      continue;
    }

    const extent = entry(metadata.extents, firstExtent);
    const sectors = extent.readBigUInt64LE(0);
    const targetType = extent.readUInt32LE(8);
    const targetData = extent.readBigUInt64LE(12);
    const targetSource = extent.readUInt32LE(20);

    if (targetType !== TARGET_TYPE_LINEAR) {
      const kind = targetType === TARGET_TYPE_ZERO ? 'a zero-fill' : `a type ${targetType}`;
      throw new Error(`${label} is ${kind} extent; only linear extents map to bytes in super`);
    }
    if (targetSource !== 0) {
      throw new Error(`${label} lives on block device ${targetSource}, not on super (device 0)`);
    }

    const start = targetData * BigInt(LP_SECTOR_SIZE);
    const end = start + sectors * BigInt(LP_SECTOR_SIZE);
    if (end > BigInt(superSize)) {
      throw new Error(`${label} extent [${start}, ${end}) reaches past the end of super (${superSize} bytes)`);
    }
    if (start < dataStart) {
      throw new Error(`${label} starts at byte ${start}, inside the LP metadata area (logical data begins at ${dataStart})`);
    }

    partitions.push({ name, attributes, offset: Number(start), size: Number(end - start) });
  }

  // Two windows over the same bytes would let an edit to one volume corrupt the other.
  const placed = partitions.filter((part) => part.size > 0).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < placed.length; i += 1) {
    const previous = placed[i - 1];
    const current = placed[i];
    if (current.offset < previous.offset + previous.size) {
      throw new Error(
        `LP partitions "${previous.name}" [${previous.offset}, ${previous.offset + previous.size}) and "${current.name}" [${current.offset}, ${current.offset + current.size}) overlap`,
      );
    }
  }

  return partitions;
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

/** SHA-256 of `struct` with the 32-byte checksum field at `at` zeroed, compared with that field. */
function checksumMatches(struct: Buffer, at: number): boolean {
  const zeroed = Buffer.from(struct);
  zeroed.fill(0, at, at + 32);
  return createHash('sha256').update(zeroed).digest().equals(struct.subarray(at, at + 32));
}

/** A fixed-size ASCII field, ended by the first NUL or the end of the field. */
function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('latin1');
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}
