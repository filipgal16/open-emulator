//! An ext4 editor for exactly one kind of filesystem: the logical partitions inside Google's
//! API 30 emulator `system.img`.
//!
//! Those volumes are built by `mke2fs` + `e2fsdroid` with a small, fixed feature set — no journal,
//! no `metadata_csum`, no `64bit`, no `flex_bg` — plus `shared_blocks`, which deduplicates
//! identical blocks so that one block can back several files. That last one is why the volumes
//! cannot simply be mounted read-write and edited, and why this exists: it is what `debugfs` did
//! for the previous attempt, without a Linux distribution on the user's machine.
//!
//! It is narrow on purpose. A volume with any feature outside the supported set is refused with
//! the feature named, so a future image with a different layout fails loudly at build time rather
//! than quietly at boot. The rules it keeps, because breaking any of them corrupts a disk:
//!
//!  - **A block that might be shared is never written.** New content always goes into freshly
//!    allocated blocks; an existing directory block is edited only when nothing else references it.
//!  - **A block is freed only when nothing references it.** Every block reachable from every
//!    in-use inode is counted first; removing a file decrements, and only zero frees.
//!  - **Uninitialised groups are initialised properly before use**, never read as if their bitmaps
//!    were real.
//!  - **Every mutation keeps the counts in step**: bitmaps, group descriptor counts and checksums,
//!    `bg_itable_unused`, and the superblock.
//!
//! [`Ext4Volume::verify`] re-derives all of that from the inodes and checks it, and the builder
//! runs it after every edit. `e2fsck -fn` is the independent oracle in development.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;

use crate::bytes::{json_quote, latin1, put_u16le, put_u32le, u16le, u32le};
use crate::{err, fail, Result};

// ── The disk ────────────────────────────────────────────────────────────────────────────────────

/// The bytes a volume lives in: a partition inside a file, or a buffer in tests.
pub trait Disk {
    fn size(&self) -> u64;
    fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>>;
    fn write(&mut self, offset: u64, data: &[u8]) -> Result<()>;
}

/// A volume held in memory.
pub struct BufferDisk<'a> {
    buffer: &'a mut [u8],
}

impl<'a> BufferDisk<'a> {
    pub fn new(buffer: &'a mut [u8]) -> Self {
        BufferDisk { buffer }
    }
}

impl Disk for BufferDisk<'_> {
    fn size(&self) -> u64 {
        self.buffer.len() as u64
    }

    fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>> {
        check_range(offset, length as u64, self.size())?;
        let start = offset as usize;
        Ok(self.buffer[start..start + length].to_vec())
    }

    fn write(&mut self, offset: u64, data: &[u8]) -> Result<()> {
        check_range(offset, data.len() as u64, self.size())?;
        let start = offset as usize;
        self.buffer[start..start + data.len()].copy_from_slice(data);
        Ok(())
    }
}

/// A window onto an open file: `base` is where the volume starts inside it.
///
/// Every access is bounds-checked against the window, so a bug in block arithmetic cannot write
/// into the partition next door.
pub struct FileDisk<'a> {
    file: &'a File,
    base: u64,
    size: u64,
    writable: bool,
}

impl<'a> FileDisk<'a> {
    pub fn new(file: &'a File, base: u64, size: u64, writable: bool) -> Self {
        FileDisk { file, base, size, writable }
    }
}

use crate::fileio::{read_at, write_at};

impl Disk for FileDisk<'_> {
    fn size(&self) -> u64 {
        self.size
    }

    fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>> {
        check_range(offset, length as u64, self.size)?;
        let mut out = vec![0u8; length];
        let mut done = 0;
        while done < length {
            let at = self.base + offset + done as u64;
            let n = read_at(self.file, &mut out[done..], at)?;
            if n == 0 {
                fail!("short read at {at}");
            }
            done += n;
        }
        Ok(out)
    }

    fn write(&mut self, offset: u64, data: &[u8]) -> Result<()> {
        if !self.writable {
            fail!("volume opened read-only");
        }
        check_range(offset, data.len() as u64, self.size)?;
        let mut done = 0;
        while done < data.len() {
            let at = self.base + offset + done as u64;
            let n = write_at(self.file, &data[done..], at)?;
            if n == 0 {
                fail!("short write at {at}");
            }
            done += n;
        }
        Ok(())
    }
}

fn check_range(offset: u64, length: u64, size: u64) -> Result<()> {
    if offset.checked_add(length).is_none_or(|end| end > size) {
        fail!("access [{offset}, +{length}) is outside the volume ({size} bytes)");
    }
    Ok(())
}

// ── On-disk constants ───────────────────────────────────────────────────────────────────────────

const EXT4_MAGIC: u16 = 0xef53;
const SUPERBLOCK_OFFSET: u64 = 1024;
const EXTENT_MAGIC: u16 = 0xf30a;
const XATTR_MAGIC: u32 = 0xea020000;
const XATTR_INDEX_SECURITY: u8 = 6;
const ROOT_INO: u32 = 2;

const COMPAT_EXT_ATTR: u32 = 0x8;
const COMPAT_DIR_INDEX: u32 = 0x20;
const INCOMPAT_FILETYPE: u32 = 0x2;
const INCOMPAT_EXTENTS: u32 = 0x40;
const RO_COMPAT_SPARSE_SUPER: u32 = 0x1;
const RO_COMPAT_LARGE_FILE: u32 = 0x2;
const RO_COMPAT_HUGE_FILE: u32 = 0x8;
const RO_COMPAT_GDT_CSUM: u32 = 0x10;
const RO_COMPAT_DIR_NLINK: u32 = 0x20;
const RO_COMPAT_EXTRA_ISIZE: u32 = 0x40;
const RO_COMPAT_SHARED_BLOCKS: u32 = 0x4000;

const SUPPORTED_COMPAT: u32 = COMPAT_EXT_ATTR | COMPAT_DIR_INDEX;
const SUPPORTED_INCOMPAT: u32 = INCOMPAT_FILETYPE | INCOMPAT_EXTENTS;
const SUPPORTED_RO_COMPAT: u32 = RO_COMPAT_SPARSE_SUPER
    | RO_COMPAT_LARGE_FILE
    | RO_COMPAT_HUGE_FILE
    | RO_COMPAT_GDT_CSUM
    | RO_COMPAT_DIR_NLINK
    | RO_COMPAT_EXTRA_ISIZE
    | RO_COMPAT_SHARED_BLOCKS;

#[derive(Clone, Copy)]
enum FeatureKind {
    Compat,
    Incompat,
    RoCompat,
}

/// Names for the features a volume might carry, so a refusal says which one.
fn feature_name(kind: FeatureKind, mask: u32) -> Option<&'static str> {
    Some(match kind {
        FeatureKind::Compat => match mask {
            0x1 => "dir_prealloc",
            0x2 => "imagic_inodes",
            0x4 => "has_journal",
            0x8 => "ext_attr",
            0x10 => "resize_inode",
            0x20 => "dir_index",
            0x40 => "lazy_bg",
            0x80 => "exclude_inode",
            0x100 => "exclude_bitmap",
            0x200 => "sparse_super2",
            0x400 => "fast_commit",
            0x800 => "stable_inodes",
            0x1000 => "orphan_file",
            _ => return None,
        },
        FeatureKind::Incompat => match mask {
            0x1 => "compression",
            0x2 => "filetype",
            0x4 => "needs_recovery",
            0x8 => "journal_dev",
            0x10 => "meta_bg",
            0x40 => "extent",
            0x80 => "64bit",
            0x100 => "mmp",
            0x200 => "flex_bg",
            0x400 => "ea_inode",
            0x1000 => "dirdata",
            0x2000 => "metadata_csum_seed",
            0x4000 => "large_dir",
            0x8000 => "inline_data",
            0x10000 => "encrypt",
            0x20000 => "casefold",
            _ => return None,
        },
        FeatureKind::RoCompat => match mask {
            0x1 => "sparse_super",
            0x2 => "large_file",
            0x4 => "btree_dir",
            0x8 => "huge_file",
            0x10 => "uninit_bg",
            0x20 => "dir_nlink",
            0x40 => "extra_isize",
            0x80 => "has_snapshot",
            0x100 => "quota",
            0x200 => "bigalloc",
            0x400 => "metadata_csum",
            0x800 => "replica",
            0x1000 => "read-only",
            0x2000 => "project",
            0x4000 => "shared_blocks",
            0x8000 => "verity",
            0x10000 => "orphan_present",
            _ => return None,
        },
    })
}

const BG_INODE_UNINIT: u16 = 0x1;
const BG_BLOCK_UNINIT: u16 = 0x2;

const INODE_FLAG_INDEX: u32 = 0x1000;
const INODE_FLAG_HUGE_FILE: u32 = 0x40000;
const INODE_FLAG_EXTENTS: u32 = 0x80000;

const S_IFMT: u16 = 0o170000;
const S_IFREG: u16 = 0o100000;
const S_IFDIR: u16 = 0o040000;
const S_IFLNK: u16 = 0o120000;

/// Directory entry file types.
pub mod ft {
    pub const UNKNOWN: u8 = 0;
    pub const REG: u8 = 1;
    pub const DIR: u8 = 2;
    pub const CHR: u8 = 3;
    pub const BLK: u8 = 4;
    pub const FIFO: u8 = 5;
    pub const SOCK: u8 = 6;
    pub const SYMLINK: u8 = 7;
}

/// `dir_nlink`: past this, a directory's link count is pinned at 1 rather than counted.
const DIR_NLINK_MAX: u32 = 65000;

// ── CRC16, for uninit_bg group descriptor checksums ─────────────────────────────────────────────

const fn crc16_table() -> [u16; 256] {
    let mut table = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u16;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xa001 } else { c >> 1 };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

const CRC16_TABLE: [u16; 256] = crc16_table();

/// The ANSI CRC-16 (reflected 0x8005) that `ext4_group_desc_csum` uses without metadata_csum.
pub fn crc16(crc: u16, data: &[u8]) -> u16 {
    let mut c = crc;
    for &byte in data {
        c = (c >> 8) ^ CRC16_TABLE[((c ^ u16::from(byte)) & 0xff) as usize];
    }
    c
}

