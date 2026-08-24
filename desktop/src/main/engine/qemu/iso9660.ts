import { closeSync, openSync, readSync, statSync } from 'fs';

/**
 * Reading files out of an ISO9660 image, without mounting it.
 *
 * The shell version used `mount -o loop`, which needs root and does not exist on Windows at all.
 * ISO9660 is a simple format — fixed 2048-byte sectors and a directory tree of variable-length
 * records — and only two files are ever needed out of it: the kernel and the initrd.
 *
 * Reading it directly is also better than mounting: no privilege, no mount point to leak if the
 * process dies partway, and no dependency on a loop device being available.
 */

const SECTOR = 2048;
/** The volume descriptors start here — the first 16 sectors are reserved for boot code. */
const PVD_SECTOR = 16;
const PVD_TYPE_PRIMARY = 1;
const STANDARD_ID = 'CD001';

/** Directory record flag bit 1: this entry is a directory rather than a file. */
const FLAG_DIRECTORY = 0x02;

export interface IsoEntry {
  name: string;
  isDirectory: boolean;
  /** Logical block address — multiply by 2048 for the byte offset. */
  lba: number;
  size: number;
}

export class IsoError extends Error {}

/**
 * ISO9660 stores multi-byte numbers twice, little-endian then big-endian, so a reader of either
 * architecture can take the half it prefers. The little-endian half is first.
 */
function bothEndian32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

/**
 * Cleans up an ISO9660 file identifier.
 *
 * Plain ISO9660 upper-cases names and appends a version suffix, so `initrd.img` is stored as
 * `INITRD.IMG;1`. Rock Ridge, which Android-x86 images carry, preserves the real name — so the
 * comparison has to work either way, which is why lookups here are case-insensitive.
 */
function cleanName(raw: string): string {
  const withoutVersion = raw.split(';')[0];
  // A trailing dot on an extension-less name is an ISO9660 artefact, not part of the name.
  return withoutVersion.endsWith('.') ? withoutVersion.slice(0, -1) : withoutVersion;
}

export class IsoReader {
  private readonly fd: number;
  private readonly size: number;

  constructor(private readonly path: string) {
    this.size = statSync(path).size;
    this.fd = openSync(path, 'r');
  }

  close(): void {
    closeSync(this.fd);
  }

  private read(offset: number, length: number): Buffer {
    if (offset < 0 || offset + length > this.size) {
      throw new IsoError(`read past the end of ${this.path}`);
    }
    const buffer = Buffer.alloc(length);
    readSync(this.fd, buffer, 0, length, offset);
    return buffer;
  }

  /** The root directory's location, from the Primary Volume Descriptor. */
  root(): IsoEntry {
    const pvd = this.read(PVD_SECTOR * SECTOR, SECTOR);

    if (pvd.subarray(1, 6).toString('ascii') !== STANDARD_ID) {
      throw new IsoError(`${this.path} is not an ISO9660 image (no CD001 signature)`);
    }
    if (pvd[0] !== PVD_TYPE_PRIMARY) {
      throw new IsoError(`${this.path} has no primary volume descriptor where one is required`);
    }

    // The root directory record is embedded in the PVD at a fixed offset, 34 bytes long.
    const record = pvd.subarray(156, 156 + 34);
    return {
      name: '',
      isDirectory: true,
      lba: bothEndian32(record, 2),
      size: bothEndian32(record, 10),
    };
  }

  /** The entries of one directory. `.` and `..` are dropped; they are never what a caller wants. */
  list(directory: IsoEntry): IsoEntry[] {
    if (!directory.isDirectory) throw new IsoError(`${directory.name} is not a directory`);

    const data = this.read(directory.lba * SECTOR, directory.size);
    const entries: IsoEntry[] = [];
    let offset = 0;

    while (offset < data.length) {
      const recordLength = data[offset];

      // A zero length means the rest of this sector is padding: records never straddle a sector
      // boundary, so the next one starts at the beginning of the next sector.
      if (recordLength === 0) {
        const next = (Math.floor(offset / SECTOR) + 1) * SECTOR;
        if (next >= data.length) break;
        offset = next;
        continue;
      }

      const record = data.subarray(offset, offset + recordLength);
      const nameLength = record[32];
      const rawName = record.subarray(33, 33 + nameLength).toString('binary');

      // Single-byte identifiers 0x00 and 0x01 are `.` and `..`.
      const isSelfOrParent = nameLength === 1 && (rawName.charCodeAt(0) === 0 || rawName.charCodeAt(0) === 1);
      if (!isSelfOrParent) {
        entries.push({
          name: cleanName(Buffer.from(rawName, 'binary').toString('utf8')),
          isDirectory: (record[25] & FLAG_DIRECTORY) !== 0,
          lba: bothEndian32(record, 2),
          size: bothEndian32(record, 10),
        });
      }

      offset += recordLength;
    }

    return entries;
  }

  /** Case-insensitive lookup within one directory. */
  find(directory: IsoEntry, name: string): IsoEntry | null {
    const wanted = name.toLowerCase();
    return this.list(directory).find((entry) => entry.name.toLowerCase() === wanted) ?? null;
  }

  /** The whole contents of a file. Only ever used for a kernel and an initrd — a few MB each. */
  readFile(entry: IsoEntry): Buffer {
    if (entry.isDirectory) throw new IsoError(`${entry.name} is a directory`);
    return this.read(entry.lba * SECTOR, entry.size);
  }
}

export interface BootFiles {
  /**
   * The directory holding the payload, as an absolute path from the media root — this is what
   * Android-x86's initrd takes as `SRC=`. Empty when the payload sits at the root, which is how
   * ISO releases are laid out; a release-named directory once installed to a disk.
   */
  srcDir: string;
  kernel: Buffer;
  initrd: Buffer;
}

/**
 * Finds and extracts the kernel and initrd.
 *
 * Searches the root and one level below it, which is the same depth the shell version used
 * (`find -maxdepth 2`). Android-x86 ISOs put the payload at the root; some rebuilds and all
 * installed-to-disk layouts put it in a release-named directory, and `SRC=` has to name it.
 * Deriving the directory rather than assuming either is what makes both work.
 */
export function readBootFiles(isoPath: string): BootFiles {
  const iso = new IsoReader(isoPath);
  try {
    const root = iso.root();

    const fromDirectory = (directory: IsoEntry, srcDir: string): BootFiles | null => {
      const kernel = iso.find(directory, 'kernel');
      const initrd = iso.find(directory, 'initrd.img');
      if (!kernel || !initrd || kernel.isDirectory || initrd.isDirectory) return null;
      return { srcDir, kernel: iso.readFile(kernel), initrd: iso.readFile(initrd) };
    };

    const atRoot = fromDirectory(root, '');
    if (atRoot) return atRoot;

    for (const entry of iso.list(root)) {
      if (!entry.isDirectory) continue;
      const found = fromDirectory(entry, `/${entry.name}`);
      if (found) return found;
    }

    throw new IsoError(
      `no kernel and initrd.img found in ${isoPath} — this does not look like an Android-x86 image`,
    );
  } finally {
    iso.close();
  }
}
