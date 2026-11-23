//! Timestamps as text, without a calendar library.

use std::time::{SystemTime, UNIX_EPOCH};

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, the format JavaScript's `Date.prototype.toISOString` writes, so
/// files the TypeScript app wrote and files this writes read the same.
pub fn iso8601(time: SystemTime) -> String {
    let millis = match time.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    };
    let days = millis.div_euclid(86_400_000);
    let of_day = millis.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

/// Now, as [`iso8601`].
pub fn now_iso8601() -> String {
    iso8601(SystemTime::now())
}

/// Year, month and day of a count of days since 1970-01-01 (Howard Hinnant's algorithm).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn formats_like_to_iso_string() {
        assert_eq!(iso8601(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        // new Date(1230768000123).toISOString()
        assert_eq!(iso8601(UNIX_EPOCH + Duration::from_millis(1_230_768_000_123)), "2009-01-01T00:00:00.123Z");
        // new Date(1795442445678).toISOString()
        assert_eq!(iso8601(UNIX_EPOCH + Duration::from_millis(1_795_442_445_678)), "2026-11-23T14:00:45.678Z");
        // A leap day.
        assert_eq!(iso8601(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00.000Z");
    }
}
