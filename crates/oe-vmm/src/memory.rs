//! Guest RAM: a zeroed, page-aligned block of bytes.
//!
//! The C version used `mmap`, which hands out page-aligned memory. KVM requires the host address
//! of a memory slot to be page-aligned, and a plain `Vec<u8>` does not promise that, so the block
//! is allocated with an explicit alignment instead. Everywhere else it is simply a byte slice.

use std::alloc::{Layout, alloc_zeroed, dealloc};
use std::ops::{Deref, DerefMut};
use std::ptr::NonNull;

const PAGE_SIZE: usize = 4096;

/// An owned, zero-initialised, page-aligned byte buffer.
pub struct GuestRam {
    ptr: NonNull<u8>,
    len: usize,
}

// The buffer is uniquely owned heap memory, exactly like a `Vec<u8>`.
unsafe impl Send for GuestRam {}
unsafe impl Sync for GuestRam {}

impl GuestRam {
    /// Allocates `len` zero bytes, or returns `None` if the host cannot provide that much. A
    /// length of zero is allowed and yields an empty slice.
    pub fn new(len: usize) -> Option<Self> {
        if len == 0 {
            return Some(Self { ptr: NonNull::dangling(), len });
        }
        let layout = Layout::from_size_align(len, PAGE_SIZE).ok()?;
        // SAFETY: the layout has a non-zero size.
        let raw = unsafe { alloc_zeroed(layout) };
        NonNull::new(raw).map(|ptr| Self { ptr, len })
    }

    /// The host address of the first byte, for handing to a hypervisor.
    #[cfg(target_os = "linux")]
    pub(crate) fn host_address(&self) -> u64 {
        self.ptr.as_ptr() as u64
    }
}

impl Deref for GuestRam {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        // SAFETY: `ptr` is valid for `len` initialised bytes for as long as `self` lives.
        unsafe { std::slice::from_raw_parts(self.ptr.as_ptr(), self.len) }
    }
}

impl DerefMut for GuestRam {
    fn deref_mut(&mut self) -> &mut [u8] {
        // SAFETY: as above, and `&mut self` guarantees exclusive access.
        unsafe { std::slice::from_raw_parts_mut(self.ptr.as_ptr(), self.len) }
    }
}

impl Drop for GuestRam {
    fn drop(&mut self) {
        if self.len != 0 {
            let layout = Layout::from_size_align(self.len, PAGE_SIZE).expect("layout was valid at allocation");
            // SAFETY: allocated in `new` with this exact layout.
            unsafe { dealloc(self.ptr.as_ptr(), layout) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_zeroed_aligned_and_writable() {
        let mut ram = GuestRam::new(3 * PAGE_SIZE).unwrap();
        assert_eq!(ram.len(), 3 * PAGE_SIZE);
        assert!(ram.iter().all(|&byte| byte == 0));
        assert_eq!(ram.as_ptr() as usize % PAGE_SIZE, 0);
        ram[5] = 9;
        assert_eq!(ram[5], 9);
    }

    #[test]
    fn empty_is_fine() {
        assert!(GuestRam::new(0).unwrap().is_empty());
    }
}
