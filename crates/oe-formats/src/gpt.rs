//! The GUID partition table of Google's emulator `system.img`.
//!
//! Since Android 10 the emulator's system image is not one ext4 volume but a whole disk: a GPT with
//! two partitions, `vbmeta` (the top-level AVB metadata) and `super` (the dynamic partitions). Every
//! byte the ROM builder writes lands at an offset derived from this table, so the table is checked
//! before it is believed. A header or entry array that fails its CRC means a truncated download, a
//! different image, or damage, and an offset read from it would aim the editor at the wrong bytes
//! of a 3 GB file, which fails at boot, far from the cause.
//!
//! Only the primary header is read. The builder never changes the table, so the backup at the end
//! of the disk cannot drift from it, and nothing here needs it.

use crate::bytes::{hex32, u16le, u32le, u64le};
use crate::{err, fail, ReadAt, Result, MAX_SAFE_INTEGER};

const SIGNATURE: &[u8; 8] = b"EFI PART";
const HEADER_LBA: u64 = 1;
/// UEFI's header is 92 bytes; `header_size` may be larger (and the CRC covers it), never smaller.
const MIN_HEADER_SIZE: u32 = 92;
const MIN_ENTRY_SIZE: u32 = 128;
/// The entry array's size comes from the header, so this bounds how much is read on its word. The
/// norm is 128 entries of 128 bytes (16 KiB); this is 64 times that.
const MAX_ENTRY_ARRAY_BYTES: u64 = 1024 * 1024;
const TYPE_GUID_BYTES: usize = 16;
const NAME_OFFSET: usize = 56;
/// 36 UTF-16 code units.
const NAME_BYTES: usize = 72;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GptPartition {
    pub name: String,
    /// Byte offset of the partition in the disk file.
    pub offset: u64,
    /// Bytes, `last_lba` included.
    pub size: u64,
    pub first_lba: u64,
    /// Inclusive, as GPT stores it.
    pub last_lba: u64,
}

/// Reads the primary GPT of a disk with 512-byte sectors. See [`read_gpt_with_sector_size`].
pub fn read_gpt<R: ReadAt + ?Sized>(read: &mut R) -> Result<Vec<GptPartition>> {
    read_gpt_with_sector_size(read, 512)
}

