//! Runs native child processes and streams their output back line by line.
//!
//! Arguments are passed as **argv**, so nothing is ever re-split and there is nothing to escape:
//! no `wsl.exe -e` versus `--` distinction to get wrong, no `$HOME` that resolves to nothing, and
//! no second shell re-parsing the command. A whole class of quoting bugs stops being possible.
//!
//! Commands are serialized: the runtimes write shared pid and state files and are not safe to
//! drive concurrently against one guest.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

use crate::text::LineSplitter;
use crate::{err, no_log, CommandResult, LogHandler, LogStream, Result};

/// `CREATE_NO_WINDOW`: a console program started from a windowed app would otherwise flash a
/// console window for every command.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone)]
pub struct RunOptions {
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    /// Added to (or replacing in) this process's environment.
    pub env: Vec<(OsString, OsString)>,
    pub timeout: Duration,
    pub on_log: LogHandler,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions { args: Vec::new(), cwd: None, env: Vec::new(), timeout: Duration::from_secs(30), on_log: no_log() }
    }
}

impl RunOptions {
    pub fn args<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        RunOptions { args: args.into_iter().map(Into::into).collect(), ..RunOptions::default() }
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn on_log(mut self, on_log: LogHandler) -> Self {
        self.on_log = on_log;
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

fn command(file: &OsString, options: &RunOptions) -> Command {
    let mut command = Command::new(file);
    command.args(&options.args).envs(options.env.iter().map(|(k, v)| (k, v)));
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// Reads a stream to its end, splitting it into lines that go both to the log and into `sink`.
async fn collect(
    mut stream: impl AsyncRead + Unpin,
    which: LogStream,
    on_log: LogHandler,
    sink: Option<Arc<Mutex<Vec<String>>>>,
) {
    let mut splitter = LineSplitter::new();
    let mut buffer = vec![0u8; 16 * 1024];
    let mut deliver = |line: String| {
        on_log(which, &line);
        if let Some(sink) = &sink {
            sink.lock().unwrap().push(line);
        }
    };
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => splitter.push(&buffer[..n], &mut deliver),
        }
    }
    splitter.flush(&mut deliver);
}

/// Runs commands one at a time.
#[derive(Default)]
pub struct ProcessRunner {
    queue: tokio::sync::Mutex<()>,
}

impl ProcessRunner {
    pub fn new() -> Self {
        ProcessRunner::default()
    }

    /// Serialized. A failed command does not poison the queue — later commands still run.
    pub async fn run(&self, file: impl Into<OsString>, options: RunOptions) -> Result<CommandResult> {
        let _turn = self.queue.lock().await;
        exec(file.into(), options).await
    }

    /// Bypasses the queue. For reads that must answer while a long command holds it.
    pub async fn run_unqueued(&self, file: impl Into<OsString>, options: RunOptions) -> Result<CommandResult> {
        exec(file.into(), options).await
    }
}

/// Runs one command to completion, or until its timeout, when it is killed and this fails.
pub async fn exec(file: OsString, options: RunOptions) -> Result<CommandResult> {
    let mut child = command(&file, &options)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| err!("could not start {}: {error}", file.to_string_lossy()))?;

    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let out = collect(child.stdout.take().expect("piped"), LogStream::Stdout, options.on_log.clone(), Some(stdout.clone()));
    let errs = collect(child.stderr.take().expect("piped"), LogStream::Stderr, options.on_log.clone(), Some(stderr.clone()));

    let finished = tokio::time::timeout(options.timeout, async {
        let (_, _, status) = tokio::join!(out, errs, child.wait());
        status
    })
    .await;

    match finished {
        Ok(status) => {
            let status = status.map_err(|error| err!("could not wait for {}: {error}", file.to_string_lossy()))?;
            Ok(CommandResult {
                code: status.code(),
                signal: None,
                stdout: std::mem::take(&mut stdout.lock().unwrap()),
                stderr: std::mem::take(&mut stderr.lock().unwrap()),
            })
        }
        Err(_) => {
            let _ = child.kill().await;
            let args: Vec<String> = options.args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
            Err(err!(
                "command timed out after {}ms: {} {}",
                options.timeout.as_millis(),
                file.to_string_lossy(),
                args.join(" ")
            ))
        }
    }
}

/// A process that outlives the call that started it — the emulator itself.
pub struct DetachedProcess {
    pub pid: Option<u32>,
    pub child: Child,
}

