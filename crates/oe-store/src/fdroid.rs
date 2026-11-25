//! F-Droid as a store source.
//!
//! The whole catalogue is downloaded once, distilled, and searched locally. That is not just a
//! performance choice: searching locally means no request leaves the machine per keystroke, the
//! store works with the network down, and F-Droid's servers see one conditional GET a day instead
//! of one per character typed.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use oe_engine::download::MessageHandler;
use oe_engine::engine::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::fdroid_index::{asset_url, choose_version, distill_index, find_app, search_index, DistilledIndex, IndexApp, DEFAULT_REPO};
use crate::fetch::{FetchRequest, Fetcher};
use crate::image_cache::ImageCache;
use crate::source::{AppSource, DownloadSpec, Location};
use crate::types::{now_ms, AppDetail, AppVersion, SourceId, StoreApp};
use crate::{err, Result};

pub const INDEX_URL: &str = "https://f-droid.org/repo/index-v2.json";
/// The published index is tens of MB; this is a sanity bound, not a target.
const MAX_INDEX_BYTES: usize = 96 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const TTL_MS: i64 = 12 * 60 * 60_000;
/// Icons are fetched in batches so a 60-result grid does not open 60 connections at once.
const ICON_BATCH: usize = 8;

/// The cache file, in the shape the Electron app wrote it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    fetched_at: i64,
    #[serde(default)]
    etag: Option<String>,
    index: DistilledIndex,
}

struct Loaded {
    index: Arc<DistilledIndex>,
    fetched_at: i64,
    etag: Option<String>,
}

pub struct FdroidSource {
    cache_file: PathBuf,
    icons: Arc<ImageCache>,
    fetch: Fetcher,
    on_log: Option<MessageHandler>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    loaded: Mutex<Loaded>,
    /// One refresh at a time; callers that arrive during one share its result.
    refreshing: tokio::sync::Mutex<()>,
    refreshes: AtomicU64,
}

impl FdroidSource {
    pub fn new(cache_file: impl Into<PathBuf>, icons: Arc<ImageCache>, fetch: Fetcher) -> FdroidSource {
        let cache_file = cache_file.into();
        let loaded = read_cache(&cache_file).unwrap_or(Loaded { index: Arc::default(), fetched_at: 0, etag: None });
        FdroidSource {
            cache_file,
            icons,
            fetch,
            on_log: None,
            now: Arc::new(now_ms),
            loaded: Mutex::new(loaded),
            refreshing: tokio::sync::Mutex::new(()),
            refreshes: AtomicU64::new(0),
        }
    }

    pub fn with_log(mut self, on_log: MessageHandler) -> FdroidSource {
        self.on_log = Some(on_log);
        self
    }

    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> FdroidSource {
        self.now = Arc::new(now);
        self
    }

    fn log(&self, message: &str) {
        if let Some(on_log) = &self.on_log {
            on_log(message);
        }
    }

    fn loaded(&self) -> std::sync::MutexGuard<'_, Loaded> {
        self.loaded.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn index(&self) -> Arc<DistilledIndex> {
        self.loaded().index.clone()
    }

    pub fn is_ready(&self) -> bool {
        !self.loaded().index.apps.is_empty()
    }

    pub fn updated_at(&self) -> Option<i64> {
        Some(self.loaded().fetched_at).filter(|&at| at != 0)
    }

    pub fn app_count(&self) -> usize {
        self.loaded().index.apps.len()
    }

    /// Fetches the catalogue if it is stale, or always with `force`. Never fails: a stale
    /// catalogue still serves.
    pub async fn refresh(&self, force: bool) {
        let before = self.refreshes.load(Ordering::SeqCst);
        let _turn = self.refreshing.lock().await;
        if self.refreshes.load(Ordering::SeqCst) != before {
            return; // a refresh finished while this one waited; it is the answer
        }
        let fresh = {
            let loaded = self.loaded();
            !loaded.index.apps.is_empty() && (self.now)() - loaded.fetched_at < TTL_MS
        };
        if force || !fresh {
            if let Err(error) = self.fetch_index().await {
                // Keep serving whatever is cached. A refresh failure is not a store failure.
                self.log(&format!("catalogue refresh failed (serving cache): {}", error.0));
            }
        }
        self.refreshes.fetch_add(1, Ordering::SeqCst);
    }

