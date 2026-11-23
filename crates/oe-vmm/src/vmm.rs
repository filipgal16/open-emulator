//! The virtual machine: guest RAM, a serial port and one of two CPU backends.
//!
//! The backend is chosen once, when the machine is created. `Auto` prefers KVM when `/dev/kvm`
//! can be opened and otherwise uses the software interpreter. Asking for KVM explicitly where it
//! cannot work falls back to the interpreter with a warning rather than failing, because the
//! guest produces the same output either way and a development machine without KVM should still
//! be able to run it.

use std::fmt;
use std::path::Path;

use crate::memory::GuestRam;
use crate::serial::Serial;
use crate::{DEFAULT_RAM_SIZE, GUEST_ENTRY, soft_cpu};

/// Which CPU executes the guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Auto,
    Kvm,
    Soft,
}

impl Backend {
    /// The name shown in the "backend=" log line.
    pub fn name(self) -> &'static str {
        match self {
            Self::Kvm => "kvm",
            Self::Soft => "soft",
            Self::Auto => "unknown",
        }
    }
}

#[derive(Debug)]
pub enum VmmError {
    /// The host could not provide the requested amount of guest RAM.
    OutOfMemory { bytes: usize },
    /// The guest binary could not be read.
    Io { path: String, source: std::io::Error },
    /// The guest binary would extend past the end of guest RAM.
    GuestTooLarge,
    /// The software CPU stopped on an error.
    SoftCpu(soft_cpu::RunError),
    /// The KVM backend failed; the message says where.
    Kvm(String),
}

impl fmt::Display for VmmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutOfMemory { bytes } => write!(f, "cannot allocate {bytes} bytes of guest RAM"),
            Self::Io { path, source } => write!(f, "{path}: {source}"),
            Self::GuestTooLarge => write!(f, "guest binary does not fit in RAM"),
            Self::SoftCpu(error) => error.fmt(f),
            Self::Kvm(message) => write!(f, "kvm: {message}"),
        }
    }
}

impl std::error::Error for VmmError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::SoftCpu(error) => Some(error),
            _ => None,
        }
    }
}

pub struct Vmm {
    pub ram: GuestRam,
    /// The backend actually in use; never `Auto`.
    pub backend: Backend,
    pub serial: Serial,
    /// The guest's exit status: 0 after a clean halt, non-zero after a failure.
    pub exit_code: i32,
    #[cfg(target_os = "linux")]
    kvm: Option<crate::kvm::KvmBackend>,
}

/// Whether KVM can be used on this machine: only on Linux, and only if `/dev/kvm` opens.
pub fn kvm_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm").is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

