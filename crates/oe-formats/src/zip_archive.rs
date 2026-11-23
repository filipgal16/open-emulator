//! Reading members out of a zip archive, in-process.
//!
//! The SDK's archives are unpacked whole (see the engine), but a game bundle is the opposite case.
//! Only some of its members are wanted — the ones that fit this guest — and one small member,
//! `manifest.json`, has to be read before deciding which. The zip format itself is a directory at
//! the end of the file and a fixed header in front of each member, which is a page of code.
//!
//! Members are streamed to disk rather than read into memory, because a bundle's assets can run to
//! gigabytes. Zip64 is handled: the archives in question are routinely past 4 GB.

use std::fmt;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use flate2::read::DeflateDecoder;

use crate::bytes::{u16le, u32le, u64le};
use crate::{fileio, MAX_SAFE_INTEGER};

const EOCD_SIGNATURE: u32 = 0x06054b50;
const EOCD_BYTES: usize = 22;
const MAX_COMMENT_BYTES: usize = 0xffff;
const ZIP64_LOCATOR_SIGNATURE: u32 = 0x07064b50;
const ZIP64_LOCATOR_BYTES: usize = 20;
const ZIP64_EOCD_SIGNATURE: u32 = 0x06064b50;
const ZIP64_EOCD_BYTES: usize = 56;
const CENTRAL_SIGNATURE: u32 = 0x02014b50;
const CENTRAL_BYTES: usize = 46;
const LOCAL_SIGNATURE: u32 = 0x04034b50;
const LOCAL_BYTES: usize = 30;
const ZIP64_EXTRA_ID: u16 = 0x0001;

pub const METHOD_STORED: u16 = 0;
pub const METHOD_DEFLATE: u16 = 8;
const FLAG_ENCRYPTED: u16 = 0x0001;

/// A zip that cannot be read, or a member that did not come out intact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipError(pub String);

impl fmt::Display for ZipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ZipError {}

impl From<std::io::Error> for ZipError {
    fn from(error: std::io::Error) -> Self {
        ZipError(error.to_string())
    }
}

impl From<crate::Error> for ZipError {
    fn from(error: crate::Error) -> Self {
        ZipError(error.0)
    }
}

impl From<ZipError> for crate::Error {
    fn from(error: ZipError) -> Self {
        crate::Error(error.0)
    }
}

pub type ZipResult<T> = std::result::Result<T, ZipError>;

