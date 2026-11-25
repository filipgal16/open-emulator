//! Game bundles: `.xapk` (APKPure, APKCombo) and `.apks` (SAI), as well as plain `.apk`.
//!
//! Both bundle formats are a zip holding a base APK and the split APKs Play would normally have
//! picked for the phone (one per processor type, screen density and language, plus asset packs)
//! and an XAPK can also carry OBB data files and a `manifest.json` describing them. Installing one
//! means doing Play's picking ourselves: the base, every language/density/asset split, and the
//! native-code split for exactly one processor type this guest can run, all handed to the package
//! manager in a single session.
//!
//! Every [`PackageFileError`] is shown to the person who chose the file, so it is phrased for them
//! and says what to do, never what the format calls things.

use std::cmp::Ordering;
use std::path::Path;
use std::time::Duration;

use oe_engine::profiles::ProfileId;
use oe_formats::bytes::js_is_space;
use oe_formats::zip_archive::{read_zip_directory, read_zip_entry, ZipEntry};
use serde_json::Value;

pub const PACKAGE_EXTENSIONS: [&str; 3] = [".apk", ".xapk", ".apks"];

/// `manifest.json` is a few kilobytes; anything far larger is not the file it claims to be.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageFileError(pub String);

impl std::fmt::Display for PackageFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PackageFileError {}

fn refuse<T>(message: impl Into<String>) -> Result<T, PackageFileError> {
    Err(PackageFileError(message.into()))
}

