//! Updates: the newest published release, looked for on a schedule, downloaded only when asked,
//! and installed when the app quits.
//!
//! The feed is the one electron-builder published and the Electron app's updater read:
//! `latest.yml` on the latest GitHub release, so existing installs and this one follow the same
//! file, and a release made for either reaches both.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use oe_engine::download::{download_file, http_client, DigestAlgorithm, DownloadOptions, DownloadProgress, DownloadSpec};
use oe_engine::engine::BoxFuture;
use oe_store::fetch::{http_fetcher, FetchRequest, Fetcher};

use crate::{err, Result};

pub const RELEASES: &str = "https://github.com/filipgal16/open-emulator/releases";
const DEV_BUILD_MESSAGE: &str = "Updates are checked by the installed app, not a development run.";
const FIRST_CHECK: Duration = Duration::from_secs(30);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatePhase {
    /// A development run: there is no installed copy to update.
    Unsupported,
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    /// Downloaded and verified; installs when the app quits, or on "Restart to update".
    Ready,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateState {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub percent: Option<u8>,
    pub message: Option<String>,
    pub checked_at: Option<i64>,
}

/// What `latest.yml` says about the newest release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    /// The installer's file name in the release.
    pub path: String,
    /// Base64 of the installer's SHA-512, as electron-builder writes it.
    pub sha512: String,
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    value
        .strip_prefix('\'')
        .and_then(|v| v.strip_suffix('\''))
        .or_else(|| value.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
        .unwrap_or(value)
}

/// The three fields of `latest.yml` that matter, from its top level, or from the first entry
/// under `files` for a file that names the installer only there.
pub fn parse_latest_yml(text: &str) -> Option<Release> {
    let (mut version, mut path, mut sha512) = (None, None, None);
    let (mut first_url, mut first_sha) = (None, None);
    for line in text.lines() {
        let top_level = !line.starts_with([' ', '\t', '-']);
        let entry = line.trim_start().trim_start_matches("- ");
        let Some((key, value)) = entry.split_once(':') else { continue };
        let value = unquote(value).to_owned();
        match (top_level, key.trim()) {
            (true, "version") => version = Some(value),
            (true, "path") => path = Some(value),
            (true, "sha512") => sha512 = Some(value),
            (false, "url") if first_url.is_none() => first_url = Some(value),
            (false, "sha512") if first_sha.is_none() => first_sha = Some(value),
            _ => {}
        }
    }
    let path = path.or(first_url)?;
    // Only a file name: it is joined onto the release's URL and the download folder.
    if path.is_empty() || path.contains(['/', '\\']) || path.contains("..") {
        return None;
    }
    Some(Release { version: version.filter(|v| !v.is_empty())?, path, sha512: sha512.or(first_sha)? })
}

fn numbers(version: &str) -> (Vec<u64>, bool) {
    let version = version.trim().trim_start_matches('v');
    let (core, prerelease) = match version.split_once('-') {
        Some((core, _)) => (core, true),
        None => (version, false),
    };
    (core.split('.').map(|part| part.parse().unwrap_or(0)).collect(), prerelease)
}

/// Semver order, enough for release numbers: numeric parts, and a pre-release before its release.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let ((mut left, left_pre), (mut right, right_pre)) = (numbers(a), numbers(b));
    let width = left.len().max(right.len());
    left.resize(width, 0);
    right.resize(width, 0);
    left.cmp(&right).then(right_pre.cmp(&left_pre))
}

/// A failure, as one sentence someone can act on.
pub fn describe_update_error(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("http 404") {
        return "No published release could be read. If the repository is private, installed copies can't see its releases.".into();
    }
    if lower.contains("http 403") || lower.contains("http 429") {
        return "GitHub is limiting requests right now. Try again later.".into();
    }
    if lower.contains("digest") || lower.contains("checksum") {
        return "The download didn't match its published checksum, so it was discarded. Try again.".into();
    }
    if lower.contains("certificate") {
        return "Couldn't make a secure connection to GitHub: its certificate wasn't trusted. A proxy or security software may be intercepting the connection.".into();
    }
    if ["error sending request", "dns", "connect", "timed out", "unreachable"].iter().any(|word| lower.contains(word)) {
        return "Couldn't reach GitHub to check for updates. Check your connection and try again.".into();
    }
    let first = message.lines().next().unwrap_or("").trim();
    match first.chars().count() {
        0 => "Updating failed for an unknown reason.".into(),
        n if n > 200 => format!("{}…", first.chars().take(200).collect::<String>()),
        _ => first.to_owned(),
    }
}

