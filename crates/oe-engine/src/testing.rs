//! A stand-in engine for tests, here and in the crates above: it records what it was asked and
//! answers from a script, so the store, the account and setup can be tested without a guest.
//!
//! Compiled for this crate's own tests, and for others with the `testing` feature.

use std::sync::Mutex;
use std::time::Duration;

use crate::engine::{AndroidEngine, BoxFuture};
use crate::quote::posix_quote;
use crate::{CommandResult, LogHandler, Result};

type ShellReply = Box<dyn Fn(&str) -> CommandResult + Send + Sync>;

#[derive(Default)]
pub struct FakeEngine {
    /// Every shell command, in order.
    pub shells: Mutex<Vec<String>>,
    /// Every input command, and `secret:<length>` for each secret typed.
    pub inputs: Mutex<Vec<String>>,
    /// Each install's files: one entry for `install_apk`, several for `install_apks`.
    pub installs: Mutex<Vec<Vec<String>>>,
    pub pushes: Mutex<Vec<(String, String)>>,
    /// What `status` reports.
    pub status_lines: Mutex<Vec<String>>,
    /// How shell commands are answered. Unset, every command succeeds with no output.
    pub shell_reply: Mutex<Option<ShellReply>>,
    /// How installs end. Unset, they succeed.
    pub install_result: Mutex<Option<CommandResult>>,
    pub provisions: Mutex<u32>,
}

pub fn ok(stdout: &[&str]) -> CommandResult {
    CommandResult::synthetic(0, stdout.iter().map(|s| (*s).to_owned()).collect(), Vec::new())
}

pub fn failed(stderr: &str) -> CommandResult {
    CommandResult::synthetic(1, Vec::new(), vec![stderr.to_owned()])
}

impl FakeEngine {
    pub fn new() -> FakeEngine {
        FakeEngine::default()
    }

    /// Answers shell commands with `reply`.
    pub fn answering(self, reply: impl Fn(&str) -> CommandResult + Send + Sync + 'static) -> FakeEngine {
        *self.shell_reply.lock().unwrap() = Some(Box::new(reply));
        self
    }

    pub fn with_status(self, lines: &[&str]) -> FakeEngine {
        *self.status_lines.lock().unwrap() = lines.iter().map(|s| (*s).to_owned()).collect();
        self
    }

    fn installed(&self, files: Vec<String>) -> CommandResult {
        self.installs.lock().unwrap().push(files);
        self.install_result.lock().unwrap().clone().unwrap_or_else(|| ok(&["Success"]))
    }
}

fn done<T: Send + 'static>(value: T) -> BoxFuture<'static, T> {
    Box::pin(async move { value })
}

impl AndroidEngine for FakeEngine {
    fn start(&self, _: LogHandler, _: bool) -> BoxFuture<'_, CommandResult> {
        done(ok(&["adb_device=emulator-5554", "boot_completed=1"]))
    }

    fn stop(&self, _: LogHandler) -> BoxFuture<'_, CommandResult> {
        done(ok(&["emulator=stopped"]))
    }

    fn status(&self, _: LogHandler) -> BoxFuture<'_, CommandResult> {
        done(CommandResult::synthetic(0, self.status_lines.lock().unwrap().clone(), Vec::new()))
    }

    fn provision(&self, _: LogHandler) -> BoxFuture<'_, CommandResult> {
        *self.provisions.lock().unwrap() += 1;
        done(ok(&["provisioned=1"]))
    }

    fn doctor(&self, _: LogHandler) -> BoxFuture<'_, CommandResult> {
        done(ok(&[]))
    }

    fn shell<'a>(&'a self, command: &'a str, _: LogHandler, _: Duration) -> BoxFuture<'a, CommandResult> {
        self.shells.lock().unwrap().push(command.to_owned());
        let reply = self.shell_reply.lock().unwrap().as_ref().map_or_else(|| ok(&[]), |reply| reply(command));
        done(reply)
    }

    fn quote_guest_arg(&self, value: &str) -> String {
        posix_quote(value)
    }

    fn type_secret<'a>(&'a self, value: &'a str, _: LogHandler, _: Duration) -> BoxFuture<'a, CommandResult> {
        self.inputs.lock().unwrap().push(format!("secret:{}", value.len()));
        done(ok(&[]))
    }

    fn install_apk<'a>(&'a self, host_path: &'a str, _: LogHandler, _: Duration) -> BoxFuture<'a, CommandResult> {
        done(self.installed(vec![host_path.to_owned()]))
    }

    fn install_apks<'a>(&'a self, host_paths: &'a [String], _: LogHandler, _: Duration) -> BoxFuture<'a, CommandResult> {
        done(self.installed(host_paths.to_vec()))
    }

    fn push_file<'a>(&'a self, host_path: &'a str, guest_path: &'a str, _: LogHandler, _: Duration) -> BoxFuture<'a, CommandResult> {
        self.pushes.lock().unwrap().push((host_path.to_owned(), guest_path.to_owned()));
        done(ok(&[]))
    }

    fn send_input<'a>(&'a self, command: &'a str) -> BoxFuture<'a, bool> {
        self.inputs.lock().unwrap().push(command.to_owned());
        done(true)
    }

    fn display_pid(&self) -> BoxFuture<'_, Option<u32>> {
        done(None)
    }

    fn screencap(&self) -> BoxFuture<'_, Result<Vec<u8>>> {
        done(Ok(Vec::new()))
    }

    fn set_profile(&self, _: Option<String>) {}
}
