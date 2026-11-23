//! The cpio "newc" archive format, read and written in Rust.
//!
//! This exists to patch an Android-x86 initrd, which is a gzipped cpio archive. The shell version
//! shelled out to `zcat | cpio -idm` and `cpio -o -H newc | gzip` — neither of which exists on
//! Windows, and neither of which is worth shipping a Unix toolchain for. The format is fixed-width
//! ASCII headers and 4-byte alignment.
//!
//! Doing it in-process is also better than the original: unpacking to a temp directory and
//! repacking loses file modes and symlinks unless every flag is right, whereas editing entries in
//! memory cannot lose what it never converted.

use crate::{fail, Result};

const MAGIC: &[u8; 6] = b"070701";
const HEADER_BYTES: usize = 110;
const TRAILER: &str = "TRAILER!!!";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CpioEntry {
    pub name: String,
    /// Unix mode, including the file-type bits. Preserved exactly on a round trip.
    pub mode: u32,
    pub data: Vec<u8>,
    pub ino: u32,
    pub uid: u32,
    pub gid: u32,
    pub nlink: u32,
    pub mtime: u32,
    pub devmajor: u32,
    pub devminor: u32,
    pub rdevmajor: u32,
    pub rdevminor: u32,
}

const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

impl CpioEntry {
    pub fn is_file(&self) -> bool {
        self.mode & S_IFMT == S_IFREG
    }

    pub fn is_directory(&self) -> bool {
        self.mode & S_IFMT == S_IFDIR
    }

    pub fn is_symlink(&self) -> bool {
        self.mode & S_IFMT == S_IFLNK
    }
}

/// Padding to the next 4-byte boundary. Both the name and the data are aligned this way.
fn pad4(value: usize) -> usize {
    (4 - value % 4) % 4
}

pub fn parse_cpio(archive: &[u8]) -> Result<Vec<CpioEntry>> {
    let mut entries = Vec::new();
    if archive.is_empty() {
        return Ok(entries);
    }

    // Checked up front, not only inside the loop. A buffer too short to hold one header would
    // otherwise fall straight through and return no entries — so a failed gunzip, or simply the
    // wrong file, would produce an *empty* initrd that repacks and boots to nothing, with no error
    // anywhere pointing at the cause.
    if archive.len() < HEADER_BYTES || &archive[..6] != MAGIC {
        fail!("not a newc cpio archive: the data does not begin with a 070701 header");
    }

    let mut offset = 0;
    while offset + HEADER_BYTES <= archive.len() {
        let magic = &archive[offset..offset + 6];
        if magic != MAGIC {
            fail!(
                "not a newc cpio archive: magic \"{}\" at offset {offset}",
                String::from_utf8_lossy(magic)
            );
        }

        let field = |index: usize| -> Result<usize> {
            let start = offset + 6 + index * 8;
            let text = std::str::from_utf8(&archive[start..start + 8]).unwrap_or("");
            match u32::from_str_radix(text, 16) {
                Ok(value) => Ok(value as usize),
                Err(_) => fail!("not a newc cpio archive: header field {index} at offset {offset} is not hex"),
            }
        };
        let [ino, mode, uid, gid, nlink, mtime, filesize, devmajor, devminor, rdevmajor, rdevminor, namesize] = [
            field(0)?,
            field(1)?,
            field(2)?,
            field(3)?,
            field(4)?,
            field(5)?,
            field(6)?,
            field(7)?,
            field(8)?,
            field(9)?,
            field(10)?,
            field(11)?,
        ];

        let name_start = offset + HEADER_BYTES;
        // namesize includes the trailing NUL, which is not part of the name.
        let name_end = (name_start + namesize.saturating_sub(1)).min(archive.len());
        let name = String::from_utf8_lossy(&archive[name_start.min(archive.len())..name_end]).into_owned();

        let data_start = name_start + namesize + pad4(HEADER_BYTES + namesize);
        let data = &archive[data_start.min(archive.len())..(data_start + filesize).min(archive.len())];

        offset = data_start + filesize + pad4(filesize);

        if name == TRAILER {
            break;
        }

        entries.push(CpioEntry {
            name,
            mode: mode as u32,
            data: data.to_vec(),
            ino: ino as u32,
            uid: uid as u32,
            gid: gid as u32,
            nlink: nlink as u32,
            mtime: mtime as u32,
            devmajor: devmajor as u32,
            devminor: devminor as u32,
            rdevmajor: rdevmajor as u32,
            rdevminor: rdevminor as u32,
        });
    }

    Ok(entries)
}

