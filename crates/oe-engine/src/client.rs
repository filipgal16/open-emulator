//! The typed façade the rest of the app drives the guest through.
//!
//! Everything above this (the store, the account, the app library, the UI) talks to
//! [`OpenEmuClient`] and never to an engine directly. Taps, swipes, keys and typed text go down the
//! engine's open input channel rather than each starting a command of their own.

use std::sync::Arc;
use std::time::Duration;

use crate::engine::AndroidEngine;
use crate::input::{is_typeable_text, key_command, swipe_command, tap_command, text_command};
use crate::{CommandResult, LogHandler};

const MINUTES_10: Duration = Duration::from_secs(600);

#[derive(Clone)]
pub struct OpenEmuClient {
    engine: Arc<dyn AndroidEngine>,
}

impl OpenEmuClient {
    pub fn new(engine: Arc<dyn AndroidEngine>) -> OpenEmuClient {
        OpenEmuClient { engine }
    }

    pub fn engine(&self) -> &Arc<dyn AndroidEngine> {
        &self.engine
    }

    pub fn set_profile(&self, profile: Option<String>) {
        self.engine.set_profile(profile);
    }

    pub async fn status(&self, on_log: LogHandler) -> CommandResult {
        self.engine.status(on_log).await
    }

    pub async fn doctor(&self, on_log: LogHandler) -> CommandResult {
        self.engine.doctor(on_log).await
    }

    pub async fn start(&self, on_log: LogHandler, cold: bool) -> CommandResult {
        self.engine.start(on_log, cold).await
    }

    pub async fn stop(&self, on_log: LogHandler) -> CommandResult {
        self.engine.stop(on_log).await
    }

    pub async fn provision(&self, on_log: LogHandler) -> CommandResult {
        self.engine.provision(on_log).await
    }

    /// The process whose window is the guest's screen, or `None` when it has to be mirrored.
    pub async fn display_pid(&self) -> Option<u32> {
        self.engine.display_pid().await
    }

    pub async fn tap(&self, x: f64, y: f64) -> bool {
        self.engine.send_input(&tap_command(x, y)).await
    }

    pub async fn swipe(&self, x1: f64, y1: f64, x2: f64, y2: f64, duration_ms: f64) -> bool {
        self.engine.send_input(&swipe_command(x1, y1, x2, y2, duration_ms)).await
    }

    /// False without touching the guest when the keycode isn't one we recognise.
    pub async fn key(&self, keycode: &str) -> bool {
        match key_command(keycode) {
            Some(command) => self.engine.send_input(&command).await,
            None => false,
        }
    }

    /// Types into whatever the guest has focused. False for text `input` cannot send.
    pub async fn text(&self, value: &str) -> bool {
        match text_command(value, |text| self.engine.quote_guest_arg(text)) {
            Some(command) => self.engine.send_input(&command).await,
            None => false,
        }
    }

    /// Types a secret without putting it on a command line. Validated here so every engine
    /// inherits the same refusal: a silently mangled password is worse than an obvious "no".
    pub async fn text_secret(&self, value: &str, on_log: LogHandler) -> bool {
        is_typeable_text(value) && self.engine.type_secret(value, on_log, Duration::from_secs(20)).await.success()
    }

    /// Opens the guest's own "add a Google account" flow. Nothing is automated past this point.
    pub async fn start_add_google_account(&self, on_log: LogHandler) -> bool {
        let command = "am start -a android.settings.ADD_ACCOUNT_SETTINGS --esa account_types com.google";
        self.engine.shell(command, on_log, Duration::from_secs(30)).await.success()
    }

    /// Takes a path on the Windows filesystem.
    pub async fn install(&self, apk_path: &str, on_log: LogHandler, timeout: Option<Duration>) -> CommandResult {
        self.engine.install_apk(apk_path, on_log, timeout.unwrap_or(MINUTES_10)).await
    }

    /// Whether this runtime can install an app that arrives as several APKs. The one runtime left
    /// can; the WSL one could not.
    pub fn can_install_bundles(&self) -> bool {
        true
    }

    /// Windows paths, base first, in one install session.
    pub async fn install_multiple(&self, apk_paths: &[String], on_log: LogHandler, timeout: Option<Duration>) -> CommandResult {
        self.engine.install_apks(apk_paths, on_log, timeout.unwrap_or(MINUTES_10)).await
    }

