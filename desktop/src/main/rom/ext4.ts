import { readSync, writeSync } from 'fs';

/**
 * An ext4 editor for exactly one kind of filesystem: the logical partitions inside Google's
 * API 30 emulator `system.img`.
 *
 * Those volumes are built by `mke2fs` + `e2fsdroid` with a small, fixed feature set — no journal,
 * no `metadata_csum`, no `64bit`, no `flex_bg` — plus `shared_blocks`, which deduplicates
 * identical blocks so that one block can back several files. That last one is why the volumes
 * cannot simply be mounted read-write and edited, and why this exists: it is what `debugfs` did
 * for the previous attempt, without a Linux distribution on the user's machine.
 *
 * It is narrow on purpose. A volume with any feature outside `SUPPORTED` is refused with the
 * feature named, so a future image with a different layout fails loudly at build time rather
 * than quietly at boot. The rules it keeps, because breaking any of them corrupts a disk:
 *
 *  - **A block that might be shared is never written.** New content always goes into freshly
 *    allocated blocks; an existing directory block is edited only when nothing else references it.
 *  - **A block is freed only when nothing references it.** Every block reachable from every
 *    in-use inode is counted first; removing a file decrements, and only zero frees.
 *  - **Uninitialised groups are initialised properly before use**, never read as if their bitmaps
 *    were real.
 *  - **Every mutation keeps the counts in step**: bitmaps, group descriptor counts and checksums,
 *    `bg_itable_unused`, and the superblock.
 *
 * `verify()` re-derives all of that from the inodes and checks it, and the builder runs it after
 * every edit. `e2fsck -fn` is the independent oracle in development.
 */

// ── The disk ──────────────────────────────────────────────────────────────────────────────────

/** The bytes a volume lives in: a partition inside a file, or a Buffer in tests. */
export interface Disk {
  readonly size: number;
  read(offset: number, length: number): Buffer;
  write(offset: number, data: Buffer): void;
}

export class BufferDisk implements Disk {
  constructor(readonly buffer: Buffer) {}

  get size(): number {
    return this.buffer.length;
  }

  read(offset: number, length: number): Buffer {
    checkRange(offset, length, this.size);
    return Buffer.from(this.buffer.subarray(offset, offset + length));
  }

  write(offset: number, data: Buffer): void {
    checkRange(offset, data.length, this.size);
    data.copy(this.buffer, offset);
  }
}

/**
 * A window onto an open file: `base` is where the volume starts inside it.
 *
 * Every access is bounds-checked against the window, so a bug in block arithmetic cannot write
 * into the partition next door.
 */
export class FileDisk implements Disk {
  constructor(
    private readonly fd: number,
    private readonly base: number,
    readonly size: number,
    private readonly writable: boolean,
  ) {}

  read(offset: number, length: number): Buffer {
    checkRange(offset, length, this.size);
    const out = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, out, done, length - done, this.base + offset + done);
      if (n <= 0) throw new Error(`short read at ${this.base + offset + done}`);
      done += n;
    }
    return out;
  }

  write(offset: number, data: Buffer): void {
    if (!this.writable) throw new Error('volume opened read-only');
    checkRange(offset, data.length, this.size);
    let done = 0;
    while (done < data.length) {
      const n = writeSync(this.fd, data, done, data.length - done, this.base + offset + done);
      if (n <= 0) throw new Error(`short write at ${this.base + offset + done}`);
      done += n;
    }
  }
}

function checkRange(offset: number, length: number, size: number): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw new Error(`access [${offset}, +${length}) is outside the volume (${size} bytes)`);
  }
}

// ── On-disk constants ───────────────────────────────────────────────────────────────────────────

const EXT4_MAGIC = 0xef53;
const SUPERBLOCK_OFFSET = 1024;
const EXTENT_MAGIC = 0xf30a;
const XATTR_MAGIC = 0xea020000;
const XATTR_INDEX_SECURITY = 6;
const ROOT_INO = 2;

const COMPAT = { EXT_ATTR: 0x8, DIR_INDEX: 0x20 } as const;
const INCOMPAT = { FILETYPE: 0x2, EXTENTS: 0x40 } as const;
const RO_COMPAT = {
  SPARSE_SUPER: 0x1,
  LARGE_FILE: 0x2,
  HUGE_FILE: 0x8,
  GDT_CSUM: 0x10,
  DIR_NLINK: 0x20,
  EXTRA_ISIZE: 0x40,
  SHARED_BLOCKS: 0x4000,
} as const;

const SUPPORTED = {
  compat: COMPAT.EXT_ATTR | COMPAT.DIR_INDEX,
  incompat: INCOMPAT.FILETYPE | INCOMPAT.EXTENTS,
  roCompat:
    RO_COMPAT.SPARSE_SUPER |
    RO_COMPAT.LARGE_FILE |
    RO_COMPAT.HUGE_FILE |
    RO_COMPAT.GDT_CSUM |
    RO_COMPAT.DIR_NLINK |
    RO_COMPAT.EXTRA_ISIZE |
    RO_COMPAT.SHARED_BLOCKS,
};

/** Names for the features a volume might carry, so a refusal says which one. */
const FEATURE_NAMES: Record<'compat' | 'incompat' | 'roCompat', Record<number, string>> = {
  compat: {
    0x1: 'dir_prealloc', 0x2: 'imagic_inodes', 0x4: 'has_journal', 0x8: 'ext_attr', 0x10: 'resize_inode',
    0x20: 'dir_index', 0x40: 'lazy_bg', 0x80: 'exclude_inode', 0x100: 'exclude_bitmap', 0x200: 'sparse_super2',
    0x400: 'fast_commit', 0x800: 'stable_inodes', 0x1000: 'orphan_file',
  },
  incompat: {
    0x1: 'compression', 0x2: 'filetype', 0x4: 'needs_recovery', 0x8: 'journal_dev', 0x10: 'meta_bg',
    0x40: 'extent', 0x80: '64bit', 0x100: 'mmp', 0x200: 'flex_bg', 0x400: 'ea_inode', 0x1000: 'dirdata',
    0x2000: 'metadata_csum_seed', 0x4000: 'large_dir', 0x8000: 'inline_data', 0x10000: 'encrypt', 0x20000: 'casefold',
  },
  roCompat: {
    0x1: 'sparse_super', 0x2: 'large_file', 0x4: 'btree_dir', 0x8: 'huge_file', 0x10: 'uninit_bg', 0x20: 'dir_nlink',
    0x40: 'extra_isize', 0x80: 'has_snapshot', 0x100: 'quota', 0x200: 'bigalloc', 0x400: 'metadata_csum',
    0x800: 'replica', 0x1000: 'read-only', 0x2000: 'project', 0x4000: 'shared_blocks', 0x8000: 'verity',
    0x10000: 'orphan_present',
  },
};

const BG_INODE_UNINIT = 0x1;
const BG_BLOCK_UNINIT = 0x2;

const INODE_FLAG_INDEX = 0x1000;
const INODE_FLAG_HUGE_FILE = 0x40000;
const INODE_FLAG_EXTENTS = 0x80000;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export const FT = { UNKNOWN: 0, REG: 1, DIR: 2, CHR: 3, BLK: 4, FIFO: 5, SOCK: 6, SYMLINK: 7 } as const;

/** `dir_nlink`: past this, a directory's link count is pinned at 1 rather than counted. */
const DIR_NLINK_MAX = 65000;

// ── CRC16, for uninit_bg group descriptor checksums ─────────────────────────────────────────────

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** The ANSI CRC-16 (reflected 0x8005) that `ext4_group_desc_csum` uses without metadata_csum. */
export function crc16(crc: number, data: Uint8Array): number {
  let c = crc & 0xffff;
  for (const byte of data) c = (c >>> 8) ^ CRC16_TABLE[(c ^ byte) & 0xff];
  return c & 0xffff;
}

// ── Types ─────────────────────────────────────────────────────────────────────────────────────

export interface Extent {
  /** First logical block of the file this extent maps. */
  logical: number;
  /** First physical block. */
  start: number;
  length: number;
  /** Allocated but reads as zeros. */
  uninit: boolean;
}

export interface DirEntry {
  name: string;
  inode: number;
  fileType: number;
}

export interface Stat {
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  links: number;
  flags: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface NewInodeOptions {
  /** Permission bits only, e.g. 0o644. The type comes from the operation. */
  mode: number;
  uid?: number;
  gid?: number;
  /** `security.selinux`, e.g. `u:object_r:system_file:s0`. Required: Android refuses unlabeled files. */
  selinux: string;
}

export interface RemoveReport {
  inodesFreed: number;
  blocksFreed: number;
  /** Blocks that were referenced by another file too, and so stayed allocated. */
  blocksStillShared: number;
}

export interface VerifyReport {
  ok: boolean;
  problems: string[];
}

interface GroupDesc {
  blockBitmap: number;
  inodeBitmap: number;
  inodeTable: number;
  freeBlocks: number;
  freeInodes: number;
  usedDirs: number;
  flags: number;
  itableUnused: number;
  checksum: number;
  /** The 32 raw bytes, kept so fields this editor does not model are written back unchanged. */
  raw: Buffer;
}

interface Inode {
  ino: number;
  raw: Buffer;
}

// ── The volume ────────────────────────────────────────────────────────────────────────────────

export interface OpenOptions {
  writable?: boolean;
  /** Timestamp for everything this editor creates or changes, in seconds. Fixed, so builds are reproducible. */
  epoch?: number;
}

export class Ext4Volume {
  readonly blockSize: number;
  readonly blocksCount: number;
  readonly inodesCount: number;
  readonly blocksPerGroup: number;
  readonly inodesPerGroup: number;
  readonly inodeSize: number;
  readonly firstDataBlock: number;
  readonly firstIno: number;
  readonly groupCount: number;
  readonly label: string;
  readonly sharedBlocks: boolean;

