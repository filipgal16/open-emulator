//! A software 16-bit x86 interpreter, just big enough for the built-in guest.
//!
//! This is not a full x86 emulator. It exists so the monitor can be exercised where `/dev/kvm`
//! is missing, which includes every Windows machine. It understands real-mode addressing with
//! the 16-bit ModRM forms, a handful of moves and arithmetic helpers, port I/O, short jumps and
//! `HLT`, and refuses anything else loudly rather than guessing.
//!
//! The behaviour is a faithful port of the C interpreter, including its quirks: memory operands
//! always use `DS`, the 16-bit `MOV` has no memory form, reads outside RAM return `0xff` and
//! writes outside RAM vanish.

use std::fmt;

use crate::serial::Serial;
use crate::vmm::Vmm;
use crate::SERIAL_PORT;

/// The zero flag, the only flag the interpreter models.
const FLAG_ZF: u16 = 1 << 6;

/// The C interpreter gave up after this many instructions, so a guest that never halts ends.
pub const MAX_STEPS: u32 = 1_000_000;

/// Why a single instruction could not be executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepError {
    /// The opcode is not one the interpreter knows; `ip` is the address of the opcode itself.
    UnhandledOpcode { opcode: u8, cs: u16, ip: u16 },
    /// `MOV r/m16` with a memory operand, which the interpreter never implemented.
    UnsupportedMemoryMove { opcode: u8 },
}

impl fmt::Display for StepError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnhandledOpcode { opcode, cs, ip } => {
                write!(f, "soft-cpu: unhandled opcode 0x{opcode:02x} at CS:IP={cs:04x}:{ip:04x}")
            }
            Self::UnsupportedMemoryMove { opcode } => {
                write!(f, "soft-cpu: unsupported MOV 0x{opcode:02x} memory form")
            }
        }
    }
}

impl std::error::Error for StepError {}

/// Why `run` stopped without the guest halting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunError {
    Step(StepError),
    /// The guest executed [`MAX_STEPS`] instructions without reaching `HLT`.
    StepLimit,
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Step(error) => error.fmt(f),
            Self::StepLimit => write!(f, "soft-cpu: exceeded max steps without HLT"),
        }
    }
}

impl std::error::Error for RunError {}

/// The processor state: general registers in ModRM order, then the instruction pointer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SoftCpu {
    pub ax: u16,
    pub cx: u16,
    pub dx: u16,
    pub bx: u16,
    pub sp: u16,
    pub bp: u16,
    pub si: u16,
    pub di: u16,
    pub ip: u16,
    pub flags: u16,
    pub cs: u16,
    pub ds: u16,
    pub es: u16,
    pub ss: u16,
    pub halted: bool,
}

impl SoftCpu {
    /// The reset state the monitor gives a guest loaded at `entry`: all segments at the entry
    /// paragraph, a stack near the top of that segment and `DX` pointing at the serial port.
    pub fn new(entry: u64) -> Self {
        let segment = (entry >> 4) as u16;
        Self {
            cs: segment,
            ds: segment,
            es: segment,
            ss: segment,
            ip: (entry & 0xf) as u16,
            sp: 0xfff0,
            dx: SERIAL_PORT,
            flags: 0x2,
            ..Self::default()
        }
    }

    fn reg16(&self, index: u8) -> u16 {
        match index & 7 {
            0 => self.ax,
            1 => self.cx,
            2 => self.dx,
            3 => self.bx,
            4 => self.sp,
            5 => self.bp,
            6 => self.si,
            _ => self.di,
        }
    }

    fn set_reg16(&mut self, index: u8, value: u16) {
        match index & 7 {
            0 => self.ax = value,
            1 => self.cx = value,
            2 => self.dx = value,
            3 => self.bx = value,
            4 => self.sp = value,
            5 => self.bp = value,
            6 => self.si = value,
            _ => self.di = value,
        }
    }

