/**
 * The cpio "newc" archive format, read and written in TypeScript.
 *
 * This exists to patch an Android-x86 initrd, which is a gzipped cpio archive. The shell version
 * shelled out to `zcat | cpio -idm` and `cpio -o -H newc | gzip` — neither of which exists on
 * Windows, and neither of which is worth shipping a Unix toolchain for. The format is fixed-width
 * ASCII headers and 4-byte alignment; the whole thing is about a hundred lines.
 *
 * Doing it in-process is also better than the original: unpacking to a temp directory and
 * repacking loses file modes and symlinks unless every flag is right, whereas editing entries in
 * memory cannot lose what it never converted.
 */

const MAGIC = '070701';
const HEADER_BYTES = 110;
const TRAILER = 'TRAILER!!!';

export interface CpioEntry {
  name: string;
  /** Unix mode, including the file-type bits. Preserved exactly on a round trip. */
  mode: number;
  data: Buffer;
  ino: number;
  uid: number;
  gid: number;
  nlink: number;
  mtime: number;
  devmajor: number;
  devminor: number;
  rdevmajor: number;
  rdevminor: number;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export function isFile(entry: CpioEntry): boolean {
  return (entry.mode & S_IFMT) === S_IFREG;
}

export function isDirectory(entry: CpioEntry): boolean {
  return (entry.mode & S_IFMT) === S_IFDIR;
}

export function isSymlink(entry: CpioEntry): boolean {
  return (entry.mode & S_IFMT) === S_IFLNK;
}

/** Padding to the next 4-byte boundary. Both the name and the data are aligned this way. */
function pad4(value: number): number {
  return (4 - (value % 4)) % 4;
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(8, '0');
}

export function parseCpio(archive: Buffer): CpioEntry[] {
  const entries: CpioEntry[] = [];
  if (archive.length === 0) return entries;

  // Checked up front, not only inside the loop. A buffer too short to hold one header would
  // otherwise fall straight through and return no entries — so a failed gunzip, or simply the
  // wrong file, would produce an *empty* initrd that repacks and boots to nothing, with no error
  // anywhere pointing at the cause.
  if (archive.length < HEADER_BYTES || archive.subarray(0, 6).toString('ascii') !== MAGIC) {
    throw new Error('not a newc cpio archive: the data does not begin with a 070701 header');
  }

  let offset = 0;

  while (offset + HEADER_BYTES <= archive.length) {
    const magic = archive.subarray(offset, offset + 6).toString('ascii');
    if (magic !== MAGIC) {
      throw new Error(`not a newc cpio archive: magic "${magic}" at offset ${offset}`);
    }

    const field = (index: number): number =>
      Number.parseInt(archive.subarray(offset + 6 + index * 8, offset + 6 + (index + 1) * 8).toString('ascii'), 16);

    const [ino, mode, uid, gid, nlink, mtime, filesize, devmajor, devminor, rdevmajor, rdevminor, namesize] =
      Array.from({ length: 12 }, (_, i) => field(i));

    const nameStart = offset + HEADER_BYTES;
    // namesize includes the trailing NUL, which is not part of the name.
    const name = archive.subarray(nameStart, nameStart + namesize - 1).toString('utf8');

    const dataStart = nameStart + namesize + pad4(HEADER_BYTES + namesize);
    const data = archive.subarray(dataStart, dataStart + filesize);

    offset = dataStart + filesize + pad4(filesize);

    if (name === TRAILER) break;

    entries.push({
      name,
      mode,
      data: Buffer.from(data),
      ino,
      uid,
      gid,
      nlink,
      mtime,
      devmajor,
      devminor,
      rdevmajor,
      rdevminor,
    });
  }

  return entries;
}

export function buildCpio(entries: CpioEntry[]): Buffer {
  const chunks: Buffer[] = [];

  const push = (entry: CpioEntry): void => {
    const name = Buffer.from(entry.name, 'utf8');
    const namesize = name.length + 1;
    const filesize = entry.data.length;

    const header =
      MAGIC +
      hex(entry.ino) +
      hex(entry.mode) +
      hex(entry.uid) +
      hex(entry.gid) +
      hex(entry.nlink) +
      hex(entry.mtime) +
      hex(filesize) +
      hex(entry.devmajor) +
      hex(entry.devminor) +
      hex(entry.rdevmajor) +
      hex(entry.rdevminor) +
      hex(namesize) +
      hex(0); // c_check is unused by newc and must be zero

    chunks.push(Buffer.from(header, 'ascii'), name, Buffer.from([0]));
    chunks.push(Buffer.alloc(pad4(HEADER_BYTES + namesize)));
    chunks.push(entry.data, Buffer.alloc(pad4(filesize)));
  };

  for (const entry of entries) push(entry);

  // Every newc archive ends with a zero-length TRAILER!!! entry; without it the kernel's own
  // unpacker keeps reading past the end and reports a corrupt initramfs.
  push({
    name: TRAILER,
    mode: 0,
    data: Buffer.alloc(0),
    ino: 0,
    uid: 0,
    gid: 0,
    nlink: 1,
    mtime: 0,
    devmajor: 0,
    devminor: 0,
    rdevmajor: 0,
    rdevminor: 0,
  });

  // Archives are conventionally padded to a 512-byte block. The kernel does not require it, but
  // tools that read the result do, and it costs at most 511 bytes.
  const body = Buffer.concat(chunks);
  const tail = (512 - (body.length % 512)) % 512;
  return tail === 0 ? body : Buffer.concat([body, Buffer.alloc(tail)]);
}

/**
 * Rewrites one entry's contents in place, leaving everything else untouched.
 *
 * The alternative — unpack to disk, edit, repack — is how the shell version worked, and it silently
 * loses file modes and symlinks unless every flag is exactly right. Editing the parsed entry
 * cannot lose what it never converted.
 */
export function replaceEntry(entries: CpioEntry[], name: string, rewrite: (previous: Buffer) => Buffer): boolean {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return false;
  entry.data = rewrite(entry.data);
  return true;
}

export function findEntry(entries: CpioEntry[], name: string): CpioEntry | null {
  return entries.find((candidate) => candidate.name === name) ?? null;
}
