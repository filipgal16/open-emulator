//! The KVM backend, Linux only.
//!
//! A single vCPU is put into 16-bit real mode with every segment based at the guest entry point,
//! then run in a loop. Only port I/O, `HLT` and shutdown are meaningful to this guest; any other
//! exit is a bug in the guest or the monitor and ends the run with an error.

use kvm_bindings::kvm_userspace_memory_region;
use kvm_ioctls::{Kvm, VcpuExit, VcpuFd, VmFd};

use crate::memory::GuestRam;
use crate::serial::Serial;
use crate::SERIAL_PORT;

/// The only KVM API version that has ever existed.
const KVM_API_VERSION: i32 = 12;
/// `EINTR`: a signal interrupted `KVM_RUN`, which is simply retried.
const EINTR: i32 = 4;

/// Real-mode code segment: present, readable, accessible, byte granular, 16-bit.
const SEGMENT_TYPE_CODE_READ_ACCESSED: u8 = 0xb;

pub struct KvmBackend {
    // The VM must outlive the vCPU created from it, so it is kept even though it is not used
    // again after setup.
    _vm: VmFd,
    _kvm: Kvm,
    vcpu: VcpuFd,
}

impl KvmBackend {
    /// Opens `/dev/kvm`, creates a VM mapping all of `ram` at guest address zero, and one vCPU.
    pub fn new(ram: &GuestRam) -> Result<Self, String> {
        let kvm = Kvm::new().map_err(|error| format!("open /dev/kvm: {error}"))?;

        let api = kvm.get_api_version();
        if api != KVM_API_VERSION {
            return Err(format!("kvm: unexpected API version {api} (want {KVM_API_VERSION})"));
        }

        let vm = kvm.create_vm().map_err(|error| format!("KVM_CREATE_VM: {error}"))?;

        let region = kvm_userspace_memory_region {
            slot: 0,
            flags: 0,
            guest_phys_addr: 0,
            memory_size: ram.len() as u64,
            userspace_addr: ram.host_address(),
        };
        // SAFETY: the region describes `ram`, which is page-aligned and which the machine keeps
        // alive for at least as long as the VM it is mapped into.
        unsafe { vm.set_user_memory_region(region) }
            .map_err(|error| format!("KVM_SET_USER_MEMORY_REGION: {error}"))?;

        let vcpu = vm.create_vcpu(0).map_err(|error| format!("KVM_CREATE_VCPU: {error}"))?;

        Ok(Self { _vm: vm, _kvm: kvm, vcpu })
    }

    /// Puts the vCPU in real mode at `entry` and runs it until the guest halts.
    pub fn run(&mut self, entry: u64, serial: &mut Serial) -> Result<(), String> {
        self.reset_vcpu(entry)?;

        loop {
            let exit = match self.vcpu.run() {
                Ok(exit) => exit,
                Err(error) if error.errno() == EINTR => continue,
                Err(error) => return Err(format!("KVM_RUN: {error}")),
            };

            match exit {
                VcpuExit::IoOut(port, data) => {
                    for &byte in data {
                        serial.outb(port, byte);
                    }
                }
                VcpuExit::IoIn(port, data) => {
                    for slot in data.iter_mut() {
                        *slot = serial.inb(port);
                    }
                }
                VcpuExit::Hlt | VcpuExit::Shutdown => return Ok(()),
                VcpuExit::InternalError => return Err("internal error".to_string()),
                VcpuExit::FailEntry(reason, _cpu) => {
                    return Err(format!("fail entry hardware_entry_failure_reason=0x{reason:x}"));
                }
                other => return Err(format!("unhandled exit reason {other:?}")),
            }
        }
    }

    fn reset_vcpu(&self, entry: u64) -> Result<(), String> {
        let mut sregs = self.vcpu.get_sregs().map_err(|error| format!("KVM_GET_SREGS: {error}"))?;

        // Real mode: the code segment base is the entry paragraph and the instruction pointer is
        // the remainder.
        sregs.cs.base = entry & !0xf;
        sregs.cs.selector = ((entry >> 4) & 0xffff) as u16;
        sregs.cs.limit = 0xffff;
        sregs.cs.type_ = SEGMENT_TYPE_CODE_READ_ACCESSED;
        sregs.cs.present = 1;
        sregs.cs.dpl = 0;
        sregs.cs.db = 0;
        sregs.cs.s = 1;
        sregs.cs.l = 0;
        sregs.cs.g = 0;
        sregs.cs.avl = 0;

        let code = sregs.cs;
        sregs.ds = code;
        sregs.es = code;
        sregs.fs = code;
        sregs.gs = code;
        sregs.ss = code;

        sregs.cr0 &= !1; // clear PE: real mode
        sregs.efer = 0;

        self.vcpu.set_sregs(&sregs).map_err(|error| format!("KVM_SET_SREGS: {error}"))?;

        let mut regs = kvm_bindings::kvm_regs::default();
        regs.rflags = 0x2; // the reserved bit must be set
        regs.rip = entry & 0xf;
        regs.rsp = 0xfff0;
        regs.rdx = u64::from(SERIAL_PORT);

        self.vcpu.set_regs(&regs).map_err(|error| format!("KVM_SET_REGS: {error}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vmm::{Backend, Vmm, kvm_available};

    #[test]
    fn the_hello_guest_runs_under_kvm_when_available() {
        if !kvm_available() {
            eprintln!("skipping: /dev/kvm is not available");
            return;
        }
        let mut vmm = Vmm::new(1 << 20, Backend::Kvm, false).unwrap();
        assert_eq!(vmm.backend, Backend::Kvm);
        vmm.load_bytes(&crate::guest::assemble(), crate::GUEST_ENTRY).unwrap();
        vmm.run().unwrap();
        assert_eq!(vmm.serial.output(), b"open-emulator: guest is alive\r\n");
    }
}