pub fn build_cpio(entries: &[CpioEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut push = |entry: &CpioEntry| {
        let name = entry.name.as_bytes();
        let namesize = name.len() + 1;
        let filesize = entry.data.len();
        let header = format!(
            "070701{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}{:08X}",
            entry.ino,
            entry.mode,
            entry.uid,
            entry.gid,
            entry.nlink,
            entry.mtime,
            filesize,
            entry.devmajor,
            entry.devminor,
            entry.rdevmajor,
            entry.rdevminor,
            namesize,
            0 // c_check is unused by newc and must be zero
        );
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(name);
        out.push(0);
        out.extend(std::iter::repeat_n(0u8, pad4(HEADER_BYTES + namesize)));
        out.extend_from_slice(&entry.data);
        out.extend(std::iter::repeat_n(0u8, pad4(filesize)));
    };

    for entry in entries {
        push(entry);
    }

    // Every newc archive ends with a zero-length TRAILER!!! entry; without it the kernel's own
    // unpacker keeps reading past the end and reports a corrupt initramfs.
    push(&CpioEntry { name: TRAILER.into(), nlink: 1, ..CpioEntry::default() });

    // Archives are conventionally padded to a 512-byte block. The kernel does not require it, but
    // tools that read the result do, and it costs at most 511 bytes.
    let tail = (512 - out.len() % 512) % 512;
    out.extend(std::iter::repeat_n(0u8, tail));
    out
}

/// Rewrites one entry's contents in place, leaving everything else untouched. `false` when there
/// is no entry of that name.
///
/// The alternative — unpack to disk, edit, repack — is how the shell version worked, and it
/// silently loses file modes and symlinks unless every flag is exactly right. Editing the parsed
/// entry cannot lose what it never converted.
pub fn replace_entry(entries: &mut [CpioEntry], name: &str, rewrite: impl FnOnce(&[u8]) -> Vec<u8>) -> bool {
    match entries.iter_mut().find(|candidate| candidate.name == name) {
        Some(entry) => {
            entry.data = rewrite(&entry.data);
            true
        }
        None => false,
    }
}

pub fn find_entry<'a>(entries: &'a [CpioEntry], name: &str) -> Option<&'a CpioEntry> {
    entries.iter().find(|candidate| candidate.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, mode: u32, data: &[u8], ino: u32) -> CpioEntry {
        CpioEntry { name: name.into(), mode, data: data.to_vec(), ino, nlink: 1, ..CpioEntry::default() }
    }

    fn init() -> CpioEntry {
        entry("init", 0o100755, b"#!/bin/sh\n", 1)
    }

    #[test]
    fn an_archive_round_trips_byte_for_byte_in_content() {
        let original = vec![
            init(),
            entry("etc/fstab", 0o100644, b"none / rootfs\n", 2),
            entry("dev", 0o040755, b"", 3),
        ];
        let parsed = parse_cpio(&build_cpio(&original)).unwrap();
        assert_eq!(parsed, original);
    }

    #[test]
    fn file_modes_survive_including_the_executable_bit_on_init() {
        let parsed = parse_cpio(&build_cpio(&[init()])).unwrap();
        assert_eq!(parsed[0].mode & 0o777, 0o755);
        assert!(parsed[0].is_file());
    }

    #[test]
    fn directories_and_symlinks_keep_their_type_bits() {
        let parsed =
            parse_cpio(&build_cpio(&[entry("sbin", 0o040755, b"", 1), entry("bin/sh", 0o120777, b"busybox", 1)])).unwrap();
        assert!(parsed[0].is_directory(), "a directory must not become a regular file");
        assert!(parsed[1].is_symlink(), "a symlink target is its data — losing the type breaks the link");
        assert_eq!(parsed[1].data, b"busybox");
    }

    #[test]
    fn names_of_every_length_are_handled_which_is_where_padding_goes_wrong() {
        let names = ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg"];
        let entries: Vec<CpioEntry> =
            names.iter().enumerate().map(|(i, name)| entry(name, 0o100755, name.as_bytes(), i as u32)).collect();
        let parsed = parse_cpio(&build_cpio(&entries)).unwrap();
        assert_eq!(parsed.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), names);
        for e in &parsed {
            assert_eq!(e.data, e.name.as_bytes(), "{} data misaligned", e.name);
        }
    }

    #[test]
    fn data_of_every_length_is_handled_too() {
        let entries: Vec<CpioEntry> =
            (0..=5).map(|n| entry(&format!("f{n}"), 0o100755, &vec![0x41; n], n as u32)).collect();
        let parsed = parse_cpio(&build_cpio(&entries)).unwrap();
        for (n, e) in parsed.iter().enumerate() {
            assert_eq!(e.data.len(), n, "entry with {n} bytes");
        }
    }

    #[test]
    fn the_archive_is_terminated_and_padded_to_a_512_byte_block() {
        let built = build_cpio(&[init()]);
        assert!(built.windows(10).any(|w| w == b"TRAILER!!!"));
        assert_eq!(parse_cpio(&built).unwrap().len(), 1, "and the trailer is not returned as an entry");
        assert_eq!(built.len() % 512, 0);
    }

    #[test]
    fn editing_an_entry_leaves_every_other_entry_untouched() {
        let mut entries = parse_cpio(&build_cpio(&[
            entry("init", 0o100755, b"line1\nro.setupwizard.mode=DISABLED\nline3\n", 1),
            entry("other", 0o100644, b"unchanged", 2),
        ]))
        .unwrap();

        let edited = replace_entry(&mut entries, "init", |prev| {
            String::from_utf8_lossy(prev).replace("DISABLED\n", "DISABLED\nservice.adb.tcp.port=5555\n").into_bytes()
        });
        assert!(edited);
        let round = parse_cpio(&build_cpio(&entries)).unwrap();
        assert!(String::from_utf8_lossy(&find_entry(&round, "init").unwrap().data).contains("service.adb.tcp.port=5555"));
        assert_eq!(find_entry(&round, "other").unwrap().data, b"unchanged");
        assert_eq!(find_entry(&round, "other").unwrap().mode, 0o100644);
    }

    #[test]
    fn editing_an_absent_entry_reports_failure_rather_than_inventing_one() {
        let mut entries = parse_cpio(&build_cpio(&[init()])).unwrap();
        assert!(!replace_entry(&mut entries, "nope", |_| b"x".to_vec()));
        assert!(find_entry(&entries, "nope").is_none());
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn a_non_cpio_buffer_is_rejected_with_a_useful_message() {
        let error = parse_cpio(b"this is not an archive at all, not even close").unwrap_err();
        assert!(error.0.contains("not a newc cpio archive"));
    }

    #[test]
    fn an_empty_buffer_yields_no_entries_rather_than_failing() {
        assert_eq!(parse_cpio(&[]).unwrap(), Vec::<CpioEntry>::new());
    }

    #[test]
    fn a_truncated_archive_is_rejected_rather_than_read_as_empty() {
        let built = build_cpio(&[init()]);
        assert!(parse_cpio(&built[..40]).unwrap_err().0.contains("not a newc cpio archive"));
    }
}
