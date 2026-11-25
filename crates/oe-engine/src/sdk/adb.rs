//! adb: the server's socket for what runs often, `adb.exe` for what it does best.
//!
//! Shell commands, property reads, device listing and screenshots go over the server's own
//! protocol ([`super::adb_wire`]), falling back to `adb.exe` only while no server is running yet.
//! Installs, pushes and the emulator console stay with `adb.exe`, driven as argv.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::adb_wire::{server_port, within, AdbWire, ShellSession, WireError};
use crate::process::{ProcessRunner, RunOptions};
use crate::text::LineSplitter;
use crate::{err, no_log, CommandResult, LogHandler, LogStream, Result};

/// The serials `adb devices` lists that are actually usable.
///
/// Only `device` counts. A serial listed as `offline`, `unauthorized`, or `bootloader` will accept
/// a connection and then fail every command against it, which reads as the guest being broken
/// rather than not ready yet.
pub fn parse_devices(stdout: &[String]) -> Vec<String> {
    stdout
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.to_ascii_lowercase().starts_with("list of devices"))
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            match (parts.next(), parts.next()) {
                (Some(serial), Some("device")) => Some(serial.to_owned()),
                _ => None,
            }
        })
        .collect()
}

/// `install-multiple` for an app delivered as several APKs.
///
/// One call, not one per file: the package manager only accepts a split inside the same install
/// session as its base, so installing the pieces one after another fails on the second. `-r`
/// replaces an installed copy, `-g` grants the runtime permissions the manifest asks for.
pub fn install_multiple_args(files: &[String]) -> Vec<String> {
    let mut args = vec!["install-multiple".to_owned(), "-r".to_owned(), "-g".to_owned()];
    args.extend(files.iter().cloned());
    args
}

/// True when the guest has finished booting *and* its package manager will answer.
pub fn is_boot_complete(boot_completed: Option<&str>, package_manager_ok: bool) -> bool {
    boot_completed.map(str::trim) == Some("1") && package_manager_ok
}

#[derive(Clone)]
pub struct Adb {
    binary: PathBuf,
    runner: Arc<ProcessRunner>,
    wire: AdbWire,
}

impl Adb {
    pub fn new(binary: PathBuf, runner: Arc<ProcessRunner>) -> Self {
        Adb { binary, runner, wire: AdbWire::new(server_port()) }
    }

    /// Talks to a server on another port: a test's fake one.
    pub fn with_server_port(mut self, port: u16) -> Self {
        self.wire = AdbWire::new(port);
        self
    }

    pub fn binary(&self) -> &PathBuf {
        &self.binary
    }

    /// `adb start-server`, so the first real command isn't the one that pays for the daemon.
    pub async fn start_server(&self, on_log: LogHandler) {
        let _ = self
            .runner
            .run(&self.binary, RunOptions::args(["start-server"]).on_log(on_log).timeout(Duration::from_secs(30)))
            .await;
    }

    pub async fn devices(&self) -> Result<Vec<String>> {
        match within(Duration::from_secs(15), self.wire.devices()).await {
            Some(Ok(serials)) => Ok(serials),
            // `adb.exe devices` starts the server on its way.
            Some(Err(WireError::NoServer(_))) => {
                let options = RunOptions::args(["devices"]).timeout(Duration::from_secs(15));
                let result = self.runner.run_unqueued(&self.binary, options).await?;
                Ok(parse_devices(&result.stdout))
            }
            Some(Err(error)) => Err(err!("{error}")),
            None => Err(err!("adb devices timed out")),
        }
    }

    /// Raw `adb -s <serial> â€¦`, with the serial as its own argv entry.
    ///
    /// Everything past `shell` is handed to the guest's `sh`, so a caller passing user text still
    /// has to quote for *that* shell: see [`crate::quote::posix_quote`]. What it no longer has to
    /// do is quote for a host shell as well, because there isn't one.
    pub async fn exec(&self, serial: &str, args: &[String], on_log: LogHandler, timeout: Duration) -> Result<CommandResult> {
        let mut argv = vec!["-s".to_owned(), serial.to_owned()];
        argv.extend(args.iter().cloned());
        self.runner.run(&self.binary, RunOptions::args(argv).on_log(on_log).timeout(timeout)).await
    }