// ── Types ───────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Extent {
    /// First logical block of the file this extent maps.
    pub logical: u64,
    /// First physical block.
    pub start: u64,
    pub length: u64,
    /// Allocated but reads as zeros.
    pub uninit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtentMap {
    pub extents: Vec<Extent>,
    /// Every block the extent tree itself occupies outside the inode.
    pub tree_blocks: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub inode: u32,
    pub file_type: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stat {
    pub ino: u32,
    pub mode: u16,
    pub uid: u32,
    pub gid: u32,
    pub size: u64,
    pub links: u16,
    pub flags: u32,
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct NewInodeOptions<'a> {
    /// Permission bits only, e.g. 0o644. The type comes from the operation.
    pub mode: u16,
    pub uid: u32,
    pub gid: u32,
    /// `security.selinux`, e.g. `u:object_r:system_file:s0`. Required: Android refuses unlabeled
    /// files.
    pub selinux: &'a str,
}

impl<'a> NewInodeOptions<'a> {
    pub fn new(mode: u16, selinux: &'a str) -> Self {
        NewInodeOptions { mode, uid: 0, gid: 0, selinux }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RemoveReport {
    pub inodes_freed: u64,
    pub blocks_freed: u64,
    /// Blocks that were referenced by another file too, and so stayed allocated.
    pub blocks_still_shared: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyReport {
    pub ok: bool,
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Run {
    start: u64,
    length: u64,
}

struct GroupDesc {
    block_bitmap: u64,
    inode_bitmap: u64,
    inode_table: u64,
    free_blocks: i64,
    free_inodes: i64,
    used_dirs: i64,
    flags: u16,
    itable_unused: u32,
    /// The 32 raw bytes, kept so fields this editor does not model are written back unchanged.
    raw: [u8; 32],
}

struct Inode {
    ino: u32,
    raw: Vec<u8>,
}

struct DirRecord {
    name: String,
    /// The name's length on disk, which is what space accounting uses.
    name_len: usize,
    inode: u32,
    file_type: u8,
    physical: u64,
    offset: usize,
    rec_len: usize,
}

/// Counts that keep the order keys were first seen, so a walk over them is reproducible.
#[derive(Default)]
struct OrderedCounts {
    order: Vec<u32>,
    counts: HashMap<u32, u32>,
}

impl OrderedCounts {
    fn add(&mut self, key: u32) {
        let count = self.counts.entry(key).or_insert(0);
        if *count == 0 {
            self.order.push(key);
        }
        *count += 1;
    }

    fn contains(&self, key: u32) -> bool {
        self.counts.contains_key(&key)
    }

    fn iter(&self) -> impl Iterator<Item = (u32, u32)> + '_ {
        self.order.iter().map(|&key| (key, self.counts[&key]))
    }
}

// ── The volume ──────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct OpenOptions {
    pub writable: bool,
    /// Timestamp for everything this editor creates or changes, in seconds. Fixed, so builds are
    /// reproducible.
    pub epoch: u32,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions { writable: false, epoch: 1230768000 }
    }
}

impl OpenOptions {
    pub fn writable() -> Self {
        OpenOptions { writable: true, ..OpenOptions::default() }
    }
}

pub struct Ext4Volume<D: Disk> {
    block_size: u64,
    blocks_count: u64,
    inodes_count: u32,
    blocks_per_group: u64,
    inodes_per_group: u32,
    inode_size: usize,
    first_data_block: u64,
    first_ino: u32,
    group_count: u32,
    label: String,
    shared_blocks: bool,

    disk: D,
    sb: Vec<u8>,
    groups: Vec<GroupDesc>,
    gdt_blocks: u64,
    uuid: [u8; 16],
    extra_isize: u16,
    epoch: u32,
    writable: bool,

    block_bitmaps: HashMap<u32, Vec<u8>>,
    inode_bitmaps: HashMap<u32, Vec<u8>>,
    dirty_block_bitmaps: BTreeSet<u32>,
    dirty_inode_bitmaps: BTreeSet<u32>,
    dirty_groups: BTreeSet<u32>,
    super_dirty: bool,
    refcount: Option<Vec<u32>>,
}

impl<D: Disk> Ext4Volume<D> {
    pub fn open(disk: D, options: OpenOptions) -> Result<Self> {
        let sb = disk.read(SUPERBLOCK_OFFSET, 1024)?;
        if u16le(&sb, 0x38) != EXT4_MAGIC {
            fail!("not an ext4 volume (bad superblock magic)");
        }

        let compat = u32le(&sb, 0x5c);
        let incompat = u32le(&sb, 0x60);
        let ro_compat = u32le(&sb, 0x64);
        refuse_unsupported(FeatureKind::Compat, compat, SUPPORTED_COMPAT)?;
        refuse_unsupported(FeatureKind::Incompat, incompat, SUPPORTED_INCOMPAT)?;
        refuse_unsupported(FeatureKind::RoCompat, ro_compat, SUPPORTED_RO_COMPAT)?;
        if incompat & INCOMPAT_EXTENTS == 0 {
            fail!("volume does not use extents");
        }
        if incompat & INCOMPAT_FILETYPE == 0 {
            fail!("volume does not store file types in directory entries");
        }
        // Without it the kernel ignores the security.selinux this editor writes on every new file,
        // and Android would refuse the unlabeled result.
        if compat & COMPAT_EXT_ATTR == 0 {
            fail!("volume has no ext_attr, so new files could not carry their SELinux label");
        }
        if ro_compat & RO_COMPAT_GDT_CSUM == 0 {
            fail!("volume has no uninit_bg; its group checksums are not the kind this editor writes");
        }

        let shared_blocks = ro_compat & RO_COMPAT_SHARED_BLOCKS != 0;
        let inodes_count = u32le(&sb, 0x00);
        let blocks_count = u64::from(u32le(&sb, 0x04));
        let first_data_block = u64::from(u32le(&sb, 0x14));
        let block_size = 1024u64.checked_shl(u32le(&sb, 0x18)).unwrap_or(0);
        let blocks_per_group = u64::from(u32le(&sb, 0x20));
        let inodes_per_group = u32le(&sb, 0x28);
        let rev_level = u32le(&sb, 0x4c);
        let first_ino = if rev_level == 0 { 11 } else { u32le(&sb, 0x54) };
        let inode_size = if rev_level == 0 { 128 } else { usize::from(u16le(&sb, 0x58)) };
        let uuid: [u8; 16] = sb[0x68..0x78].try_into().unwrap();
        let label = crate::bytes::c_string(&sb[0x78..0x88]);
        let extra_isize = if inode_size > 128 {
            let wanted = u16le(&sb, 0x15e);
            32.max(if wanted == 0 { 32 } else { wanted })
        } else {
            0
        };

        if block_size != 4096 && block_size != 1024 && block_size != 2048 {
            fail!("unsupported block size {block_size}");
        }
        if blocks_count * block_size > disk.size() {
            fail!("volume claims {} bytes but only {} are available", blocks_count * block_size, disk.size());
        }
        if inode_size < 128 || inode_size as u64 > block_size {
            fail!("bad inode size {inode_size}");
        }
        // Only meaningful with 64bit, which is refused above; anything but "unset" or 32 means the
        // descriptor layout is not the one this editor reads.
        let desc_size = u16le(&sb, 0xfe);
        if desc_size != 0 && desc_size != 32 {
            fail!("unsupported group descriptor size {desc_size}");
        }
        // A volume with orphans was not cleanly finished; editing it would build on a half-deleted
        // file.
        if u32le(&sb, 0xe8) != 0 {
            fail!("volume has a non-empty orphan list (s_last_orphan)");
        }

        if blocks_per_group == 0 || blocks_count <= first_data_block {
            fail!("volume has {blocks_count} blocks from block {first_data_block} in groups of {blocks_per_group}");
        }
        let group_count = (blocks_count - first_data_block).div_ceil(blocks_per_group);
        if group_count * u64::from(inodes_per_group) != u64::from(inodes_count) {
            fail!("inode count {inodes_count} does not match {group_count} groups of {inodes_per_group}");
        }
        let gdt_blocks = (group_count * 32).div_ceil(block_size);

        let mut volume = Ext4Volume {
            block_size,
            blocks_count,
            inodes_count,
            blocks_per_group,
            inodes_per_group,
            inode_size,
            first_data_block,
            first_ino,
            group_count: group_count as u32,
            label,
            shared_blocks,
            disk,
            sb,
            groups: Vec::new(),
            gdt_blocks,
            uuid,
            extra_isize,
            epoch: options.epoch,
            writable: options.writable,
            block_bitmaps: HashMap::new(),
            inode_bitmaps: HashMap::new(),
            dirty_block_bitmaps: BTreeSet::new(),
            dirty_inode_bitmaps: BTreeSet::new(),
            dirty_groups: BTreeSet::new(),
            super_dirty: false,
            refcount: None,
        };

        let gdt = volume.read_blocks(first_data_block + 1, gdt_blocks)?;
        for g in 0..volume.group_count {
            let at = g as usize * 32;
            let raw: [u8; 32] = gdt[at..at + 32].try_into().unwrap();
            let desc = GroupDesc {
                block_bitmap: u64::from(u32le(&raw, 0x00)),
                inode_bitmap: u64::from(u32le(&raw, 0x04)),
                inode_table: u64::from(u32le(&raw, 0x08)),
                free_blocks: i64::from(u16le(&raw, 0x0c)),
                free_inodes: i64::from(u16le(&raw, 0x0e)),
                used_dirs: i64::from(u16le(&raw, 0x10)),
                flags: u16le(&raw, 0x12),
                itable_unused: u32::from(u16le(&raw, 0x1c)),
                raw,
            };
            if u16le(&raw, 0x1e) != volume.group_checksum(g, &raw) {
                fail!("group {g} descriptor checksum does not match — the volume is damaged or not what it claims");
            }
            volume.groups.push(desc);
        }
        Ok(volume)
    }

    /// The disk back, once editing is done.
    pub fn into_disk(self) -> D {
        self.disk
    }

    pub fn block_size(&self) -> u64 {
        self.block_size
    }

    pub fn blocks_count(&self) -> u64 {
        self.blocks_count
    }

    pub fn inodes_count(&self) -> u32 {
        self.inodes_count
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn shared_blocks(&self) -> bool {
        self.shared_blocks
    }

    pub fn free_blocks(&self) -> u64 {
        u64::from(u32le(&self.sb, 0x0c))
    }

    pub fn free_inodes(&self) -> u32 {
        u32le(&self.sb, 0x10)
    }

    // ── Blocks and groups ───────────────────────────────────────────────────────────────────────

    fn read_blocks(&self, block: u64, count: u64) -> Result<Vec<u8>> {
        self.disk.read(block * self.block_size, (count * self.block_size) as usize)
    }

    fn write_block(&mut self, block: u64, data: &[u8]) -> Result<()> {
        self.require_writable()?;
        if data.len() as u64 != self.block_size {
            fail!("block write of {} bytes", data.len());
        }
        if block < self.first_data_block || block >= self.blocks_count {
            fail!("block {block} out of range");
        }
        self.disk.write(block * self.block_size, data)
    }

    fn require_writable(&self) -> Result<()> {
        if !self.writable {
            fail!("volume opened read-only");
        }
        Ok(())
    }

    fn group_start(&self, g: u32) -> u64 {
        self.first_data_block + u64::from(g) * self.blocks_per_group
    }

    fn group_block_count(&self, g: u32) -> u64 {
        self.blocks_per_group.min(self.blocks_count - self.group_start(g))
    }

    fn group_of_block(&self, block: u64) -> u32 {
        ((block - self.first_data_block) / self.blocks_per_group) as u32
    }

    /// Groups 0, 1 and powers of 3, 5 and 7 carry a superblock and GDT backup under sparse_super.
    fn has_super_backup(&self, g: u32) -> bool {
        let sparse = u32le(&self.sb, 0x64) & RO_COMPAT_SPARSE_SUPER != 0;
        if !sparse || g <= 1 {
            return true;
        }
        [3u64, 5, 7].iter().any(|&base| {
            let mut n = base;
            while n < u64::from(g) {
                n *= base;
            }
            n == u64::from(g)
        })
    }

    fn group_checksum(&self, g: u32, raw: &[u8]) -> u16 {
        let mut crc = crc16(0xffff, &self.uuid);
        crc = crc16(crc, &g.to_le_bytes());
        crc16(crc, &raw[..0x1e])
    }

    /// Blocks in group `g` that belong to the filesystem itself rather than to any file.
    fn metadata_blocks(&self, g: u32) -> Result<Vec<u64>> {
        let mut out = Vec::new();
        let start = self.group_start(g);
        if self.has_super_backup(g) {
            // The superblock's own block (block 0 holds it at byte 1024 when blocks are 4 KiB),
            // then the GDT.
            out.extend((0..1 + self.gdt_blocks).map(|i| start + i));
        }
        let desc = &self.groups[g as usize];
        out.push(desc.block_bitmap);
        out.push(desc.inode_bitmap);
        let table_blocks = (u64::from(self.inodes_per_group) * self.inode_size as u64).div_ceil(self.block_size);
        out.extend((0..table_blocks).map(|i| desc.inode_table + i));
        let end = start + self.group_block_count(g);
        for &b in &out {
            if b < start || b >= end {
                fail!("group {g} metadata block {b} lies outside the group — flex_bg-style layouts are not supported");
            }
        }
        Ok(out)
    }

    /// Loads the group's block bitmap, synthesised when the group is BLOCK_UNINIT.
    ///
    /// An uninitialised group's bitmap block holds whatever was on disk; the truth is "only the
    /// group's own metadata is in use". Reading the block as if it were real is how a free-space
    /// search ends up handing out an inode table.
    fn load_block_bitmap(&mut self, g: u32) -> Result<()> {
        if self.block_bitmaps.contains_key(&g) {
            return Ok(());
        }
        let desc = &self.groups[g as usize];
        let mut bitmap = if desc.flags & BG_BLOCK_UNINIT != 0 {
            let mut bitmap = vec![0u8; self.block_size as usize];
            let start = self.group_start(g);
            for b in self.metadata_blocks(g)? {
                set_bit(&mut bitmap, (b - start) as usize);
            }
            bitmap
        } else {
            self.read_blocks(desc.block_bitmap, 1)?
        };
        // Bits past the end of the last group stand for blocks that do not exist, and are always
        // set.
        for i in self.group_block_count(g) as usize..self.block_size as usize * 8 {
            set_bit(&mut bitmap, i);
        }
        self.block_bitmaps.insert(g, bitmap);
        Ok(())
    }

    fn load_inode_bitmap(&mut self, g: u32) -> Result<()> {
        if self.inode_bitmaps.contains_key(&g) {
            return Ok(());
        }
        let desc = &self.groups[g as usize];
        let mut bitmap = if desc.flags & BG_INODE_UNINIT != 0 {
            vec![0u8; self.block_size as usize]
        } else {
            self.read_blocks(desc.inode_bitmap, 1)?
        };
        for i in self.inodes_per_group as usize..self.block_size as usize * 8 {
            set_bit(&mut bitmap, i);
        }
        self.inode_bitmaps.insert(g, bitmap);
        Ok(())
    }

    // ── Inodes ──────────────────────────────────────────────────────────────────────────────────

    fn inode_offset(&self, ino: u32) -> Result<u64> {
        if ino < 1 || ino > self.inodes_count {
            fail!("inode {ino} out of range");
        }
        let g = (ino - 1) / self.inodes_per_group;
        let index = (ino - 1) % self.inodes_per_group;
        Ok(self.groups[g as usize].inode_table * self.block_size + u64::from(index) * self.inode_size as u64)
    }

    fn read_inode(&self, ino: u32) -> Result<Inode> {
        Ok(Inode { ino, raw: self.disk.read(self.inode_offset(ino)?, self.inode_size)? })
    }

    fn write_inode(&mut self, inode: &Inode) -> Result<()> {
        self.require_writable()?;
        let offset = self.inode_offset(inode.ino)?;
        self.disk.write(offset, &inode.raw)
    }

    /// A copy of the inode's on-disk bytes, for diagnostics and byte-level tests.
    pub fn raw_inode(&self, ino: u32) -> Result<Vec<u8>> {
        Ok(self.read_inode(ino)?.raw)
    }

    pub fn stat(&self, ino: u32) -> Result<Stat> {
        let raw = self.read_inode(ino)?.raw;
        let mode = u16le(&raw, 0x00);
        Ok(Stat {
            ino,
            mode,
            uid: u32::from(u16le(&raw, 0x02)) | (u32::from(u16le(&raw, 0x78)) << 16),
            gid: u32::from(u16le(&raw, 0x18)) | (u32::from(u16le(&raw, 0x7a)) << 16),
            size: inode_size_of(&raw),
            links: u16le(&raw, 0x1a),
            flags: u32le(&raw, 0x20),
            is_directory: mode & S_IFMT == S_IFDIR,
            is_file: mode & S_IFMT == S_IFREG,
            is_symlink: mode & S_IFMT == S_IFLNK,
        })
    }

    /// Extended attributes: in the inode, where the images keep SELinux labels, and in the external
    /// block an inode with more of them uses (a file with `security.capability` beside its label).
    pub fn xattrs(&self, ino: u32) -> Result<Vec<(String, Vec<u8>)>> {
        let raw = self.read_inode(ino)?.raw;
        let mut out = Vec::new();
        if self.inode_size > 128 {
            let base = 0x80 + usize::from(u16le(&raw, 0x80));
            if base + 4 <= self.inode_size && u32le(&raw, base) == XATTR_MAGIC {
                // In-inode values are offset from the first entry.
                read_xattr_entries(&raw, base + 4, base + 4, self.inode_size, &mut out);
            }
        }
        let acl = xattr_block_of(&raw);
        if acl != 0 {
            let block = self.read_blocks(acl, 1)?;
            if u32le(&block, 0) != XATTR_MAGIC {
                fail!("inode {ino}: block {acl} is not an xattr block");
            }
            // Block values are offset from the start of the block; entries follow a 32-byte header.
            read_xattr_entries(&block, 32, 0, self.block_size as usize, &mut out);
        }
        Ok(out)
    }

    pub fn selinux_label(&self, ino: u32) -> Result<Option<String>> {
        Ok(self.xattrs(ino)?.into_iter().find(|(name, _)| name == "security.selinux").map(|(_, value)| {
            let text = latin1(&value);
            text.strip_suffix('\0').map(str::to_owned).unwrap_or(text)
        }))
    }

    // ── Extents ─────────────────────────────────────────────────────────────────────────────────

    /// Every extent of an inode, and every block the extent tree itself occupies outside the inode.
    pub fn extents(&self, ino: u32) -> Result<ExtentMap> {
        self.extents_of(&self.read_inode(ino)?)
    }

    fn extents_of(&self, inode: &Inode) -> Result<ExtentMap> {
        let flags = u32le(&inode.raw, 0x20);
        if flags & INODE_FLAG_EXTENTS == 0 {
            let blocks = u32le(&inode.raw, 0x1c);
            // A fast symlink keeps its target in i_block and owns no blocks. Anything else without
            // the extents flag is block-mapped, which these images never use.
            if blocks == 0 {
                return Ok(ExtentMap { extents: Vec::new(), tree_blocks: Vec::new() });
            }
            fail!("inode {} is block-mapped; only extent-mapped files are supported", inode.ino);
        }
        let mut extents = Vec::new();
        let mut tree_blocks = Vec::new();
        self.walk_extent_node(&inode.raw[0x28..0x28 + 60], 0, &mut extents, &mut tree_blocks, inode.ino)?;
        extents.sort_by_key(|e: &Extent| e.logical);
        for pair in extents.windows(2) {
            if pair[1].logical < pair[0].logical + pair[0].length {
                fail!("inode {}: two extents map logical block {}", inode.ino, pair[1].logical);
            }
        }
        Ok(ExtentMap { extents, tree_blocks })
    }

    fn walk_extent_node(
        &self,
        node: &[u8],
        level: u32,
        extents: &mut Vec<Extent>,
        tree_blocks: &mut Vec<u64>,
        ino: u32,
    ) -> Result<()> {
        if level > 5 {
            fail!("inode {ino}: extent tree deeper than 5 levels");
        }
        if u16le(node, 0) != EXTENT_MAGIC {
            fail!("inode {ino}: bad extent header magic");
        }
        let entries = usize::from(u16le(node, 2));
        let depth = u16le(node, 6);
        if 12 + entries * 12 > node.len() {
            fail!("inode {ino}: extent node overflows");
        }
        for i in 0..entries {
            let at = 12 + i * 12;
            if depth == 0 {
                let raw_len = u64::from(u16le(node, at + 4));
                extents.push(Extent {
                    logical: u64::from(u32le(node, at)),
                    start: (u64::from(u16le(node, at + 6)) << 32) | u64::from(u32le(node, at + 8)),
                    length: if raw_len > 32768 { raw_len - 32768 } else { raw_len },
                    uninit: raw_len > 32768,
                });
            } else {
                let child = u64::from(u32le(node, at + 4)) | (u64::from(u16le(node, at + 8)) << 32);
                self.check_data_block(child, ino)?;
                tree_blocks.push(child);
                let block = self.read_blocks(child, 1)?;
                self.walk_extent_node(&block, level + 1, extents, tree_blocks, ino)?;
            }
        }
        Ok(())
    }

    fn check_data_block(&self, block: u64, ino: u32) -> Result<()> {
        if block < self.first_data_block || block >= self.blocks_count {
            fail!("inode {ino} references block {block}, outside the volume");
        }
        Ok(())
    }

    /// Every physical block an inode references: extent tree blocks, then data — one entry per
    /// reference, so a block can appear more than once.
    ///
    /// It does on Google's images. e2fsdroid deduplicates identical blocks *within* a file as well
    /// as between files, so one file can map the same physical block at two logical offsets. Each
    /// mapping is a reference and is counted as one, which is what makes removing that file free
    /// the block exactly once, when its last reference goes. What would be damage is two extents
    /// claiming the same *logical* range, and `extents_of` refuses that.
    fn owned_blocks(&self, inode: &Inode) -> Result<Vec<u64>> {
        let ExtentMap { extents, tree_blocks } = self.extents_of(inode)?;
        let mut out = tree_blocks;
        for e in &extents {
            for i in 0..e.length {
                self.check_data_block(e.start + i, inode.ino)?;
                out.push(e.start + i);
            }
        }
        Ok(out)
    }

    // ── Reading files and directories ───────────────────────────────────────────────────────────

    pub fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        self.read_file_ino(self.require(path)?)
    }

    pub fn read_file_ino(&self, ino: u32) -> Result<Vec<u8>> {
        let inode = self.read_inode(ino)?;
        let mode = u16le(&inode.raw, 0x00);
        let size = inode_size_of(&inode.raw) as usize;
        if mode & S_IFMT == S_IFLNK && u32le(&inode.raw, 0x20) & INODE_FLAG_EXTENTS == 0 {
            let end = (0x28 + size).min(inode.raw.len());
            return Ok(inode.raw[0x28..end].to_vec());
        }
        let mut out = vec![0u8; size];
        for e in self.extents_of(&inode)?.extents {
            if e.uninit {
                continue;
            }
            let from = (e.logical * self.block_size) as usize;
            if from >= size {
                continue;
            }
            let data = self.read_blocks(e.start, e.length)?;
            let take = data.len().min(size - from);
            out[from..from + take].copy_from_slice(&data[..take]);
        }
        Ok(out)
    }

    /// Entries of a directory, `.` and `..` included.
    ///
    /// Linear and hashed (`dir_index`) directories read the same way: an htree's root block hides
    /// its index inside the `..` record, and its internal index blocks look like one empty record
    /// the size of the block, so a scan of every block sees exactly the leaves.
    pub fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        self.read_dir_ino(self.require(path)?)
    }

    pub fn read_dir_ino(&self, ino: u32) -> Result<Vec<DirEntry>> {
        Ok(self
            .dir_records(ino)?
            .into_iter()
            .filter(|r| r.inode != 0)
            .map(|r| DirEntry { name: r.name, inode: r.inode, file_type: r.file_type })
            .collect())
    }

    fn dir_records(&self, ino: u32) -> Result<Vec<DirRecord>> {
        let inode = self.read_inode(ino)?;
        if u16le(&inode.raw, 0x00) & S_IFMT != S_IFDIR {
            fail!("inode {ino} is not a directory");
        }
        let block_size = self.block_size as usize;
        let mut out = Vec::new();
        for e in self.extents_of(&inode)?.extents {
            for i in 0..e.length {
                let physical = e.start + i;
                let data = self.read_blocks(physical, 1)?;
                let mut at = 0;
                while at < block_size {
                    let corrupt = || err!("directory inode {ino}: corrupt entry at block {} offset {at}", e.logical + i);
                    if at + 8 > block_size {
                        return Err(corrupt());
                    }
                    let child = u32le(&data, at);
                    let rec_len = usize::from(u16le(&data, at + 4));
                    let name_len = usize::from(data[at + 6]);
                    if rec_len < 8 || rec_len % 4 != 0 || at + rec_len > block_size || 8 + name_len > rec_len {
                        return Err(corrupt());
                    }
                    out.push(DirRecord {
                        name: String::from_utf8_lossy(&data[at + 8..at + 8 + name_len]).into_owned(),
                        name_len,
                        inode: child,
                        file_type: data[at + 7],
                        physical,
                        offset: at,
                        rec_len,
                    });
                    at += rec_len;
                }
            }
        }
        Ok(out)
    }

    /// Inode number for an absolute path, or `None`.
    pub fn lookup(&self, path: &str) -> Result<Option<u32>> {
        let mut ino = ROOT_INO;
        for part in split_path(path)? {
            match self.read_dir_ino(ino)?.into_iter().find(|e| e.name == part) {
                Some(entry) => ino = entry.inode,
                None => return Ok(None),
            }
        }
        Ok(Some(ino))
    }

    pub fn exists(&self, path: &str) -> Result<bool> {
        Ok(self.lookup(path)?.is_some())
    }

    fn require(&self, path: &str) -> Result<u32> {
        self.lookup(path)?.ok_or_else(|| err!("{path}: no such file or directory"))
    }

    // ── Reference counts ────────────────────────────────────────────────────────────────────────

    /// Every in-use inode number, walked from the bitmaps.
    fn in_use_inodes(&mut self) -> Result<Vec<u32>> {
        let mut out = Vec::new();
        for g in 0..self.group_count {
            if self.groups[g as usize].flags & BG_INODE_UNINIT != 0 {
                continue;
            }
            self.load_inode_bitmap(g)?;
            let bitmap = &self.inode_bitmaps[&g];
            for i in 0..self.inodes_per_group {
                if test_bit(bitmap, i as usize) {
                    out.push(g * self.inodes_per_group + i + 1);
                }
            }
        }
        Ok(out)
    }

    /// How many inodes reference each block. Built once, then kept in step by every mutation.
    ///
    /// This is what makes freeing safe on a `shared_blocks` volume: a debloated APK may share
    /// blocks with a file that stays, and those must remain allocated.
    fn ensure_refs(&mut self) -> Result<()> {
        if self.refcount.is_some() {
            return Ok(());
        }
        let mut counts = vec![0u32; self.blocks_count as usize];
        for ino in self.in_use_inodes()? {
            let inode = self.read_inode(ino)?;
            if ino != ROOT_INO && ino < self.first_ino {
                // Reserved inodes other than the root own nothing on these volumes (no journal, no
                // resize inode). Confirm rather than assume.
                if u32le(&inode.raw, 0x1c) != 0 && u32le(&inode.raw, 0x20) & INODE_FLAG_EXTENTS != 0 {
                    fail!("reserved inode {ino} owns blocks; not supported");
                }
                continue;
            }
            for b in self.owned_blocks(&inode)? {
                counts[b as usize] += 1;
            }
            // An external xattr block — `/system/bin/run-as` has one, for `security.capability`
            // beside its label — is a reference like any other, and ext4 lets several inodes share
            // one.
            let acl = xattr_block_of(&inode.raw);
            if acl != 0 {
                self.check_data_block(acl, ino)?;
                counts[acl as usize] += 1;
            }
        }
        self.refcount = Some(counts);
        Ok(())
    }

    fn refs(&mut self) -> Result<&mut Vec<u32>> {
        self.ensure_refs()?;
        Ok(self.refcount.as_mut().expect("just built"))
    }

    /// Drops one inode's reference to its external xattr block.
    ///
    /// The block keeps its own count of the inodes using it (`h_refcount`), and e2fsck holds it to
    /// the real number. So the header is rewritten to match whenever a reference goes, and the
    /// block is freed with the last one. Writing a shared xattr block's header is not the hazard
    /// writing a shared data block is: that count is the one field every sharer agrees on.
    fn release_xattr_block(&mut self, block: u64) -> Result<()> {
        self.ensure_refs()?;
        let mut data = self.read_blocks(block, 1)?;
        if u32le(&data, 0) != XATTR_MAGIC || u32le(&data, 8) != 1 {
            fail!("block {block} is not a single-block xattr block");
        }
        let refs = self.refs()?;
        if refs[block as usize] <= 1 {
            self.release_blocks(&[block])?;
            return Ok(());
        }
        refs[block as usize] -= 1;
        put_u32le(&mut data, 4, refs[block as usize]);
        self.write_block(block, &data)
    }

    // ── Allocation ──────────────────────────────────────────────────────────────────────────────

    fn mark_blocks(&mut self, start: u64, length: u64, used: bool) -> Result<()> {
        for b in start..start + length {
            let g = self.group_of_block(b);
            self.load_block_bitmap(g)?;
            let bit = (b - self.group_start(g)) as usize;
            let bitmap = self.block_bitmaps.get_mut(&g).expect("just loaded");
            if test_bit(bitmap, bit) == used {
                fail!("block {b} is already {}", if used { "in use" } else { "free" });
            }
            if used {
                set_bit(bitmap, bit);
            } else {
                clear_bit(bitmap, bit);
            }
            let desc = &mut self.groups[g as usize];
            desc.free_blocks += if used { -1 } else { 1 };
            // The bitmap is real now, whatever it was before.
            desc.flags &= !BG_BLOCK_UNINIT;
            self.dirty_block_bitmaps.insert(g);
            self.dirty_groups.insert(g);
        }
        let free = self.free_blocks() as i64 + if used { -(length as i64) } else { length as i64 };
        let free = u32::try_from(free).map_err(|_| err!("free block count would become {free}"))?;
        put_u32le(&mut self.sb, 0x0c, free);
        self.super_dirty = true;
        Ok(())
    }

    /// Groups in the order an allocation tries them: the goal, then initialised groups, then the
    /// ones `uninit_flag` marks as never used.
    fn group_order(&self, goal_group: u32, uninit_flag: u16) -> Vec<u32> {
        let mut order: Vec<u32> = (0..self.group_count).collect();
        order.sort_by_key(|&g| {
            let score = if g == goal_group {
                0
            } else if self.groups[g as usize].flags & uninit_flag != 0 {
                2
            } else {
                1
            };
            (score, g)
        });
        order
    }

    fn runs_in(&mut self, g: u32) -> Result<Vec<Run>> {
        if self.groups[g as usize].free_blocks == 0 {
            return Ok(Vec::new());
        }
        self.load_block_bitmap(g)?;
        let start = self.group_start(g);
        let total = self.group_block_count(g);
        let bitmap = &self.block_bitmaps[&g];
        let mut runs = Vec::new();
        let mut run_start: Option<u64> = None;
        for i in 0..=total {
            let free = i < total && !test_bit(bitmap, i as usize);
            if free && run_start.is_none() {
                run_start = Some(i);
            }
            if !free {
                if let Some(s) = run_start.take() {
                    runs.push(Run { start: start + s, length: i - s });
                }
            }
        }
        Ok(runs)
    }

    /// Finds `count` free blocks, as few runs as possible and never more than `max_runs` (four fit
    /// in an inode without an extent tree block). Prefers `goal_group`, then initialised groups.
    fn allocate_blocks(&mut self, count: u64, goal_group: u32, max_runs: usize) -> Result<Vec<Run>> {
        self.require_writable()?;
        if count == 0 {
            return Ok(Vec::new());
        }
        if count > self.free_blocks() {
            fail!("need {count} blocks, {} free", self.free_blocks());
        }
        self.ensure_refs()?;
        let order = self.group_order(goal_group, BG_BLOCK_UNINIT);

        // One run that fits, if any group has one.
        for &g in &order {
            let fitting = self.runs_in(g)?.into_iter().find(|r| r.length >= count);
            if let Some(run) = fitting {
                self.mark_blocks(run.start, count, true)?;
                let refs = self.refs()?;
                for b in run.start..run.start + count {
                    refs[b as usize] = 1;
                }
                return Ok(vec![Run { start: run.start, length: count }]);
            }
        }

        // Otherwise the largest runs first, up to max_runs.
        let mut all = Vec::new();
        for &g in &order {
            all.extend(self.runs_in(g)?);
        }
        all.sort_by(|a, b| b.length.cmp(&a.length));
        let mut picked = Vec::new();
        let mut remaining = count;
        for run in all {
            if remaining == 0 || picked.len() == max_runs {
                break;
            }
            let take = run.length.min(remaining);
            picked.push(Run { start: run.start, length: take });
            remaining -= take;
        }
        if remaining > 0 {
            fail!("cannot place {count} blocks in {max_runs} runs; free space is too fragmented");
        }
        for run in &picked {
            self.mark_blocks(run.start, run.length, true)?;
            let refs = self.refs()?;
            for b in run.start..run.start + run.length {
                refs[b as usize] = 1;
            }
        }
        picked.sort_by_key(|r| r.start);
        Ok(picked)
    }

    /// Drops one reference from each block, freeing those that reach zero. Returns how many were
    /// freed and how many are still referenced by another file.
    fn release_blocks(&mut self, blocks: &[u64]) -> Result<(u64, u64)> {
        let mut freed = 0;
        let mut still_shared = 0;
        for &b in blocks {
            let refs = self.refs()?;
            if refs[b as usize] == 0 {
                fail!("block {b} released more times than it is referenced");
            }
            refs[b as usize] -= 1;
            if refs[b as usize] == 0 {
                self.mark_blocks(b, 1, false)?;
                freed += 1;
            } else {
                still_shared += 1;
            }
        }
        Ok((freed, still_shared))
    }

    fn allocate_inode(&mut self, goal_group: u32, is_directory: bool) -> Result<u32> {
        self.require_writable()?;
        if self.free_inodes() == 0 {
            fail!("no free inodes");
        }
        for g in self.group_order(goal_group, BG_INODE_UNINIT) {
            if self.groups[g as usize].free_inodes == 0 {
                continue;
            }
            self.load_inode_bitmap(g)?;
            for i in 0..self.inodes_per_group {
                let ino = g * self.inodes_per_group + i + 1;
                let bitmap = self.inode_bitmaps.get_mut(&g).expect("just loaded");
                if ino < self.first_ino || test_bit(bitmap, i as usize) {
                    continue;
                }
                set_bit(bitmap, i as usize);
                let inodes_per_group = self.inodes_per_group;
                let desc = &mut self.groups[g as usize];
                desc.free_inodes -= 1;
                if is_directory {
                    desc.used_dirs += 1;
                }
                desc.flags &= !BG_INODE_UNINIT;
                // Inodes past the in-use high-water mark are "unused" and never read; moving the
                // mark is what makes the new one visible.
                if i >= inodes_per_group - desc.itable_unused {
                    desc.itable_unused = inodes_per_group - i - 1;
                }
                self.dirty_inode_bitmaps.insert(g);
                self.dirty_groups.insert(g);
                let free = self.free_inodes() - 1;
                put_u32le(&mut self.sb, 0x10, free);
                self.super_dirty = true;
                return Ok(ino);
            }
        }
        fail!("no free inodes (group counts disagree with bitmaps)")
    }

    fn free_inode(&mut self, ino: u32, is_directory: bool) -> Result<()> {
        let g = self.group_of_inode(ino);
        let bit = ((ino - 1) % self.inodes_per_group) as usize;
        self.load_inode_bitmap(g)?;
        let bitmap = self.inode_bitmaps.get_mut(&g).expect("just loaded");
        if !test_bit(bitmap, bit) {
            fail!("inode {ino} is already free");
        }
        clear_bit(bitmap, bit);
        let desc = &mut self.groups[g as usize];
        desc.free_inodes += 1;
        if is_directory {
            desc.used_dirs -= 1;
        }
        self.dirty_inode_bitmaps.insert(g);
        self.dirty_groups.insert(g);
        let free = self.free_inodes() + 1;
        put_u32le(&mut self.sb, 0x10, free);
        self.super_dirty = true;
        // Zeroed, so nothing can mistake the remains for a live inode.
        let zeroed = Inode { ino, raw: vec![0u8; self.inode_size] };
        self.write_inode(&zeroed)
    }

    fn group_of_inode(&self, ino: u32) -> u32 {
        (ino - 1) / self.inodes_per_group
    }

    // ── Directory entries ───────────────────────────────────────────────────────────────────────

    /// A directory block may be edited in place only if no other file shares it.
    fn require_unshared(&mut self, block: u64, what: &str) -> Result<()> {
        if self.refs()?[block as usize] > 1 {
            fail!("{what}: block {block} is shared with another file; refusing to edit it in place");
        }
        Ok(())
    }

    fn remove_entry(&mut self, dir_ino: u32, name: &str) -> Result<DirEntry> {
        let records = self.dir_records(dir_ino)?;
        let Some(index) = records.iter().position(|r| r.inode != 0 && r.name == name) else {
            fail!("{name}: not in directory {dir_ino}");
        };
        if name == "." || name == ".." {
            fail!("refusing to remove . or ..");
        }
        let target = &records[index];
        self.require_unshared(target.physical, &format!("directory {dir_ino}"))?;

        let mut block = self.read_blocks(target.physical, 1)?;
        let previous = if index > 0 { Some(&records[index - 1]) } else { None };
        match previous {
            Some(previous) if previous.physical == target.physical => {
                // Fold the record into the one before it, which is how the kernel deletes.
                put_u16le(&mut block, previous.offset + 4, (previous.rec_len + target.rec_len) as u16);
            }
            _ => {
                // First record in its block: keep the record, mark it empty.
                put_u32le(&mut block, target.offset, 0);
                block[target.offset + 7] = 0;
            }
        }
        self.write_block(target.physical, &block)?;
        Ok(DirEntry { name: target.name.clone(), inode: target.inode, file_type: target.file_type })
    }

    fn add_entry(&mut self, dir_ino: u32, name: &str, child_ino: u32, file_type: u8) -> Result<()> {
        let name_bytes = name.as_bytes();
        if name_bytes.is_empty() || name_bytes.len() > 255 || name.contains('/') || name.contains('\0') {
            fail!("invalid file name {}", json_quote(name));
        }
        let mut dir = self.read_inode(dir_ino)?;
        if u32le(&dir.raw, 0x20) & INODE_FLAG_INDEX != 0 {
            // Inserting into a hashed directory means placing the entry in the leaf its hash
            // selects, and splitting that leaf when it is full. Nothing the ROM adds needs it, so
            // it is refused rather than half-done.
            fail!("directory {dir_ino} is hashed (dir_index); adding entries to it is not supported");
        }
        if self.read_dir_ino(dir_ino)?.iter().any(|e| e.name == name) {
            fail!("{name} already exists");
        }

        let needed = (8 + name_bytes.len() + 3) & !3;
        let write = |block: &mut [u8], offset: usize, rec_len: usize| {
            put_u32le(block, offset, child_ino);
            put_u16le(block, offset + 4, rec_len as u16);
            block[offset + 6] = name_bytes.len() as u8;
            block[offset + 7] = file_type;
            block[offset + 8..offset + rec_len].fill(0);
            block[offset + 8..offset + 8 + name_bytes.len()].copy_from_slice(name_bytes);
        };

        for record in self.dir_records(dir_ino)? {
            let used = if record.inode == 0 { 0 } else { (8 + record.name_len + 3) & !3 };
            if record.rec_len < used + needed {
                continue;
            }
            self.require_unshared(record.physical, &format!("directory {dir_ino}"))?;
            let mut block = self.read_blocks(record.physical, 1)?;
            if used == 0 {
                write(&mut block, record.offset, record.rec_len);
            } else {
                put_u16le(&mut block, record.offset + 4, used as u16);
                write(&mut block, record.offset + used, record.rec_len - used);
            }
            return self.write_block(record.physical, &block);
        }

        // No room: grow the directory by one block.
        let ExtentMap { mut extents, tree_blocks } = self.extents_of(&dir)?;
        if !tree_blocks.is_empty() {
            fail!("directory {dir_ino} has an extent tree; growing it is not supported");
        }
        let run = self.allocate_blocks(1, self.group_of_inode(dir_ino), 1)?[0];
        let mut block = vec![0u8; self.block_size as usize];
        write(&mut block, 0, self.block_size as usize);
        self.write_block(run.start, &block)?;

        let next_logical = extents.iter().map(|e| e.logical + e.length).max().unwrap_or(0);
        let extends_last = extents
            .last()
            .is_some_and(|last| !last.uninit && last.start + last.length == run.start && last.length < 32768);
        if extends_last {
            extents.last_mut().expect("checked").length += 1;
        } else {
            extents.push(Extent { logical: next_logical, start: run.start, length: 1, uninit: false });
        }
        if extents.len() > 4 {
            fail!("directory {dir_ino} would need more than four extents");
        }
        write_extent_root(&mut dir.raw, &extents)?;
        set_inode_size(&mut dir.raw, (next_logical + 1) * self.block_size);
        add_inode_blocks(&mut dir.raw, self.block_size / 512);
        self.write_inode(&dir)
    }

    // ── Mutations ───────────────────────────────────────────────────────────────────────────────

    fn visit_tree(&self, ino: u32, links_removed: &mut OrderedCounts, directories: &mut HashSet<u32>) -> Result<()> {
        links_removed.add(ino);
        if !self.stat(ino)?.is_directory {
            return Ok(());
        }
        if !directories.insert(ino) {
            fail!("directory {ino} reached twice; the tree is not a tree");
        }
        for entry in self.read_dir_ino(ino)? {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            self.visit_tree(entry.inode, links_removed, directories)?;
        }
        Ok(())
    }

    /// Removes a file or directory tree, freeing what it owned.
    ///
    /// A file with hard links outside the tree keeps its inode and its blocks; only the links being
    /// removed are dropped.
    pub fn remove_tree(&mut self, path: &str) -> Result<RemoveReport> {
        self.require_writable()?;
        let parts = split_path(path)?;
        let Some((name, parents)) = parts.split_last() else {
            fail!("refusing to remove the root");
        };
        let parent_ino = self.require(&format!("/{}", parents.join("/")))?;
        let child_ino = self.require(path)?;
        self.ensure_refs()?;

        // Every inode under the tree, with how many of its links are inside it.
        let mut links_removed = OrderedCounts::default();
        let mut directories = HashSet::new();
        self.visit_tree(child_ino, &mut links_removed, &mut directories)?;
        if links_removed.contains(ROOT_INO) {
            fail!("refusing to remove the root");
        }

        let mut report = RemoveReport::default();
        for (ino, removed) in links_removed.iter() {
            let mut inode = self.read_inode(ino)?;
            let is_dir = directories.contains(&ino);
            let links = u32::from(u16le(&inode.raw, 0x1a));
            if !is_dir && links > removed {
                put_u16le(&mut inode.raw, 0x1a, (links - removed) as u16);
                self.write_inode(&inode)?;
                continue;
            }
            let owned = self.owned_blocks(&inode)?;
            let (freed, still_shared) = self.release_blocks(&owned)?;
            report.blocks_freed += freed;
            report.blocks_still_shared += still_shared;
            let acl = xattr_block_of(&inode.raw);
            if acl != 0 {
                self.release_xattr_block(acl)?;
            }
            self.free_inode(ino, is_dir)?;
            report.inodes_freed += 1;
        }

        self.remove_entry(parent_ino, name)?;
        if directories.contains(&child_ino) {
            // The removed directory's `..` no longer points at the parent.
            let mut parent = self.read_inode(parent_ino)?;
            let links = u32::from(u16le(&parent.raw, 0x1a));
            if links > 2 && links < DIR_NLINK_MAX {
                put_u16le(&mut parent.raw, 0x1a, (links - 1) as u16);
                self.write_inode(&parent)?;
            }
        }
        Ok(report)
    }

    /// Creates a regular file. Fails if it exists; use [`replace_file`](Self::replace_file) for
    /// that.
    pub fn create_file(&mut self, path: &str, data: &[u8], options: NewInodeOptions) -> Result<u32> {
        self.require_writable()?;
        // Counted before anything is allocated: the scan reads every in-use inode, and one
        // allocated but not yet written would be read as whatever the inode table held.
        self.ensure_refs()?;
        let (parent_ino, name) = self.parent_of(path)?;
        let goal = self.group_of_inode(parent_ino);
        let ino = self.allocate_inode(goal, false)?;
        let runs = self.write_data(data, goal)?;
        let mut raw = self.new_inode_raw(S_IFREG | (options.mode & 0o7777), &options, 1)?;
        set_inode_size(&mut raw, data.len() as u64);
        write_extent_root(&mut raw, &runs_to_extents(&runs))?;
        let blocks: u64 = runs.iter().map(|r| r.length).sum();
        add_inode_blocks(&mut raw, blocks * self.block_size / 512);
        self.write_inode(&Inode { ino, raw })?;
        self.add_entry(parent_ino, &name, ino, ft::REG)?;
        Ok(ino)
    }

    pub fn mkdir(&mut self, path: &str, options: NewInodeOptions) -> Result<u32> {
        self.require_writable()?;
        self.ensure_refs()?;
        let (parent_ino, name) = self.parent_of(path)?;
        let ino = self.allocate_inode(self.group_of_inode(parent_ino), true)?;
        let run = self.allocate_blocks(1, self.group_of_inode(ino), 1)?[0];

        let mut block = vec![0u8; self.block_size as usize];
        put_u32le(&mut block, 0, ino);
        put_u16le(&mut block, 4, 12);
        block[6] = 1;
        block[7] = ft::DIR;
        block[8] = b'.';
        put_u32le(&mut block, 12, parent_ino);
        put_u16le(&mut block, 16, (self.block_size - 12) as u16);
        block[18] = 2;
        block[19] = ft::DIR;
        block[20..22].copy_from_slice(b"..");
        self.write_block(run.start, &block)?;

        let mut raw = self.new_inode_raw(S_IFDIR | (options.mode & 0o7777), &options, 2)?;
        set_inode_size(&mut raw, self.block_size);
        write_extent_root(&mut raw, &runs_to_extents(&[run]))?;
        add_inode_blocks(&mut raw, self.block_size / 512);
        self.write_inode(&Inode { ino, raw })?;

        self.add_entry(parent_ino, &name, ino, ft::DIR)?;
        let mut parent = self.read_inode(parent_ino)?;
        let links = u32::from(u16le(&parent.raw, 0x1a));
        // 1 is dir_nlink's "too many to count" sentinel, and stays 1; it is not a tally to add to.
        if links != 1 {
            let next = if links + 1 >= DIR_NLINK_MAX { 1 } else { links + 1 };
            put_u16le(&mut parent.raw, 0x1a, next as u16);
            self.write_inode(&parent)?;
        }
        Ok(ino)
    }

    /// Replaces a regular file's content, keeping its inode — and so its mode, owner and label.
    ///
    /// In place when every block the file owns is referenced by it alone and the new content fits:
    /// the vendor volume has one free inode and fifty free blocks, and rewriting its `build.prop`
    /// must not depend on either. Otherwise the new bytes go into new blocks and the old ones are
    /// released through the reference count — on a deduplicated volume "this file's block" may also
    /// be someone else's, and that block is never written.
    pub fn replace_file(&mut self, path: &str, data: &[u8]) -> Result<()> {
        self.require_writable()?;
        self.ensure_refs()?;
        let ino = self.require(path)?;
        let mut inode = self.read_inode(ino)?;
        if u16le(&inode.raw, 0x00) & S_IFMT != S_IFREG {
            fail!("{path} is not a regular file");
        }
        let ExtentMap { extents, tree_blocks } = self.extents_of(&inode)?;
        let old = self.owned_blocks(&inode)?;
        let block_size = self.block_size as usize;
        let needed = data.len().div_ceil(block_size);

        // The data blocks in file order, if the file is a plain run of them from logical block 0.
        let mut expect_logical = 0;
        let mut data_blocks = Vec::new();
        let mut plain = tree_blocks.is_empty();
        for e in &extents {
            if e.uninit || e.logical != expect_logical {
                plain = false;
            }
            data_blocks.extend((0..e.length).map(|i| e.start + i));
            expect_logical = e.logical + e.length;
        }
        let keep: Vec<u64> = data_blocks.iter().copied().take(needed).collect();
        let keep_runs = blocks_to_runs(&keep);
        let exclusive = {
            let refs = self.refs()?;
            old.iter().all(|&b| refs[b as usize] == 1)
        };
        let in_place = plain && exclusive && data_blocks.len() >= needed && keep_runs.len() <= 4;

        let runs = if in_place {
            for (i, &b) in keep.iter().enumerate() {
                let mut block = vec![0u8; block_size];
                let from = i * block_size;
                let to = ((i + 1) * block_size).min(data.len());
                block[..to - from].copy_from_slice(&data[from..to]);
                self.write_block(b, &block)?;
            }
            self.release_blocks(&data_blocks[needed..])?;
            keep_runs
        } else {
            let runs = self.write_data(data, self.group_of_inode(ino))?;
            self.release_blocks(&old)?;
            runs
        };
        set_inode_size(&mut inode.raw, data.len() as u64);
        write_extent_root(&mut inode.raw, &runs_to_extents(&runs))?;
        let flags = u32le(&inode.raw, 0x20) & !INODE_FLAG_HUGE_FILE;
        put_u32le(&mut inode.raw, 0x20, flags | INODE_FLAG_EXTENTS);
        put_u32le(&mut inode.raw, 0x1c, 0);
        put_u16le(&mut inode.raw, 0x74, 0);
        // i_blocks counts the external xattr block too; the inode keeps it, so the count must.
        let blocks_now: u64 =
            runs.iter().map(|r| r.length).sum::<u64>() + u64::from(xattr_block_of(&inode.raw) != 0);
        add_inode_blocks(&mut inode.raw, blocks_now * self.block_size / 512);
        put_u32le(&mut inode.raw, 0x0c, self.epoch);
        put_u32le(&mut inode.raw, 0x10, self.epoch);
        self.write_inode(&inode)
    }

    fn parent_of(&self, path: &str) -> Result<(u32, String)> {
        let parts = split_path(path)?;
        let Some((name, parents)) = parts.split_last() else {
            fail!("the root has no parent");
        };
        let parent_ino = self.require(&format!("/{}", parents.join("/")))?;
        if !self.stat(parent_ino)?.is_directory {
            fail!("{path}: parent is not a directory");
        }
        Ok((parent_ino, (*name).to_owned()))
    }

    fn write_data(&mut self, data: &[u8], goal_group: u32) -> Result<Vec<Run>> {
        let block_size = self.block_size as usize;
        let count = data.len().div_ceil(block_size) as u64;
        let runs = self.allocate_blocks(count, goal_group, 4)?;
        let mut at = 0;
        for run in &runs {
            for i in 0..run.length {
                let mut block = vec![0u8; block_size];
                let end = (at + block_size).min(data.len());
                block[..end - at].copy_from_slice(&data[at..end]);
                self.write_block(run.start + i, &block)?;
                at += block_size;
            }
        }
        Ok(runs)
    }

    fn new_inode_raw(&self, mode: u16, options: &NewInodeOptions, links: u16) -> Result<Vec<u8>> {
        if options.selinux.is_empty() {
            fail!("a new inode needs a security.selinux label");
        }
        let mut raw = vec![0u8; self.inode_size];
        put_u16le(&mut raw, 0x00, mode);
        put_u16le(&mut raw, 0x02, (options.uid & 0xffff) as u16);
        put_u32le(&mut raw, 0x08, self.epoch);
        put_u32le(&mut raw, 0x0c, self.epoch);
        put_u32le(&mut raw, 0x10, self.epoch);
        put_u16le(&mut raw, 0x18, (options.gid & 0xffff) as u16);
        put_u16le(&mut raw, 0x1a, links);
        put_u32le(&mut raw, 0x20, INODE_FLAG_EXTENTS);
        put_u16le(&mut raw, 0x78, (options.uid >> 16) as u16);
        put_u16le(&mut raw, 0x7a, (options.gid >> 16) as u16);
        write_extent_root(&mut raw, &[])?;
        if self.inode_size > 128 {
            put_u16le(&mut raw, 0x80, self.extra_isize);
            put_u32le(&mut raw, 0x90, self.epoch);
            let mut value: Vec<u8> = options.selinux.chars().map(|c| c as u32 as u8).collect();
            value.push(0);
            write_inode_xattr(&mut raw, 0x80 + usize::from(self.extra_isize), "selinux", &value)?;
        }
        Ok(raw)
    }

    // ── Persisting ──────────────────────────────────────────────────────────────────────────────

    /// Writes bitmaps, group descriptors (with fresh checksums) and the superblock — and the backup
    /// copies of the last two in every group that carries one, as `ext2fs_flush` does.
    ///
    /// The kernel reads only the primaries, so stale backups would boot fine. They matter to
    /// repair: `e2fsck -b` or a damaged primary would bring back the stock allocation state over
    /// files that no longer match it, and quietly undo the ROM.
    pub fn flush(&mut self) -> Result<()> {
        if !self.writable {
            return Ok(());
        }
        for g in std::mem::take(&mut self.dirty_block_bitmaps) {
            let bitmap = self.block_bitmaps[&g].clone();
            self.write_block(self.groups[g as usize].block_bitmap, &bitmap)?;
        }
        for g in std::mem::take(&mut self.dirty_inode_bitmaps) {
            let bitmap = self.inode_bitmaps[&g].clone();
            self.write_block(self.groups[g as usize].inode_bitmap, &bitmap)?;
        }

        let write_backups = !self.dirty_groups.is_empty() || self.super_dirty;
        let block_size = self.block_size as usize;

        if !self.dirty_groups.is_empty() {
            let mut gdt = self.read_blocks(self.first_data_block + 1, self.gdt_blocks)?;
            for g in std::mem::take(&mut self.dirty_groups) {
                let desc = &self.groups[g as usize];
                let field = |value: i64, what: &str| {
                    u16::try_from(value).map_err(|_| err!("group {g}: {what} would be {value}"))
                };
                let mut raw = desc.raw;
                put_u16le(&mut raw, 0x0c, field(desc.free_blocks, "free block count")?);
                put_u16le(&mut raw, 0x0e, field(desc.free_inodes, "free inode count")?);
                put_u16le(&mut raw, 0x10, field(desc.used_dirs, "directory count")?);
                put_u16le(&mut raw, 0x12, desc.flags);
                put_u16le(&mut raw, 0x1c, field(i64::from(desc.itable_unused), "itable_unused")?);
                let checksum = self.group_checksum(g, &raw);
                put_u16le(&mut raw, 0x1e, checksum);
                self.groups[g as usize].raw = raw;
                gdt[g as usize * 32..g as usize * 32 + 32].copy_from_slice(&raw);
            }
            for i in 0..self.gdt_blocks as usize {
                self.write_block(self.first_data_block + 1 + i as u64, &gdt[i * block_size..(i + 1) * block_size])?;
            }
        }

        if self.super_dirty {
            self.disk.write(SUPERBLOCK_OFFSET, &self.sb)?;
            self.super_dirty = false;
        }

        if write_backups {
            let gdt = self.read_blocks(self.first_data_block + 1, self.gdt_blocks)?;
            for g in 1..self.group_count {
                if !self.has_super_backup(g) {
                    continue;
                }
                let start = self.group_start(g);
                // A backup superblock sits at the very start of its group's first block, and
                // records which group it is in.
                let mut copy = self.sb.clone();
                put_u16le(&mut copy, 0x5a, g as u16);
                let mut block = self.read_blocks(start, 1)?;
                block[..copy.len()].copy_from_slice(&copy);
                self.write_block(start, &block)?;
                for i in 0..self.gdt_blocks as usize {
                    self.write_block(start + 1 + i as u64, &gdt[i * block_size..(i + 1) * block_size])?;
                }
            }
        }
        Ok(())
    }

    // ── Verification ────────────────────────────────────────────────────────────────────────────

    /// Re-derives the allocation state from the inodes and checks it against what is on disk.
    ///
    /// Covers what `e2fsck` passes 1, 2, 4 and 5 would catch after the kinds of edit this editor
    /// makes: bitmaps against reachable blocks, counts against bitmaps, group checksums, directory
    /// structure, link counts, and inodes that are allocated but unreachable. Reads through the
    /// editor's own caches, so run it after `flush()` on a fresh `open()` to check what was
    /// written.
    pub fn verify(&mut self) -> Result<VerifyReport> {
        let mut problems: Vec<String> = Vec::new();
        let mut problem = |message: String| {
            if problems.len() < 200 {
                problems.push(message);
            }
        };

        for g in 0..self.group_count {
            let raw = self.groups[g as usize].raw;
            if u16le(&raw, 0x1e) != self.group_checksum(g, &raw) {
                problem(format!("group {g}: checksum mismatch"));
            }
        }
        if u32le(&self.sb, 0xe8) != 0 {
            problem("superblock: orphan list is not empty".into());
        }

        // Expected use of every block: metadata, then everything reachable from in-use inodes.
        let mut expected = vec![0u8; self.blocks_count as usize];
        for g in 0..self.group_count {
            for b in self.metadata_blocks(g)? {
                expected[b as usize] = 1;
            }
        }
        let in_use_list = self.in_use_inodes()?;
        let in_use: HashSet<u32> = in_use_list.iter().copied().collect();
        let mut owner: HashMap<u64, u32> = HashMap::new();
        let mut xattr_users: Vec<(u64, u32)> = Vec::new();
        for &ino in &in_use_list {
            if ino != ROOT_INO && ino < self.first_ino {
                continue;
            }
            let inode = self.read_inode(ino)?;
            let blocks = match self.owned_blocks(&inode) {
                Ok(blocks) => blocks,
                Err(error) => {
                    problem(error.0);
                    continue;
                }
            };
            let acl = xattr_block_of(&inode.raw);
            if acl != 0 {
                if acl >= self.blocks_count {
                    problem(format!("inode {ino}: xattr block {acl} is outside the volume"));
                } else {
                    match xattr_users.iter_mut().find(|(block, _)| *block == acl) {
                        Some(entry) => entry.1 += 1,
                        None => xattr_users.push((acl, 1)),
                    }
                    if expected[acl as usize] == 1 && !owner.contains_key(&acl) {
                        problem(format!("inode {ino}: xattr block {acl} is a metadata block"));
                    }
                    owner.insert(acl, ino);
                    expected[acl as usize] = 2;
                }
            }
            // i_blocks counts 512-byte sectors, or filesystem blocks under the inode's HUGE_FILE
            // flag, and includes the external xattr block.
            let flags = u32le(&inode.raw, 0x20);
            let recorded = u64::from(u32le(&inode.raw, 0x1c)) + (u64::from(u16le(&inode.raw, 0x74)) << 32);
            let sectors = recorded * if flags & INODE_FLAG_HUGE_FILE != 0 { self.block_size / 512 } else { 1 };
            let owned = blocks.len() as u64 + u64::from(acl != 0);
            if sectors != owned * (self.block_size / 512) {
                problem(format!("inode {ino}: i_blocks says {sectors} sectors, it owns {owned} blocks"));
            }
            for b in blocks {
                if expected[b as usize] == 1 && !owner.contains_key(&b) {
                    problem(format!("inode {ino} owns metadata block {b}"));
                }
                if let Some(&other) = owner.get(&b) {
                    if !self.shared_blocks {
                        problem(format!("block {b} is owned by inodes {other} and {ino}"));
                    }
                }
                owner.insert(b, ino);
                expected[b as usize] = 2;
            }
        }

        for (block, users) in xattr_users {
            let data = self.read_blocks(block, 1)?;
            if u32le(&data, 0) != XATTR_MAGIC {
                problem(format!("block {block}: referenced as xattrs but not an xattr block"));
            } else if u32le(&data, 4) != users {
                problem(format!("xattr block {block}: h_refcount {}, used by {users} inodes", u32le(&data, 4)));
            }
        }

        let mut free_blocks = 0u64;
        let mut free_inodes = 0u64;
        for g in 0..self.group_count {
            self.load_block_bitmap(g)?;
            self.load_inode_bitmap(g)?;
            let start = self.group_start(g);
            let count = self.group_block_count(g);
            let bitmap = &self.block_bitmaps[&g];
            let desc = &self.groups[g as usize];
            let mut free = 0u64;
            for i in 0..count {
                let on_disk = test_bit(bitmap, i as usize);
                let want = expected[(start + i) as usize] != 0;
                if on_disk && !want {
                    problem(format!("block {}: marked in use, owned by nothing", start + i));
                }
                if !on_disk && want {
                    problem(format!("block {}: in use but marked free", start + i));
                }
                if !on_disk {
                    free += 1;
                }
            }
            if (count as usize..self.block_size as usize * 8).any(|i| !test_bit(bitmap, i)) {
                problem(format!("group {g}: block bitmap padding not set"));
            }
            if free as i64 != desc.free_blocks {
                problem(format!("group {g}: descriptor says {} free blocks, bitmap says {free}", desc.free_blocks));
            }
            free_blocks += free;

            let ibitmap = &self.inode_bitmaps[&g];
            let mut ifree = 0u64;
            let mut dirs = 0i64;
            for i in 0..self.inodes_per_group {
                let ino = g * self.inodes_per_group + i + 1;
                if !test_bit(ibitmap, i as usize) {
                    ifree += 1;
                    continue;
                }
                if i >= self.inodes_per_group - desc.itable_unused {
                    problem(format!("inode {ino}: in use but past bg_itable_unused"));
                }
                if (ino >= self.first_ino || ino == ROOT_INO) && self.stat(ino)?.is_directory {
                    dirs += 1;
                }
            }
            if (self.inodes_per_group as usize..self.block_size as usize * 8).any(|i| !test_bit(ibitmap, i)) {
                problem(format!("group {g}: inode bitmap padding not set"));
            }
            if ifree as i64 != desc.free_inodes {
                problem(format!("group {g}: descriptor says {} free inodes, bitmap says {ifree}", desc.free_inodes));
            }
            if dirs != desc.used_dirs {
                problem(format!("group {g}: descriptor says {} directories, found {dirs}", desc.used_dirs));
            }
            free_inodes += ifree;
        }
        if free_blocks != self.free_blocks() {
            problem(format!("superblock says {} free blocks, groups say {free_blocks}", self.free_blocks()));
        }
        if free_inodes != u64::from(self.free_inodes()) {
            problem(format!("superblock says {} free inodes, groups say {free_inodes}", self.free_inodes()));
        }

        // Directory structure, reachability and link counts.
        let mut references: HashMap<u32, u64> = HashMap::new();
        let mut reached: HashSet<u32> = HashSet::from([ROOT_INO]);
        let mut queue = std::collections::VecDeque::from([ROOT_INO]);
        while let Some(dir_ino) = queue.pop_front() {
            let entries = match self.read_dir_ino(dir_ino) {
                Ok(entries) => entries,
                Err(error) => {
                    problem(error.0);
                    continue;
                }
            };
            if entries.first().is_none_or(|e| e.name != "." || e.inode != dir_ino) {
                problem(format!("directory {dir_ino}: first entry is not ."));
            }
            if entries.get(1).is_none_or(|e| e.name != "..") {
                problem(format!("directory {dir_ino}: second entry is not .."));
            }
            for entry in entries {
                *references.entry(entry.inode).or_insert(0) += 1;
                if !in_use.contains(&entry.inode) {
                    problem(format!(
                        "directory {dir_ino}: entry {} points at free inode {}",
                        entry.name, entry.inode
                    ));
                    continue;
                }
                if entry.name == "." || entry.name == ".." || !reached.insert(entry.inode) {
                    continue;
                }
                let stat = self.stat(entry.inode)?;
                let want_type = if stat.is_directory {
                    ft::DIR
                } else if stat.is_file {
                    ft::REG
                } else if stat.is_symlink {
                    ft::SYMLINK
                } else {
                    entry.file_type
                };
                if entry.file_type != want_type {
                    problem(format!(
                        "{} (inode {}): directory says type {}",
                        entry.name, entry.inode, entry.file_type
                    ));
                }
                if stat.is_directory {
                    queue.push_back(entry.inode);
                }
            }
        }
        for &ino in &in_use_list {
            if ino < self.first_ino && ino != ROOT_INO {
                continue;
            }
            if !reached.contains(&ino) {
                problem(format!("inode {ino}: allocated but not reachable from /"));
                continue;
            }
            let stat = self.stat(ino)?;
            let count = references.get(&ino).copied().unwrap_or(0);
            let ok = u64::from(stat.links) == count
                || (stat.is_directory && stat.links == 1 && count >= u64::from(DIR_NLINK_MAX));
            if !ok {
                problem(format!("inode {ino}: link count {}, referenced {count} times", stat.links));
            }
        }

        Ok(VerifyReport { ok: problems.is_empty(), problems })
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/// `i_file_acl`: the inode's external xattr block, or 0.
fn xattr_block_of(raw: &[u8]) -> u64 {
    u64::from(u32le(raw, 0x68)) | (u64::from(u16le(raw, 0x76)) << 32)
}

/// `buf[start..end]`, clamped to the buffer the way `Buffer.subarray` clamps.
fn clamped(buf: &[u8], start: usize, end: usize) -> &[u8] {
    let start = start.min(buf.len());
    &buf[start..end.clamp(start, buf.len())]
}

fn read_xattr_entries(buf: &[u8], first_entry: usize, value_base: usize, end: usize, out: &mut Vec<(String, Vec<u8>)>) {
    let mut at = first_entry;
    while at + 16 <= end && at + 16 <= buf.len() && u32le(buf, at) != 0 {
        let name_len = usize::from(buf[at]);
        let index = buf[at + 1];
        let value_offs = usize::from(u16le(buf, at + 2));
        let value_size = u32le(buf, at + 8) as usize;
        let name = latin1(clamped(buf, at + 16, at + 16 + name_len));
        let prefix = match index {
            XATTR_INDEX_SECURITY => "security.".to_owned(),
            1 => "user.".to_owned(),
            4 => "trusted.".to_owned(),
            other => format!("#{other}."),
        };
        let key = prefix + &name;
        let value = clamped(buf, value_base + value_offs, value_base + value_offs + value_size).to_vec();
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => out.push((key, value)),
        }
        at += (16 + name_len + 3) & !3;
    }
}

fn refuse_unsupported(kind: FeatureKind, flags: u32, supported: u32) -> Result<()> {
    let extra = flags & !supported;
    if extra == 0 {
        return Ok(());
    }
    let label = match kind {
        FeatureKind::Compat => "compat",
        FeatureKind::Incompat => "incompat",
        FeatureKind::RoCompat => "roCompat",
    };
    let names: Vec<String> = (0..32)
        .map(|bit| 1u32 << bit)
        .filter(|mask| extra & mask != 0)
        .map(|mask| feature_name(kind, mask).map(str::to_owned).unwrap_or_else(|| format!("{label}:0x{mask:x}")))
        .collect();
    fail!("unsupported ext4 feature(s): {}", names.join(", "))
}

fn split_path(path: &str) -> Result<Vec<&str>> {
    if !path.starts_with('/') {
        fail!("path must be absolute: {path}");
    }
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|&p| p == "." || p == "..") {
        fail!("path must be normalised: {path}");
    }
    Ok(parts)
}

fn set_bit(bitmap: &mut [u8], bit: usize) {
    bitmap[bit >> 3] |= 1 << (bit & 7);
}

fn clear_bit(bitmap: &mut [u8], bit: usize) {
    bitmap[bit >> 3] &= !(1 << (bit & 7));
}

fn test_bit(bitmap: &[u8], bit: usize) -> bool {
    bitmap[bit >> 3] & (1 << (bit & 7)) != 0
}

fn inode_size_of(raw: &[u8]) -> u64 {
    u64::from(u32le(raw, 0x04)) | (u64::from(u32le(raw, 0x6c)) << 32)
}

fn set_inode_size(raw: &mut [u8], size: u64) {
    put_u32le(raw, 0x04, size as u32);
    put_u32le(raw, 0x6c, (size >> 32) as u32);
}

/// Adds to i_blocks, in 512-byte units (the inode never carries HUGE_FILE after we touch it).
fn add_inode_blocks(raw: &mut [u8], sectors: u64) {
    let current = u64::from(u32le(raw, 0x1c)) | (u64::from(u16le(raw, 0x74)) << 32);
    let next = current + sectors;
    put_u32le(raw, 0x1c, next as u32);
    put_u16le(raw, 0x74, (next >> 32) as u16);
}

/// Physical blocks, in file order, as maximal contiguous runs.
fn blocks_to_runs(blocks: &[u64]) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for &b in blocks {
        let extends_last = runs.last().is_some_and(|last| last.start + last.length == b && last.length < 32768);
        if extends_last {
            runs.last_mut().expect("checked").length += 1;
        } else {
            runs.push(Run { start: b, length: 1 });
        }
    }
    runs
}

