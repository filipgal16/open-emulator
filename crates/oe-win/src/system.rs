//! Running something as administrator, services, and knowing when Windows wants a restart.
//!
//! The Electron app did each of these by starting a process — `powershell Start-Process -Verb
//! RunAs`, `sc.exe query`, `reg.exe query` — and parsing what it printed. These are the calls those
//! tools make themselves, without the second or so each process cost.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::time::Duration;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ};
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS,
    SERVICE_RUNNING, SERVICE_STATUS,
};
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, TerminateProcess, WaitForSingleObject};
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

/// A NUL-terminated UTF-16 copy, for the `W` APIs.
pub fn wide(text: impl AsRef<OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// One argument quoted the way `CommandLineToArgvW` and the C runtime read it back.
///
/// `ShellExecuteExW` takes the arguments as one string, so they have to be joined in a form the
/// child splits into exactly the values given: wrapped in quotes when they contain spaces, tabs or
/// quotes, with backslashes doubled only where they precede a quote.
pub fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// Why an elevated command did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElevationError {
    /// The user said no at the UAC prompt.
    Declined,
    /// It ran, and exited with this code.
    Failed(u32),
    TimedOut,
    /// It could not be started at all.
    Launch(String),
}

impl std::fmt::Display for ElevationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ElevationError::Declined => f.write_str("elevation was declined"),
            ElevationError::Failed(code) => write!(f, "the elevated command failed (exit {code})"),
            ElevationError::TimedOut => f.write_str("the elevated command timed out"),
            ElevationError::Launch(reason) => write!(f, "the elevated command could not start: {reason}"),
        }
    }
}

impl std::error::Error for ElevationError {}

/// Runs a command elevated, via a UAC prompt, and waits for it.
///
/// Succeeds only if the user accepts and the command exits 0. Declining is an error, which the
/// caller surfaces as a setup failure rather than a silent no-op — a setup step that quietly does
/// nothing is worse than one that fails, because the failure arrives later and somewhere else.
///
/// Blocking: call it from a worker thread.
pub fn run_elevated(file: &str, args: &[&str], timeout: Duration) -> Result<(), ElevationError> {
    let verb = wide("runas");
    let file_w = wide(file);
    let parameters = wide(args.iter().map(|a| quote_windows_arg(a)).collect::<Vec<_>>().join(" "));

    // SAFETY: the struct is zeroed and sized as the API requires; every string outlives the call.
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file_w.as_ptr();
        info.lpParameters = parameters.as_ptr();
        info.nShow = SW_HIDE;
        if ShellExecuteExW(&mut info) == 0 {
            let code = GetLastError();
            return Err(if code == ERROR_CANCELLED {
                ElevationError::Declined
            } else {
                ElevationError::Launch(format!("Win32 error {code}"))
            });
        }
        if info.hProcess.is_null() {
            // The shell handed the request to an existing process; there is nothing to wait for.
            return Ok(());
        }
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        let waited = WaitForSingleObject(info.hProcess, millis);
        if waited == WAIT_TIMEOUT {
            TerminateProcess(info.hProcess, 1);
            CloseHandle(info.hProcess);
            return Err(ElevationError::TimedOut);
        }
        let mut code = 1u32;
        let read = GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if waited != WAIT_OBJECT_0 || read == 0 {
            return Err(ElevationError::Launch(format!("could not wait for {file}")));
        }
        if code == 0 { Ok(()) } else { Err(ElevationError::Failed(code)) }
    }
}

/// Whether a key exists under `HKEY_LOCAL_MACHINE`.
pub fn hklm_key_exists(path: &str) -> bool {
    let path = wide(path);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: opens and immediately closes a registry key handle.
    unsafe {
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut key) != 0 {
            return false;
        }
        RegCloseKey(key);
    }
    true
}

/// True when Windows has staged feature changes that need a restart to take effect.
///
/// This is the trap that every "enable an optional feature" flow falls into. `DISM
/// /Enable-Feature` reports success, changes nothing observable, and stays that way until the
/// machine reboots — while every direct check keeps saying the feature is fine. The user sees a
/// green step immediately followed by a baffling failure two steps later, with no mention anywhere
/// of the one action that fixes it.
///
/// Only ever used to *explain* a failure, never to cause one: a reboot pending for unrelated
/// reasons (a Windows update) must not block setup on a machine where everything already works.
///
/// The CBS key is the one servicing sets when a feature is enabled but not yet live.
pub fn is_reboot_pending() -> bool {
    hklm_key_exists(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending")
}

/// Whether Windows is set to light mode for apps. `None` when it does not say (an older Windows).
pub fn apps_use_light_theme() -> Option<bool> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let value = wide("AppsUseLightTheme");
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: reads one DWORD into a buffer of exactly that size.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (status == 0).then_some(data != 0)
}

/// Installed physical memory in bytes, as Node's `os.totalmem()` reported it. `None` if Windows
/// will not say.
pub fn total_memory_bytes() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: the struct is zeroed and its length set, as the API requires.
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        (GlobalMemoryStatusEx(&mut status) != 0).then_some(status.ullTotalPhys)
    }
}

/// Whether a Windows service exists and is running.
pub fn is_service_running(name: &str) -> bool {
    let name = wide(name);
    // SAFETY: service-control handles opened read-only and closed on every path.
    unsafe {
        let manager = OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
        if manager.is_null() {
            return false;
        }
        let service = OpenServiceW(manager, name.as_ptr(), SERVICE_QUERY_STATUS);
        let running = if service.is_null() {
            false
        } else {
            let mut status: SERVICE_STATUS = std::mem::zeroed();
            let ok = QueryServiceStatus(service, &mut status) != 0 && status.dwCurrentState == SERVICE_RUNNING;
            CloseServiceHandle(service);
            ok
        };
        CloseServiceHandle(manager);
        running
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_are_quoted_the_way_argv_reads_them_back() {
        assert_eq!(quote_windows_arg("plain"), "plain");
        assert_eq!(quote_windows_arg(""), "\"\"");
        assert_eq!(quote_windows_arg("with space"), "\"with space\"");
        assert_eq!(quote_windows_arg(r"C:\Program Files\x"), r#""C:\Program Files\x""#);
        assert_eq!(quote_windows_arg(r#"say "hi""#), r#""say \"hi\"""#);
        // A trailing backslash would escape the closing quote unless doubled.
        assert_eq!(quote_windows_arg(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        // Backslashes not before a quote stay single.
        assert_eq!(quote_windows_arg(r"a\b c"), r#""a\b c""#);
    }

    #[test]
    fn the_machine_has_some_memory() {
        assert!(total_memory_bytes().is_some_and(|bytes| bytes > 256 * 1024 * 1024));
    }

    #[test]
    fn a_service_that_does_not_exist_is_not_running() {
        assert!(!is_service_running("definitely-not-a-service-xyz"));
    }

    #[test]
    fn a_key_that_does_not_exist_does_not() {
        assert!(!hklm_key_exists(r"SOFTWARE\open-emulator-test\does-not-exist"));
        assert!(hklm_key_exists(r"SOFTWARE\Microsoft"));
    }
}
