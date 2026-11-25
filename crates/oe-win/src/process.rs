//! Other processes by pid: whether one is still running, what it is, and ending it.
//!
//! The Electron app asked `process.kill(pid, 0)`, which says only that *some* process holds the
//! pid. Windows hands pids out again quickly, so a pid file left behind by a guest that has since
//! exited can name an unrelated program later, and a stop would then end that program. Reading
//! the image name as well lets a caller check that the pid is still the process it recorded.

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

/// Closes the handle however the caller leaves.
struct Handle(HANDLE);

impl Handle {
    fn open(pid: u32, access: u32) -> Option<Handle> {
        if pid == 0 {
            return None;
        }
        // SAFETY: a plain open; a null result is a failure and is not wrapped.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        (!handle.is_null()).then_some(Handle(handle))
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle came from OpenProcess and is closed exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

/// The file name of a process's executable (`qemu-system-x86_64.exe`), if it is still running.
///
/// `None` both for a pid nothing holds and for one that has exited but is still referenced, which
/// is the case `process.kill(pid, 0)` got wrong: an exited process whose handle someone keeps open
/// still answers to its pid.
pub fn running_image_name(pid: u32) -> Option<String> {
    let process = Handle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?;
    let mut buffer = vec![0u16; 1024];
    let mut size = buffer.len() as u32;
    // SAFETY: the handle is live; the buffer and its length agree, and the API writes at most `size`.
    let (running, named) = unsafe {
        let running = WaitForSingleObject(process.0, 0) == WAIT_TIMEOUT;
        let named = QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size) != 0;
        (running, named)
    };
    if !running || !named {
        return None;
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    Some(path.rsplit(['\\', '/']).next().unwrap_or(&path).to_owned())
}

/// Whether a process holds this pid and has not exited.
pub fn is_running(pid: u32) -> bool {
    let Some(process) = Handle::open(pid, PROCESS_SYNCHRONIZE) else { return false };
    // SAFETY: the handle is live; a zero timeout only polls.
    unsafe { WaitForSingleObject(process.0, 0) == WAIT_TIMEOUT }
}

/// Ends a process at once. True if it was ended, or had already gone.
pub fn terminate(pid: u32) -> bool {
    let Some(process) = Handle::open(pid, PROCESS_TERMINATE | PROCESS_SYNCHRONIZE) else {
        return !is_running(pid);
    };
    // SAFETY: the handle is live and opened with the right to terminate.
    unsafe { TerminateProcess(process.0, 1) != 0 || WaitForSingleObject(process.0, 0) != WAIT_TIMEOUT }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_running_under_its_own_image_name() {
        let pid = std::process::id();
        assert!(is_running(pid));
        let own = std::env::current_exe().unwrap();
        let expected = own.file_name().unwrap().to_string_lossy().to_lowercase();
        assert_eq!(running_image_name(pid).map(|name| name.to_lowercase()), Some(expected));
    }

    #[test]
    fn a_process_that_has_exited_is_not_running_even_while_its_handle_is_held() {
        let mut child = std::process::Command::new("cmd.exe").args(["/c", "exit 0"]).spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        // `child` still holds the handle, so the pid still resolves to the exited process.
        assert!(!is_running(pid));
        assert_eq!(running_image_name(pid), None);
        drop(child);
    }

    #[test]
    fn terminating_ends_the_process() {
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(is_running(pid));
        assert!(terminate(pid));
        child.wait().unwrap();
        assert!(!is_running(pid));
    }

    #[test]
    fn pid_zero_is_never_a_running_process() {
        assert!(!is_running(0));
        assert_eq!(running_image_name(0), None);
    }
}
