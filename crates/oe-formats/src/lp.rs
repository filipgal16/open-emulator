//! Android dynamic partitions — liblp metadata, format 10.x — read from the `super` partition.
//!
//! `system`, `system_ext`, `product` and `vendor` are not GPT partitions. They are regions of
//! `super` that first-stage init maps with device-mapper from this metadata, and the ROM builder
//! edits each one as a bounded window onto the image file. A wrong window means ext4 edits land in
//! the neighbouring volume or on the metadata itself, so everything is SHA-256-checked the way liblp
//! checks it before a single offset is used.
//!
//! Anything a single window cannot represent is refused by name rather than approximated: a
//! partition in several pieces, a zero-fill or non-linear target, an extent on a block device other
//! than `super`, and A/B slot suffixes (the emulator is a single-slot device; a suffixed partition
//! means a different image from the one this was measured on).
//!
//! Layout, from liblp's `metadata_format.h`: 4 KiB reserved, the geometry and its backup in 4 KiB
//! each, then `metadata_slot_count` primary metadata copies of `metadata_max_size` bytes, then as
//! many backups. Extents are always in 512-byte sectors, whatever `logical_block_size` says.

use sha2::{Digest, Sha256};

use crate::bytes::{c_string, hex32, u16le, u32le, u64le};
use crate::{fail, ReadAt, Result, MAX_SAFE_INTEGER};

const LP_SECTOR_SIZE: u64 = 512;
const RESERVED_BYTES: u64 = 4096;
const GEOMETRY_SLOT_BYTES: u64 = 4096;
const GEOMETRY_OFFSET: u64 = RESERVED_BYTES;
const BACKUP_GEOMETRY_OFFSET: u64 = RESERVED_BYTES + GEOMETRY_SLOT_BYTES;
const METADATA_OFFSET: u64 = RESERVED_BYTES + 2 * GEOMETRY_SLOT_BYTES;

const GEOMETRY_MAGIC: u32 = 0x616c4467;
const GEOMETRY_STRUCT_SIZE: u32 = 52;

const HEADER_MAGIC: u32 = 0x414c5030;
const MAJOR_VERSION: u16 = 10;
const MINOR_VERSION_MAX: u16 = 2;
/// Minor 0 and 1 have a 128-byte header; minor 2 expanded it to 256 (adding header flags).
const HEADER_SIZE_V1_0: u32 = 128;
const HEADER_SIZE_V1_2: u32 = 256;

pub const LP_PARTITION_ATTR_READONLY: u32 = 0x1;
pub const LP_PARTITION_ATTR_SLOT_SUFFIXED: u32 = 0x2;
const LP_PARTITION_ATTR_UPDATED: u32 = 0x4;
const LP_PARTITION_ATTR_DISABLED: u32 = 0x8;
/// The attribute bits each minor version defines; liblp refuses any others, and so does this.
const ATTRIBUTE_MASK_V0: u32 = LP_PARTITION_ATTR_READONLY | LP_PARTITION_ATTR_SLOT_SUFFIXED;
const ATTRIBUTE_MASK_V1: u32 = ATTRIBUTE_MASK_V0 | LP_PARTITION_ATTR_UPDATED | LP_PARTITION_ATTR_DISABLED;