pub type ProgressSink = Arc<dyn Fn(u64, u64) + Send + Sync>;
/// Fetches `url` to `target`, which appears only once its SHA-512 (hex) matches.
pub type InstallerDownload = Arc<dyn Fn(String, PathBuf, String, ProgressSink) -> BoxFuture<'static, Result<()>> + Send + Sync>;

pub struct UpdateFeed {
    /// `https://github.com/<owner>/<repo>/releases`.
    pub releases: String,
    pub fetch: Fetcher,
    pub download: InstallerDownload,
    /// Where the installer is downloaded to.
    pub dir: PathBuf,
}

impl UpdateFeed {
    /// The real feed, over the network.
    pub fn github(dir: PathBuf) -> UpdateFeed {
        let client = http_client();
        let download: InstallerDownload = {
            let client = client.clone();
            Arc::new(move |url, target, sha512, progress| {
                let options = DownloadOptions {
                    client: client.clone(),
                    on_progress: Some(Arc::new(move |p: &DownloadProgress| progress(p.bytes_done, p.bytes_total))),
                    on_log: None,
                    max_bytes: 512 * 1024 * 1024,
                };
                Box::pin(async move {
                    let spec = DownloadSpec::new(url, target).digest(DigestAlgorithm::Sha512, sha512);
                    download_file(&spec, &options).await.map(|_| ()).map_err(|error| err!("{}", error.message))
                })
            })
        };
        UpdateFeed { releases: RELEASES.to_owned(), fetch: http_fetcher(client), download, dir }
    }
}

/// Whether this is an installed copy (the installer leaves its uninstaller beside the app) and
/// so one an update can replace. A development build run from `target/` is not.
pub fn is_installed_copy() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe")))
        .is_some_and(|uninstaller| uninstaller.is_file())
}

fn base64_to_hex(text: &str) -> Option<String> {
    let value = |c: u8| -> Option<u32> {
        Some(u32::from(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        }))
    };
    let body = text.trim().trim_end_matches('=');
    let mut bytes = Vec::new();
    for chunk in body.as_bytes().chunks(4) {
        let mut bits = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            bits |= value(c)? << (18 - 6 * i);
        }
        bytes.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8][..chunk.len().saturating_sub(1)]);
    }
    (bytes.len() == 64).then(|| oe_formats::bytes::hex(&bytes))
}

pub struct UpdateService {
    feed: Option<UpdateFeed>,
    state: Mutex<UpdateState>,
    release: Mutex<Option<Release>>,
    installer: Mutex<Option<PathBuf>>,
    on_change: Arc<dyn Fn(&UpdateState) + Send + Sync>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    busy: tokio::sync::Mutex<()>,
}

impl UpdateService {
    /// `feed` is `None` for a development run, which never updates itself.
    pub fn new(current_version: &str, feed: Option<UpdateFeed>, on_change: impl Fn(&UpdateState) + Send + Sync + 'static) -> UpdateService {
        let supported = feed.is_some();
        UpdateService {
            state: Mutex::new(UpdateState {
                phase: if supported { UpdatePhase::Idle } else { UpdatePhase::Unsupported },
                current_version: current_version.to_owned(),
                latest_version: None,
                percent: None,
                message: (!supported).then(|| DEV_BUILD_MESSAGE.to_owned()),
                checked_at: None,
            }),
            feed,
            release: Mutex::new(None),
            installer: Mutex::new(None),
            on_change: Arc::new(on_change),
            now: Arc::new(crate::now_ms),
            busy: tokio::sync::Mutex::new(()),
        }
    }

    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> UpdateService {
        self.now = Arc::new(now);
        self
    }

    pub fn get(&self) -> UpdateState {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set(&self, change: impl FnOnce(&mut UpdateState)) {
        let state = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            change(&mut state);
            state.clone()
        };
        (self.on_change)(&state);
    }

    fn fail(&self, error: &str) {
        self.set(|state| {
            state.phase = UpdatePhase::Error;
            state.percent = None;
            state.message = Some(describe_update_error(error));
        });
    }

