//! A minimal virtual machine monitor for the open-emulator guest payload.
//!
//! The C original was a step towards a type-2 hypervisor: it loads a flat 16-bit binary at guest
//! address `0x1000`, runs it until `HLT`, and forwards writes to the serial port at `0x3f8` to
//! standard output. It had two interchangeable CPU backends, and so does this port. The KVM
//! backend only exists on Linux, because `/dev/kvm` does; the software interpreter is plain Rust
//! and runs everywhere, which is what lets the tests run on the Windows machines we build on.

pub mod cli;
pub mod guest;
#[cfg(target_os = "linux")]
mod kvm;
pub mod memory;
pub mod serial;
pub mod soft_cpu;
pub mod vmm;

pub use vmm::{Backend, Vmm, VmmError};

/// Guest RAM used when the caller does not pick a size: 16 MiB.
pub const DEFAULT_RAM_SIZE: usize = 16 * 1024 * 1024;
/// Guest physical address the flat binary is loaded at and started from.
pub const GUEST_ENTRY: u64 = 0x1000;
/// The I/O port of the serial transmit register.
pub const SERIAL_PORT: u16 = 0x3f8;
