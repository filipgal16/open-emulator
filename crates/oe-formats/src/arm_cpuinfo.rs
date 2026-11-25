//! The `/proc/cpuinfo` an ARM app sees on an x86 guest.
//!
//! Google's ARM translator (`libndk_translation`) does not pass the real `/proc/cpuinfo` through
//! to translated code; it is an x86 one, and ARM code would not know what to make of it. It
//! serves `/system/etc/cpuinfo.arm64.txt` (and `cpuinfo.arm.txt` for 32-bit) instead, and Google's
//! images ship those describing **one** processor, numbered 1:
//!
//! ```text
//! processor	: 1
//! BogoMIPS	: 1.00
//! Features	: fp asimd evtstrm aes pmull …
//! CPU implementer	: 0x41
//! ```
//!
//! An engine that counts cores from that file believes the device has one. Unity does: measured
//! on a 6-core guest it logged `SystemInfo CPU = x86-64, Cores = 1` and `1 big (mask: 0x2)`,
//! started no `Job.Worker` threads and no `UnityGfxDeviceWorker`, and ran the whole game on its
//! main thread. With the file listing six processors it logged `Cores = 6`, `6 big (mask: 0x3f)`,
//! and started five workers and the render thread.
//!
//! So the ROM repeats the stock entry once per guest core, numbered from 0 as the kernel does.
//! Everything else (the feature list, the implementer and part) stays byte-for-byte Google's:
//! it describes what the translator can execute, which is not ours to restate.

use crate::{fail, Result};

/// `^processor[ \t]*:[ \t]*\d+[ \t]*$`, for one line.
fn is_processor_line(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("processor") else { return false };
    let Some(rest) = rest.trim_start_matches([' ', '\t']).strip_prefix(':') else { return false };
    let rest = rest.trim_start_matches([' ', '\t']);
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    digits > 0 && rest[digits..].chars().all(|c| c == ' ' || c == '\t')
}

fn processor_lines(text: &str) -> Vec<(usize, usize)> {
    crate::bytes::js_line_spans(text)
        .into_iter()
        .filter(|&(start, end)| is_processor_line(&text[start..end]))
        .collect()
}

/// Splits on runs of two or more newlines: JavaScript's `text.split(/\n{2,}/)`.
fn split_blocks(text: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            let mut end = i;
            while end < bytes.len() && bytes[end] == b'\n' {
                end += 1;
            }
            blocks.push(&text[start..i]);
            start = end;
            i = end;
        } else {
            i += 1;
        }
    }
    blocks.push(&text[start..]);
    blocks
}