fn runs_to_extents(runs: &[Run]) -> Vec<Extent> {
    let mut logical = 0;
    runs.iter()
        .map(|run| {
            let extent = Extent { logical, start: run.start, length: run.length, uninit: false };
            logical += run.length;
            extent
        })
        .collect()
}

/// Writes a depth-0 extent tree into i_block: the header and up to four leaf entries.
fn write_extent_root(raw: &mut [u8], extents: &[Extent]) -> Result<()> {
    if extents.len() > 4 {
        fail!("more than four extents do not fit in the inode");
    }
    let node = &mut raw[0x28..0x28 + 60];
    node.fill(0);
    put_u16le(node, 0, EXTENT_MAGIC);
    put_u16le(node, 2, extents.len() as u16);
    put_u16le(node, 4, 4);
    put_u16le(node, 6, 0);
    for (i, e) in extents.iter().enumerate() {
        let at = 12 + i * 12;
        if e.length < 1 || e.length > 32768 {
            fail!("extent length {} out of range", e.length);
        }
        put_u32le(node, at, e.logical as u32);
        let raw_length = if e.uninit { e.length + 32768 } else { e.length };
        put_u16le(node, at + 4, raw_length as u16);
        put_u16le(node, at + 6, (e.start >> 32) as u16);
        put_u32le(node, at + 8, e.start as u32);
    }
    Ok(())
}