impl Vmm {
    /// Creates a machine with `ram_size` bytes of RAM (zero means the default of 16 MiB).
    /// `echo_serial` forwards guest serial output to standard output as it is produced.
    pub fn new(ram_size: usize, backend: Backend, echo_serial: bool) -> Result<Self, VmmError> {
        let ram_size = if ram_size == 0 { DEFAULT_RAM_SIZE } else { ram_size };
        let ram = GuestRam::new(ram_size).ok_or(VmmError::OutOfMemory { bytes: ram_size })?;

        let mut backend = match backend {
            Backend::Auto if kvm_available() => Backend::Kvm,
            Backend::Auto => Backend::Soft,
            chosen => chosen,
        };

        #[cfg(target_os = "linux")]
        let mut kvm = None;
        #[cfg(target_os = "linux")]
        if backend == Backend::Kvm {
            match crate::kvm::KvmBackend::new(&ram) {
                Ok(created) => kvm = Some(created),
                Err(message) => {
                    eprintln!("{message}");
                    eprintln!("kvm setup failed; falling back to soft CPU");
                    backend = Backend::Soft;
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        if backend == Backend::Kvm {
            eprintln!("KVM not supported on this platform; using soft CPU");
            backend = Backend::Soft;
        }

        Ok(Self {
            ram,
            backend,
            serial: Serial::new(echo_serial),
            exit_code: 0,
            #[cfg(target_os = "linux")]
            kvm,
        })
    }

    /// Copies `bytes` into guest RAM at `guest_addr`.
    pub fn load_bytes(&mut self, bytes: &[u8], guest_addr: u64) -> Result<(), VmmError> {
        let start = usize::try_from(guest_addr).map_err(|_| VmmError::GuestTooLarge)?;
        let end = start.checked_add(bytes.len()).ok_or(VmmError::GuestTooLarge)?;
        if end > self.ram.len() {
            return Err(VmmError::GuestTooLarge);
        }
        self.ram[start..end].copy_from_slice(bytes);
        Ok(())
    }

    /// Reads a flat binary from `path` and places it at `guest_addr`.
    pub fn load_flat_binary(&mut self, path: &Path, guest_addr: u64) -> Result<(), VmmError> {
        let bytes = std::fs::read(path).map_err(|source| VmmError::Io {
            path: path.display().to_string(),
            source,
        })?;
        self.load_bytes(&bytes, guest_addr)
    }

    /// Runs the guest from [`GUEST_ENTRY`] until it halts or fails, recording `exit_code`.
    pub fn run(&mut self) -> Result<(), VmmError> {
        eprintln!(
            "vmm: backend={} ram={} entry=0x{:x}",
            self.backend.name(),
            self.ram.len(),
            GUEST_ENTRY
        );

        #[cfg(target_os = "linux")]
        if let Some(kvm) = self.kvm.as_mut() {
            let result = kvm.run(GUEST_ENTRY, &mut self.serial);
            self.exit_code = i32::from(result.is_err());
            return result.map_err(VmmError::Kvm);
        }

        soft_cpu::run(self, GUEST_ENTRY).map_err(VmmError::SoftCpu)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_ram_means_the_default() {
        let vmm = Vmm::new(0, Backend::Soft, false).unwrap();
        assert_eq!(vmm.ram.len(), DEFAULT_RAM_SIZE);
        assert_eq!(vmm.backend, Backend::Soft);
    }

    #[test]
    fn auto_resolves_to_a_concrete_backend() {
        let vmm = Vmm::new(1 << 20, Backend::Auto, false).unwrap();
        assert_ne!(vmm.backend, Backend::Auto);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn kvm_falls_back_to_soft_off_linux() {
        let vmm = Vmm::new(1 << 20, Backend::Kvm, false).unwrap();
        assert_eq!(vmm.backend, Backend::Soft);
        assert!(!kvm_available());
    }

    #[test]
    fn loading_checks_bounds() {
        let mut vmm = Vmm::new(4096, Backend::Soft, false).unwrap();
        vmm.load_bytes(&[1, 2, 3], 4093).unwrap();
        assert_eq!(&vmm.ram[4093..], &[1, 2, 3]);
        assert!(matches!(vmm.load_bytes(&[1, 2, 3, 4], 4093), Err(VmmError::GuestTooLarge)));
        assert!(matches!(vmm.load_bytes(&[1], u64::MAX), Err(VmmError::GuestTooLarge)));
    }

    #[test]
    fn loading_a_missing_file_names_the_path() {
        let mut vmm = Vmm::new(4096, Backend::Soft, false).unwrap();
        let error = vmm.load_flat_binary(Path::new("definitely/not/here.bin"), 0).unwrap_err();
        assert!(error.to_string().starts_with("definitely/not/here.bin: "));
    }

    #[test]
    fn a_failing_guest_reports_exit_code_one() {
        let mut vmm = Vmm::new(1 << 20, Backend::Soft, false).unwrap();
        vmm.load_bytes(&[0x0f], GUEST_ENTRY).unwrap();
        assert!(vmm.run().is_err());
        assert_eq!(vmm.exit_code, 1);
    }
}
