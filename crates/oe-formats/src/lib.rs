//! Pure codecs for the disk images, archives and file formats open-emulator reads and writes.
//!
//! Nothing here touches the network, spawns a process or knows about the UI. Every format is read
//! through [`ReadAt`] and written through [`WriteAt`], so the same code runs against a 3 GB image on
//! disk and against a few kilobytes built in memory by a test.
//!
//! Errors are plain sentences. They end up in the setup log the user reads, so each one says what
//! was expected and what was found rather than carrying a code.

pub mod arm_cpuinfo;
pub mod avb;
pub mod build_prop;
pub mod builder;
pub mod bytes;
pub mod cpio;
pub mod ext4;
pub mod gpt;
pub mod initrd;
pub mod iso9660;
pub mod lp;
pub mod qemu_args;
pub mod recipe;
pub mod recipe_compat;
pub mod recipes;
pub mod testing;
pub mod time;
pub mod wallpaper;
pub mod zip_archive;

use std::fmt;

/// A refusal or a failure, as a sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Error(error.to_string())
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Error(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Error(message.to_owned())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// `Err(Error(format!(...)))`, for use with `?` or `return`.
#[macro_export]
macro_rules! err {
    ($($arg:tt)*) => {
        $crate::Error(format!($($arg)*))
    };
}

/// Returns early with an [`Error`] built from a format string.
#[macro_export]
macro_rules! fail {
    ($($arg:tt)*) => {
        return Err($crate::Error(format!($($arg)*)))
    };
}

/// Random-access reads.
///
/// A read returns fewer bytes than asked only when the data ends; callers that need an exact
/// length check it themselves, because "the image is truncated" is the error worth reporting.
pub trait ReadAt {
    fn read_at(&mut self, offset: u64, len: usize) -> Result<Vec<u8>>;
}

/// Random-access writes. A write either lands in full or fails.
pub trait WriteAt {
    fn write_at(&mut self, offset: u64, data: &[u8]) -> Result<()>;
}

impl ReadAt for [u8] {
    fn read_at(&mut self, offset: u64, len: usize) -> Result<Vec<u8>> {
        Ok(slice_at(self, offset, len).to_vec())
    }
}

impl ReadAt for Vec<u8> {
    fn read_at(&mut self, offset: u64, len: usize) -> Result<Vec<u8>> {
        Ok(slice_at(self, offset, len).to_vec())
    }
}

impl WriteAt for Vec<u8> {
    fn write_at(&mut self, offset: u64, data: &[u8]) -> Result<()> {
        let start = usize::try_from(offset).map_err(|_| err!("write offset {offset} is out of range"))?;
        let end = start
            .checked_add(data.len())
            .ok_or_else(|| err!("write of {} bytes at {offset} overflows", data.len()))?;
        if end > self.len() {
            fail!("write of {} bytes at offset {offset} runs past the end ({} bytes)", data.len(), self.len());
        }
        self[start..end].copy_from_slice(data);
        Ok(())
    }
}

impl ReadAt for std::fs::File {
    fn read_at(&mut self, offset: u64, len: usize) -> Result<Vec<u8>> {
        fileio::read_up_to(self, offset, len)
    }
}

impl WriteAt for std::fs::File {
    fn write_at(&mut self, offset: u64, data: &[u8]) -> Result<()> {
        fileio::write_all(self, offset, data)
    }
}

/// Positional reads and writes through a shared `&File`, so several windows onto one image (a
/// GPT reader, four ext4 volumes, the vbmeta writer) can use a single open handle.
pub mod fileio {
    use std::fs::File;

    use crate::Result;

    #[cfg(windows)]
    pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        std::os::windows::fs::FileExt::seek_read(file, buf, offset)
    }

    #[cfg(windows)]
    pub fn write_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<usize> {
        std::os::windows::fs::FileExt::seek_write(file, buf, offset)
    }

    #[cfg(unix)]
    pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        std::os::unix::fs::FileExt::read_at(file, buf, offset)
    }

    #[cfg(unix)]
    pub fn write_at(file: &File, buf: &[u8], offset: u64) -> std::io::Result<usize> {
        std::os::unix::fs::FileExt::write_at(file, buf, offset)
    }

    /// Up to `length` bytes at `offset`; fewer only where the file ends.
    pub fn read_up_to(file: &File, offset: u64, length: usize) -> Result<Vec<u8>> {
        let mut out = vec![0u8; length];
        let mut done = 0;
        while done < length {
            let n = read_at(file, &mut out[done..], offset + done as u64)?;
            if n == 0 {
                break;
            }
            done += n;
        }
        out.truncate(done);
        Ok(out)
    }

    /// Exactly `length` bytes at `offset`, or an error naming where the file ran out.
    pub fn read_exact(file: &File, offset: u64, length: usize) -> Result<Vec<u8>> {
        let data = read_up_to(file, offset, length)?;
        if data.len() != length {
            fail!("short read at {}", offset + data.len() as u64);
        }
        Ok(data)
    }

    pub fn write_all(file: &File, offset: u64, data: &[u8]) -> Result<()> {
        let mut done = 0;
        while done < data.len() {
            let n = write_at(file, &data[done..], offset + done as u64)?;
            if n == 0 {
                fail!("short write at {}", offset + done as u64);
            }
            done += n;
        }
        Ok(())
    }
}

impl<T: ReadAt + ?Sized> ReadAt for &mut T {
    fn read_at(&mut self, offset: u64, len: usize) -> Result<Vec<u8>> {
        (**self).read_at(offset, len)
    }
}

impl<T: WriteAt + ?Sized> WriteAt for &mut T {
    fn write_at(&mut self, offset: u64, data: &[u8]) -> Result<()> {
        (**self).write_at(offset, data)
    }
}

/// A closure as a reader, for windows onto a larger file and for tests.
pub struct FnReader<F>(pub F);

impl<F: FnMut(u64, usize) -> Result<Vec<u8>>> ReadAt for FnReader<F> {
    fn read_at(&mut self, offset: u64, len: usize) -> Result<Vec<u8>> {
        (self.0)(offset, len)
    }
}

fn slice_at(data: &[u8], offset: u64, len: usize) -> &[u8] {
    let start = usize::try_from(offset).unwrap_or(usize::MAX).min(data.len());
    let end = start.saturating_add(len).min(data.len());
    &data[start..end]
}

/// JavaScript's `Number.MAX_SAFE_INTEGER`.
///
/// The TypeScript this was ported from refused any size or offset above it, and so does this:
/// a disk image with a byte count past 2^53 is damage, not a real device, and keeping the same
/// bound keeps both builders refusing the same images.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// JavaScript's `Math.round`: halves round towards positive infinity.
///
/// `f64::round` rounds halves away from zero, which differs for negative halves. Geometry that
/// was ported from TypeScript uses this so both produce the same pixels.
pub fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_matches_javascript() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.6), -3.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(7.0), 7.0);
    }

    #[test]
    fn slices_clamp_at_the_end() {
        let mut data = vec![1u8, 2, 3, 4];
        assert_eq!(data.read_at(2, 10).unwrap(), vec![3, 4]);
        assert_eq!(data.read_at(10, 2).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn writes_past_the_end_are_refused() {
        let mut data = vec![0u8; 4];
        assert!(data.write_at(3, &[1, 2]).is_err());
        data.write_at(2, &[7, 8]).unwrap();
        assert_eq!(data, vec![0, 0, 7, 8]);
    }
}