  private readonly sb: Buffer;
  private readonly groups: GroupDesc[];
  private readonly gdtBlocks: number;
  private readonly uuid: Buffer;
  private readonly extraIsize: number;
  private readonly epoch: number;
  private readonly writable: boolean;

  private readonly blockBitmaps = new Map<number, Uint8Array>();
  private readonly inodeBitmaps = new Map<number, Uint8Array>();
  private readonly dirtyBlockBitmaps = new Set<number>();
  private readonly dirtyInodeBitmaps = new Set<number>();
  private readonly dirtyGroups = new Set<number>();
  private superDirty = false;
  private refcount: Uint32Array | null = null;

  private constructor(private readonly disk: Disk, options: OpenOptions) {
    this.writable = options.writable === true;
    this.epoch = options.epoch ?? 1230768000;

    this.sb = disk.read(SUPERBLOCK_OFFSET, 1024);
    if (this.sb.readUInt16LE(0x38) !== EXT4_MAGIC) throw new Error('not an ext4 volume (bad superblock magic)');

    const compat = this.sb.readUInt32LE(0x5c);
    const incompat = this.sb.readUInt32LE(0x60);
    const roCompat = this.sb.readUInt32LE(0x64);
    refuseUnsupported('compat', compat, SUPPORTED.compat);
    refuseUnsupported('incompat', incompat, SUPPORTED.incompat);
    refuseUnsupported('roCompat', roCompat, SUPPORTED.roCompat);
    if (!(incompat & INCOMPAT.EXTENTS)) throw new Error('volume does not use extents');
    if (!(incompat & INCOMPAT.FILETYPE)) throw new Error('volume does not store file types in directory entries');
    // Without it the kernel ignores the security.selinux this editor writes on every new file, and
    // Android would refuse the unlabeled result.
    if (!(compat & COMPAT.EXT_ATTR)) throw new Error('volume has no ext_attr, so new files could not carry their SELinux label');
    if (!(roCompat & RO_COMPAT.GDT_CSUM)) throw new Error('volume has no uninit_bg; its group checksums are not the kind this editor writes');

    this.sharedBlocks = (roCompat & RO_COMPAT.SHARED_BLOCKS) !== 0;
    this.inodesCount = this.sb.readUInt32LE(0x00);
    this.blocksCount = this.sb.readUInt32LE(0x04);
    this.firstDataBlock = this.sb.readUInt32LE(0x14);
    this.blockSize = 1024 << this.sb.readUInt32LE(0x18);
    this.blocksPerGroup = this.sb.readUInt32LE(0x20);
    this.inodesPerGroup = this.sb.readUInt32LE(0x28);
    const revLevel = this.sb.readUInt32LE(0x4c);
    this.firstIno = revLevel === 0 ? 11 : this.sb.readUInt32LE(0x54);
    this.inodeSize = revLevel === 0 ? 128 : this.sb.readUInt16LE(0x58);
    this.uuid = Buffer.from(this.sb.subarray(0x68, 0x78));
    this.label = this.sb.subarray(0x78, 0x88).toString('latin1').replace(/\0.*$/s, '');
    this.extraIsize = this.inodeSize > 128 ? Math.max(32, this.sb.readUInt16LE(0x15e) || 32) : 0;

    if (this.blockSize !== 4096 && this.blockSize !== 1024 && this.blockSize !== 2048) {
      throw new Error(`unsupported block size ${this.blockSize}`);
    }
    if (this.blocksCount * this.blockSize > disk.size) {
      throw new Error(`volume claims ${this.blocksCount * this.blockSize} bytes but only ${disk.size} are available`);
    }
    if (this.inodeSize < 128 || this.inodeSize > this.blockSize) throw new Error(`bad inode size ${this.inodeSize}`);
    // Only meaningful with 64bit, which is refused above; anything but "unset" or 32 means the
    // descriptor layout is not the one this editor reads.
    const descSize = this.sb.readUInt16LE(0xfe);
    if (descSize !== 0 && descSize !== 32) throw new Error(`unsupported group descriptor size ${descSize}`);
    // A volume with orphans was not cleanly finished; editing it would build on a half-deleted file.
    if (this.sb.readUInt32LE(0xe8) !== 0) throw new Error('volume has a non-empty orphan list (s_last_orphan)');

    this.groupCount = Math.ceil((this.blocksCount - this.firstDataBlock) / this.blocksPerGroup);
    if (this.groupCount * this.inodesPerGroup !== this.inodesCount) {
      throw new Error(`inode count ${this.inodesCount} does not match ${this.groupCount} groups of ${this.inodesPerGroup}`);
    }
    this.gdtBlocks = Math.ceil((this.groupCount * 32) / this.blockSize);

    const gdt = this.readBlocks(this.firstDataBlock + 1, this.gdtBlocks);
    this.groups = [];
    for (let g = 0; g < this.groupCount; g += 1) {
      const raw = Buffer.from(gdt.subarray(g * 32, g * 32 + 32));
      const desc: GroupDesc = {
        blockBitmap: raw.readUInt32LE(0x00),
        inodeBitmap: raw.readUInt32LE(0x04),
        inodeTable: raw.readUInt32LE(0x08),
        freeBlocks: raw.readUInt16LE(0x0c),
        freeInodes: raw.readUInt16LE(0x0e),
        usedDirs: raw.readUInt16LE(0x10),
        flags: raw.readUInt16LE(0x12),
        itableUnused: raw.readUInt16LE(0x1c),
        checksum: raw.readUInt16LE(0x1e),
        raw,
      };
      if (desc.checksum !== this.groupChecksum(g, raw)) {
        throw new Error(`group ${g} descriptor checksum does not match — the volume is damaged or not what it claims`);
      }
      this.groups.push(desc);
    }
  }

  static open(disk: Disk, options: OpenOptions = {}): Ext4Volume {
    return new Ext4Volume(disk, options);
  }

  get freeBlocks(): number {
    return this.sb.readUInt32LE(0x0c);
  }

  get freeInodes(): number {
    return this.sb.readUInt32LE(0x10);
  }

  // ── Blocks and groups ──────────────────────────────────────────────────────────────────────

  private readBlocks(block: number, count = 1): Buffer {
    return this.disk.read(block * this.blockSize, count * this.blockSize);
  }

  private writeBlock(block: number, data: Buffer): void {
    this.requireWritable();
    if (data.length !== this.blockSize) throw new Error(`block write of ${data.length} bytes`);
    if (block < this.firstDataBlock || block >= this.blocksCount) throw new Error(`block ${block} out of range`);
    this.disk.write(block * this.blockSize, data);
  }

  private requireWritable(): void {
    if (!this.writable) throw new Error('volume opened read-only');
  }

  private groupStart(g: number): number {
    return this.firstDataBlock + g * this.blocksPerGroup;
  }

  private groupBlockCount(g: number): number {
    return Math.min(this.blocksPerGroup, this.blocksCount - this.groupStart(g));
  }

  /** Groups 0, 1 and powers of 3, 5 and 7 carry a superblock and GDT backup under sparse_super. */
  private hasSuperBackup(g: number): boolean {
    const sparse = (this.sb.readUInt32LE(0x64) & RO_COMPAT.SPARSE_SUPER) !== 0;
    if (!sparse || g <= 1) return true;
    for (const base of [3, 5, 7]) {
      let n = base;
      while (n < g) n *= base;
      if (n === g) return true;
    }
    return false;
  }

  private groupChecksum(g: number, raw: Buffer): number {
    const le = Buffer.alloc(4);
    le.writeUInt32LE(g, 0);
    let crc = crc16(0xffff, this.uuid);
    crc = crc16(crc, le);
    crc = crc16(crc, raw.subarray(0, 0x1e));
    return crc;
  }

  /** Blocks in group `g` that belong to the filesystem itself rather than to any file. */
  private metadataBlocks(g: number): number[] {
    const out: number[] = [];
    const start = this.groupStart(g);
    if (this.hasSuperBackup(g)) {
      // The superblock's own block (block 0 holds it at byte 1024 when blocks are 4 KiB), then the GDT.
      for (let i = 0; i < 1 + this.gdtBlocks; i += 1) out.push(start + i);
    }
    const desc = this.groups[g];
    out.push(desc.blockBitmap, desc.inodeBitmap);
    const tableBlocks = Math.ceil((this.inodesPerGroup * this.inodeSize) / this.blockSize);
    for (let i = 0; i < tableBlocks; i += 1) out.push(desc.inodeTable + i);
    for (const b of out) {
      if (b < start || b >= start + this.groupBlockCount(g)) {
        throw new Error(`group ${g} metadata block ${b} lies outside the group — flex_bg-style layouts are not supported`);
      }
    }
    return out;
  }

