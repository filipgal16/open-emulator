//! What the store shows and tracks: apps, their versions, install jobs, and the store's state.

use std::path::PathBuf;

use oe_formats::js_round;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SourceId {
    Fdroid,
    Local,
    Play,
}

impl SourceId {
    pub const ALL: [SourceId; 3] = [SourceId::Fdroid, SourceId::Local, SourceId::Play];

    pub fn id(self) -> &'static str {
        match self {
            SourceId::Fdroid => "fdroid",
            SourceId::Local => "local",
            SourceId::Play => "play",
        }
    }

    pub fn parse(value: &str) -> Option<SourceId> {
        SourceId::ALL.into_iter().find(|source| source.id() == value)
    }

    pub fn label(self) -> &'static str {
        match self {
            SourceId::Fdroid => "F-Droid",
            SourceId::Local => "Local",
            SourceId::Play => "Play",
        }
    }

    /// Shown when the source has nothing to offer, in place of an empty grid.
    pub fn empty_hint(self) -> &'static str {
        match self {
            SourceId::Fdroid => "Nothing matched. The catalogue is only free and open-source apps.",
            SourceId::Local => "Choose Install from file, drop an app file onto this window, or put one in android/apps/.",
            SourceId::Play => "The Play Store runs inside the guest.",
        }
    }
}

/// The guest's API level until it has been asked. Everything the store offers is checked against
/// the real one before Install is enabled.
pub const DEFAULT_GUEST_SDK: u32 = 30;

/// One app as shown in the grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreApp {
    /// Stable across refreshes: `<source>:<package>`.
    pub id: String,
    pub source: SourceId,
    pub package_name: String,
    pub name: String,
    pub summary: String,
    /// The icon, already downloaded to the image cache, never a remote URL. `None` shows a
    /// placeholder.
    pub icon: Option<PathBuf>,
    pub version_name: String,
    pub version_code: i64,
    pub size_bytes: u64,
    pub license: Option<String>,
    /// Minimum API level this build installs on.
    pub min_sdk: u32,
    /// ABIs the APK carries native code for. Empty means pure bytecode: runs on any guest.
    pub abis: Vec<String>,
    pub categories: Vec<String>,
    pub last_updated: i64,
    /// F-Droid anti-feature ids (`Ads`, `Tracking`, `NonFreeNet`…), surfaced rather than hidden.
    pub anti_features: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppVersion {
    pub version_name: String,
    pub version_code: i64,
    pub size_bytes: u64,
    pub min_sdk: u32,
    pub added: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDetail {
    pub app: StoreApp,
    pub description: String,
    pub web_site: Option<String>,
    pub source_code: Option<String>,
    /// Already cached by the time the detail pane shows them.
    pub screenshots: Vec<PathBuf>,
    /// Newest first, excluding the one in `app`.
    pub other_versions: Vec<AppVersion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallState {
    Queued,
    Downloading,
    Verifying,
    /// Taking the pieces this device needs out of an app bundle (.xapk, .apks).
    Unpacking,
    Installing,
    Done,
    Failed,
}

impl InstallState {
    pub fn is_finished(self) -> bool {
        matches!(self, InstallState::Done | InstallState::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallJob {
    pub id: String,
    /// The id the job was started against. Stable for the job's whole life, so the UI can match it.
    pub package_name: String,
    /// The real package the guest ended up with. Only differs for a local file, whose package
    /// name is not knowable until it is installed.
    pub resolved_package: Option<String>,
    pub label: String,
    pub source: SourceId,
    pub state: InstallState,
    pub bytes_done: u64,
    /// 0 when the server sent no length; the UI shows an indeterminate bar.
    pub bytes_total: u64,
    /// Why the job failed, or, on a `Done` job, what after the install did not work (a game's
    /// data files that could not be copied), since the install itself stands.
    pub error: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StoreState {
    /// Whether the F-Droid catalogue has been distilled and is searchable.
    pub index_ready: bool,
    pub index_updated_at: Option<i64>,
    pub index_app_count: usize,
    /// `None` until the guest has been asked. Installs stay disabled while it is unknown.
    pub guest_sdk: Option<u32>,
    /// True when the running guest actually carries the Play Store app.
    pub play_available: bool,
    /// True when the guest's build fingerprint has been rewritten. Play refuses to sign in on an
    /// uncertified fingerprint, so the Play tab warns instead of failing.
    pub identity_spoofed: bool,
}

/// Why an app cannot be installed right now, or `None` when it can.
pub fn install_blocked_reason(app: &StoreApp, guest_sdk: Option<u32>) -> Option<String> {
    let guest_sdk = guest_sdk?;
    (app.min_sdk > guest_sdk).then(|| format!("Needs API {} (guest is {guest_sdk})", app.min_sdk))
}

/// `install_blocked_reason`, also blocking while the guest is unknown.
pub fn install_blocked(app: &StoreApp, guest_sdk: Option<u32>) -> Option<String> {
    match guest_sdk {
        None => Some("Waiting for the guest".to_owned()),
        Some(_) => install_blocked_reason(app, guest_sdk),
    }
}

/// `1.4 MB`, `12 MB`, `Unknown` for nothing.
pub fn format_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "Unknown".to_owned();
    }
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    const UNITS: [&str; 3] = ["KB", "MB", "GB"];
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value < 10.0 {
        format!("{:.1} {}", js_round(value * 10.0) / 10.0, UNITS[unit])
    } else {
        format!("{} {}", js_round(value), UNITS[unit])
    }
}

/// Milliseconds since the Unix epoch, as `Date.now()` gave them.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(min_sdk: u32) -> StoreApp {
        StoreApp {
            id: "fdroid:x".into(),
            source: SourceId::Fdroid,
            package_name: "x".into(),
            name: "X".into(),
            summary: String::new(),
            icon: None,
            version_name: "1".into(),
            version_code: 1,
            size_bytes: 1,
            license: None,
            min_sdk,
            abis: Vec::new(),
            categories: Vec::new(),
            last_updated: 0,
            anti_features: Vec::new(),
        }
    }

    #[test]
    fn an_unknown_guest_blocks_every_install_and_a_low_one_blocks_newer_apps() {
        assert_eq!(install_blocked(&app(21), None).as_deref(), Some("Waiting for the guest"));
        assert_eq!(install_blocked(&app(33), Some(30)).as_deref(), Some("Needs API 33 (guest is 30)"));
        assert_eq!(install_blocked(&app(30), Some(30)), None);
    }

    #[test]
    fn sizes_read_the_way_a_person_says_them() {
        assert_eq!(format_bytes(0), "Unknown");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(25 * 1024 * 1024), "25 MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    }

    #[test]
    fn source_ids_round_trip() {
        for source in SourceId::ALL {
            assert_eq!(SourceId::parse(source.id()), Some(source));
        }
    }
}
