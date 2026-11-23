//! Turning a child process's output bytes into lines.
//!
//! Windows tools do not agree on an encoding when their output is piped: most write UTF-8 (or the
//! console's code page, which is UTF-8-compatible for everything the SDK prints), while some —
//! `wsl.exe` most notoriously — write UTF-16LE, sometimes with a BOM. Decoding UTF-16 as UTF-8
//! produces text riddled with NUL bytes, so the encoding is detected from the first bytes.

/// Decodes one buffer of Windows process output, detecting UTF-16LE by its BOM or by the share of
/// NUL high bytes in the first 64.
pub fn decode_windows_process_output(buffer: &[u8]) -> String {
    match detect(buffer) {
        Some(true) => decode_utf16(buffer),
        _ => String::from_utf8_lossy(buffer).into_owned(),
    }
}

/// `Some(true)` for UTF-16LE, `Some(false)` for UTF-8, `None` when there is too little to tell.
fn detect(buffer: &[u8]) -> Option<bool> {
    if buffer.len() >= 2 && buffer[0] == 0xff && buffer[1] == 0xfe {
        return Some(true);
    }
    let sample = buffer.len().min(64);
    if sample < 4 {
        return if buffer.is_empty() { None } else { Some(false) };
    }
    let nulls = (1..sample).step_by(2).filter(|&i| buffer[i] == 0).count();
    Some(nulls as f64 / (sample / 2) as f64 > 0.8)
}

fn decode_utf16(buffer: &[u8]) -> String {
    let units: Vec<u16> = buffer.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
    let text = String::from_utf16_lossy(&units);
    text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text)
}

/// Splits a byte stream into whole lines, holding a partial line until the rest arrives.
///
/// [`flush`](LineSplitter::flush) must be called when the stream ends. A program's last line
/// frequently has no trailing newline, and without the flush that line vanishes — which is the
/// worst possible failure for a log, because the last thing a process says before dying is usually
/// the reason it died. Empty lines are not delivered.
#[derive(Default)]
pub struct LineSplitter {
    pending: Vec<u8>,
    utf16: Option<bool>,
}

impl LineSplitter {
    pub fn new() -> Self {
        LineSplitter::default()
    }

    pub fn push(&mut self, chunk: &[u8], mut on_line: impl FnMut(String)) {
        self.pending.extend_from_slice(chunk);
        if self.utf16.is_none() {
            self.utf16 = detect(&self.pending);
            if self.utf16 == Some(true) && self.pending.starts_with(&[0xff, 0xfe]) {
                self.pending.drain(..2);
            }
        }
        match self.utf16 {
            Some(true) => self.split_utf16(&mut on_line),
            Some(false) => self.split_utf8(&mut on_line),
            None => {}
        }
    }

    pub fn flush(&mut self, mut on_line: impl FnMut(String)) {
        let rest = std::mem::take(&mut self.pending);
        let text = if self.utf16 == Some(true) { decode_utf16(&rest) } else { String::from_utf8_lossy(&rest).into_owned() };
        let line = text.strip_suffix('\r').unwrap_or(&text);
        if !line.is_empty() {
            on_line(line.to_owned());
        }
    }

    fn split_utf8(&mut self, on_line: &mut impl FnMut(String)) {
        while let Some(newline) = self.pending.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=newline).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if !line.is_empty() {
                on_line(String::from_utf8_lossy(&line).into_owned());
            }
        }
    }

    fn split_utf16(&mut self, on_line: &mut impl FnMut(String)) {
        loop {
            let newline = self.pending.chunks_exact(2).position(|pair| pair == [b'\n', 0]);
            let Some(unit) = newline else { break };
            let mut line: Vec<u8> = self.pending.drain(..(unit + 1) * 2).collect();
            line.truncate(line.len() - 2);
            if line.ends_with(&[b'\r', 0]) {
                line.truncate(line.len() - 2);
            }
            if !line.is_empty() {
                on_line(decode_utf16(&line));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str, bom: bool) -> Vec<u8> {
        let mut out = if bom { vec![0xff, 0xfe] } else { Vec::new() };
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    fn lines_of(chunks: &[&[u8]]) -> Vec<String> {
        let mut splitter = LineSplitter::new();
        let mut out = Vec::new();
        for chunk in chunks {
            splitter.push(chunk, |line| out.push(line));
        }
        splitter.flush(|line| out.push(line));
        out
    }

    #[test]
    fn utf8_and_utf16_both_decode() {
        assert_eq!(decode_windows_process_output(b"plain text"), "plain text");
        assert_eq!(decode_windows_process_output(&utf16("Ubuntu Running", true)), "Ubuntu Running");
        assert_eq!(decode_windows_process_output(&utf16("Ubuntu Running", false)), "Ubuntu Running");
        assert_eq!(decode_windows_process_output(b""), "");
    }

    #[test]
    fn a_line_split_across_chunks_is_reassembled() {
        assert_eq!(lines_of(&[b"abc", b"def\nghi\r\n"]), vec!["abcdef", "ghi"]);
    }

    #[test]
    fn the_last_line_survives_without_a_newline() {
        assert_eq!(lines_of(&[b"no newline here"]), vec!["no newline here"]);
    }

    #[test]
    fn empty_lines_are_not_delivered() {
        assert_eq!(lines_of(&[b"a\n\n\r\nb\n"]), vec!["a", "b"]);
    }

    #[test]
    fn utf16_output_splits_into_lines_too() {
        let data = utf16("first\r\nsecond\nthird", true);
        let (head, tail) = data.split_at(9); // mid-character
        assert_eq!(lines_of(&[head, tail]), vec!["first", "second", "third"]);
    }

    #[test]
    fn a_multibyte_character_split_across_chunks_is_not_garbled() {
        let text = "naïve ✓\n".as_bytes();
        assert_eq!(lines_of(&[&text[..3], &text[3..8], &text[8..]]), vec!["naïve ✓"]);
    }
}
