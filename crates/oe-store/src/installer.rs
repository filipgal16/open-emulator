//! Gets an app from wherever it lives into the guest.
//!
//! Jobs run one at a time: a queue of installs racing each other through one emulator is slower in
//! aggregate than doing them in order, and a single progress bar that means something beats five
//! that do not.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use oe_engine::client::OpenEmuClient;
use oe_engine::download::{download_file, DigestAlgorithm, DownloadOptions, DownloadProgress, MessageHandler};
use oe_engine::engine::BoxFuture;
use oe_engine::{no_log, CommandResult};
use oe_formats::zip_archive::{extract_zip_entry, ZipEntry, ZipError};

use crate::app_library::AppLibrary;
use crate::bundle::{
    inspect_package_file, install_timeout, is_package_name, parse_abi_list, plan_expansions, select_apks, AppBundle, NamedSize,
    PackageFile,
};
use crate::source::{DownloadSpec, Location};
use crate::types::{now_ms, InstallJob, InstallState, SourceId};
use crate::{err, Result};

const MAX_APK_BYTES: u64 = 1_500 * 1024 * 1024;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Unpacking gigabytes in 64 KB chunks would otherwise send the window tens of thousands of updates.
const PROGRESS_INTERVAL_MS: i64 = 200;

pub type JobListener = Arc<dyn Fn(&InstallJob) + Send + Sync>;
pub type ProgressSink = Arc<dyn Fn(u64, u64) + Send + Sync>;

/// One APK to fetch: written to `target` only once its SHA-256 matches.
pub struct DownloadRequest {
    pub url: String,
    pub target: PathBuf,
    pub sha256: String,
    pub on_progress: ProgressSink,
}

pub type Downloader = Arc<dyn Fn(DownloadRequest) -> BoxFuture<'static, Result<()>> + Send + Sync>;

/// Downloads over https, resuming a partial file, and verifying the digest before the file takes
/// its final name, so the cache can never hold a bad artefact under a name that says it is good.
pub fn http_downloader(client: reqwest::Client) -> Downloader {
    Arc::new(move |request: DownloadRequest| {
        let client = client.clone();
        Box::pin(async move {
            let progress = request.on_progress.clone();
            let options = DownloadOptions {
                client,
                on_progress: Some(Arc::new(move |p: &DownloadProgress| progress(p.bytes_done, p.bytes_total))),
                on_log: None,
                max_bytes: MAX_APK_BYTES,
            };
            let spec =
                oe_engine::download::DownloadSpec::new(request.url, request.target).digest(DigestAlgorithm::Sha256, request.sha256);
            download_file(&spec, &options).await.map(|_| ()).map_err(|error| err!("{}", error.message))
        })
    })
}

#[derive(Default)]
struct Queue {
    jobs: Vec<InstallJob>,
    specs: HashMap<String, DownloadSpec>,
    running: bool,
}

pub struct Installer {
    client: OpenEmuClient,
    library: AppLibrary,
    download_dir: PathBuf,
    scratch_dir: PathBuf,
    downloader: Downloader,
    on_log: Option<MessageHandler>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    queue: Mutex<Queue>,
    listeners: Mutex<Vec<JobListener>>,
    ids: AtomicU64,
}