/// One in-inode `security.*` xattr, laid out the way e2fsdroid lays out the stock images: header,
/// a single entry with `e_hash` 0 (valid for in-inode entries), a terminator, and the value packed
/// against the end of the inode.
fn write_inode_xattr(raw: &mut [u8], base: usize, name: &str, value: &[u8]) -> Result<()> {
    let first = base + 4;
    let name_bytes = name.as_bytes();
    let entry_size = (16 + name_bytes.len() + 3) & !3;
    let value_size = (value.len() + 3) & !3;
    let value_offs = raw.len() as i64 - first as i64 - value_size as i64;
    if value_offs < (entry_size + 4) as i64 {
        fail!("xattr {name} does not fit in the inode");
    }
    let value_offs = value_offs as usize;
    put_u32le(raw, base, XATTR_MAGIC);
    raw[first] = name_bytes.len() as u8;
    raw[first + 1] = XATTR_INDEX_SECURITY;
    put_u16le(raw, first + 2, value_offs as u16);
    put_u32le(raw, first + 4, 0);
    put_u32le(raw, first + 8, value.len() as u32);
    put_u32le(raw, first + 12, 0);
    raw[first + 16..first + 16 + name_bytes.len()].copy_from_slice(name_bytes);
    put_u32le(raw, first + entry_size, 0);
    raw[first + value_offs..first + value_offs + value.len()].copy_from_slice(value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::LazyLock;

    // A 24 MiB volume with the stock system volumes' exact feature set; see make-ext4-fixture.sh
    // for what it contains and why. Copied fresh for every test so no test sees another's edits.
    static FIXTURE: LazyLock<Vec<u8>> = LazyLock::new(|| {
        let path = format!("{}/testdata/ext4-fixture.img.gz", env!("CARGO_MANIFEST_DIR"));
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap()).read_to_end(&mut out).unwrap();
        out
    });
    const LABEL: &str = "u:object_r:system_file:s0";
    const BS: usize = 4096;

    fn fresh() -> Vec<u8> {
        FIXTURE.clone()
    }

    fn open(buffer: &mut [u8]) -> Ext4Volume<BufferDisk<'_>> {
        Ext4Volume::open(BufferDisk::new(buffer), OpenOptions::writable()).unwrap()
    }

    fn open_read_only(buffer: &mut [u8]) -> Ext4Volume<BufferDisk<'_>> {
        Ext4Volume::open(BufferDisk::new(buffer), OpenOptions::default()).unwrap()
    }

    /// Checks what was written through a brand-new reader — never the editor's own caches.
    fn verified(buffer: &mut [u8]) -> Ext4Volume<BufferDisk<'_>> {
        let mut again = open_read_only(buffer);
        let report = again.verify().unwrap();
        assert_eq!(report.problems, Vec::<String>::new(), "fsck-lite found problems");
        again
    }

    fn bytes(c: u8, count: usize) -> Vec<u8> {
        vec![c; count]
    }

    fn label() -> NewInodeOptions<'static> {
        NewInodeOptions::new(0o644, LABEL)
    }

    fn dir_label() -> NewInodeOptions<'static> {
        NewInodeOptions::new(0o755, LABEL)
    }

    fn message<T>(result: Result<T>) -> String {
        match result {
            Ok(_) => panic!("expected a refusal"),
            Err(error) => error.0,
        }
    }

    #[test]
    fn the_pristine_fixture_opens_and_verifies_clean() {
        let mut buffer = fresh();
        let mut volume = open_read_only(&mut buffer);
        assert_eq!(volume.label(), "system");
        assert_eq!(volume.block_size(), BS as u64);
        assert!(volume.shared_blocks());
        assert_eq!(volume.verify().unwrap().problems, Vec::<String>::new());
    }

    #[test]
    fn reads_files_a_hashed_directory_a_symlink_and_labels() {
        let mut buffer = fresh();
        let volume = open_read_only(&mut buffer);
        let build_prop = String::from_utf8(volume.read_file("/system/build.prop").unwrap()).unwrap();
        assert!(build_prop.starts_with("ro.build.display.id=fixture-1\n"));
        assert_eq!(volume.read_file("/system/etc/large.bin").unwrap(), bytes(b'L', 40 * BS));

        let many = volume.lookup("/system/etc/many").unwrap().unwrap();
        assert!(volume.stat(many).unwrap().flags & 0x1000 != 0, "fixture directory should be htree-indexed");
        let names: Vec<String> = volume.read_dir_ino(many).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names.len(), 302);
        assert_eq!(names[..2], [".", ".."]);
        assert!(names.iter().any(|n| n == "a-deliberately-long-file-name-to-fill-directory-blocks-299.txt"));

        assert_eq!(volume.read_file("/system/build.prop.link").unwrap(), b"/system/build.prop");
        let ino = volume.lookup("/system/build.prop").unwrap().unwrap();
        assert_eq!(volume.selinux_label(ino).unwrap().as_deref(), Some(LABEL));
        assert_eq!(volume.lookup("/system/nope").unwrap(), None);
    }

    #[test]
    fn removing_a_tree_frees_what_it_owned_and_keeps_a_block_another_file_shares() {
        let mut buffer = fresh();
        let (before_blocks, before_inodes, app_links) = {
            let mut volume = open(&mut buffer);
            let before_blocks = volume.free_blocks();
            let before_inodes = volume.free_inodes();
            let app = volume.lookup("/system/app").unwrap().unwrap();
            let app_links = volume.stat(app).unwrap().links;

            let report = volume.remove_tree("/system/app/Bloat").unwrap();
            // Bloat/, Bloat.apk, oat/, oat/x86_64/, Bloat.odex.
            assert_eq!(report.inodes_freed, 5);
            // Bloat.apk's first two blocks are also Shared.apk's.
            assert_eq!(report.blocks_still_shared, 2);
            // Bloat.apk's third block, the odex, and one block for each of the three directories.
            assert_eq!(report.blocks_freed, 5);
            volume.flush().unwrap();
            (before_blocks, before_inodes, app_links)
        };

        {
            let after = verified(&mut buffer);
            assert_eq!(after.free_blocks(), before_blocks + 5);
            assert_eq!(after.free_inodes(), before_inodes + 5);
            assert_eq!(after.lookup("/system/app/Bloat").unwrap(), None);
            let app = after.lookup("/system/app").unwrap().unwrap();
            assert_eq!(after.stat(app).unwrap().links, app_links - 1);
            assert_eq!(after.read_file("/system/app/Keep/Shared.apk").unwrap(), bytes(b'B', 2 * BS));
        }

        // The last reference goes, so the shared blocks are finally freed.
        {
            let mut again = open(&mut buffer);
            let removed = again.remove_tree("/system/app/Keep/Shared.apk").unwrap();
            assert_eq!(removed.blocks_freed, 2);
            again.flush().unwrap();
        }
        assert_eq!(verified(&mut buffer).free_blocks(), before_blocks + 7);
    }

    #[test]
    fn an_entry_removed_from_a_hashed_directory_leaves_it_valid() {
        let mut buffer = fresh();
        {
            let mut volume = open(&mut buffer);
            volume.remove_tree("/system/etc/many/a-deliberately-long-file-name-to-fill-directory-blocks-150.txt").unwrap();
            volume.flush().unwrap();
        }
        assert_eq!(verified(&mut buffer).read_dir("/system/etc/many").unwrap().len(), 301);
    }

    #[test]
    fn creates_a_labelled_directory_and_file_the_way_the_stock_images_lay_them_out() {
        let mut buffer = fresh();
        let content = [bytes(b'W', 3 * BS), b"tail".to_vec()].concat();
        let (ino, media_links) = {
            let mut volume = open(&mut buffer);
            let media = volume.lookup("/system/media").unwrap().unwrap();
            let media_links = volume.stat(media).unwrap().links;
            volume.mkdir("/system/media/openemu", dir_label()).unwrap();
            let ino = volume.create_file("/system/media/openemu/wallpaper.png", &content, label()).unwrap();
            volume.flush().unwrap();
            (ino, media_links)
        };

        let after = verified(&mut buffer);
        assert_eq!(after.read_file("/system/media/openemu/wallpaper.png").unwrap(), content);
        let stat = after.stat(ino).unwrap();
        assert_eq!(stat.mode, 0o100644);
        assert_eq!(stat.links, 1);
        assert_eq!(stat.uid, 0);
        let dir = after.lookup("/system/media/openemu").unwrap().unwrap();
        assert_eq!(after.stat(dir).unwrap().links, 2);
        let media = after.lookup("/system/media").unwrap().unwrap();
        assert_eq!(after.stat(media).unwrap().links, media_links + 1);
        assert_eq!(after.selinux_label(ino).unwrap().as_deref(), Some(LABEL));

        // Byte-for-byte what e2fsdroid wrote for /system/build.prop on Google's image: extra_isize
        // 32, the magic, one entry (name_len 7, index 6, value at 64, size 26, hash 0), "selinux",
        // the terminator, and the value packed against the end of the inode.
        let raw = after.raw_inode(ino).unwrap();
        assert_eq!(u16le(&raw, 0x80), 32);
        let mut expected = vec![0u8; 96];
        put_u32le(&mut expected, 0, 0xea020000);
        expected[4] = 7;
        expected[5] = 6;
        put_u16le(&mut expected, 6, 64);
        put_u32le(&mut expected, 12, 26);
        expected[20..27].copy_from_slice(b"selinux");
        expected[68..68 + LABEL.len()].copy_from_slice(LABEL.as_bytes());
        assert_eq!(raw[160..256], expected[..]);
    }

    #[test]
    fn allocates_from_a_block_uninit_group_and_an_inode_uninit_group_correctly() {
        let mut buffer = fresh();
        // More than any initialised group has free in one run, so it has to come from an
        // uninitialised one.
        let big = bytes(b'Z', 1015 * BS);
        {
            let mut volume = open(&mut buffer);
            let ino = volume.create_file("/system/media/big.bin", &big, label()).unwrap();
            let extent = volume.extents(ino).unwrap().extents[0];
            assert_eq!(extent.length, 1015);
            // Groups 1, 2 and 4 are the BLOCK_UNINIT ones in the fixture.
            let group = extent.start / 1024;
            assert!([1, 2, 4].contains(&group), "landed in group {group}");

            // Group 3 has 55 free inodes; the 56th onward come from INODE_UNINIT groups.
            volume.mkdir("/system/media/lots", dir_label()).unwrap();
            let inodes: Vec<u32> = (0..60)
                .map(|i| volume.create_file(&format!("/system/media/lots/f{i}"), &[], label()).unwrap())
                .collect();
            assert!(inodes.iter().any(|&n| (n - 1) / 96 >= 4), "expected some inodes from groups 4-5");
            volume.flush().unwrap();
        }

        let after = verified(&mut buffer);
        assert_eq!(after.read_file("/system/media/big.bin").unwrap(), big);
        assert_eq!(after.read_dir("/system/media/lots").unwrap().len(), 62);
    }

    #[test]
    fn a_directory_grows_by_a_block_when_its_entries_no_longer_fit() {
        let mut buffer = fresh();
        let long = "n".repeat(190);
        {
            let mut volume = open(&mut buffer);
            volume.mkdir("/system/media/wide", dir_label()).unwrap();
            for i in 0..40 {
                volume.create_file(&format!("/system/media/wide/{i:03}-{long}"), i.to_string().as_bytes(), label()).unwrap();
            }
            volume.flush().unwrap();
        }
        let after = verified(&mut buffer);
        let dir = after.lookup("/system/media/wide").unwrap().unwrap();
        assert!(after.stat(dir).unwrap().size > BS as u64, "directory should span more than one block");
        assert_eq!(after.read_dir_ino(dir).unwrap().len(), 42);
        assert_eq!(after.read_file(&format!("/system/media/wide/007-{long}")).unwrap(), b"7");
    }

    #[test]
    fn replace_rewrites_an_exclusively_owned_file_in_place_and_keeps_its_label() {
        let mut buffer = fresh();
        let (ino, before, free_before) = {
            let mut volume = open(&mut buffer);
            let ino = volume.lookup("/system/build.prop").unwrap().unwrap();
            let before = volume.extents(ino).unwrap().extents[0];
            let free_before = volume.free_blocks();
            volume.replace_file("/system/build.prop", b"ro.build.display.id=openemu\n").unwrap();
            volume.flush().unwrap();
            (ino, before, free_before)
        };

        let after = verified(&mut buffer);
        assert_eq!(after.lookup("/system/build.prop").unwrap(), Some(ino));
        assert_eq!(after.read_file_ino(ino).unwrap(), b"ro.build.display.id=openemu\n");
        assert_eq!(after.extents(ino).unwrap().extents[0].start, before.start, "should have been written in place");
        assert_eq!(after.free_blocks(), free_before, "in place allocates nothing");
        assert_eq!(after.selinux_label(ino).unwrap().as_deref(), Some(LABEL));
    }

    #[test]
    fn replace_reallocates_when_the_content_grows_and_never_writes_a_shared_block() {
        let mut buffer = fresh();
        let grown = bytes(b'g', 3 * BS + 10);
        // Shared.apk's blocks also back Bloat.apk: replacing it must leave Bloat.apk's bytes alone.
        let replacement = bytes(b'R', 2 * BS);
        {
            let mut volume = open(&mut buffer);
            volume.replace_file("/system/build.prop", &grown).unwrap();
            volume.replace_file("/system/app/Keep/Shared.apk", &replacement).unwrap();
            volume.flush().unwrap();
        }
        let after = verified(&mut buffer);
        assert_eq!(after.read_file("/system/build.prop").unwrap(), grown);
        assert_eq!(after.read_file("/system/app/Keep/Shared.apk").unwrap(), replacement);
        assert_eq!(after.read_file("/system/app/Bloat/Bloat.apk").unwrap(), bytes(b'B', 3 * BS));
    }

    #[test]
    fn backup_superblocks_and_descriptor_tables_follow_the_primary() {
        let mut buffer = fresh();
        {
            let mut volume = open(&mut buffer);
            volume.remove_tree("/system/app/Bloat").unwrap();
            volume.flush().unwrap();
        }
        let primary = buffer[1024..2048].to_vec();
        for group in [1usize, 3, 5] {
            let backup = &buffer[group * 1024 * BS..group * 1024 * BS + 1024];
            assert_eq!(usize::from(u16le(backup, 0x5a)), group, "group {group} records its own number");
            assert_eq!(u32le(backup, 0x0c), u32le(&primary, 0x0c), "group {group} free blocks");
            assert_eq!(u32le(backup, 0x10), u32le(&primary, 0x10), "group {group} free inodes");
            let table = (group * 1024 + 1) * BS;
            assert_eq!(buffer[table..table + 6 * 32], buffer[BS..BS + 6 * 32]);
        }
    }

    #[test]
    fn the_same_edits_on_the_same_input_produce_the_same_bytes() {
        let run = || {
            let mut buffer = fresh();
            {
                let mut volume =
                    Ext4Volume::open(BufferDisk::new(&mut buffer), OpenOptions { writable: true, epoch: 1234567890 }).unwrap();
                volume.remove_tree("/system/app/Bloat").unwrap();
                volume.replace_file("/system/build.prop", b"x=1\n").unwrap();
                volume.mkdir("/system/media/openemu", dir_label()).unwrap();
                volume.create_file("/system/media/openemu/a", &bytes(b'a', 5000), label()).unwrap();
                volume.flush().unwrap();
            }
            buffer
        };
        assert!(run() == run());
    }

    #[test]
    fn refuses_what_it_cannot_do_safely() {
        let mut buffer = fresh();
        let mut volume = open(&mut buffer);
        assert!(message(volume.create_file("/system/etc/many/new.txt", b"x", label())).contains("hashed"));
        assert!(message(volume.create_file("/system/build.prop", b"x", label())).contains("already exists"));
        assert!(message(volume.create_file("/system/media/x", b"x", NewInodeOptions::new(0o644, ""))).contains("selinux"));
        assert!(message(volume.remove_tree("/")).contains("root"));
        assert!(message(volume.remove_tree("/system/../system")).contains("normalised"));

        let mut other = fresh();
        let mut read_only = open_read_only(&mut other);
        assert!(message(read_only.remove_tree("/system/app/Bloat")).contains("read-only"));
    }

    #[test]
    fn refuses_volumes_with_features_outside_the_stock_set() {
        let with_feature = |offset: usize, bit: u32| {
            let mut buffer = fresh();
            let value = u32le(&buffer, 1024 + offset) | bit;
            put_u32le(&mut buffer, 1024 + offset, value);
            buffer
        };
        let refusal = |mut buffer: Vec<u8>| match Ext4Volume::open(BufferDisk::new(&mut buffer), OpenOptions::default()) {
            Ok(_) => panic!("expected a refusal"),
            Err(error) => error.0,
        };
        assert!(refusal(with_feature(0x60, 0x80)).contains("64bit"));
        assert!(refusal(with_feature(0x5c, 0x4)).contains("has_journal"));
        assert!(refusal(with_feature(0x64, 0x400)).contains("metadata_csum"));

        let mut orphaned = fresh();
        put_u32le(&mut orphaned, 1024 + 0xe8, 12);
        assert!(refusal(orphaned).contains("orphan"));

        let mut damaged = fresh();
        damaged[BS + 0x0c] ^= 0xff;
        assert!(refusal(damaged).contains("checksum"));
    }

    #[test]
    fn a_file_window_keeps_every_access_inside_the_partition() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("disk.img");
        {
            let mut file = std::fs::File::create(&path).unwrap();
            // The volume sits 1 MiB into the file, like a partition inside system.img.
            file.write_all(&vec![0xaa; 1024 * 1024]).unwrap();
            file.write_all(&FIXTURE).unwrap();
        }
        let file = std::fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();
        let volume = Ext4Volume::open(FileDisk::new(&file, 1024 * 1024, FIXTURE.len() as u64, true), OpenOptions::writable())
            .unwrap();
        assert_eq!(volume.read_file("/system/build.prop.link").unwrap(), b"/system/build.prop");

        let mut disk = FileDisk::new(&file, 1024 * 1024, FIXTURE.len() as u64, true);
        assert!(disk.write(FIXTURE.len() as u64 - 1, &[0, 0]).unwrap_err().0.contains("outside"));
        assert!(disk.read(FIXTURE.len() as u64, 1).unwrap_err().0.contains("outside"));
    }

    #[test]
    fn crc16_matches_the_reference_check_value() {
        // CRC-16/ARC of "123456789" with an initial value of 0 is 0xbb3d.
        assert_eq!(crc16(0, b"123456789"), 0xbb3d);
    }
}