  /**
   * The group's block bitmap, synthesised when the group is BLOCK_UNINIT.
   *
   * An uninitialised group's bitmap block holds whatever was on disk; the truth is "only the
   * group's own metadata is in use". Reading the block as if it were real is how a free-space
   * search ends up handing out an inode table.
   */
  private blockBitmap(g: number): Uint8Array {
    let bitmap = this.blockBitmaps.get(g);
    if (bitmap) return bitmap;
    const desc = this.groups[g];
    if (desc.flags & BG_BLOCK_UNINIT) {
      bitmap = new Uint8Array(this.blockSize);
      const start = this.groupStart(g);
      for (const b of this.metadataBlocks(g)) setBit(bitmap, b - start);
    } else {
      bitmap = new Uint8Array(this.readBlocks(desc.blockBitmap));
    }
    // Bits past the end of the last group stand for blocks that do not exist, and are always set.
    for (let i = this.groupBlockCount(g); i < this.blockSize * 8; i += 1) setBit(bitmap, i);
    this.blockBitmaps.set(g, bitmap);
    return bitmap;
  }

  private inodeBitmap(g: number): Uint8Array {
    let bitmap = this.inodeBitmaps.get(g);
    if (bitmap) return bitmap;
    const desc = this.groups[g];
    bitmap = desc.flags & BG_INODE_UNINIT ? new Uint8Array(this.blockSize) : new Uint8Array(this.readBlocks(desc.inodeBitmap));
    for (let i = this.inodesPerGroup; i < this.blockSize * 8; i += 1) setBit(bitmap, i);
    this.inodeBitmaps.set(g, bitmap);
    return bitmap;
  }

  private isBlockInUse(block: number): boolean {
    const g = Math.floor((block - this.firstDataBlock) / this.blocksPerGroup);
    return testBit(this.blockBitmap(g), block - this.groupStart(g));
  }

  private isInodeInUse(ino: number): boolean {
    const g = Math.floor((ino - 1) / this.inodesPerGroup);
    return testBit(this.inodeBitmap(g), (ino - 1) % this.inodesPerGroup);
  }

  // ── Inodes ─────────────────────────────────────────────────────────────────────────────────

  private inodeOffset(ino: number): number {
    if (ino < 1 || ino > this.inodesCount) throw new Error(`inode ${ino} out of range`);
    const g = Math.floor((ino - 1) / this.inodesPerGroup);
    const index = (ino - 1) % this.inodesPerGroup;
    return this.groups[g].inodeTable * this.blockSize + index * this.inodeSize;
  }

  private readInode(ino: number): Inode {
    return { ino, raw: this.disk.read(this.inodeOffset(ino), this.inodeSize) };
  }

  private writeInode(inode: Inode): void {
    this.requireWritable();
    this.disk.write(this.inodeOffset(inode.ino), inode.raw);
  }

  /** A copy of the inode's on-disk bytes, for diagnostics and byte-level tests. */
  rawInode(ino: number): Buffer {
    return this.readInode(ino).raw;
  }

  stat(ino: number): Stat {
    const { raw } = this.readInode(ino);
    const mode = raw.readUInt16LE(0x00);
    return {
      ino,
      mode,
      uid: raw.readUInt16LE(0x02) | (raw.readUInt16LE(0x78) << 16),
      gid: raw.readUInt16LE(0x18) | (raw.readUInt16LE(0x7a) << 16),
      size: inodeSize(raw),
      links: raw.readUInt16LE(0x1a),
      flags: raw.readUInt32LE(0x20),
      isDirectory: (mode & S_IFMT) === S_IFDIR,
      isFile: (mode & S_IFMT) === S_IFREG,
      isSymlink: (mode & S_IFMT) === S_IFLNK,
    };
  }

  /**
   * Extended attributes: in the inode, where the images keep SELinux labels, and in the external
   * block an inode with more of them uses (a file with `security.capability` beside its label).
   */
  xattrs(ino: number): Map<string, Buffer> {
    const { raw } = this.readInode(ino);
    const out = new Map<string, Buffer>();
    if (this.inodeSize > 128) {
      const base = 0x80 + raw.readUInt16LE(0x80);
      if (base + 4 <= this.inodeSize && raw.readUInt32LE(base) === XATTR_MAGIC) {
        // In-inode values are offset from the first entry.
        readXattrEntries(raw, base + 4, base + 4, this.inodeSize, out);
      }
    }
    const acl = xattrBlockOf(raw);
    if (acl !== 0) {
      const block = this.readBlocks(acl);
      if (block.readUInt32LE(0) !== XATTR_MAGIC) throw new Error(`inode ${ino}: block ${acl} is not an xattr block`);
      // Block values are offset from the start of the block; entries follow a 32-byte header.
      readXattrEntries(block, 32, 0, this.blockSize, out);
    }
    return out;
  }

  selinuxLabel(ino: number): string | null {
    const value = this.xattrs(ino).get('security.selinux');
    return value ? value.toString('latin1').replace(/\0$/, '') : null;
  }

  // ── Extents ────────────────────────────────────────────────────────────────────────────────

  /** Every extent of an inode, and every block the extent tree itself occupies outside the inode. */
  extents(ino: number): { extents: Extent[]; treeBlocks: number[] } {
    return this.extentsOf(this.readInode(ino));
  }

  private extentsOf(inode: Inode): { extents: Extent[]; treeBlocks: number[] } {
    const flags = inode.raw.readUInt32LE(0x20);
    if (!(flags & INODE_FLAG_EXTENTS)) {
      const mode = inode.raw.readUInt16LE(0x00);
      const blocks = inode.raw.readUInt32LE(0x1c);
      // A fast symlink keeps its target in i_block and owns no blocks. Anything else without the
      // extents flag is block-mapped, which these images never use.
      if ((mode & S_IFMT) === S_IFLNK && blocks === 0) return { extents: [], treeBlocks: [] };
      if (blocks === 0) return { extents: [], treeBlocks: [] };
      throw new Error(`inode ${inode.ino} is block-mapped; only extent-mapped files are supported`);
    }
    const extents: Extent[] = [];
    const treeBlocks: number[] = [];
    this.walkExtentNode(inode.raw.subarray(0x28, 0x28 + 60), 0, extents, treeBlocks, inode.ino);
    extents.sort((a, b) => a.logical - b.logical);
    for (let i = 1; i < extents.length; i += 1) {
      if (extents[i].logical < extents[i - 1].logical + extents[i - 1].length) {
        throw new Error(`inode ${inode.ino}: two extents map logical block ${extents[i].logical}`);
      }
    }
    return { extents, treeBlocks };
  }

  private walkExtentNode(node: Buffer, level: number, extents: Extent[], treeBlocks: number[], ino: number): void {
    if (level > 5) throw new Error(`inode ${ino}: extent tree deeper than 5 levels`);
    if (node.readUInt16LE(0) !== EXTENT_MAGIC) throw new Error(`inode ${ino}: bad extent header magic`);
    const entries = node.readUInt16LE(2);
    const depth = node.readUInt16LE(6);
    if (12 + entries * 12 > node.length) throw new Error(`inode ${ino}: extent node overflows`);
    for (let i = 0; i < entries; i += 1) {
      const at = 12 + i * 12;
      if (depth === 0) {
        const rawLen = node.readUInt16LE(at + 4);
        extents.push({
          logical: node.readUInt32LE(at),
          start: node.readUInt16LE(at + 6) * 0x1_0000_0000 + node.readUInt32LE(at + 8),
          length: rawLen > 32768 ? rawLen - 32768 : rawLen,
          uninit: rawLen > 32768,
        });
      } else {
        const child = node.readUInt32LE(at + 4) + node.readUInt16LE(at + 8) * 0x1_0000_0000;
        this.checkDataBlock(child, ino);
        treeBlocks.push(child);
        this.walkExtentNode(this.readBlocks(child), level + 1, extents, treeBlocks, ino);
      }
    }
  }

  private checkDataBlock(block: number, ino: number): void {
    if (block < this.firstDataBlock || block >= this.blocksCount) {
      throw new Error(`inode ${ino} references block ${block}, outside the volume`);
    }
  }

  /**
   * Every physical block an inode references: extent tree blocks, then data — one entry per
   * reference, so a block can appear more than once.
   *
   * It does on Google's images. e2fsdroid deduplicates identical blocks *within* a file as well as
   * between files, so one file can map the same physical block at two logical offsets. Each
   * mapping is a reference and is counted as one, which is what makes removing that file free the
   * block exactly once, when its last reference goes. What would be damage is two extents claiming
   * the same *logical* range, and `extentsOf` refuses that.
   */
  private ownedBlocks(inode: Inode): number[] {
    const { extents, treeBlocks } = this.extentsOf(inode);
    const out = [...treeBlocks];
    for (const e of extents) {
      for (let i = 0; i < e.length; i += 1) {
        this.checkDataBlock(e.start + i, inode.ino);
        out.push(e.start + i);
      }
    }
    return out;
  }