/// One entry per core, numbered from 0. Fails if `stock` is not the one-entry-or-more file
/// described above: an image that ships something else is one this transform was not measured
/// against.
pub fn expand_arm_cpuinfo(stock: &[u8], cores: u32) -> Result<Vec<u8>> {
    if cores < 1 {
        fail!("cannot describe {cores} CPU cores");
    }

    let text = String::from_utf8_lossy(stock).replace("\r\n", "\n");
    // Entries are separated by a blank line, as in the kernel's own output. The first one is the
    // template, so running this over a file that already lists several gives the same result.
    let Some(entry) = split_blocks(&text).into_iter().find(|block| !processor_lines(block).is_empty()) else {
        fail!("the cpuinfo file has no \"processor : N\" entry to repeat");
    };
    let template = entry.trim_matches('\n');
    let lines = processor_lines(template);
    if lines.len() != 1 {
        fail!("one cpuinfo entry names more than one processor");
    }
    let (start, end) = lines[0];

    let entries: Vec<String> = (0..cores)
        .map(|cpu| format!("{}processor\t: {cpu}{}", &template[..start], &template[end..]))
        .collect();
    // Each entry ends with a blank line, the last included: that is what the kernel prints, and
    // what a parser splitting on blank lines expects.
    Ok(format!("{}\n\n", entries.join("\n\n")).into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The two files as Google's API 34 Google APIs image ships them, byte for byte (tabs included).
    const STOCK_ARM64: &str = "processor\t: 1\n\
        BogoMIPS\t: 1.00\n\
        Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp\n\
        CPU implementer\t: 0x41\n\
        CPU architecture: 8\n\
        CPU variant\t: 0x6\n\
        CPU part\t: 0x802\n\
        CPU revision\t: 13\n";
    const STOCK_ARM: &str = "processor\t: 1\n\
        BogoMIPS\t: 1.00\n\
        Features\t: neon vfp swp half thumb fastmult edsp vfpv3 vfpv4 idiva idivt\n\
        CPU implementer\t: 0x41\n\
        CPU architecture: 8\n\
        CPU variant\t: 0x6\n\
        CPU part\t: 0x802\n\
        CPU revision\t: 13\n";

    /// `^processor\t: (\d+)$`, every match.
    fn processors(data: &[u8]) -> Vec<u32> {
        String::from_utf8_lossy(data)
            .split('\n')
            .filter_map(|line| line.strip_prefix("processor\t: ")?.parse().ok())
            .collect()
    }

    #[test]
    fn one_entry_becomes_one_per_core_numbered_from_0_as_the_kernel_numbers_them() {
        let out = expand_arm_cpuinfo(STOCK_ARM64.as_bytes(), 6).unwrap();
        assert_eq!(processors(&out), vec![0, 1, 2, 3, 4, 5]);
        // The stock file numbers its only processor 1, which is why Unity reported "mask: 0x2".
        assert_eq!(processors(STOCK_ARM64.as_bytes()), vec![1]);
    }

    #[test]
    fn every_entry_keeps_googles_lines_exactly_only_the_processor_number_differs() {
        let out = String::from_utf8(expand_arm_cpuinfo(STOCK_ARM64.as_bytes(), 3).unwrap()).unwrap();
        let entries: Vec<&str> = out.split("\n\n").filter(|e| !e.is_empty()).collect();
        assert_eq!(entries.len(), 3);
        let stock_body: Vec<&str> = STOCK_ARM64.trim_end().split('\n').skip(1).collect();
        for (cpu, entry) in entries.iter().enumerate() {
            let lines: Vec<&str> = entry.split('\n').collect();
            assert_eq!(lines[0], format!("processor\t: {cpu}"));
            assert_eq!(lines[1..], stock_body[..]);
        }
    }

    #[test]
    fn entries_are_separated_by_a_blank_line_and_the_file_ends_with_one() {
        let out = String::from_utf8(expand_arm_cpuinfo(STOCK_ARM.as_bytes(), 2).unwrap()).unwrap();
        assert!(out.ends_with("CPU revision\t: 13\n\n"));
        assert_eq!(out.split("\n\n").count(), 3, "two entries and the empty tail");
        assert!(!out.contains("\n\n\n"), "never two blank lines");
    }

    #[test]
    fn the_32_bit_file_is_expanded_the_same_way_and_keeps_its_own_feature_list() {
        let out = expand_arm_cpuinfo(STOCK_ARM.as_bytes(), 4).unwrap();
        assert_eq!(processors(&out), vec![0, 1, 2, 3]);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.matches("neon vfp swp half thumb").count(), 4);
        assert!(!text.contains("asimd"));
    }

    #[test]
    fn one_core_gives_one_entry_renumbered_to_0() {
        assert_eq!(processors(&expand_arm_cpuinfo(STOCK_ARM64.as_bytes(), 1).unwrap()), vec![0]);
    }

    #[test]
    fn expanding_an_already_expanded_file_gives_the_same_bytes() {
        let once = expand_arm_cpuinfo(STOCK_ARM64.as_bytes(), 8).unwrap();
        assert_eq!(expand_arm_cpuinfo(&once, 8).unwrap(), once);
        assert_eq!(processors(&expand_arm_cpuinfo(&once, 2).unwrap()), vec![0, 1], "and a smaller count shrinks it");
    }

    #[test]
    fn crlf_line_endings_are_read_and_written_back_as_lf() {
        let crlf = STOCK_ARM64.replace('\n', "\r\n");
        assert_eq!(
            expand_arm_cpuinfo(crlf.as_bytes(), 2).unwrap(),
            expand_arm_cpuinfo(STOCK_ARM64.as_bytes(), 2).unwrap()
        );
    }

    #[test]
    fn a_file_with_no_processor_entry_is_refused_rather_than_guessed_at() {
        for input in ["model name\t: something\n", ""] {
            let error = expand_arm_cpuinfo(input.as_bytes(), 4).unwrap_err().to_string();
            assert!(error.contains("no \"processor : N\" entry"), "{error}");
        }
    }

    #[test]
    fn an_entry_that_names_two_processors_is_refused() {
        let merged = "processor\t: 0\nprocessor\t: 1\nBogoMIPS\t: 1.00\n";
        assert!(expand_arm_cpuinfo(merged.as_bytes(), 2).unwrap_err().to_string().contains("more than one processor"));
    }

    #[test]
    fn a_core_count_of_zero_is_refused() {
        assert!(expand_arm_cpuinfo(STOCK_ARM64.as_bytes(), 0).unwrap_err().to_string().contains("cannot describe"));
    }

    #[test]
    fn processor_lines_follow_the_pattern() {
        assert!(is_processor_line("processor\t: 12"));
        assert!(is_processor_line("processor :3 \t"));
        assert!(!is_processor_line("processor\t: "));
        assert!(!is_processor_line("processors : 1"));
        assert!(!is_processor_line(" processor : 1"));
        assert!(!is_processor_line("processor : 1a"));
    }
}
