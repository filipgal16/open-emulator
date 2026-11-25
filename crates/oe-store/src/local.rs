//! App files already on this PC: whatever sits in `android/apps/`, plus anything dropped onto the
//! window or chosen with Install from file. Plain APKs and the two bundle formats are listed alike;
//! telling them apart is the installer's job, at install time.
//!
//! No APK parsing happens here. Reading a package name out of an APK means decoding Android's
//! binary XML, and getting that subtly wrong would mislabel apps, while the guest can answer the
//! same question exactly: the installer diffs `pm list packages -3` across the install. So a local
//! entry is honest about what it is, a file, until it has been installed.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use oe_engine::engine::BoxFuture;

use crate::bundle::{has_package_extension, package_file_label};
use crate::source::{AppSource, DownloadSpec, Location};
use crate::types::{AppDetail, SourceId, StoreApp};
use crate::{err, Result};

struct LocalFile {
    path: PathBuf,
    size: u64,
    mtime: i64,
}

pub struct LocalSource {
    dirs: Vec<PathBuf>,
    /// Where dropped files are copied, so they outlast the drag they arrived on.
    import_dir: PathBuf,
}

impl LocalSource {
    pub fn new(dirs: Vec<PathBuf>, import_dir: impl Into<PathBuf>) -> LocalSource {
        LocalSource { dirs, import_dir: import_dir.into() }
    }

    /// Copies a dropped or chosen app file into the managed directory, returning its new path.
    /// The same file dropped twice is a no-op rather than an error.
    pub async fn import(&self, source_path: &Path) -> Result<PathBuf> {
        if !has_package_extension(&source_path.to_string_lossy()) {
            return Err(err!("not an .apk, .xapk or .apks file"));
        }
        tokio::fs::create_dir_all(&self.import_dir).await?;
        let name = source_path.file_name().ok_or_else(|| err!("not a file"))?;
        let dest = self.import_dir.join(name);
        let same = std::path::absolute(source_path).ok() == std::path::absolute(&dest).ok();
        if !same {
            tokio::fs::copy(source_path, &dest).await?;
        }
        Ok(dest)
    }

    /// Local entries are keyed by file name, since the package name is not known before install.
    fn id_for(path: &Path) -> String {
        path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// Newest first. The managed copies come first, so one shadows a same-named file elsewhere.
    fn files(&self) -> Vec<LocalFile> {
        let mut seen = std::collections::HashSet::new();
        let mut found = Vec::new();
        for dir in std::iter::once(&self.import_dir).chain(&self.dirs) {
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !has_package_extension(&name) || seen.contains(&name) {
                    continue;
                }
                // Vanished between listing and reading it, or not a plain file: skipped.
                let Ok(meta) = entry.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |since| since.as_millis() as i64);
                seen.insert(name);
                found.push(LocalFile { path: entry.path(), size: meta.len(), mtime });
            }
        }
        found.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        found
    }

    fn to_store_app(file: &LocalFile) -> StoreApp {
        let base = package_file_label(&file.path.to_string_lossy());
        let spaced: String = base.split(['_', '-']).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
        let joined = if base.starts_with(['_', '-']) || base.ends_with(['_', '-']) { spaced.trim().to_owned() } else { spaced };
        StoreApp {
            id: format!("local:{}", Self::id_for(&file.path)),
            source: SourceId::Local,
            package_name: Self::id_for(&file.path),
            name: if joined.trim().is_empty() { base.clone() } else { joined.trim().to_owned() },
            summary: file.path.to_string_lossy().into_owned(),
            icon: None,
            version_name: String::new(),
            version_code: 0,
            size_bytes: file.size,
            license: None,
            // A file the user chose is never blocked on a guess about compatibility: the guest's
            // package manager is the authority, and it will say so if the APK does not fit.
            min_sdk: 0,
            abis: Vec::new(),
            categories: Vec::new(),
            last_updated: file.mtime,
            anti_features: Vec::new(),
        }
    }

    pub fn search_files(&self, query: &str, limit: usize) -> Vec<StoreApp> {
        let needle = query.trim().to_lowercase();
        self.files()
            .iter()
            .filter(|file| needle.is_empty() || Self::id_for(&file.path).to_lowercase().contains(&needle))
            .take(limit)
            .map(Self::to_store_app)
            .collect()
    }

    pub fn file_detail(&self, id: &str) -> Option<AppDetail> {
        let file = self.files().into_iter().find(|candidate| Self::id_for(&candidate.path) == id)?;
        Some(AppDetail {
            app: Self::to_store_app(&file),
            description: "An app file on this PC. Its real package name and version are read from the guest once it is installed."
                .to_owned(),
            web_site: None,
            source_code: None,
            screenshots: Vec::new(),
            other_versions: Vec::new(),
        })
    }

    pub fn resolve_file(&self, id: &str) -> Option<DownloadSpec> {
        let file = self.files().into_iter().find(|candidate| Self::id_for(&candidate.path) == id)?;
        Some(DownloadSpec {
            package_name: Self::id_for(&file.path),
            label: package_file_label(&file.path.to_string_lossy()),
            source: SourceId::Local,
            location: Location::File(file.path),
            // Nothing to verify against: the user supplied this file.
            sha256: None,
            size_bytes: file.size,
            version_name: String::new(),
        })
    }
}

