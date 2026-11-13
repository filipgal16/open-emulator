import { closeSync, createReadStream, createWriteStream, fstatSync, openSync, readSync, writeFileSync } from 'fs';
import { Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { createInflateRaw, inflateRawSync } from 'zlib';

/**
 * Reading members out of a zip archive, in-process.
 *
 * `engine/sdk/unzip.ts` hands whole archives to Windows' `tar.exe`, which is right for the SDK:
 * every file in those archives is wanted, and bsdtar is fast. A game bundle is the opposite case.
 * Only some of its members are wanted — the ones that fit this guest — and one small member,
 * `manifest.json`, has to be read before deciding which. Listing and picking through `tar.exe`
 * would mean a process per question and parsing its text output; the zip format itself is a
 * directory at the end of the file and a fixed header in front of each member, which is a page of
 * code.
 *
 * Members are streamed to disk rather than read into memory, because a bundle's assets can run to
 * gigabytes. Zip64 is handled: the archives in question are routinely past 4 GB.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_BYTES = 56;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_BYTES = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_BYTES = 30;
const ZIP64_EXTRA_ID = 0x0001;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;

export class ZipError extends Error {}

export interface ZipEntry {
  /** As stored: `/`-separated, relative. Never joined onto a host path by this module. */
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Running CRC-32. Electron 31 ships Node 20.14, one minor short of `zlib.crc32`, so it is computed
 * here; the table makes it fast enough to keep pace with the disk.
 */
function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < chunk.length; i += 1) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  if (read !== length) throw new ZipError('the archive ends early');
  return buffer;
}

/** Above 2^53 a Number stops being exact; no file this app will ever see is that large. */
function u64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('a size in the archive is out of range');
  return Number(value);
}

/**
 * The central directory: every member's name, sizes and where its data starts.
 *
 * Read from the end of the file, which is where zip keeps the authoritative copy. The local
 * headers in front of each member can carry zeroed sizes (when the writer streamed them), so they
 * are only consulted for the one thing they alone know: how long their own name and extra fields
 * are.
 */
export function readZipDirectory(filePath: string): ZipEntry[] {
  const fd = openSync(filePath, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize < EOCD_BYTES) throw new ZipError('not a zip archive');

    // The end record sits behind a comment of up to 64 KB, so it is found by scanning backwards.
    const tailLength = Math.min(fileSize, EOCD_BYTES + MAX_COMMENT_BYTES);
    const tail = readAt(fd, fileSize - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - EOCD_BYTES; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('not a zip archive');

    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);

    // Any field pinned at its maximum means the real value is in the zip64 record, found through
    // the locator immediately before the classic end record.
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locatorAt = fileSize - tailLength + eocd - ZIP64_LOCATOR_BYTES;
      if (locatorAt < 0) throw new ZipError('the archive’s zip64 locator is missing');
      const locator = readAt(fd, locatorAt, ZIP64_LOCATOR_BYTES);
      if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) throw new ZipError('the archive’s zip64 locator is missing');
      const record = readAt(fd, u64(locator, 8), ZIP64_EOCD_BYTES);
      if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw new ZipError('the archive’s zip64 record is damaged');
      count = u64(record, 32);
      directorySize = u64(record, 40);
      directoryOffset = u64(record, 48);
    }

    if (directoryOffset + directorySize > fileSize) throw new ZipError('the archive’s directory is out of bounds');
    const directory = readAt(fd, directoryOffset, directorySize);

    const entries: ZipEntry[] = [];
    let at = 0;
    for (let i = 0; i < count; i += 1) {
      if (at + CENTRAL_BYTES > directory.length || directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
        throw new ZipError('the archive’s directory is damaged');
      }
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const entry: ZipEntry = {
        name: directory.toString('utf8', at + CENTRAL_BYTES, at + CENTRAL_BYTES + nameLength),
        flags: directory.readUInt16LE(at + 8),
        method: directory.readUInt16LE(at + 10),
        crc32: directory.readUInt32LE(at + 16),
        compressedSize: directory.readUInt32LE(at + 20),
        size: directory.readUInt32LE(at + 24),
        localHeaderOffset: directory.readUInt32LE(at + 42),
      };

      // The zip64 extra field holds only the values that overflowed, in this fixed order.
      const extraStart = at + CENTRAL_BYTES + nameLength;
      const extraEnd = extraStart + extraLength;
      for (let x = extraStart; x + 4 <= extraEnd; ) {
        const id = directory.readUInt16LE(x);
        const length = directory.readUInt16LE(x + 2);
        if (id === ZIP64_EXTRA_ID) {
          let field = x + 4;
          if (entry.size === 0xffffffff) {
            entry.size = u64(directory, field);
            field += 8;
          }
          if (entry.compressedSize === 0xffffffff) {
            entry.compressedSize = u64(directory, field);
            field += 8;
          }
          if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = u64(directory, field);
        }
        x += 4 + length;
      }

      entries.push(entry);
      at = extraEnd + commentLength;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

function checkReadable(entry: ZipEntry): void {
  if (entry.flags & FLAG_ENCRYPTED) throw new ZipError(`${entry.name} is encrypted`);
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    throw new ZipError(`${entry.name} uses compression method ${entry.method}`);
  }
}

