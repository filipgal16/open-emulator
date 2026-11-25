//! An opt-in Windows Defender exclusion for the emulator's folder.
//!
//! Defender's real-time scanner inspects every write, and a cold boot writes a lot: the guest's
//! userdata and snapshot images churn constantly. Excluding the emulator's own directory is a known
//! emulator speedup on Windows.
//!
//! **This changes a security setting, so it is only ever done on an explicit request from the
//! user.** Nothing here runs on its own: reading the state is unprivileged (WMI); applying and
//! reverting are one elevated `Add-MpPreference` / `Remove-MpPreference` each, behind a UAC prompt,
//! and the reversal is exact. The exclusion is scoped to the app's own data folder.

use std::path::Path;
use std::time::Duration;

use crate::{err, Result};

/// Whether Defender excludes the folder. `Unknown` is a real third answer: Defender may be absent
/// (another antivirus), managed by policy, or not queryable, and the UI must not claim "not
/// excluded: turn it on" when it does not actually know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExclusionState {
    Excluded,
    NotExcluded,
    Unknown,
}

/// Whether `folder` is covered by any of `exclusions` (equal to one, or nested under one) so a
/// broader exclusion the user already has (their whole profile, say) counts, and a redundant one
/// is not offered. Case-folded and trailing-slash-trimmed, as Windows compares paths.
pub fn is_covered_by(folder: &str, exclusions: &[String]) -> bool {
    let target = normalize(folder);
    !target.is_empty()
        && exclusions.iter().map(|entry| normalize(entry)).filter(|entry| !entry.is_empty()).any(|entry| {
            target == entry || target.strip_prefix(entry.as_str()).is_some_and(|rest| rest.starts_with('\\'))
        })
}

fn normalize(path: &str) -> String {
    path.trim().trim_end_matches(['\\', '/']).to_lowercase()
}

/// Read-only and unprivileged.
pub async fn exclusion_state(folder: &Path) -> ExclusionState {
    let folder = folder.to_string_lossy().into_owned();
    tokio::task::spawn_blocking(move || read_state(&folder)).await.unwrap_or(ExclusionState::Unknown)
}

#[cfg(windows)]
fn read_state(folder: &str) -> ExclusionState {
    use oe_win::wmi_probe::{defender_exclusions, DefenderExclusions};
    match defender_exclusions() {
        DefenderExclusions::Paths(paths) if is_covered_by(folder, &paths) => ExclusionState::Excluded,
        DefenderExclusions::Paths(_) => ExclusionState::NotExcluded,
        DefenderExclusions::Unknown => ExclusionState::Unknown,
    }
}

#[cfg(not(windows))]
fn read_state(_folder: &str) -> ExclusionState {
    ExclusionState::Unknown
}

/// Adds the exclusion, via one UAC prompt. Fails if the user declines.
pub async fn add_exclusion(folder: &Path) -> Result<()> {
    change_exclusion("Add-MpPreference", folder).await
}

/// Removes exactly the exclusion [`add_exclusion`] adds.
pub async fn remove_exclusion(folder: &Path) -> Result<()> {
    change_exclusion("Remove-MpPreference", folder).await
}

/// The one `powershell.exe` this app still starts: elevated, once, when the user asks. Defender's
/// preference methods take an array, which WMI's method calls cannot be handed from here without
/// hand-built COM, and a one-off behind a UAC prompt does not justify that.
async fn change_exclusion(cmdlet: &'static str, folder: &Path) -> Result<()> {
    let command = format!("{cmdlet} -ExclusionPath {}", powershell_quote(&folder.to_string_lossy()));
    let elevated = tokio::task::spawn_blocking(move || run(&command));
    elevated.await.map_err(|error| err!("the Defender change stopped unexpectedly: {error}"))?
}

/// A PowerShell single-quoted string: nothing inside is expanded, and a quote is doubled.
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn run(command: &str) -> Result<()> {
    let args = ["-NoProfile", "-NonInteractive", "-Command", command];
    oe_win::system::run_elevated("powershell.exe", &args, Duration::from_secs(120)).map_err(|error| err!("{error}"))
}

#[cfg(not(windows))]
fn run(_command: &str) -> Result<()> {
    let _ = Duration::ZERO;
    Err(err!("Windows Defender exists only on Windows"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOLDER: &str = r"C:\Users\Filip\AppData\Local\open-emulator";

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn an_exact_match_counts_as_covered() {
        assert!(is_covered_by(FOLDER, &list(&[FOLDER])));
    }

    #[test]
    fn matching_is_case_and_trailing_slash_insensitive() {
        assert!(is_covered_by(FOLDER, &list(&[r"c:\users\filip\appdata\local\open-emulator\"])));
    }

    #[test]
    fn a_broader_exclusion_covering_a_parent_counts() {
        assert!(is_covered_by(FOLDER, &list(&[r"C:\Users\Filip"])));
        assert!(is_covered_by(FOLDER, &list(&[r"C:\"])), "a whole drive covers everything on it");
    }

    #[test]
    fn an_unrelated_exclusion_does_not_count() {
        assert!(!is_covered_by(FOLDER, &list(&[r"C:\Games", r"D:\"])));
    }

    #[test]
    fn a_sibling_sharing_a_prefix_but_not_a_path_boundary_does_not_count() {
        assert!(!is_covered_by(FOLDER, &list(&[r"C:\Users\Filip\AppData\Local\open-emulator-old"])));
    }

    #[test]
    fn an_empty_exclusion_list_is_not_covered() {
        assert!(!is_covered_by(FOLDER, &[]));
        assert!(!is_covered_by(FOLDER, &list(&["", "  "])));
    }

    #[test]
    fn the_folder_reaches_powershell_as_one_literal_string() {
        assert_eq!(powershell_quote(r"C:\Users\O'Brien\x"), r"'C:\Users\O''Brien\x'");
        assert_eq!(powershell_quote(r"C:\$env:x"), r"'C:\$env:x'", "nothing inside single quotes is expanded");
    }
}