fn zip_err<T>(message: &str) -> ZipResult<T> {
    Err(ZipError(message.to_owned()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    /// As stored: `/`-separated, relative. Never joined onto a host path by this module.
    pub name: String,
    pub method: u16,
    pub flags: u16,
    pub crc32: u32,
    pub compressed_size: u64,
    pub size: u64,
    pub local_header_offset: u64,
}

fn read_at(file: &File, position: u64, length: usize) -> ZipResult<Vec<u8>> {
    let data = fileio::read_up_to(file, position, length)?;
    if data.len() != length {
        return zip_err("the archive ends early");
    }
    Ok(data)
}

/// No file this app will ever see is past 2^53 bytes; a size that is says the archive is damaged.
fn u64_field(buffer: &[u8], offset: usize) -> ZipResult<u64> {
    let value = u64le(buffer, offset);
    if value > MAX_SAFE_INTEGER {
        return zip_err("a size in the archive is out of range");
    }
    Ok(value)
}

/// The central directory: every member's name, sizes and where its data starts.
///
/// Read from the end of the file, which is where zip keeps the authoritative copy. The local
/// headers in front of each member can carry zeroed sizes (when the writer streamed them), so they
/// are only consulted for the one thing they alone know: how long their own name and extra fields
/// are.
pub fn read_zip_directory(file_path: &Path) -> ZipResult<Vec<ZipEntry>> {
    let file = File::open(file_path)?;
    let file_size = file.metadata()?.len();
    if file_size < EOCD_BYTES as u64 {
        return zip_err("not a zip archive");
    }

    // The end record sits behind a comment of up to 64 KB, so it is found by scanning backwards.
    let tail_length = file_size.min((EOCD_BYTES + MAX_COMMENT_BYTES) as u64) as usize;
    let tail_start = file_size - tail_length as u64;
    let tail = read_at(&file, tail_start, tail_length)?;
    let Some(eocd) = (0..=tail.len() - EOCD_BYTES).rev().find(|&i| u32le(&tail, i) == EOCD_SIGNATURE) else {
        return zip_err("not a zip archive");
    };

    let mut count = u64::from(u16le(&tail, eocd + 10));
    let mut directory_size = u64::from(u32le(&tail, eocd + 12));
    let mut directory_offset = u64::from(u32le(&tail, eocd + 16));

    // Any field pinned at its maximum means the real value is in the zip64 record, found through
    // the locator immediately before the classic end record.
    if count == 0xffff || directory_size == 0xffffffff || directory_offset == 0xffffffff {
        let Some(locator_at) = (tail_start + eocd as u64).checked_sub(ZIP64_LOCATOR_BYTES as u64) else {
            return zip_err("the archive’s zip64 locator is missing");
        };
        let locator = read_at(&file, locator_at, ZIP64_LOCATOR_BYTES)?;
        if u32le(&locator, 0) != ZIP64_LOCATOR_SIGNATURE {
            return zip_err("the archive’s zip64 locator is missing");
        }
        let record = read_at(&file, u64_field(&locator, 8)?, ZIP64_EOCD_BYTES)?;
        if u32le(&record, 0) != ZIP64_EOCD_SIGNATURE {
            return zip_err("the archive’s zip64 record is damaged");
        }
        count = u64_field(&record, 32)?;
        directory_size = u64_field(&record, 40)?;
        directory_offset = u64_field(&record, 48)?;
    }

    if directory_offset + directory_size > file_size {
        return zip_err("the archive’s directory is out of bounds");
    }
    let directory = read_at(&file, directory_offset, directory_size as usize)?;

    let mut entries = Vec::new();
    let mut at = 0usize;
    for _ in 0..count {
        if at + CENTRAL_BYTES > directory.len() || u32le(&directory, at) != CENTRAL_SIGNATURE {
            return zip_err("the archive’s directory is damaged");
        }
        let name_length = usize::from(u16le(&directory, at + 28));
        let extra_length = usize::from(u16le(&directory, at + 30));
        let comment_length = usize::from(u16le(&directory, at + 32));
        let name_end = at + CENTRAL_BYTES + name_length;
        let extra_end = name_end + extra_length;
        if extra_end + comment_length > directory.len() {
            return zip_err("the archive’s directory is damaged");
        }
        let mut entry = ZipEntry {
            name: String::from_utf8_lossy(&directory[at + CENTRAL_BYTES..name_end]).into_owned(),
            flags: u16le(&directory, at + 8),
            method: u16le(&directory, at + 10),
            crc32: u32le(&directory, at + 16),
            compressed_size: u64::from(u32le(&directory, at + 20)),
            size: u64::from(u32le(&directory, at + 24)),
            local_header_offset: u64::from(u32le(&directory, at + 42)),
        };

        // The zip64 extra field holds only the values that overflowed, in this fixed order.
        let mut x = name_end;
        while x + 4 <= extra_end {
            let id = u16le(&directory, x);
            let length = usize::from(u16le(&directory, x + 2));
            if id == ZIP64_EXTRA_ID {
                let mut field = x + 4;
                let mut next = |value: &mut u64| -> ZipResult<()> {
                    if field + 8 > extra_end {
                        return zip_err("the archive’s directory is damaged");
                    }
                    *value = u64_field(&directory, field)?;
                    field += 8;
                    Ok(())
                };
                if entry.size == 0xffffffff {
                    next(&mut entry.size)?;
                }
                if entry.compressed_size == 0xffffffff {
                    next(&mut entry.compressed_size)?;
                }
                if entry.local_header_offset == 0xffffffff {
                    next(&mut entry.local_header_offset)?;
                }
            }
            x += 4 + length;
        }

        entries.push(entry);
        at = extra_end + comment_length;
    }
    Ok(entries)
}

fn check_readable(entry: &ZipEntry) -> ZipResult<()> {
    if entry.flags & FLAG_ENCRYPTED != 0 {
        return Err(ZipError(format!("{} is encrypted", entry.name)));
    }
    if entry.method != METHOD_STORED && entry.method != METHOD_DEFLATE {
        return Err(ZipError(format!("{} uses compression method {}", entry.name, entry.method)));
    }
    Ok(())
}

/// Where a member's bytes begin: past its local header, whose name and extra lengths are its own.
fn data_offset(file: &File, entry: &ZipEntry) -> ZipResult<u64> {
    let header = read_at(file, entry.local_header_offset, LOCAL_BYTES)?;
    if u32le(&header, 0) != LOCAL_SIGNATURE {
        return Err(ZipError(format!("{} has a damaged header", entry.name)));
    }
    Ok(entry.local_header_offset + LOCAL_BYTES as u64 + u64::from(u16le(&header, 26)) + u64::from(u16le(&header, 28)))
}

/// A small member, whole, into memory. Refuses anything over `max_bytes` before reading it.
pub fn read_zip_entry(file_path: &Path, entry: &ZipEntry, max_bytes: u64) -> ZipResult<Vec<u8>> {
    check_readable(entry)?;
    if entry.size > max_bytes || entry.compressed_size > max_bytes {
        return Err(ZipError(format!("{} is too large to read", entry.name)));
    }
    let file = File::open(file_path)?;
    let raw = read_at(&file, data_offset(&file, entry)?, entry.compressed_size as usize)?;
    let data = if entry.method == METHOD_DEFLATE {
        let mut out = Vec::with_capacity(entry.size as usize);
        DeflateDecoder::new(&raw[..])
            .take(max_bytes + 1)
            .read_to_end(&mut out)
            .map_err(|_| ZipError(format!("{} is damaged", entry.name)))?;
        out
    } else {
        raw
    };
    if data.len() as u64 != entry.size || crc32fast::hash(&data) != entry.crc32 {
        return Err(ZipError(format!("{} is damaged", entry.name)));
    }
    Ok(data)
}

/// The bytes between `start` and `end` of a file, read through a shared handle.
struct Window<'a> {
    file: &'a File,
    at: u64,
    end: u64,
}

impl Read for Window<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = (self.end - self.at).min(buf.len() as u64) as usize;
        if left == 0 {
            return Ok(0);
        }
        let n = fileio::read_at(self.file, &mut buf[..left], self.at)?;
        self.at += n as u64;
        Ok(n)
    }
}