  // ── Reading files and directories ──────────────────────────────────────────────────────────

  readFile(pathOrIno: string | number): Buffer {
    const ino = typeof pathOrIno === 'number' ? pathOrIno : this.require(pathOrIno);
    const inode = this.readInode(ino);
    const mode = inode.raw.readUInt16LE(0x00);
    const size = inodeSize(inode.raw);
    if ((mode & S_IFMT) === S_IFLNK && !(inode.raw.readUInt32LE(0x20) & INODE_FLAG_EXTENTS)) {
      return Buffer.from(inode.raw.subarray(0x28, 0x28 + size));
    }
    const out = Buffer.alloc(size);
    for (const e of this.extentsOf(inode).extents) {
      if (e.uninit) continue;
      const from = e.logical * this.blockSize;
      if (from >= size) continue;
      const data = this.readBlocks(e.start, e.length);
      data.copy(out, from, 0, Math.min(data.length, size - from));
    }
    return out;
  }

  /**
   * Entries of a directory, `.` and `..` included.
   *
   * Linear and hashed (`dir_index`) directories read the same way: an htree's root block hides its
   * index inside the `..` record, and its internal index blocks look like one empty record the
   * size of the block, so a scan of every block sees exactly the leaves.
   */
  readDir(pathOrIno: string | number): DirEntry[] {
    const ino = typeof pathOrIno === 'number' ? pathOrIno : this.require(pathOrIno);
    return this.dirRecords(ino)
      .filter((r) => r.inode !== 0)
      .map((r) => ({ name: r.name, inode: r.inode, fileType: r.fileType }));
  }

  private dirRecords(ino: number): Array<DirEntry & { block: number; offset: number; recLen: number; physical: number }> {
    const inode = this.readInode(ino);
    if ((inode.raw.readUInt16LE(0x00) & S_IFMT) !== S_IFDIR) throw new Error(`inode ${ino} is not a directory`);
    const out: Array<DirEntry & { block: number; offset: number; recLen: number; physical: number }> = [];
    for (const e of this.extentsOf(inode).extents) {
      for (let i = 0; i < e.length; i += 1) {
        const physical = e.start + i;
        const data = this.readBlocks(physical);
        let at = 0;
        while (at < this.blockSize) {
          const child = data.readUInt32LE(at);
          const recLen = data.readUInt16LE(at + 4);
          const nameLen = data[at + 6];
          if (recLen < 8 || recLen % 4 !== 0 || at + recLen > this.blockSize || 8 + nameLen > recLen) {
            throw new Error(`directory inode ${ino}: corrupt entry at block ${e.logical + i} offset ${at}`);
          }
          out.push({
            name: data.subarray(at + 8, at + 8 + nameLen).toString('utf8'),
            inode: child,
            fileType: data[at + 7],
            block: e.logical + i,
            physical,
            offset: at,
            recLen,
          });
          at += recLen;
        }
      }
    }
    return out;
  }

  /** Inode number for an absolute path, or null. */
  lookup(path: string): number | null {
    let ino = ROOT_INO;
    for (const part of splitPath(path)) {
      const entry = this.readDir(ino).find((e) => e.name === part);
      if (!entry) return null;
      ino = entry.inode;
    }
    return ino;
  }

  exists(path: string): boolean {
    return this.lookup(path) !== null;
  }

  private require(path: string): number {
    const ino = this.lookup(path);
    if (ino === null) throw new Error(`${path}: no such file or directory`);
    return ino;
  }

  // ── Reference counts ───────────────────────────────────────────────────────────────────────

  /** Every in-use inode number, walked from the bitmaps. */
  private *inUseInodes(): Generator<number> {
    for (let g = 0; g < this.groupCount; g += 1) {
      if (this.groups[g].flags & BG_INODE_UNINIT) continue;
      const bitmap = this.inodeBitmap(g);
      for (let i = 0; i < this.inodesPerGroup; i += 1) {
        if (testBit(bitmap, i)) yield g * this.inodesPerGroup + i + 1;
      }
    }
  }

  /**
   * How many inodes reference each block. Built once, then kept in step by every mutation.
   *
   * This is what makes freeing safe on a `shared_blocks` volume: a debloated APK may share blocks
   * with a file that stays, and those must remain allocated.
   */
  private refs(): Uint32Array {
    if (this.refcount) return this.refcount;
    const counts = new Uint32Array(this.blocksCount);
    for (const ino of this.inUseInodes()) {
      if (ino !== ROOT_INO && ino < this.firstIno) {
        // Reserved inodes other than the root own nothing on these volumes (no journal, no resize
        // inode). Confirm rather than assume.
        const inode = this.readInode(ino);
        if (inode.raw.readUInt32LE(0x1c) !== 0 && inode.raw.readUInt32LE(0x20) & INODE_FLAG_EXTENTS) {
          throw new Error(`reserved inode ${ino} owns blocks; not supported`);
        }
        continue;
      }
      const inode = this.readInode(ino);
      for (const b of this.ownedBlocks(inode)) counts[b] += 1;
      // An external xattr block — `/system/bin/run-as` has one, for `security.capability` beside
      // its label — is a reference like any other, and ext4 lets several inodes share one.
      const acl = xattrBlockOf(inode.raw);
      if (acl !== 0) {
        this.checkDataBlock(acl, ino);
        counts[acl] += 1;
      }
    }
    this.refcount = counts;
    return counts;
  }

  /**
   * Drops one inode's reference to its external xattr block.
   *
   * The block keeps its own count of the inodes using it (`h_refcount`), and e2fsck holds it to the
   * real number. So the header is rewritten to match whenever a reference goes, and the block is
   * freed with the last one. Writing a shared xattr block's header is not the hazard writing a
   * shared data block is: that count is the one field every sharer agrees on.
   */
  private releaseXattrBlock(block: number): void {
    const refs = this.refs();
    const data = this.readBlocks(block);
    if (data.readUInt32LE(0) !== XATTR_MAGIC || data.readUInt32LE(8) !== 1) {
      throw new Error(`block ${block} is not a single-block xattr block`);
    }
    if (refs[block] <= 1) {
      this.releaseBlocks([block]);
      return;
    }
    refs[block] -= 1;
    data.writeUInt32LE(refs[block], 4);
    this.writeBlock(block, data);
  }

  // ── Allocation ─────────────────────────────────────────────────────────────────────────────

  private markBlocks(start: number, length: number, used: boolean): void {
    for (let b = start; b < start + length; b += 1) {
      const g = Math.floor((b - this.firstDataBlock) / this.blocksPerGroup);
      const bitmap = this.blockBitmap(g);
      const bit = b - this.groupStart(g);
      if (testBit(bitmap, bit) === used) throw new Error(`block ${b} is already ${used ? 'in use' : 'free'}`);
      if (used) setBit(bitmap, bit);
      else clearBit(bitmap, bit);
      const desc = this.groups[g];
      desc.freeBlocks += used ? -1 : 1;
      // The bitmap is real now, whatever it was before.
      desc.flags &= ~BG_BLOCK_UNINIT;
      this.dirtyBlockBitmaps.add(g);
      this.dirtyGroups.add(g);
    }
    this.sb.writeUInt32LE(this.freeBlocks + (used ? -length : length), 0x0c);
    this.superDirty = true;
  }

  /**
   * Finds `count` free blocks, as few runs as possible and never more than `maxRuns` (four fit in
   * an inode without an extent tree block). Prefers `goalGroup`, then initialised groups.
   */
  private allocateBlocks(count: number, goalGroup: number, maxRuns = 4): Array<{ start: number; length: number }> {
    this.requireWritable();
    if (count === 0) return [];
    if (count > this.freeBlocks) throw new Error(`need ${count} blocks, ${this.freeBlocks} free`);
    const refs = this.refs();

    const order = [...Array(this.groupCount).keys()].sort((a, b) => {
      const score = (g: number) => (g === goalGroup ? 0 : this.groups[g].flags & BG_BLOCK_UNINIT ? 2 : 1);
      return score(a) - score(b) || a - b;
    });

    const runsIn = (g: number): Array<{ start: number; length: number }> => {
      if (this.groups[g].freeBlocks === 0) return [];
      const bitmap = this.blockBitmap(g);
      const start = this.groupStart(g);
      const runs: Array<{ start: number; length: number }> = [];
      let runStart = -1;
      const total = this.groupBlockCount(g);
      for (let i = 0; i <= total; i += 1) {
        const free = i < total && !testBit(bitmap, i);
        if (free && runStart < 0) runStart = i;
        if (!free && runStart >= 0) {
          runs.push({ start: start + runStart, length: i - runStart });
          runStart = -1;
        }
      }
      return runs;
    };

    // One run that fits, if any group has one.
    for (const g of order) {
      const run = runsIn(g).find((r) => r.length >= count);
      if (run) {
        this.markBlocks(run.start, count, true);
        for (let b = run.start; b < run.start + count; b += 1) refs[b] = 1;
        return [{ start: run.start, length: count }];
      }
    }

    // Otherwise the largest runs first, up to maxRuns.
    const all = order.flatMap((g) => runsIn(g)).sort((a, b) => b.length - a.length);
    const picked: Array<{ start: number; length: number }> = [];
    let remaining = count;
    for (const run of all) {
      if (remaining === 0 || picked.length === maxRuns) break;
      const take = Math.min(run.length, remaining);
      picked.push({ start: run.start, length: take });
      remaining -= take;
    }
    if (remaining > 0) throw new Error(`cannot place ${count} blocks in ${maxRuns} runs; free space is too fragmented`);
    for (const run of picked) {
      this.markBlocks(run.start, run.length, true);
      for (let b = run.start; b < run.start + run.length; b += 1) refs[b] = 1;
    }
    return picked.sort((a, b) => a.start - b.start);
  }

