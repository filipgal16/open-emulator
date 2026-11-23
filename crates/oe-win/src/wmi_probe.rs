//! The WMI questions the app asks: which processes are running with which command lines, whether
//! a Windows feature is on, whether a hypervisor is loaded, and what Defender excludes.
//!
//! The Electron app asked these through `powershell Get-CimInstance`, a second or more each. WMI is
//! what that cmdlet talks to; asking it directly is the same answer without the shell.
//!
//! Every function here opens its own connection on the calling thread, because COM connections
//! may not cross threads. They block for tens of milliseconds, so call them from a worker thread.
//! None of them fails: an error reads as "not found" or "unknown", so a probe can never be the
//! reason the app does not start.

use std::collections::HashMap;

use serde::Deserialize;
use wmi::{FilterValue, WMIConnection};

#[derive(Deserialize)]
#[serde(rename = "Win32_Process")]
#[serde(rename_all = "PascalCase")]
struct Process {
    process_id: u32,
    command_line: Option<String>,
}

/// Every running process with this image name, as `(pid, command line)`. The command line is
/// empty when Windows will not show it (another user's process).
pub fn processes_named(image: &str) -> Vec<(u32, String)> {
    let Ok(connection) = WMIConnection::new() else { return Vec::new() };
    let filters = HashMap::from([("Name".to_owned(), FilterValue::String(image.to_owned()))]);
    match connection.filtered_query::<Process>(&filters) {
        Ok(processes) => processes.into_iter().map(|p| (p.process_id, p.command_line.unwrap_or_default())).collect(),
        Err(_) => Vec::new(),
    }
}

#[derive(Deserialize)]
#[serde(rename = "Win32_OptionalFeature")]
#[serde(rename_all = "PascalCase")]
struct OptionalFeature {
    install_state: u32,
}

/// Whether an optional Windows feature is enabled (`InstallState = 1`).
///
/// Asked through WMI rather than `DISM /Get-FeatureInfo` because DISM's online image operations
/// want elevation, and this runs at startup in an unelevated app.
pub fn is_optional_feature_enabled(name: &str) -> bool {
    let Ok(connection) = WMIConnection::new() else { return false };
    let filters = HashMap::from([("Name".to_owned(), FilterValue::String(name.to_owned()))]);
    connection
        .filtered_query::<OptionalFeature>(&filters)
        .map(|features| features.iter().any(|f| f.install_state == 1))
        .unwrap_or(false)
}

#[derive(Deserialize)]
#[serde(rename = "Win32_ComputerSystem")]
#[serde(rename_all = "PascalCase")]
struct ComputerSystem {
    hypervisor_present: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename = "Win32_Processor")]
#[serde(rename_all = "PascalCase")]
struct Processor {
    virtualization_firmware_enabled: Option<bool>,
}

/// Whether a hypervisor is loaded right now.
pub fn is_hypervisor_present() -> bool {
    let Ok(connection) = WMIConnection::new() else { return false };
    connection
        .query::<ComputerSystem>()
        .map(|systems| systems.iter().any(|s| s.hypervisor_present == Some(true)))
        .unwrap_or(false)
}

/// Whether the first processor reports virtualization enabled in firmware.
///
/// Reads `False` once a hypervisor has taken the setting for itself, which is why callers ask
/// [`is_hypervisor_present`] too.
pub fn is_virtualization_firmware_enabled() -> bool {
    let Ok(connection) = WMIConnection::new() else { return false };
    connection
        .query::<Processor>()
        .map(|processors| processors.first().is_some_and(|p| p.virtualization_firmware_enabled == Some(true)))
        .unwrap_or(false)
}

#[derive(Deserialize)]
#[serde(rename = "MSFT_MpPreference")]
#[serde(rename_all = "PascalCase")]
struct MpPreference {
    exclusion_path: Option<Vec<String>>,
}

/// What Defender's exclusion list says, when it can be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DefenderExclusions {
    /// Defender answered; the list may be empty.
    Paths(Vec<String>),
    /// Defender is absent, managed elsewhere, or will not show its list to this user.
    Unknown,
}

/// Defender's excluded paths.
pub fn defender_exclusions() -> DefenderExclusions {
    let Ok(connection) = WMIConnection::with_namespace_path(r"root\Microsoft\Windows\Defender") else {
        return DefenderExclusions::Unknown;
    };
    match connection.query::<MpPreference>() {
        Ok(preferences) => {
            let paths: Vec<String> = preferences.into_iter().flat_map(|p| p.exclusion_path.unwrap_or_default()).collect();
            // Recent Defender versions hide the list from standard users behind a placeholder
            // entry rather than an error.
            if paths.iter().any(|p| p.starts_with("N/A")) { DefenderExclusions::Unknown } else { DefenderExclusions::Paths(paths) }
        }
        Err(_) => DefenderExclusions::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_test_process_is_found_by_its_image_name() {
        let image = std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().into_owned();
        let found = processes_named(&image);
        assert!(found.iter().any(|(pid, _)| *pid == std::process::id()), "{found:?}");
    }

    #[test]
    fn no_process_has_a_made_up_name() {
        assert!(processes_named("definitely-not-running-xyz.exe").is_empty());
    }

    #[test]
    fn the_probes_answer_without_failing() {
        // Whatever this machine's state, every probe gives an answer.
        let _ = is_optional_feature_enabled("HypervisorPlatform");
        let _ = is_hypervisor_present();
        let _ = is_virtualization_firmware_enabled();
        let _ = defender_exclusions();
    }
}
