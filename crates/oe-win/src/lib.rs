//! Every Win32 call open-emulator makes, behind safe functions.
//!
//! The Electron app reached these through a JavaScript FFI bridge; here they are direct calls.
//! Each module owns one concern: [`window`] reparents the emulator's window into ours,
//! [`guest_window`] keeps it placed and alive, and the rest replace what used to be a PowerShell
//! or `reg.exe` round trip.
//!
//! The guest-window controller is plain logic over an injected [`guest_window::EmbedApi`], so it
//! builds and tests on every platform; only the Win32 implementation is Windows-only.

#[cfg(windows)]
pub mod dpapi;
pub mod guest_window;
#[cfg(windows)]
pub mod process;
#[cfg(windows)]
pub mod system;
#[cfg(windows)]
pub mod window;
#[cfg(windows)]
pub mod wmi_probe;

/// A window handle as a plain number, so it can cross threads and live in messages.
///
/// `HWND` is a pointer type, which Rust will not send between threads; the value itself is just an
/// identifier the window manager hands out, and is safe to copy anywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Hwnd(pub isize);

impl Hwnd {
    pub fn is_null(self) -> bool {
        self.0 == 0
    }
}

/// A rectangle in physical pixels of the parent window's client area.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Rect { x, y, width, height }
    }
}

impl std::fmt::Display for Rect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}x{}@{},{}", self.width, self.height, self.x, self.y)
    }
}

/// A window's styles, captured before embedding so they can be put back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowStyles {
    pub style: isize,
    pub ex_style: isize,
}
