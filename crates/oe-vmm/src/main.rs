//! `open-vmm`: runs a flat 16-bit guest binary until it halts. See [`oe_vmm::cli`].

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut arguments = std::env::args();
    let program = arguments.next().unwrap_or_else(|| "open-vmm".to_string());
    let arguments: Vec<String> = arguments.collect();
    // Exit statuses are small non-negative numbers; anything else cannot be reported, so it is
    // clamped to a generic failure.
    ExitCode::from(u8::try_from(oe_vmm::cli::run(&program, &arguments)).unwrap_or(1))
}
