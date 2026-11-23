//! Turns F-Droid's `index-v2.json` into something small enough to keep in memory and search on
//! every keystroke.
//!
//! The published index is tens of megabytes and carries per-locale text, build metadata and full
//! permission lists for every version of every app. So it is *distilled* once on download — one
//! locale, the fields the UI shows, and a handful of recent versions per app — and only the
//! distillate is cached and reloaded. The cache keeps the Electron app's JSON shape, so an
//! existing cache is read as it is.
//!
//! Pure: no files, no network.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use oe_formats::bytes::js_is_space;
use oe_formats::js_round;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexFile {
    /// Repo-relative, starting with `/` — joined onto the repo address for a URL.
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexVersion {
    pub version_name: String,
    pub version_code: i64,
    pub min_sdk: u32,
    pub added: i64,
    pub file: IndexFile,
    /// Native ABIs this build ships. Empty means pure bytecode, which runs on any guest.
    pub abis: Vec<String>,
    pub anti_features: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexApp {
    pub package_name: String,
    pub name: String,
    pub summary: String,
    pub description: String,
    pub license: Option<String>,
    pub categories: Vec<String>,
    pub web_site: Option<String>,
    pub source_code: Option<String>,
    pub last_updated: i64,
    pub icon_path: Option<String>,
    pub screenshot_paths: Vec<String>,
    /// Newest first, capped at [`MAX_VERSIONS`].
    pub versions: Vec<IndexVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DistilledIndex {
    pub repo_address: String,
    pub timestamp: i64,
    pub apps: Vec<IndexApp>,
}

/// Enough for the detail pane's version picker without carrying an app's whole history.
pub const MAX_VERSIONS: usize = 6;
const MAX_SCREENSHOTS: usize = 6;
/// In UTF-16 code units, as the Electron app counted.
const MAX_DESCRIPTION: usize = 4000;
const PREFERRED_LOCALES: [&str; 4] = ["en-US", "en_US", "en-GB", "en"];
pub const DEFAULT_REPO: &str = "https://f-droid.org/repo";

fn js_trim(text: &str) -> &str {
    text.trim_matches(js_is_space)
}

/// A non-blank string, trimmed.
fn as_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(js_trim).filter(|text| !text.is_empty()).map(str::to_owned)
}

fn as_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|number| number.is_finite())
}

fn as_int(value: Option<&Value>) -> Option<i64> {
    as_number(value).map(|number| number as i64)
}

fn as_array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn as_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    as_array(value).iter().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// Picks one language out of a `{ locale: value }` map. Falls back to *any* locale rather than
/// nothing: an app whose metadata exists only in German is still worth listing under its own name.
pub fn pick_localized(field: Option<&Value>) -> Option<&Value> {
    let map = as_object(field)?;
    PREFERRED_LOCALES.iter().find_map(|locale| map.get(*locale)).or_else(|| map.values().next())
}

/// F-Droid descriptions carry a restricted subset of HTML; the detail pane shows plain text.
pub fn strip_html(html: &str) -> String {
    let text = replace_tags(html, |tag| {
        let inner = tag.strip_prefix('<')?.strip_suffix('>')?;
        let rest = inner.get(..2).filter(|br| br.eq_ignore_ascii_case("br")).map(|_| &inner[2..])?;
        let rest = rest.trim_start_matches(js_is_space);
        matches!(rest, "" | "/").then_some("\n")
    });
    let text = replace_tags(&text, |tag| tag.eq_ignore_ascii_case("</p>").then_some("\n\n"));
    let text = replace_tags(&text, |tag| tag.eq_ignore_ascii_case("<li>").then_some("\n• "));
    let text = remove_tags(&text);
    let mut text = text
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    while text.contains("\n\n\n") {
        text = text.replace("\n\n\n", "\n\n");
    }
    js_trim(&text).to_owned()
}

