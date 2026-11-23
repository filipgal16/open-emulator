//! Google's Android SDK repository manifest.
//!
//! Each package lists its archives with a direct URL, a byte size, and a SHA-1. Reading it lets the
//! packages be fetched in parallel and resumed, and removes the need for a Java runtime and
//! `cmdline-tools` whose only job was to run `sdkmanager` as a downloader.
//!
//! Read by splitting on element boundaries and looking within each block — never with one search
//! spanning the whole document, which is the mistake that quietly returns the wrong archive (see
//! [`archives_of`]). The shape is small, stable and covered by the fixture test.

use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    Windows,
    Macosx,
    Linux,
}

impl HostOs {
    pub fn name(self) -> &'static str {
        match self {
            HostOs::Windows => "windows",
            HostOs::Macosx => "macosx",
            HostOs::Linux => "linux",
        }
    }

    /// The host this build runs on.
    pub fn current() -> HostOs {
        if cfg!(windows) {
            HostOs::Windows
        } else if cfg!(target_os = "macos") {
            HostOs::Macosx
        } else {
            HostOs::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkArchive {
    /// Package coordinate, e.g. `platform-tools` or `system-images;android-30;default;x86_64`.
    pub path: String,
    pub display_name: String,
    /// Absolute, resolved against the manifest's own location.
    pub url: String,
    pub size_bytes: u64,
    pub sha1: String,
    /// `<uses-license ref="…">`, matched against the licence texts in the same document.
    pub license_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkLicense {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedRepository {
    pub packages: BTreeMap<String, SdkArchive>,
    pub licenses: BTreeMap<String, SdkLicense>,
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_xml_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}')
}

/// Every non-overlapping block from an opening `<name` (followed by a non-word character) to the
/// first closing tag after it — `/<name\b[\s\S]*?<\/name>/g`.
fn blocks<'a>(source: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = source[at..].find(&open) {
        let start = at + found;
        let after = start + open.len();
        if source[after..].chars().next().is_some_and(is_word_char) {
            at = after;
            continue;
        }
        let Some(end) = source[after..].find(&close) else { break };
        let end = after + end + close.len();
        out.push(&source[start..end]);
        at = end;
    }
    out
}

/// The trimmed content of the first `<name …>…</name>` in `source` — `/<name[^>]*>([\s\S]*?)<\/name>/`.
fn tag<'a>(source: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut at = 0;
    while let Some(found) = source[at..].find(&open) {
        let start = at + found + open.len();
        // `[^>]*>`: the rest of the opening tag, which may not contain another `<`… or anything but
        // `>` before it ends.
        let Some(gt) = source[start..].find('>') else { return None };
        let content_start = start + gt + 1;
        if let Some(end) = source[content_start..].find(&close) {
            return Some(source[content_start..content_start + end].trim_matches(is_xml_space));
        }
        at = start;
    }
    None
}

/// `/<element\s+attribute="([^"]+)"/`: the first such attribute value.
fn attribute<'a>(source: &'a str, element: &str, attribute: &str) -> Option<&'a str> {
    let open = format!("<{element}");
    let mut at = 0;
    while let Some(found) = source[at..].find(&open) {
        let after = at + found + open.len();
        at = after;
        let rest = &source[after..];
        let trimmed = rest.trim_start_matches(is_xml_space);
        if trimmed.len() == rest.len() {
            continue; // `\s+` needs at least one space
        }
        let Some(value) = trimmed.strip_prefix(attribute).and_then(|r| r.strip_prefix("=\"")) else { continue };
        let end = value.find('"')?;
        if end > 0 {
            return Some(&value[..end]);
        }
    }
    None
}

/// The archives of one package, each with its own host-os.
///
/// Split into blocks *before* looking inside them. A single lazy search spanning from the first
/// `<archive>` to the Windows `<host-os>` reaches across the intervening archives, and the `<url>`
/// read out of that span is the *first* archive's — the Linux one. That produced a manifest lookup
/// which cheerfully returned `platform-tools_r37.0.1-linux.zip` for a Windows host.
fn archives_of(package_block: &str) -> Vec<&str> {
    // `<archive>` exactly: `<archives>` is the container, not an archive.
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = package_block[at..].find("<archive>") {
        let start = at + found;
        let Some(end) = package_block[start..].find("</archive>") else { break };
        let end = start + end + "</archive>".len();
        out.push(&package_block[start..end]);
        at = end;
    }
    out
}