    /// Looks for a newer version. Never downloads one.
    pub async fn check(&self) -> UpdateState {
        let Some(feed) = &self.feed else { return self.get() };
        if matches!(self.get().phase, UpdatePhase::Downloading | UpdatePhase::Ready) {
            return self.get();
        }
        let Ok(_turn) = self.busy.try_lock() else {
            // A check is already running; its answer is the one to give.
            let _wait = self.busy.lock().await;
            return self.get();
        };
        self.set(|state| {
            state.phase = UpdatePhase::Checking;
            state.message = None;
        });
        let url = format!("{}/latest/download/latest.yml", feed.releases);
        let answer = match (feed.fetch)(FetchRequest::new(url, 64 * 1024, Duration::from_secs(30))).await {
            Ok(response) if response.ok() => parse_latest_yml(&String::from_utf8_lossy(&response.body))
                .ok_or_else(|| err!("the release's latest.yml could not be read")),
            Ok(response) => Err(err!("HTTP {}", response.status)),
            Err(error) => Err(error),
        };
        match answer {
            Ok(release) => {
                let current = self.get().current_version;
                let newer = compare_versions(&release.version, &current) == Ordering::Greater;
                let now = (self.now)();
                self.set(|state| {
                    state.phase = if newer { UpdatePhase::Available } else { UpdatePhase::UpToDate };
                    state.latest_version = newer.then(|| release.version.clone());
                    state.checked_at = Some(now);
                    state.message = None;
                });
                *self.release.lock().unwrap_or_else(|p| p.into_inner()) = newer.then_some(release);
            }
            Err(error) => self.fail(&error.0),
        }
        self.get()
    }

    /// Downloads the version a check found; nothing happens unless one is on offer.
    pub async fn download(&self) -> UpdateState {
        let (Some(feed), Some(release)) = (&self.feed, self.release.lock().unwrap_or_else(|p| p.into_inner()).clone()) else {
            return self.get();
        };
        if self.get().phase != UpdatePhase::Available {
            return self.get();
        }
        let _turn = self.busy.lock().await;
        self.set(|state| {
            state.phase = UpdatePhase::Downloading;
            state.percent = Some(0);
            state.message = None;
        });
        let Some(sha512) = base64_to_hex(&release.sha512) else {
            self.fail("the release's checksum could not be read");
            return self.get();
        };
        let url = format!("{}/download/v{}/{}", feed.releases, release.version, release.path);
        let target = feed.dir.join(&release.path);
        let _ = std::fs::create_dir_all(&feed.dir);
        let sink = self.on_change.clone();
        let state = Arc::new(Mutex::new(self.get()));
        let progress: ProgressSink = Arc::new(move |done, total| {
            if total == 0 {
                return;
            }
            let percent = ((done.min(total) * 100) / total) as u8;
            let mut state = state.lock().unwrap_or_else(|p| p.into_inner());
            if state.percent != Some(percent) {
                state.percent = Some(percent);
                sink(&state);
            }
        });
        match (feed.download)(url, target.clone(), sha512, progress).await {
            Ok(()) => {
                *self.installer.lock().unwrap_or_else(|p| p.into_inner()) = Some(target);
                self.set(|state| {
                    state.phase = UpdatePhase::Ready;
                    state.percent = Some(100);
                    state.latest_version = Some(release.version.clone());
                });
            }
            Err(error) => self.fail(&error.0),
        }
        self.get()
    }

    /// The verified installer, once a download has finished.
    pub fn ready_installer(&self) -> Option<PathBuf> {
        if self.get().phase != UpdatePhase::Ready {
            return None;
        }
        self.installer.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

/// Checks after thirty seconds, then every six hours, as the Electron app did. Never downloads.
pub fn schedule_checks(service: Arc<UpdateService>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            service.check().await;
            tokio::time::sleep(EVERY).await;
        }
    })
}