    /// `adb shell <command>`, over the server's socket. The command reaches the guest's `sh` as one
    /// string, exactly as `adb.exe shell <command>` would send it.
    pub async fn shell(&self, serial: &str, command: &str, on_log: LogHandler, timeout: Duration) -> Result<CommandResult> {
        let mut lines = Lines::new(on_log.clone());
        let call = self.wire.shell(serial, command, |stream, data| lines.push(stream, data));
        match within(timeout, call).await {
            // A guest that went away mid-command closes without an exit code; that is a failure.
            Some(Ok(code)) => Ok(lines.finish(code.unwrap_or(1))),
            Some(Err(WireError::NoServer(_))) => {
                self.exec(serial, &["shell".to_owned(), command.to_owned()], on_log, timeout).await
            }
            // What `adb.exe` would have printed and exited 1 for: "device offline", "not found".
            Some(Err(WireError::Refused(message))) => {
                Ok(CommandResult::synthetic(1, Vec::new(), vec![format!("adb: {message}")]))
            }
            Some(Err(error)) => Err(err!("{error}")),
            None => Err(err!("command timed out after {}ms: adb shell {command}", timeout.as_millis())),
        }
    }

    /// A guest shell kept open for commands sent one after another. See [`ShellSession`].
    pub async fn open_shell(&self, serial: &str) -> Result<ShellSession> {
        match within(Duration::from_secs(10), self.wire.open_shell(serial)).await {
            Some(Ok(session)) => Ok(session),
            Some(Err(error)) => Err(err!("{error}")),
            None => Err(err!("opening a guest shell timed out")),
        }
    }

    /// Each path is its own argv entry, so spaces in a Windows path need no escaping.
    pub async fn install_multiple(&self, serial: &str, files: &[String], on_log: LogHandler, timeout: Duration) -> Result<CommandResult> {
        self.exec(serial, &install_multiple_args(files), on_log, timeout).await
    }

    /// Copies a host file into the guest. `guest_path` is not parsed by any shell on the way.
    pub async fn push(&self, serial: &str, host_path: &str, guest_path: &str, on_log: LogHandler, timeout: Duration) -> Result<CommandResult> {
        self.exec(serial, &["push".to_owned(), host_path.to_owned(), guest_path.to_owned()], on_log, timeout).await
    }

    /// A single property, or `None` when the guest doesn't answer.
    pub async fn getprop(&self, serial: &str, name: &str) -> Option<String> {
        let result = self.shell(serial, &format!("getprop {name}"), no_log(), Duration::from_secs(15)).await.ok()?;
        if result.code != Some(0) {
            return None;
        }
        result.stdout.iter().map(|line| line.trim()).find(|line| !line.is_empty()).map(str::to_owned)
    }

    /// Captures a PNG straight from the guest.
    ///
    /// Read as bytes, not through the line runner: a `0x0a` byte inside the image data is not a
    /// line break, and a text decode mangles anything that is not valid text. `exec-out` rather
    /// than `shell` for the same class of reason: `adb shell` translates `\n` to `\r\n` on some
    /// transports, which quietly corrupts every capture.
    pub async fn screencap(&self, serial: &str, timeout: Duration) -> Result<Vec<u8>> {
        match within(timeout, self.wire.exec_out(serial, "screencap -p")).await {
            Some(Ok(bytes)) => return Ok(bytes),
            Some(Err(WireError::NoServer(_))) => {}
            Some(Err(error)) => return Err(err!("{error}")),
            None => return Err(err!("screencap timed out")),
        }
        let mut command = tokio::process::Command::new(&self.binary);
        command.args(["-s", serial, "exec-out", "screencap", "-p"]).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let output = tokio::time::timeout(timeout, command.output())
            .await
            .map_err(|_| err!("screencap timed out"))?
            .map_err(|error| err!("could not run screencap: {error}"))?;
        Ok(output.stdout)
    }

