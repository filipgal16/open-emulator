//! Patching the Android-x86 initrd so the guest is reachable over adb.
//!
//! There is no USB to emulate, so adb has to arrive over TCP, and `adbd` only listens on TCP when
//! `service.adb.tcp.port` is set. Getting that property in is the whole problem, and the initrd is
//! the small honest place to do it:
//!
//!   `/data/property` does not work. Android 9 keeps persistent properties in a single protobuf
//!   blob rather than one file per property, so seeding an empty data disk achieves nothing.
//!
//!   Editing `system.sfs` means unpacking and repacking 942 MB to change one line.
//!
//!   The initrd is about 1.3 MB and *already* writes to `default.prop` immediately before handing
//!   over to Android; that is how it disables the setup wizard. Adding three lines beside that is
//!   a few hundred bytes of change to a file that is rebuilt on every prepare anyway.
//!
//! `ro.adb.secure` and `ro.secure` go in the same edit for a related reason: with adb
//! authentication on, the first connection waits for someone to accept a key prompt on a screen
//! nobody is looking at.
//!
//! The patch itself is shell: it runs inside the guest's initrd, where `sh` is what there is.

use std::fmt;
use std::io::{Read, Write};

use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::cpio::{build_cpio, find_entry, parse_cpio, replace_entry};

/// The line the stock initrd uses to disable the setup wizard: our insertion point.
const ANCHOR: &str = "ro.setupwizard.mode=DISABLED";

pub const ADB_TCP_PORT: u16 = 5555;

/// A refusal to patch an initrd, distinguishable from other failures so callers can say what
/// went wrong with the image rather than with the disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitrdPatchError(pub String);

impl fmt::Display for InitrdPatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InitrdPatchError {}

impl From<InitrdPatchError> for crate::Error {
    fn from(error: InitrdPatchError) -> Self {
        crate::Error(error.0)
    }
}

/// Shell inserted into the initrd's `init`, immediately after the anchor.
///
/// Existing assignments are stripped before the new ones are appended, because `default.prop` is
/// read top to bottom and a later duplicate does not reliably win, leaving the original in place
/// would make the result depend on Android's property-loading order rather than on this edit.
///
/// Tab-indented to match the surrounding script.
fn patch_script(port: u16) -> String {
    [
        String::new(),
        "\t# open-emulator: adbd only listens on TCP when this property is set, and there is no USB to".into(),
        "\t# emulate. Written here because the initrd owns default.prop right up until Android starts.".into(),
        "\tgrep -v -E '^(service\\.adb\\.tcp\\.port|ro\\.adb\\.secure|ro\\.secure)=' default.prop > oe.prop".into(),
        format!("\tprintf 'service.adb.tcp.port={port}\\nro.adb.secure=0\\nro.secure=0\\n' >> oe.prop"),
        "\tmv oe.prop default.prop".into(),
    ]
    .join("\n")
}

