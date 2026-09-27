import { crc32 } from 'zlib';

/**
 * The GUID partition table of Google's emulator `system.img`.
 *
 * Since Android 10 the emulator's system image is not one ext4 volume but a whole disk: a GPT with
 * two partitions, `vbmeta` (the top-level AVB metadata) and `super` (the dynamic partitions). Every
 * byte the ROM builder writes lands at an offset derived from this table, so the table is checked
 * before it is believed. A header or entry array that fails its CRC means a truncated download, a
 * different image, or damage — and an offset read from it would aim the editor at the wrong bytes
 * of a 3 GB file, which fails at boot, far from the cause.
 *
 * Only the primary header is read. The builder never changes the table, so the backup at the end of
 * the disk cannot drift from it, and nothing here needs it.
 */

const SIGNATURE = 'EFI PART';
const HEADER_LBA = 1;
/** UEFI's header is 92 bytes; `header_size` may be larger (and the CRC covers it), never smaller. */
const MIN_HEADER_SIZE = 92;
const MIN_ENTRY_SIZE = 128;
/**
 * The entry array's size comes from the header, so this bounds how much is read on its word. The
 * norm is 128 entries of 128 bytes (16 KiB); this is 64 times that.
 */
const MAX_ENTRY_ARRAY_BYTES = 1024 * 1024;
const TYPE_GUID_BYTES = 16;
const NAME_OFFSET = 56;
/** 36 UTF-16 code units. */
const NAME_BYTES = 72;

export interface GptPartition {
  name: string;
  /** Byte offset of the partition in the disk file. */
  offset: number;
  /** Bytes, `lastLba` included. */
  size: number;
  firstLba: number;
  /** Inclusive, as GPT stores it. */
  lastLba: number;
}

/**
 * Reads the primary GPT and returns every used entry, in table order.
 *
 * `read` is relative to the start of the disk. Refuses a missing signature, a header or entry
 * array whose CRC32 does not match, a header that is not the primary, entries outside the usable
 * range, and partitions that overlap — any of which means the offsets cannot be trusted to write
 * through.
 */
