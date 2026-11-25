//! `cargo xtask emu-compare`: one identical measurement suite against any Android emulator over
//! adb, so open-emulator and LDPlayer (or anything else) are compared with the same definitions.
//!
//! Boot time is deliberately not measured here: `cargo xtask bench` does that with matching
//! definitions. Run each emulator on its own with the other closed, let the guest sit idle for a
//! minute after boot, then compare the two JSON files:
//!
//! ```text
//! cargo xtask emu-compare --adb C:\LDPlayer\LDPlayer9\adb.exe --serial 127.0.0.1:5555 --label ldplayer --apk ApiDemos-debug.apk
//! cargo xtask emu-compare --adb %LOCALAPPDATA%\open-emulator\sdk\platform-tools\adb.exe --serial emulator-5554 --label open-emulator --apk ApiDemos-debug.apk
//! cargo xtask emu-compare --compare ldplayer.json open-emulator.json
//! ```

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};

use super::{parse_args, utc_stamp, AdbCli, Captured};

const USAGE: &str = "\
cargo xtask emu-compare --adb <adb> --serial <serial> [--label <name>] [--apk file.apk]
                        [--component io.appium.android.apis/.ApiDemos] [--trials 3] [--out <label>.json]
cargo xtask emu-compare --compare a.json b.json";

/// A JSON number the way JavaScript prints it: whole values without `.0`, and NaN as `null`.
pub(crate) fn num(value: f64) -> Value {
    if !value.is_finite() {
        Value::Null
    } else if value.fract() == 0.0 && value.abs() < 1e15 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

/// The ordinary median (mean of the two middle values for an even count), over the finite values.
/// `None` when there are none, which the JSON records as `null`.
pub(crate) fn median(values: &[f64]) -> Option<f64> {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| x.is_finite()).collect();
    v.sort_by(f64::total_cmp);
    let m = v.len() / 2;
    match v.len() {
        0 => None,
        n if n % 2 == 1 => Some(v[m]),
        _ => Some((v[m - 1] + v[m]) / 2.0),
    }
}