/// An Android package name, for checking the ones that arrive inside a downloaded file.
pub fn is_package_name(name: &str) -> bool {
    let segments: Vec<&str> = name.split('.').collect();
    segments.len() >= 2
        && segments.iter().all(|segment| {
            let mut chars = segment.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BundleManifest {
    pub package_name: Option<String>,
    pub name: Option<String>,
    pub version_name: Option<String>,
    pub version_code: Option<i64>,
    /// `(file, id)` for each split the manifest names.
    pub splits: Vec<(String, String)>,
    /// OBB data files: where each sits in the archive, and where the manifest says it belongs.
    pub expansions: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppBundle {
    /// The top-level `.apk` members.
    pub apks: Vec<ZipEntry>,
    /// Every member, for finding expansion files, which live in subdirectories.
    pub entries: Vec<ZipEntry>,
    pub manifest: Option<BundleManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageFile {
    Apk,
    Bundle(AppBundle),
}

fn extension(file_path: &str) -> Option<String> {
    let name = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    // `path.extname`: a leading dot alone does not make an extension.
    name.rfind('.').filter(|&at| at > 0).map(|at| name[at..].to_lowercase())
}

pub fn has_package_extension(file_path: &str) -> bool {
    extension(file_path).is_some_and(|ext| PACKAGE_EXTENSIONS.contains(&ext.as_str()))
}

/// A file name with any of the three extensions removed, for showing to people.
pub fn package_file_label(file_path: &str) -> String {
    let base = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    match extension(base).filter(|ext| PACKAGE_EXTENSIONS.contains(&ext.as_str())) {
        Some(ext) => base[..base.len() - ext.len()].to_owned(),
        None => base.to_owned(),
    }
}

fn is_top_level_apk(name: &str) -> bool {
    !name.contains('/') && !name.contains('\\') && name.to_lowercase().ends_with(".apk")
}

/// Decides what a file is from its contents, not only its name.
///
/// An APK is itself a zip, so the extension cannot be the whole story: an XAPK renamed to `.apk`
/// is common on download sites. What separates them is unambiguous: an APK has
/// `AndroidManifest.xml` at its root, a bundle has APKs there instead.
pub fn inspect_package_file(file_path: &Path) -> Result<PackageFile, PackageFileError> {
    if !has_package_extension(&file_path.to_string_lossy()) {
        return refuse("Only Android app files (.apk, .xapk or .apks) can be installed.");
    }
    let damaged = "This file isn’t an Android app, or it is damaged.";
    let Ok(entries) = read_zip_directory(file_path) else { return refuse(damaged) };
    if entries.iter().any(|entry| entry.name == "AndroidManifest.xml") {
        return Ok(PackageFile::Apk);
    }
    let apks: Vec<ZipEntry> = entries.iter().filter(|entry| is_top_level_apk(&entry.name)).cloned().collect();
    if apks.is_empty() {
        return refuse(damaged);
    }
    // The manifest only refines choices the APK names already allow, so an unreadable one is
    // ignored rather than fatal.
    let manifest = entries
        .iter()
        .find(|entry| entry.name == "manifest.json")
        .and_then(|entry| read_zip_entry(file_path, entry, MAX_MANIFEST_BYTES).ok())
        .and_then(|bytes| parse_bundle_manifest(&String::from_utf8_lossy(&bytes)));
    Ok(PackageFile::Bundle(AppBundle { apks, entries, manifest }))
}

fn string_or_none(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(|text| text.trim_matches(js_is_space)).filter(|text| !text.is_empty()).map(str::to_owned)
}

/// JavaScript's `Number(value)`, for the fields download sites write by hand.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => if value.is_none() { f64::NAN } else { 0.0 },
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => {
            let text = text.trim_matches(js_is_space);
            if text.is_empty() { 0.0 } else { text.parse().unwrap_or(f64::NAN) }
        }
        Some(_) => f64::NAN,
    }
}

/// XAPK's `manifest.json`, version 2. Tolerant: every field is optional, and a field of the wrong
/// type is dropped rather than failing the whole file; download sites write these by hand.
pub fn parse_bundle_manifest(text: &str) -> Option<BundleManifest> {
    let raw: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text)).ok()?;
    let record = raw.as_object()?;
    let version_code = js_number(record.get("version_code"));
    let safe = version_code.fract() == 0.0 && version_code > 0.0 && version_code <= 9_007_199_254_740_991.0;
    let pairs = |list: &str, first: &str, second: &str| -> Vec<(String, String)> {
        record
            .get(list)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let item = item.as_object()?;
                        Some((string_or_none(item.get(first))?, string_or_none(item.get(second))?))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    Some(BundleManifest {
        package_name: string_or_none(record.get("package_name")),
        name: string_or_none(record.get("name")),
        version_name: string_or_none(record.get("version_name")),
        version_code: safe.then_some(version_code as i64),
        splits: pairs("split_apks", "file", "id"),
        expansions: pairs("expansions", "file", "install_path"),
    })
}

/// `config.<token>.apk` or `split_config.<token>.apk`, the token lower-cased.
fn config_split_token(file_name: &str) -> Option<String> {
    let lower = file_name.to_lowercase();
    let rest = lower.strip_prefix("split_").unwrap_or(&lower);
    let token = rest.strip_prefix("config.")?.strip_suffix(".apk")?;
    (!token.is_empty() && !token.contains('.')).then(|| token.to_owned())
}

/// The processor type a split carries native code for, or `None` for any other kind of split.
/// Split names spell them `arm64_v8a`; the guest says `arm64-v8a`.
pub fn split_abi(file_name: &str) -> Option<&'static str> {
    match config_split_token(file_name)?.as_str() {
        "armeabi" => Some("armeabi"),
        "armeabi_v7a" => Some("armeabi-v7a"),
        "arm64_v8a" => Some("arm64-v8a"),
        "x86" => Some("x86"),
        "x86_64" => Some("x86_64"),
        "mips" => Some("mips"),
        "mips64" => Some("mips64"),
        _ => None,
    }
}

/// `ro.product.cpu.abilist`, in the guest's own order of preference.
pub fn parse_abi_list(value: Option<&str>) -> Vec<String> {
    value.unwrap_or("").split(',').map(str::trim).filter(|abi| !abi.is_empty()).map(str::to_owned).collect()
}

/// Close to `localeCompare` for file names: case is a tiebreak, not an order.
fn locale_compare(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// An APK's name and size, which is all the picking needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedSize {
    pub name: String,
    pub size: u64,
}

/// Which APK is the app itself, as opposed to one of its splits.
///
/// Asked in order of how much the answer can be trusted: the manifest naming it, the
/// `<package>.apk` convention XAPK uses, the `base.apk` convention SAI and bundletool use, and only
/// then a guess among whatever is not a config split: a package-shaped name first, then the
/// largest, since asset packs aside the base is where the code lives.
pub fn find_base(apks: &[NamedSize], manifest: Option<&BundleManifest>) -> Option<String> {
    let has = |name: &str| apks.iter().any(|apk| apk.name == name);
    if let Some(declared) = manifest.and_then(|m| m.splits.iter().find(|(_, id)| id == "base")).map(|(file, _)| file) {
        if has(declared) {
            return Some(declared.clone());
        }
    }
    if let Some(conventional) = manifest.and_then(|m| m.package_name.as_ref()).map(|package| format!("{package}.apk")) {
        if has(&conventional) {
            return Some(conventional);
        }
    }
    if has("base.apk") {
        return Some("base.apk".to_owned());
    }
    let candidates: Vec<&NamedSize> = apks.iter().filter(|apk| config_split_token(&apk.name).is_none()).collect();
    let unsplit: Vec<&NamedSize> = candidates.iter().copied().filter(|apk| !apk.name.to_lowercase().starts_with("split_")).collect();
    let package_shaped: Vec<&NamedSize> = unsplit
        .iter()
        .copied()
        .filter(|apk| apk.name.len() > 4 && is_package_name(&apk.name[..apk.name.len() - 4]))
        .collect();
    let pool = [package_shaped, unsplit, candidates].into_iter().find(|group| !group.is_empty())?;
    pool.into_iter().min_by(|a, b| b.size.cmp(&a.size).then_with(|| locale_compare(&a.name, &b.name))).map(|apk| apk.name.clone())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleSelection {
    pub base: String,
    /// Every APK to install, base first.
    pub apks: Vec<String>,
    /// The processor type whose native code was chosen, or `None` when the bundle carries none.
    pub abi: Option<String>,
}

fn no_matching_abi_message(bundle_abis: &[&str]) -> String {
    if bundle_abis.iter().all(|abi| abi.starts_with("arm")) {
        return format!(
            "This app is built for ARM phones, and this Android version can’t run those. Switch to “{}” in the Android version menu, then try again.",
            ProfileId::OpenemuCompat.spec().label
        );
    }
    "This app is built for a different kind of phone, and this Android version can’t run it.".to_owned()
}

/// Picks the APKs this guest should get.
///
/// Everything except native-code splits is installed: languages and densities the guest will not
/// use cost some disk, while leaving out one it does use breaks the app. Native code is the one
/// place a wrong pick fails the install outright, so exactly one processor type is chosen: the
/// first in the guest's own preference order that the bundle has.
pub fn select_apks(apks: &[NamedSize], manifest: Option<&BundleManifest>, guest_abis: &[String]) -> Result<BundleSelection, PackageFileError> {
    let Some(base) = find_base(apks, manifest) else {
        return refuse("This file doesn’t contain the app itself, only parts of it.");
    };
    let mut abi_splits: Vec<(&'static str, Vec<String>)> = Vec::new();
    let mut others = Vec::new();
    for apk in apks.iter().filter(|apk| apk.name != base) {
        match split_abi(&apk.name) {
            Some(abi) => match abi_splits.iter_mut().find(|(known, _)| *known == abi) {
                Some((_, names)) => names.push(apk.name.clone()),
                None => abi_splits.push((abi, vec![apk.name.clone()])),
            },
            None => others.push(apk.name.clone()),
        }
    }
    others.sort_by(|a, b| locale_compare(a, b));
    let mut chosen = vec![base.clone()];
    chosen.extend(others);
    if abi_splits.is_empty() {
        return Ok(BundleSelection { base, apks: chosen, abi: None });
    }
    let Some((abi, names)) = guest_abis.iter().find_map(|wanted| abi_splits.iter().find(|(abi, _)| abi == wanted)) else {
        let offered: Vec<&str> = abi_splits.iter().map(|(abi, _)| *abi).collect();
        return refuse(no_matching_abi_message(&offered));
    };
    chosen.extend(names.iter().cloned());
    Ok(BundleSelection { base, apks: chosen, abi: Some((*abi).to_owned()) })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpansionPlan {
    pub entry: ZipEntry,
    /// Absolute path in the guest.
    pub guest_path: String,
}

fn is_obb_file_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// Where each OBB in the manifest goes: `/sdcard/Android/obb/<package>/<file>`, the one place a
/// game looks for them.
///
/// Only the file name is taken from the manifest's install path, and both it and the package name
/// are checked against a strict pattern; they come from a downloaded file and end up as a path on
/// the guest's storage. An entry that fails the check, or names a member the archive does not
/// have, is skipped.
pub fn plan_expansions(bundle: &AppBundle, package_name: Option<&str>) -> Vec<ExpansionPlan> {
    let (Some(package), Some(manifest)) = (package_name.filter(|p| is_package_name(p)), &bundle.manifest) else {
        return Vec::new();
    };
    manifest
        .expansions
        .iter()
        .filter_map(|(file, install_path)| {
            let entry = bundle.entries.iter().find(|candidate| &candidate.name == file)?;
            let file_name = install_path.rsplit(['/', '\\']).next().unwrap_or("");
            is_obb_file_name(file_name)
                .then(|| ExpansionPlan { entry: entry.clone(), guest_path: format!("/sdcard/Android/obb/{package}/{file_name}") })
        })
        .collect()
}

/// A 2.7 GB bundle took 66–76 s to push into a guest when measured, about 40 MB/s. A quarter of
/// that leaves room for a slower disk and for the package manager's own work after the copy.
const ASSUMED_BYTES_PER_SECOND: u64 = 10 * 1024 * 1024;

/// How long to give one install of `total_bytes`: proportional to its size, within sane bounds.
pub fn install_timeout(total_bytes: u64) -> Duration {
    let proportional = total_bytes.div_ceil(ASSUMED_BYTES_PER_SECOND);
    Duration::from_secs(proportional.clamp(10 * 60, 60 * 60))
}

#[cfg(test)]
mod tests {
    use oe_formats::testing::{fake_apk, make_zip, ZipFile};

    use super::*;

    fn sized(names: &[(&str, u64)]) -> Vec<NamedSize> {
        names.iter().map(|(name, size)| NamedSize { name: (*name).to_owned(), size: *size }).collect()
    }

    fn abis(list: &str) -> Vec<String> {
        parse_abi_list(Some(list))
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn a_plain_apk_and_a_bundle_are_told_apart_by_their_contents_not_their_names() {
        let dir = tempfile::tempdir().unwrap();
        let apk = write(dir.path(), "app.xapk", &fake_apk("plain"));
        assert_eq!(inspect_package_file(&apk).unwrap(), PackageFile::Apk);

        let base = fake_apk("base");
        let split = fake_apk("split");
        let manifest = br#"{"package_name":"com.game","version_code":"42","split_apks":[{"file":"com.game.apk","id":"base"}]}"#;
        let zip = make_zip(
            &[ZipFile::stored("com.game.apk", &base), ZipFile::stored("config.arm64_v8a.apk", &split), ZipFile::deflated("manifest.json", manifest)],
            false,
        );
        let renamed = write(dir.path(), "game.apk", &zip);
        let PackageFile::Bundle(bundle) = inspect_package_file(&renamed).unwrap() else { panic!("a bundle") };
        assert_eq!(bundle.apks.len(), 2);
        let manifest = bundle.manifest.unwrap();
        assert_eq!((manifest.package_name.as_deref(), manifest.version_code), (Some("com.game"), Some(42)));
    }

    #[test]
    fn junk_is_refused_with_a_sentence_a_person_can_read() {
        let dir = tempfile::tempdir().unwrap();
        let junk = write(dir.path(), "junk.apk", b"not a zip at all");
        assert!(inspect_package_file(&junk).unwrap_err().0.contains("isn’t an Android app"));
        let text = write(dir.path(), "notes.txt", b"x");
        assert!(inspect_package_file(&text).unwrap_err().0.starts_with("Only Android app files"));
    }

    #[test]
    fn a_file_label_drops_whichever_app_extension_it_has() {
        assert_eq!(package_file_label(r"C:\x\My Game.XAPK"), "My Game");
        assert_eq!(package_file_label("/a/b/app.apks"), "app");
        assert_eq!(package_file_label("notes.txt"), "notes.txt");
        assert!(!has_package_extension(".apk"), "a dot file has no extension");
    }

    #[test]
    fn a_manifest_is_read_tolerantly() {
        let manifest = parse_bundle_manifest("\u{feff}{\"package_name\":\"  com.x \",\"version_code\":true,\"split_apks\":[1,{\"file\":\"a.apk\"}],\"expansions\":[{\"file\":\"main.obb\",\"install_path\":\"Android/obb/com.x/main.1.com.x.obb\"}]}").unwrap();
        assert_eq!(manifest.package_name.as_deref(), Some("com.x"));
        assert_eq!(manifest.version_code, Some(1), "Number(true) is 1");
        assert!(manifest.splits.is_empty(), "an entry missing its id is dropped");
        assert_eq!(manifest.expansions.len(), 1);
        assert_eq!(parse_bundle_manifest("[1,2]"), None);
        assert_eq!(parse_bundle_manifest("{\"version_code\":-3}").unwrap().version_code, None);
    }

    #[test]
    fn native_code_splits_are_recognised_under_both_prefixes() {
        assert_eq!(split_abi("config.arm64_v8a.apk"), Some("arm64-v8a"));
        assert_eq!(split_abi("split_config.X86_64.apk"), Some("x86_64"));
        assert_eq!(split_abi("config.en.apk"), None);
        assert_eq!(split_abi("config.xxhdpi.apk"), None);
        assert_eq!(split_abi("base.apk"), None);
    }

    #[test]
    fn x86_64_code_wins_and_every_other_split_comes_along() {
        let apks = sized(&[("base.apk", 10), ("config.en.apk", 1), ("config.arm64_v8a.apk", 5), ("config.x86_64.apk", 5), ("config.xxhdpi.apk", 1)]);
        let selection = select_apks(&apks, None, &abis("x86_64,arm64-v8a")).unwrap();
        assert_eq!(selection.apks, ["base.apk", "config.en.apk", "config.xxhdpi.apk", "config.x86_64.apk"]);
        assert_eq!(selection.abi.as_deref(), Some("x86_64"));
    }

    #[test]
    fn an_arm_only_bundle_gets_the_translators_first_choice_or_is_refused_naming_the_fix() {
        let apks = sized(&[("base.apk", 10), ("config.armeabi_v7a.apk", 5), ("config.arm64_v8a.apk", 5)]);
        let translated = select_apks(&apks, None, &abis("x86_64,x86,arm64-v8a,armeabi-v7a,armeabi")).unwrap();
        assert_eq!(translated.abi.as_deref(), Some("arm64-v8a"));
        let refused = select_apks(&apks, None, &abis("x86_64,x86")).unwrap_err();
        assert!(refused.0.contains("ARM phones") && refused.0.contains("open-emulator Android (Google APIs)"), "{refused}");
        let mips = select_apks(&sized(&[("base.apk", 1), ("config.mips.apk", 1)]), None, &abis("x86_64")).unwrap_err();
        assert!(mips.0.contains("different kind of phone"));
    }

    #[test]
    fn a_bundle_with_no_native_code_installs_on_any_guest() {
        let selection = select_apks(&sized(&[("base.apk", 1), ("config.en.apk", 1)]), None, &[]).unwrap();
        assert_eq!(selection.abi, None);
    }

    #[test]
    fn the_base_is_found_by_manifest_then_package_name_then_base_apk_then_by_elimination() {
        let manifest = BundleManifest { splits: vec![("weird.apk".into(), "base".into())], ..BundleManifest::default() };
        let apks = sized(&[("weird.apk", 1), ("base.apk", 9)]);
        assert_eq!(find_base(&apks, Some(&manifest)).as_deref(), Some("weird.apk"));
        let named = BundleManifest { package_name: Some("com.game".into()), ..BundleManifest::default() };
        assert_eq!(find_base(&sized(&[("com.game.apk", 1), ("base.apk", 9)]), Some(&named)).as_deref(), Some("com.game.apk"));
        assert_eq!(find_base(&sized(&[("x.apk", 99), ("base.apk", 1)]), None).as_deref(), Some("base.apk"));
        assert_eq!(find_base(&sized(&[("split_assets.apk", 99), ("com.a.b.apk", 1)]), None).as_deref(), Some("com.a.b.apk"));
        assert_eq!(find_base(&sized(&[("assets.apk", 50), ("game.apk", 80), ("config.en.apk", 999)]), None).as_deref(), Some("game.apk"));
        assert_eq!(find_base(&sized(&[("config.en.apk", 1)]), None), None);
    }

    #[test]
    fn the_install_timeout_grows_with_size_between_a_floor_and_a_ceiling() {
        assert_eq!(install_timeout(1), Duration::from_secs(600));
        assert_eq!(install_timeout(20 * 1024 * 1024 * 1024), Duration::from_secs(2048));
        assert_eq!(install_timeout(u64::MAX / 2), Duration::from_secs(3600));
    }

    #[test]
    fn obb_destinations_are_built_only_from_names_that_pass_a_strict_check() {
        let entry = |name: &str| ZipEntry { name: name.into(), method: 0, flags: 0, crc32: 0, compressed_size: 1, size: 1, local_header_offset: 0 };
        let bundle = AppBundle {
            apks: Vec::new(),
            entries: vec![entry("Android/obb/main.obb"), entry("evil.obb")],
            manifest: Some(BundleManifest {
                expansions: vec![
                    ("Android/obb/main.obb".into(), "Android/obb/com.game/main.7.com.game.obb".into()),
                    ("evil.obb".into(), "../../../data/evil;rm".into()),
                    ("missing.obb".into(), "Android/obb/com.game/missing.obb".into()),
                ],
                ..BundleManifest::default()
            }),
        };
        let plans = plan_expansions(&bundle, Some("com.game"));
        assert_eq!(plans.iter().map(|p| p.guest_path.as_str()).collect::<Vec<_>>(), ["/sdcard/Android/obb/com.game/main.7.com.game.obb"]);
        assert!(plan_expansions(&bundle, Some("not a package")).is_empty());
    }
}
