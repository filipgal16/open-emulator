//! Finds the emulator's QEMU process for an AVD by its command line.
//!
//! Exists because the pid we spawn is the wrong one to remember. `emulator.exe` is a launcher: it
//! starts `qemu-system-x86_64.exe` and forwards its output, and when the app that spawned it
//! exits, the launcher's stdio pipes close and the launcher goes with them, while QEMU carries on
//! running the guest. The pid file then names a dead process, `status` reports a running guest as
//! stopped, nothing embeds its window, and the next `start` boots a second emulator against the
//! same AVD. Observed exactly that way after the first app restart.
//!
//! The AVD name is on QEMU's command line as `-avd <name>`, which is enough to find it again. The
//! Electron app asked PowerShell for the command lines; this asks WMI directly.

use std::time::Duration;

use oe_formats::bytes::js_is_space;

pub const QEMU_IMAGE: &str = "qemu-system-x86_64.exe";

/// The images a recorded emulator pid may belong to: the launcher this app spawns, and the QEMU it
/// starts, which the pid file is switched to once found. A recorded pid now held by anything else
/// is a reused pid, not the guest.
pub fn is_emulator_image(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "emulator.exe" || name.starts_with("qemu-system-")
}

/// Picks the pid whose command line names this AVD. Pure, so the matching can be tested.
pub fn match_qemu_pid(processes: &[(u32, String)], avd_name: &str) -> Option<u32> {
    processes
        .iter()
        .find(|(pid, command_line)| *pid > 0 && names_avd(command_line, avd_name))
        .map(|(pid, _)| *pid)
}

/// `(?:^|\s)-avd\s+"?NAME"?(?:\s|$)`: the AVD as a whole argument, so a name that is a prefix of
/// another AVD's does not match it.
fn names_avd(command_line: &str, avd_name: &str) -> bool {
    if avd_name.is_empty() {
        return false;
    }
    command_line.match_indices("-avd").any(|(at, flag)| {
        let after_space = command_line[..at].chars().next_back().is_none_or(js_is_space);
        let rest = &command_line[at + flag.len()..];
        let value = rest.trim_start_matches(js_is_space);
        if !after_space || value.len() == rest.len() {
            return false;
        }
        let value = value.strip_prefix('"').unwrap_or(value);
        let Some(tail) = value.strip_prefix(avd_name) else { return false };
        let tail = tail.strip_prefix('"').unwrap_or(tail);
        tail.chars().next().is_none_or(js_is_space)
    })
}

/// The running QEMU for this AVD, if there is one. Never the reason a status poll fails: every
/// error, and a query that hangs, reads as "not found".
pub async fn find_qemu_pid(avd_name: &str) -> Option<u32> {
    let avd = avd_name.to_owned();
    let query = tokio::task::spawn_blocking(move || find_qemu_pid_blocking(&avd));
    tokio::time::timeout(Duration::from_secs(15), query).await.ok()?.ok()?
}

/// [`find_qemu_pid`] for a caller already on a worker thread.
pub fn find_qemu_pid_blocking(avd_name: &str) -> Option<u32> {
    #[cfg(windows)]
    {
        match_qemu_pid(&oe_win::wmi_probe::processes_named(QEMU_IMAGE), avd_name)
    }
    #[cfg(not(windows))]
    {
        let _ = avd_name;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn processes() -> Vec<(u32, String)> {
        vec![
            (
                25448,
                r#""C:\sdk\emulator\qemu\windows-x86_64\qemu-system-x86_64.exe" -avd OpenEmulator_API30_fast -gpu host -accel on"#.into(),
            ),
            (31000, r#""C:\sdk\emulator\qemu\windows-x86_64\qemu-system-x86_64.exe" -avd OpenEmulator_API30_play -gpu host"#.into()),
        ]
    }

    #[test]
    fn finds_the_qemu_process_by_the_avd_on_its_command_line() {
        assert_eq!(match_qemu_pid(&processes(), "OpenEmulator_API30_fast"), Some(25448));
        assert_eq!(match_qemu_pid(&processes(), "OpenEmulator_API30_play"), Some(31000));
    }

    #[test]
    fn a_name_that_is_a_prefix_of_another_avd_does_not_match_it() {
        // `OpenEmulator_API30` must not adopt the `_fast` guest: `start` would then skip booting the
        // profile that was actually asked for.
        assert_eq!(match_qemu_pid(&processes(), "OpenEmulator_API30"), None);
    }

    #[test]
    fn no_process_an_unreadable_command_line_and_pid_zero_all_read_as_not_found() {
        assert_eq!(match_qemu_pid(&[], "x"), None);
        let odd = vec![(7, String::new()), (8, "   ".into()), (0, "qemu -avd x".into()), (9, "qemu-avd x".into())];
        assert_eq!(match_qemu_pid(&odd, "x"), None);
    }

    #[test]
    fn a_quoted_name_and_a_name_at_the_end_of_the_line_both_match() {
        assert_eq!(match_qemu_pid(&[(5, r#"qemu -avd "Pixel_A""#.into())], "Pixel_A"), Some(5));
        assert_eq!(match_qemu_pid(&[(6, "qemu -gpu host -avd Pixel_A".into())], "Pixel_A"), Some(6));
        assert_eq!(match_qemu_pid(&[(7, "qemu -avd\tPixel_A\t-no-window".into())], "Pixel_A"), Some(7));
        assert_eq!(match_qemu_pid(&[(8, "qemu -avd Pixel_A2".into())], "Pixel_A"), None);
        assert_eq!(match_qemu_pid(&[(9, "qemu x-avd Pixel_A".into())], "Pixel_A"), None);
    }

    #[test]
    fn only_the_launcher_and_qemu_count_as_the_emulator() {
        assert!(is_emulator_image("emulator.exe"));
        assert!(is_emulator_image("QEMU-SYSTEM-X86_64.EXE"));
        assert!(is_emulator_image("qemu-system-x86_64-headless.exe"));
        assert!(!is_emulator_image("notepad.exe"));
    }
}