fn base36(mut value: u64) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(digits[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

impl Installer {
    /// Bundles are unpacked into a directory beside the download cache, one per job, removed when
    /// the job ends however it ends.
    pub fn new(client: OpenEmuClient, download_dir: impl Into<PathBuf>, downloader: Downloader) -> Installer {
        let download_dir = download_dir.into();
        let mut scratch = download_dir.clone().into_os_string();
        scratch.push("-unpacking");
        Installer {
            library: AppLibrary::new(client.clone()),
            client,
            scratch_dir: PathBuf::from(scratch),
            download_dir,
            downloader,
            on_log: None,
            now: Arc::new(now_ms),
            queue: Mutex::default(),
            listeners: Mutex::default(),
            ids: AtomicU64::new(0),
        }
    }

    pub fn with_log(mut self, on_log: MessageHandler) -> Installer {
        self.on_log = Some(on_log);
        self
    }

    pub fn with_scratch_dir(mut self, dir: impl Into<PathBuf>) -> Installer {
        self.scratch_dir = dir.into();
        self
    }

    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> Installer {
        self.now = Arc::new(now);
        self
    }

    fn log(&self, message: &str) {
        if let Some(on_log) = &self.on_log {
            on_log(message);
        }
    }

    fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn on_update(&self, listener: JobListener) {
        self.listeners.lock().unwrap_or_else(|p| p.into_inner()).push(listener);
    }

    /// Active and recently finished jobs, newest first.
    pub fn jobs(&self) -> Vec<InstallJob> {
        self.queue().jobs.iter().rev().cloned().collect()
    }

    fn new_job(&self, package_name: &str, label: &str, source: SourceId) -> InstallJob {
        let now = (self.now)();
        let sequence = self.ids.fetch_add(1, Ordering::SeqCst);
        InstallJob {
            id: format!("{}-{}", base36(now.max(0) as u64), base36(sequence)),
            package_name: package_name.to_owned(),
            resolved_package: None,
            label: label.to_owned(),
            source,
            state: InstallState::Queued,
            bytes_done: 0,
            bytes_total: 0,
            error: None,
            started_at: now,
        }
    }

    /// Queues an install. The same app already in flight returns that job instead of a second.
    pub fn enqueue(self: &Arc<Self>, spec: DownloadSpec) -> InstallJob {
        let (job, start) = {
            let mut queue = self.queue();
            let in_flight = queue
                .jobs
                .iter()
                .find(|job| job.package_name == spec.package_name && job.source == spec.source && !job.state.is_finished());
            if let Some(existing) = in_flight {
                return existing.clone();
            }
            let mut job = self.new_job(&spec.package_name, &spec.label, spec.source);
            job.resolved_package = (spec.source != SourceId::Local).then(|| spec.package_name.clone());
            job.bytes_total = spec.size_bytes;
            queue.jobs.push(job.clone());
            queue.specs.insert(job.id.clone(), spec);
            let start = !queue.running;
            queue.running = true;
            (job, start)
        };
        self.emit(&job);
        if start {
            tokio::spawn(Arc::clone(self).drain());
        }
        job
    }

    /// Records a file turned away before it could become a job, as a failed job rather than a
    /// return value, so the reason appears in the install list the person is already watching.
    pub fn refuse(&self, label: &str, reason: &str) -> InstallJob {
        let mut job = self.new_job(label, label, SourceId::Local);
        job.state = InstallState::Failed;
        job.error = Some(reason.to_owned());
        self.log(&format!("refused {label}: {reason}"));
        self.queue().jobs.push(job.clone());
        self.emit(&job);
        job
    }

    fn emit(&self, job: &InstallJob) {
        let listeners = self.listeners.lock().unwrap_or_else(|p| p.into_inner()).clone();
        for listener in listeners {
            listener(job);
        }
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut InstallJob)) {
        let updated = {
            let mut queue = self.queue();
            let Some(job) = queue.jobs.iter_mut().find(|job| job.id == id) else { return };
            change(job);
            job.clone()
        };
        self.emit(&updated);
    }

    fn fail(&self, id: &str, message: &str) {
        let label = self.queue().jobs.iter().find(|job| job.id == id).map(|job| job.label.clone()).unwrap_or_default();
        self.log(&format!("install failed ({label}): {message}"));
        self.update(id, |job| {
            job.state = InstallState::Failed;
            job.error = Some(message.to_owned());
        });
    }

    async fn drain(self: Arc<Self>) {
        loop {
            let next = {
                let mut queue = self.queue();
                match queue.jobs.iter().find(|job| job.state == InstallState::Queued).map(|job| job.id.clone()) {
                    Some(id) => {
                        let spec = queue.specs.get(&id).cloned();
                        Some((id, spec))
                    }
                    None => {
                        queue.running = false;
                        None
                    }
                }
            };
            let Some((id, spec)) = next else { return };
            match spec {
                Some(spec) => self.run(&id, spec).await,
                None => self.fail(&id, "internal: job lost its download spec"),
            }
        }
    }

    async fn run(self: &Arc<Self>, id: &str, spec: DownloadSpec) {
        let prepared = match &spec.location {
            Location::File(path) => match self.use_local_file(id, path) {
                Ok(()) => bundle_in(path).await.map(|bundle| (path.clone(), bundle)),
                Err(error) => Err(error),
            },
            Location::Url(url) => self.download(id, &spec, url).await.map(|path| (path, None)),
        };
        let (path, bundle) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => return self.fail(id, &error.0),
        };
        if let Some(bundle) = bundle {
            return self.run_bundle(id, &spec, &path, bundle).await;
        }

        // A local file's package is not known until the guest has it: the difference between the
        // package lists before and after says which one it was.
        let needs_diff = spec.source == SourceId::Local;
        let before = if needs_diff { self.library.package_names().await } else { Vec::new() };
        self.update(id, |job| job.state = InstallState::Installing);
        let result = self.client.install(&path.to_string_lossy(), no_log(), Some(INSTALL_TIMEOUT)).await;
        if !result.success() {
            return self.fail(id, &failure_detail(&result, "adb install"));
        }
        if needs_diff {
            let added: Vec<String> = self.library.package_names().await.into_iter().filter(|name| !before.contains(name)).collect();
            if let [only] = added.as_slice() {
                let only = only.clone();
                self.update(id, |job| job.resolved_package = Some(only));
            }
        }
        self.update(id, |job| {
            job.state = InstallState::Done;
            if job.bytes_total > 0 {
                job.bytes_done = job.bytes_total;
            }
        });
        let name = self.queue().jobs.iter().find(|job| job.id == id).map(|job| job.resolved_package.clone().unwrap_or_else(|| job.label.clone()));
        self.log(&format!("installed {} ({})", name.unwrap_or_default(), spec.source.id()));
    }

    fn use_local_file(&self, id: &str, path: &Path) -> Result<()> {
        let size = std::fs::metadata(path).map_err(|_| err!("the APK file is no longer there"))?.len();
        self.update(id, |job| {
            job.bytes_done = size;
            job.bytes_total = size;
            job.state = InstallState::Verifying;
        });
        Ok(())
    }

    /// Fetches the APK and checks it against the catalogue's digest before the guest sees it. An
    /// APK is executable code: "downloaded from the right URL" is not the same claim as "is the
    /// artefact the catalogue signed for", and only the second one is worth acting on.
    async fn download(self: &Arc<Self>, id: &str, spec: &DownloadSpec, url: &str) -> Result<PathBuf> {
        let Some(sha256) = spec.sha256.clone() else {
            return Err(err!("refusing to install a network APK with no expected digest"));
        };
        if !url.get(..8).is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://")) {
            return Err(err!("refusing a non-https download"));
        }
        std::fs::create_dir_all(&self.download_dir)?;
        let final_path = self.download_dir.join(format!("{sha256}.apk"));
        if let Ok(meta) = std::fs::metadata(&final_path) {
            let size = meta.len();
            self.update(id, |job| {
                job.state = InstallState::Verifying;
                job.bytes_done = size;
                job.bytes_total = size;
            });
            return Ok(final_path);
        }

        self.update(id, |job| {
            job.state = InstallState::Downloading;
            job.bytes_done = 0;
        });
        let installer = Arc::clone(self);
        let job_id = id.to_owned();
        let last_emit = Arc::new(AtomicI64::new(0));
        let on_progress: ProgressSink = Arc::new(move |done, total| {
            let now = (installer.now)();
            if now - last_emit.load(Ordering::Relaxed) < PROGRESS_INTERVAL_MS && done < total {
                return;
            }
            last_emit.store(now, Ordering::Relaxed);
            installer.update(&job_id, |job| {
                job.bytes_done = done;
                if total > 0 {
                    job.bytes_total = total;
                }
            });
        });
        (self.downloader)(DownloadRequest { url: url.to_owned(), target: final_path.clone(), sha256, on_progress }).await?;
        self.update(id, |job| job.state = InstallState::Verifying);
        Ok(final_path)
    }

    /// Unpacks the APKs this guest needs from a bundle and installs them in one session, then copies
    /// any game data files into place.
    ///
    /// The guest is asked for its processor types before anything is unpacked, so a bundle it
    /// cannot run is turned away in a second rather than after minutes of extracting gigabytes. The
    /// scratch directory goes whichever way the job ends.
    async fn run_bundle(self: &Arc<Self>, id: &str, spec: &DownloadSpec, bundle_path: &Path, bundle: AppBundle) {
        let abis = parse_abi_list(self.client.getprop("ro.product.cpu.abilist", no_log()).await.as_deref());
        if abis.is_empty() {
            return self.fail(id, "The device isn’t answering. Start it, then try again.");
        }
        let sized: Vec<NamedSize> = bundle.apks.iter().map(|entry| NamedSize { name: entry.name.clone(), size: entry.size }).collect();
        let chosen = match select_apks(&sized, bundle.manifest.as_ref(), &abis) {
            Ok(selection) => selection.apks,
            Err(error) => return self.fail(id, &error.0),
        };
        let members: Vec<ZipEntry> =
            chosen.iter().filter_map(|name| bundle.apks.iter().find(|entry| &entry.name == name).cloned()).collect();
        let manifest_package = bundle.manifest.as_ref().and_then(|manifest| manifest.package_name.clone());
        let expansions = plan_expansions(&bundle, manifest_package.as_deref());
        let work_dir = self.scratch_dir.join(format!("bundle-{id}"));

        let outcome = self.unpack_and_install(id, spec, bundle_path, &work_dir, &members, &expansions, manifest_package).await;
        let _ = std::fs::remove_dir_all(&work_dir);
        if let Err(message) = outcome {
            self.fail(id, &message);
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn unpack_and_install(
        self: &Arc<Self>,
        id: &str,
        spec: &DownloadSpec,
        bundle_path: &Path,
        work_dir: &Path,
        members: &[ZipEntry],
        expansions: &[crate::bundle::ExpansionPlan],
        manifest_package: Option<String>,
    ) -> std::result::Result<(), String> {
        let total: u64 = members.iter().map(|entry| entry.size).chain(expansions.iter().map(|plan| plan.entry.size)).sum();
        let _ = std::fs::remove_dir_all(work_dir);
        std::fs::create_dir_all(work_dir).map_err(|error| io_failure(&error.to_string()))?;
        self.update(id, |job| {
            job.state = InstallState::Unpacking;
            job.bytes_done = 0;
            job.bytes_total = total;
        });

        // On a worker thread: inflating gigabytes would otherwise stall every other request.
        let installer = Arc::clone(self);
        let (job_id, source, dir) = (id.to_owned(), bundle_path.to_owned(), work_dir.to_owned());
        let (apk_entries, obb_entries): (Vec<ZipEntry>, Vec<ZipEntry>) =
            (members.to_vec(), expansions.iter().map(|plan| plan.entry.clone()).collect());
        let unpacked = tokio::task::spawn_blocking(move || -> std::result::Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
            let (mut done, mut last_emit) = (0u64, 0i64);
            let mut progress = |bytes: u64| {
                done += bytes;
                let now = (installer.now)();
                if now - last_emit >= PROGRESS_INTERVAL_MS {
                    last_emit = now;
                    installer.update(&job_id, |job| job.bytes_done = done);
                }
            };
            let mut extract = |entries: &[ZipEntry], extension: &str| -> std::result::Result<Vec<PathBuf>, String> {
                let mut paths = Vec::new();
                for (index, entry) in entries.iter().enumerate() {
                    let target = dir.join(format!("{index}.{extension}"));
                    extract_zip_entry(&source, entry, &target, &mut progress).map_err(|error| unpack_failure(&error))?;
                    paths.push(target);
                }
                Ok(paths)
            };
            Ok((extract(&apk_entries, "apk")?, extract(&obb_entries, "obb")?))
        });
        let (apk_paths, obb_paths) = unpacked.await.map_err(|error| error.to_string())??;

        let before = self.library.package_names().await;
        self.update(id, |job| {
            job.state = InstallState::Installing;
            job.bytes_done = total;
        });
        let install_bytes = members.iter().map(|entry| entry.size).sum();
        let paths: Vec<String> = apk_paths.iter().map(|path| path.to_string_lossy().into_owned()).collect();
        let result = self.client.install_multiple(&paths, no_log(), Some(install_timeout(install_bytes))).await;
        if !result.success() {
            return Err(failure_detail(&result, "install-multiple"));
        }

        let added: Vec<String> = self.library.package_names().await.into_iter().filter(|name| !before.contains(name)).collect();
        let resolved = match added.as_slice() {
            [only] => Some(only.clone()),
            _ => manifest_package.filter(|package| is_package_name(package)),
        };
        if let Some(resolved) = resolved {
            self.update(id, |job| job.resolved_package = Some(resolved));
        }

        let mut warning = None;
        for (plan, obb) in expansions.iter().zip(&obb_paths) {
            let pushed = self
                .client
                .push_file(&obb.to_string_lossy(), &plan.guest_path, no_log(), Some(install_timeout(plan.entry.size)))
                .await;
            if !pushed.success() {
                self.log(&format!("could not copy {}: {}", plan.guest_path, failure_detail(&pushed, "adb push")));
                warning = Some("Installed, but the game’s data files couldn’t be copied. It may download them again when it starts.".to_owned());
                break;
            }
        }
        self.update(id, |job| {
            job.state = InstallState::Done;
            job.bytes_done = total;
            job.error = warning;
        });
        let name = self.queue().jobs.iter().find(|job| job.id == id).map(|job| job.resolved_package.clone().unwrap_or_else(|| job.label.clone()));
        self.log(&format!(
            "installed {} ({}, {} APKs, {} OBBs)",
            name.unwrap_or_default(),
            spec.source.id(),
            members.len(),
            expansions.len()
        ));
        Ok(())
    }
}