/// Inserts the patch after the anchor line in `init`.
///
/// Separate from the archive handling so the text transformation can be tested without building a
/// cpio, and so a future Android-x86 release that moves the anchor fails here with a clear message
/// rather than producing a silently unpatched initrd.
pub fn patch_init_script(script: &str, port: u16) -> Result<String, InitrdPatchError> {
    if script.contains("service.adb.tcp.port") {
        // Already patched. Returning it unchanged keeps `prepare` idempotent, and re-running the
        // insertion would stack duplicate blocks on every call.
        return Ok(script.to_owned());
    }

    let mut lines: Vec<String> = script.split('\n').map(str::to_owned).collect();
    let Some(anchor) = lines.iter().position(|line| line.contains(ANCHOR)) else {
        return Err(InitrdPatchError(format!(
            "could not find \"{ANCHOR}\" in the initrd's init script; this Android-x86 build is not one this patch understands"
        )));
    };

    lines.insert(anchor + 1, patch_script(port));
    Ok(lines.join("\n"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchResult {
    /// The gzipped, repacked initrd, ready to hand to QEMU as `-initrd`.
    pub image: Vec<u8>,
    pub entry_count: usize,
    pub already_patched: bool,
}

/// Reads a gzipped initrd, patches `init`, and repacks it.
///
/// Every other entry is passed through untouched, including its mode, which matters more than it
/// sounds, because `init` is the one file whose executable bit the kernel absolutely requires.
pub fn patch_initrd(gzipped: &[u8], port: u16) -> Result<PatchResult, InitrdPatchError> {
    let mut raw = Vec::new();
    MultiGzDecoder::new(gzipped)
        .read_to_end(&mut raw)
        .map_err(|error| InitrdPatchError(format!("the initrd is not gzip-compressed: {error}")))?;

    let mut entries = parse_cpio(&raw).map_err(|error| InitrdPatchError(error.0))?;

    let Some(init) = find_entry(&entries, "init") else {
        return Err(InitrdPatchError("the initrd contains no init; it is not an Android-x86 boot image".into()));
    };
    let already_patched = String::from_utf8_lossy(&init.data).contains("service.adb.tcp.port");

    let mut failure = None;
    replace_entry(&mut entries, "init", |previous| match patch_init_script(&String::from_utf8_lossy(previous), port) {
        Ok(text) => text.into_bytes(),
        Err(error) => {
            failure = Some(error);
            previous.to_vec()
        }
    });
    if let Some(error) = failure {
        return Err(error);
    }

    // Belt and braces: a patch that silently did nothing produces a guest that boots fine and is
    // simply unreachable, which is a far worse failure than refusing here.
    let after = find_entry(&entries, "init").expect("found above");
    if !String::from_utf8_lossy(&after.data).contains("service.adb.tcp.port") {
        return Err(InitrdPatchError("the initrd patch did not apply".into()));
    }

    let compress_failed = |error: std::io::Error| InitrdPatchError(format!("could not compress the initrd: {error}"));
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(9));
    encoder.write_all(&build_cpio(&entries)).map_err(compress_failed)?;
    let image = encoder.finish().map_err(compress_failed)?;

    Ok(PatchResult { image, entry_count: entries.len(), already_patched })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cpio::CpioEntry;

    // A believable slice of the real Android-x86 init: the anchor sits inside a block that is
    // already editing default.prop, which is exactly why it is the right place to insert.
    const INIT: &str = "#!/bin/sh\nmount_data()\n{\n\techo \"mounting data\"\n}\n\nsetup_wizard()\n{\n\techo ro.setupwizard.mode=DISABLED >> default.prop\n\techo \"wizard disabled\"\n}\n\nexec /init";

    fn entry(name: &str, data: &str, mode: u32) -> CpioEntry {
        CpioEntry { name: name.into(), mode, data: data.as_bytes().to_vec(), ino: 1, nlink: 1, ..CpioEntry::default() }
    }

    fn image(entries: &[CpioEntry]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&build_cpio(entries)).unwrap();
        encoder.finish().unwrap()
    }

    fn gunzip(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        MultiGzDecoder::new(data).read_to_end(&mut out).unwrap();
        out
    }

    fn init_of(gzipped: &[u8]) -> String {
        let entries = parse_cpio(&gunzip(gzipped)).unwrap();
        String::from_utf8(find_entry(&entries, "init").unwrap().data.clone()).unwrap()
    }

    #[test]
    fn the_patch_lands_immediately_after_the_anchor() {
        let out = patch_init_script(INIT, ADB_TCP_PORT).unwrap();
        let lines: Vec<&str> = out.split('\n').collect();
        let anchor = lines.iter().position(|l| l.contains("ro.setupwizard.mode=DISABLED")).unwrap();
        assert!(lines[anchor..anchor + 8].join("\n").contains("service.adb.tcp.port=5555"));
    }

    #[test]
    fn adb_authentication_is_disabled_in_the_same_edit() {
        let out = patch_init_script(INIT, ADB_TCP_PORT).unwrap();
        assert!(out.contains("ro.adb.secure=0"));
        assert!(out.contains("ro.secure=0"));
    }

    #[test]
    fn existing_assignments_are_stripped_before_the_new_ones_are_appended() {
        assert!(patch_init_script(INIT, ADB_TCP_PORT).unwrap().contains("grep -v -E '^(service\\.adb\\.tcp\\.port"));
    }

    #[test]
    fn patching_twice_is_a_no_op_rather_than_stacking_duplicate_blocks() {
        let once = patch_init_script(INIT, ADB_TCP_PORT).unwrap();
        assert_eq!(patch_init_script(&once, ADB_TCP_PORT).unwrap(), once);
        assert_eq!(once.matches("service.adb.tcp.port=5555").count(), 1);
    }

    #[test]
    fn a_build_without_the_anchor_fails_loudly() {
        let error = patch_init_script("#!/bin/sh\nexec /init\n", ADB_TCP_PORT).unwrap_err();
        assert!(error.0.contains("could not find \"ro.setupwizard.mode=DISABLED\""));
    }

    #[test]
    fn a_custom_port_is_honoured() {
        assert!(patch_init_script(INIT, 5599).unwrap().contains("service.adb.tcp.port=5599"));
        assert_eq!(ADB_TCP_PORT, 5555);
    }

    #[test]
    fn a_real_initrd_round_trips_patched_with_every_other_entry_intact() {
        let result = patch_initrd(
            &image(&[entry("init", INIT, 0o100755), entry("etc/fstab", "none / rootfs\n", 0o100644), entry("sbin", "", 0o040755)]),
            ADB_TCP_PORT,
        )
        .unwrap();
        let entries = parse_cpio(&gunzip(&result.image)).unwrap();
        assert_eq!(result.entry_count, 3);
        assert!(!result.already_patched);
        assert!(init_of(&result.image).contains("service.adb.tcp.port=5555"));
        assert_eq!(find_entry(&entries, "etc/fstab").unwrap().data, b"none / rootfs\n");
    }

    #[test]
    fn init_keeps_its_executable_bit_which_the_kernel_requires() {
        let result = patch_initrd(&image(&[entry("init", INIT, 0o100755)]), ADB_TCP_PORT).unwrap();
        let entries = parse_cpio(&gunzip(&result.image)).unwrap();
        assert_eq!(find_entry(&entries, "init").unwrap().mode & 0o111, 0o111, "an init without +x does not boot");
    }

    #[test]
    fn the_output_is_gzip_so_qemu_can_load_it_directly() {
        let out = patch_initrd(&image(&[entry("init", INIT, 0o100755)]), ADB_TCP_PORT).unwrap().image;
        assert_eq!(out[..2], [0x1f, 0x8b]);
    }

    #[test]
    fn re_patching_an_already_patched_image_is_reported_and_stays_valid() {
        let once = patch_initrd(&image(&[entry("init", INIT, 0o100755)]), ADB_TCP_PORT).unwrap();
        let twice = patch_initrd(&once.image, ADB_TCP_PORT).unwrap();
        assert!(twice.already_patched);
        assert_eq!(init_of(&twice.image).matches("service.adb.tcp.port=5555").count(), 1, "no duplicate blocks");
    }

    #[test]
    fn an_image_with_no_init_is_refused() {
        let error = patch_initrd(&image(&[entry("etc/fstab", "x", 0o100644)]), ADB_TCP_PORT).unwrap_err();
        assert!(error.0.contains("contains no init"));
    }

    #[test]
    fn data_that_is_not_gzip_is_refused_with_a_clear_reason() {
        let error = patch_initrd(b"not compressed at all", ADB_TCP_PORT).unwrap_err();
        assert!(error.0.contains("not gzip-compressed"));
    }
}