    /// Copies a host file into the guest, creating its directory first, explicitly, so storage
    /// that refuses the directory fails here, with its own error, before a copy that can run to
    /// gigabytes has started.
    pub async fn push_file(&self, host_path: &str, guest_path: &str, on_log: LogHandler, timeout: Option<Duration>) -> CommandResult {
        if let Some(dir) = guest_path.rfind('/').map(|at| &guest_path[..at]).filter(|dir| !dir.is_empty()) {
            let command = format!("mkdir -p {}", self.engine.quote_guest_arg(dir));
            let made = self.engine.shell(&command, on_log.clone(), Duration::from_secs(15)).await;
            if !made.success() {
                return made;
            }
        }
        self.engine.push_file(host_path, guest_path, on_log, timeout.unwrap_or(MINUTES_10)).await
    }

    /// Fires a VIEW intent: how the Play client is driven (`market://search?q=…`).
    pub async fn view_intent(&self, uri: &str, on_log: LogHandler) -> bool {
        let command = format!("am start -a android.intent.action.VIEW -d {}", self.engine.quote_guest_arg(uri));
        self.engine.shell(&command, on_log, Duration::from_secs(30)).await.success()
    }

    /// A single system property, or `None` when the guest doesn't answer.
    pub async fn getprop(&self, name: &str, on_log: LogHandler) -> Option<String> {
        let safe = (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_');
        if !safe {
            return None;
        }
        let result = self.engine.shell(&format!("getprop {name}"), on_log, Duration::from_secs(15)).await;
        if !result.success() {
            return None;
        }
        result.stdout.iter().map(|line| line.trim()).find(|line| !line.is_empty()).map(str::to_owned)
    }

    /// Generic `adb shell` passthrough. Callers quote their own arguments.
    pub async fn shell(&self, command: &str, on_log: LogHandler, timeout: Option<Duration>) -> CommandResult {
        self.engine.shell(command, on_log, timeout.unwrap_or(Duration::from_secs(15))).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::no_log;
    use crate::testing::{failed, ok, FakeEngine};

    fn client() -> (Arc<FakeEngine>, OpenEmuClient) {
        let engine = Arc::new(FakeEngine::default());
        (engine.clone(), OpenEmuClient::new(engine))
    }

    #[tokio::test]
    async fn taps_keys_and_text_go_down_the_input_channel() {
        let (engine, client) = client();
        assert!(client.tap(10.6, 20.2).await);
        assert!(client.key("KEYCODE_BACK").await);
        assert!(client.text("hello world").await);
        assert_eq!(*engine.inputs.lock().unwrap(), ["input tap 11 20", "input keyevent KEYCODE_BACK", "input text 'hello world'"]);
        assert!(engine.shells.lock().unwrap().is_empty(), "no command of its own per tap");
    }

    #[tokio::test]
    async fn what_the_guest_cannot_take_never_reaches_it() {
        let (engine, client) = client();
        assert!(!client.key("KEYCODE_BACK; reboot").await);
        assert!(!client.text("café").await);
        assert!(!client.text_secret("pässword", no_log()).await);
        assert!(client.getprop("ro.x; reboot", no_log()).await.is_none());
        assert!(engine.inputs.lock().unwrap().is_empty());
        assert!(engine.shells.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_push_makes_the_directory_first_and_stops_if_it_cannot() {
        let (engine, client) = client();
        assert!(client.push_file(r"C:\x\main.obb", "/sdcard/Android/obb/com.x/main.obb", no_log(), None).await.success());
        assert_eq!(*engine.shells.lock().unwrap(), ["mkdir -p '/sdcard/Android/obb/com.x'"]);
        assert_eq!(engine.pushes.lock().unwrap().len(), 1);

        *engine.shell_reply.lock().unwrap() = Some(Box::new(|_| failed("Permission denied")));
        assert!(!client.push_file(r"C:\x\y.obb", "/data/locked/y.obb", no_log(), None).await.success());
        assert_eq!(engine.pushes.lock().unwrap().len(), 1, "no copy after the directory was refused");
    }

    #[tokio::test]
    async fn a_property_is_its_first_non_empty_line() {
        let (engine, client) = client();
        *engine.shell_reply.lock().unwrap() = Some(Box::new(|_| ok(&["", "  30 "])));
        assert_eq!(client.getprop("ro.build.version.sdk", no_log()).await.as_deref(), Some("30"));
        assert_eq!(engine.shells.lock().unwrap()[0], "getprop ro.build.version.sdk");
    }
}
