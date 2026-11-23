//! Drives Google's Android emulator as a native Windows process: the SDK it is downloaded into,
//! the AVDs it runs, `adb`, and the guest itself.
//!
//! Errors are sentences, as in `oe-formats`, because they end up in the setup log the user reads.

pub mod acceleration;
pub mod client;
pub mod defender;
pub mod download;
pub mod engine;
pub mod env_file;
pub mod host;
pub mod input;
pub mod layout;
pub mod mirror;
pub mod process;
pub mod profiles;
pub mod quote;
pub mod rom_profile;
pub mod sdk;
pub mod text;
#[cfg(any(test, feature = "testing"))]
pub mod testing;

use std::sync::Arc;

pub use oe_formats::{err, fail, Error, Result};

/// Which of a process's output streams a line came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LogStream {
    Stdout,
    Stderr,
}

impl LogStream {
    pub fn name(self) -> &'static str {
        match self {
            LogStream::Stdout => "stdout",
            LogStream::Stderr => "stderr",
        }
    }
}

/// Where a command's output lines go as they arrive.
pub type LogHandler = Arc<dyn Fn(LogStream, &str) + Send + Sync>;

/// A handler that drops everything.
pub fn no_log() -> LogHandler {
    Arc::new(|_, _| {})
}

/// What a finished command produced, line by line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandResult {
    /// `None` when the process was killed rather than exiting.
    pub code: Option<i32>,
    /// Always `None` on Windows; kept so results read the same as the TypeScript app's.
    pub signal: Option<String>,
    pub stdout: Vec<String>,
    pub stderr: Vec<String>,
}

impl CommandResult {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// A result made up rather than run, for answers an engine knows without a process.
    pub fn synthetic(code: i32, stdout: Vec<String>, stderr: Vec<String>) -> Self {
        CommandResult { code: Some(code), signal: None, stdout, stderr }
    }
}