/// Streams one member to `destination`, checking its length and CRC on the way past.
///
/// The check matters more than it would for a download with a digest: nothing else stands between
/// a truncated bundle and a guest that fails the install with an error about signatures.
pub fn extract_zip_entry(
    file_path: &Path,
    entry: &ZipEntry,
    destination: &Path,
    mut on_bytes: impl FnMut(u64),
) -> ZipResult<()> {
    check_readable(entry)?;
    let file = File::open(file_path)?;
    let start = data_offset(&file, entry)?;
    let window = Window { file: &file, at: start, end: start + entry.compressed_size };
    let mut source: Box<dyn Read> =
        if entry.method == METHOD_DEFLATE { Box::new(DeflateDecoder::new(window)) } else { Box::new(window) };

    let mut sink = std::io::BufWriter::new(File::create(destination)?);
    let mut crc = crc32fast::Hasher::new();
    let mut written = 0u64;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let n = source.read(&mut buffer).map_err(|_| ZipError(format!("{} is damaged", entry.name)))?;
        if n == 0 {
            break;
        }
        crc.update(&buffer[..n]);
        written += n as u64;
        // Past the declared size is damage too, and there is no reason to keep writing it.
        if written > entry.size {
            return Err(ZipError(format!("{} is damaged", entry.name)));
        }
        sink.write_all(&buffer[..n])?;
        on_bytes(n as u64);
    }
    sink.flush()?;

    if written != entry.size || crc.finalize() != entry.crc32 {
        return Err(ZipError(format!("{} is damaged", entry.name)));
    }
    Ok(())
}

/// Where an entry may be written under `destination`, or why it may not.
///
/// A zip names its entries with relative `/`-separated paths, and nothing stops one from naming
/// `../../Windows/x.dll` or `C:/x`. An archive that tries is refused whole rather than partly
/// extracted: it is not one this app has any business unpacking.
fn entry_path(destination: &Path, name: &str) -> ZipResult<std::path::PathBuf> {
    let mut path = destination.to_owned();
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return Err(ZipError(format!("{name} reaches outside the folder it is extracted into"))),
            part if part.contains(':') => return Err(ZipError(format!("{name} is not a relative path"))),
            part => path.push(part),
        }
    }
    Ok(path)
}

