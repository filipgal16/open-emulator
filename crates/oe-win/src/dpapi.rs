//! DPAPI: data only this Windows user, on this machine, can read back.
//!
//! What Electron's `safeStorage` used underneath, called directly: the app's stored password is
//! encrypted with it, and so is the key Electron itself kept in `Local State`.

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

/// No UI, ever: a prompt from a background process would be a mystery to the person who sees it.
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr().cast_mut() }
}

/// Takes ownership of a blob DPAPI allocated, copying it out and freeing it.
unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    // SAFETY: DPAPI returned `cbData` bytes at `pbData`, allocated with LocalAlloc.
    unsafe {
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData.cast());
        bytes
    }
}

/// Encrypts `data` for the current user. `None` if Windows refuses.
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    let input = blob(data);
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: the input blob borrows `data` for the call; the output is freed by `take`.
    unsafe {
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        );
        (ok != 0).then(|| take(out))
    }
}

/// Decrypts what [`protect`] produced — for this user only. `None` for anything else, including
/// data from another user or another machine.
pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    let input = blob(data);
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: as for `protect`.
    unsafe {
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        );
        (ok != 0).then(|| take(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_protected_comes_back_and_only_for_the_real_thing() {
        let sealed = protect(b"correct horse battery staple").unwrap();
        assert_ne!(sealed.as_slice(), b"correct horse battery staple".as_slice());
        assert_eq!(unprotect(&sealed).unwrap(), b"correct horse battery staple");
        assert_eq!(unprotect(b"not a dpapi blob at all"), None);
    }
}
