//! The apps installed in the guest, and launching one.

use std::time::Duration;

use oe_engine::client::OpenEmuClient;
use oe_engine::no_log;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledApp {
    pub package_name: String,
    pub label: String,
}

/// Android package names are `[a-zA-Z][a-zA-Z0-9_]*` segments joined by dots. Anything else is
/// refused rather than escaped: these strings end up inside guest shell commands.
pub fn is_valid_package_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 {
        return false;
    }
    let mut segments = name.split('.');
    let first = segments.next().unwrap_or("");
    let mut chars = first.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && segments.all(|segment| !segment.is_empty() && segment.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// A package name as something a person recognises: `com.king.candycrushsaga` → "Candycrushsaga".
/// Crude, but the alternative is an adb round trip per app for its real label.
pub fn pretty_label(package_name: &str) -> String {
    let last = package_name.split('.').filter(|part| !part.is_empty()).next_back().unwrap_or(package_name);
    let mut spaced = String::new();
    let mut in_run = false;
    for c in last.chars() {
        if c == '_' || c == '-' {
            if !in_run {
                spaced.push(' ');
            }
            in_run = true;
        } else {
            spaced.push(c);
            in_run = false;
        }
    }
    let mut chars = spaced.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

#[derive(Clone)]
pub struct AppLibrary {
    client: OpenEmuClient,
}

impl AppLibrary {
    pub fn new(client: OpenEmuClient) -> AppLibrary {
        AppLibrary { client }
    }

    /// Third-party packages installed in the guest, sorted. Excludes the system image's own apps.
    pub async fn list(&self) -> Vec<InstalledApp> {
        let result = self.client.shell("pm list packages -3", no_log(), Some(Duration::from_secs(20))).await;
        let mut names: Vec<String> = result
            .stdout
            .iter()
            .filter_map(|line| line.trim().strip_prefix("package:"))
            .map(|name| name.trim().to_owned())
            .filter(|name| is_valid_package_name(name))
            .collect();
        names.sort();
        names.into_iter().map(|package_name| InstalledApp { label: pretty_label(&package_name), package_name }).collect()
    }

    /// Package names only — what install attribution compares before and after.
    pub async fn package_names(&self) -> Vec<String> {
        self.list().await.into_iter().map(|app| app.package_name).collect()
    }

    pub async fn launch(&self, package_name: &str) -> bool {
        if !is_valid_package_name(package_name) {
            return false;
        }
        let command = format!("monkey -p {package_name} -c android.intent.category.LAUNCHER 1");
        self.client.shell(&command, no_log(), Some(Duration::from_secs(20))).await.success()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use oe_engine::testing::{ok, FakeEngine};

    use super::*;

    #[test]
    fn package_names_are_allowlisted_not_escaped() {
        assert!(is_valid_package_name("com.king.candycrushsaga"));
        assert!(is_valid_package_name("a"));
        for hostile in ["", "com.x; reboot", "$(id)", "1com.x", "com..x", "com.x ", &"a".repeat(256)] {
            assert!(!is_valid_package_name(hostile), "{hostile}");
        }
    }

    #[test]
    fn labels_come_from_the_last_segment() {
        assert_eq!(pretty_label("com.king.candycrushsaga"), "Candycrushsaga");
        assert_eq!(pretty_label("org.my_cool--app"), "My cool app");
    }

    #[tokio::test]
    async fn the_list_is_third_party_packages_sorted_and_checked() {
        let engine = FakeEngine::new().answering(|_| ok(&["package:org.zeta", "package:com.alpha", "package:bad name", "junk"]));
        let library = AppLibrary::new(OpenEmuClient::new(Arc::new(engine)));
        assert_eq!(library.package_names().await, ["com.alpha", "org.zeta"]);
    }

    #[tokio::test]
    async fn launching_refuses_a_name_that_is_not_a_package() {
        let engine = Arc::new(FakeEngine::new());
        let library = AppLibrary::new(OpenEmuClient::new(engine.clone()));
        assert!(!library.launch("x; reboot").await);
        assert!(library.launch("com.alpha").await);
        assert_eq!(*engine.shells.lock().unwrap(), ["monkey -p com.alpha -c android.intent.category.LAUNCHER 1"]);
    }
}
