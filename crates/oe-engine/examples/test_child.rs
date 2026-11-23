//! A child process the engine's tests start, so they control exactly what it prints, how long it
//! takes and how it exits. Not part of the app.
//!
//! - `print <line>... [--stderr <line>...]` — lines on stdout, then on stderr
//! - `raw <text>` / `raw-stderr <text>` — text with no trailing newline
//! - `split <first> <second>` — two writes 60 ms apart, then a newline
//! - `sleep <ms>` — waits, then exits 0
//! - `exit <code>` — exits with the code

use std::io::Write;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    match args.first().map(String::as_str) {
        Some("print") => {
            let mut to_stderr = false;
            for arg in &args[1..] {
                if arg == "--stderr" {
                    to_stderr = true;
                } else if to_stderr {
                    writeln!(err, "{arg}").unwrap();
                } else {
                    writeln!(out, "{arg}").unwrap();
                }
            }
        }
        Some("raw") => write!(out, "{}", args[1]).unwrap(),
        Some("raw-stderr") => write!(err, "{}", args[1]).unwrap(),
        Some("split") => {
            write!(out, "{}", args[1]).unwrap();
            out.flush().unwrap();
            std::thread::sleep(Duration::from_millis(60));
            writeln!(out, "{}", args[2]).unwrap();
        }
        Some("sleep") => std::thread::sleep(Duration::from_millis(args[1].parse().unwrap())),
        Some("exit") => std::process::exit(args[1].parse().unwrap()),
        _ => std::process::exit(64),
    }
}
