//! The serial port: a transmit register at `0x3f8` and a line status register at `0x3fd`.
//!
//! Output is kept in a bounded buffer (so a runaway guest cannot grow the host without limit) and
//! optionally echoed to standard output as it arrives, which is what the command-line program
//! does. Tests turn the echo off and read the buffer instead.

use std::io::Write;

use crate::SERIAL_PORT;

/// The C buffer held 4096 bytes including a terminating NUL, so at most 4095 bytes are kept.
const BUFFER_LIMIT: usize = 4095;
/// Line status: transmitter empty and holding register empty.
const LINE_STATUS_READY: u8 = 0x60;

#[derive(Debug)]
pub struct Serial {
    buffer: Vec<u8>,
    echo: bool,
}

impl Serial {
    /// `echo` forwards every transmitted byte to standard output immediately.
    pub fn new(echo: bool) -> Self {
        Self { buffer: Vec::new(), echo }
    }

    /// Handles a byte written to an I/O port. Anything but the transmit register is ignored.
    pub fn outb(&mut self, port: u16, value: u8) {
        if port != SERIAL_PORT {
            return;
        }
        if self.buffer.len() < BUFFER_LIMIT {
            self.buffer.push(value);
        }
        if self.echo {
            let mut stdout = std::io::stdout().lock();
            // A closed stdout must not stop the guest, so write errors are deliberately dropped.
            let _ = stdout.write_all(&[value]);
            let _ = stdout.flush();
        }
    }

    /// Handles a byte read from an I/O port: always ready to send, and `0xff` for unknown ports.
    pub fn inb(&self, port: u16) -> u8 {
        if port == SERIAL_PORT + 5 { LINE_STATUS_READY } else { 0xff }
    }

    /// Everything the guest has transmitted so far, up to the buffer limit.
    pub fn output(&self) -> &[u8] {
        &self.buffer
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_transmit_register_is_captured() {
        let mut serial = Serial::new(false);
        serial.outb(SERIAL_PORT, b'a');
        serial.outb(SERIAL_PORT + 1, b'b');
        serial.outb(0x80, b'c');
        assert_eq!(serial.output(), b"a");
    }

    #[test]
    fn line_status_reports_ready_and_other_ports_float_high() {
        let serial = Serial::new(false);
        assert_eq!(serial.inb(SERIAL_PORT + 5), 0x60);
        assert_eq!(serial.inb(SERIAL_PORT), 0xff);
        assert_eq!(serial.inb(0x1234), 0xff);
    }

    #[test]
    fn buffer_is_bounded() {
        let mut serial = Serial::new(false);
        for _ in 0..5000 {
            serial.outb(SERIAL_PORT, b'x');
        }
        assert_eq!(serial.output().len(), 4095);
    }
}