/// A local file's bundle contents, or `None` to install it as a single APK.
///
/// A file named `.apk` that turns out not to be a bundle goes to the guest as it is, even when it
/// could not be read as a zip: the guest's package manager is the authority on what an APK is, and
/// its own refusal says more than a guess from here. A `.xapk` or `.apks` has no such fallback.
async fn bundle_in(path: &Path) -> Result<Option<AppBundle>> {
    let file = path.to_owned();
    let inspected = tokio::task::spawn_blocking(move || inspect_package_file(&file)).await.map_err(|error| err!("{error}"))?;
    match inspected {
        Ok(PackageFile::Bundle(bundle)) => Ok(Some(bundle)),
        Ok(PackageFile::Apk) => Ok(None),
        Err(_) if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("apk")) => Ok(None),
        Err(error) => Err(err!("{}", error.0)),
    }
}

/// The one line of adb's output worth showing. "fail" rather than "failure": adb's own wording is
/// "failed to install" and "INSTALL_FAILED_…".
pub fn failure_detail(result: &CommandResult, command: &str) -> String {
    let worth = |line: &&String| {
        let lower = line.to_lowercase();
        ["fail", "error", "not allowed", "invalid", "denied"].iter().any(|word| lower.contains(word))
    };
    result
        .stderr
        .iter()
        .chain(&result.stdout)
        .filter(worth)
        .next_back()
        .cloned()
        .unwrap_or_else(|| format!("{command} exited {}", result.code.map_or_else(|| "null".to_owned(), |code| code.to_string())))
}