/** Where a member's bytes begin: past its local header, whose name and extra lengths are its own. */
function dataOffset(fd: number, entry: ZipEntry): number {
  const header = readAt(fd, entry.localHeaderOffset, LOCAL_BYTES);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new ZipError(`${entry.name} has a damaged header`);
  return entry.localHeaderOffset + LOCAL_BYTES + header.readUInt16LE(26) + header.readUInt16LE(28);
}

/** A small member, whole, into memory. Refuses anything over `maxBytes` before reading it. */
export function readZipEntry(filePath: string, entry: ZipEntry, maxBytes: number): Buffer {
  checkReadable(entry);
  if (entry.size > maxBytes || entry.compressedSize > maxBytes) throw new ZipError(`${entry.name} is too large to read`);
  const fd = openSync(filePath, 'r');
  try {
    const raw = readAt(fd, dataOffset(fd, entry), entry.compressedSize);
    const data = entry.method === METHOD_DEFLATE ? inflateRawSync(raw) : raw;
    if (data.length !== entry.size || crc32Update(0, data) !== entry.crc32) {
      throw new ZipError(`${entry.name} is damaged`);
    }
    return data;
  } finally {
    closeSync(fd);
  }
}

/**
 * Streams one member to `destination`, checking its length and CRC on the way past.
 *
 * The check matters more than it would for a download with a digest: nothing else stands between
 * a truncated bundle and a guest that fails the install with an error about signatures.
 */
export async function extractZipEntry(
  filePath: string,
  entry: ZipEntry,
  destination: string,
  onBytes: (bytes: number) => void = () => undefined,
): Promise<void> {
  checkReadable(entry);
  const fd = openSync(filePath, 'r');
  let start: number;
  try {
    start = dataOffset(fd, entry);
  } finally {
    closeSync(fd);
  }

  let crc = 0;
  let written = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      crc = crc32Update(crc, chunk);
      written += chunk.length;
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });

  if (entry.compressedSize === 0) {
    // Not streamed: `createReadStream` with an `end` before its `start` reads to the end of the
    // file instead of reading nothing.
    writeFileSync(destination, Buffer.alloc(0));
  } else {
    const source = createReadStream(filePath, { start, end: start + entry.compressedSize - 1 });
    const sink = createWriteStream(destination);
    if (entry.method === METHOD_DEFLATE) await pipeline(source, createInflateRaw(), meter, sink);
    else await pipeline(source, meter, sink);
  }

  if (written !== entry.size || crc !== entry.crc32) throw new ZipError(`${entry.name} is damaged`);
}
