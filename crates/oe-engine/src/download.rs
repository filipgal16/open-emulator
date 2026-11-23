//! Downloads that resume, verify, and skip what is already right.

use std::collections::VecDeque;
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use reqwest::header::{CONTENT_LENGTH, RANGE};
use reqwest::StatusCode;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestAlgorithm {
    Sha1,
    Sha256,
    /// What electron-builder's `latest.yml` publishes for installers.
    Sha512,
}

impl DigestAlgorithm {
    pub fn name(self) -> &'static str {
        match self {
            DigestAlgorithm::Sha1 => "sha1",
            DigestAlgorithm::Sha256 => "sha256",
            DigestAlgorithm::Sha512 => "sha512",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadSpec {
    pub url: String,
    /// Absolute destination. The file is only created here once it has verified.
    pub target: PathBuf,
    /// Expected digest, hex. Google's SDK manifest publishes SHA-1.
    pub digest: Option<String>,
    pub algorithm: DigestAlgorithm,
    /// Declared size, used for progress before any bytes arrive.
    pub size_bytes: Option<u64>,
}

impl DownloadSpec {
    pub fn new(url: impl Into<String>, target: impl Into<PathBuf>) -> Self {
        DownloadSpec { url: url.into(), target: target.into(), digest: None, algorithm: DigestAlgorithm::Sha1, size_bytes: None }
    }

    pub fn digest(mut self, algorithm: DigestAlgorithm, digest: impl Into<String>) -> Self {
        self.algorithm = algorithm;
        self.digest = Some(digest.into());
        self
    }

    pub fn size(mut self, bytes: u64) -> Self {
        self.size_bytes = Some(bytes);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadProgress {
    pub url: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

pub type ProgressHandler = Arc<dyn Fn(&DownloadProgress) + Send + Sync>;
pub type MessageHandler = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct DownloadOptions {
    pub client: reqwest::Client,
    pub on_progress: Option<ProgressHandler>,
    pub on_log: Option<MessageHandler>,
    /// Refuse anything larger, so a wrong URL cannot fill the disk.
    pub max_bytes: u64,
}

const DEFAULT_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

impl Default for DownloadOptions {
    fn default() -> Self {
        DownloadOptions { client: http_client(), on_progress: None, on_log: None, max_bytes: DEFAULT_MAX_BYTES }
    }
}

/// The client every download shares: Windows' own TLS and certificate store, and its proxy
/// settings, so a machine behind a corporate proxy or inspecting firewall works as its browser
/// does.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("open-emulator/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("the HTTP client builds with its default configuration")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadError {
    pub message: String,
    /// True when retrying could plausibly work — a network drop rather than a bad digest.
    pub retryable: bool,
}

impl DownloadError {
    fn new(message: impl Into<String>, retryable: bool) -> Self {
        DownloadError { message: message.into(), retryable }
    }
}

impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DownloadError {}

impl From<DownloadError> for crate::Error {
    fn from(error: DownloadError) -> Self {
        crate::Error(error.message)
    }
}

fn io_error(context: &str, error: std::io::Error) -> DownloadError {
    DownloadError::new(format!("{context}: {error}"), true)
}

/// Hashes a file that is already on disk. Used to decide whether it needs downloading at all.
pub async fn digest_of(file: &Path, algorithm: DigestAlgorithm) -> std::io::Result<String> {
    let file = file.to_owned();
    tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        let mut input = std::io::BufReader::with_capacity(1024 * 1024, std::fs::File::open(&file)?);
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut sha1 = Sha1::new();
        let mut sha256 = Sha256::new();
        let mut sha512 = Sha512::new();
        loop {
            let n = input.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            match algorithm {
                DigestAlgorithm::Sha1 => sha1.update(&buffer[..n]),
                DigestAlgorithm::Sha256 => sha256.update(&buffer[..n]),
                DigestAlgorithm::Sha512 => sha512.update(&buffer[..n]),
            }
        }
        Ok(match algorithm {
            DigestAlgorithm::Sha1 => oe_formats::bytes::hex(&sha1.finalize()),
            DigestAlgorithm::Sha256 => oe_formats::bytes::hex(&sha256.finalize()),
            DigestAlgorithm::Sha512 => oe_formats::bytes::hex(&sha512.finalize()),
        })
    })
    .await
    .map_err(std::io::Error::other)?
}

fn part_path(target: &Path) -> PathBuf {
    let mut text = target.as_os_str().to_owned();
    text.push(".part");
    PathBuf::from(text)
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Downloads one file, resuming a partial one and verifying before it counts.
///
/// Three properties, each earning its complexity:
///
///   **Resume.** Bytes already in the `.part` file are requested with `Range: bytes=N-`. Without
///   this, a dropped connection at 90% of a 1.5 GB system image costs the entire download — which
///   is the single most demoralising way first-run setup fails.
///
///   **Verify before rename.** The real file appears only after its digest matches. Nothing
///   downstream ever sees a half-written or corrupt archive, so "does this file exist?" is a
///   sufficient completeness check everywhere else.
///
///   **Skip what is already right.** A target that exists and matches is returned immediately.
///   That is what makes the whole setup step idempotent, and it is why "Try again" after a failure
///   costs seconds rather than starting from nothing.
pub async fn download_file(spec: &DownloadSpec, options: &DownloadOptions) -> Result<PathBuf, DownloadError> {
    let log = |message: &str| {
        if let Some(on_log) = &options.on_log {
            on_log(message);
        }
    };
    let progress = |bytes_done: u64, bytes_total: u64| {
        if let Some(on_progress) = &options.on_progress {
            on_progress(&DownloadProgress { url: spec.url.clone(), bytes_done, bytes_total });
        }
    };

    let part = part_path(&spec.target);
    if let Some(parent) = spec.target.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| io_error("could not create the download folder", e))?;
    }

    if spec.target.exists() {
        let Some(digest) = &spec.digest else { return Ok(spec.target.clone()) };
        let actual = digest_of(&spec.target, spec.algorithm).await.map_err(|e| io_error("could not read the file", e))?;
        if actual == digest.to_lowercase() {
            log(&format!("already downloaded: {}", file_name(&spec.target)));
            let size = std::fs::metadata(&spec.target).map(|m| m.len()).unwrap_or(0);
            progress(size, size);
            return Ok(spec.target.clone());
        }
        // Present but wrong — a truncated or superseded file. Start over rather than resuming
        // onto it.
        log(&format!("re-downloading {}: digest did not match", file_name(&spec.target)));
        let _ = tokio::fs::remove_file(&spec.target).await;
    }

    let mut existing = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if existing > 0 {
        log(&format!("resuming {} at {existing} bytes", file_name(&spec.target)));
    }

    let mut request = options.client.get(&spec.url);
    if existing > 0 {
        request = request.header(RANGE, format!("bytes={existing}-"));
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| DownloadError::new(format!("could not reach {}: {error}", spec.url), true))?;

    // A server that ignores Range answers 200 with the whole file; honouring it answers 206.
    // Trusting a 200 while appending would silently produce a file with the first N bytes
    // duplicated.
    let status = response.status();
    if existing > 0 && status == StatusCode::OK {
        log("the server ignored the resume request — starting over");
        let _ = tokio::fs::remove_file(&part).await;
        existing = 0;
    } else if existing > 0 && status != StatusCode::PARTIAL_CONTENT {
        return Err(DownloadError::new(format!("resume refused with status {}", status.as_u16()), true));
    }
    if !status.is_success() {
        // 4xx is a wrong URL or an expired manifest; retrying will not help. 5xx might.
        return Err(DownloadError::new(
            format!("download failed with status {}", status.as_u16()),
            status.is_server_error(),
        ));
    }

    let declared: u64 = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let total = spec.size_bytes.unwrap_or(if declared > 0 { declared + existing } else { 0 });
    if total > options.max_bytes {
        return Err(DownloadError::new(format!("refusing a {total}-byte download"), false));
    }

    let sink = std::fs::OpenOptions::new()
        .create(true)
        .append(existing > 0)
        .write(true)
        .truncate(existing == 0)
        .open(&part)
        .map_err(|e| io_error("could not write the download", e))?;
    let mut sink = std::io::BufWriter::with_capacity(1024 * 1024, sink);
    let mut done = existing;

    let streamed: Result<(), DownloadError> = async {
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|error| DownloadError::new(format!("the download was interrupted: {error}"), true))?;
            let Some(chunk) = chunk else { break };
            done += chunk.len() as u64;
            if done > options.max_bytes {
                return Err(DownloadError::new("the download exceeded its size limit", false));
            }
            sink.write_all(&chunk).map_err(|e| io_error("could not write the download", e))?;
            progress(done, total.max(done));
        }
        Ok(())
    }
    .await;

    // Flushed either way: the partial file is the entire point of resuming, so an interrupted
    // download has to keep what it has before giving up.
    let flushed = sink.flush();
    drop(sink);
    streamed?;
    flushed.map_err(|e| io_error("could not write the download", e))?;

    if let Some(digest) = &spec.digest {
        let actual = digest_of(&part, spec.algorithm).await.map_err(|e| io_error("could not read the download", e))?;
        if actual != digest.to_lowercase() {
            // A mismatch after a resume usually means the remote file changed under us, so the
            // partial bytes are worthless — keeping them would make every retry fail the same way.
            let _ = tokio::fs::remove_file(&part).await;
            return Err(DownloadError::new(
                format!("{} failed verification ({})", file_name(&spec.target), spec.algorithm.name()),
                true,
            ));
        }
    }

    tokio::fs::rename(&part, &spec.target).await.map_err(|e| io_error("could not finish the download", e))?;
    log(&format!("downloaded {}", file_name(&spec.target)));
    Ok(spec.target.clone())
}

