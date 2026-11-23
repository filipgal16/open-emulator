//! Reading files out of an ISO9660 image, without mounting it.
//!
//! The shell version used `mount -o loop`, which needs root and does not exist on Windows at all.
//! ISO9660 is a simple format — fixed 2048-byte sectors and a directory tree of variable-length
//! records — and only two files are ever needed out of it: the kernel and the initrd.
//!
//! Reading it directly is also better than mounting: no privilege, no mount point to leak if the
//! process dies partway, and no dependency on a loop device being available.

use std::fs::File;
use std::path::{Path, PathBuf};

use crate::bytes::u32le;
use crate::{err, fail, fileio, Result};

const SECTOR: u64 = 2048;
/// The volume descriptors start here — the first 16 sectors are reserved for boot code.
const PVD_SECTOR: u64 = 16;
const PVD_TYPE_PRIMARY: u8 = 1;
const STANDARD_ID: &[u8; 5] = b"CD001";

/// Directory record flag bit 1: this entry is a directory rather than a file.
const FLAG_DIRECTORY: u8 = 0x02;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoEntry {
    pub name: String,
    pub is_directory: bool,
    /// Logical block address — multiply by 2048 for the byte offset.
    pub lba: u32,
    pub size: u32,
}

/// ISO9660 stores multi-byte numbers twice, little-endian then big-endian, so a reader of either
/// architecture can take the half it prefers. The little-endian half is first.
fn both_endian32(buffer: &[u8], offset: usize) -> u32 {
    u32le(buffer, offset)
}

/// Cleans up an ISO9660 file identifier.
///
/// Plain ISO9660 upper-cases names and appends a version suffix, so `initrd.img` is stored as
/// `INITRD.IMG;1`. Rock Ridge, which Android-x86 images carry, preserves the real name — so the
/// comparison has to work either way, which is why lookups here are case-insensitive.
fn clean_name(raw: &str) -> String {
    let without_version = raw.split(';').next().unwrap_or("");
    // A trailing dot on an extension-less name is an ISO9660 artefact, not part of the name.
    without_version.strip_suffix('.').unwrap_or(without_version).to_owned()
}

pub struct IsoReader {
    path: PathBuf,
    file: File,
    size: u64,
}

impl IsoReader {
    pub fn open(path: &Path) -> Result<IsoReader> {
        let file = File::open(path).map_err(|error| err!("{}: {error}", path.display()))?;
        let size = file.metadata()?.len();
        Ok(IsoReader { path: path.to_owned(), file, size })
    }

    fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>> {
        if offset + length as u64 > self.size {
            fail!("read past the end of {}", self.path.display());
        }
        fileio::read_exact(&self.file, offset, length)
    }

    /// The root directory's location, from the Primary Volume Descriptor.
    pub fn root(&self) -> Result<IsoEntry> {
        let pvd = self.read(PVD_SECTOR * SECTOR, SECTOR as usize)?;
        if &pvd[1..6] != STANDARD_ID {
            fail!("{} is not an ISO9660 image (no CD001 signature)", self.path.display());
        }
        if pvd[0] != PVD_TYPE_PRIMARY {
            fail!("{} has no primary volume descriptor where one is required", self.path.display());
        }
        // The root directory record is embedded in the PVD at a fixed offset, 34 bytes long.
        let record = &pvd[156..156 + 34];
        Ok(IsoEntry { name: String::new(), is_directory: true, lba: both_endian32(record, 2), size: both_endian32(record, 10) })
    }

