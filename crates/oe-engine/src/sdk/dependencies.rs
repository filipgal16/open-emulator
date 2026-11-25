//! Everything the SDK engine needs on disk, acquired in one pass.
//!
//! Replaces `fetch_android.sh`, which downloaded a JDK and `cmdline-tools` in order to run
//! `sdkmanager`, which then downloaded the packages one at a time. Here the packages come straight
//! from the manifest, three at a time, resumable, and the JRE and command-line tools stop being
//! needed at all.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::download::{download_all, DigestAlgorithm, DownloadOptions, DownloadSpec, ProgressHandler};
use crate::env_file::GuestProfile;
use crate::layout::SdkLayout;
use crate::sdk::repository::{parse_repository, sys_img_manifest_for, HostOs, SdkArchive, REPOSITORY_URL};
use crate::{err, fail, LogHandler, LogStream, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencyPlan {
    pub archives: Vec<SdkArchive>,
    /// Licence ids these packages require, for the acceptance step.
    pub license_ids: Vec<String>,
    pub total_bytes: u64,
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String> {
    let response = client.get(url).send().await.map_err(|error| err!("could not reach {url}: {error}"))?;
    if !response.status().is_success() {
        fail!("{url} answered with status {}", response.status().as_u16());
    }
    response.text().await.map_err(|error| err!("could not read {url}: {error}"))
}

/// The packages a profile needs, picked out of the two manifests.
///
/// `platform-tools` carries adb; `emulator` is the emulator itself; the platform and the system
/// image are what the AVD is created against.
pub fn plan_from_manifests(profile: &GuestProfile, main_xml: &str, sys_xml: &str, host: HostOs) -> Result<DependencyPlan> {
    // A derived image (`openemu`) is built here, not downloaded; what the repository has to supply
    // is the stock image it is built from, at the profile's API level, which is also the base's.
    let image_tag = profile.base_image_tag.as_deref().unwrap_or(&profile.image_tag);
    let api = profile.api_level;
    let main = parse_repository(main_xml, host, REPOSITORY_URL);
    let sys = parse_repository(sys_xml, host, sys_img_manifest_for(image_tag));

    let wanted = [
        ("platform-tools".to_owned(), &main.packages),
        ("emulator".to_owned(), &main.packages),
        (format!("platforms;android-{api}"), &main.packages),
        (format!("system-images;android-{api};{image_tag};x86_64"), &sys.packages),
    ];
    let mut archives = Vec::new();
    for (coordinate, source) in wanted {
        // Naming the missing coordinate matters: "the download failed" sends someone to check
        // their network, when the real cause is a manifest that no longer carries this API level.
        let Some(archive) = source.get(&coordinate) else {
            fail!("the SDK manifest has no package \"{coordinate}\" for {}", host.name());
        };
        archives.push(archive.clone());
    }
    let mut license_ids: Vec<String> = Vec::new();
    for id in archives.iter().filter_map(|a| a.license_id.clone()) {
        if !license_ids.contains(&id) {
            license_ids.push(id);
        }
    }
    let total_bytes = archives.iter().map(|a| a.size_bytes).sum();
    Ok(DependencyPlan { archives, license_ids, total_bytes })
}

/// Which packages this profile needs, with URLs and digests resolved. The system image lives in a
/// *different* manifest per image tag, which is why two documents are fetched.
pub async fn resolve_dependencies(profile: &GuestProfile, client: &reqwest::Client) -> Result<DependencyPlan> {
    let image_tag = profile.base_image_tag.as_deref().unwrap_or(&profile.image_tag);
    let (main, sys) = tokio::try_join!(fetch_text(client, REPOSITORY_URL), fetch_text(client, sys_img_manifest_for(image_tag)))?;
    plan_from_manifests(profile, &main, &sys, HostOs::current())
}

fn sanitize_segment(segment: &str) -> Result<&str> {
    // Coordinates come from Google's manifest, but they become filesystem paths, so they are
    // matched rather than trusted.
    if segment.is_empty() || !segment.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-') {
        fail!("unsafe package segment: {segment}");
    }
    Ok(segment)
}

/// Where a package's zip lands, and the directory it must end up as.
///
/// A package coordinate maps directly onto the SDK's directory layout: `platforms;android-30`
/// becomes `platforms/android-30`, and `system-images;android-30;default;x86_64` becomes the
/// matching four-deep path. `platform-tools` and `emulator` have a single segment.
fn archive_paths(layout: &SdkLayout, archive: &SdkArchive) -> Result<(PathBuf, PathBuf)> {
    let name = archive.url.rsplit('/').next().filter(|n| !n.is_empty()).map(str::to_owned).unwrap_or_else(|| format!("{}.zip", archive.path));
    let zip = layout.root.join("downloads").join(sanitize_segment(&name)?);
    let mut dest = layout.sdk_root.clone();
    for segment in archive.path.split(';') {
        dest.push(sanitize_segment(segment)?);
    }
    Ok((zip, dest))
}

/// Downloads and extracts everything in the plan.
///
/// Downloads run in parallel; extraction is serial, because unzipping three archives at once on one
/// disk is slower than doing them in turn and makes progress meaningless.
pub async fn acquire_dependencies(
    layout: &SdkLayout,
    plan: &DependencyPlan,
    on_progress: Option<ProgressHandler>,
    on_log: LogHandler,
    keep_archives: bool,
) -> Result<()> {
    let mut specs = Vec::new();
    for archive in &plan.archives {
        let (zip, _) = archive_paths(layout, archive)?;
        specs.push(DownloadSpec::new(&archive.url, zip).digest(DigestAlgorithm::Sha1, &archive.sha1).size(archive.size_bytes));
    }
    on_log(LogStream::Stdout, &format!("downloading {} packages ({})", specs.len(), format_bytes(plan.total_bytes)));

    let log = on_log.clone();
    let options = DownloadOptions {
        on_progress,
        on_log: Some(Arc::new(move |message: &str| log(LogStream::Stdout, message))),
        ..DownloadOptions::default()
    };
    let result = download_all(specs, options, 3).await;
    if !result.failures.is_empty() {
        let detail: Vec<String> = result
            .failures
            .iter()
            .map(|(url, error)| format!("{}: {}", url.rsplit('/').next().unwrap_or(url), error.message))
            .collect();
        fail!("could not download {} package(s): {}", result.failures.len(), detail.join("; "));
    }

    for archive in &plan.archives {
        let (zip, dest) = archive_paths(layout, archive)?;
        on_log(LogStream::Stdout, &format!("extracting {}", archive.display_name));
        let (zip_for_task, dest_for_task) = (zip.clone(), dest.clone());
        tokio::task::spawn_blocking(move || extract_into(&zip_for_task, &dest_for_task))
            .await
            .map_err(|error| err!("extraction did not finish: {error}"))??;
        // Only after the extraction it belongs to has succeeded. Deleting eagerly would mean a
        // failure here costs the whole download again.
        if !keep_archives {
            let _ = std::fs::remove_file(&zip);
        }
    }

    // The archives are gone; the directory that held them is just clutter.
    let downloads = layout.root.join("downloads");
    if !keep_archives && std::fs::read_dir(&downloads).is_ok_and(|mut entries| entries.next().is_none()) {
        let _ = std::fs::remove_dir_all(&downloads);
    }
    Ok(())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut text = path.as_os_str().to_owned();
    text.push(suffix);
    PathBuf::from(text)
}

/// Unpacks an SDK archive and puts it exactly where the SDK layout requires.
///
/// Every one of these zips already contains a single top-level directory, and its name is **not**
/// always the name the destination needs:
///
/// ```text
/// platform-tools                            zip has `platform-tools/`  → platform-tools
/// emulator                                  zip has `emulator/`        → emulator
/// platforms;android-30                      zip has `android-11/`      → platforms/android-30
/// system-images;android-30;default;x86_64   zip has `x86_64/`          → …/default/x86_64
/// ```
///
/// So extracting straight into the destination is wrong twice over: it nests a redundant level
/// (`…/default/x86_64/x86_64/system.img`) and it leaves the platform under its version name rather
/// than its API level. It is extracted aside and renamed instead, as `sdkmanager` does.
pub fn extract_into(zip: &Path, dest: &Path) -> Result<()> {
    if !zip.exists() {
        fail!("archive not found: {}", zip.display());
    }
    let staging = with_suffix(dest, ".staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;

    let outcome = (|| -> Result<()> {
        oe_formats::zip_archive::extract_all(zip, &staging, |_| {})
            .map_err(|error| err!("extracting {} failed: {error}", zip.display()))?;
        let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&staging)?.collect::<std::io::Result<_>>()?;
        // One directory and nothing else is the shape every SDK archive has. Anything else means
        // the packaging changed, and guessing which part to promote would put files somewhere
        // arbitrary.
        let source = match entries.as_slice() {
            [only] if only.file_type()?.is_dir() => only.path(),
            _ => staging.clone(),
        };
        let _ = std::fs::remove_dir_all(dest);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&source, dest)?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    outcome
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CleanupReport {
    pub removed: Vec<PathBuf>,
    pub bytes_freed: u64,
}

/// Removes what setup no longer needs.
///
/// Every path here is safe to remove at any time: the archives have already been extracted,
/// `.part` files belong to downloads that either completed or were abandoned, and the SDK's own
/// scratch directories are rebuilt on demand. Exposed to the UI as "free up space" as well as
/// running automatically, so the same code path serves both and cannot rot from disuse.
pub fn cleanup(layout: &SdkLayout, drop_jre: bool) -> CleanupReport {
    let mut targets = vec![
        layout.root.join("downloads"),
        // The SDK tooling leaves these behind; they are caches, not state.
        layout.sdk_root.join(".temp"),
        layout.sdk_root.join(".downloadIntermediates"),
    ];
    // The JRE is only needed while `sdkmanager` is, which is no longer at all, but it is removed
    // explicitly rather than silently, because an installation that predates the direct-download
    // path may still have one.
    if drop_jre {
        targets.push(layout.jre_root.clone());
    }

    let mut report = CleanupReport::default();
    for target in targets {
        if !target.exists() {
            continue;
        }
        report.bytes_freed += size_of(&target);
        let _ = std::fs::remove_dir_all(&target);
        report.removed.push(target);
    }
    // Orphaned partial downloads anywhere under the root: a `.part` whose download was abandoned
    // long ago is not a head start, it is dead weight.
    for stale in find_by_extension(&layout.root, ".part", 4) {
        report.bytes_freed += size_of(&stale);
        let _ = std::fs::remove_file(&stale);
        report.removed.push(stale);
    }
    report
}

/// The bytes under a path, file or directory. Unreadable parts count as nothing.
pub fn size_of(target: &Path) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(target) else { return 0 };
    if metadata.is_file() {
        return metadata.len();
    }
    if !metadata.is_dir() {
        return 0;
    }
    std::fs::read_dir(target)
        .map(|entries| entries.filter_map(|e| e.ok()).map(|e| size_of(&e.path())).sum())
        .unwrap_or(0)
}

fn find_by_extension(root: &Path, extension: &str, depth: i32) -> Vec<PathBuf> {
    if depth < 0 {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut found = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            found.extend(find_by_extension(&path, extension, depth - 1));
        } else if entry.file_name().to_string_lossy().ends_with(extension) {
            found.push(path);
        }
    }
    found
}

pub fn format_bytes(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let value = bytes as f64;
    if value >= GB {
        format!("{:.1} GB", value / GB)
    } else if value >= MB {
        format!("{} MB", oe_formats::js_round(value / MB))
    } else {
        format!("{} KB", oe_formats::js_round(value / 1024.0).max(1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oe_formats::testing::{make_zip, ZipFile};

    #[test]
    fn a_zip_whose_top_level_directory_has_a_different_name_is_renamed_into_place() {
        let root = tempfile::tempdir().unwrap();
        let zip = root.path().join("platform-30_r03.zip");
        std::fs::write(&zip, make_zip(&[ZipFile::stored("android-11/", b""), ZipFile::deflated("android-11/android.jar", b"jar")], false))
            .unwrap();
        let dest = root.path().join("sdk").join("platforms").join("android-30");
        extract_into(&zip, &dest).unwrap();
        assert_eq!(std::fs::read(dest.join("android.jar")).unwrap(), b"jar");
        assert!(!with_suffix(&dest, ".staging").exists(), "no staging directory is left behind");
    }

    #[test]
    fn a_system_image_lands_at_the_path_the_emulator_looks_for_not_one_level_deeper() {
        let root = tempfile::tempdir().unwrap();
        let zip = root.path().join("x86_64-30_r10.zip");
        std::fs::write(&zip, make_zip(&[ZipFile::deflated("x86_64/system.img", b"img")], false)).unwrap();
        let dest = root.path().join("system-images").join("android-30").join("default").join("x86_64");
        extract_into(&zip, &dest).unwrap();
        assert!(dest.join("system.img").exists());
        assert!(!dest.join("x86_64").exists());
    }

    #[test]
    fn extracting_a_missing_archive_fails_clearly_and_leaves_no_staging_directory() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("dest");
        assert!(extract_into(&root.path().join("nope.zip"), &dest).unwrap_err().0.contains("archive not found"));
        let broken = root.path().join("broken.zip");
        std::fs::write(&broken, b"not a zip").unwrap();
        assert!(extract_into(&broken, &dest).is_err());
        assert!(!with_suffix(&dest, ".staging").exists());
    }

    #[test]
    fn cleanup_removes_archives_scratch_dirs_and_orphaned_part_files_but_keeps_the_jre_unless_asked() {
        let root = tempfile::tempdir().unwrap();
        let layout = SdkLayout::new(root.path());
        std::fs::create_dir_all(layout.root.join("downloads")).unwrap();
        std::fs::write(layout.root.join("downloads").join("a.zip"), vec![0u8; 1000]).unwrap();
        std::fs::create_dir_all(layout.sdk_root.join(".temp")).unwrap();
        std::fs::create_dir_all(layout.sdk_root.join("emulator")).unwrap();
        std::fs::write(layout.sdk_root.join("emulator").join("x.zip.part"), vec![0u8; 24]).unwrap();
        std::fs::create_dir_all(&layout.jre_root).unwrap();

        let report = cleanup(&layout, false);
        assert_eq!(report.bytes_freed, 1024);
        assert!(!layout.root.join("downloads").exists());
        assert!(!layout.sdk_root.join("emulator").join("x.zip.part").exists());
        assert!(layout.sdk_root.join("emulator").exists(), "the SDK itself is untouched");
        assert!(layout.jre_root.exists(), "the JRE is only removed when explicitly asked for");
        cleanup(&layout, true);
        assert!(!layout.jre_root.exists());

        let untouched = tempfile::tempdir().unwrap();
        assert_eq!(cleanup(&SdkLayout::new(untouched.path()), false), CleanupReport::default());
    }

    #[test]
    fn a_missing_package_names_the_coordinate_rather_than_blaming_the_network() {
        let profile = crate::env_file::load_profile(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../android"), "fast").unwrap();
        let empty = "<sdk:sdk-repository></sdk:sdk-repository>";
        let error = plan_from_manifests(&profile, empty, empty, HostOs::Windows).unwrap_err();
        assert!(error.0.contains("no package \"platform-tools\" for windows"), "{error}");
    }

    #[test]
    fn byte_sizes_read_for_humans() {
        assert_eq!(format_bytes(1_610_612_736), "1.5 GB");
        assert_eq!(format_bytes(52_428_800), "50 MB");
        assert_eq!(format_bytes(10), "1 KB");
    }
}