const TARGET_TYPE_LINEAR: u32 = 0;
const TARGET_TYPE_ZERO: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogicalPartition {
    pub name: String,
    pub attributes: u32,
    /// Bytes from the start of `super`. 0 for a partition with no extents.
    pub offset: u64,
    /// Bytes. 0 for a partition with no extents.
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataSource {
    Primary,
    Backup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LpMetadata {
    pub partitions: Vec<LogicalPartition>,
    pub slot_count: u32,
    pub metadata_max_size: u32,
    /// Which metadata copy was used.
    pub source: MetadataSource,
    /// Why any copy (geometry or metadata) tried before the one used was rejected. Empty on a
    /// healthy image; anything here is worth a log line, because the guest's liblp is falling back
    /// too.
    pub skipped: Vec<String>,
}

struct Geometry {
    metadata_max_size: u32,
    slot_count: u32,
}

#[derive(Clone, Copy)]
struct TableDescriptor {
    offset: u32,
    count: u32,
    entry_size: u32,
}

struct ValidatedMetadata {
    minor: u16,
    tables: Vec<u8>,
    partitions: TableDescriptor,
    extents: TableDescriptor,
    groups: TableDescriptor,
    block_devices: TableDescriptor,
}

impl ValidatedMetadata {
    fn entry(&self, table: TableDescriptor, index: u32) -> &[u8] {
        let start = (table.offset + index * table.entry_size) as usize;
        &self.tables[start..start + table.entry_size as usize]
    }
}

/// Reads the partition table out of `super`.
///
/// `read` is relative to the start of `super`; `super_size` is its size in bytes (from the GPT),
/// which every extent must fit inside. Tries the primary copy of slot 0, then the backup. A copy
/// that fails its checksums is skipped with its reason kept; if none validates, every reason is
/// returned. A copy that validates but describes something unsupported is refused outright — the
/// backup of a valid table is not a second opinion.
pub fn read_lp_metadata<R: ReadAt + ?Sized>(read: &mut R, super_size: u64) -> Result<LpMetadata> {
    if super_size == 0 || super_size > MAX_SAFE_INTEGER {
        fail!("super size {super_size} is not a positive byte count");
    }

    let mut read_exactly = |offset: u64, length: u64, what: &str| -> Result<Vec<u8>> {
        if offset + length > super_size {
            fail!("{what} at [{offset}, +{length}) lies outside super ({super_size} bytes)");
        }
        let data = read.read_at(offset, length as usize)?;
        if data.len() as u64 != length {
            fail!("short read of {what}: {} of {length} bytes at offset {offset}", data.len());
        }
        Ok(data)
    };

    let mut skipped = Vec::new();
    let geometry = read_geometry(&mut read_exactly, super_size, &mut skipped)?;
    let metadata_max_size = u64::from(geometry.metadata_max_size);
    let slot_count = u64::from(geometry.slot_count);

    // The metadata area ends after every slot's primary and backup copy; logical data starts after.
    let metadata_end = METADATA_OFFSET + 2 * metadata_max_size * slot_count;

    let copies = [
        (MetadataSource::Primary, "primary slot 0", METADATA_OFFSET),
        (MetadataSource::Backup, "backup slot 0", METADATA_OFFSET + metadata_max_size * slot_count),
    ];

    let mut failures = Vec::new();
    for (source, label, offset) in copies {
        let validated = read_exactly(offset, metadata_max_size, &format!("LP metadata {label}"))
            .and_then(|slot| validate_metadata(&slot, geometry.metadata_max_size, label));
        let metadata = match validated {
            Ok(metadata) => metadata,
            Err(error) => {
                failures.push(error.0);
                continue;
            }
        };
        let partitions = resolve_partitions(&metadata, super_size, metadata_end)?;
        skipped.extend(failures);
        return Ok(LpMetadata {
            partitions,
            slot_count: geometry.slot_count,
            metadata_max_size: geometry.metadata_max_size,
            source,
            skipped,
        });
    }

    fail!("no valid LP metadata in super: {}", failures.join("; "))
}

/// The logical partition called `name`. Names are unique — [`read_lp_metadata`] refuses
/// duplicates.
pub fn find_logical<'a>(parts: &'a [LogicalPartition], name: &str) -> Result<&'a LogicalPartition> {
    match parts.iter().find(|part| part.name == name) {
        Some(found) => Ok(found),
        None => {
            let names = if parts.is_empty() {
                "none".to_owned()
            } else {
                parts.iter().map(|part| format!("\"{}\"", part.name)).collect::<Vec<_>>().join(", ")
            };
            fail!("no logical partition named \"{name}\" in super (partitions: {names})")
        }
    }
}

// ── Geometry ────────────────────────────────────────────────────────────────────────────────────

