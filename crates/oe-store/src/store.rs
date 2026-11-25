//! The store as the rest of the app sees it: one handle over the catalogue, the guest's facts, the
//! installer and Play, with its events delivered to one callback.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use oe_engine::client::OpenEmuClient;
use oe_engine::download::{http_client, MessageHandler};

use crate::app_library::AppLibrary;
use crate::bundle::{inspect_package_file, package_file_label};
use crate::catalog::Catalog;
use crate::fdroid::FdroidSource;
use crate::fetch::{http_fetcher, Fetcher};
use crate::guest_facts::GuestFactsProbe;
use crate::image_cache::ImageCache;
use crate::installer::{http_downloader, Downloader, Installer};
use crate::local::LocalSource;
use crate::play::PlayController;
use crate::source::AppSource;
use crate::types::{AppDetail, InstallJob, InstallState, SourceId, StoreApp, StoreState};

const MAX_SEARCH_LIMIT: usize = 120;
const DEFAULT_SEARCH_LIMIT: usize = 60;
const MAX_FILES_AT_ONCE: usize = 20;
const MAX_ICON_BYTES: usize = 4 * 1024 * 1024;
const MAX_QUERY_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreEvent {
    /// A job changed: progress, a new state, an error.
    Job(InstallJob),
    /// An install really landed in the guest: the cue to re-read the app list.
    Installed(String),
    /// The catalogue or the guest's facts changed.
    IndexUpdated(StoreState),
}

pub type EventSink = Arc<dyn Fn(StoreEvent) + Send + Sync>;

/// Where the store keeps what it downloads and imports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorePaths {
    /// The app's own data folder: icons, the catalogue, downloaded and imported APKs.
    pub user_data: PathBuf,
    /// `android/apps` beside the app, listed under Local.
    pub repo_apps: PathBuf,
    /// Where bundles are unpacked, one directory per job.
    pub scratch: PathBuf,
}

pub struct Store {
    fdroid: Arc<FdroidSource>,
    local: Arc<LocalSource>,
    catalog: Catalog,
    facts: GuestFactsProbe,
    installer: Arc<Installer>,
    play: PlayController,
    library: AppLibrary,
    on_event: EventSink,
    on_log: MessageHandler,
}

impl Store {
    pub fn new(client: OpenEmuClient, paths: &StorePaths, on_log: MessageHandler, on_event: EventSink) -> Arc<Store> {
        let fetch = http_fetcher(http_client());
        Store::with_network(client, paths, on_log, on_event, fetch, http_downloader(http_client()))
    }

    /// [`Store::new`] over a network of the caller's choosing: a test's script.
    pub fn with_network(
        client: OpenEmuClient,
        paths: &StorePaths,
        on_log: MessageHandler,
        on_event: EventSink,
        fetch: Fetcher,
        downloader: Downloader,
    ) -> Arc<Store> {
        let log: MessageHandler = {
            let on_log = on_log.clone();
            Arc::new(move |message: &str| on_log(&format!("[store] {message}")))
        };
        let icons = Arc::new(
            ImageCache::new(paths.user_data.join("store-icons"), fetch.clone()).with_max_bytes(MAX_ICON_BYTES).with_log(log.clone()),
        );
        let fdroid = Arc::new(FdroidSource::new(paths.user_data.join("store-fdroid-index.json"), icons, fetch).with_log(log.clone()));
        let local = Arc::new(LocalSource::new(vec![paths.repo_apps.clone()], paths.user_data.join("local-apks")));
        let catalog = Catalog::new(vec![local.clone() as Arc<dyn AppSource>, fdroid.clone() as Arc<dyn AppSource>]);
        let library = AppLibrary::new(client.clone());
        let installer = Arc::new(
            Installer::new(client.clone(), paths.user_data.join("store-apks"), downloader)
                .with_scratch_dir(paths.scratch.clone())
                .with_log(log.clone()),
        );
        let sink = on_event.clone();
        installer.on_update(Arc::new(move |job: &InstallJob| {
            sink(StoreEvent::Job(job.clone()));
            if job.state == InstallState::Done {
                sink(StoreEvent::Installed(job.resolved_package.clone().unwrap_or_else(|| job.package_name.clone())));
            }
        }));
        Arc::new(Store {
            fdroid,
            local,
            catalog,
            facts: GuestFactsProbe::new(client.clone()).with_log(log.clone()),
            installer,
            play: PlayController::new(client, library.clone()),
            library,
            on_event,
            on_log: log,
        })
    }

    pub fn state(&self) -> StoreState {
        let facts = self.facts.current();
        StoreState {
            index_ready: self.fdroid.is_ready(),
            index_updated_at: self.fdroid.updated_at(),
            index_app_count: self.fdroid.app_count(),
            guest_sdk: facts.sdk,
            play_available: facts.play_available,
            identity_spoofed: facts.identity_spoofed,
        }
    }

    /// Which AVD last answered the guest probe.
    pub fn avd_name(&self) -> Option<String> {
        self.facts.current().avd_name
    }

    pub fn library(&self) -> &AppLibrary {
        &self.library
    }

    pub fn play(&self) -> &PlayController {
        &self.play
    }