    async fn fetch_index(&self) -> Result<()> {
        let mut request = FetchRequest::new(INDEX_URL, MAX_INDEX_BYTES, FETCH_TIMEOUT);
        request.accept = Some("application/json");
        // A conditional GET is the difference between a 30 MB transfer and a 200-byte one.
        request.if_none_match = {
            let loaded = self.loaded();
            loaded.etag.clone().filter(|_| !loaded.index.apps.is_empty())
        };
        let response = (self.fetch)(request).await?;
        if response.status == 304 {
            let count = {
                let mut loaded = self.loaded();
                loaded.fetched_at = (self.now)();
                loaded.index.apps.len()
            };
            self.write_cache();
            self.log(&format!("catalogue unchanged ({count} apps)"));
            return Ok(());
        }
        if !response.ok() {
            return Err(err!("HTTP {}", response.status));
        }
        let etag = response.etag;
        let body = response.body;
        // Parsing and distilling tens of megabytes is CPU work, kept off the async threads.
        let distilled = tokio::task::spawn_blocking(move || -> Result<DistilledIndex> {
            let raw: serde_json::Value = serde_json::from_slice(&body).map_err(|error| err!("{error}"))?;
            Ok(distill_index(&raw))
        })
        .await
        .map_err(|error| err!("{error}"))??;
        if distilled.apps.is_empty() {
            return Err(err!("index parsed to zero apps"));
        }
        let count = distilled.apps.len();
        {
            let mut loaded = self.loaded();
            loaded.index = Arc::new(distilled);
            loaded.fetched_at = (self.now)();
            loaded.etag = etag;
        }
        self.write_cache();
        self.log(&format!("catalogue refreshed: {count} apps"));
        Ok(())
    }

    fn write_cache(&self) {
        let payload = {
            let loaded = self.loaded();
            CacheFile { fetched_at: loaded.fetched_at, etag: loaded.etag.clone(), index: (*loaded.index).clone() }
        };
        let written = (|| -> Result<()> {
            if let Some(dir) = self.cache_file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = self.cache_file.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec(&payload).map_err(|error| err!("{error}"))?)?;
            std::fs::rename(&tmp, &self.cache_file)?;
            Ok(())
        })();
        if let Err(error) = written {
            self.log(&format!("catalogue cache write failed: {}", error.0));
        }
    }

    fn to_store_app(&self, index: &DistilledIndex, app: &IndexApp, guest_sdk: Option<u32>) -> StoreApp {
        let version = choose_version(app, guest_sdk);
        StoreApp {
            id: format!("fdroid:{}", app.package_name),
            source: SourceId::Fdroid,
            package_name: app.package_name.clone(),
            name: app.name.clone(),
            summary: app.summary.clone(),
            icon: app.icon_path.as_ref().and_then(|path| self.icons.path_if_ready(&asset_url(&index.repo_address, path))),
            version_name: version.version_name.clone(),
            version_code: version.version_code,
            size_bytes: version.file.size,
            license: app.license.clone(),
            min_sdk: version.min_sdk,
            abis: version.abis.clone(),
            categories: app.categories.clone(),
            last_updated: app.last_updated,
            anti_features: version.anti_features.clone(),
        }
    }

    /// Returns once every icon is cached or has failed. Failures are not fatal.
    async fn prefetch_icons(&self, index: &DistilledIndex, apps: &[&IndexApp]) {
        let urls: Vec<String> = apps
            .iter()
            .filter_map(|app| app.icon_path.as_ref())
            .map(|path| asset_url(&index.repo_address, path))
            .filter(|url| self.icons.path_if_ready(url).is_none())
            .collect();
        for batch in urls.chunks(ICON_BATCH) {
            self.icons.prefetch(batch).await;
        }
    }

    pub async fn search_apps(&self, query: &str, guest_sdk: Option<u32>, limit: usize) -> Vec<StoreApp> {
        let index = self.index();
        let matches = search_index(&index, query, limit, (self.now)());
        self.prefetch_icons(&index, &matches).await;
        matches.into_iter().map(|app| self.to_store_app(&index, app, guest_sdk)).collect()
    }

    pub async fn app_detail(&self, package_name: &str, guest_sdk: Option<u32>) -> Option<AppDetail> {
        let index = self.index();
        let app = find_app(&index, package_name)?;
        let shots: Vec<String> = app.screenshot_paths.iter().map(|path| asset_url(&index.repo_address, path)).collect();
        self.icons.prefetch(&shots).await;
        let chosen = choose_version(app, guest_sdk).version_code;
        Some(AppDetail {
            app: self.to_store_app(&index, app, guest_sdk),
            description: app.description.clone(),
            web_site: app.web_site.clone(),
            source_code: app.source_code.clone(),
            screenshots: shots.iter().filter_map(|url| self.icons.path_if_ready(url)).collect(),
            other_versions: app
                .versions
                .iter()
                .filter(|version| version.version_code != chosen)
                .map(|version| AppVersion {
                    version_name: version.version_name.clone(),
                    version_code: version.version_code,
                    size_bytes: version.file.size,
                    min_sdk: version.min_sdk,
                    added: version.added,
                })
                .collect(),
        })
    }

    pub fn resolve_app(&self, package_name: &str, version_code: Option<i64>, guest_sdk: Option<u32>) -> Option<DownloadSpec> {
        let index = self.index();
        let app = find_app(&index, package_name)?;
        let version = match version_code {
            None => choose_version(app, guest_sdk),
            Some(code) => app.versions.iter().find(|candidate| candidate.version_code == code)?,
        };
        Some(DownloadSpec {
            package_name: package_name.to_owned(),
            label: app.name.clone(),
            source: SourceId::Fdroid,
            location: Location::Url(asset_url(&index.repo_address, &version.file.name)),
            sha256: Some(version.file.sha256.clone()),
            size_bytes: version.file.size,
            version_name: version.version_name.clone(),
        })
    }
}