/// The digits after `prefix` (`TotalTime: ` in `am start -W` output), or NaN when absent.
pub(crate) fn number_after(text: &str, prefix: &str) -> f64 {
    let Some(at) = text.find(prefix) else { return f64::NAN };
    let digits: String = text[at + prefix.len()..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    digits.parse().unwrap_or(f64::NAN)
}

/// The numbers `dumpsys gfxinfo` reports for a window's frames.
#[derive(Debug, PartialEq)]
pub(crate) struct Gfx {
    pub frames: f64,
    pub janky_pct: f64,
    pub p50: f64,
    pub p90: f64,
    pub p99: f64,
}

pub(crate) fn parse_gfxinfo(text: &str) -> Gfx {
    // "Janky frames: 12 (3.45%)": the percentage sits after the count and a parenthesis.
    let janky = text.find("Janky frames: ").map_or(f64::NAN, |at| {
        let rest = &text[at + "Janky frames: ".len()..];
        rest.split_once('(').map_or(f64::NAN, |(_, after)| number_after(after, ""))
    });
    Gfx {
        frames: number_after(text, "Total frames rendered: "),
        janky_pct: janky,
        p50: number_after(text, "50th percentile: "),
        p90: number_after(text, "90th percentile: "),
        p99: number_after(text, "99th percentile: "),
    }
}

/// What open-emulator's screenshot fallback can reach at this screencap cost, in frames per
/// second. Only meaningful for open-emulator: LDPlayer draws its own window and never uses
/// screencap. The fallback ticks every 250 ms and skips ticks while a capture is in flight, so it
/// can reach at most 4 FPS. (The app's own display streams over gRPC; this is only its fallback.)
pub(crate) fn mirror_fps(png_median_ms: f64) -> f64 {
    ((1000.0 / ((png_median_ms / 250.0).ceil() * 250.0)) * 100.0).round() / 100.0
}

/// The comparison table for two result files. Lower is better except `*_fps` and `*_mb_s`.
pub(crate) fn compare_table(a: &Value, b: &Value) -> Vec<String> {
    let summary = |v: &Value| v["summary"].as_object().cloned().unwrap_or_default();
    let (sa, sb) = (summary(a), summary(b));
    let mut keys: Vec<&String> = sa.keys().collect();
    keys.extend(sb.keys().filter(|k| !sa.contains_key(*k)));
    let width = keys.iter().map(|k| k.len()).max().unwrap_or(0);
    let (la, lb) = (a["label"].as_str().unwrap_or("a"), b["label"].as_str().unwrap_or("b"));
    let cell = |m: &Map<String, Value>, k: &str| match m.get(k).and_then(Value::as_f64) {
        Some(x) => x.to_string(),
        None => "-".to_owned(),
    };
    let mut lines = vec![format!("{:<width$}  {la:>14}  {lb:>14}  ratio({lb}/{la})", "metric")];
    for k in keys {
        let r = match (sa.get(k).and_then(Value::as_f64), sb.get(k).and_then(Value::as_f64)) {
            (Some(x), Some(y)) if x > 0.0 => format!("{:.2}x", y / x),
            _ => String::new(),
        };
        lines.push(format!("{k:<width$}  {:>14}  {:>14}  {r}", cell(&sa, k), cell(&sb, k)));
    }
    lines.push("\nAll times in ms (lower is better) except *_fps and *_mb_s (higher is better).".to_owned());
    lines.push("oe_mirror_fps_* only describe open-emulator's screen mirror; LDPlayer renders its own window.".to_owned());
    lines
}

fn read_result(path: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))
}

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("--compare") {
        let [a, b] = [args.get(1), args.get(2)].map(|f| f.ok_or("--compare needs two result files"));
        let (a, b) = (read_result(a?)?, read_result(b?)?);
        for line in compare_table(&a, &b) {
            println!("{line}");
        }
        return Ok(());
    }
    let p = parse_args(args, &["adb", "serial", "label", "trials", "apk", "component", "out"], &["help"])?;
    let Some(serial) = p.str("serial").map(str::to_owned).filter(|_| !p.flag("help")) else {
        println!("{USAGE}");
        return if p.flag("help") { Ok(()) } else { Err("--serial is required".to_owned()) };
    };
    let label = p.str("label").unwrap_or(&serial).to_owned();
    let trials: usize = p.int("trials", 3)?;
    let component = p.str("component").unwrap_or("io.appium.android.apis/.ApiDemos");
    let adb = AdbCli { binary: PathBuf::from(p.str("adb").unwrap_or("adb")), serial: serial.clone() };
    let mut suite = Suite { adb, raw: Map::new(), summary: Map::new() };
    let when = {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        format!("{}.{:03}Z", utc_stamp(now.as_secs()).trim_end_matches('Z'), now.subsec_millis())
    };

    println!("== {label} ({serial}) ==");
    let mut facts = Map::new();
    for prop in ["ro.build.version.release", "ro.build.version.sdk", "ro.product.model", "ro.product.cpu.abi"] {
        facts.insert(prop.to_owned(), Value::String(suite.sh(&format!("getprop {prop}")).text().trim().to_owned()));
    }
    facts.insert("nproc".to_owned(), Value::String(suite.sh("nproc").text().trim().to_owned()));
    let mem: String = suite.sh("grep MemTotal /proc/meminfo").text().chars().skip_while(|c| !c.is_ascii_digit()).take_while(char::is_ascii_digit).collect();
    facts.insert("memTotal".to_owned(), Value::String(format!("{mem} kB")));
    println!("{}", serde_json::to_string(&facts).unwrap_or_default());

    // adb itself costs something per call; everything below includes it, as the desktop app pays it too.
    let overhead: Vec<f64> = (0..5).map(|_| suite.sh("true").ms as f64).collect();
    println!("adb round trip: {} ms", join(&overhead));
    suite.put("adb_roundtrip_ms", &overhead);

    let mut components = vec!["com.android.settings/.Settings".to_owned()];
    if let Some(apk) = p.str("apk") {
        let package = component.split('/').next().unwrap_or(component);
        let size = std::fs::metadata(apk).map_err(|e| format!("{apk}: {e}"))?.len();
        let name = Path::new(apk).file_name().map_or_else(|| apk.to_owned(), |n| n.to_string_lossy().into_owned());
        let mut times = Vec::new();
        for i in 1..=trials {
            suite.adb_run(&["uninstall", package], None);
            let r = suite.adb_run(&["install", "-r", "-g", "-d", apk], Some(Duration::from_secs(600)));
            times.push(if r.ok() && r.text().contains("Success") { r.ms as f64 } else { f64::NAN });
            let err = if r.ok() { String::new() } else { String::from_utf8_lossy(&r.stderr).trim().to_owned() };
            println!("install {name} ({:.1} MB) #{i}: {} ms {err}", size as f64 / 1e6, r.ms);
        }
        suite.put("apk_install_ms", &times);
        components.push(component.to_owned());
    }

    for comp in &components {
        let pkg = comp.split('/').next().unwrap_or(comp);
        let short = pkg.rsplit('.').next().unwrap_or(pkg);
        let (mut cold, mut cold_wall, mut hot) = (Vec::new(), Vec::new(), Vec::new());
        for i in 1..=trials {
            suite.sh(&format!("am force-stop {pkg}"));
            sleep(1000);
            let r = suite.sh(&format!("am start -W -S -n {comp}"));
            cold.push(number_after(&r.text(), "TotalTime: "));
            cold_wall.push(r.ms as f64);
            sleep(2000);
            suite.sh("input keyevent KEYCODE_HOME");
            sleep(2000);
            hot.push(number_after(&suite.sh(&format!("am start -W -n {comp}")).text(), "TotalTime: "));
            println!("launch {comp} #{i}: cold {} ms (wall {}), hot {} ms", cold[i - 1], cold_wall[i - 1], hot[i - 1]);
            sleep(1000);
        }
        suite.put(&format!("launch_cold_{short}_ms"), &cold);
        suite.put(&format!("launch_cold_wall_{short}_ms"), &cold_wall);
        suite.put(&format!("launch_hot_{short}_ms"), &hot);
        suite.sh("input keyevent KEYCODE_HOME");
    }

    // The desktop app's Apps tab launches through monkey, which starts its own JVM first.
    let mut monkey = Vec::new();
    for _ in 0..trials {
        suite.sh("am force-stop com.android.settings");
        suite.sh("input keyevent KEYCODE_HOME");
        sleep(1500);
        monkey.push(suite.sh("monkey -p com.android.settings -c android.intent.category.LAUNCHER 1").ms as f64);
    }
    suite.put("launch_via_monkey_settings_ms", &monkey);
    println!("monkey launch: {} ms", join(&monkey));

    let tap: Vec<f64> = (0..8).map(|_| suite.sh("input tap 5 5").ms as f64).collect();
    let key: Vec<f64> = (0..8).map(|_| suite.sh("input keyevent KEYCODE_UNKNOWN").ms as f64).collect();
    suite.put("input_tap_ms", &tap);
    suite.put("input_keyevent_ms", &key);
    println!("input tap: {} ms; keyevent: {} ms", join(&tap), join(&key));

    suite.sh("am start -W -n com.android.settings/.Settings");
    sleep(2000);
    let (mut png, mut png_bytes) = (Vec::new(), 0);
    for _ in 0..10 {
        let r = suite.adb_run(&["exec-out", "screencap", "-p"], None);
        png.push(r.ms as f64);
        png_bytes = r.stdout.len();
    }
    let raw: Vec<f64> = (0..5).map(|_| suite.adb_run(&["exec-out", "screencap"], None).ms as f64).collect();
    suite.put("screencap_png_ms", &png);
    suite.put("screencap_raw_ms", &raw);
    suite.summary.insert("oe_mirror_fps_native".to_owned(), num(mirror_fps(median(&png).unwrap_or(f64::NAN))));
    println!("screencap -p: {} ms ({png_bytes} B); raw: {} ms", join(&png), join(&raw));

    suite.sh("dumpsys gfxinfo com.android.settings reset");
    for _ in 0..5 {
        suite.sh("input swipe 300 900 300 300 300");
        sleep(700);
        suite.sh("input swipe 300 300 300 900 300");
        sleep(700);
    }
    let gfx = parse_gfxinfo(&suite.sh("dumpsys gfxinfo com.android.settings").text());
    for (key, value) in [
        ("ui_frames", gfx.frames),
        ("ui_janky_pct", gfx.janky_pct),
        ("ui_frame_p50_ms", gfx.p50),
        ("ui_frame_p90_ms", gfx.p90),
        ("ui_frame_p99_ms", gfx.p99),
    ] {
        suite.summary.insert(key.to_owned(), num(value));
    }
    println!("UI: {} frames, {}% janky, p50 {} ms, p90 {} ms", gfx.frames, gfx.janky_pct, gfx.p50, gfx.p90);
    suite.sh("input keyevent KEYCODE_HOME");

    // CPU and storage with tools every Android build has (toybox), so no binary needs pushing.
    let (mut hash, mut wr, mut rd) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..trials {
        hash.push(suite.sh("dd if=/dev/zero bs=1048576 count=128 2>/dev/null | md5sum >/dev/null").ms as f64);
        wr.push(suite.sh("dd if=/dev/zero of=/data/local/tmp/emu-compare.bin bs=1048576 count=256 2>/dev/null; sync").ms as f64);
        rd.push(suite.sh("dd if=/data/local/tmp/emu-compare.bin of=/dev/null bs=1048576 2>/dev/null").ms as f64);
        suite.sh("rm -f /data/local/tmp/emu-compare.bin");
    }
    suite.put("cpu_md5_128MiB_ms", &hash);
    suite.put("disk_write_256MiB_ms", &wr);
    suite.put("disk_read_256MiB_cached_ms", &rd);
    let write_mb_s = median(&wr).map_or(f64::NAN, |ms| ((256.0 / (ms / 1000.0)) * 10.0).round() / 10.0);
    suite.summary.insert("disk_write_mb_s".to_owned(), num(write_mb_s));
    println!("md5 128 MiB: {} ms; write 256 MiB: {} ms; read: {} ms", join(&hash), join(&wr), join(&rd));

    let mut result = Map::new();
    result.insert("label".to_owned(), Value::String(label.clone()));
    result.insert("serial".to_owned(), Value::String(serial));
    result.insert("when".to_owned(), Value::String(when));
    result.insert("facts".to_owned(), Value::Object(facts));
    result.insert("raw".to_owned(), Value::Object(suite.raw));
    result.insert("summary".to_owned(), Value::Object(suite.summary.clone()));
    let file = p.str("out").map_or_else(|| format!("{label}.json"), str::to_owned);
    std::fs::write(&file, serde_json::to_string_pretty(&Value::Object(result)).map_err(|e| e.to_string())?)
        .map_err(|e| format!("{file}: {e}"))?;
    println!("\nsummary (medians):");
    for (k, v) in &suite.summary {
        let shown = if v.is_null() { "null".to_owned() } else { v.to_string() };
        println!("  {k:<34} {shown}");
    }
    println!("\nwrote {file}");
    Ok(())
}

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