    /// The entries of one directory. `.` and `..` are dropped; they are never what a caller wants.
    pub fn list(&self, directory: &IsoEntry) -> Result<Vec<IsoEntry>> {
        if !directory.is_directory {
            fail!("{} is not a directory", directory.name);
        }
        let data = self.read(u64::from(directory.lba) * SECTOR, directory.size as usize)?;
        let mut entries = Vec::new();
        let mut offset = 0;

        while offset < data.len() {
            let record_length = usize::from(data[offset]);

            // A zero length means the rest of this sector is padding: records never straddle a
            // sector boundary, so the next one starts at the beginning of the next sector.
            if record_length == 0 {
                let next = (offset / SECTOR as usize + 1) * SECTOR as usize;
                if next >= data.len() {
                    break;
                }
                offset = next;
                continue;
            }

            let record = &data[offset..(offset + record_length).min(data.len())];
            if record.len() < 34 {
                fail!("{}: a directory record at offset {offset} is cut short", self.path.display());
            }
            let name_length = usize::from(record[32]);
            let raw_name = &record[33..(33 + name_length).min(record.len())];

            // Single-byte identifiers 0x00 and 0x01 are `.` and `..`.
            let is_self_or_parent = name_length == 1 && (raw_name[0] == 0 || raw_name[0] == 1);
            if !is_self_or_parent {
                entries.push(IsoEntry {
                    name: clean_name(&String::from_utf8_lossy(raw_name)),
                    is_directory: record[25] & FLAG_DIRECTORY != 0,
                    lba: both_endian32(record, 2),
                    size: both_endian32(record, 10),
                });
            }

            offset += record_length;
        }

        Ok(entries)
    }

    /// Case-insensitive lookup within one directory.
    pub fn find(&self, directory: &IsoEntry, name: &str) -> Result<Option<IsoEntry>> {
        let wanted = name.to_lowercase();
        Ok(self.list(directory)?.into_iter().find(|entry| entry.name.to_lowercase() == wanted))
    }