fn io_failure(message: &str) -> String {
    // ERROR_DISK_FULL on Windows, ENOSPC elsewhere.
    if message.contains("os error 112") || message.contains("os error 28") {
        "There isn’t enough free disk space to unpack this app.".to_owned()
    } else {
        message.to_owned()
    }
}

/// Unpacking errors, translated for the person who chose the file.
fn unpack_failure(error: &ZipError) -> String {
    if error.0.contains("(os error") {
        io_failure(&error.0)
    } else {
        "This file is damaged. Download it again, then try again.".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use oe_engine::testing::{failed, ok, FakeEngine};
    use oe_formats::testing::{fake_apk, make_zip, ZipFile};

    use super::*;

    /// A network that hands over `bytes` for every APK, or fails with `error`.
    fn downloader(bytes: &'static [u8], error: Option<&'static str>) -> (Downloader, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let fetch: Downloader = Arc::new(move |request: DownloadRequest| {
            seen.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if let Some(error) = error {
                    return Err(err!("{error}"));
                }
                (request.on_progress)(bytes.len() as u64, bytes.len() as u64);
                std::fs::write(&request.target, bytes)?;
                Ok(())
            })
        });
        (fetch, calls)
    }

    fn installer(dir: &Path, engine: Arc<FakeEngine>, fetch: Downloader) -> Arc<Installer> {
        Arc::new(Installer::new(OpenEmuClient::new(engine), dir.join("apks"), fetch).with_scratch_dir(dir.join("scratch")))
    }

    fn fdroid(url: &str, sha256: Option<&str>) -> DownloadSpec {
        DownloadSpec {
            package_name: "org.example".into(),
            label: "Example".into(),
            source: SourceId::Fdroid,
            location: Location::Url(url.into()),
            sha256: sha256.map(str::to_owned),
            size_bytes: 3,
            version_name: "1.0".into(),
        }
    }

    fn local(path: &Path) -> DownloadSpec {
        DownloadSpec {
            package_name: path.file_name().unwrap().to_string_lossy().into_owned(),
            label: "file".into(),
            source: SourceId::Local,
            location: Location::File(path.to_owned()),
            sha256: None,
            size_bytes: 0,
            version_name: String::new(),
        }
    }

    async fn finished(installer: &Installer, id: &str) -> InstallJob {
        for _ in 0..500 {
            if let Some(job) = installer.jobs().into_iter().find(|job| job.id == id && job.state.is_finished()) {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the job never finished: {:?}", installer.jobs());
    }

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[tokio::test]
    async fn a_verified_download_is_installed_and_cached_under_its_own_digest() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(FakeEngine::new());
        let (fetch, calls) = downloader(b"apk", None);
        let installer = installer(dir.path(), engine.clone(), fetch);
        let job = installer.enqueue(fdroid("https://f-droid.org/repo/x.apk", Some(SHA)));
        let done = finished(&installer, &job.id).await;
        assert_eq!(done.state, InstallState::Done, "{:?}", done.error);
        let cached = dir.path().join("apks").join(format!("{SHA}.apk"));
        assert_eq!(*engine.installs.lock().unwrap(), [vec![cached.to_string_lossy().into_owned()]]);

        let again = installer.enqueue(fdroid("https://f-droid.org/repo/x.apk", Some(SHA)));
        finished(&installer, &again.id).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "an already-cached digest is not downloaded twice");
    }

    #[tokio::test]
    async fn a_digest_mismatch_fails_the_job_and_nothing_reaches_the_guest() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(FakeEngine::new());
        let (fetch, _) = downloader(b"apk", Some("the download did not match its expected digest"));
        let installer = installer(dir.path(), engine.clone(), fetch);
        let job = finished(&installer, &installer.enqueue(fdroid("https://f-droid.org/repo/x.apk", Some(SHA))).id).await;
        assert_eq!(job.state, InstallState::Failed);
        assert!(job.error.unwrap().contains("digest"));
        assert!(engine.installs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn no_digest_or_plain_http_is_refused_before_any_request() {
        let dir = tempfile::tempdir().unwrap();
        let (fetch, calls) = downloader(b"apk", None);
        let installer = installer(dir.path(), Arc::new(FakeEngine::new()), fetch);
        let unsigned = finished(&installer, &installer.enqueue(fdroid("https://f-droid.org/x.apk", None)).id).await;
        assert!(unsigned.error.unwrap().contains("no expected digest"));
        let plain = finished(&installer, &installer.enqueue(fdroid("http://f-droid.org/x.apk", Some(SHA))).id).await;
        assert!(plain.error.unwrap().contains("non-https"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_local_apk_is_installed_from_disk_and_its_real_package_learnt_from_the_guest() {
        let dir = tempfile::tempdir().unwrap();
        let apk = dir.path().join("thing.apk");
        std::fs::write(&apk, fake_apk("thing")).unwrap();
        let lists = Arc::new(AtomicUsize::new(0));
        let count = lists.clone();
        let engine = Arc::new(FakeEngine::new().answering(move |command| {
            if command != "pm list packages -3" {
                return ok(&[]);
            }
            match count.fetch_add(1, Ordering::SeqCst) {
                0 => ok(&["package:com.old"]),
                _ => ok(&["package:com.old", "package:com.thing"]),
            }
        }));
        let (fetch, _) = downloader(b"", None);
        let installer = installer(dir.path(), engine.clone(), fetch);
        let job = finished(&installer, &installer.enqueue(local(&apk)).id).await;
        assert_eq!(job.state, InstallState::Done);
        assert_eq!(job.resolved_package.as_deref(), Some("com.thing"));
        assert_eq!(job.package_name, "thing.apk", "the id it was started with stays");
    }

    #[tokio::test]
    async fn a_failing_install_surfaces_the_guests_own_reason_and_a_missing_file_fails_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let apk = dir.path().join("old.apk");
        std::fs::write(&apk, fake_apk("old")).unwrap();
        let engine = Arc::new(FakeEngine::new());
        *engine.install_result.lock().unwrap() = Some(failed("adb: failed to install old.apk: Failure [INSTALL_FAILED_OLDER_SDK]"));
        let (fetch, _) = downloader(b"", None);
        let installer = installer(dir.path(), engine, fetch);
        let job = finished(&installer, &installer.enqueue(local(&apk)).id).await;
        assert!(job.error.unwrap().contains("INSTALL_FAILED_OLDER_SDK"));
        let gone = finished(&installer, &installer.enqueue(local(&dir.path().join("gone.apk"))).id).await;
        assert_eq!(gone.error.as_deref(), Some("the APK file is no longer there"));
    }

    #[tokio::test]
    async fn enqueueing_the_same_app_twice_returns_the_job_already_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let (fetch, _) = downloader(b"apk", None);
        let installer = installer(dir.path(), Arc::new(FakeEngine::new()), fetch);
        let first = installer.enqueue(fdroid("https://f-droid.org/repo/x.apk", Some(SHA)));
        let second = installer.enqueue(fdroid("https://f-droid.org/repo/x.apk", Some(SHA)));
        assert_eq!(first.id, second.id);
    }

    fn game_bundle(dir: &Path, abis: &[&str]) -> PathBuf {
        let base = fake_apk("base");
        let lang = fake_apk("en");
        let natives: Vec<(String, Vec<u8>)> = abis.iter().map(|abi| (format!("config.{abi}.apk"), fake_apk(abi))).collect();
        let manifest = br#"{"package_name":"com.game","split_apks":[{"file":"com.game.apk","id":"base"}],"expansions":[{"file":"Android/obb/com.game/main.1.com.game.obb","install_path":"Android/obb/com.game/main.1.com.game.obb"}]}"#;
        let mut files = vec![
            ZipFile::stored("com.game.apk", &base),
            ZipFile::stored("config.en.apk", &lang),
            ZipFile::deflated("manifest.json", manifest),
            ZipFile::deflated("Android/obb/com.game/main.1.com.game.obb", b"game data"),
        ];
        files.extend(natives.iter().map(|(name, data)| ZipFile::stored(name, data)));
        let path = dir.join("game.xapk");
        std::fs::write(&path, make_zip(&files, false)).unwrap();
        path
    }

    #[tokio::test]
    async fn a_bundle_installs_base_splits_and_one_native_split_then_copies_its_data() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = game_bundle(dir.path(), &["arm64_v8a", "x86_64"]);
        let engine = Arc::new(FakeEngine::new().answering(|command| match command {
            "getprop ro.product.cpu.abilist" => ok(&["x86_64,arm64-v8a"]),
            _ => ok(&[]),
        }));
        let (fetch, _) = downloader(b"", None);
        let installer = installer(dir.path(), engine.clone(), fetch);
        let job = finished(&installer, &installer.enqueue(local(&bundle)).id).await;
        assert_eq!((job.state, job.error.as_deref()), (InstallState::Done, None));
        assert_eq!(job.resolved_package.as_deref(), Some("com.game"), "from the manifest when the diff says nothing");
        let installs = engine.installs.lock().unwrap();
        assert_eq!(installs[0].len(), 3, "base, the language split, and only the x86_64 split");
        assert_eq!(*engine.pushes.lock().unwrap().iter().map(|(_, guest)| guest.as_str()).collect::<Vec<_>>(), ["/sdcard/Android/obb/com.game/main.1.com.game.obb"]);
        assert!(!dir.path().join("scratch").join(format!("bundle-{}", job.id)).exists(), "the unpacked copy is removed");
    }

    #[tokio::test]
    async fn an_arm_only_bundle_on_a_guest_without_arm_fails_before_unpacking() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = game_bundle(dir.path(), &["arm64_v8a"]);
        let engine = Arc::new(FakeEngine::new().answering(|command| match command {
            "getprop ro.product.cpu.abilist" => ok(&["x86_64,x86"]),
            _ => ok(&[]),
        }));
        let (fetch, _) = downloader(b"", None);
        let installer = installer(dir.path(), engine.clone(), fetch);
        let job = finished(&installer, &installer.enqueue(local(&bundle)).id).await;
        assert!(job.error.unwrap().contains("ARM phones"));
        assert_eq!(job.bytes_done, job.bytes_total, "nothing unpacked: the verify step's sizes stand");
        assert!(engine.installs.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_damaged_bundle_fails_with_a_plain_sentence_and_a_refused_file_becomes_a_failed_job() {
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("broken.xapk");
        std::fs::write(&junk, b"definitely not a zip").unwrap();
        let (fetch, _) = downloader(b"", None);
        let installer = installer(dir.path(), Arc::new(FakeEngine::new()), fetch);
        let job = finished(&installer, &installer.enqueue(local(&junk)).id).await;
        assert!(job.error.unwrap().contains("isn’t an Android app"));
        let refused = installer.refuse("notes.txt", "not an app");
        assert_eq!((refused.state, refused.error.as_deref()), (InstallState::Failed, Some("not an app")));
    }

    #[test]
    fn the_failure_worth_showing_is_the_last_line_that_says_so() {
        let result = CommandResult::synthetic(1, vec!["Performing Streamed Install".into(), "adb: failed to install".into()], vec![]);
        assert_eq!(failure_detail(&result, "adb install"), "adb: failed to install");
        assert_eq!(failure_detail(&CommandResult::synthetic(3, vec![], vec![]), "adb install"), "adb install exited 3");
    }
}