fn join(values: &[f64]) -> String {
    values.iter().map(|v| if v.is_nan() { "NaN".to_owned() } else { v.to_string() }).collect::<Vec<_>>().join(" ")
}

/// The adb connection and the results gathered so far.
struct Suite {
    adb: AdbCli,
    raw: Map<String, Value>,
    summary: Map<String, Value>,
}

impl Suite {
    /// `adb -s <serial> <args>` with its output and wall time. A failure is data here, not an error.
    fn adb_run(&self, args: &[&str], timeout: Option<Duration>) -> Captured {
        self.adb.run(args, timeout.unwrap_or(Duration::from_secs(300)))
    }

    fn sh(&self, command: &str) -> Captured {
        self.adb_run(&["shell", command], None)
    }

    /// Records every trial under `raw` and its median under `summary`.
    fn put(&mut self, key: &str, values: &[f64]) {
        self.raw.insert(key.to_owned(), Value::Array(values.iter().map(|v| num(*v)).collect()));
        self.summary.insert(key.to_owned(), median(values).map_or(Value::Null, num));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_median_averages_the_middle_pair_and_skips_failed_trials() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(&[4.0, 1.0, 2.0, f64::NAN, 3.0]), Some(2.5));
        assert_eq!(median(&[f64::NAN]), None);
    }

    #[test]
    fn numbers_serialise_the_way_javascript_prints_them() {
        assert_eq!(num(12.0).to_string(), "12");
        assert_eq!(num(12.5).to_string(), "12.5");
        assert_eq!(num(f64::NAN), Value::Null);
    }

    #[test]
    fn am_start_total_time_is_read_and_a_missing_one_is_nan() {
        let out = "Starting: Intent\nStatus: ok\nTotalTime: 743\nWaitTime: 760\n";
        assert_eq!(number_after(out, "TotalTime: "), 743.0);
        assert!(number_after("Error: no activity", "TotalTime: ").is_nan());
    }

    #[test]
    fn gfxinfo_yields_frames_jank_and_percentiles() {
        let dump = "Total frames rendered: 240\nJanky frames: 12 (5.00%)\n50th percentile: 9ms\n90th percentile: 17ms\n95th percentile: 21ms\n99th percentile: 40ms\n";
        assert_eq!(parse_gfxinfo(dump), Gfx { frames: 240.0, janky_pct: 5.0, p50: 9.0, p90: 17.0, p99: 40.0 });
        assert!(parse_gfxinfo("nothing").frames.is_nan());
    }

    #[test]
    fn the_mirror_estimate_matches_the_fallbacks_pacing() {
        // A capture waits for the next 250 ms tick.
        assert_eq!(mirror_fps(100.0), 4.0);
        assert_eq!(mirror_fps(300.0), 2.0);
    }

    #[test]
    fn the_comparison_lists_every_metric_with_the_second_over_the_first() {
        let a = json!({"label": "ldplayer", "summary": {"input_tap_ms": 100, "only_a": 5, "gone": null}});
        let b = json!({"label": "open-emulator", "summary": {"input_tap_ms": 150, "only_b": 7}});
        let table = compare_table(&a, &b);
        assert!(table[0].starts_with("metric") && table[0].ends_with("ratio(open-emulator/ldplayer)"), "{}", table[0]);
        assert!(table[1].starts_with("input_tap_ms") && table[1].ends_with("1.50x"), "{}", table[1]);
        assert!(table.iter().any(|l| l.starts_with("only_a") && l.contains('-') && !l.contains('x')));
        assert!(table.iter().any(|l| l.starts_with("only_b")));
        assert_eq!(table.iter().filter(|l| l.contains("lower is better")).count(), 1);
    }

    #[test]
    fn compare_needs_two_files_and_run_needs_a_serial() {
        assert!(run(&["--compare".to_owned(), "only-one.json".to_owned()]).is_err());
        assert!(run(&[]).is_err());
    }
}
