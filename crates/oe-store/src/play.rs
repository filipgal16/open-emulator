//! Drives the real Play Store app inside the guest.
//!
//! This is the whole of the "Play source": no catalogue, no protobuf client, no scraped listing.
//! Google's own client renders in the guest and `market://` intents steer it, so Play's UI is
//! always current and its installs are real Play installs.

use oe_engine::client::OpenEmuClient;
use oe_engine::no_log;

use crate::app_library::{is_valid_package_name, AppLibrary};

pub const PLAY_PACKAGE: &str = "com.android.vending";

/// `encodeURIComponent`: everything but `A–Z a–z 0–9 - _ . ! ~ * ' ( )` percent-encoded as UTF-8.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[derive(Clone)]
pub struct PlayController {
    client: OpenEmuClient,
    library: AppLibrary,
}

impl PlayController {
    pub fn new(client: OpenEmuClient, library: AppLibrary) -> PlayController {
        PlayController { client, library }
    }

    /// Brings Play to the foreground, the way the app grid launches anything.
    pub async fn open(&self) -> bool {
        self.library.launch(PLAY_PACKAGE).await
    }

    /// Searches inside Play. An empty query opens the store's front page.
    pub async fn search(&self, query: &str) -> bool {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return self.open().await;
        }
        self.client.view_intent(&format!("market://search?q={}&c=apps", encode_uri_component(trimmed)), no_log()).await
    }

    /// Opens one app's Play listing.
    pub async fn details(&self, package_name: &str) -> bool {
        is_valid_package_name(package_name)
            && self.client.view_intent(&format!("market://details?id={package_name}"), no_log()).await
    }

    pub async fn back(&self) -> bool {
        self.client.key("KEYCODE_BACK").await
    }

    pub async fn home(&self) -> bool {
        self.client.key("KEYCODE_HOME").await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use oe_engine::testing::FakeEngine;

    use super::*;

    #[test]
    fn queries_are_encoded_as_the_browser_would() {
        assert_eq!(encode_uri_component("clash of clans"), "clash%20of%20clans");
        assert_eq!(encode_uri_component("a&b=c/d"), "a%26b%3Dc%2Fd");
        assert_eq!(encode_uri_component("café"), "caf%C3%A9");
        assert_eq!(encode_uri_component("it's (ok)!"), "it's%20(ok)!");
    }

    #[tokio::test]
    async fn search_and_details_steer_play_with_market_intents() {
        let engine = Arc::new(FakeEngine::new());
        let client = OpenEmuClient::new(engine.clone());
        let play = PlayController::new(client.clone(), AppLibrary::new(client));
        assert!(play.search(" chess ").await);
        assert!(play.details("com.chess").await);
        assert!(!play.details("com.chess; reboot").await);
        let shells = engine.shells.lock().unwrap();
        assert_eq!(shells[0], "am start -a android.intent.action.VIEW -d 'market://search?q=chess&c=apps'");
        assert_eq!(shells[1], "am start -a android.intent.action.VIEW -d 'market://details?id=com.chess'");
        assert_eq!(shells.len(), 2);
    }
}