/// The primary geometry, or the backup if the primary fails its checks — as liblp reads it.
fn read_geometry(
    read: &mut impl FnMut(u64, u64, &str) -> Result<Vec<u8>>,
    super_size: u64,
    skipped: &mut Vec<String>,
) -> Result<Geometry> {
    let mut failures = Vec::new();
    for (label, offset) in [("primary", GEOMETRY_OFFSET), ("backup", BACKUP_GEOMETRY_OFFSET)] {
        let attempt = read(offset, u64::from(GEOMETRY_STRUCT_SIZE), &format!("LP {label} geometry"))
            .and_then(|raw| parse_geometry(&raw, label))
            .and_then(|geometry| {
                let metadata_end = METADATA_OFFSET
                    + 2 * u64::from(geometry.metadata_max_size) * u64::from(geometry.slot_count);
                if metadata_end > super_size {
                    fail!(
                        "LP {label} geometry puts {} slots of {} bytes (twice) past the end of super ({super_size} bytes)",
                        geometry.slot_count,
                        geometry.metadata_max_size
                    );
                }
                Ok(geometry)
            });
        match attempt {
            Ok(geometry) => {
                skipped.extend(failures);
                return Ok(geometry);
            }
            Err(error) => failures.push(error.0),
        }
    }
    fail!("no valid LP geometry in super: {}", failures.join("; "))
}

fn parse_geometry(raw: &[u8], label: &str) -> Result<Geometry> {
    let magic = u32le(raw, 0);
    if magic != GEOMETRY_MAGIC {
        fail!("LP {label} geometry magic is {}, expected {}", hex32(magic), hex32(GEOMETRY_MAGIC));
    }
    let struct_size = u32le(raw, 4);
    if struct_size != GEOMETRY_STRUCT_SIZE {
        fail!("LP {label} geometry struct_size is {struct_size}, expected {GEOMETRY_STRUCT_SIZE}");
    }
    if !checksum_matches(&raw[..struct_size as usize], 8) {
        fail!("LP {label} geometry checksum mismatch");
    }

    let metadata_max_size = u32le(raw, 40);
    let slot_count = u32le(raw, 44);
    if slot_count == 0 {
        fail!("LP {label} geometry has no metadata slots");
    }
    if metadata_max_size < HEADER_SIZE_V1_0 || u64::from(metadata_max_size) % LP_SECTOR_SIZE != 0 {
        fail!(
            "LP {label} geometry metadata_max_size {metadata_max_size} is not a whole number of sectors large enough for a header"
        );
    }
    Ok(Geometry { metadata_max_size, slot_count })
}

// ── Metadata ────────────────────────────────────────────────────────────────────────────────────

/// Checks one metadata copy the way liblp's reader does: magic and version, header checksum before
/// any other header field is believed, then the tables' checksum and every table's bounds.
fn validate_metadata(slot: &[u8], metadata_max_size: u32, label: &str) -> Result<ValidatedMetadata> {
    let magic = u32le(slot, 0);
    if magic != HEADER_MAGIC {
        fail!("LP metadata header magic in {label} is {}, expected {}", hex32(magic), hex32(HEADER_MAGIC));
    }
    let major = u16le(slot, 4);
    let minor = u16le(slot, 6);
    if major != MAJOR_VERSION || minor > MINOR_VERSION_MAX {
        fail!(
            "LP metadata version in {label} is {major}.{minor}; only {MAJOR_VERSION}.0 to {MAJOR_VERSION}.{MINOR_VERSION_MAX} are understood"
        );
    }
    let header_size = u32le(slot, 8);
    let expected_header_size = if minor >= 2 { HEADER_SIZE_V1_2 } else { HEADER_SIZE_V1_0 };
    if header_size != expected_header_size {
        fail!("LP metadata header_size in {label} is {header_size}; version {major}.{minor} uses {expected_header_size}");
    }
    if header_size > metadata_max_size {
        fail!("LP metadata header in {label} ({header_size} bytes) does not fit the {metadata_max_size}-byte slot");
    }
    if !checksum_matches(&slot[..header_size as usize], 12) {
        fail!("LP metadata header checksum mismatch in {label}");
    }

    let tables_size = u32le(slot, 44);
    if u64::from(header_size) + u64::from(tables_size) > u64::from(metadata_max_size) {
        fail!(
            "LP metadata tables in {label} ({tables_size} bytes after a {header_size}-byte header) overrun the {metadata_max_size}-byte slot"
        );
    }
    let tables = slot[header_size as usize..(header_size + tables_size) as usize].to_vec();
    let tables_checksum = Sha256::digest(&tables);
    if tables_checksum.as_slice() != &slot[48..80] {
        fail!("LP metadata tables checksum mismatch in {label}");
    }

    let descriptor = |at: usize, what: &str, expected: u32| -> Result<TableDescriptor> {
        let table = TableDescriptor {
            offset: u32le(slot, at),
            count: u32le(slot, at + 4),
            entry_size: u32le(slot, at + 8),
        };
        if table.entry_size != expected {
            fail!("LP {what} table in {label} has {}-byte entries, expected {expected}", table.entry_size);
        }
        if u64::from(table.offset) + u64::from(table.count) * u64::from(table.entry_size) > u64::from(tables_size) {
            fail!(
                "LP {what} table in {label} ({} entries at {}) overruns the {tables_size}-byte tables area",
                table.count,
                table.offset
            );
        }
        Ok(table)
    };

    Ok(ValidatedMetadata {
        minor,
        partitions: descriptor(80, "partitions", 52)?,
        extents: descriptor(92, "extents", 24)?,
        groups: descriptor(104, "groups", 48)?,
        block_devices: descriptor(116, "blockDevices", 64)?,
        tables,
    })
}