/// Replaces each `<…>` (no `>` inside) for which `with` has an answer, leaving the rest as it was.
fn replace_tags(text: &str, with: impl Fn(&str) -> Option<&'static str>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let candidate = &rest[open..];
        match candidate.find('>').map(|close| &candidate[..=close]) {
            Some(tag) if !tag[1..].contains('<') => match with(tag) {
                Some(replacement) => {
                    out.push_str(replacement);
                    rest = &candidate[tag.len()..];
                }
                None => {
                    out.push('<');
                    rest = &candidate[1..];
                }
            },
            _ => {
                out.push('<');
                rest = &candidate[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `<[^>]*>` removed: from each `<` to the next `>`, whatever is between them.
fn remove_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let candidate = &rest[open..];
        match candidate.find('>') {
            Some(close) => rest = &candidate[close + 1..],
            None => {
                out.push_str(candidate);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The first `units` UTF-16 code units of `text`, never splitting a character.
fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut counted = 0;
    for (at, c) in text.char_indices() {
        counted += c.len_utf16();
        if counted > units {
            return &text[..at];
        }
    }
    text
}

fn parse_file(raw: Option<&Value>) -> Option<IndexFile> {
    let raw = as_object(raw)?;
    let name = as_string(raw.get("name"))?;
    let sha256 = as_string(raw.get("sha256"))?;
    // A version with no digest is dropped outright: the hash is the only thing that makes the
    // download verifiable, and installing an unverifiable APK is not a degraded mode worth having.
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(IndexFile { name, sha256: sha256.to_ascii_lowercase(), size: as_number(raw.get("size")).map_or(0, |size| size as u64) })
}

fn parse_version(raw: &Value) -> Option<IndexVersion> {
    let raw = raw.as_object()?;
    let file = parse_file(raw.get("file"))?;
    let manifest = as_object(raw.get("manifest"));
    let field = |name: &str| manifest.and_then(|manifest| manifest.get(name));
    let version_code = as_int(field("versionCode"))?;
    let uses_sdk = as_object(field("usesSdk"));
    Some(IndexVersion {
        version_name: as_string(field("versionName")).unwrap_or_else(|| version_code.to_string()),
        version_code,
        // No declared minimum means "any" — API 1 is the platform's own default.
        min_sdk: as_number(uses_sdk.and_then(|sdk| sdk.get("minSdkVersion"))).map_or(1, |sdk| sdk as u32),
        added: as_int(raw.get("added")).unwrap_or(0),
        file,
        abis: strings(field("nativecode")),
        anti_features: as_object(raw.get("antiFeatures")).map_or_else(Vec::new, |features| features.keys().cloned().collect()),
    })
}

fn parse_app(package_name: &str, raw: &Value) -> Option<IndexApp> {
    let raw = raw.as_object()?;
    let metadata = as_object(raw.get("metadata"));
    let meta = |name: &str| metadata.and_then(|metadata| metadata.get(name));

    let mut versions: Vec<IndexVersion> =
        as_object(raw.get("versions")).map_or_else(Vec::new, |versions| versions.values().filter_map(parse_version).collect());
    versions.sort_by(|a, b| b.version_code.cmp(&a.version_code));
    versions.truncate(MAX_VERSIONS);
    // Nothing installable, nothing to list.
    let newest_added = versions.first()?.added;

    let icon = as_object(pick_localized(meta("icon")));
    let screenshots = as_object(meta("screenshots"));
    let phone = screenshots.and_then(|shots| {
        pick_localized(shots.get("phone")).or_else(|| pick_localized(shots.values().next()))
    });
    let description = pick_localized(meta("description")).and_then(Value::as_str);
    let localized_text = |name: &str| pick_localized(meta(name)).and_then(Value::as_str).map(|text| js_trim(text).to_owned());

    Some(IndexApp {
        package_name: package_name.to_owned(),
        name: localized_text("name").filter(|name| !name.is_empty()).unwrap_or_else(|| package_name.to_owned()),
        summary: localized_text("summary").unwrap_or_default(),
        description: description.map(|text| utf16_prefix(&strip_html(text), MAX_DESCRIPTION).to_owned()).unwrap_or_default(),
        license: as_string(meta("license")),
        categories: strings(meta("categories")),
        web_site: as_string(meta("webSite")),
        source_code: as_string(meta("sourceCode")),
        last_updated: as_int(meta("lastUpdated")).unwrap_or(newest_added),
        icon_path: icon.and_then(|icon| as_string(icon.get("name"))),
        screenshot_paths: as_array(phone)
            .iter()
            .filter_map(|shot| as_string(shot.as_object().and_then(|shot| shot.get("name"))))
            .take(MAX_SCREENSHOTS)
            .collect(),
        versions,
    })
}

/// Distills a parsed `index-v2.json`. Malformed apps are skipped rather than failing the whole
/// index — one bad entry upstream must not take the catalogue offline.
pub fn distill_index(raw: &Value) -> DistilledIndex {
    let Some(raw) = raw.as_object() else { return DistilledIndex::default() };
    let repo = as_object(raw.get("repo"));
    let mut apps: Vec<IndexApp> = as_object(raw.get("packages"))
        .map_or_else(Vec::new, |packages| packages.iter().filter_map(|(name, entry)| parse_app(name, entry)).collect());
    apps.sort_by(|a, b| b.last_updated.cmp(&a.last_updated));
    DistilledIndex {
        repo_address: as_string(repo.and_then(|repo| repo.get("address")))
            .unwrap_or_else(|| DEFAULT_REPO.to_owned())
            .trim_end_matches('/')
            .to_owned(),
        timestamp: as_int(repo.and_then(|repo| repo.get("timestamp"))).unwrap_or(0),
        apps,
    }
}

/// The absolute URL of a repo-relative asset (icon, screenshot, or APK).
pub fn asset_url(repo_address: &str, repo_path: &str) -> String {
    format!("{repo_address}/{}", repo_path.trim_start_matches('/'))
}

/// The version to offer: the newest build the guest can actually run, rather than the newest
/// overall. When nothing qualifies, the newest anyway, so the UI can say *why* it is unavailable.
pub fn choose_version(app: &IndexApp, guest_sdk: Option<u32>) -> &IndexVersion {
    guest_sdk
        .and_then(|sdk| app.versions.iter().find(|version| version.min_sdk <= sdk))
        .unwrap_or(&app.versions[0])
}

const RECENCY_WINDOW_MS: f64 = 2.0 * 365.0 * 24.0 * 60.0 * 60_000.0;

/// A small tiebreaker so two equally relevant matches put the maintained one first.
fn recency_bonus(app: &IndexApp, now: i64) -> i64 {
    let age = (now - app.last_updated) as f64;
    if !(0.0..=RECENCY_WINDOW_MS).contains(&age) {
        return 0;
    }
    js_round(40.0 * (1.0 - age / RECENCY_WINDOW_MS)) as i64
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b<token>`: the token starting at a word boundary somewhere in `text`.
fn at_word_boundary(text: &str, token: &str) -> bool {
    let starts_word = token.chars().next().is_some_and(is_word);
    text.char_indices().any(|(at, _)| {
        text[at..].starts_with(token) && text[..at].chars().next_back().is_some_and(is_word) != starts_word
    })
}

fn token_score(app: &IndexApp, token: &str) -> i64 {
    let name = app.name.to_lowercase();
    let package = app.package_name.to_lowercase();
    if package == token {
        1000
    } else if name == token {
        900
    } else if name.starts_with(token) {
        700
    } else if at_word_boundary(&name, token) {
        // A word-boundary hit inside the name ("pipe" in "News Pipe") beats a mid-word one.
        600
    } else if name.contains(token) {
        450
    } else if package.contains(token) {
        300
    } else if app.summary.to_lowercase().contains(token) {
        150
    } else if app.description.to_lowercase().contains(token) {
        40
    } else {
        0
    }
}

/// Ranked search over the distillate.
///
/// Multi-token queries are AND: every token must hit something, which is what makes "signal
/// messenger" narrow the result rather than widen it. An empty query browses by last update.
pub fn search_index<'a>(index: &'a DistilledIndex, query: &str, limit: usize, now: i64) -> Vec<&'a IndexApp> {
    let query = query.to_lowercase();
    let tokens: Vec<&str> = query.split(js_is_space).filter(|token| !token.is_empty()).collect();
    if tokens.is_empty() {
        return index.apps.iter().take(limit).collect();
    }
    let mut scored: Vec<(&IndexApp, i64)> = index
        .apps
        .iter()
        .filter_map(|app| {
            let mut total = 0;
            for token in &tokens {
                match token_score(app, token) {
                    0 => return None,
                    score => total += score,
                }
            }
            Some((app, total + recency_bonus(app, now)))
        })
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.last_updated.cmp(&a.0.last_updated)));
    scored.into_iter().take(limit).map(|(app, _)| app).collect()
}

pub fn find_app<'a>(index: &'a DistilledIndex, package_name: &str) -> Option<&'a IndexApp> {
    index.apps.iter().find(|app| app.package_name == package_name)
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::json;

    use super::*;

    pub fn sha(n: u32) -> String {
        n.to_string().repeat(64)[..64].to_owned()
    }

    pub fn version(code: i64, min_sdk: u32) -> Value {
        json!({
            "added": 100,
            "file": { "name": format!("/app_{code}.apk"), "sha256": sha(1), "size": 1024 },
            "manifest": { "versionCode": code, "versionName": format!("{code}.0"), "usesSdk": { "minSdkVersion": min_sdk, "targetSdkVersion": 30 } },
        })
    }

    pub fn app(name: &str, summary: &str, last_updated: i64, versions: Value) -> Value {
        json!({
            "metadata": {
                "name": { "en-US": name },
                "summary": { "en-US": summary },
                "description": { "en-US": "" },
                "license": "GPL-3.0-only",
                "categories": ["Internet"],
                "lastUpdated": last_updated,
                "icon": { "en-US": { "name": format!("/{name}/icon.png"), "sha256": sha(2), "size": 10 } },
            },
            "versions": versions,
        })
    }

    pub fn index(packages: Value) -> DistilledIndex {
        distill_index(&json!({ "repo": { "address": "https://f-droid.org/repo/", "timestamp": 42 }, "packages": packages }))
    }

    fn one(name: &str) -> Value {
        app(name, &format!("{name} summary"), 1000, json!({ sha(1): version(1, 21) }))
    }

    #[test]
    fn localised_fields_prefer_english_but_never_render_blank() {
        let pick = |value: Value| pick_localized(Some(&value)).cloned();
        assert_eq!(pick(json!({ "en-US": "a", "de": "b" })), Some(json!("a")));
        assert_eq!(pick(json!({ "en": "a" })), Some(json!("a")));
        assert_eq!(pick(json!({ "de": "nur deutsch" })), Some(json!("nur deutsch")), "falls back to any locale");
        assert_eq!(pick_localized(None), None);
        assert_eq!(pick(json!("not a map")), None);
    }

    #[test]
    fn descriptions_are_reduced_to_plain_text() {
        assert_eq!(strip_html("<p>One</p><p>Two</p>"), "One\n\nTwo");
        assert_eq!(strip_html("a<br>b"), "a\nb");
        assert_eq!(strip_html("a<BR />b"), "a\nb");
        assert_eq!(strip_html("<b>bold</b> &amp; &quot;quoted&quot;"), "bold & \"quoted\"");
        assert_eq!(strip_html("<ul><li>one</li><li>two</li></ul>"), "• one\n• two");
        assert_eq!(strip_html("a < b"), "a < b", "a bracket that never closes is text");
        assert_eq!(strip_html("1 < 2 and 3 > 2"), "1  2", "as the Electron app read it: anything between brackets");
        assert_eq!(strip_html("a\n\n\n\n\nb"), "a\n\nb");
    }

    #[test]
    fn a_version_with_no_usable_digest_is_dropped() {
        let mut bad = version(2, 21);
        bad["file"]["sha256"] = json!("not-a-digest");
        let distilled = index(json!({ "a.b": app("A", "s", 1, json!({ "x": bad, "y": version(1, 21) })) }));
        assert_eq!(distilled.apps[0].versions.iter().map(|v| v.version_code).collect::<Vec<_>>(), [1]);
    }

    #[test]
    fn an_app_with_no_installable_version_is_not_listed_and_one_malformed_package_is_skipped() {
        let distilled = index(json!({ "a.b": app("A", "s", 1, json!({})), "bad": "garbage", "c.d": one("C") }));
        assert_eq!(distilled.apps.iter().map(|a| a.package_name.as_str()).collect::<Vec<_>>(), ["c.d"]);
    }

    #[test]
    fn the_repo_address_is_normalised_so_asset_urls_never_double_up_slashes() {
        let distilled = index(json!({ "a.b": one("A") }));
        assert_eq!(distilled.repo_address, "https://f-droid.org/repo");
        assert_eq!(asset_url(&distilled.repo_address, "/icons/a.png"), "https://f-droid.org/repo/icons/a.png");
        assert_eq!(distilled.timestamp, 42);
    }

    #[test]
    fn the_offered_version_is_the_newest_the_guest_can_run() {
        let distilled = index(json!({ "a.b": app("A", "s", 1, json!({ "1": version(1, 21), "2": version(2, 33), "3": version(3, 34) })) }));
        let app = &distilled.apps[0];
        assert_eq!(app.versions.iter().map(|v| v.version_code).collect::<Vec<_>>(), [3, 2, 1], "newest first");
        assert_eq!(choose_version(app, Some(30)).version_code, 1);
        assert_eq!(choose_version(app, Some(33)).version_code, 2);
        assert_eq!(choose_version(app, None).version_code, 3);
        assert_eq!(choose_version(app, Some(19)).version_code, 3, "nothing fits: the newest, so the UI can say why");
    }

    #[test]
    fn native_abis_and_anti_features_are_carried_through() {
        let mut v = version(1, 21);
        v["manifest"]["nativecode"] = json!(["arm64-v8a", "x86_64"]);
        v["antiFeatures"] = json!({ "Ads": {}, "Tracking": {} });
        let distilled = index(json!({ "a.b": app("A", "s", 1, json!({ "x": v })) }));
        assert_eq!(distilled.apps[0].versions[0].abis, ["arm64-v8a", "x86_64"]);
        assert_eq!(distilled.apps[0].versions[0].anti_features, ["Ads", "Tracking"]);
    }

    #[test]
    fn search_ranks_exact_package_then_name_prefix_then_summary() {
        let distilled = index(json!({
            "org.mention": app("Other", "works with signal", 1000, json!({ "x": version(1, 21) })),
            "org.signal": app("Messenger", "s", 1000, json!({ "x": version(1, 21) })),
            "org.prefix": app("Signalling", "s", 1000, json!({ "x": version(1, 21) })),
        }));
        let names = |query: &str| search_index(&distilled, query, 60, 0).iter().map(|a| a.package_name.clone()).collect::<Vec<_>>();
        assert_eq!(names("org.signal")[0], "org.signal");
        // A name prefix (700) beats a package that merely contains the word (300), which beats a summary mention (150).
        assert_eq!(names("signal"), ["org.prefix", "org.signal", "org.mention"]);
    }

    #[test]
    fn multi_token_queries_narrow_rather_than_widen() {
        let distilled = index(json!({ "a.b": one("Signal Messenger"), "c.d": one("Signal Clock") }));
        assert_eq!(search_index(&distilled, "signal messenger", 60, 0).len(), 1);
    }

    #[test]
    fn an_empty_query_browses_by_last_update_and_the_limit_holds() {
        let distilled = index(json!({
            "old.app": app("Old", "s", 1, json!({ "x": version(1, 21) })),
            "new.app": app("New", "s", 5, json!({ "x": version(1, 21) })),
        }));
        assert_eq!(search_index(&distilled, "  ", 60, 0)[0].package_name, "new.app");
        assert_eq!(search_index(&distilled, "", 1, 0).len(), 1);
        assert!(search_index(&distilled, "zzz", 60, 0).is_empty());
    }

    #[test]
    fn a_word_boundary_hit_beats_a_mid_word_one() {
        let distilled = index(json!({ "a.a": one("Newspipe"), "b.b": one("News Pipe") }));
        assert_eq!(search_index(&distilled, "pipe", 60, 0)[0].package_name, "b.b");
    }

    #[test]
    fn the_distillate_round_trips_through_the_electron_cache_shape() {
        let distilled = index(json!({ "a.b": one("A") }));
        let text = serde_json::to_string(&distilled).unwrap();
        assert!(text.starts_with(r#"{"repoAddress":"https://f-droid.org/repo","timestamp":42,"apps":[{"packageName":"a.b","name":"A""#), "{text}");
        assert_eq!(serde_json::from_str::<DistilledIndex>(&text).unwrap(), distilled);
    }
}