impl AppSource for LocalSource {
    fn id(&self) -> SourceId {
        SourceId::Local
    }

    fn search<'a>(&'a self, query: &'a str, _guest_sdk: Option<u32>, limit: usize) -> BoxFuture<'a, Result<Vec<StoreApp>>> {
        Box::pin(async move { Ok(self.search_files(query, limit)) })
    }

    fn detail<'a>(&'a self, package_name: &'a str, _guest_sdk: Option<u32>) -> BoxFuture<'a, Option<AppDetail>> {
        Box::pin(async move { self.file_detail(package_name) })
    }

    fn resolve<'a>(&'a self, package_name: &'a str, _version_code: Option<i64>, _guest_sdk: Option<u32>) -> BoxFuture<'a, Option<DownloadSpec>> {
        Box::pin(async move { self.resolve_file(package_name) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, LocalSource) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("apps")).unwrap();
        let source = LocalSource::new(vec![dir.path().join("apps"), dir.path().join("missing")], dir.path().join("imported"));
        (dir, source)
    }

    #[test]
    fn app_files_in_the_watched_directories_are_listed_and_a_missing_one_is_skipped() {
        let (dir, source) = setup();
        std::fs::write(dir.path().join("apps").join("my_cool-game.xapk"), "x").unwrap();
        std::fs::write(dir.path().join("apps").join("readme.txt"), "x").unwrap();
        let listed = source.search_files("", 10);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "my cool game");
        assert_eq!(listed[0].id, "local:my_cool-game.xapk");
    }

    #[tokio::test]
    async fn a_dropped_file_is_copied_in_once_and_shadows_a_same_named_one() {
        let (dir, source) = setup();
        let dropped = dir.path().join("Downloads-app.apk");
        std::fs::write(&dropped, "x").unwrap();
        std::fs::write(dir.path().join("apps").join("Downloads-app.apk"), "older").unwrap();
        let copy = source.import(&dropped).await.unwrap();
        assert!(copy.starts_with(dir.path().join("imported")));
        assert_eq!(source.import(&copy).await.unwrap(), copy, "importing the copy itself is a no-op");
        let spec = source.resolve_file("Downloads-app.apk").unwrap();
        assert_eq!(spec.location, Location::File(copy));
        assert_eq!(spec.sha256, None, "nothing to check a file the user chose against");
        assert!(source.import(&dir.path().join("notes.txt")).await.is_err());
    }

    #[test]
    fn search_filters_by_file_name() {
        let (dir, source) = setup();
        for name in ["alpha.apk", "beta.apks"] {
            std::fs::write(dir.path().join("apps").join(name), "x").unwrap();
        }
        assert_eq!(source.search_files("BET", 10).iter().map(|a| a.package_name.as_str()).collect::<Vec<_>>(), ["beta.apks"]);
    }
}
