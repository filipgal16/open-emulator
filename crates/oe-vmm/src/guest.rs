//! The built-in "hello" guest, assembled by hand.
//!
//! The C project shipped a Python script that emitted these bytes so that building did not need
//! NASM. This is the same assembler, byte for byte, as a function: the guest prints a message to
//! the serial port and halts. The image is loaded at guest address `0x1000` and started at offset
//! zero, so every label is an offset from the start of the image.

use crate::SERIAL_PORT;

/// The text the guest prints, including its terminating NUL.
pub const MESSAGE: &[u8] = b"open-emulator: guest is alive\r\n\0";

/// Assembles the default hello guest.
pub fn assemble() -> Vec<u8> {
    assemble_message(MESSAGE)
}

/// Assembles a guest that prints `message` (which must end in a NUL byte) and halts.
pub fn assemble_message(message: &[u8]) -> Vec<u8> {
    let mut code: Vec<u8> = Vec::new();

    // mov dx, 0x3f8
    code.push(0xba);
    code.extend_from_slice(&SERIAL_PORT.to_le_bytes());

    // mov si, message (the address is patched in once the message offset is known)
    let mov_si_at = code.len();
    code.extend_from_slice(&[0xbe, 0x00, 0x00]);

    let print_label = code.len();
    // mov al, [si]
    code.extend_from_slice(&[0x8a, 0x04]);
    // test al, al
    code.extend_from_slice(&[0x84, 0xc0]);
    // jz .done (displacement patched later)
    let jz_at = code.len();
    code.extend_from_slice(&[0x74, 0x00]);
    // out dx, al
    code.push(0xee);
    // inc si
    code.push(0x46);
    // jmp .print
    let jmp_print_at = code.len();
    code.extend_from_slice(&[0xeb, 0x00]);

    let done_label = code.len();
    // hlt
    code.push(0xf4);
    // jmp .done
    let jmp_done_at = code.len();
    code.extend_from_slice(&[0xeb, 0x00]);

    let message_offset = code.len();
    code.extend_from_slice(message);

    code[mov_si_at + 1..mov_si_at + 3].copy_from_slice(&(message_offset as u16).to_le_bytes());
    code[jz_at + 1] = displacement(done_label, jz_at + 2);
    code[jmp_print_at + 1] = displacement(print_label, jmp_print_at + 2);
    code[jmp_done_at + 1] = displacement(done_label, jmp_done_at + 2);

    code
}

/// A relative jump displacement, truncated to a byte exactly as the Python `& 0xFF` did.
fn displacement(target: usize, next_instruction: usize) -> u8 {
    (target as i64 - next_instruction as i64) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Produced by running `assemble()` from `scripts/assemble_guest.py`.
    const REFERENCE: &[u8] = include_bytes!("../testdata/hello.bin");

    #[test]
    fn matches_the_python_assembler_byte_for_byte() {
        assert_eq!(assemble(), REFERENCE);
    }

    #[test]
    fn layout_is_as_documented() {
        let image = assemble();
        assert_eq!(image.len(), 19 + MESSAGE.len());
        assert_eq!(&image[..3], &[0xba, 0xf8, 0x03]);
        assert_eq!(&image[3..6], &[0xbe, 0x13, 0x00]);
        assert_eq!(&image[19..], MESSAGE);
    }
}
