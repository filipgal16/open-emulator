//! Builders for the `input …` commands that drive the guest.
//!
//! Kept apart from the client so the escaping and clamping can be tested directly; this is the
//! one place where text from the UI is turned into a command line, so it is tested as carefully as
//! package names are.

use oe_formats::js_round;

/// Android keycode names (`KEYCODE_BACK`) or raw numeric codes. Nothing else reaches the guest.
pub fn is_safe_keycode(keycode: &str) -> bool {
    if let Some(name) = keycode.strip_prefix("KEYCODE_") {
        return (1..=40).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
    }
    (1..=4).contains(&keycode.len()) && keycode.bytes().all(|b| b.is_ascii_digit())
}

/// Screen coordinates are clamped rather than rejected: a tap a few pixels outside the panel is a
/// rounding artefact of a scaled view, not an attack, and swallowing it silently would make the UI
/// feel broken. Non-finite input is garbage rather than a big number, so it lands at the origin.
pub fn clamp_coord(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    js_round(value).clamp(0.0, 20_000.0) as i64
}

pub fn tap_command(x: f64, y: f64) -> String {
    format!("input tap {} {}", clamp_coord(x), clamp_coord(y))
}

/// Android reads a gesture's velocity from its duration, so it is bounded.
pub fn swipe_command(x1: f64, y1: f64, x2: f64, y2: f64, duration_ms: f64) -> String {
    let duration = js_round(if duration_ms.is_finite() { duration_ms } else { 200.0 }).clamp(1.0, 10_000.0) as i64;
    format!(
        "input swipe {} {} {} {} {duration}",
        clamp_coord(x1),
        clamp_coord(y1),
        clamp_coord(x2),
        clamp_coord(y2)
    )
}

pub fn key_command(keycode: &str) -> Option<String> {
    is_safe_keycode(keycode).then(|| format!("input keyevent {keycode}"))
}

/// Whether `input text` can actually send this string.
///
/// Android's `input` speaks printable ASCII. Anything else arrives mangled or not at all, and a
/// silently truncated password is worse than an obvious refusal.
pub fn is_typeable_text(value: &str) -> bool {
    (1..=1024).contains(&value.chars().count()) && value.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// `input text` for arbitrary user text, quoted rather than `%s`-escaped: the `%s`-for-space
/// convention corrupts any text that legitimately contains `%s`. The quoting is the caller's,
/// because how deep to quote is a property of the runtime, not of the text.
pub fn text_command(value: &str, quote: impl Fn(&str) -> String) -> Option<String> {
    is_typeable_text(value).then(|| format!("input text {}", quote(value)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quote::{guest_shell_arg, posix_quote};

    #[test]
    fn coordinates_are_clamped_never_passed_through_raw() {
        assert_eq!(clamp_coord(120.4), 120);
        assert_eq!(clamp_coord(-5.0), 0, "negatives clamp to the panel edge");
        assert_eq!(clamp_coord(1e9), 20_000, "absurd values clamp to the ceiling");
        assert_eq!(clamp_coord(f64::NAN), 0);
        assert_eq!(clamp_coord(f64::INFINITY), 0);
    }

    #[test]
    fn tap_and_swipe_emit_only_numbers() {
        assert_eq!(tap_command(10.6, 20.2), "input tap 11 20");
        assert_eq!(swipe_command(1.0, 2.0, 3.0, 4.0, 250.0), "input swipe 1 2 3 4 250");
    }

    #[test]
    fn swipe_duration_is_bounded() {
        assert_eq!(swipe_command(0.0, 0.0, 0.0, 0.0, 0.0), "input swipe 0 0 0 0 1");
        assert_eq!(swipe_command(0.0, 0.0, 0.0, 0.0, 999_999.0), "input swipe 0 0 0 0 10000");
        assert_eq!(swipe_command(0.0, 0.0, 0.0, 0.0, f64::NAN), "input swipe 0 0 0 0 200");
    }

    #[test]
    fn only_real_keycodes_reach_the_guest() {
        assert!(is_safe_keycode("KEYCODE_BACK"));
        assert!(is_safe_keycode("4"), "numeric codes are legitimate");
        assert_eq!(key_command("KEYCODE_HOME").as_deref(), Some("input keyevent KEYCODE_HOME"));
        for hostile in ["KEYCODE_BACK; id", "KEYCODE_BACK && id", "$(id)", "keycode_back", "", "KEYCODE-BACK", "KEYCODE_", "12345"] {
            assert!(!is_safe_keycode(hostile), "accepted keycode: {hostile}");
            assert_eq!(key_command(hostile), None, "built a command for: {hostile}");
        }
    }

    #[test]
    fn text_is_quoted_rather_than_percent_escaped() {
        let command = text_command("100%s off", guest_shell_arg).unwrap();
        assert!(command.starts_with("input text "));
        assert!(command.contains("100%s off"), "the literal text is preserved inside the quoting");
        assert_eq!(text_command("a b", posix_quote).as_deref(), Some("input text 'a b'"));
    }

    #[test]
    fn input_text_refuses_what_android_cannot_type() {
        assert!(!is_typeable_text(""));
        assert!(!is_typeable_text("café"), "non-ASCII arrives mangled");
        assert!(!is_typeable_text("line\nbreak"));
        assert!(!is_typeable_text(&"x".repeat(1025)));
        assert_eq!(text_command("café", guest_shell_arg), None);
        assert!(is_typeable_text("ASCII is fine ~!@#$%^&*()"));
    }
}