/// Turns validated tables into byte windows, refusing anything one window cannot describe.
fn resolve_partitions(metadata: &ValidatedMetadata, super_size: u64, metadata_end: u64) -> Result<Vec<LogicalPartition>> {
    if metadata.block_devices.count == 0 {
        fail!("LP metadata lists no block devices, not even super");
    }
    let super_device = metadata.entry(metadata.block_devices, 0);
    let data_start = u128::from(u64le(super_device, 0)) * u128::from(LP_SECTOR_SIZE);
    if data_start < u128::from(metadata_end) {
        fail!(
            "LP block device \"{}\" starts its data at byte {data_start}, inside the metadata area that ends at {metadata_end}",
            c_string(&super_device[24..60])
        );
    }

    let valid_attributes = if metadata.minor >= 1 { ATTRIBUTE_MASK_V1 } else { ATTRIBUTE_MASK_V0 };
    let mut seen = std::collections::HashSet::new();
    let mut partitions = Vec::new();

    for i in 0..metadata.partitions.count {
        let raw = metadata.entry(metadata.partitions, i);
        let name = c_string(&raw[..36]);
        if name.is_empty() {
            fail!("LP partition {i} has an empty name");
        }
        let label = format!("LP partition \"{name}\"");

        if !seen.insert(name.clone()) {
            fail!("{label} is listed twice in the metadata");
        }

        let attributes = u32le(raw, 36);
        let first_extent = u32le(raw, 40);
        let num_extents = u32le(raw, 44);
        let group_index = u32le(raw, 48);

        if attributes & !valid_attributes != 0 {
            fail!(
                "{label} has attribute bits {} that metadata version 10.{} does not define",
                hex32(attributes & !valid_attributes),
                metadata.minor
            );
        }
        if attributes & LP_PARTITION_ATTR_SLOT_SUFFIXED != 0 {
            fail!("{label} is SLOT_SUFFIXED — an A/B layout, not the single-slot emulator image this reads");
        }
        if group_index >= metadata.groups.count {
            fail!("{label} is in group {group_index}, but the metadata has {} groups", metadata.groups.count);
        }
        if u64::from(first_extent) + u64::from(num_extents) > u64::from(metadata.extents.count) {
            fail!(
                "{label} claims {num_extents} extents from index {first_extent}, but the metadata has {}",
                metadata.extents.count
            );
        }
        if num_extents > 1 {
            fail!("{label} has {num_extents} extents; only a single linear extent can be edited as one window");
        }
        if num_extents == 0 {
            partitions.push(LogicalPartition { name, attributes, offset: 0, size: 0 });
            continue;
        }

        let extent = metadata.entry(metadata.extents, first_extent);
        let sectors = u64le(extent, 0);
        let target_type = u32le(extent, 8);
        let target_data = u64le(extent, 12);
        let target_source = u32le(extent, 20);

        if target_type != TARGET_TYPE_LINEAR {
            let kind = if target_type == TARGET_TYPE_ZERO { "a zero-fill".to_owned() } else { format!("a type {target_type}") };
            fail!("{label} is {kind} extent; only linear extents map to bytes in super");
        }
        if target_source != 0 {
            fail!("{label} lives on block device {target_source}, not on super (device 0)");
        }

        let start = u128::from(target_data) * u128::from(LP_SECTOR_SIZE);
        let end = start + u128::from(sectors) * u128::from(LP_SECTOR_SIZE);
        if end > u128::from(super_size) {
            fail!("{label} extent [{start}, {end}) reaches past the end of super ({super_size} bytes)");
        }
        if start < data_start {
            fail!("{label} starts at byte {start}, inside the LP metadata area (logical data begins at {data_start})");
        }

        partitions.push(LogicalPartition { name, attributes, offset: start as u64, size: (end - start) as u64 });
    }

    // Two windows over the same bytes would let an edit to one volume corrupt the other.
    let mut placed: Vec<&LogicalPartition> = partitions.iter().filter(|part| part.size > 0).collect();
    placed.sort_by_key(|part| part.offset);
    for pair in placed.windows(2) {
        let (previous, current) = (pair[0], pair[1]);
        if current.offset < previous.offset + previous.size {
            fail!(
                "LP partitions \"{}\" [{}, {}) and \"{}\" [{}, {}) overlap",
                previous.name,
                previous.offset,
                previous.offset + previous.size,
                current.name,
                current.offset,
                current.offset + current.size
            );
        }
    }

    Ok(partitions)
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/// SHA-256 of `structure` with the 32-byte checksum field at `at` zeroed, compared with that field.
fn checksum_matches(structure: &[u8], at: usize) -> bool {
    let mut zeroed = structure.to_vec();
    zeroed[at..at + 32].fill(0);
    Sha256::digest(&zeroed).as_slice() == &structure[at..at + 32]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::{put_u16le, put_u32le, put_u64le};

    /// `super` of Google's API 30 image, as measured: size, and each volume's byte offset and size.
    const SUPER_SIZE: u64 = 3229614080;
    const REAL: [(&str, u64, u64); 4] = [
        ("system", 1048576, 1078669312),
        ("system_ext", 1080033280, 106766336),
        ("product", 1186988032, 264716288),
        ("vendor", 1452277760, 67837952),
    ];

    const PRIMARY: usize = 12288;
    const MAX_SIZE: usize = 65536;
    const SLOTS: usize = 2;
    const BACKUP: usize = PRIMARY + MAX_SIZE * SLOTS;

    #[derive(Clone)]
    struct Extent {
        sectors: u64,
        data: u64,
        kind: u32,
        source: u32,
    }

    #[derive(Clone)]
    struct Part {
        name: String,
        attributes: u32,
        extents: Vec<Extent>,
    }

    fn extent(sectors: u64, data: u64) -> Extent {
        Extent { sectors, data, kind: 0, source: 0 }
    }

    fn real_partitions() -> Vec<Part> {
        REAL.iter()
            .map(|&(name, offset, size)| Part { name: name.into(), attributes: 1, extents: vec![extent(size / 512, offset / 512)] })
            .collect()
    }

    struct Build {
        partitions: Vec<Part>,
        metadata_max_size: usize,
        slot_count: usize,
        logical_block_size: u32,
        minor: u16,
        first_logical_sector: u64,
    }

    impl Default for Build {
        fn default() -> Self {
            Build {
                partitions: real_partitions(),
                metadata_max_size: MAX_SIZE,
                slot_count: SLOTS,
                logical_block_size: 4096,
                minor: 0,
                first_logical_sector: 2048,
            }
        }
    }

    fn sha256(data: &[u8]) -> Vec<u8> {
        Sha256::digest(data).to_vec()
    }

    /// The metadata area of a `super` partition, built the way lpmake writes it: geometry and its
    /// backup, then every slot's primary copy, then every slot's backup, with real SHA-256
    /// checksums. Only the metadata is materialised — the logical partitions' bytes are never read.
    fn build_super(build: Build) -> Vec<u8> {
        let mut buffer = vec![0u8; PRIMARY + 2 * build.metadata_max_size * build.slot_count];

        let mut geometry = vec![0u8; 52];
        put_u32le(&mut geometry, 0, 0x616c4467);
        put_u32le(&mut geometry, 4, 52);
        put_u32le(&mut geometry, 40, build.metadata_max_size as u32);
        put_u32le(&mut geometry, 44, build.slot_count as u32);
        put_u32le(&mut geometry, 48, build.logical_block_size);
        let checksum = sha256(&geometry);
        geometry[8..40].copy_from_slice(&checksum);
        buffer[4096..4096 + 52].copy_from_slice(&geometry);
        buffer[8192..8192 + 52].copy_from_slice(&geometry);

        let mut partition_table = vec![0u8; 52 * build.partitions.len()];
        let mut extents: Vec<Extent> = Vec::new();
        for (i, part) in build.partitions.iter().enumerate() {
            let entry = &mut partition_table[i * 52..(i + 1) * 52];
            entry[..part.name.len()].copy_from_slice(part.name.as_bytes());
            put_u32le(entry, 36, part.attributes);
            put_u32le(entry, 40, extents.len() as u32);
            put_u32le(entry, 44, part.extents.len() as u32);
            put_u32le(entry, 48, 0);
            extents.extend(part.extents.iter().cloned());
        }

        let mut extent_table = vec![0u8; 24 * extents.len()];
        for (i, extent) in extents.iter().enumerate() {
            put_u64le(&mut extent_table, i * 24, extent.sectors);
            put_u32le(&mut extent_table, i * 24 + 8, extent.kind);
            put_u64le(&mut extent_table, i * 24 + 12, extent.data);
            put_u32le(&mut extent_table, i * 24 + 20, extent.source);
        }

        let mut group_table = vec![0u8; 48];
        group_table[..7].copy_from_slice(b"default");

        let mut device_table = vec![0u8; 64];
        put_u64le(&mut device_table, 0, build.first_logical_sector);
        put_u32le(&mut device_table, 8, 1048576);
        put_u64le(&mut device_table, 16, SUPER_SIZE);
        device_table[24..29].copy_from_slice(b"super");

        let tables = [partition_table.clone(), extent_table.clone(), group_table.clone(), device_table].concat();
        let header_size = if build.minor >= 2 { 256 } else { 128 };
        let mut header = vec![0u8; header_size];
        put_u32le(&mut header, 0, 0x414c5030);
        put_u16le(&mut header, 4, 10);
        put_u16le(&mut header, 6, build.minor);
        put_u32le(&mut header, 8, header_size as u32);
        put_u32le(&mut header, 44, tables.len() as u32);
        header[48..80].copy_from_slice(&sha256(&tables));
        let mut descriptor = |at: usize, offset: usize, count: usize, size: u32| {
            put_u32le(&mut header, at, offset as u32);
            put_u32le(&mut header, at + 4, count as u32);
            put_u32le(&mut header, at + 8, size);
        };
        descriptor(80, 0, build.partitions.len(), 52);
        descriptor(92, partition_table.len(), extents.len(), 24);
        descriptor(104, partition_table.len() + extent_table.len(), 1, 48);
        descriptor(116, partition_table.len() + extent_table.len() + group_table.len(), 1, 64);
        let checksum = sha256(&header);
        header[12..44].copy_from_slice(&checksum);

        let slot = [header, tables].concat();
        for s in 0..build.slot_count {
            let primary = PRIMARY + s * build.metadata_max_size;
            let backup = PRIMARY + (build.slot_count + s) * build.metadata_max_size;
            buffer[primary..primary + slot.len()].copy_from_slice(&slot);
            buffer[backup..backup + slot.len()].copy_from_slice(&slot);
        }
        buffer
    }

    fn read(mut buffer: Vec<u8>) -> Result<LpMetadata> {
        read_lp_metadata(&mut buffer, SUPER_SIZE)
    }

    fn message<T: std::fmt::Debug>(result: Result<T>) -> String {
        result.expect_err("expected a refusal").to_string()
    }

    fn with_system(change: impl Fn(&mut Part)) -> Vec<Part> {
        let mut parts = real_partitions();
        for part in &mut parts {
            if part.name == "system" {
                change(part);
            }
        }
        parts
    }

    #[test]
    fn reads_the_four_volumes_at_their_measured_offsets() {
        let metadata = read(build_super(Build::default())).unwrap();

        assert_eq!(metadata.slot_count, SLOTS as u32);
        assert_eq!(metadata.metadata_max_size, MAX_SIZE as u32);
        assert_eq!(metadata.source, MetadataSource::Primary);
        assert!(metadata.skipped.is_empty());
        let expected: Vec<LogicalPartition> = REAL
            .iter()
            .map(|&(name, offset, size)| LogicalPartition { name: name.into(), attributes: 1, offset, size })
            .collect();
        assert_eq!(metadata.partitions, expected);
        // 2 MiB is where super starts in system.img; the design's table is in file offsets.
        assert_eq!(2097152 + find_logical(&metadata.partitions, "system").unwrap().offset, 3145728);
    }

    #[test]
    fn extents_are_512_byte_sectors_whatever_logical_block_size_says() {
        // The geometry's 4096-byte logical block is the allocation granule, not the extent unit.
        // Using it would put every volume eight times further in.
        let metadata = read(build_super(Build { logical_block_size: 4096, ..Build::default() })).unwrap();
        assert_eq!(find_logical(&metadata.partitions, "system").unwrap().offset, 2048 * 512);
    }

    #[test]
    fn the_expanded_10_2_header_is_read_too() {
        assert_eq!(read(build_super(Build { minor: 2, ..Build::default() })).unwrap().partitions.len(), 4);
    }

    #[test]
    fn a_corrupt_primary_header_falls_back_to_the_backup_and_says_so() {
        let mut buffer = build_super(Build::default());
        buffer[PRIMARY + 44] ^= 0x01; // tables_size, covered by the header checksum

        let metadata = read(buffer).unwrap();
        assert_eq!(metadata.source, MetadataSource::Backup);
        assert_eq!(metadata.partitions.len(), 4);
        assert!(metadata.skipped.join("\n").contains("header checksum mismatch in primary slot 0"));
    }

    #[test]
    fn corrupt_primary_tables_fall_back_to_the_backup() {
        let mut buffer = build_super(Build::default());
        buffer[PRIMARY + 128] ^= 0x01; // first letter of "system"

        let metadata = read(buffer).unwrap();
        assert_eq!(metadata.source, MetadataSource::Backup);
        assert_eq!(find_logical(&metadata.partitions, "system").unwrap().size, 1078669312);
        assert!(metadata.skipped.join("\n").contains("tables checksum mismatch in primary slot 0"));
    }

    #[test]
    fn both_copies_corrupt_reports_both_reasons() {
        let mut buffer = build_super(Build::default());
        buffer[PRIMARY + 44] ^= 0x01;
        buffer[BACKUP + 128] ^= 0x01;

        let text = message(read(buffer));
        let first = text.find("header checksum mismatch in primary slot 0").expect(&text);
        let second = text.find("tables checksum mismatch in backup slot 0").expect(&text);
        assert!(first < second);
    }

    #[test]
    fn a_corrupt_primary_geometry_falls_back_to_the_backup_geometry() {
        let mut buffer = build_super(Build::default());
        buffer[4096 + 40] ^= 0x01; // metadata_max_size

        let metadata = read(buffer).unwrap();
        assert_eq!(metadata.metadata_max_size, MAX_SIZE as u32);
        assert!(metadata.skipped.join("\n").contains("primary geometry checksum mismatch"));
    }

    #[test]
    fn both_geometries_corrupt_is_refused() {
        let mut buffer = build_super(Build::default());
        buffer[4096 + 40] ^= 0x01;
        put_u32le(&mut buffer, 8192, 0);

        let text = message(read(buffer));
        let first = text.find("primary geometry checksum mismatch").expect(&text);
        let second = text.find("backup geometry magic").expect(&text);
        assert!(first < second);
    }

    #[test]
    fn a_partition_with_no_extents_is_returned_with_size_0() {
        let mut partitions = real_partitions();
        partitions.push(Part { name: "odm".into(), attributes: 1, extents: vec![] });

        let metadata = read(build_super(Build { partitions, ..Build::default() })).unwrap();
        assert_eq!(
            find_logical(&metadata.partitions, "odm").unwrap(),
            &LogicalPartition { name: "odm".into(), attributes: 1, offset: 0, size: 0 }
        );
    }

    #[test]
    fn a_missing_logical_partition_names_what_is_there() {
        let metadata = read(build_super(Build::default())).unwrap();
        let text = message(find_logical(&metadata.partitions, "odm"));
        assert!(text.starts_with("no logical partition named \"odm\"") && text.contains("\"vendor\""), "{text}");
    }

    // ── Refusals: each is a layout a single byte window cannot describe ─────────────────────────

    #[test]
    fn more_than_one_extent_is_refused() {
        let partitions = with_system(|part| part.extents = vec![extent(1024, 2048), extent(1024, 4096)]);
        assert!(message(read(build_super(Build { partitions, ..Build::default() }))).contains("\"system\" has 2 extents"));
    }

    #[test]
    fn a_zero_fill_extent_is_refused() {
        let partitions = with_system(|part| part.extents[0].kind = 1);
        assert!(message(read(build_super(Build { partitions, ..Build::default() })))
            .contains("\"system\" is a zero-fill extent"));
    }

    #[test]
    fn an_extent_on_another_block_device_is_refused() {
        let partitions = with_system(|part| part.extents[0].source = 1);
        assert!(message(read(build_super(Build { partitions, ..Build::default() })))
            .contains("\"system\" lives on block device 1"));
    }

    #[test]
    fn a_slot_suffixed_partition_is_refused() {
        let partitions = with_system(|part| part.attributes = 1 | 2);
        assert!(message(read(build_super(Build { partitions, ..Build::default() }))).contains("\"system\" is SLOT_SUFFIXED"));
    }

    #[test]
    fn attribute_bits_the_metadata_version_does_not_define_are_refused() {
        let partitions = with_system(|part| part.attributes = 1 | 0x10);
        assert!(message(read(build_super(Build { partitions, ..Build::default() })))
            .contains("\"system\" has attribute bits 0x00000010"));
    }

    #[test]
    fn a_duplicated_name_is_refused() {
        let mut partitions = real_partitions();
        partitions.push(Part { name: "vendor".into(), attributes: 1, extents: vec![] });
        assert!(message(read(build_super(Build { partitions, ..Build::default() }))).contains("\"vendor\" is listed twice"));
    }

    #[test]
    fn an_extent_reaching_past_the_end_of_super_is_refused() {
        let mut buffer = build_super(Build::default());
        let text = message(read_lp_metadata(&mut buffer, 1452277760 + 67837952 - 512));
        assert!(text.contains("\"vendor\" extent") && text.contains("reaches past the end of super"), "{text}");
    }

    #[test]
    fn overlapping_partitions_are_refused() {
        let mut partitions = real_partitions();
        let system_end = REAL[0].1 + REAL[0].2;
        partitions[1].extents[0].data = (system_end - 4096) / 512; // system_ext now starts 4 KiB inside system

        let text = message(read(build_super(Build { partitions, ..Build::default() })));
        assert!(text.contains("\"system\"") && text.contains("\"system_ext\"") && text.ends_with("overlap"), "{text}");
    }

    #[test]
    fn an_extent_inside_the_metadata_area_is_refused() {
        let partitions = with_system(|part| part.extents = vec![extent(8, 0)]);
        assert!(message(read(build_super(Build { partitions, ..Build::default() })))
            .contains("\"system\" starts at byte 0, inside the LP metadata area"));
    }
}
