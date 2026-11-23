//! The device as the UI shows it: which Android version, and whether it is running.

use std::path::PathBuf;

use oe_engine::profiles::ProfileId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EmuPhase {
    #[default]
    Unknown,
    Stopped,
    Starting,
    Running,
    Stopping,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceState {
    pub profile: ProfileId,
    pub phase: EmuPhase,
    pub avd: Option<String>,
    /// e.g. "11".
    pub android_version: Option<String>,
    pub api: Option<u32>,
    pub boot_completed: bool,
    /// Whether this profile's AVD has been prepared, and so can boot from a snapshot.
    pub provisioned: bool,
    pub snapshot: bool,
    /// True while a start, stop or prepare is in flight — the UI disables its buttons on this.
    pub busy: bool,
    /// Set when the last action failed, so the UI can say what went wrong.
    pub error: Option<String>,
}

impl Default for DeviceState {
    fn default() -> Self {
        DeviceState {
            profile: ProfileId::Openemu,
            phase: EmuPhase::Unknown,
            avd: None,
            android_version: None,
            api: None,
            boot_completed: false,
            provisioned: false,
            snapshot: false,
            busy: false,
            error: None,
        }
    }
}

/// What a status report said. A line that is absent leaves its field unknown rather than
/// reporting "not provisioned" for a guest that was merely quiet — that would send someone through
/// a re-provision they did not need.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StatusReport {
    pub avd: Option<String>,
    pub phase: Option<EmuPhase>,
    pub android_version: Option<String>,
    pub api: Option<u32>,
    pub boot_completed: bool,
    pub snapshot: Option<bool>,
    pub provisioned: bool,
}

/// Reads the engine's `key=value` status lines. The first occurrence of a key wins.
pub fn parse_status(lines: &[String]) -> StatusReport {
    let mut fields: Vec<(&str, &str)> = Vec::new();
    for line in lines {
        let line = line.trim();
        if let Some(eq) = line.find('=').filter(|&eq| eq > 0) {
            let key = &line[..eq];
            if !fields.iter().any(|(known, _)| *known == key) {
                fields.push((key, line[eq + 1..].trim()));
            }
        }
    }
    let get = |key: &str| fields.iter().find(|(known, _)| *known == key).map(|(_, value)| *value);
    let mut report = StatusReport {
        avd: get("avd").filter(|avd| !avd.is_empty()).map(str::to_owned),
        phase: match get("emulator") {
            Some("running") => Some(EmuPhase::Running),
            Some("stopped") => Some(EmuPhase::Stopped),
            _ => None,
        },
        boot_completed: get("boot_completed") == Some("1"),
        snapshot: get("snapshot").filter(|s| !s.is_empty()).map(|s| s.contains("present=yes")),
        provisioned: get("provisioned_at").is_some(),
        ..StatusReport::default()
    };
    if let Some(android) = get("android").filter(|a| !a.is_empty()) {
        let mut parts = android.split_whitespace();
        if let Some(version) = parts.next().filter(|v| *v != "unknown") {
            report.android_version = Some(version.to_owned());
        }
        let api = parts.next().unwrap_or("").replacen("api=", "", 1);
        let digits: String = api.chars().take_while(char::is_ascii_digit).collect();
        report.api = digits.parse().ok();
    }
    report
}

impl DeviceState {
    /// This state with what a status report knows laid over it.
    pub fn with_report(mut self, report: &StatusReport) -> DeviceState {
        if let Some(avd) = &report.avd {
            self.avd = Some(avd.clone());
        }
        if let Some(phase) = report.phase {
            self.phase = phase;
        }
        if let Some(version) = &report.android_version {
            self.android_version = Some(version.clone());
        }
        if let Some(api) = report.api {
            self.api = Some(api);
        }
        if let Some(snapshot) = report.snapshot {
            self.snapshot = snapshot;
        }
        self.boot_completed = report.boot_completed;
        self.provisioned = report.provisioned;
        self
    }
}

/// Which Android version the user chose, kept in `device.json` as the Electron app kept it.
pub struct DevicePrefsStore {
    file: PathBuf,
    profile: std::sync::Mutex<ProfileId>,
}

impl DevicePrefsStore {
    pub fn new(file: impl Into<PathBuf>, fallback: ProfileId) -> DevicePrefsStore {
        let file = file.into();
        let profile = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|raw| raw.get("profile").and_then(|p| p.as_str()).and_then(ProfileId::parse))
            .unwrap_or(fallback);
        DevicePrefsStore { file, profile: std::sync::Mutex::new(profile) }
    }

    pub fn get(&self) -> ProfileId {
        *self.profile.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn set(&self, profile: ProfileId) -> ProfileId {
        *self.profile.lock().unwrap_or_else(|p| p.into_inner()) = profile;
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.file.with_extension("json.tmp");
        if std::fs::write(&tmp, format!("{{\"profile\":\"{}\"}}", profile.id())).is_ok() {
            let _ = std::fs::rename(&tmp, &self.file);
        }
        profile
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &[&str]) -> Vec<String> {
        text.iter().map(|s| (*s).to_owned()).collect()
    }

    /// Copied from what the engine emits: the seam between the engine and the UI.
    #[test]
    fn a_fully_running_guest_is_read_correctly() {
        let report = parse_status(&lines(&[
            "avd=OpenEmulator_API30_fast",
            "emulator=running",
            "pid=4242",
            "adb_device=emulator-5554",
            "boot_completed=1",
            "android=11 api=30",
            "snapshot=default_boot present=yes",
            "provisioned_at=2026-08-24T10:00:00.000Z",
        ]));
        let state = DeviceState::default().with_report(&report);
        assert_eq!(state.avd.as_deref(), Some("OpenEmulator_API30_fast"));
        assert_eq!(state.phase, EmuPhase::Running);
        assert!(state.boot_completed && state.snapshot && state.provisioned);
        assert_eq!((state.android_version.as_deref(), state.api), (Some("11"), Some(30)));
    }

    #[test]
    fn a_stopped_guest_reports_stopped_and_a_quiet_one_leaves_fields_unknown() {
        let stopped = parse_status(&lines(&["avd=A", "emulator=stopped", "adb_device=none", "snapshot=default_boot present=no"]));
        assert_eq!((stopped.phase, stopped.snapshot, stopped.provisioned), (Some(EmuPhase::Stopped), Some(false), false));
        let quiet = parse_status(&lines(&["avd=A", "emulator=stopped"]));
        assert_eq!((quiet.android_version, quiet.api), (None, None));
        let unknown = parse_status(&lines(&["android=unknown api=unknown"]));
        assert_eq!((unknown.android_version, unknown.api), (None, None));
    }

    #[test]
    fn the_chosen_profile_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("device.json");
        assert_eq!(DevicePrefsStore::new(&file, ProfileId::Openemu).get(), ProfileId::Openemu);
        DevicePrefsStore::new(&file, ProfileId::Openemu).set(ProfileId::OpenemuCompat);
        assert_eq!(DevicePrefsStore::new(&file, ProfileId::Openemu).get(), ProfileId::OpenemuCompat);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"profile":"openemu-compat"}"#);
    }
}