export function readGpt(read: (offset: number, length: number) => Buffer, sectorSize = 512): GptPartition[] {
  if (!Number.isInteger(sectorSize) || sectorSize < 512 || (sectorSize & (sectorSize - 1)) !== 0) {
    throw new Error(`GPT sector size ${sectorSize} is not a power of two of at least 512`);
  }

  const readExactly = (offset: number, length: number, what: string): Buffer => {
    const data = read(offset, length);
    if (data.length !== length) {
      throw new Error(`short read of the ${what}: ${data.length} of ${length} bytes at offset ${offset}`);
    }
    return data;
  };

  const header = readExactly(HEADER_LBA * sectorSize, sectorSize, 'GPT header');
  if (header.subarray(0, 8).toString('latin1') !== SIGNATURE) {
    throw new Error(`no GPT: LBA ${HEADER_LBA} does not begin with "${SIGNATURE}" (sector size ${sectorSize})`);
  }

  const headerSize = header.readUInt32LE(12);
  if (headerSize < MIN_HEADER_SIZE || headerSize > sectorSize) {
    throw new Error(`GPT header size ${headerSize} is outside ${MIN_HEADER_SIZE}..${sectorSize}`);
  }

  // The CRC is computed with its own field zeroed, over exactly header_size bytes.
  const storedHeaderCrc = header.readUInt32LE(16);
  const zeroed = Buffer.from(header.subarray(0, headerSize));
  zeroed.writeUInt32LE(0, 16);
  const headerCrc = crc32(zeroed);
  if (headerCrc !== storedHeaderCrc) {
    throw new Error(`GPT header CRC32 mismatch: stored ${hex32(storedHeaderCrc)}, computed ${hex32(headerCrc)}`);
  }

  const myLba = u64(header, 24, 'GPT header my_lba');
  if (myLba !== HEADER_LBA) {
    // A backup header copied into place, or a table written for a different sector size.
    throw new Error(`GPT header at LBA ${HEADER_LBA} says it lives at LBA ${myLba}`);
  }

  const firstUsable = u64(header, 40, 'GPT first usable LBA');
  const lastUsable = u64(header, 48, 'GPT last usable LBA');
  if (lastUsable < firstUsable) {
    throw new Error(`GPT usable range is empty: first usable LBA ${firstUsable}, last ${lastUsable}`);
  }

  const entriesLba = u64(header, 72, 'GPT partition entry LBA');
  const numEntries = header.readUInt32LE(80);
  const entrySize = header.readUInt32LE(84);
  const storedEntriesCrc = header.readUInt32LE(88);

  if (entrySize < MIN_ENTRY_SIZE || entrySize % 8 !== 0) {
    throw new Error(`GPT partition entry size ${entrySize} is not a multiple of 8 of at least ${MIN_ENTRY_SIZE}`);
  }
  const arrayBytes = numEntries * entrySize;
  if (arrayBytes > MAX_ENTRY_ARRAY_BYTES) {
    throw new Error(`GPT claims ${numEntries} entries of ${entrySize} bytes (${arrayBytes} bytes); more than ${MAX_ENTRY_ARRAY_BYTES} is not a real table`);
  }

  // The entry array must sit between the header and the first usable LBA, or a partition could
  // overlap the table that describes it.
  const arraySectors = Math.ceil(arrayBytes / sectorSize);
  if (entriesLba <= HEADER_LBA || (arraySectors > 0 && entriesLba + arraySectors - 1 >= firstUsable)) {
    throw new Error(
      `GPT partition entry array at LBA ${entriesLba} (${arraySectors} sectors) overlaps the header or the usable range starting at LBA ${firstUsable}`,
    );
  }

  const entries = readExactly(entriesLba * sectorSize, arrayBytes, 'GPT partition entry array');
  const entriesCrc = crc32(entries);
  if (entriesCrc !== storedEntriesCrc) {
    throw new Error(`GPT partition entry array CRC32 mismatch: stored ${hex32(storedEntriesCrc)}, computed ${hex32(entriesCrc)}`);
  }

  const partitions: GptPartition[] = [];
  for (let i = 0; i < numEntries; i += 1) {
    const entry = entries.subarray(i * entrySize, (i + 1) * entrySize);
    // An all-zero partition type GUID is UEFI's "unused entry"; its other fields mean nothing.
    if (entry.subarray(0, TYPE_GUID_BYTES).every((byte) => byte === 0)) continue;

    const name = decodeName(entry.subarray(NAME_OFFSET, NAME_OFFSET + NAME_BYTES));
    const label = `GPT partition ${i} ("${name}")`;
    const firstLba = u64(entry, 32, `${label} first LBA`);
    const lastLba = u64(entry, 40, `${label} last LBA`);

    if (lastLba < firstLba) {
      throw new Error(`${label} ends at LBA ${lastLba}, before it starts at LBA ${firstLba}`);
    }
    if (firstLba < firstUsable || lastLba > lastUsable) {
      throw new Error(`${label} spans LBA ${firstLba}..${lastLba}, outside the usable range ${firstUsable}..${lastUsable}`);
    }

    const offset = firstLba * sectorSize;
    const size = (lastLba - firstLba + 1) * sectorSize;
    if (!Number.isSafeInteger(offset + size)) {
      throw new Error(`${label} ends past ${Number.MAX_SAFE_INTEGER} bytes`);
    }

    partitions.push({ name, offset, size, firstLba, lastLba });
  }

  // Two partitions sharing sectors means an edit to one silently corrupts the other.
  const byStart = [...partitions].sort((a, b) => a.firstLba - b.firstLba);
  for (let i = 1; i < byStart.length; i += 1) {
    const previous = byStart[i - 1];
    const current = byStart[i];
    if (current.firstLba <= previous.lastLba) {
      throw new Error(
        `GPT partitions "${previous.name}" (LBA ${previous.firstLba}..${previous.lastLba}) and "${current.name}" (LBA ${current.firstLba}..${current.lastLba}) overlap`,
      );
    }
  }

  return partitions;
}

/**
 * The one partition called `name`.
 *
 * A duplicate is refused rather than resolved by position: which of two `super`s the guest's
 * bootloader picks is not something to guess at when the answer decides where edits are written.
 */
export function findPartition(parts: GptPartition[], name: string): GptPartition {
  const matches = parts.filter((part) => part.name === name);
  if (matches.length === 0) {
    const names = parts.map((part) => `"${part.name}"`).join(', ') || 'none';
    throw new Error(`no GPT partition named "${name}" (partitions: ${names})`);
  }
  if (matches.length > 1) {
    throw new Error(`GPT has ${matches.length} partitions named "${name}"; refusing to guess which one is real`);
  }
  return matches[0];
}

/** UTF-16LE, ended by the first NUL code unit or the end of the 72-byte field. */
function decodeName(field: Buffer): string {
  let units = 0;
  while (units * 2 + 1 < field.length && field.readUInt16LE(units * 2) !== 0) units += 1;
  return field.subarray(0, units * 2).toString('utf16le');
}

/** A u64 that is about to become an LBA or byte count, so it must survive conversion to a number. */
function u64(buffer: Buffer, offset: number, what: string): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${what} ${value} is too large to be real`);
  return Number(value);
}

function hex32(value: number): string {
  return `0x${value.toString(16).padStart(8, '0')}`;
}