    /// Indices 0-3 are AL, CL, DL, BL and 4-7 are AH, CH, DH, BH.
    fn reg8(&self, index: u8) -> u8 {
        let word = self.reg16(index & 3);
        if index & 4 == 0 { word as u8 } else { (word >> 8) as u8 }
    }

    fn set_reg8(&mut self, index: u8, value: u8) {
        let word = self.reg16(index & 3);
        let word = if index & 4 == 0 {
            (word & 0xff00) | u16::from(value)
        } else {
            (word & 0x00ff) | (u16::from(value) << 8)
        };
        self.set_reg16(index & 3, word);
    }

    fn set_zero_flag(&mut self, zero: bool) {
        if zero {
            self.flags |= FLAG_ZF;
        } else {
            self.flags &= !FLAG_ZF;
        }
    }

    fn set_al(&mut self, value: u8) {
        self.ax = (self.ax & 0xff00) | u16::from(value);
    }

    fn jump_relative(&mut self, displacement: i16) {
        self.ip = self.ip.wrapping_add(displacement as u16);
    }

    fn fetch8(&mut self, ram: &[u8]) -> u8 {
        let byte = read8(ram, linear(self.cs, self.ip));
        self.ip = self.ip.wrapping_add(1);
        byte
    }

    fn fetch16(&mut self, ram: &[u8]) -> u16 {
        let low = self.fetch8(ram);
        let high = self.fetch8(ram);
        u16::from(low) | (u16::from(high) << 8)
    }

    /// The linear address a 16-bit ModRM operand with a memory form refers to (always via DS).
    fn effective_address(&mut self, ram: &[u8], modrm: u8) -> u32 {
        let mode = modrm >> 6;
        let mut offset = match modrm & 7 {
            0 => self.bx.wrapping_add(self.si),
            1 => self.bx.wrapping_add(self.di),
            2 => self.bp.wrapping_add(self.si),
            3 => self.bp.wrapping_add(self.di),
            4 => self.si,
            5 => self.di,
            6 if mode == 0 => self.fetch16(ram),
            6 => self.bp,
            _ => self.bx,
        };
        if mode == 1 {
            offset = offset.wrapping_add(self.fetch8(ram) as i8 as u16);
        } else if mode == 2 {
            offset = offset.wrapping_add(self.fetch16(ram));
        }
        linear(self.ds, offset)
    }

