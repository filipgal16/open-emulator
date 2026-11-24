//! The checks of the old `scripts/smoke_test.sh`, as tests.
//!
//! The shell script ran the built binary on the assembled guest with each available backend and
//! grepped its output. These tests do the same through the real `open-vmm` executable, and also
//! through the library so the serial output can be compared exactly.

use std::process::Command;

use oe_vmm::{Backend, GUEST_ENTRY, Vmm, guest};

const GREETING: &str = "open-emulator: guest is alive";

/// Writes the assembled guest to a temporary file, as `make` wrote `build/guest/hello.bin`.
fn write_guest() -> (tempdir::Guard, std::path::PathBuf) {
    let guard = tempdir::Guard::new();
    let path = guard.path().join("hello.bin");
    std::fs::write(&path, guest::assemble()).unwrap();
    (guard, path)
}

/// A minimal temporary directory, so this test needs no extra dependency.
mod tempdir {
    use std::path::{Path, PathBuf};

    pub struct Guard(PathBuf);

    impl Guard {
        pub fn new() -> Self {
            let path = std::env::temp_dir().join(format!("oe-vmm-smoke-{}-{:?}", std::process::id(), std::thread::current().id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn run_binary(backend: &str) -> (String, String, bool) {
    let (_guard, path) = write_guest();
    let output = Command::new(env!("CARGO_BIN_EXE_open-vmm"))
        .arg(format!("--backend={backend}"))
        .arg(&path)
        .output()
        .unwrap();
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.success(),
    )
}

#[test]
fn soft_backend_prints_the_greeting() {
    let (stdout, stderr, success) = run_binary("soft");
    assert!(success, "stderr: {stderr}");
    assert!(stdout.contains(GREETING), "stdout: {stdout}");
    assert!(stderr.contains("backend=soft"), "stderr: {stderr}");
    assert!(stderr.contains("exit_code=0"), "stderr: {stderr}");
}

#[test]
fn kvm_backend_when_dev_kvm_opens() {
    // The same test the monitor makes: `/dev/kvm` has to open, not merely exist. CI runners have
    // the device without permission to use it, and the binary then rightly falls back to soft.
    if !oe_vmm::vmm::kvm_available() {
        eprintln!("kvm backend skipped (/dev/kvm missing or not permitted)");
        return;
    }
    let (stdout, stderr, success) = run_binary("kvm");
    assert!(success, "stderr: {stderr}");
    assert!(stdout.contains(GREETING), "stdout: {stdout}");
    assert!(stderr.contains("backend=kvm"), "stderr: {stderr}");
}

#[test]
fn library_run_gives_exact_serial_output() {
    let mut vmm = Vmm::new(16 * 1024 * 1024, Backend::Soft, false).unwrap();
    vmm.load_bytes(&guest::assemble(), GUEST_ENTRY).unwrap();
    vmm.run().unwrap();
    assert_eq!(vmm.exit_code, 0);
    assert_eq!(vmm.serial.output(), format!("{GREETING}\r\n").as_bytes());
}

#[test]
fn missing_guest_file_fails_and_no_arguments_prints_usage() {
    let output = Command::new(env!("CARGO_BIN_EXE_open-vmm")).arg("no-such-guest.bin").output().unwrap();
    assert_eq!(output.status.code(), Some(1));

    let output = Command::new(env!("CARGO_BIN_EXE_open-vmm")).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));

    let output = Command::new(env!("CARGO_BIN_EXE_open-vmm")).arg("--help").output().unwrap();
    assert_eq!(output.status.code(), Some(0));
}