/// Starts a process that outlives the call, streaming its output to `on_log` until it exits.
///
/// Its output is flushed on exit for the reason that matters most here: when the emulator dies,
/// its final message is the one worth reading, and it is exactly the one most likely to arrive
/// without a trailing newline.
pub fn spawn_detached(file: impl Into<OsString>, options: RunOptions) -> Result<DetachedProcess> {
    let file = file.into();
    let mut child = command(&file, &options)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| err!("could not start {}: {error}", file.to_string_lossy()))?;

    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    tokio::spawn(collect(stdout, LogStream::Stdout, options.on_log.clone(), None));
    tokio::spawn(collect(stderr, LogStream::Stderr, options.on_log, None));
    Ok(DetachedProcess { pid: child.id(), child })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// The helper child process (`examples/test_child.rs`), which `cargo test` builds into the
    /// profile's `examples` directory — found by walking up from the test binary, wherever this
    /// Cargo version keeps that.
    fn child() -> OsString {
        let name = if cfg!(windows) { "test_child.exe" } else { "test_child" };
        let exe = std::env::current_exe().unwrap();
        exe.ancestors()
            .map(|dir| dir.join("examples").join(name))
            .find(|candidate| candidate.exists())
            .expect("cargo test builds examples/test_child")
            .into()
    }

    fn opts<const N: usize>(args: [&str; N]) -> RunOptions {
        RunOptions::args(args).timeout(Duration::from_secs(15))
    }

    #[tokio::test]
    async fn stdout_is_captured_line_by_line_with_the_exit_code() {
        let result = ProcessRunner::new().run(child(), opts(["print", "one", "two"])).await.unwrap();
        assert_eq!(result.stdout, vec!["one", "two"]);
        assert_eq!(result.code, Some(0));
    }

    #[tokio::test]
    async fn stderr_is_kept_separate_from_stdout() {
        let result = ProcessRunner::new().run(child(), opts(["print", "out", "--stderr", "err"])).await.unwrap();
        assert_eq!(result.stdout, vec!["out"]);
        assert_eq!(result.stderr, vec!["err"]);
    }

    #[tokio::test]
    async fn a_non_zero_exit_resolves_with_the_code_rather_than_failing() {
        let result = ProcessRunner::new().run(child(), opts(["exit", "3"])).await.unwrap();
        assert_eq!(result.code, Some(3));
    }

    #[tokio::test]
    async fn a_line_split_across_two_writes_is_reassembled() {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let seen = lines.clone();
        let on_log: LogHandler = Arc::new(move |_, line| seen.lock().unwrap().push(line.to_owned()));
        let result = ProcessRunner::new().run(child(), opts(["split", "abc", "def"]).on_log(on_log)).await.unwrap();
        assert_eq!(result.stdout, vec!["abcdef"]);
        assert_eq!(*lines.lock().unwrap(), vec!["abcdef"]);
    }

    #[tokio::test]
    async fn output_with_no_trailing_newline_is_still_delivered() {
        let result = ProcessRunner::new().run(child(), opts(["raw", "no newline here"])).await.unwrap();
        assert_eq!(result.stdout, vec!["no newline here"]);
        let result = ProcessRunner::new().run(child(), opts(["raw-stderr", "dying words"])).await.unwrap();
        assert_eq!(result.stderr, vec!["dying words"]);
    }

    #[tokio::test]
    async fn a_command_that_overruns_its_timeout_fails_and_the_child_is_killed() {
        let started = Instant::now();
        let options = RunOptions::args(["sleep", "30000"]).timeout(Duration::from_millis(300));
        let error = ProcessRunner::new().run(child(), options).await.unwrap_err();
        assert!(error.0.contains("timed out after 300ms"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(10), "failed promptly rather than waiting the child out");
    }

    #[tokio::test]
    async fn commands_are_serialized_because_the_runtimes_share_pid_and_state_files() {
        let runner = Arc::new(ProcessRunner::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        let (r1, o1) = (runner.clone(), order.clone());
        let slow = tokio::spawn(async move {
            r1.run(child(), opts(["sleep", "250"])).await.unwrap();
            o1.lock().unwrap().push("slow");
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (r2, o2) = (runner.clone(), order.clone());
        let fast = tokio::spawn(async move {
            r2.run(child(), opts(["print", "fast"])).await.unwrap();
            o2.lock().unwrap().push("fast");
        });
        slow.await.unwrap();
        fast.await.unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["slow", "fast"], "the second command waited for the first");
    }

    #[tokio::test]
    async fn a_failed_command_does_not_poison_the_queue() {
        let runner = ProcessRunner::new();
        assert!(runner.run(child(), RunOptions::args(["sleep", "9999"]).timeout(Duration::from_millis(200))).await.is_err());
        let after = runner.run(child(), opts(["print", "still works"])).await.unwrap();
        assert_eq!(after.stdout, vec!["still works"]);
    }

    #[tokio::test]
    async fn a_missing_executable_fails_rather_than_hanging() {
        assert!(ProcessRunner::new().run("definitely-not-a-real-binary-xyz", opts([])).await.is_err());
    }

    #[tokio::test]
    async fn an_unqueued_read_answers_while_a_long_command_holds_the_queue() {
        let runner = Arc::new(ProcessRunner::new());
        let holder = runner.clone();
        let held = tokio::spawn(async move { holder.run(child(), opts(["sleep", "400"])).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let peek = runner.run_unqueued(child(), opts(["print", "peek"])).await.unwrap();
        assert_eq!(peek.stdout, vec!["peek"], "did not wait behind the queued command");
        held.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn arguments_are_passed_as_argv_so_nothing_re_splits_them() {
        let nasty = "a b\"c'd $HOME `whoami` ;rm -rf";
        let result = ProcessRunner::new().run(child(), opts(["raw", nasty])).await.unwrap();
        assert_eq!(result.stdout, vec![nasty]);
    }
}