    /// The whole contents of a file. Only ever used for a kernel and an initrd — a few MB each.
    pub fn read_file(&self, entry: &IsoEntry) -> Result<Vec<u8>> {
        if entry.is_directory {
            fail!("{} is a directory", entry.name);
        }
        self.read(u64::from(entry.lba) * SECTOR, entry.size as usize)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootFiles {
    /// The directory holding the payload, as an absolute path from the media root — this is what
    /// Android-x86's initrd takes as `SRC=`. Empty when the payload sits at the root, which is how
    /// ISO releases are laid out; a release-named directory once installed to a disk.
    pub src_dir: String,
    pub kernel: Vec<u8>,
    pub initrd: Vec<u8>,
}

/// Finds and extracts the kernel and initrd.
///
/// Searches the root and one level below it, which is the same depth the shell version used
/// (`find -maxdepth 2`). Android-x86 ISOs put the payload at the root; some rebuilds and all
/// installed-to-disk layouts put it in a release-named directory, and `SRC=` has to name it.
/// Deriving the directory rather than assuming either is what makes both work.
pub fn read_boot_files(iso_path: &Path) -> Result<BootFiles> {
    let iso = IsoReader::open(iso_path)?;
    let root = iso.root()?;

    let from_directory = |directory: &IsoEntry, src_dir: String| -> Result<Option<BootFiles>> {
        let kernel = iso.find(directory, "kernel")?;
        let initrd = iso.find(directory, "initrd.img")?;
        match (kernel, initrd) {
            (Some(kernel), Some(initrd)) if !kernel.is_directory && !initrd.is_directory => {
                Ok(Some(BootFiles { src_dir, kernel: iso.read_file(&kernel)?, initrd: iso.read_file(&initrd)? }))
            }
            _ => Ok(None),
        }
    };

    if let Some(found) = from_directory(&root, String::new())? {
        return Ok(found);
    }
    for entry in iso.list(&root)? {
        if !entry.is_directory {
            continue;
        }
        if let Some(found) = from_directory(&entry, format!("/{}", entry.name))? {
            return Ok(found);
        }
    }
    fail!(
        "no kernel and initrd.img found in {} — this does not look like an Android-x86 image",
        iso_path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::{put_u32be, put_u32le};

    const SECTOR: usize = 2048;

    struct FileSpec {
        name: &'static str,
        data: Vec<u8>,
    }

    struct DirSpec {
        name: &'static str,
        files: Vec<FileSpec>,
    }

    fn both32(n: u32) -> [u8; 8] {
        let mut b = [0u8; 8];
        put_u32le(&mut b, 0, n);
        put_u32be(&mut b, 4, n);
        b
    }

    fn dir_record(name: &str, lba: u32, size: u32, is_dir: bool, special: Option<u8>) -> Vec<u8> {
        let id: Vec<u8> = match special {
            Some(byte) => vec![byte],
            None => name.as_bytes().to_vec(),
        };
        let mut len = 33 + id.len();
        if len % 2 == 1 {
            len += 1; // records are padded to an even length
        }
        let mut r = vec![0u8; len];
        r[0] = len as u8;
        r[2..10].copy_from_slice(&both32(lba));
        r[10..18].copy_from_slice(&both32(size));
        r[25] = if is_dir { 0x02 } else { 0x00 };
        r[32] = id.len() as u8;
        r[33..33 + id.len()].copy_from_slice(&id);
        r
    }

    fn directory_sector(self_lba: u32, parent_lba: u32, children: Vec<Vec<u8>>) -> Vec<u8> {
        let mut out = vec![0u8; SECTOR];
        let mut off = 0;
        let parts = [
            vec![dir_record("", self_lba, SECTOR as u32, true, Some(0)), dir_record("", parent_lba, SECTOR as u32, true, Some(1))],
            children,
        ]
        .concat();
        for p in parts {
            out[off..off + p.len()].copy_from_slice(&p);
            off += p.len();
        }
        out
    }

    /// A minimal but genuinely valid ISO9660 image, built by hand rather than by mkisofs, which
    /// does not exist on Windows — and the point of the module under test is precisely that we no
    /// longer need such a tool. Sector plan: 0-15 reserved, 16 PVD, 17 terminator, 18 root dir,
    /// then one sector per subdirectory, then file contents.
    fn build_iso(files: Vec<FileSpec>, dirs: Vec<DirSpec>) -> Vec<u8> {
        let mut sectors: Vec<Option<Vec<u8>>> = Vec::new();
        let mut put = |index: usize, buf: Vec<u8>| {
            if sectors.len() <= index {
                sectors.resize(index + 1, None);
            }
            sectors[index] = Some(buf);
        };

        let mut next_lba = 19 + dirs.len();
        let mut placed: Vec<(&str, u32, u32)> = Vec::new();
        for f in files.iter().chain(dirs.iter().flat_map(|d| d.files.iter())) {
            let lba = next_lba;
            let count = f.data.len().div_ceil(SECTOR).max(1);
            next_lba += count;
            placed.push((f.name, lba as u32, f.data.len() as u32));
            let mut padded = vec![0u8; count * SECTOR];
            padded[..f.data.len()].copy_from_slice(&f.data);
            for i in 0..count {
                put(lba + i, padded[i * SECTOR..(i + 1) * SECTOR].to_vec());
            }
        }
        let at = |name: &str| *placed.iter().find(|(n, _, _)| *n == name).unwrap();

        for (i, d) in dirs.iter().enumerate() {
            let lba = 19 + i as u32;
            let children = d.files.iter().map(|f| dir_record(f.name, at(f.name).1, at(f.name).2, false, None)).collect();
            put(lba as usize, directory_sector(lba, 18, children));
        }
        let mut root_children: Vec<Vec<u8>> = files.iter().map(|f| dir_record(f.name, at(f.name).1, at(f.name).2, false, None)).collect();
        root_children.extend(dirs.iter().enumerate().map(|(i, d)| dir_record(d.name, 19 + i as u32, SECTOR as u32, true, None)));
        put(18, directory_sector(18, 18, root_children));

        let mut pvd = vec![0u8; SECTOR];
        pvd[0] = 1;
        pvd[1..6].copy_from_slice(b"CD001");
        pvd[6] = 1;
        let root = dir_record("", 18, SECTOR as u32, true, Some(0));
        pvd[156..156 + root.len()].copy_from_slice(&root);
        put(16, pvd);

        let mut term = vec![0u8; SECTOR];
        term[0] = 0xff;
        term[1..6].copy_from_slice(b"CD001");
        put(17, term);

        let mut out = vec![0u8; sectors.len() * SECTOR];
        for (i, sector) in sectors.iter().enumerate() {
            if let Some(sector) = sector {
                out[i * SECTOR..(i + 1) * SECTOR].copy_from_slice(sector);
            }
        }
        out
    }

    const KERNEL: &[u8] = b"\x1f\x8b fake bzImage payload";
    const INITRD: &[u8] = b"fake gzipped cpio payload";

    fn with_iso(files: Vec<FileSpec>, dirs: Vec<DirSpec>, check: impl FnOnce(&Path)) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("android.iso");
        std::fs::write(&file, build_iso(files, dirs)).unwrap();
        check(&file);
    }

    fn boot_payload(kernel: &'static str, initrd: &'static str) -> Vec<FileSpec> {
        vec![FileSpec { name: kernel, data: KERNEL.to_vec() }, FileSpec { name: initrd, data: INITRD.to_vec() }]
    }

    #[test]
    fn a_payload_at_the_media_root_is_found_with_an_empty_src() {
        with_iso(boot_payload("kernel", "initrd.img"), vec![], |file| {
            let boot = read_boot_files(file).unwrap();
            assert_eq!(boot.src_dir, "", "SRC= must be empty for a root payload");
            assert_eq!(boot.kernel, KERNEL);
            assert_eq!(boot.initrd, INITRD);
        });
    }

    #[test]
    fn a_payload_in_a_release_named_directory_yields_that_directory_as_src() {
        let dirs = vec![DirSpec { name: "android-9.0-r2", files: boot_payload("kernel", "initrd.img") }];
        with_iso(vec![], dirs, |file| {
            let boot = read_boot_files(file).unwrap();
            assert_eq!(boot.src_dir, "/android-9.0-r2");
            assert_eq!(boot.kernel, KERNEL);
        });
    }

    #[test]
    fn the_root_listing_skips_dot_and_dot_dot() {
        with_iso(boot_payload("kernel", "initrd.img"), vec![], |file| {
            let iso = IsoReader::open(file).unwrap();
            let mut names: Vec<String> = iso.list(&iso.root().unwrap()).unwrap().into_iter().map(|e| e.name).collect();
            names.sort();
            assert_eq!(names, vec!["initrd.img", "kernel"]);
        });
    }

    #[test]
    fn lookups_are_case_insensitive_and_ignore_the_iso_version_suffix() {
        with_iso(boot_payload("KERNEL;1", "INITRD.IMG;1"), vec![], |file| {
            let boot = read_boot_files(file).unwrap();
            assert_eq!(boot.kernel, KERNEL);
            assert_eq!(boot.initrd, INITRD);
        });
    }

    #[test]
    fn an_image_with_no_boot_files_is_refused_naming_what_it_looked_for() {
        with_iso(vec![FileSpec { name: "readme.txt", data: b"hello".to_vec() }], vec![], |file| {
            assert!(read_boot_files(file).unwrap_err().0.contains("no kernel and initrd.img found"));
        });
    }

    #[test]
    fn a_file_that_is_not_an_iso_is_refused_rather_than_misread() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("not.iso");
        std::fs::write(&file, vec![0x41u8; SECTOR * 20]).unwrap();
        assert!(read_boot_files(&file).unwrap_err().0.contains("not an ISO9660 image"));
    }

    #[test]
    fn reading_past_the_end_of_the_image_fails_instead_of_returning_garbage() {
        with_iso(boot_payload("kernel", "initrd.img"), vec![], |file| {
            let iso = IsoReader::open(file).unwrap();
            let entry = IsoEntry { name: "x".into(), is_directory: false, lba: 999_999, size: SECTOR as u32 };
            assert!(iso.read_file(&entry).unwrap_err().0.contains("read past the end"));
        });
    }
}