    /// Brings the catalogue up to date and asks the guest about itself, in the background.
    pub fn start(self: &Arc<Self>) {
        let store = Arc::clone(self);
        tokio::spawn(async move {
            store.fdroid.refresh(false).await;
            (store.on_event)(StoreEvent::IndexUpdated(store.state()));
        });
        let store = Arc::clone(self);
        tokio::spawn(async move {
            store.facts.probe(false).await;
        });
    }

    /// Re-asks the guest for its API level, Play presence, and identity.
    pub async fn probe_guest(&self, force: bool) -> StoreState {
        self.facts.probe(force).await;
        self.state()
    }

    pub async fn refresh_index(&self, force: bool) -> StoreState {
        self.fdroid.refresh(force).await;
        self.state()
    }

    /// `source` `None` (or Play, which has no catalogue here) searches every source at once.
    pub async fn search(&self, query: &str, source: Option<SourceId>, limit: Option<usize>) -> Vec<StoreApp> {
        let query: String = query.chars().take(MAX_QUERY_CHARS).collect();
        let source = source.filter(|source| *source != SourceId::Play);
        let limit = limit.filter(|&limit| limit > 0).map_or(DEFAULT_SEARCH_LIMIT, |limit| limit.min(MAX_SEARCH_LIMIT));
        self.catalog.search(&query, source, self.facts.current().sdk, limit).await
    }

    pub async fn detail(&self, source: SourceId, package_name: &str) -> Option<AppDetail> {
        self.catalog.detail(source, package_name, self.facts.current().sdk).await
    }

    /// `None` when the app or version could not be resolved. Progress arrives as events.
    pub async fn install(&self, source: SourceId, package_name: &str, version_code: Option<i64>) -> Option<InstallJob> {
        let spec = self.catalog.resolve(source, package_name, version_code, self.facts.current().sdk).await?;
        Some(self.installer.enqueue(spec))
    }

    pub fn jobs(&self) -> Vec<InstallJob> {
        self.installer.jobs()
    }

    /// Installs app files already on this PC: a drop onto the window, or a file chosen. One job
    /// per file; a file that is not an app comes back as a failed job saying why.
    pub async fn install_files(&self, paths: &[PathBuf]) -> Vec<InstallJob> {
        let mut jobs = Vec::new();
        for path in paths.iter().take(MAX_FILES_AT_ONCE) {
            jobs.push(self.install_file(path).await);
        }
        (self.on_event)(StoreEvent::IndexUpdated(self.state()));
        jobs
    }

    async fn install_file(&self, path: &Path) -> InstallJob {
        let label = package_file_label(&path.to_string_lossy());
        let file = path.to_owned();
        let inspected = tokio::task::spawn_blocking(move || inspect_package_file(&file)).await;
        match inspected {
            Ok(Ok(_)) => {}
            Ok(Err(refused)) => return self.installer.refuse(&label, &refused.0),
            Err(_) => return self.installer.refuse(&label, "This file couldn’t be read."),
        }
        let stored = match self.local.import(path).await {
            Ok(stored) => stored,
            Err(error) => {
                (self.on_log)(&format!("could not import {}: {}", path.display(), error.0));
                return self.installer.refuse(&label, "This file couldn’t be copied. Check there is free disk space, then try again.");
            }
        };
        let id = stored.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        match self.local.resolve_file(&id) {
            Some(spec) => self.installer.enqueue(spec),
            None => self.installer.refuse(&label, "This file couldn’t be read."),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use oe_engine::testing::{ok, FakeEngine};
    use oe_formats::testing::fake_apk;

    use super::*;
    use crate::fetch::FetchResponse;
    use crate::installer::DownloadRequest;

    #[tokio::test]
    async fn a_dropped_file_is_imported_installed_and_announced_and_junk_is_refused_in_the_same_list() {
        let dir = tempfile::tempdir().unwrap();
        let paths = StorePaths {
            user_data: dir.path().join("data"),
            repo_apps: dir.path().join("apps"),
            scratch: dir.path().join("scratch"),
        };
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let offline: Fetcher = Arc::new(|_| Box::pin(async { Ok(FetchResponse { status: 503, etag: None, body: Vec::new() }) }));
        let no_downloads: Downloader = Arc::new(|_: DownloadRequest| Box::pin(async { Err(crate::err!("offline")) }));
        let engine = Arc::new(FakeEngine::new().answering(|_| ok(&[])));
        let store = Store::with_network(
            OpenEmuClient::new(engine.clone()),
            &paths,
            Arc::new(|_: &str| {}),
            Arc::new(move |event| seen.lock().unwrap().push(event)),
            offline,
            no_downloads,
        );

        let apk = dir.path().join("Game.apk");
        std::fs::write(&apk, fake_apk("game")).unwrap();
        let notes = dir.path().join("notes.txt");
        std::fs::write(&notes, "hello").unwrap();
        let jobs = store.install_files(&[apk, notes]).await;
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[1].state, InstallState::Failed);

        for _ in 0..200 {
            if events.lock().unwrap().iter().any(|event| matches!(event, StoreEvent::Installed(_))) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(events.lock().unwrap().contains(&StoreEvent::Installed("Game.apk".into())));
        assert!(paths.user_data.join("local-apks").join("Game.apk").exists(), "the drop was copied in");
        assert_eq!(store.search("game", Some(SourceId::Local), None).await.len(), 1);
    }
}
