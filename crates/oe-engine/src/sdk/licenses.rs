//! Google's SDK licences: presenting them, and recording that they were accepted.
//!
//! The old `fetch_android.sh` piped `yes` into `sdkmanager --licenses`; it accepted every Google
//! licence automatically, without ever showing one. `LICENSING.md` rests its whole argument on each
//! user's machine accepting Google's licence, so here the text is shown and the acceptance is
//! explicit.
//!
//! The acceptance is recorded in the same format `sdkmanager` uses (a file per licence id under
//! `<sdk>/licenses/`, containing the SHA-1 of the licence text), so the SDK directory stays
//! interchangeable with a normally-installed one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};

use crate::sdk::repository::SdkLicense;
use crate::{fail, Result};

/// `sdkmanager` identifies an accepted licence by the SHA-1 of its exact text.
pub fn license_hash(text: &str) -> String {
    oe_formats::bytes::hex(&Sha1::digest(text.as_bytes()))
}

fn license_file(sdk_root: &Path, license_id: &str) -> Result<PathBuf> {
    let safe = !license_id.is_empty()
        && license_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-');
    if !safe {
        fail!("unsafe licence id: {license_id}");
    }
    Ok(sdk_root.join("licenses").join(license_id))
}

fn recorded_hashes(file: &Path) -> Vec<String> {
    std::fs::read_to_string(file)
        .map(|text| text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Whether this exact licence text has already been accepted.
///
/// Matched on the hash, not merely the presence of the file: Google revises these, and a stale
/// acceptance recorded against older wording is not consent to the current one.
pub fn is_accepted(sdk_root: &Path, license: &SdkLicense) -> Result<bool> {
    let file = license_file(sdk_root, &license.id)?;
    Ok(recorded_hashes(&file).contains(&license_hash(&license.text)))
}

/// Records acceptance, appending rather than replacing.
///
/// A licences file legitimately holds several hashes, one per licence version the user has
/// accepted over time, and overwriting would silently revoke consent to the others.
pub fn record_acceptance(sdk_root: &Path, license: &SdkLicense) -> Result<()> {
    let file = license_file(sdk_root, &license.id)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let hash = license_hash(&license.text);
    let mut existing = recorded_hashes(&file);
    if existing.contains(&hash) {
        return Ok(());
    }
    existing.push(hash);
    // Leading newline matches the layout sdkmanager writes.
    std::fs::write(&file, format!("\n{}\n", existing.join("\n")))?;
    Ok(())
}

/// The licences that still need showing, given what has already been accepted.
pub fn pending_licenses(
    sdk_root: &Path,
    licenses: &BTreeMap<String, SdkLicense>,
    required_ids: &[String],
) -> Result<Vec<SdkLicense>> {
    let mut seen = Vec::new();
    let mut pending = Vec::new();
    for id in required_ids {
        if seen.contains(id) {
            continue;
        }
        seen.push(id.clone());
        // A package referencing a licence the manifest does not carry cannot be lawfully accepted
        // on the user's behalf, so it is surfaced rather than skipped.
        let Some(license) = licenses.get(id) else {
            fail!("the manifest references licence \"{id}\" but does not define it");
        };
        if !is_accepted(sdk_root, license)? {
            pending.push(license.clone());
        }
    }
    Ok(pending)
}

/// Accepts every licence in the list. Call only once a person has actually agreed to them.
pub fn accept_all(sdk_root: &Path, licenses: &[SdkLicense]) -> Result<()> {
    licenses.iter().try_for_each(|license| record_acceptance(sdk_root, license))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn license(id: &str, text: &str) -> SdkLicense {
        SdkLicense { id: id.into(), text: text.into() }
    }

    #[test]
    fn the_hash_is_the_sha1_of_the_exact_licence_text() {
        assert_eq!(license_hash("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    #[test]
    fn acceptance_round_trips_in_the_layout_sdkmanager_expects() {
        let root = tempfile::tempdir().unwrap();
        let terms = license("android-sdk-license", "Terms v1");
        assert!(!is_accepted(root.path(), &terms).unwrap(), "nothing is accepted on a fresh SDK root");
        record_acceptance(root.path(), &terms).unwrap();
        assert!(is_accepted(root.path(), &terms).unwrap());
        let written = std::fs::read_to_string(root.path().join("licenses").join("android-sdk-license")).unwrap();
        assert_eq!(written, format!("\n{}\n", license_hash("Terms v1")));
    }

    #[test]
    fn revised_wording_is_not_covered_and_a_second_version_appends() {
        let root = tempfile::tempdir().unwrap();
        record_acceptance(root.path(), &license("l", "v1")).unwrap();
        assert!(!is_accepted(root.path(), &license("l", "v2")).unwrap(), "revised wording needs its own consent");
        record_acceptance(root.path(), &license("l", "v2")).unwrap();
        record_acceptance(root.path(), &license("l", "v2")).unwrap();
        assert!(is_accepted(root.path(), &license("l", "v1")).unwrap(), "the first consent is not revoked");
        let lines = recorded_hashes(&root.path().join("licenses").join("l"));
        assert_eq!(lines.len(), 2, "recording twice does not duplicate the hash");
    }

    #[test]
    fn only_unaccepted_licences_are_pending_and_an_undefined_one_is_surfaced() {
        let root = tempfile::tempdir().unwrap();
        let all = BTreeMap::from([("a".to_owned(), license("a", "A")), ("b".to_owned(), license("b", "B"))]);
        accept_all(root.path(), &[license("a", "A")]).unwrap();
        let pending = pending_licenses(root.path(), &all, &["a".into(), "b".into(), "b".into()]).unwrap();
        assert_eq!(pending, vec![license("b", "B")]);
        assert!(pending_licenses(root.path(), &all, &["missing".into()]).unwrap_err().0.contains("does not define it"));
    }

    #[test]
    fn a_licence_id_that_is_a_path_traversal_is_refused() {
        let root = tempfile::tempdir().unwrap();
        assert!(record_acceptance(root.path(), &license("../evil", "x")).unwrap_err().0.contains("unsafe licence id"));
    }

    #[test]
    fn a_corrupt_licences_file_reads_as_not_accepted_rather_than_failing() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("licenses")).unwrap();
        std::fs::write(root.path().join("licenses").join("l"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(!is_accepted(root.path(), &license("l", "text")).unwrap());
    }
}