  /** Drops one reference from each block, freeing those that reach zero. */
  private releaseBlocks(blocks: number[]): { freed: number; stillShared: number } {
    const refs = this.refs();
    let freed = 0;
    let stillShared = 0;
    for (const b of blocks) {
      if (refs[b] === 0) throw new Error(`block ${b} released more times than it is referenced`);
      refs[b] -= 1;
      if (refs[b] === 0) {
        this.markBlocks(b, 1, false);
        freed += 1;
      } else {
        stillShared += 1;
      }
    }
    return { freed, stillShared };
  }

  private allocateInode(goalGroup: number, isDirectory: boolean): number {
    this.requireWritable();
    if (this.freeInodes === 0) throw new Error('no free inodes');
    const order = [...Array(this.groupCount).keys()].sort((a, b) => {
      const score = (g: number) => (g === goalGroup ? 0 : this.groups[g].flags & BG_INODE_UNINIT ? 2 : 1);
      return score(a) - score(b) || a - b;
    });
    for (const g of order) {
      const desc = this.groups[g];
      if (desc.freeInodes === 0) continue;
      const bitmap = this.inodeBitmap(g);
      for (let i = 0; i < this.inodesPerGroup; i += 1) {
        const ino = g * this.inodesPerGroup + i + 1;
        if (ino < this.firstIno || testBit(bitmap, i)) continue;
        setBit(bitmap, i);
        desc.freeInodes -= 1;
        if (isDirectory) desc.usedDirs += 1;
        desc.flags &= ~BG_INODE_UNINIT;
        // Inodes past the in-use high-water mark are "unused" and never read; moving the mark is
        // what makes the new one visible.
        if (i >= this.inodesPerGroup - desc.itableUnused) desc.itableUnused = this.inodesPerGroup - i - 1;
        this.dirtyInodeBitmaps.add(g);
        this.dirtyGroups.add(g);
        this.sb.writeUInt32LE(this.freeInodes - 1, 0x10);
        this.superDirty = true;
        return ino;
      }
    }
    throw new Error('no free inodes (group counts disagree with bitmaps)');
  }

  private freeInode(ino: number, isDirectory: boolean): void {
    const g = Math.floor((ino - 1) / this.inodesPerGroup);
    const bit = (ino - 1) % this.inodesPerGroup;
    const bitmap = this.inodeBitmap(g);
    if (!testBit(bitmap, bit)) throw new Error(`inode ${ino} is already free`);
    clearBit(bitmap, bit);
    const desc = this.groups[g];
    desc.freeInodes += 1;
    if (isDirectory) desc.usedDirs -= 1;
    this.dirtyInodeBitmaps.add(g);
    this.dirtyGroups.add(g);
    this.sb.writeUInt32LE(this.freeInodes + 1, 0x10);
    this.superDirty = true;
    // Zeroed, so nothing can mistake the remains for a live inode.
    this.writeInode({ ino, raw: Buffer.alloc(this.inodeSize) });
  }

  private groupOfInode(ino: number): number {
    return Math.floor((ino - 1) / this.inodesPerGroup);
  }

  // ── Directory entries ──────────────────────────────────────────────────────────────────────

  /** A directory block may be edited in place only if no other file shares it. */
  private requireUnshared(block: number, what: string): void {
    if (this.refs()[block] > 1) throw new Error(`${what}: block ${block} is shared with another file; refusing to edit it in place`);
  }

  private removeEntry(dirIno: number, name: string): DirEntry {
    const records = this.dirRecords(dirIno);
    const index = records.findIndex((r) => r.inode !== 0 && r.name === name);
    if (index < 0) throw new Error(`${name}: not in directory ${dirIno}`);
    const target = records[index];
    if (name === '.' || name === '..') throw new Error('refusing to remove . or ..');
    this.requireUnshared(target.physical, `directory ${dirIno}`);

    const block = this.readBlocks(target.physical);
    const previous = index > 0 ? records[index - 1] : null;
    if (previous && previous.physical === target.physical) {
      // Fold the record into the one before it, which is how the kernel deletes.
      block.writeUInt16LE(previous.recLen + target.recLen, previous.offset + 4);
    } else {
      // First record in its block: keep the record, mark it empty.
      block.writeUInt32LE(0, target.offset);
      block[target.offset + 7] = 0;
    }
    this.writeBlock(target.physical, block);
    return { name: target.name, inode: target.inode, fileType: target.fileType };
  }

  private addEntry(dirIno: number, name: string, childIno: number, fileType: number): void {
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length === 0 || nameBytes.length > 255 || name.includes('/') || name.includes('\0')) {
      throw new Error(`invalid file name ${JSON.stringify(name)}`);
    }
    const dir = this.readInode(dirIno);
    if (dir.raw.readUInt32LE(0x20) & INODE_FLAG_INDEX) {
      // Inserting into a hashed directory means placing the entry in the leaf its hash selects,
      // and splitting that leaf when it is full. Nothing the ROM adds needs it, so it is refused
      // rather than half-done.
      throw new Error(`directory ${dirIno} is hashed (dir_index); adding entries to it is not supported`);
    }
    if (this.readDir(dirIno).some((e) => e.name === name)) throw new Error(`${name} already exists`);

    const needed = (8 + nameBytes.length + 3) & ~3;
    const write = (block: Buffer, offset: number, recLen: number) => {
      block.writeUInt32LE(childIno, offset);
      block.writeUInt16LE(recLen, offset + 4);
      block[offset + 6] = nameBytes.length;
      block[offset + 7] = fileType;
      block.fill(0, offset + 8, offset + recLen);
      nameBytes.copy(block, offset + 8);
    };

    for (const record of this.dirRecords(dirIno)) {
      const used = record.inode === 0 ? 0 : (8 + Buffer.byteLength(record.name, 'utf8') + 3) & ~3;
      if (record.recLen - used < needed) continue;
      this.requireUnshared(record.physical, `directory ${dirIno}`);
      const block = this.readBlocks(record.physical);
      if (used === 0) {
        write(block, record.offset, record.recLen);
      } else {
        block.writeUInt16LE(used, record.offset + 4);
        write(block, record.offset + used, record.recLen - used);
      }
      this.writeBlock(record.physical, block);
      return;
    }

    // No room: grow the directory by one block.
    const { extents, treeBlocks } = this.extentsOf(dir);
    if (treeBlocks.length > 0) throw new Error(`directory ${dirIno} has an extent tree; growing it is not supported`);
    const [run] = this.allocateBlocks(1, this.groupOfInode(dirIno), 1);
    const block = Buffer.alloc(this.blockSize);
    write(block, 0, this.blockSize);
    this.writeBlock(run.start, block);

    const nextLogical = extents.reduce((max, e) => Math.max(max, e.logical + e.length), 0);
    const last = extents[extents.length - 1];
    if (last && !last.uninit && last.start + last.length === run.start && last.length < 32768) {
      last.length += 1;
    } else {
      extents.push({ logical: nextLogical, start: run.start, length: 1, uninit: false });
    }
    if (extents.length > 4) throw new Error(`directory ${dirIno} would need more than four extents`);
    writeExtentRoot(dir.raw, extents);
    setInodeSize(dir.raw, (nextLogical + 1) * this.blockSize);
    addInodeBlocks(dir.raw, this.blockSize / 512);
    this.writeInode(dir);
  }

  // ── Mutations ──────────────────────────────────────────────────────────────────────────────