/// Picks the archive for this host.
///
/// A missing `<host-os>` means the package is platform-independent — `platforms;android-30` is one —
/// so it is a valid match for every host rather than a match for none.
fn select_archive<'a>(archives: &[&'a str], host: HostOs) -> Option<&'a str> {
    archives
        .iter()
        .find(|archive| tag(archive, "host-os") == Some(host.name()))
        .or_else(|| archives.iter().find(|archive| tag(archive, "host-os").is_none()))
        .copied()
}

/// Relative URLs are resolved against the directory the manifest itself came from.
pub fn resolve_url(manifest_url: &str, relative: &str) -> String {
    let lower = relative.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return relative.to_owned();
    }
    let base = &manifest_url[..manifest_url.rfind('/').map_or(0, |i| i + 1)];
    format!("{base}{}", relative.trim_start_matches('/'))
}

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

pub fn parse_repository(xml: &str, host: HostOs, manifest_url: &str) -> ParsedRepository {
    let mut parsed = ParsedRepository::default();

    for block in blocks(xml, "license") {
        let Some(id) = attribute(block, "license", "id") else { continue };
        let Some(gt) = block.find('>') else { continue };
        let text = &block[gt + 1..block.len() - "</license>".len()];
        parsed.licenses.insert(
            id.to_owned(),
            SdkLicense { id: id.to_owned(), text: decode_entities(text.trim_matches(is_xml_space)) },
        );
    }

    for block in blocks(xml, "remotePackage") {
        let Some(path) = attribute(block, "remotePackage", "path") else { continue };
        let Some(archive) = select_archive(&archives_of(block), host) else { continue };

        // `<complete>` rather than `<patches>`: a patch archive is a delta against a specific older
        // revision, which is useless when starting from nothing.
        let complete = blocks(archive, "complete").into_iter().next().unwrap_or(archive);

        let (Some(url), Some(sha1)) = (tag(complete, "url"), tag(complete, "checksum")) else { continue };
        let size: u64 = tag(complete, "size").and_then(|s| s.parse().ok()).unwrap_or(0);
        if url.is_empty() || sha1.is_empty() || size == 0 {
            continue;
        }

        parsed.packages.insert(
            path.to_owned(),
            SdkArchive {
                path: path.to_owned(),
                display_name: tag(block, "display-name").unwrap_or(path).to_owned(),
                url: resolve_url(manifest_url, url),
                size_bytes: size,
                sha1: sha1.to_lowercase(),
                license_id: attribute(block, "uses-license", "ref").map(str::to_owned),
            },
        );
    }
    parsed
}

/// The manifest for the main SDK, and the ones for system images.
pub const REPOSITORY_URL: &str = "https://dl.google.com/android/repository/repository2-3.xml";
pub const SYS_IMG_URL: &str = "https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml";
pub const SYS_IMG_GOOGLE_APIS_URL: &str = "https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml";
pub const SYS_IMG_PLAYSTORE_URL: &str = "https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml";