/// Extracts every member under `destination`, creating directories as needed. `on_bytes` hears
/// each chunk written, for progress.
pub fn extract_all(file_path: &Path, destination: &Path, mut on_bytes: impl FnMut(u64)) -> ZipResult<()> {
    let entries = read_zip_directory(file_path)?;
    // Every name is checked before anything is written, so a hostile archive leaves nothing behind.
    let targets: Vec<std::path::PathBuf> =
        entries.iter().map(|entry| entry_path(destination, &entry.name)).collect::<ZipResult<_>>()?;
    std::fs::create_dir_all(destination)?;
    for (entry, target) in entries.iter().zip(&targets) {
        if entry.name.ends_with('/') || entry.name.ends_with('\\') {
            std::fs::create_dir_all(target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        extract_zip_entry(file_path, entry, target, &mut on_bytes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{make_zip, ZipFile};

    #[test]
    fn a_whole_archive_extracts_into_its_folder_with_directories_created() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write(
            dir.path(),
            "tools.zip",
            &make_zip(
                &[
                    ZipFile::stored("platform-tools/", b""),
                    ZipFile::deflated("platform-tools/adb.exe", b"pretend adb"),
                    ZipFile::deflated("platform-tools/lib/deep/file.txt", b"deep"),
                ],
                false,
            ),
        );
        let out = dir.path().join("out");
        extract_all(&zip, &out, |_| {}).unwrap();
        assert_eq!(std::fs::read(out.join("platform-tools").join("adb.exe")).unwrap(), b"pretend adb");
        assert_eq!(std::fs::read(out.join("platform-tools/lib/deep/file.txt")).unwrap(), b"deep");
    }

    #[test]
    fn an_entry_that_climbs_out_of_the_folder_refuses_the_whole_archive() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write(
            dir.path(),
            "evil.zip",
            &make_zip(&[ZipFile::stored("fine.txt", b"ok"), ZipFile::stored("../escaped.txt", b"no")], false),
        );
        let out = dir.path().join("out");
        assert!(extract_all(&zip, &out, |_| {}).unwrap_err().0.contains("reaches outside"));
        assert!(!dir.path().join("escaped.txt").exists());
        assert!(!out.join("fine.txt").exists(), "nothing is written before every name is checked");
    }

    /// Compressible but not trivially so, and large enough to cross many stream chunks.
    fn payload(bytes: usize) -> Vec<u8> {
        let mut seed: u32 = 7;
        (0..bytes)
            .map(|_| {
                seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
                0x41 + ((seed >> 16) % 8) as u8
            })
            .collect()
    }

    fn write(dir: &Path, name: &str, data: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, data).unwrap();
        path
    }

    #[test]
    fn the_directory_lists_stored_and_deflated_members_with_their_real_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let packed_text = "deflated text ".repeat(40);
        let zip = write(
            dir.path(),
            "a.zip",
            &make_zip(&[ZipFile::stored("plain.txt", b"stored text"), ZipFile::deflated("packed.txt", packed_text.as_bytes())], false),
        );

        let entries = read_zip_directory(&zip).unwrap();
        assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["plain.txt", "packed.txt"]);
        assert_eq!(entries[0].method, 0);
        assert_eq!(entries[1].method, 8);
        assert_eq!(entries[1].size, packed_text.len() as u64);
        assert!(entries[1].compressed_size < entries[1].size, "the fixture really is compressed");
        assert_eq!(read_zip_entry(&zip, &entries[0], 1024).unwrap(), b"stored text");
        assert_eq!(read_zip_entry(&zip, &entries[1], 1024).unwrap(), packed_text.as_bytes());
    }

    #[test]
    fn a_large_member_streams_to_disk_byte_for_byte_reporting_progress_as_it_goes() {
        let dir = tempfile::tempdir().unwrap();
        let big = payload(3 * 1024 * 1024);
        let zip = write(
            dir.path(),
            "big.zip",
            &make_zip(
                &[
                    ZipFile::deflated("readme.txt", b"hi"),
                    ZipFile::deflated("big.bin", &big),
                    ZipFile::stored("raw.bin", &big[..70_000]),
                ],
                false,
            ),
        );

        let entries = read_zip_directory(&zip).unwrap();
        let mut reported = 0;
        let mut calls = 0;
        extract_zip_entry(&zip, &entries[1], &dir.path().join("big.out"), |bytes| {
            reported += bytes;
            calls += 1;
        })
        .unwrap();
        extract_zip_entry(&zip, &entries[2], &dir.path().join("raw.out"), |_| {}).unwrap();

        assert_eq!(std::fs::read(dir.path().join("big.out")).unwrap(), big);
        assert_eq!(std::fs::read(dir.path().join("raw.out")).unwrap(), &big[..70_000]);
        assert_eq!(reported, big.len() as u64, "progress adds up to the member’s size");
        assert!(calls > 1, "delivered in chunks, not read whole");
    }

    #[test]
    fn an_empty_member_extracts_to_an_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write(
            dir.path(),
            "empty.zip",
            &make_zip(&[ZipFile::stored("nothing.txt", b""), ZipFile::deflated("also-nothing.txt", b"")], false),
        );
        let entries = read_zip_directory(&zip).unwrap();
        extract_zip_entry(&zip, &entries[0], &dir.path().join("a"), |_| {}).unwrap();
        extract_zip_entry(&zip, &entries[1], &dir.path().join("b"), |_| {}).unwrap();
        assert_eq!(std::fs::read(dir.path().join("a")).unwrap().len(), 0);
        assert_eq!(std::fs::read(dir.path().join("b")).unwrap().len(), 0);
    }

    #[test]
    fn zip64_archives_are_read_through_their_zip64_record_and_extra_fields() {
        let dir = tempfile::tempdir().unwrap();
        let data = payload(200_000);
        let zip = write(
            dir.path(),
            "z64.zip",
            &make_zip(&[ZipFile::deflated("first.apk", b"small one"), ZipFile::deflated("second.bin", &data)], true),
        );

        let entries = read_zip_directory(&zip).unwrap();
        assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["first.apk", "second.bin"]);
        assert_eq!(entries[1].size, data.len() as u64, "the size came from the zip64 extra, not the placeholder");
        assert_ne!(entries[1].local_header_offset, 0xffffffff);
        extract_zip_entry(&zip, &entries[1], &dir.path().join("out.bin"), |_| {}).unwrap();
        assert_eq!(std::fs::read(dir.path().join("out.bin")).unwrap(), data);
    }

    #[test]
    fn a_corrupted_member_is_refused_rather_than_handed_on() {
        let dir = tempfile::tempdir().unwrap();
        let mut archive = make_zip(&[ZipFile::stored("data.txt", b"the original content")], false);
        // Flip a byte inside the stored data; the CRC in the directory no longer matches.
        archive[30 + "data.txt".len() + 2] ^= 0xff;
        let zip = write(dir.path(), "bad.zip", &archive);

        let entries = read_zip_directory(&zip).unwrap();
        assert!(extract_zip_entry(&zip, &entries[0], &dir.path().join("out"), |_| {}).is_err());
        assert!(read_zip_entry(&zip, &entries[0], 1024).is_err());
    }

    #[test]
    fn something_that_is_not_a_zip_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let junk = write(dir.path(), "junk.bin", b"definitely not an archive, just some text that goes on for a while");
        assert_eq!(read_zip_directory(&junk).unwrap_err().0, "not a zip archive");
        let tiny = write(dir.path(), "tiny.bin", b"PK");
        assert_eq!(read_zip_directory(&tiny).unwrap_err().0, "not a zip archive");
    }

    #[test]
    fn a_small_read_refuses_a_member_over_its_limit_before_reading_it() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write(dir.path(), "a.zip", &make_zip(&[ZipFile::deflated("manifest.json", "x".repeat(5000).as_bytes())], false));
        let entries = read_zip_directory(&zip).unwrap();
        assert!(read_zip_entry(&zip, &entries[0], 1000).unwrap_err().0.contains("too large"));
    }
}