  /**
   * Removes a file or directory tree, freeing what it owned.
   *
   * A file with hard links outside the tree keeps its inode and its blocks; only the links being
   * removed are dropped.
   */
  removeTree(path: string): RemoveReport {
    this.requireWritable();
    const parts = splitPath(path);
    if (parts.length === 0) throw new Error('refusing to remove the root');
    const parentIno = this.require('/' + parts.slice(0, -1).join('/'));
    const name = parts[parts.length - 1];
    const childIno = this.require(path);
    this.refs();

    // Every inode under the tree, with how many of its links are inside it.
    const linksRemoved = new Map<number, number>();
    const directories = new Set<number>();
    const visit = (ino: number) => {
      linksRemoved.set(ino, (linksRemoved.get(ino) ?? 0) + 1);
      if (!this.stat(ino).isDirectory) return;
      if (directories.has(ino)) throw new Error(`directory ${ino} reached twice; the tree is not a tree`);
      directories.add(ino);
      for (const entry of this.readDir(ino)) {
        if (entry.name === '.' || entry.name === '..') continue;
        visit(entry.inode);
      }
    };
    visit(childIno);
    if (linksRemoved.has(ROOT_INO)) throw new Error('refusing to remove the root');

    const report: RemoveReport = { inodesFreed: 0, blocksFreed: 0, blocksStillShared: 0 };
    for (const [ino, removed] of linksRemoved) {
      const inode = this.readInode(ino);
      const isDir = directories.has(ino);
      const links = inode.raw.readUInt16LE(0x1a);
      if (!isDir && links > removed) {
        inode.raw.writeUInt16LE(links - removed, 0x1a);
        this.writeInode(inode);
        continue;
      }
      const released = this.releaseBlocks(this.ownedBlocks(inode));
      report.blocksFreed += released.freed;
      report.blocksStillShared += released.stillShared;
      const acl = xattrBlockOf(inode.raw);
      if (acl !== 0) this.releaseXattrBlock(acl);
      this.freeInode(ino, isDir);
      report.inodesFreed += 1;
    }

    this.removeEntry(parentIno, name);
    if (directories.has(childIno)) {
      // The removed directory's `..` no longer points at the parent.
      const parent = this.readInode(parentIno);
      const links = parent.raw.readUInt16LE(0x1a);
      if (links > 2 && links < DIR_NLINK_MAX) {
        parent.raw.writeUInt16LE(links - 1, 0x1a);
        this.writeInode(parent);
      }
    }
    return report;
  }

  /** Creates a regular file. Fails if it exists; use `replaceFile` for that. */
  createFile(path: string, data: Buffer, options: NewInodeOptions): number {
    this.requireWritable();
    // Counted before anything is allocated: the scan reads every in-use inode, and one allocated
    // but not yet written would be read as whatever the inode table held.
    this.refs();
    const { parentIno, name } = this.parentOf(path);
    const ino = this.allocateInode(this.groupOfInode(parentIno), false);
    const runs = this.writeData(data, this.groupOfInode(parentIno));
    const raw = this.newInodeRaw(S_IFREG | (options.mode & 0o7777), options, 1);
    setInodeSize(raw, data.length);
    writeExtentRoot(raw, runsToExtents(runs));
    addInodeBlocks(raw, (runs.reduce((n, r) => n + r.length, 0) * this.blockSize) / 512);
    this.writeInode({ ino, raw });
    this.addEntry(parentIno, name, ino, FT.REG);
    return ino;
  }

  mkdir(path: string, options: NewInodeOptions): number {
    this.requireWritable();
    this.refs();
    const { parentIno, name } = this.parentOf(path);
    const ino = this.allocateInode(this.groupOfInode(parentIno), true);
    const [run] = this.allocateBlocks(1, this.groupOfInode(ino), 1);

    const block = Buffer.alloc(this.blockSize);
    block.writeUInt32LE(ino, 0);
    block.writeUInt16LE(12, 4);
    block[6] = 1;
    block[7] = FT.DIR;
    block.write('.', 8, 'latin1');
    block.writeUInt32LE(parentIno, 12);
    block.writeUInt16LE(this.blockSize - 12, 16);
    block[18] = 2;
    block[19] = FT.DIR;
    block.write('..', 20, 'latin1');
    this.writeBlock(run.start, block);

    const raw = this.newInodeRaw(S_IFDIR | (options.mode & 0o7777), options, 2);
    setInodeSize(raw, this.blockSize);
    writeExtentRoot(raw, runsToExtents([run]));
    addInodeBlocks(raw, this.blockSize / 512);
    this.writeInode({ ino, raw });

    this.addEntry(parentIno, name, ino, FT.DIR);
    const parent = this.readInode(parentIno);
    const links = parent.raw.readUInt16LE(0x1a);
    // 1 is dir_nlink's "too many to count" sentinel, and stays 1; it is not a tally to add to.
    if (links !== 1) {
      parent.raw.writeUInt16LE(links + 1 >= DIR_NLINK_MAX ? 1 : links + 1, 0x1a);
      this.writeInode(parent);
    }
    return ino;
  }

  /**
   * Replaces a regular file's content, keeping its inode — and so its mode, owner and label.
   *
   * In place when every block the file owns is referenced by it alone and the new content fits:
   * the vendor volume has one free inode and fifty free blocks, and rewriting its `build.prop`
   * must not depend on either. Otherwise the new bytes go into new blocks and the old ones are
   * released through the reference count — on a deduplicated volume "this file's block" may also
   * be someone else's, and that block is never written.
   */
  replaceFile(path: string, data: Buffer): void {
    this.requireWritable();
    const refs = this.refs();
    const ino = this.require(path);
    const inode = this.readInode(ino);
    if ((inode.raw.readUInt16LE(0x00) & S_IFMT) !== S_IFREG) throw new Error(`${path} is not a regular file`);
    const { extents, treeBlocks } = this.extentsOf(inode);
    const old = this.ownedBlocks(inode);
    const needed = Math.ceil(data.length / this.blockSize);

    // The data blocks in file order, if the file is a plain run of them from logical block 0.
    let expectLogical = 0;
    const dataBlocks: number[] = [];
    let plain = treeBlocks.length === 0;
    for (const e of extents) {
      if (e.uninit || e.logical !== expectLogical) plain = false;
      for (let i = 0; i < e.length; i += 1) dataBlocks.push(e.start + i);
      expectLogical = e.logical + e.length;
    }
    const keep = dataBlocks.slice(0, needed);
    const keepRuns = blocksToRuns(keep);
    const inPlace = plain && old.every((b) => refs[b] === 1) && dataBlocks.length >= needed && keepRuns.length <= 4;

    let runs: Array<{ start: number; length: number }>;
    if (inPlace) {
      keep.forEach((b, i) => {
        const block = Buffer.alloc(this.blockSize);
        data.copy(block, 0, i * this.blockSize, Math.min((i + 1) * this.blockSize, data.length));
        this.writeBlock(b, block);
      });
      this.releaseBlocks(dataBlocks.slice(needed));
      runs = keepRuns;
    } else {
      runs = this.writeData(data, this.groupOfInode(ino));
      this.releaseBlocks(old);
    }
    setInodeSize(inode.raw, data.length);
    writeExtentRoot(inode.raw, runsToExtents(runs));
    const flags = inode.raw.readUInt32LE(0x20) & ~INODE_FLAG_HUGE_FILE;
    inode.raw.writeUInt32LE(flags | INODE_FLAG_EXTENTS, 0x20);
    inode.raw.writeUInt32LE(0, 0x1c);
    inode.raw.writeUInt16LE(0, 0x74);
    // i_blocks counts the external xattr block too; the inode keeps it, so the count must.
    const dataBlocksNow = runs.reduce((n, r) => n + r.length, 0) + (xattrBlockOf(inode.raw) !== 0 ? 1 : 0);
    addInodeBlocks(inode.raw, (dataBlocksNow * this.blockSize) / 512);
    inode.raw.writeUInt32LE(this.epoch, 0x0c);
    inode.raw.writeUInt32LE(this.epoch, 0x10);
    this.writeInode(inode);
  }

  private parentOf(path: string): { parentIno: number; name: string } {
    const parts = splitPath(path);
    if (parts.length === 0) throw new Error('the root has no parent');
    const parentIno = this.require('/' + parts.slice(0, -1).join('/'));
    if (!this.stat(parentIno).isDirectory) throw new Error(`${path}: parent is not a directory`);
    return { parentIno, name: parts[parts.length - 1] };
  }

  private writeData(data: Buffer, goalGroup: number): Array<{ start: number; length: number }> {
    const count = Math.ceil(data.length / this.blockSize);
    const runs = this.allocateBlocks(count, goalGroup);
    let at = 0;
    for (const run of runs) {
      for (let i = 0; i < run.length; i += 1) {
        const block = Buffer.alloc(this.blockSize);
        data.copy(block, 0, at, Math.min(at + this.blockSize, data.length));
        this.writeBlock(run.start + i, block);
        at += this.blockSize;
      }
    }
    return runs;
  }