/// Reads the primary GPT and returns every used entry, in table order.
///
/// `read` is relative to the start of the disk. Refuses a missing signature, a header or entry
/// array whose CRC32 does not match, a header that is not the primary, entries outside the usable
/// range, and partitions that overlap, any of which means the offsets cannot be trusted to write
/// through.
pub fn read_gpt_with_sector_size<R: ReadAt + ?Sized>(read: &mut R, sector_size: u64) -> Result<Vec<GptPartition>> {
    if sector_size < 512 || !sector_size.is_power_of_two() {
        fail!("GPT sector size {sector_size} is not a power of two of at least 512");
    }

    let mut read_exactly = |offset: u64, length: u64, what: &str| -> Result<Vec<u8>> {
        let data = read.read_at(offset, length as usize)?;
        if data.len() as u64 != length {
            fail!("short read of the {what}: {} of {length} bytes at offset {offset}", data.len());
        }
        Ok(data)
    };

    let header = read_exactly(HEADER_LBA * sector_size, sector_size, "GPT header")?;
    if &header[0..8] != SIGNATURE {
        fail!("no GPT: LBA {HEADER_LBA} does not begin with \"EFI PART\" (sector size {sector_size})");
    }

    let header_size = u32le(&header, 12);
    if header_size < MIN_HEADER_SIZE || u64::from(header_size) > sector_size {
        fail!("GPT header size {header_size} is outside {MIN_HEADER_SIZE}..{sector_size}");
    }

    // The CRC is computed with its own field zeroed, over exactly header_size bytes.
    let stored_header_crc = u32le(&header, 16);
    let mut zeroed = header[..header_size as usize].to_vec();
    zeroed[16..20].fill(0);
    let header_crc = crc32fast::hash(&zeroed);
    if header_crc != stored_header_crc {
        fail!(
            "GPT header CRC32 mismatch: stored {}, computed {}",
            hex32(stored_header_crc),
            hex32(header_crc)
        );
    }

    let my_lba = safe_u64(&header, 24, "GPT header my_lba")?;
    if my_lba != HEADER_LBA {
        // A backup header copied into place, or a table written for a different sector size.
        fail!("GPT header at LBA {HEADER_LBA} says it lives at LBA {my_lba}");
    }

    let first_usable = safe_u64(&header, 40, "GPT first usable LBA")?;
    let last_usable = safe_u64(&header, 48, "GPT last usable LBA")?;
    if last_usable < first_usable {
        fail!("GPT usable range is empty: first usable LBA {first_usable}, last {last_usable}");
    }

    let entries_lba = safe_u64(&header, 72, "GPT partition entry LBA")?;
    let num_entries = u32le(&header, 80);
    let entry_size = u32le(&header, 84);
    let stored_entries_crc = u32le(&header, 88);

    if entry_size < MIN_ENTRY_SIZE || entry_size % 8 != 0 {
        fail!("GPT partition entry size {entry_size} is not a multiple of 8 of at least {MIN_ENTRY_SIZE}");
    }
    let array_bytes = u64::from(num_entries) * u64::from(entry_size);
    if array_bytes > MAX_ENTRY_ARRAY_BYTES {
        fail!(
            "GPT claims {num_entries} entries of {entry_size} bytes ({array_bytes} bytes); more than {MAX_ENTRY_ARRAY_BYTES} is not a real table"
        );
    }

    // The entry array must sit between the header and the first usable LBA, or a partition could
    // overlap the table that describes it.
    let array_sectors = array_bytes.div_ceil(sector_size);
    if entries_lba <= HEADER_LBA || (array_sectors > 0 && entries_lba + array_sectors - 1 >= first_usable) {
        fail!(
            "GPT partition entry array at LBA {entries_lba} ({array_sectors} sectors) overlaps the header or the usable range starting at LBA {first_usable}"
        );
    }

    let entries_offset = entries_lba
        .checked_mul(sector_size)
        .ok_or_else(|| err!("GPT partition entry LBA {entries_lba} is too large to be real"))?;
    let entries = read_exactly(entries_offset, array_bytes, "GPT partition entry array")?;
    let entries_crc = crc32fast::hash(&entries);
    if entries_crc != stored_entries_crc {
        fail!(
            "GPT partition entry array CRC32 mismatch: stored {}, computed {}",
            hex32(stored_entries_crc),
            hex32(entries_crc)
        );
    }

    let mut partitions = Vec::new();
    let entry_size = entry_size as usize;
    for i in 0..num_entries as usize {
        let entry = &entries[i * entry_size..(i + 1) * entry_size];
        // An all-zero partition type GUID is UEFI's "unused entry"; its other fields mean nothing.
        if entry[..TYPE_GUID_BYTES].iter().all(|&byte| byte == 0) {
            continue;
        }

        let name = decode_name(&entry[NAME_OFFSET..NAME_OFFSET + NAME_BYTES]);
        let label = format!("GPT partition {i} (\"{name}\")");
        let first_lba = safe_u64(entry, 32, &format!("{label} first LBA"))?;
        let last_lba = safe_u64(entry, 40, &format!("{label} last LBA"))?;

        if last_lba < first_lba {
            fail!("{label} ends at LBA {last_lba}, before it starts at LBA {first_lba}");
        }
        if first_lba < first_usable || last_lba > last_usable {
            fail!("{label} spans LBA {first_lba}..{last_lba}, outside the usable range {first_usable}..{last_usable}");
        }

        let offset = u128::from(first_lba) * u128::from(sector_size);
        let size = u128::from(last_lba - first_lba + 1) * u128::from(sector_size);
        if offset + size > u128::from(MAX_SAFE_INTEGER) {
            fail!("{label} ends past {MAX_SAFE_INTEGER} bytes");
        }

        partitions.push(GptPartition { name, offset: offset as u64, size: size as u64, first_lba, last_lba });
    }

    // Two partitions sharing sectors means an edit to one silently corrupts the other.
    let mut by_start: Vec<&GptPartition> = partitions.iter().collect();
    by_start.sort_by_key(|part| part.first_lba);
    for pair in by_start.windows(2) {
        let (previous, current) = (pair[0], pair[1]);
        if current.first_lba <= previous.last_lba {
            fail!(
                "GPT partitions \"{}\" (LBA {}..{}) and \"{}\" (LBA {}..{}) overlap",
                previous.name,
                previous.first_lba,
                previous.last_lba,
                current.name,
                current.first_lba,
                current.last_lba
            );
        }
    }

    Ok(partitions)
}

/// The one partition called `name`.
///
/// A duplicate is refused rather than resolved by position: which of two `super`s the guest's
/// bootloader picks is not something to guess at when the answer decides where edits are written.
pub fn find_partition<'a>(parts: &'a [GptPartition], name: &str) -> Result<&'a GptPartition> {
    let matches: Vec<&GptPartition> = parts.iter().filter(|part| part.name == name).collect();
    match matches.len() {
        0 => {
            let names = if parts.is_empty() {
                "none".to_owned()
            } else {
                parts.iter().map(|part| format!("\"{}\"", part.name)).collect::<Vec<_>>().join(", ")
            };
            fail!("no GPT partition named \"{name}\" (partitions: {names})")
        }
        1 => Ok(matches[0]),
        n => fail!("GPT has {n} partitions named \"{name}\"; refusing to guess which one is real"),
    }
}