    /// Waits for a serial to reach the `device` state. `None` on timeout, never an error.
    pub async fn wait_for_device(&self, timeout: Duration, poll: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        self.start_server(no_log()).await;
        while Instant::now() < deadline {
            if let Some(serial) = self.devices().await.ok().and_then(|serials| serials.into_iter().next()) {
                return Some(serial);
            }
            tokio::time::sleep(poll).await;
        }
        None
    }

    /// Waits for `sys.boot_completed=1` *and* a package manager that answers.
    ///
    /// The property alone is not enough: it flips before `pm` is ready, so an install fired the
    /// moment it goes high fails with a package manager that is not up yet.
    pub async fn wait_for_boot(&self, serial: &str, timeout: Duration, poll: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.getprop(serial, "sys.boot_completed").await.as_deref().map(str::trim) == Some("1") {
                let pm = self.shell(serial, "pm path android", no_log(), Duration::from_secs(15)).await;
                if pm.is_ok_and(|pm| pm.success()) {
                    return true;
                }
            }
            tokio::time::sleep(poll).await;
        }
        false
    }

    /// Asks the emulator to shut itself down cleanly, so pending qcow2 writes are flushed.
    pub async fn emu_kill(&self, serial: &str, on_log: LogHandler) {
        let _ = self.exec(serial, &["emu".to_owned(), "kill".to_owned()], on_log, Duration::from_secs(30)).await;
    }
}

/// Shell output as the line runner delivers it: split into lines, each logged as it completes.
struct Lines {
    on_log: LogHandler,
    out: LineSplitter,
    err: LineSplitter,
    stdout: Vec<String>,
    stderr: Vec<String>,
}

impl Lines {
    fn new(on_log: LogHandler) -> Lines {
        Lines { on_log, out: LineSplitter::new(), err: LineSplitter::new(), stdout: Vec::new(), stderr: Vec::new() }
    }

    fn push(&mut self, stream: LogStream, data: &[u8]) {
        let on_log = &self.on_log;
        let (splitter, sink) = match stream {
            LogStream::Stdout => (&mut self.out, &mut self.stdout),
            LogStream::Stderr => (&mut self.err, &mut self.stderr),
        };
        splitter.push(data, |line| {
            on_log(stream, &line);
            sink.push(line);
        });
    }

    fn finish(mut self, code: i32) -> CommandResult {
        let on_log = &self.on_log;
        let (stdout, stderr) = (&mut self.stdout, &mut self.stderr);
        self.out.flush(|line| {
            on_log(LogStream::Stdout, &line);
            stdout.push(line);
        });
        self.err.flush(|line| {
            on_log(LogStream::Stderr, &line);
            stderr.push(line);
        });
        CommandResult { code: Some(code), signal: None, stdout: self.stdout, stderr: self.stderr }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &[&str]) -> Vec<String> {
        text.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn only_serials_in_the_device_state_are_usable() {
        let serials = parse_devices(&lines(&[
            "List of devices attached",
            "emulator-5554\tdevice",
            "emulator-5556\toffline",
            "emulator-5558\tunauthorized",
            "",
        ]));
        assert_eq!(serials, vec!["emulator-5554"]);
    }

    #[test]
    fn an_empty_list_is_empty_not_a_phantom_device() {
        assert!(parse_devices(&lines(&["List of devices attached", ""])).is_empty());
    }

    #[test]
    fn a_tcp_serial_is_accepted() {
        assert_eq!(parse_devices(&lines(&["List of devices attached", "localhost:5555\tdevice"])), vec!["localhost:5555"]);
    }

    #[test]
    fn boot_needs_the_property_and_a_package_manager_that_answers() {
        assert!(is_boot_complete(Some("1"), true));
        assert!(!is_boot_complete(Some("1"), false), "property high but pm silent is not booted");
        assert!(!is_boot_complete(Some("0"), true));
        assert!(!is_boot_complete(None, true));
        assert!(is_boot_complete(Some("1\r"), true), "carriage returns do not defeat the comparison");
    }
}