/// Which system-image manifest carries a given image tag.
pub fn sys_img_manifest_for(image_tag: &str) -> &'static str {
    match image_tag {
        "google_apis" => SYS_IMG_GOOGLE_APIS_URL,
        "google_apis_playstore" => SYS_IMG_PLAYSTORE_URL,
        _ => SYS_IMG_URL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST_URL: &str = "https://dl.google.com/android/repository/repository2-3.xml";

    /// Shaped exactly like Google's real manifest, including the detail that matters: `<host-os>`
    /// comes *after* `<complete>`, and one package carries three archives back to back.
    const XML: &str = r#"<?xml version="1.0" ?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
  <license id="android-sdk-license" type="text">Terms and Conditions &amp; such &lt;here&gt;</license>
  <license id="android-sdk-preview-license" type="text">Preview terms</license>
  <remotePackage path="platform-tools">
    <display-name>Android SDK Platform-Tools</display-name>
    <uses-license ref="android-sdk-license"/>
    <archives>
      <archive>
        <complete>
          <size>9054187</size>
          <checksum type="sha1">AAAA254aa5f903c15cf51001717bdf347fb6b53e0</checksum>
          <url>platform-tools_r37.0.1-linux.zip</url>
        </complete>
        <host-os>linux</host-os>
      </archive>
      <archive>
        <complete>
          <size>9100000</size>
          <checksum type="sha1">BBBB254aa5f903c15cf51001717bdf347fb6b53e0</checksum>
          <url>platform-tools_r37.0.1-darwin.zip</url>
        </complete>
        <host-os>macosx</host-os>
      </archive>
      <archive>
        <complete>
          <size>8000000</size>
          <checksum type="sha1">CCCC254aa5f903c15cf51001717bdf347fb6b53e0</checksum>
          <url>platform-tools_r37.0.1-win.zip</url>
        </complete>
        <host-os>windows</host-os>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="platforms;android-30">
    <display-name>Android SDK Platform 30</display-name>
    <uses-license ref="android-sdk-license"/>
    <archives>
      <archive>
        <complete>
          <size>52328361</size>
          <checksum type="sha1">e7c6280901dcfa511af098d67dd88c4dfcbc6ea2</checksum>
          <url>platform-30_r03.zip</url>
        </complete>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="broken;no-archive">
    <display-name>Nothing usable</display-name>
    <archives></archives>
  </remotePackage>
</sdk:sdk-repository>"#;

    fn package(host: HostOs, path: &str) -> Option<SdkArchive> {
        parse_repository(XML, host, MANIFEST_URL).packages.get(path).cloned()
    }

    #[test]
    fn the_archive_for_this_host_is_chosen_not_the_first_one_in_the_file() {
        assert!(package(HostOs::Windows, "platform-tools").unwrap().url.ends_with("-win.zip"));
        assert!(package(HostOs::Macosx, "platform-tools").unwrap().url.ends_with("-darwin.zip"));
        assert!(package(HostOs::Linux, "platform-tools").unwrap().url.ends_with("-linux.zip"));
    }

    #[test]
    fn size_and_checksum_come_from_the_same_archive_as_the_url() {
        let win = package(HostOs::Windows, "platform-tools").unwrap();
        assert_eq!(win.size_bytes, 8000000);
        assert_eq!(win.sha1, "cccc254aa5f903c15cf51001717bdf347fb6b53e0");
    }

    #[test]
    fn a_package_with_no_host_os_is_universal_not_unavailable() {
        for host in [HostOs::Windows, HostOs::Macosx, HostOs::Linux] {
            let platform = package(host, "platforms;android-30").unwrap_or_else(|| panic!("missing on {host:?}"));
            assert!(platform.url.ends_with("platform-30_r03.zip"));
        }
    }

    #[test]
    fn a_package_with_no_usable_archive_is_skipped_rather_than_half_parsed() {
        assert!(package(HostOs::Windows, "broken;no-archive").is_none());
    }

    #[test]
    fn urls_are_resolved_against_the_manifest_not_left_relative() {
        assert_eq!(
            package(HostOs::Windows, "platform-tools").unwrap().url,
            "https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip"
        );
        assert_eq!(resolve_url(MANIFEST_URL, "https://example.com/a.zip"), "https://example.com/a.zip");
    }

    #[test]
    fn licence_texts_are_captured_and_entity_decoded() {
        let parsed = parse_repository(XML, HostOs::Windows, MANIFEST_URL);
        assert_eq!(parsed.licenses.len(), 2);
        assert_eq!(parsed.licenses["android-sdk-license"].text, "Terms and Conditions & such <here>");
    }

    #[test]
    fn a_package_records_which_licence_it_requires() {
        assert_eq!(package(HostOs::Windows, "platform-tools").unwrap().license_id.as_deref(), Some("android-sdk-license"));
        assert_eq!(package(HostOs::Windows, "platform-tools").unwrap().display_name, "Android SDK Platform-Tools");
    }

    #[test]
    fn each_image_tag_maps_to_its_own_system_image_manifest() {
        let manifests = [sys_img_manifest_for("default"), sys_img_manifest_for("google_apis"), sys_img_manifest_for("google_apis_playstore")];
        assert_eq!(manifests.iter().collect::<std::collections::HashSet<_>>().len(), 3);
        assert!(manifests[1].contains("google_apis/"));
        assert!(manifests[2].contains("google_apis_playstore/"));
    }
}