/// Starts the downloaded installer silently, to replace this copy once it has exited, and to
/// start the new one afterwards (`--force-run`, the flag the Electron updater passed too). The
/// installer asks a running copy to close; the caller quits straight after anyway.
pub fn run_installer(installer: &Path) -> Result<()> {
    let mut command = std::process::Command::new(installer);
    command.args(["/S", "--force-run"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Detached, with no console window of its own.
        command.creation_flags(0x0000_0008 | 0x0800_0000);
    }
    command.spawn().map(|_| ()).map_err(|error| err!("could not start the installer: {error}"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    use oe_store::fetch::FetchResponse;

    use super::*;

    const YML: &str = "version: 0.4.0\nfiles:\n  - url: open-emulator-Setup-0.4.0.exe\n    sha512: AAAA\n    size: 1234\npath: open-emulator-Setup-0.4.0.exe\nsha512: 7iaw3Ur350mqGo7jwQrpkj9hiYB3Lkc/iBml1JQODbJ6wYX4oOHV+E+IvIh/1nsUNzLDBMxfqa2Ob1f1ACio/w==\nreleaseDate: '2026-11-01T00:00:00.000Z'\n";

    #[test]
    fn latest_yml_gives_the_version_the_installer_and_its_checksum() {
        let release = parse_latest_yml(YML).unwrap();
        assert_eq!(release.version, "0.4.0");
        assert_eq!(release.path, "open-emulator-Setup-0.4.0.exe");
        assert!(release.sha512.starts_with("7iaw3"));
        assert!(parse_latest_yml("version: 1.0.0\npath: ../../evil.exe\nsha512: x\n").is_none(), "only a file name");
        assert!(base64_to_hex(&release.sha512).is_some_and(|hex| hex.len() == 128));
    }

    #[test]
    fn versions_compare_by_number_not_text() {
        assert_eq!(compare_versions("0.10.0", "0.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("v0.3.0", "0.3.0"), Ordering::Equal);
        assert_eq!(compare_versions("0.3.0-beta.1", "0.3.0"), Ordering::Less);
        assert_eq!(compare_versions("0.3", "0.3.0"), Ordering::Equal);
    }

    #[test]
    fn failures_read_as_something_a_person_can_act_on() {
        assert!(describe_update_error("HTTP 404").contains("No published release"));
        assert!(describe_update_error("HTTP 429").contains("limiting"));
        assert!(describe_update_error("error sending request for url").contains("Couldn't reach GitHub"));
        assert!(describe_update_error("the download did not match its expected digest").contains("checksum"));
        assert_eq!(describe_update_error(""), "Updating failed for an unknown reason.");
    }

    fn feed(dir: &Path, status: u16, body: &'static str) -> (UpdateFeed, Arc<AtomicUsize>) {
        let downloads = Arc::new(AtomicUsize::new(0));
        let counted = downloads.clone();
        let fetch: Fetcher = Arc::new(move |request: FetchRequest| {
            assert!(request.url.ends_with("/releases/latest/download/latest.yml"));
            Box::pin(async move { Ok(FetchResponse { status, etag: None, body: body.as_bytes().to_vec() }) })
        });
        let download: InstallerDownload = Arc::new(move |url, target, sha512, progress| {
            counted.fetch_add(1, AtomicOrdering::SeqCst);
            Box::pin(async move {
                assert!(url.ends_with("/releases/download/v0.4.0/open-emulator-Setup-0.4.0.exe"), "{url}");
                assert_eq!(sha512.len(), 128);
                progress(50, 100);
                progress(100, 100);
                std::fs::write(&target, b"installer")?;
                Ok(())
            })
        });
        (UpdateFeed { releases: "https://example.test/releases".into(), fetch, download, dir: dir.to_owned() }, downloads)
    }

    #[tokio::test]
    async fn a_newer_release_is_offered_but_not_downloaded_until_asked() {
        let dir = tempfile::tempdir().unwrap();
        let (feed, downloads) = feed(dir.path(), 200, YML);
        let changes = Arc::new(Mutex::new(Vec::new()));
        let seen = changes.clone();
        let service = UpdateService::new("0.3.0", Some(feed), move |state| seen.lock().unwrap().push(state.phase)).with_clock(|| 42);
        let checked = service.check().await;
        assert_eq!((checked.phase, checked.latest_version.as_deref(), checked.checked_at), (UpdatePhase::Available, Some("0.4.0"), Some(42)));
        assert_eq!(downloads.load(AtomicOrdering::SeqCst), 0, "never downloads on its own");
        assert_eq!(service.ready_installer(), None);

        let done = service.download().await;
        assert_eq!((done.phase, done.percent), (UpdatePhase::Ready, Some(100)));
        assert_eq!(service.ready_installer(), Some(dir.path().join("open-emulator-Setup-0.4.0.exe")));
        assert!(changes.lock().unwrap().contains(&UpdatePhase::Downloading));
    }

    #[tokio::test]
    async fn the_same_version_is_up_to_date_and_a_missing_release_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let (current, _) = feed(dir.path(), 200, YML);
        assert_eq!(UpdateService::new("0.4.0", Some(current), |_| {}).check().await.phase, UpdatePhase::UpToDate);
        let (missing, _) = feed(dir.path(), 404, "");
        let failed = UpdateService::new("0.3.0", Some(missing), |_| {}).check().await;
        assert_eq!(failed.phase, UpdatePhase::Error);
        assert!(failed.message.unwrap().contains("No published release"));
    }

    #[tokio::test]
    async fn a_development_run_never_updates() {
        let service = UpdateService::new("0.3.0", None, |_| {});
        assert_eq!(service.check().await.phase, UpdatePhase::Unsupported);
        assert_eq!(service.download().await.phase, UpdatePhase::Unsupported);
        assert_eq!(service.get().message.as_deref(), Some(DEV_BUILD_MESSAGE));
    }
}
