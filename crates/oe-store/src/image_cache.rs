//! Remote images, icons and screenshots, downloaded once and kept on disk.
//!
//! The UI only ever draws from the files here; it never reaches a remote host itself. Every image
//! is fetched over https only, capped in size, and kept only if its first bytes say it is really a
//! PNG, JPEG, GIF or WebP: the `Content-Type` header is not trusted for that, since a hostile or
//! compromised CDN can label anything `image/png`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::join_all;
use oe_engine::download::MessageHandler;
use sha2::{Digest, Sha256};

use crate::fetch::{FetchRequest, Fetcher};
use crate::{err, Result};

const DEFAULT_MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// The image format the bytes are, by their signature, or `None` for anything else.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub struct ImageCache {
    dir: PathBuf,
    fetch: Fetcher,
    on_log: Option<MessageHandler>,
    max_bytes: usize,
    /// One download per image at a time; a second caller waits for the first.
    pending: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ImageCache {
    pub fn new(dir: impl Into<PathBuf>, fetch: Fetcher) -> ImageCache {
        ImageCache { dir: dir.into(), fetch, on_log: None, max_bytes: DEFAULT_MAX_IMAGE_BYTES, pending: Mutex::default() }
    }

    pub fn with_log(mut self, on_log: MessageHandler) -> ImageCache {
        self.on_log = Some(on_log);
        self
    }

    pub fn with_max_bytes(mut self, max_bytes: usize) -> ImageCache {
        self.max_bytes = max_bytes;
        self
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The file name an image is kept under: a hash of its URL, so no text from a remote index
    /// ever becomes part of a path.
    pub fn id_for(image_url: &str) -> String {
        oe_formats::bytes::hex(&Sha256::digest(image_url.as_bytes()))[..32].to_owned()
    }

    /// The stored file for an id, if the id is well-formed and something is stored.
    pub fn path_for(&self, id: &str) -> Option<PathBuf> {
        let well_formed = id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        let file = self.dir.join(id);
        (well_formed && file.is_file()).then_some(file)
    }

    /// The image's file if it is already downloaded; `None` draws a placeholder.
    pub fn path_if_ready(&self, image_url: &str) -> Option<PathBuf> {
        self.path_for(&Self::id_for(image_url))
    }

    /// Downloads the image if needed. `None` when it cannot be used, never an error: art that
    /// fails to fetch degrades to a placeholder, it does not break the caller.
    pub async fn ensure(&self, image_url: &str) -> Option<PathBuf> {
        if let Some(ready) = self.path_if_ready(image_url) {
            return Some(ready);
        }
        let id = Self::id_for(image_url);
        let gate = self.pending.lock().unwrap_or_else(|p| p.into_inner()).entry(id.clone()).or_default().clone();
        let _turn = gate.lock().await;
        // Another caller may have finished it while this one waited.
        if let Some(ready) = self.path_if_ready(image_url) {
            return Some(ready);
        }
        let result = self.download(image_url, &id).await;
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        match result {
            Ok(path) => Some(path),
            Err(error) => {
                if let Some(on_log) = &self.on_log {
                    on_log(&format!("image fetch failed ({image_url}): {}", error.0));
                }
                None
            }
        }
    }

    /// Warms the cache, all at once, so images do not pop in a beat after the text.
    pub async fn prefetch(&self, image_urls: &[String]) {
        join_all(image_urls.iter().map(|url| self.ensure(url))).await;
    }

    async fn download(&self, image_url: &str, id: &str) -> Result<PathBuf> {
        if !image_url.get(..8).is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://")) {
            return Err(err!("not https"));
        }
        let response = (self.fetch)(FetchRequest::new(image_url, self.max_bytes, FETCH_TIMEOUT)).await?;
        if !response.ok() {
            return Err(err!("HTTP {}", response.status));
        }
        if sniff_image(&response.body).is_none() {
            return Err(err!("not a recognised image"));
        }
        std::fs::create_dir_all(&self.dir)?;
        let tmp = self.dir.join(format!("{id}.tmp"));
        std::fs::write(&tmp, &response.body)?;
        let file = self.dir.join(id);
        std::fs::rename(&tmp, &file)?;
        Ok(file)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::fetch::FetchResponse;

    pub const PNG: [u8; 16] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];

    /// A network that answers every URL with `body`, counting the requests.
    pub fn serving(body: &'static [u8], status: u16) -> (Fetcher, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let fetch: Fetcher = Arc::new(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(FetchResponse { status, etag: None, body: body.to_vec() }) })
        });
        (fetch, calls)
    }

    #[test]
    fn images_are_recognised_by_their_bytes_not_their_label() {
        assert_eq!(sniff_image(&PNG), Some("image/png"));
        assert_eq!(sniff_image(b"\xff\xd8\xff\xe0 0123456789"), Some("image/jpeg"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<html>not an image</html>"), None);
        assert_eq!(sniff_image(b"GIF89"), None, "too short to be anything");
    }

    #[tokio::test]
    async fn an_image_is_downloaded_once_and_then_served_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let (fetch, calls) = serving(&PNG, 200);
        let cache = ImageCache::new(dir.path(), fetch);
        let url = "https://f-droid.org/repo/icons/x.png";
        assert_eq!(cache.path_if_ready(url), None);
        let first = cache.ensure(url).await.expect("downloaded");
        assert_eq!(cache.ensure(url).await, Some(first.clone()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read(first).unwrap(), PNG);
    }

    #[tokio::test]
    async fn plain_http_a_non_image_and_an_error_status_are_all_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (fetch, calls) = serving(&PNG, 200);
        let cache = ImageCache::new(dir.path(), fetch);
        assert_eq!(cache.ensure("http://example.com/x.png").await, None);
        assert_eq!(calls.load(Ordering::SeqCst), 0, "never even requested");

        let (html, _) = serving(b"<html>hello world</html>", 200);
        assert_eq!(ImageCache::new(dir.path(), html).ensure("https://example.com/a.png").await, None);
        let (missing, _) = serving(&PNG, 404);
        assert_eq!(ImageCache::new(dir.path(), missing).ensure("https://example.com/b.png").await, None);
    }

    #[test]
    fn only_well_formed_ids_name_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let (fetch, _) = serving(&PNG, 200);
        let cache = ImageCache::new(dir.path(), fetch);
        assert_eq!(cache.path_for("../../etc/passwd"), None);
        assert_eq!(ImageCache::id_for("https://x").len(), 32);
    }
}