    /// Executes one instruction.
    pub fn step(&mut self, ram: &mut [u8], serial: &mut Serial) -> Result<(), StepError> {
        let opcode = self.fetch8(ram);

        match opcode {
            // NOP
            0x90 => {}

            // MOV r8, imm8
            0xb0..=0xb7 => {
                let value = self.fetch8(ram);
                self.set_reg8(opcode - 0xb0, value);
            }

            // MOV r16, imm16
            0xb8..=0xbf => {
                let value = self.fetch16(ram);
                self.set_reg16(opcode - 0xb8, value);
            }

            // MOV r/m8, r8
            0x88 => {
                let modrm = self.fetch8(ram);
                let source = self.reg8((modrm >> 3) & 7);
                if modrm >> 6 == 3 {
                    self.set_reg8(modrm & 7, source);
                } else {
                    let address = self.effective_address(ram, modrm);
                    write8(ram, address, source);
                }
            }

            // MOV r8, r/m8
            0x8a => {
                let modrm = self.fetch8(ram);
                let value = if modrm >> 6 == 3 {
                    self.reg8(modrm & 7)
                } else {
                    let address = self.effective_address(ram, modrm);
                    read8(ram, address)
                };
                self.set_reg8((modrm >> 3) & 7, value);
            }

            // MOV r/m16, r16 (register form only)
            0x89 => {
                let modrm = self.fetch8(ram);
                if modrm >> 6 != 3 {
                    return Err(StepError::UnsupportedMemoryMove { opcode });
                }
                let value = self.reg16((modrm >> 3) & 7);
                self.set_reg16(modrm & 7, value);
            }

            // MOV r16, r/m16 (register form only)
            0x8b => {
                let modrm = self.fetch8(ram);
                if modrm >> 6 != 3 {
                    return Err(StepError::UnsupportedMemoryMove { opcode });
                }
                let value = self.reg16(modrm & 7);
                self.set_reg16((modrm >> 3) & 7, value);
            }

            // TEST AL, imm8
            0xa8 => {
                let value = self.fetch8(ram);
                self.set_zero_flag((self.ax as u8 & value) == 0);
            }

            // TEST r/m8, r8
            0x84 => {
                let modrm = self.fetch8(ram);
                let second = self.reg8((modrm >> 3) & 7);
                let first = if modrm >> 6 == 3 {
                    self.reg8(modrm & 7)
                } else {
                    let address = self.effective_address(ram, modrm);
                    read8(ram, address)
                };
                self.set_zero_flag((first & second) == 0);
            }

            // INC r16 (SI included); only the zero flag is modelled
            0x40..=0x47 => {
                let index = opcode - 0x40;
                let value = self.reg16(index).wrapping_add(1);
                self.set_reg16(index, value);
                self.set_zero_flag(value == 0);
            }

            // LODSB
            0xac => {
                let value = read8(ram, linear(self.ds, self.si));
                self.set_al(value);
                self.si = self.si.wrapping_add(1);
            }

            // OUT imm8, AL
            0xe6 => {
                let port = self.fetch8(ram);
                serial.outb(u16::from(port), self.ax as u8);
            }

            // OUT DX, AL
            0xee => serial.outb(self.dx, self.ax as u8),

            // IN AL, imm8
            0xe4 => {
                let port = self.fetch8(ram);
                let value = serial.inb(u16::from(port));
                self.set_al(value);
            }

            // IN AL, DX
            0xec => {
                let value = serial.inb(self.dx);
                self.set_al(value);
            }

            // JMP rel8
            0xeb => {
                let displacement = self.fetch8(ram) as i8;
                self.jump_relative(i16::from(displacement));
            }

            // JMP rel16
            0xe9 => {
                let displacement = self.fetch16(ram) as i16;
                self.jump_relative(displacement);
            }

            // JZ rel8
            0x74 => {
                let displacement = self.fetch8(ram) as i8;
                if self.flags & FLAG_ZF != 0 {
                    self.jump_relative(i16::from(displacement));
                }
            }

            // JNZ rel8
            0x75 => {
                let displacement = self.fetch8(ram) as i8;
                if self.flags & FLAG_ZF == 0 {
                    self.jump_relative(i16::from(displacement));
                }
            }

            // HLT
            0xf4 => self.halted = true,

            // INT imm8: there are no interrupt handlers, so the call is swallowed.
            0xcd => {
                self.fetch8(ram);
            }

            _ => {
                return Err(StepError::UnhandledOpcode {
                    opcode,
                    cs: self.cs,
                    ip: self.ip.wrapping_sub(1),
                });
            }
        }
        Ok(())
    }

    /// Runs until `HLT`, an error, or [`MAX_STEPS`] instructions.
    pub fn run(&mut self, ram: &mut [u8], serial: &mut Serial) -> Result<(), RunError> {
        for _ in 0..MAX_STEPS {
            if self.halted {
                return Ok(());
            }
            self.step(ram, serial).map_err(RunError::Step)?;
        }
        // The C loop checked for a halt before each step, so a `HLT` that was the very last
        // permitted instruction still counted as exceeding the limit.
        Err(RunError::StepLimit)
    }
}

/// Runs the guest loaded in `vmm` from `entry` on the software CPU and records its exit code:
/// 0 for a clean halt, 1 for an unsupported instruction, 2 for the step limit.
pub fn run(vmm: &mut Vmm, entry: u64) -> Result<(), RunError> {
    let mut cpu = SoftCpu::new(entry);
    let result = cpu.run(&mut vmm.ram, &mut vmm.serial);
    if let Err(error) = &result {
        eprintln!("{error}");
    }
    vmm.exit_code = match result {
        Ok(()) => 0,
        Err(RunError::Step(_)) => 1,
        Err(RunError::StepLimit) => 2,
    };
    result
}