/// UTF-16LE, ended by the first NUL code unit or the end of the 72-byte field.
fn decode_name(field: &[u8]) -> String {
    let mut units = Vec::new();
    let mut i = 0;
    while i * 2 + 1 < field.len() {
        let unit = u16le(field, i * 2);
        if unit == 0 {
            break;
        }
        units.push(unit);
        i += 1;
    }
    String::from_utf16_lossy(&units)
}

/// A u64 that is about to become an LBA or byte count, so it must stay within the range both
/// builders accept.
fn safe_u64(data: &[u8], at: usize, what: &str) -> Result<u64> {
    let value = u64le(data, at);
    if value > MAX_SAFE_INTEGER {
        fail!("{what} {value} is too large to be real");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::{put_u16le, put_u32le, put_u64le};

    /// Any non-zero partition type GUID marks an entry as used; this is Microsoft basic data.
    const TYPE_GUID: [u8; 16] = [
        0xa2, 0xa0, 0xd0, 0xeb, 0xe5, 0xb9, 0x33, 0x44, 0x87, 0xc0, 0x68, 0xb6, 0xb7, 0x26, 0x99, 0xc7,
    ];

    struct Part {
        name: &'static str,
        first_lba: u64,
        last_lba: u64,
        slot: Option<usize>,
    }

    const fn part(name: &'static str, first_lba: u64, last_lba: u64) -> Part {
        Part { name, first_lba, last_lba, slot: None }
    }

    /// The two partitions of Google's API 30 `system.img`, as measured.
    fn real() -> Vec<Part> {
        vec![part("vbmeta", 2048, 4095), part("super", 4096, 6311935)]
    }

    struct Layout {
        sector_size: usize,
        num_entries: usize,
        entry_size: usize,
        last_usable: u64,
    }

    impl Default for Layout {
        fn default() -> Self {
            Layout { sector_size: 512, num_entries: 128, entry_size: 128, last_usable: 6313950 }
        }
    }

    /// A disk laid out the way sgdisk does it: protective MBR, header at LBA 1, 128 entries of 128
    /// bytes from LBA 2, CRCs computed for real. Only the table is materialised: the partitions'
    /// own sectors are never read, so the buffer ends at the first usable LBA.
    fn build_disk(partitions: &[Part], layout: Layout) -> Vec<u8> {
        let Layout { sector_size, num_entries, entry_size, last_usable } = layout;
        let entries_lba = 2usize;
        let first_usable = entries_lba + (num_entries * entry_size).div_ceil(sector_size);
        let mut disk = vec![0u8; first_usable * sector_size];

        disk[446 + 4] = 0xee;
        put_u32le(&mut disk, 446 + 8, 1);
        put_u32le(&mut disk, 446 + 12, 0xffffffff);
        put_u16le(&mut disk, 510, 0xaa55);

        let mut entries = vec![0u8; num_entries * entry_size];
        for (i, part) in partitions.iter().enumerate() {
            let slot = part.slot.unwrap_or(i);
            let entry = &mut entries[slot * entry_size..(slot + 1) * entry_size];
            entry[..16].copy_from_slice(&TYPE_GUID);
            put_u32le(entry, 16, i as u32 + 1);
            put_u64le(entry, 32, part.first_lba);
            put_u64le(entry, 40, part.last_lba);
            for (k, unit) in part.name.encode_utf16().enumerate() {
                put_u16le(entry, 56 + k * 2, unit);
            }
        }
        let start = entries_lba * sector_size;
        disk[start..start + entries.len()].copy_from_slice(&entries);

        let header = &mut disk[sector_size..sector_size + 92];
        header[..8].copy_from_slice(b"EFI PART");
        put_u32le(header, 8, 0x00010000);
        put_u32le(header, 12, 92);
        put_u64le(header, 24, 1);
        put_u64le(header, 32, last_usable + 33);
        put_u64le(header, 40, first_usable as u64);
        put_u64le(header, 48, last_usable);
        header[56..72].fill(0x5a);
        put_u64le(header, 72, entries_lba as u64);
        put_u32le(header, 80, num_entries as u32);
        put_u32le(header, 84, entry_size as u32);
        put_u32le(header, 88, crc32fast::hash(&entries));
        let crc = crc32fast::hash(header);
        put_u32le(header, 16, crc);
        disk
    }

    fn message(result: Result<impl std::fmt::Debug>) -> String {
        result.expect_err("expected a refusal").to_string()
    }

    #[test]
    fn finds_vbmeta_and_super_at_their_byte_offsets() {
        let mut disk = build_disk(&real(), Layout::default());
        let parts = read_gpt(&mut disk).unwrap();

        assert_eq!(parts.len(), 2);
        let vbmeta = find_partition(&parts, "vbmeta").unwrap();
        let super_part = find_partition(&parts, "super").unwrap();
        assert_eq!(
            vbmeta,
            &GptPartition { name: "vbmeta".into(), offset: 1048576, size: 1048576, first_lba: 2048, last_lba: 4095 }
        );
        assert_eq!(super_part.offset, 2097152);
        assert_eq!(super_part.size, (6311935 - 4096 + 1) * 512, "last_lba is inclusive");
    }

    #[test]
    fn unused_entries_between_used_ones_are_skipped() {
        let parts = vec![
            Part { slot: Some(0), ..part("vbmeta", 2048, 4095) },
            Part { slot: Some(7), ..part("super", 4096, 6311935) },
        ];
        let mut disk = build_disk(&parts, Layout::default());
        let names: Vec<String> = read_gpt(&mut disk).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["vbmeta", "super"]);
    }

    #[test]
    fn byte_offsets_follow_the_sector_size() {
        let mut disk = build_disk(
            &[part("super", 256, 511)],
            Layout { sector_size: 4096, last_usable: 100000, ..Layout::default() },
        );
        let parts = read_gpt_with_sector_size(&mut disk, 4096).unwrap();
        assert_eq!(parts[0].offset, 256 * 4096);
        assert_eq!(parts[0].size, 256 * 4096);
    }

    #[test]
    fn a_flipped_byte_in_the_header_is_refused() {
        let mut disk = build_disk(&real(), Layout::default());
        disk[512 + 60] ^= 0x01; // inside the disk GUID, covered by the header CRC
        assert!(message(read_gpt(&mut disk)).contains("GPT header CRC32 mismatch"));
    }

    #[test]
    fn a_flipped_byte_in_the_entry_array_is_refused() {
        // The dangerous case: a changed LBA in an entry would move every write the builder makes.
        let mut disk = build_disk(&real(), Layout::default());
        disk[2 * 512 + 128 + 32] ^= 0x01; // super's first LBA
        assert!(message(read_gpt(&mut disk)).contains("GPT partition entry array CRC32 mismatch"));
    }

    #[test]
    fn a_disk_without_the_signature_is_refused() {
        let mut disk = build_disk(&real(), Layout::default());
        disk[512..520].copy_from_slice(b"NOT PART");
        assert!(message(read_gpt(&mut disk)).starts_with("no GPT"));
    }

    #[test]
    fn a_truncated_disk_is_refused_rather_than_read_short() {
        let disk = build_disk(&real(), Layout::default());
        let mut short = disk[..4 * 512].to_vec();
        assert!(message(read_gpt(&mut short)).contains("short read of the GPT partition entry array"));
    }

    #[test]
    fn overlapping_partitions_are_refused() {
        let mut disk = build_disk(&[part("vbmeta", 2048, 4096), part("super", 4096, 8191)], Layout::default());
        let text = message(read_gpt(&mut disk));
        assert!(text.contains("\"vbmeta\"") && text.contains("\"super\"") && text.ends_with("overlap"), "{text}");
    }

    #[test]
    fn a_partition_outside_the_usable_range_is_refused() {
        let mut disk = build_disk(&[part("super", 4096, 7000000)], Layout::default());
        let text = message(read_gpt(&mut disk));
        assert!(text.contains("\"super\"") && text.contains("outside the usable range"), "{text}");
    }

    #[test]
    fn a_duplicated_name_is_refused_rather_than_resolved_by_position() {
        let mut disk = build_disk(&[part("super", 2048, 4095), part("super", 4096, 8191)], Layout::default());
        let parts = read_gpt(&mut disk).unwrap();
        assert_eq!(parts.len(), 2, "the table itself is valid");
        assert!(message(find_partition(&parts, "super")).contains("2 partitions named \"super\""));
    }

    #[test]
    fn a_missing_partition_names_what_is_there() {
        let mut disk = build_disk(&real(), Layout::default());
        let parts = read_gpt(&mut disk).unwrap();
        assert_eq!(
            message(find_partition(&parts, "userdata")),
            "no GPT partition named \"userdata\" (partitions: \"vbmeta\", \"super\")"
        );
    }
}
