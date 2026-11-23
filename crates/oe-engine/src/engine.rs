//! Everything the app needs from an Android runtime.
//!
//! One runtime is left — Google's emulator, as [`crate::sdk::sdk_engine::SdkEngine`] — but the
//! store, the account and the app library reach it only through this trait, so their tests can
//! stand a fake in for a guest. Methods return boxed futures so the trait can live behind `dyn`.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use crate::sdk::sdk_engine::SdkEngine;
use crate::{CommandResult, LogHandler, Result};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait AndroidEngine: Send + Sync {
    // ── Lifecycle ────────────────────────────────────────────────────────────────────────────
    /// Starts the guest, or adopts the one already running. `cold` skips the snapshot.
    fn start(&self, on_log: LogHandler, cold: bool) -> BoxFuture<'_, CommandResult>;
    fn stop(&self, on_log: LogHandler) -> BoxFuture<'_, CommandResult>;
    /// `key=value` lines; the parser is deliberately tolerant of missing ones.
    fn status(&self, on_log: LogHandler) -> BoxFuture<'_, CommandResult>;
    /// First boot, guest tuning, then a snapshot so later starts are quick. Safe to re-run.
    fn provision(&self, on_log: LogHandler) -> BoxFuture<'_, CommandResult>;
    fn doctor(&self, on_log: LogHandler) -> BoxFuture<'_, CommandResult>;

    // ── Guest access ─────────────────────────────────────────────────────────────────────────
    /// `adb shell <command>`. The caller quotes its own arguments with [`Self::quote_guest_arg`].
    fn shell<'a>(&'a self, command: &'a str, on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult>;
    /// Quotes one argument so it reaches the guest's `sh` as a literal value.
    fn quote_guest_arg(&self, value: &str) -> String;
    /// Types a string into the guest's focused field without putting it on a command line.
    fn type_secret<'a>(&'a self, value: &'a str, on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult>;
    /// Installs an APK from a path on the Windows filesystem.
    fn install_apk<'a>(&'a self, host_path: &'a str, on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult>;
    /// Installs one app delivered as several APKs, base first, in a single session.
    fn install_apks<'a>(&'a self, host_paths: &'a [String], on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult>;
    /// Copies a host file to an absolute path in the guest.
    fn push_file<'a>(&'a self, host_path: &'a str, guest_path: &'a str, on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult>;
    /// Sends one `input …` command down a channel that stays open, for taps and keys. True once
    /// it has been handed to the guest.
    fn send_input<'a>(&'a self, command: &'a str) -> BoxFuture<'a, bool>;

    // ── Presentation ─────────────────────────────────────────────────────────────────────────
    /// The process whose window shows the guest, or `None` when the screen has to be mirrored.
    fn display_pid(&self) -> BoxFuture<'_, Option<u32>>;
    /// One PNG of the guest's screen.
    fn screencap(&self) -> BoxFuture<'_, Result<Vec<u8>>>;

    /// Which guest profile later commands drive, or `None` for the default.
    fn set_profile(&self, profile: Option<String>);
}

impl AndroidEngine for SdkEngine {
    fn start(&self, on_log: LogHandler, cold: bool) -> BoxFuture<'_, CommandResult> {
        Box::pin(SdkEngine::start(self, on_log, cold))
    }

    fn stop(&self, on_log: LogHandler) -> BoxFuture<'_, CommandResult> {
        Box::pin(SdkEngine::stop(self, on_log))
    }

    fn status(&self, on_log: LogHandler) -> BoxFuture<'_, CommandResult> {
        Box::pin(SdkEngine::status(self, on_log))
    }

    fn provision(&self, on_log: LogHandler) -> BoxFuture<'_, CommandResult> {
        Box::pin(SdkEngine::provision(self, on_log))
    }

    fn doctor(&self, on_log: LogHandler) -> BoxFuture<'_, CommandResult> {
        Box::pin(SdkEngine::doctor(self, on_log))
    }

    fn shell<'a>(&'a self, command: &'a str, on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult> {
        Box::pin(SdkEngine::shell(self, command, on_log, timeout))
    }

    fn quote_guest_arg(&self, value: &str) -> String {
        SdkEngine::quote_guest_arg(self, value)
    }

    fn type_secret<'a>(&'a self, value: &'a str, on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult> {
        Box::pin(SdkEngine::type_secret(self, value, on_log, timeout))
    }

    fn install_apk<'a>(&'a self, host_path: &'a str, on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult> {
        Box::pin(SdkEngine::install_apk(self, host_path, on_log, timeout))
    }

    fn install_apks<'a>(&'a self, host_paths: &'a [String], on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult> {
        Box::pin(SdkEngine::install_apks(self, host_paths, on_log, timeout))
    }

    fn push_file<'a>(&'a self, host_path: &'a str, guest_path: &'a str, on_log: LogHandler, timeout: Duration) -> BoxFuture<'a, CommandResult> {
        Box::pin(SdkEngine::push_file(self, host_path, guest_path, on_log, timeout))
    }

    fn send_input<'a>(&'a self, command: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(SdkEngine::send_input(self, command))
    }

    fn display_pid(&self) -> BoxFuture<'_, Option<u32>> {
        Box::pin(SdkEngine::display_pid(self))
    }

    fn screencap(&self) -> BoxFuture<'_, Result<Vec<u8>>> {
        Box::pin(SdkEngine::screencap(self))
    }

    fn set_profile(&self, profile: Option<String>) {
        SdkEngine::set_profile(self, profile);
    }
}