  private newInodeRaw(mode: number, options: NewInodeOptions, links: number): Buffer {
    if (!options.selinux) throw new Error('a new inode needs a security.selinux label');
    const raw = Buffer.alloc(this.inodeSize);
    const uid = options.uid ?? 0;
    const gid = options.gid ?? 0;
    raw.writeUInt16LE(mode, 0x00);
    raw.writeUInt16LE(uid & 0xffff, 0x02);
    raw.writeUInt32LE(this.epoch, 0x08);
    raw.writeUInt32LE(this.epoch, 0x0c);
    raw.writeUInt32LE(this.epoch, 0x10);
    raw.writeUInt16LE(gid & 0xffff, 0x18);
    raw.writeUInt16LE(links, 0x1a);
    raw.writeUInt32LE(INODE_FLAG_EXTENTS, 0x20);
    raw.writeUInt16LE(uid >>> 16, 0x78);
    raw.writeUInt16LE(gid >>> 16, 0x7a);
    writeExtentRoot(raw, []);
    if (this.inodeSize > 128) {
      raw.writeUInt16LE(this.extraIsize, 0x80);
      raw.writeUInt32LE(this.epoch, 0x90);
      writeInodeXattr(raw, 0x80 + this.extraIsize, 'selinux', Buffer.from(`${options.selinux}\0`, 'latin1'));
    }
    return raw;
  }

  // ── Persisting ─────────────────────────────────────────────────────────────────────────────

  /**
   * Writes bitmaps, group descriptors (with fresh checksums) and the superblock — and the backup
   * copies of the last two in every group that carries one, as `ext2fs_flush` does.
   *
   * The kernel reads only the primaries, so stale backups would boot fine. They matter to repair:
   * `e2fsck -b` or a damaged primary would bring back the stock allocation state over files that
   * no longer match it, and quietly undo the ROM.
   */
  flush(): void {
    if (!this.writable) return;
    for (const g of this.dirtyBlockBitmaps) this.writeBlock(this.groups[g].blockBitmap, Buffer.from(this.blockBitmap(g)));
    for (const g of this.dirtyInodeBitmaps) this.writeBlock(this.groups[g].inodeBitmap, Buffer.from(this.inodeBitmap(g)));
    this.dirtyBlockBitmaps.clear();
    this.dirtyInodeBitmaps.clear();

    const writeBackups = this.dirtyGroups.size > 0 || this.superDirty;

    if (this.dirtyGroups.size > 0) {
      const gdt = this.readBlocks(this.firstDataBlock + 1, this.gdtBlocks);
      for (const g of this.dirtyGroups) {
        const desc = this.groups[g];
        const raw = desc.raw;
        raw.writeUInt16LE(desc.freeBlocks, 0x0c);
        raw.writeUInt16LE(desc.freeInodes, 0x0e);
        raw.writeUInt16LE(desc.usedDirs, 0x10);
        raw.writeUInt16LE(desc.flags, 0x12);
        raw.writeUInt16LE(desc.itableUnused, 0x1c);
        desc.checksum = this.groupChecksum(g, raw);
        raw.writeUInt16LE(desc.checksum, 0x1e);
        raw.copy(gdt, g * 32);
      }
      for (let i = 0; i < this.gdtBlocks; i += 1) {
        this.writeBlock(this.firstDataBlock + 1 + i, Buffer.from(gdt.subarray(i * this.blockSize, (i + 1) * this.blockSize)));
      }
      this.dirtyGroups.clear();
    }

    if (this.superDirty) {
      this.disk.write(SUPERBLOCK_OFFSET, this.sb);
      this.superDirty = false;
    }

    if (writeBackups) {
      const gdt = this.readBlocks(this.firstDataBlock + 1, this.gdtBlocks);
      for (let g = 1; g < this.groupCount; g += 1) {
        if (!this.hasSuperBackup(g)) continue;
        const start = this.groupStart(g);
        // A backup superblock sits at the very start of its group's first block, and records
        // which group it is in.
        const copy = Buffer.from(this.sb);
        copy.writeUInt16LE(g, 0x5a);
        const block = this.readBlocks(start);
        copy.copy(block, 0);
        this.writeBlock(start, block);
        for (let i = 0; i < this.gdtBlocks; i += 1) {
          this.writeBlock(start + 1 + i, Buffer.from(gdt.subarray(i * this.blockSize, (i + 1) * this.blockSize)));
        }
      }
    }
  }

  // ── Verification ───────────────────────────────────────────────────────────────────────────

  /**
   * Re-derives the allocation state from the inodes and checks it against what is on disk.
   *
   * Covers what `e2fsck` passes 1, 2, 4 and 5 would catch after the kinds of edit this editor
   * makes: bitmaps against reachable blocks, counts against bitmaps, group checksums, directory
   * structure, link counts, and inodes that are allocated but unreachable. Reads through the
   * editor's own caches, so run it after `flush()` on a fresh `open()` to check what was written.
   */
  verify(): VerifyReport {
    const problems: string[] = [];
    const problem = (message: string) => {
      if (problems.length < 200) problems.push(message);
    };

    for (let g = 0; g < this.groupCount; g += 1) {
      const raw = this.groups[g].raw;
      if (raw.readUInt16LE(0x1e) !== this.groupChecksum(g, raw)) problem(`group ${g}: checksum mismatch`);
    }
    if (this.sb.readUInt32LE(0xe8) !== 0) problem('superblock: orphan list is not empty');

    // Expected use of every block: metadata, then everything reachable from in-use inodes.
    const expected = new Uint8Array(this.blocksCount);
    for (let g = 0; g < this.groupCount; g += 1) {
      for (const b of this.metadataBlocks(g)) expected[b] = 1;
    }
    const inUse = new Set(this.inUseInodes());
    const owner = new Map<number, number>();
    const xattrUsers = new Map<number, number>();
    for (const ino of inUse) {
      if (ino !== ROOT_INO && ino < this.firstIno) continue;
      let blocks: number[];
      const inode = this.readInode(ino);
      try {
        blocks = this.ownedBlocks(inode);
      } catch (err) {
        problem((err as Error).message);
        continue;
      }
      const acl = xattrBlockOf(inode.raw);
      if (acl !== 0) {
        if (acl >= this.blocksCount) {
          problem(`inode ${ino}: xattr block ${acl} is outside the volume`);
        } else {
          xattrUsers.set(acl, (xattrUsers.get(acl) ?? 0) + 1);
          if (expected[acl] === 1 && !owner.has(acl)) problem(`inode ${ino}: xattr block ${acl} is a metadata block`);
          owner.set(acl, ino);
          expected[acl] = 2;
        }
      }
      // i_blocks counts 512-byte sectors, or filesystem blocks under the inode's HUGE_FILE flag,
      // and includes the external xattr block.
      const flags = inode.raw.readUInt32LE(0x20);
      const recorded = inode.raw.readUInt32LE(0x1c) + inode.raw.readUInt16LE(0x74) * 0x1_0000_0000;
      const sectors = recorded * (flags & INODE_FLAG_HUGE_FILE ? this.blockSize / 512 : 1);
      const owned = blocks.length + (acl !== 0 ? 1 : 0);
      if (sectors !== owned * (this.blockSize / 512)) {
        problem(`inode ${ino}: i_blocks says ${sectors} sectors, it owns ${owned} blocks`);
      }
      for (const b of blocks) {
        if (expected[b] === 1 && !owner.has(b)) problem(`inode ${ino} owns metadata block ${b}`);
        if (owner.has(b) && !this.sharedBlocks) problem(`block ${b} is owned by inodes ${owner.get(b)} and ${ino}`);
        owner.set(b, ino);
        expected[b] = 2;
      }
    }

    for (const [block, users] of xattrUsers) {
      const data = this.readBlocks(block);
      if (data.readUInt32LE(0) !== XATTR_MAGIC) problem(`block ${block}: referenced as xattrs but not an xattr block`);
      else if (data.readUInt32LE(4) !== users) problem(`xattr block ${block}: h_refcount ${data.readUInt32LE(4)}, used by ${users} inodes`);
    }

    let freeBlocks = 0;
    let freeInodes = 0;
    for (let g = 0; g < this.groupCount; g += 1) {
      const desc = this.groups[g];
      const bitmap = this.blockBitmap(g);
      const start = this.groupStart(g);
      let free = 0;
      for (let i = 0; i < this.groupBlockCount(g); i += 1) {
        const onDisk = testBit(bitmap, i);
        const want = expected[start + i] !== 0;
        if (onDisk && !want) problem(`block ${start + i}: marked in use, owned by nothing`);
        if (!onDisk && want) problem(`block ${start + i}: in use but marked free`);
        if (!onDisk) free += 1;
      }
      for (let i = this.groupBlockCount(g); i < this.blockSize * 8; i += 1) {
        if (!testBit(bitmap, i)) {
          problem(`group ${g}: block bitmap padding not set`);
          break;
        }
      }
      if (free !== desc.freeBlocks) problem(`group ${g}: descriptor says ${desc.freeBlocks} free blocks, bitmap says ${free}`);
      freeBlocks += free;

      const ibitmap = this.inodeBitmap(g);
      let ifree = 0;
      let dirs = 0;
      for (let i = 0; i < this.inodesPerGroup; i += 1) {
        const ino = g * this.inodesPerGroup + i + 1;
        if (!testBit(ibitmap, i)) {
          ifree += 1;
          continue;
        }
        if (i >= this.inodesPerGroup - desc.itableUnused) problem(`inode ${ino}: in use but past bg_itable_unused`);
        if (ino >= this.firstIno || ino === ROOT_INO) {
          if (this.stat(ino).isDirectory) dirs += 1;
        }
      }
      for (let i = this.inodesPerGroup; i < this.blockSize * 8; i += 1) {
        if (!testBit(ibitmap, i)) {
          problem(`group ${g}: inode bitmap padding not set`);
          break;
        }
      }
      if (ifree !== desc.freeInodes) problem(`group ${g}: descriptor says ${desc.freeInodes} free inodes, bitmap says ${ifree}`);
      if (dirs !== desc.usedDirs) problem(`group ${g}: descriptor says ${desc.usedDirs} directories, found ${dirs}`);
      freeInodes += ifree;
    }
    if (freeBlocks !== this.freeBlocks) problem(`superblock says ${this.freeBlocks} free blocks, groups say ${freeBlocks}`);
    if (freeInodes !== this.freeInodes) problem(`superblock says ${this.freeInodes} free inodes, groups say ${freeInodes}`);

    // Directory structure, reachability and link counts.
    const references = new Map<number, number>();
    const reached = new Set<number>([ROOT_INO]);
    const queue = [ROOT_INO];
    while (queue.length > 0) {
      const dirIno = queue.shift() as number;
      let entries: DirEntry[];
      try {
        entries = this.readDir(dirIno);
      } catch (err) {
        problem((err as Error).message);
        continue;
      }
      if (entries[0]?.name !== '.' || entries[0].inode !== dirIno) problem(`directory ${dirIno}: first entry is not .`);
      if (entries[1]?.name !== '..') problem(`directory ${dirIno}: second entry is not ..`);
      for (const entry of entries) {
        references.set(entry.inode, (references.get(entry.inode) ?? 0) + 1);
        if (!inUse.has(entry.inode)) {
          problem(`directory ${dirIno}: entry ${entry.name} points at free inode ${entry.inode}`);
          continue;
        }
        if (entry.name === '.' || entry.name === '..') continue;
        if (reached.has(entry.inode)) continue;
        reached.add(entry.inode);
        const stat = this.stat(entry.inode);
        const wantType = stat.isDirectory ? FT.DIR : stat.isFile ? FT.REG : stat.isSymlink ? FT.SYMLINK : entry.fileType;
        if (entry.fileType !== wantType) problem(`${entry.name} (inode ${entry.inode}): directory says type ${entry.fileType}`);
        if (stat.isDirectory) queue.push(entry.inode);
      }
    }
    for (const ino of inUse) {
      if (ino < this.firstIno && ino !== ROOT_INO) continue;
      if (!reached.has(ino)) {
        problem(`inode ${ino}: allocated but not reachable from /`);
        continue;
      }
      const stat = this.stat(ino);
      const count = references.get(ino) ?? 0;
      const ok = stat.links === count || (stat.isDirectory && stat.links === 1 && count >= DIR_NLINK_MAX);
      if (!ok) problem(`inode ${ino}: link count ${stat.links}, referenced ${count} times`);
    }

    return { ok: problems.length === 0, problems };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

/** `i_file_acl`: the inode's external xattr block, or 0. */
function xattrBlockOf(raw: Buffer): number {
  return raw.readUInt32LE(0x68) + raw.readUInt16LE(0x76) * 0x1_0000_0000;
}

function readXattrEntries(buf: Buffer, firstEntry: number, valueBase: number, end: number, out: Map<string, Buffer>): void {
  let at = firstEntry;
  while (at + 16 <= end && buf.readUInt32LE(at) !== 0) {
    const nameLen = buf[at];
    const index = buf[at + 1];
    const valueOffs = buf.readUInt16LE(at + 2);
    const valueSize = buf.readUInt32LE(at + 8);
    const name = buf.subarray(at + 16, at + 16 + nameLen).toString('latin1');
    const prefix = index === XATTR_INDEX_SECURITY ? 'security.' : index === 1 ? 'user.' : index === 4 ? 'trusted.' : `#${index}.`;
    out.set(prefix + name, Buffer.from(buf.subarray(valueBase + valueOffs, valueBase + valueOffs + valueSize)));
    at += (16 + nameLen + 3) & ~3;
  }
}

function refuseUnsupported(kind: 'compat' | 'incompat' | 'roCompat', flags: number, supported: number): void {
  const extra = flags & ~supported;
  if (extra === 0) return;
  const names: string[] = [];
  for (let bit = 0; bit < 32; bit += 1) {
    const mask = 2 ** bit;
    if (extra & mask) names.push(FEATURE_NAMES[kind][mask] ?? `${kind}:0x${mask.toString(16)}`);
  }
  throw new Error(`unsupported ext4 feature(s): ${names.join(', ')}`);
}

function splitPath(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`path must be absolute: ${path}`);
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p === '.' || p === '..')) throw new Error(`path must be normalised: ${path}`);
  return parts;
}