impl AppSource for FdroidSource {
    fn id(&self) -> SourceId {
        SourceId::Fdroid
    }

    fn search<'a>(&'a self, query: &'a str, guest_sdk: Option<u32>, limit: usize) -> BoxFuture<'a, Result<Vec<StoreApp>>> {
        Box::pin(async move { Ok(self.search_apps(query, guest_sdk, limit).await) })
    }

    fn detail<'a>(&'a self, package_name: &'a str, guest_sdk: Option<u32>) -> BoxFuture<'a, Option<AppDetail>> {
        Box::pin(self.app_detail(package_name, guest_sdk))
    }

    fn resolve<'a>(&'a self, package_name: &'a str, version_code: Option<i64>, guest_sdk: Option<u32>) -> BoxFuture<'a, Option<DownloadSpec>> {
        Box::pin(async move { self.resolve_app(package_name, version_code, guest_sdk) })
    }
}

/// The cached catalogue, or `None` if there is no usable one: the store then says it is updating
/// the catalogue until the first refresh lands.
fn read_cache(file: &std::path::Path) -> Option<Loaded> {
    let cache: CacheFile = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let mut index = cache.index;
    if index.repo_address.is_empty() {
        index.repo_address = DEFAULT_REPO.to_owned();
    }
    Some(Loaded { index: Arc::new(index), fetched_at: cache.fetched_at, etag: cache.etag })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use serde_json::json;

    use super::*;
    use crate::fdroid_index::tests::{app, version};
    use crate::fetch::FetchResponse;
    use crate::image_cache::tests::PNG;

    fn catalogue() -> Vec<u8> {
        let packages = json!({
            "org.signal": app("Signal", "Private messenger", 1000, json!({ "a": version(10, 21), "b": version(11, 33) })),
            "org.pipe": app("NewPipe", "YouTube client", 900, json!({ "a": version(1, 21) })),
        });
        serde_json::to_vec(&json!({ "repo": { "address": "https://f-droid.org/repo", "timestamp": 1 }, "packages": packages })).unwrap()
    }

    /// A network that serves the catalogue at the index URL and a PNG everywhere else. Records
    /// each index request's `if-none-match`.
    struct Net {
        fetch: Fetcher,
        index_requests: Arc<Mutex<Vec<Option<String>>>>,
        status: Arc<Mutex<u16>>,
        body: Arc<Mutex<Vec<u8>>>,
        icon_requests: Arc<AtomicUsize>,
    }

    fn net() -> Net {
        let index_requests = Arc::new(Mutex::new(Vec::new()));
        let status = Arc::new(Mutex::new(200));
        let body = Arc::new(Mutex::new(catalogue()));
        let icon_requests = Arc::new(AtomicUsize::new(0));
        let (seen, code, served, icons) = (index_requests.clone(), status.clone(), body.clone(), icon_requests.clone());
        let fetch: Fetcher = Arc::new(move |request: FetchRequest| {
            let response = if request.url == INDEX_URL {
                seen.lock().unwrap().push(request.if_none_match.clone());
                let status = *code.lock().unwrap();
                Ok(FetchResponse { status, etag: Some("\"v1\"".into()), body: served.lock().unwrap().clone() })
            } else {
                icons.fetch_add(1, Ordering::SeqCst);
                Ok(FetchResponse { status: 200, etag: None, body: PNG.to_vec() })
            };
            Box::pin(async move { response })
        });
        Net { fetch, index_requests, status, body, icon_requests }
    }

    fn source(dir: &std::path::Path, net: &Net) -> FdroidSource {
        let icons = Arc::new(ImageCache::new(dir.join("icons"), net.fetch.clone()));
        FdroidSource::new(dir.join("fdroid-index.json"), icons, net.fetch.clone()).with_clock(|| 5_000)
    }

    #[tokio::test]
    async fn the_catalogue_is_fetched_distilled_and_searchable() {
        let dir = tempfile::tempdir().unwrap();
        let net = net();
        let fdroid = source(dir.path(), &net);
        assert!(!fdroid.is_ready());
        fdroid.refresh(false).await;
        assert_eq!(fdroid.app_count(), 2);
        let hits = fdroid.search_apps("signal", Some(30), 10).await;
        assert_eq!(hits[0].package_name, "org.signal");
        assert_eq!(hits[0].id, "fdroid:org.signal");
    }

    #[tokio::test]
    async fn the_distilled_catalogue_is_cached_and_reloaded_without_a_second_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let net = net();
        source(dir.path(), &net).refresh(false).await;
        let reloaded = source(dir.path(), &net);
        assert_eq!(reloaded.app_count(), 2, "read back from disk");
        reloaded.refresh(false).await;
        assert_eq!(net.index_requests.lock().unwrap().len(), 1, "fresh enough: no second download");
    }

    #[tokio::test]
    async fn a_refresh_sends_a_conditional_get_and_a_304_keeps_the_catalogue() {
        let dir = tempfile::tempdir().unwrap();
        let net = net();
        let fdroid = source(dir.path(), &net);
        fdroid.refresh(false).await;
        *net.status.lock().unwrap() = 304;
        *net.body.lock().unwrap() = Vec::new();
        fdroid.refresh(true).await;
        assert_eq!(*net.index_requests.lock().unwrap(), [None, Some("\"v1\"".to_owned())]);
        assert_eq!(fdroid.app_count(), 2, "a 304 keeps what is cached rather than emptying it");
    }

    #[tokio::test]
    async fn a_failed_or_empty_refresh_keeps_serving_what_is_cached() {
        let dir = tempfile::tempdir().unwrap();
        let net = net();
        let fdroid = source(dir.path(), &net);
        fdroid.refresh(false).await;
        *net.status.lock().unwrap() = 500;
        fdroid.refresh(true).await;
        assert_eq!(fdroid.app_count(), 2);
        *net.status.lock().unwrap() = 200;
        *net.body.lock().unwrap() = br#"{"repo":{},"packages":{}}"#.to_vec();
        fdroid.refresh(true).await;
        assert_eq!(fdroid.app_count(), 2, "an index that parses to nothing does not replace a good one");
    }

    #[tokio::test]
    async fn the_version_offered_depends_on_the_guest_and_resolve_can_pin_one() {
        let dir = tempfile::tempdir().unwrap();
        let net = net();
        let fdroid = source(dir.path(), &net);
        fdroid.refresh(false).await;
        assert_eq!(fdroid.resolve_app("org.signal", None, Some(30)).unwrap().version_name, "10.0");
        assert_eq!(fdroid.resolve_app("org.signal", None, Some(34)).unwrap().version_name, "11.0");
        let pinned = fdroid.resolve_app("org.signal", Some(11), Some(30)).unwrap();
        assert_eq!(pinned.location, Location::Url("https://f-droid.org/repo/app_11.apk".into()));
        assert_eq!(pinned.sha256.as_deref().map(str::len), Some(64), "the digest to check the download against");
        assert!(fdroid.resolve_app("org.signal", Some(99), None).is_none());
    }

    #[tokio::test]
    async fn icons_are_ready_on_the_first_search_and_detail_carries_other_versions() {
        let dir = tempfile::tempdir().unwrap();
        let net = net();
        let fdroid = source(dir.path(), &net);
        fdroid.refresh(false).await;
        let hits = fdroid.search_apps("", None, 10).await;
        assert!(hits.iter().all(|hit| hit.icon.is_some()), "not a render later");
        assert_eq!(net.icon_requests.load(Ordering::SeqCst), 2);
        let detail = fdroid.app_detail("org.signal", Some(30)).await.unwrap();
        assert_eq!(detail.other_versions.iter().map(|v| v.version_code).collect::<Vec<_>>(), [11]);
    }
}
