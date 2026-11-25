//! Little- and big-endian field access on byte slices.
//!
//! Every on-disk structure here is a fixed layout read at known offsets. These panic on an
//! out-of-range offset, exactly like `Buffer.readUInt32LE` throws: callers size their buffers
//! from the structure they are reading, so an out-of-range read is a bug, not bad input.

#[inline]
pub fn u16le(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

#[inline]
pub fn u32le(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(data[at..at + 4].try_into().unwrap())
}

#[inline]
pub fn u64le(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

#[inline]
pub fn i32le(data: &[u8], at: usize) -> i32 {
    i32::from_le_bytes(data[at..at + 4].try_into().unwrap())
}

#[inline]
pub fn u16be(data: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([data[at], data[at + 1]])
}

#[inline]
pub fn u32be(data: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(data[at..at + 4].try_into().unwrap())
}

#[inline]
pub fn u64be(data: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(data[at..at + 8].try_into().unwrap())
}

#[inline]
pub fn put_u16le(data: &mut [u8], at: usize, value: u16) {
    data[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

#[inline]
pub fn put_u32le(data: &mut [u8], at: usize, value: u32) {
    data[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

#[inline]
pub fn put_u64le(data: &mut [u8], at: usize, value: u64) {
    data[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

#[inline]
pub fn put_u16be(data: &mut [u8], at: usize, value: u16) {
    data[at..at + 2].copy_from_slice(&value.to_be_bytes());
}

#[inline]
pub fn put_u32be(data: &mut [u8], at: usize, value: u32) {
    data[at..at + 4].copy_from_slice(&value.to_be_bytes());
}

#[inline]
pub fn put_u64be(data: &mut [u8], at: usize, value: u64) {
    data[at..at + 8].copy_from_slice(&value.to_be_bytes());
}

/// A fixed-size ASCII field, ended by the first NUL or the end of the field, decoded as Latin-1
/// (one char per byte, the way Node's `latin1` encoding reads it).
pub fn c_string(field: &[u8]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    latin1(&field[..end])
}

/// Bytes as Latin-1: every byte is the code point of the same value.
pub fn latin1(data: &[u8]) -> String {
    data.iter().map(|&b| b as char).collect()
}

/// `0x` and eight lower-case hex digits.
pub fn hex32(value: u32) -> String {
    format!("0x{value:08x}")
}

/// A string as JavaScript's `JSON.stringify` writes it: quoted, with `"` `\` and control
/// characters escaped, everything else as is. Error messages quote values this way so a stray
/// newline or tab is visible rather than breaking the line.
pub fn json_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// JavaScript's `\s`: the characters a JS regular expression treats as whitespace.
///
/// Not the same set as `char::is_whitespace` (JS includes U+FEFF and excludes U+0085), and the
/// difference decides what a ported validator accepts.
pub fn js_is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `str.trim()` as JavaScript does it: [`js_is_space`] and line terminators off both ends.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(js_is_space)
}

/// Splits on `\n`, dropping one `\r` before each `\n`: JavaScript's `text.split(/\r?\n/)`.
pub fn split_lines(text: &str) -> Vec<&str> {
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    pieces
        .into_iter()
        .enumerate()
        .map(|(i, piece)| if i < last { piece.strip_suffix('\r').unwrap_or(piece) } else { piece })
        .collect()
}

/// Line spans the way a JavaScript `m`-flag regex sees them: split at `\n`, `\r`, U+2028 and
/// U+2029. Each span excludes its terminator. Code ported from a multiline regex uses this so a
/// stray `\r` ends a line exactly as it did there.
pub fn js_line_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            spans.push((start, i));
            start = i + c.len_utf8();
        }
    }
    spans.push((start, text.len()));
    spans
}

/// Replaces the first line that starts with `prefix` (JavaScript's
/// `text.replace(/^<prefix>.*$/m, replacement)`) and leaves the text alone if there is none.
pub fn replace_first_line(text: &str, prefix: &str, replacement: &str) -> String {
    for (start, end) in js_line_spans(text) {
        if text[start..end].starts_with(prefix) {
            return format!("{}{replacement}{}", &text[..start], &text[end..]);
        }
    }
    text.to_owned()
}

/// Lower-case hex of every byte.
pub fn hex(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 2);
    for byte in data {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Parses lower- or upper-case hex. `None` on an odd length or a non-hex digit.
pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let mut data = [0u8; 16];
        put_u32le(&mut data, 0, 0xdeadbeef);
        put_u64be(&mut data, 4, 0x0102030405060708);
        put_u16le(&mut data, 12, 0xabcd);
        assert_eq!(u32le(&data, 0), 0xdeadbeef);
        assert_eq!(u64be(&data, 4), 0x0102030405060708);
        assert_eq!(u16le(&data, 12), 0xabcd);
        assert_eq!(data[4], 1);
    }

    #[test]
    fn c_strings_stop_at_nul() {
        assert_eq!(c_string(b"super\0\0junk"), "super");
        assert_eq!(c_string(b"full"), "full");
    }

    #[test]
    fn json_quote_matches_json_stringify() {
        assert_eq!(json_quote("a b"), "\"a b\"");
        assert_eq!(json_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(json_quote("a\nb\tc\u{1f}"), "\"a\\nb\\tc\\u001f\"");
        assert_eq!(json_quote("é"), "\"é\"");
    }

    #[test]
    fn split_lines_matches_the_js_regex_split() {
        assert_eq!(split_lines("a\r\nb\nc"), vec!["a", "b", "c"]);
        assert_eq!(split_lines("a\rb\n"), vec!["a\rb", ""]);
        assert_eq!(split_lines("a\r"), vec!["a\r"]);
        assert_eq!(split_lines(""), vec![""]);
    }

    #[test]
    fn js_whitespace_is_not_rust_whitespace() {
        assert!(js_is_space('\u{feff}'));
        assert!(!js_is_space('\u{85}'));
        assert_eq!(js_trim("\u{feff} x \n"), "x");
    }

    #[test]
    fn replace_first_line_replaces_only_the_first_match() {
        let text = "a=1\r\nTag=old\nTag=again\n";
        assert_eq!(replace_first_line(text, "Tag=", "Tag=new"), "a=1\r\nTag=new\nTag=again\n");
        assert_eq!(replace_first_line(text, "None=", "x"), text);
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(hex(&[0, 0xab, 0x10]), "00ab10");
        assert_eq!(from_hex("00AB10").unwrap(), vec![0, 0xab, 0x10]);
        assert!(from_hex("0").is_none());
        assert!(from_hex("zz").is_none());
    }
}