#[derive(Debug, Default)]
pub struct ParallelResult {
    pub files: Vec<PathBuf>,
    pub failures: Vec<(String, DownloadError)>,
}

/// Downloads several files at once, with a ceiling on concurrency.
///
/// The point is overlap, not raw parallelism: the emulator, the platform tools, and a 1.5 GB system
/// image queueing one behind another is what makes first run feel like it has stalled. Three at a
/// time keeps a domestic link busy without turning progress reporting into noise.
///
/// Failures are collected rather than returned early, so one bad package does not discard the
/// other two gigabytes that downloaded successfully — the caller retries only what failed.
pub async fn download_all(specs: Vec<DownloadSpec>, options: DownloadOptions, concurrency: usize) -> ParallelResult {
    // One shared view of overall progress, so the UI can show a single meaningful bar rather than
    // three bars that each jump around independently.
    let per_url: Arc<Mutex<Vec<DownloadProgress>>> = Arc::new(Mutex::new(
        specs
            .iter()
            .map(|s| DownloadProgress { url: s.url.clone(), bytes_done: 0, bytes_total: s.size_bytes.unwrap_or(0) })
            .collect(),
    ));
    let outer = options.on_progress.clone();
    let report: ProgressHandler = {
        let per_url = per_url.clone();
        Arc::new(move |progress: &DownloadProgress| {
            let total = {
                let mut entries = per_url.lock().unwrap();
                if let Some(entry) = entries.iter_mut().find(|e| e.url == progress.url) {
                    *entry = progress.clone();
                }
                entries.iter().fold((0, 0), |(done, total), e| (done + e.bytes_done, total + e.bytes_total))
            };
            if let Some(outer) = &outer {
                outer(&DownloadProgress { url: progress.url.clone(), bytes_done: total.0, bytes_total: total.1 });
            }
        })
    };
    let options = DownloadOptions { on_progress: Some(report), ..options };

    let queue = Arc::new(Mutex::new(specs.into_iter().collect::<VecDeque<_>>()));
    let result = Arc::new(Mutex::new(ParallelResult::default()));
    let workers = concurrency.max(1).min(queue.lock().unwrap().len().max(1));
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..workers {
        let (queue, result, options) = (queue.clone(), result.clone(), options.clone());
        set.spawn(async move {
            loop {
                let Some(spec) = queue.lock().unwrap().pop_front() else { return };
                match download_file(&spec, &options).await {
                    Ok(file) => result.lock().unwrap().files.push(file),
                    Err(error) => result.lock().unwrap().failures.push((spec.url.clone(), error)),
                }
            }
        });
    }
    while set.join_next().await.is_some() {}
    let mut result = result.lock().unwrap();
    std::mem::take(&mut *result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn payload() -> Vec<u8> {
        let mut data = vec![b'x'; 4096];
        data.extend_from_slice(b"END");
        data
    }

    fn sha1_of(data: &[u8]) -> String {
        oe_formats::bytes::hex(&Sha1::digest(data))
    }

    #[derive(Clone, Copy, Default)]
    struct Behaviour {
        truncate_at: Option<usize>,
        ignore_range: bool,
        status: Option<u16>,
    }

    /// A real HTTP server, not a stubbed client: resume is a *protocol* behaviour — Range
    /// requests, 206 versus 200, Content-Range — and a fake would only encode assumptions.
    /// Returns its base URL and a log of the Range header of every request.
    async fn serve(behaviour: impl Fn(&str) -> Behaviour + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<Option<String>>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let seen = ranges.clone();
        let behaviour = Arc::new(behaviour);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let (seen, behaviour) = (seen.clone(), behaviour.clone());
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        let Ok(n) = socket.read(&mut buffer).await else { return };
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..n]);
                    }
                    let text = String::from_utf8_lossy(&request).into_owned();
                    let path = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let how = behaviour(&path);
                    let range = text
                        .lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("range: ").map(|v| v.trim().to_owned()));
                    seen.lock().unwrap().push(range.clone());

                    if let Some(status) = how.status {
                        let head = format!("HTTP/1.1 {status} Nope\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                        let _ = socket.write_all(head.as_bytes()).await;
                        return;
                    }
                    let data = payload();
                    let start = match (&range, how.ignore_range) {
                        (Some(range), false) => range.trim_start_matches("bytes=").trim_end_matches('-').parse().unwrap_or(0),
                        _ => 0,
                    };
                    let body = &data[start..];
                    let head = if range.is_some() && !how.ignore_range {
                        format!(
                            "HTTP/1.1 206 Partial Content\r\ncontent-length: {}\r\ncontent-range: bytes {start}-{}/{}\r\nconnection: close\r\n\r\n",
                            body.len(),
                            data.len() - 1,
                            data.len()
                        )
                    } else {
                        format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len())
                    };
                    let _ = socket.write_all(head.as_bytes()).await;
                    match how.truncate_at {
                        Some(cut) => {
                            let _ = socket.write_all(&body[..cut]).await;
                            let _ = socket.flush().await;
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                            // Dropped here: the connection dies partway through the body.
                        }
                        None => {
                            let _ = socket.write_all(body).await;
                        }
                    }
                });
            }
        });
        (base, ranges)
    }

    fn spec(base: &str, name: &str, dir: &Path) -> DownloadSpec {
        DownloadSpec::new(format!("{base}/{name}"), dir.join(name)).digest(DigestAlgorithm::Sha1, sha1_of(&payload()))
    }

    #[tokio::test]
    async fn a_file_downloads_and_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let (base, _) = serve(|_| Behaviour::default()).await;
        let target = download_file(&spec(&base, "pkg.zip", dir.path()), &DownloadOptions::default()).await.unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), payload());
        assert!(!part_path(&target).exists(), "the part file is renamed away, not left behind");
    }

    #[tokio::test]
    async fn a_wrong_digest_is_refused_and_the_file_never_appears() {
        let dir = tempfile::tempdir().unwrap();
        let (base, _) = serve(|_| Behaviour::default()).await;
        let wrong = spec(&base, "pkg.zip", dir.path()).digest(DigestAlgorithm::Sha1, "a".repeat(40));
        let error = download_file(&wrong, &DownloadOptions::default()).await.unwrap_err();
        assert!(error.message.contains("failed verification"), "{error}");
        assert!(!dir.path().join("pkg.zip").exists());
    }

    #[tokio::test]
    async fn an_interrupted_download_leaves_a_part_file_and_the_retry_resumes_from_it() {
        let dir = tempfile::tempdir().unwrap();
        let (broken, _) = serve(|_| Behaviour { truncate_at: Some(2000), ..Behaviour::default() }).await;
        assert!(download_file(&spec(&broken, "pkg.zip", dir.path()), &DownloadOptions::default()).await.is_err());

        let partial = std::fs::metadata(part_path(&dir.path().join("pkg.zip"))).unwrap().len();
        assert!(partial > 0 && partial < payload().len() as u64, "kept {partial} bytes as a head start");

        let (healthy, ranges) = serve(|_| Behaviour::default()).await;
        let target = download_file(&spec(&healthy, "pkg.zip", dir.path()), &DownloadOptions::default()).await.unwrap();
        assert_eq!(ranges.lock().unwrap().first().cloned().flatten(), Some(format!("bytes={partial}-")));
        assert_eq!(std::fs::read(target).unwrap(), payload(), "and the reassembled file is byte-identical");
    }

    #[tokio::test]
    async fn a_server_that_ignores_range_is_handled_by_starting_over_not_by_appending() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(part_path(&dir.path().join("pkg.zip")), &payload()[..1000]).unwrap();
        let (base, _) = serve(|_| Behaviour { ignore_range: true, ..Behaviour::default() }).await;
        let target = download_file(&spec(&base, "pkg.zip", dir.path()), &DownloadOptions::default()).await.unwrap();
        assert_eq!(std::fs::read(target).unwrap(), payload());
    }

    #[tokio::test]
    async fn an_already_correct_file_is_not_downloaded_again() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pkg.zip"), payload()).unwrap();
        let (base, ranges) = serve(|_| Behaviour::default()).await;
        download_file(&spec(&base, "pkg.zip", dir.path()), &DownloadOptions::default()).await.unwrap();
        assert!(ranges.lock().unwrap().is_empty(), "no request was made");
    }

    #[tokio::test]
    async fn a_present_but_wrong_file_is_replaced_rather_than_resumed_onto() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pkg.zip"), b"stale contents").unwrap();
        let (base, _) = serve(|_| Behaviour::default()).await;
        let target = download_file(&spec(&base, "pkg.zip", dir.path()), &DownloadOptions::default()).await.unwrap();
        assert_eq!(std::fs::read(target).unwrap(), payload());
    }

    #[tokio::test]
    async fn a_404_is_not_retryable_a_503_is() {
        let dir = tempfile::tempdir().unwrap();
        for (status, retryable) in [(404u16, false), (503, true)] {
            let (base, _) = serve(move |_| Behaviour { status: Some(status), ..Behaviour::default() }).await;
            let target = DownloadSpec::new(format!("{base}/x.zip"), dir.path().join(format!("{status}.zip")));
            let error = download_file(&target, &DownloadOptions::default()).await.unwrap_err();
            assert_eq!(error.retryable, retryable, "status {status}");
        }
    }

    #[tokio::test]
    async fn an_oversized_download_is_refused_before_it_fills_the_disk() {
        let dir = tempfile::tempdir().unwrap();
        let (base, _) = serve(|_| Behaviour::default()).await;
        let options = DownloadOptions { max_bytes: 10, ..DownloadOptions::default() };
        let error = download_file(&DownloadSpec::new(format!("{base}/pkg.zip"), dir.path().join("big.zip")), &options)
            .await
            .unwrap_err();
        assert!(error.message.contains("refusing") || error.message.contains("size limit"), "{error}");
    }

    #[tokio::test]
    async fn progress_across_parallel_downloads_is_reported_as_one_total() {
        let dir = tempfile::tempdir().unwrap();
        let (base, _) = serve(|_| Behaviour::default()).await;
        let seen: Arc<Mutex<Vec<DownloadProgress>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let options = DownloadOptions {
            on_progress: Some(Arc::new(move |p: &DownloadProgress| sink.lock().unwrap().push(p.clone()))),
            ..DownloadOptions::default()
        };
        let size = payload().len() as u64;
        let specs = ["a", "b", "c"].iter().map(|n| spec(&base, &format!("{n}.zip"), dir.path()).size(size)).collect();
        let result = download_all(specs, options, 3).await;

        assert_eq!(result.files.len(), 3);
        assert!(result.failures.is_empty());
        let last = seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.bytes_total, size * 3, "one bar covering all three, not three bars");
        assert_eq!(last.bytes_done, size * 3);
    }

    #[tokio::test]
    async fn one_failed_package_does_not_discard_the_others_that_succeeded() {
        let dir = tempfile::tempdir().unwrap();
        let (base, _) = serve(|path| if path.contains("bad") { Behaviour { status: Some(404), ..Behaviour::default() } } else { Behaviour::default() }).await;
        let result =
            download_all(vec![spec(&base, "good.zip", dir.path()), spec(&base, "bad.zip", dir.path())], DownloadOptions::default(), 2)
                .await;
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.failures.len(), 1);
        assert!(result.failures[0].0.contains("bad.zip"));
    }

    #[tokio::test]
    async fn digest_of_agrees_with_the_hash_the_manifest_would_publish() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.bin");
        std::fs::write(&file, payload()).unwrap();
        assert_eq!(digest_of(&file, DigestAlgorithm::Sha1).await.unwrap(), sha1_of(&payload()));
    }
}