function setBit(bitmap: Uint8Array, bit: number): void {
  bitmap[bit >> 3] |= 1 << (bit & 7);
}

function clearBit(bitmap: Uint8Array, bit: number): void {
  bitmap[bit >> 3] &= ~(1 << (bit & 7));
}

function testBit(bitmap: Uint8Array, bit: number): boolean {
  return (bitmap[bit >> 3] & (1 << (bit & 7))) !== 0;
}

function inodeSize(raw: Buffer): number {
  return raw.readUInt32LE(0x04) + raw.readUInt32LE(0x6c) * 0x1_0000_0000;
}

function setInodeSize(raw: Buffer, size: number): void {
  raw.writeUInt32LE(size % 0x1_0000_0000, 0x04);
  raw.writeUInt32LE(Math.floor(size / 0x1_0000_0000), 0x6c);
}

/** Adds to i_blocks, in 512-byte units (the inode never carries HUGE_FILE after we touch it). */
function addInodeBlocks(raw: Buffer, sectors: number): void {
  const current = raw.readUInt32LE(0x1c) + raw.readUInt16LE(0x74) * 0x1_0000_0000;
  const next = current + sectors;
  raw.writeUInt32LE(next % 0x1_0000_0000, 0x1c);
  raw.writeUInt16LE(Math.floor(next / 0x1_0000_0000), 0x74);
}

/** Physical blocks, in file order, as maximal contiguous runs. */
function blocksToRuns(blocks: number[]): Array<{ start: number; length: number }> {
  const runs: Array<{ start: number; length: number }> = [];
  for (const b of blocks) {
    const last = runs[runs.length - 1];
    if (last && last.start + last.length === b && last.length < 32768) last.length += 1;
    else runs.push({ start: b, length: 1 });
  }
  return runs;
}

function runsToExtents(runs: Array<{ start: number; length: number }>): Extent[] {
  let logical = 0;
  return runs.map((run) => {
    const extent = { logical, start: run.start, length: run.length, uninit: false };
    logical += run.length;
    return extent;
  });
}

/** Writes a depth-0 extent tree into i_block: the header and up to four leaf entries. */
function writeExtentRoot(raw: Buffer, extents: Extent[]): void {
  if (extents.length > 4) throw new Error('more than four extents do not fit in the inode');
  const node = raw.subarray(0x28, 0x28 + 60);
  node.fill(0);
  node.writeUInt16LE(EXTENT_MAGIC, 0);
  node.writeUInt16LE(extents.length, 2);
  node.writeUInt16LE(4, 4);
  node.writeUInt16LE(0, 6);
  extents.forEach((e, i) => {
    const at = 12 + i * 12;
    if (e.length < 1 || e.length > 32768) throw new Error(`extent length ${e.length} out of range`);
    node.writeUInt32LE(e.logical, at);
    node.writeUInt16LE(e.uninit ? e.length + 32768 : e.length, at + 4);
    node.writeUInt16LE(Math.floor(e.start / 0x1_0000_0000), at + 6);
    node.writeUInt32LE(e.start % 0x1_0000_0000, at + 8);
  });
}

/**
 * One in-inode `security.*` xattr, laid out the way e2fsdroid lays out the stock images: header,
 * a single entry with `e_hash` 0 (valid for in-inode entries), a terminator, and the value packed
 * against the end of the inode.
 */
function writeInodeXattr(raw: Buffer, base: number, name: string, value: Buffer): void {
  const first = base + 4;
  const nameBytes = Buffer.from(name, 'latin1');
  const entrySize = (16 + nameBytes.length + 3) & ~3;
  const valueSize = (value.length + 3) & ~3;
  const valueOffs = raw.length - first - valueSize;
  if (valueOffs < entrySize + 4) throw new Error(`xattr ${name} does not fit in the inode`);
  raw.writeUInt32LE(XATTR_MAGIC, base);
  raw[first] = nameBytes.length;
  raw[first + 1] = XATTR_INDEX_SECURITY;
  raw.writeUInt16LE(valueOffs, first + 2);
  raw.writeUInt32LE(0, first + 4);
  raw.writeUInt32LE(value.length, first + 8);
  raw.writeUInt32LE(0, first + 12);
  nameBytes.copy(raw, first + 16);
  raw.writeUInt32LE(0, first + entrySize);
  value.copy(raw, first + valueOffs);
}
