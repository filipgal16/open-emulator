//! Quoting values for the guest's shell.
//!
//! `adb shell <command>` hands one string to the guest's `sh`, which splits and expands it. A
//! search query or a password with `$`, a backtick, `;`, `&` or `|` in it would execute in the
//! guest unless it arrives single-quoted. With `adb.exe` started directly (argv, no shell on this
//! side) there is exactly one shell to get through, so one layer of quoting is right; the WSL
//! runtime had two shells in the way and needed [`guest_shell_arg`]'s two layers.

/// POSIX single-quoting: close the quote, emit an escaped quote, reopen: the only way to get a
/// single quote inside a single-quoted POSIX string.
pub fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Two layers of quoting, for a value that crosses two shells before the guest's.
pub fn guest_shell_arg(value: &str) -> String {
    posix_quote(&posix_quote(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_quotes_survive() {
        assert_eq!(posix_quote("it's"), r"'it'\''s'");
        assert_eq!(posix_quote("$HOME `x`; rm"), "'$HOME `x`; rm'");
        assert_eq!(posix_quote(""), "''");
    }

    #[test]
    fn two_layers_unwrap_to_the_value() {
        assert_eq!(guest_shell_arg("a b"), r"''\''a b'\'''");
    }
}
