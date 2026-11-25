//! Fixtures other crates' tests build archives with. Small, dependency-free, and compiled always,
//! so a test anywhere in the workspace can make a real zip without a tool.

use std::io::Write;

use flate2::write::DeflateEncoder;
use flate2::Compression;

use crate::bytes::{put_u16le, put_u32le, put_u64le};

/// One member of a test archive.
pub struct ZipFile<'a> {
    pub name: &'a str,
    pub data: &'a [u8],
    pub deflate: bool,
}

impl<'a> ZipFile<'a> {
    pub fn stored(name: &'a str, data: &'a [u8]) -> Self {
        ZipFile { name, data, deflate: false }
    }

    pub fn deflated(name: &'a str, data: &'a [u8]) -> Self {
        ZipFile { name, data, deflate: true }
    }
}

fn zip64_extra(values: &[u64]) -> Vec<u8> {
    let mut extra = vec![0u8; 4 + values.len() * 8];
    put_u16le(&mut extra, 0, 0x0001);
    put_u16le(&mut extra, 2, (values.len() * 8) as u16);
    for (i, &value) in values.iter().enumerate() {
        put_u64le(&mut extra, 4 + i * 8, value);
    }
    extra
}

/// A genuine PKZIP archive built in memory, by hand, so the fixture depends on nothing, with
/// deflate and zip64 as options, since bundles use both.
///
/// With `zip64`, every size and offset is written as the 0xFFFFFFFF placeholder with its real
/// value in a zip64 extra field, and the end of the archive carries the zip64 record and locator:
/// the layout a writer produces for an archive past 4 GB, at a size a test can afford.
pub fn make_zip(files: &[ZipFile], zip64: bool) -> Vec<u8> {
    let mut locals: Vec<u8> = Vec::new();
    let mut directory: Vec<u8> = Vec::new();

    for file in files {
        let method: u16 = if file.deflate { 8 } else { 0 };
        let packed = if file.deflate {
            let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(file.data).unwrap();
            encoder.finish().unwrap()
        } else {
            file.data.to_vec()
        };
        let crc = crc32fast::hash(file.data);
        let name = file.name.as_bytes();
        let offset = locals.len() as u64;

        let local_extra = if zip64 { zip64_extra(&[file.data.len() as u64, packed.len() as u64]) } else { Vec::new() };
        let mut head = vec![0u8; 30];
        put_u32le(&mut head, 0, 0x04034b50);
        put_u16le(&mut head, 4, if zip64 { 45 } else { 20 });
        put_u16le(&mut head, 6, 0x0800);
        put_u16le(&mut head, 8, method);
        put_u32le(&mut head, 14, crc);
        put_u32le(&mut head, 18, if zip64 { 0xffffffff } else { packed.len() as u32 });
        put_u32le(&mut head, 22, if zip64 { 0xffffffff } else { file.data.len() as u32 });
        put_u16le(&mut head, 26, name.len() as u16);
        put_u16le(&mut head, 28, local_extra.len() as u16);
        locals.extend_from_slice(&head);
        locals.extend_from_slice(name);
        locals.extend_from_slice(&local_extra);
        locals.extend_from_slice(&packed);

        let central_extra =
            if zip64 { zip64_extra(&[file.data.len() as u64, packed.len() as u64, offset]) } else { Vec::new() };
        let mut entry = vec![0u8; 46];
        put_u32le(&mut entry, 0, 0x02014b50);
        put_u16le(&mut entry, 4, if zip64 { 45 } else { 20 });
        put_u16le(&mut entry, 6, if zip64 { 45 } else { 20 });
        put_u16le(&mut entry, 8, 0x0800);
        put_u16le(&mut entry, 10, method);
        put_u32le(&mut entry, 16, crc);
        put_u32le(&mut entry, 20, if zip64 { 0xffffffff } else { packed.len() as u32 });
        put_u32le(&mut entry, 24, if zip64 { 0xffffffff } else { file.data.len() as u32 });
        put_u16le(&mut entry, 28, name.len() as u16);
        put_u16le(&mut entry, 30, central_extra.len() as u16);
        put_u32le(&mut entry, 42, if zip64 { 0xffffffff } else { offset as u32 });
        directory.extend_from_slice(&entry);
        directory.extend_from_slice(name);
        directory.extend_from_slice(&central_extra);
    }

    let offset = locals.len() as u64;
    let mut out = locals;
    out.extend_from_slice(&directory);

    if zip64 {
        let mut record = vec![0u8; 56];
        put_u32le(&mut record, 0, 0x06064b50);
        put_u64le(&mut record, 4, 44);
        put_u16le(&mut record, 12, 45);
        put_u16le(&mut record, 14, 45);
        put_u64le(&mut record, 24, files.len() as u64);
        put_u64le(&mut record, 32, files.len() as u64);
        put_u64le(&mut record, 40, directory.len() as u64);
        put_u64le(&mut record, 48, offset);
        let mut locator = vec![0u8; 20];
        put_u32le(&mut locator, 0, 0x07064b50);
        put_u64le(&mut locator, 8, offset + directory.len() as u64);
        put_u32le(&mut locator, 16, 1);
        out.extend_from_slice(&record);
        out.extend_from_slice(&locator);
    }

    let mut end = vec![0u8; 22];
    put_u32le(&mut end, 0, 0x06054b50);
    put_u16le(&mut end, 8, if zip64 { 0xffff } else { files.len() as u16 });
    put_u16le(&mut end, 10, if zip64 { 0xffff } else { files.len() as u16 });
    put_u32le(&mut end, 12, if zip64 { 0xffffffff } else { directory.len() as u32 });
    put_u32le(&mut end, 16, if zip64 { 0xffffffff } else { offset as u32 });
    out.extend_from_slice(&end);
    out
}

/// A stand-in APK: a zip with a manifest at its root, which is all bundle detection looks for.
pub fn fake_apk(tag: &str) -> Vec<u8> {
    let manifest = format!("manifest for {tag}");
    let code = format!("code for {tag}").repeat(50);
    make_zip(
        &[ZipFile::deflated("AndroidManifest.xml", manifest.as_bytes()), ZipFile::deflated("classes.dex", code.as_bytes())],
        false,
    )
}