fn linear(segment: u16, offset: u16) -> u32 {
    (u32::from(segment) << 4) + u32::from(offset)
}

fn read8(ram: &[u8], address: u32) -> u8 {
    ram.get(address as usize).copied().unwrap_or(0xff)
}

fn write8(ram: &mut [u8], address: u32, value: u8) {
    if let Some(slot) = ram.get_mut(address as usize) {
        *slot = value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: u64 = 0x1000;

    /// Loads `code` at the entry point of 64 KiB of RAM and runs it to completion.
    fn run_code(code: &[u8]) -> (SoftCpu, Vec<u8>, Serial, Result<(), RunError>) {
        let mut ram = vec![0u8; 0x10000];
        ram[ENTRY as usize..ENTRY as usize + code.len()].copy_from_slice(code);
        let mut serial = Serial::new(false);
        let mut cpu = SoftCpu::new(ENTRY);
        let result = cpu.run(&mut ram, &mut serial);
        (cpu, ram, serial, result)
    }

    #[test]
    fn reset_state_matches_the_monitor() {
        let cpu = SoftCpu::new(ENTRY);
        assert_eq!((cpu.cs, cpu.ip, cpu.ds, cpu.es, cpu.ss), (0x100, 0, 0x100, 0x100, 0x100));
        assert_eq!((cpu.sp, cpu.dx, cpu.flags), (0xfff0, 0x3f8, 2));
    }

    #[test]
    fn mov_immediates_reach_every_register() {
        let (cpu, _, _, result) = run_code(&[
            0xb8, 0x34, 0x12, // mov ax, 0x1234
            0xb9, 0x01, 0x02, // mov cx, 0x0201
            0xbb, 0xcd, 0xab, // mov bx, 0xabcd
            0xbe, 0x11, 0x11, // mov si, 0x1111
            0xbf, 0x22, 0x22, // mov di, 0x2222
            0xbd, 0x33, 0x33, // mov bp, 0x3333
            0xf4,
        ]);
        assert_eq!(result, Ok(()));
        assert_eq!(
            (cpu.ax, cpu.cx, cpu.bx, cpu.si, cpu.di, cpu.bp),
            (0x1234, 0x0201, 0xabcd, 0x1111, 0x2222, 0x3333)
        );
    }

    #[test]
    fn mov_byte_immediates_address_low_and_high_halves() {
        let (cpu, _, _, _) = run_code(&[
            0xb0, 0x11, // mov al, 0x11
            0xb4, 0x22, // mov ah, 0x22
            0xb1, 0x33, // mov cl, 0x33
            0xb5, 0x44, // mov ch, 0x44
            0xb2, 0x55, // mov dl, 0x55
            0xb6, 0x66, // mov dh, 0x66
            0xb3, 0x77, // mov bl, 0x77
            0xb7, 0x88, // mov bh, 0x88
            0xf4,
        ]);
        assert_eq!((cpu.ax, cpu.cx, cpu.dx, cpu.bx), (0x2211, 0x4433, 0x6655, 0x8877));
    }

    #[test]
    fn register_to_register_moves() {
        let (cpu, _, _, _) = run_code(&[
            0xb8, 0x34, 0x12, // mov ax, 0x1234
            0x89, 0xc3, // mov bx, ax
            0x8b, 0xcb, // mov cx, bx
            0x88, 0xe2, // mov dl, ah
            0x8a, 0xf8, // mov bh, al
            0xf4,
        ]);
        assert_eq!(cpu.cx, 0x1234);
        assert_eq!(cpu.dx & 0xff, 0x12);
        assert_eq!(cpu.bx, 0x3434);
    }

    #[test]
    fn sixteen_bit_moves_have_no_memory_form() {
        for opcode in [0x89, 0x8b] {
            let (_, _, _, result) = run_code(&[opcode, 0x04]);
            assert_eq!(result, Err(RunError::Step(StepError::UnsupportedMemoryMove { opcode })));
        }
    }

    #[test]
    fn byte_moves_through_memory_use_ds() {
        let (cpu, ram, _, result) = run_code(&[
            0xbb, 0x00, 0x20, // mov bx, 0x2000
            0xbe, 0x05, 0x00, // mov si, 5
            0xb0, 0x7e, // mov al, 0x7e
            0x88, 0x00, // mov [bx+si], al
            0x8a, 0x20, // mov ah, [bx+si]
            0xf4,
        ]);
        assert_eq!(result, Ok(()));
        assert_eq!(ram[0x1000 + 0x2005], 0x7e);
        assert_eq!(cpu.ax, 0x7e7e);
    }

    #[test]
    fn displacement_forms_wrap_and_sign_extend() {
        let (cpu, ram, _, _) = run_code(&[
            0xbb, 0x00, 0x02, // mov bx, 0x200
            0xb0, 0xaa, // mov al, 0xaa
            0x88, 0x47, 0xff, // mov [bx-1], al
            0x88, 0x87, 0x00, 0x01, // mov [bx+0x100], al
            0x88, 0x06, 0x00, 0x30, // mov [0x3000], al
            0xf4,
        ]);
        assert_eq!(ram[0x1000 + 0x1ff], 0xaa);
        assert_eq!(ram[0x1000 + 0x300], 0xaa);
        assert_eq!(ram[0x1000 + 0x3000], 0xaa);
        assert_eq!(cpu.ax & 0xff, 0xaa);
    }

    #[test]
    fn out_of_range_memory_reads_ff_and_writes_vanish() {
        let (cpu, _, _, result) = run_code(&[
            0xbb, 0xff, 0xff, // mov bx, 0xffff
            0x88, 0x07, // mov [bx], al (0x1000 + 0xffff is past the 64 KiB of RAM)
            0x8a, 0x07, // mov al, [bx]
            0xf4,
        ]);
        assert_eq!(result, Ok(()));
        assert_eq!(cpu.ax & 0xff, 0xff);
    }

    #[test]
    fn test_sets_the_zero_flag_and_jumps_follow_it() {
        // test al, 0x0f with AL = 0xf0 is zero, so jz is taken and skips the mov.
        let (cpu, _, _, _) = run_code(&[
            0xb0, 0xf0, // mov al, 0xf0
            0xa8, 0x0f, // test al, 0x0f
            0x74, 0x03, // jz +3
            0xb3, 0x01, // mov bl, 1 (skipped)
            0x90, // nop (skipped)
            0xf4,
        ]);
        assert_eq!(cpu.bx & 0xff, 0);

        // test al, al with AL = 1 is non-zero, so jnz is taken.
        let (cpu, _, _, _) = run_code(&[
            0xb0, 0x01, // mov al, 1
            0x84, 0xc0, // test al, al
            0x75, 0x02, // jnz +2
            0xb3, 0x09, // mov bl, 9 (skipped)
            0xf4,
        ]);
        assert_eq!(cpu.bx & 0xff, 0);

        // jz is not taken when the result is non-zero.
        let (cpu, _, _, _) = run_code(&[
            0xb0, 0x01, // mov al, 1
            0xa8, 0x01, // test al, 1
            0x74, 0x02, // jz +2 (not taken)
            0xb3, 0x09, // mov bl, 9
            0xf4,
        ]);
        assert_eq!(cpu.bx & 0xff, 9);
    }

    #[test]
    fn test_with_a_memory_operand() {
        let (cpu, _, _, _) = run_code(&[
            0xbb, 0x09, 0x00, // mov bx, 9 (the offset of the hlt below)
            0xb0, 0xff, // mov al, 0xff
            0x84, 0x07, // test [bx], al
            0x75, 0x00, // jnz +0
            0xf4,
        ]);
        // The byte at [bx] is the hlt opcode 0xf4, so the AND is non-zero.
        assert_eq!(cpu.flags & FLAG_ZF, 0);
    }

    #[test]
    fn inc_updates_the_register_and_zero_flag() {
        let (cpu, _, _, _) = run_code(&[
            0xb9, 0xff, 0xff, // mov cx, 0xffff
            0x41, // inc cx
            0xf4,
        ]);
        assert_eq!(cpu.cx, 0);
        assert_ne!(cpu.flags & FLAG_ZF, 0);

        let (cpu, _, _, _) = run_code(&[0x46, 0xf4]); // inc si
        assert_eq!(cpu.si, 1);
        assert_eq!(cpu.flags & FLAG_ZF, 0);
    }

    #[test]
    fn lodsb_loads_al_and_advances_si() {
        let (cpu, _, _, _) = run_code(&[
            0xb4, 0x99, // mov ah, 0x99
            0xbe, 0x06, 0x00, // mov si, 6 (offset of the hlt byte below)
            0xac, // lodsb
            0xf4,
        ]);
        assert_eq!(cpu.ax, 0x99f4);
        assert_eq!(cpu.si, 7);
    }

    #[test]
    fn port_output_and_input() {
        let (cpu, _, serial, _) = run_code(&[
            0xb0, b'h', // mov al, 'h'
            0xee, // out dx, al
            0xb0, b'i', // mov al, 'i'
            0xe6, 0xf8, // out 0xf8, al (port 0xf8 is not the serial port)
            0xe4, 0xf8, // in al, 0xf8
            0xf4,
        ]);
        assert_eq!(serial.output(), b"h");
        assert_eq!(cpu.ax & 0xff, 0xff);

        let (cpu, _, _, _) = run_code(&[
            0xba, 0xfd, 0x03, // mov dx, 0x3fd
            0xec, // in al, dx
            0xf4,
        ]);
        assert_eq!(cpu.ax & 0xff, 0x60);
    }

    #[test]
    fn jumps_move_forwards_and_backwards() {
        let (cpu, _, _, _) = run_code(&[
            0xeb, 0x03, // jmp +3
            0xb0, 0x11, 0x90, // skipped
            0xe9, 0x02, 0x00, // jmp +2
            0xb3, 0x01, // skipped
            0xf4,
        ]);
        assert_eq!(cpu.ax & 0xff, 0);
        assert_eq!(cpu.bx & 0xff, 0);
    }

    #[test]
    fn backward_jump_loops() {
        let (cpu, _, _, result) = run_code(&[
            0xb9, 0xfd, 0xff, // mov cx, 0xfffd
            0x41, // top: inc cx
            0x75, 0xfd, // jnz top
            0xf4,
        ]);
        assert_eq!(result, Ok(()));
        assert_eq!(cpu.cx, 0);
    }

    #[test]
    fn int_is_swallowed_and_nop_does_nothing() {
        let (cpu, _, _, result) = run_code(&[0x90, 0xcd, 0x10, 0xf4]);
        assert_eq!(result, Ok(()));
        assert_eq!(cpu.ip, 4);
    }

    #[test]
    fn unknown_opcodes_are_reported_with_their_address() {
        let (_, _, _, result) = run_code(&[0x90, 0x0f]);
        assert_eq!(
            result,
            Err(RunError::Step(StepError::UnhandledOpcode { opcode: 0x0f, cs: 0x100, ip: 1 }))
        );
        assert_eq!(
            result.unwrap_err().to_string(),
            "soft-cpu: unhandled opcode 0x0f at CS:IP=0100:0001"
        );
    }

    #[test]
    fn a_guest_that_never_halts_hits_the_step_limit() {
        let (_, _, _, result) = run_code(&[0xeb, 0xfe]); // jmp $
        assert_eq!(result, Err(RunError::StepLimit));
    }

    #[test]
    fn the_hello_guest_prints_its_message() {
        let image = crate::guest::assemble();
        let (cpu, _, serial, result) = run_code(&image);
        assert_eq!(result, Ok(()));
        assert!(cpu.halted);
        assert_eq!(serial.output(), b"open-emulator: guest is alive\r\n");
    }
}
