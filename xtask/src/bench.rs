//! `cargo xtask bench`, `emu-compare` and `start-game-avd`: the timing scripts, in Rust.
//!
//! These replace `bench_paired.ps1`, `bench_ldplayer.ps1`, `emu-compare.mjs` and
//! `start_game_avd.ps1`. They drive a real emulator, so everything that can be checked without
//! one (argument parsing, statistics, the command lines and CSV rows built) is a plain function
//! with a test, and the code that waits on a guest is kept thin around them.
//!
//! The scripts shelled out to adb and ldconsole as blocking child processes, so this does too:
//! one timeout-guarded [`run_capture`] is the only place a process is started and waited on.

mod avd;
mod compare;

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use oe_engine::acceleration::detect_acceleration;
use oe_engine::env_file::{load_device, load_profile};
use oe_engine::host::{tune_for_host, HostFacts, TuningOverrides};
use oe_engine::layout::{native_root, SdkLayout};
use oe_engine::sdk::avd_config::{emulator_args, EmulatorArgsInput};

const BENCH_USAGE: &str = "\
cargo xtask bench paired   [--rounds 3] [--mode cold|snapshot] [--profile fast] [--device generic]
                           [--ld-path C:\\LDPlayer\\LDPlayer9] [--timeout 300] [--root DIR]
                           [--cores N] [--ram-mb N]
cargo xtask bench ldplayer [--trials 5] [--label ldplayer-default] [--index 0]
                           [--ld-path C:\\LDPlayer\\LDPlayer9] [--csv android/logs/bench.csv] [--timeout 300]";

pub fn bench(args: &[String]) -> Result<(), String> {
    match args.split_first() {
        Some((sub, rest)) if sub == "paired" => paired(rest),
        Some((sub, rest)) if sub == "ldplayer" => ldplayer(rest),
        Some((sub, _)) if matches!(sub.as_str(), "help" | "--help" | "-h") => {
            println!("{BENCH_USAGE}");
            Ok(())
        }
        Some((sub, _)) => Err(format!("unknown bench subcommand `{sub}`\n\n{BENCH_USAGE}")),
        None => Err(format!("bench needs a subcommand\n\n{BENCH_USAGE}")),
    }
}

pub fn emu_compare(args: &[String]) -> Result<(), String> {
    compare::run(args)
}

pub fn start_game_avd(args: &[String]) -> Result<(), String> {
    avd::run(args)
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

/// Parsed `--name value` / `--name=value` options, `--flag` switches and bare words.
#[derive(Debug, Default)]
pub(crate) struct Parsed {
    values: HashMap<String, String>,
    flags: HashSet<String>,
    pub positional: Vec<String>,
}

impl Parsed {
    pub fn str(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    pub fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }

    /// A whole number, or `default` when the option is absent. A present but non-numeric value
    /// fails: silently running 3 rounds when someone typed `--rounds=three` hides the typo.
    pub fn int<T: std::str::FromStr>(&self, name: &str, default: T) -> Result<T, String> {
        match self.str(name) {
            None => Ok(default),
            Some(raw) => raw.trim().parse().map_err(|_| format!("--{name} needs a whole number, not `{raw}`")),
        }
    }
}

/// Splits `args` into the options each command declares. Unknown options are errors so a typo
/// cannot turn into a default.
pub(crate) fn parse_args(args: &[String], values: &[&str], flags: &[&str]) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let Some(name) = arg.strip_prefix("--") else {
            parsed.positional.push(arg.clone());
            continue;
        };
        let (name, inline) = match name.split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (name, None),
        };
        if flags.contains(&name) {
            parsed.flags.insert(name.to_owned());
        } else if values.contains(&name) {
            let value = match inline {
                Some(value) => value,
                None => iter.next().cloned().ok_or_else(|| format!("--{name} needs a value"))?,
            };
            parsed.values.insert(name.to_owned(), value);
        } else {
            return Err(format!("unknown option --{name}"));
        }
    }
    Ok(parsed)
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

/// What a finished (or killed) child left behind.
#[derive(Debug, Default)]
pub(crate) struct Captured {
    /// `None` when it could not start, timed out, or was killed.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub ms: u64,
}

impl Captured {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// stdout as text. Bytes map one to one (latin-1), so a binary payload such as a PNG keeps
    /// its length and text matching never fails on invalid UTF-8.
    pub fn text(&self) -> String {
        self.stdout.iter().map(|&b| b as char).filter(|&c| c != '\r').collect()
    }
}

#[cfg(windows)]
pub(crate) fn no_window(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000)
}

#[cfg(not(windows))]
pub(crate) fn no_window(command: &mut Command) -> &mut Command {
    command
}

/// Runs a program to completion or `timeout`, whichever comes first, and never fails: a command
/// that cannot start or hangs is data for a benchmark (an empty answer), not a reason to stop.
///
/// Output is drained on threads so a chatty child cannot fill its pipe, and waited for only
/// briefly after the child exits: `adb` starts a server that inherits the pipes, and waiting for
/// that to close them would hang forever.
pub(crate) fn run_capture(program: impl AsRef<OsStr>, args: &[String], timeout: Duration) -> Captured {
    let started = Instant::now();
    let mut command = Command::new(program.as_ref());
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Captured { stderr: error.to_string().into_bytes(), ms: started.elapsed().as_millis() as u64, ..Captured::default() };
        }
    };
    fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            let _ = sender.send(bytes);
        });
        receiver
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let ms = started.elapsed().as_millis() as u64;
    let grace = Duration::from_secs(2);
    Captured {
        code,
        stdout: out.recv_timeout(grace).unwrap_or_default(),
        stderr: err.recv_timeout(grace).unwrap_or_default(),
        ms,
    }
}

/// An adb binary and what to call on it.
#[derive(Clone)]
pub(crate) struct AdbCli {
    pub binary: PathBuf,
    pub serial: String,
}

impl AdbCli {
    pub fn run(&self, args: &[&str], timeout: Duration) -> Captured {
        let mut argv = vec!["-s".to_owned(), self.serial.clone()];
        argv.extend(args.iter().map(|a| (*a).to_owned()));
        run_capture(&self.binary, &argv, timeout)
    }

    pub fn shell(&self, command: &str, timeout: Duration) -> Captured {
        self.run(&["shell", command], timeout)
    }

    /// Server-level commands that take no serial (`connect`, `kill-server`).
    pub fn global(&self, args: &[&str]) -> Captured {
        let argv: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        run_capture(&self.binary, &argv, Duration::from_secs(30))
    }
}

const ADB_QUICK: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------------------------
// Statistics and formatting
// ---------------------------------------------------------------------------------------------

pub(crate) fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// The scripts' `Median`: the element at `floor(n / 2)` of the sorted values, so an even count
/// gives the upper of the two middle values rather than their mean. Kept because the numbers in
/// older benchmark notes were produced this way.
pub(crate) fn upper_median(values: &[Option<f64>]) -> Option<f64> {
    let mut v: Vec<f64> = values.iter().flatten().copied().collect();
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied()
}

/// Per-round ratio, empty when either side did not finish (the script's `Ratio`).
pub(crate) fn ratio(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) if a != 0.0 && b != 0.0 => Some(round2(a / b)),
        _ => None,
    }
}

fn show(value: Option<f64>) -> String {
    value.map_or_else(String::new, |v| v.to_string())
}

// ---------------------------------------------------------------------------------------------
// Boot measurement, shared by LDPlayer and the native emulator
// ---------------------------------------------------------------------------------------------

/// The two events every benchmark here is timed to, in seconds from the launch.
///
/// `boot` is `sys.boot_completed == 1` with `pm path android` answering; `usable` is the
/// launcher window holding focus. They are the definitions `bench_ldplayer.ps1` and the app share.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Trial {
    pub boot: Option<f64>,
    pub usable: Option<f64>,
}

/// True when a `dumpsys window` line says some window has focus.
pub(crate) fn has_focus(dumpsys: &str) -> bool {
    dumpsys.lines().find(|line| line.contains("mCurrentFocus")).is_some_and(|line| !line.contains("null"))
}

/// Polls `adb` every 250 ms until both events happened or `timeout` passed. `connect` is for
/// LDPlayer, which has to be told to attach to its TCP port; the emulator registers itself.
pub(crate) fn poll_events(adb: &AdbCli, connect: bool, started: Instant, timeout: Duration) -> Trial {
    let mut trial = Trial::default();
    while started.elapsed() < timeout {
        if trial.boot.is_none() {
            if connect {
                adb.global(&["connect", &adb.serial]);
            }
            let boot = adb.shell("getprop sys.boot_completed", ADB_QUICK);
            if boot.text().trim() == "1" && adb.shell("pm path android", ADB_QUICK).ok() {
                trial.boot = Some(round2(started.elapsed().as_secs_f64()));
            }
        } else if has_focus(&adb.shell("dumpsys window", ADB_QUICK).text()) {
            trial.usable = Some(round2(started.elapsed().as_secs_f64()));
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    trial
}

// ---------------------------------------------------------------------------------------------
// LDPlayer
// ---------------------------------------------------------------------------------------------

/// LDPlayer's adb listens on 5555 for instance 0, then two further per instance.
pub(crate) fn ld_serial(index: u32) -> String {
    format!("127.0.0.1:{}", 5555 + index * 2)
}

/// The "android started" field of `ldconsole list2`'s first line (`index,name,..,started,..`).
pub(crate) fn ld_started(list2: &str) -> Option<String> {
    list2.lines().next()?.split(',').nth(4).map(|field| field.trim().to_owned())
}

struct LdPlayer {
    console: PathBuf,
    adb: AdbCli,
    index: u32,
}

impl LdPlayer {
    fn new(ld_path: &str, index: u32) -> Result<LdPlayer, String> {
        let console = Path::new(ld_path).join("ldconsole.exe");
        let adb = Path::new(ld_path).join("adb.exe");
        for exe in [&console, &adb] {
            if !exe.exists() {
                return Err(format!("Not found: {}  (use --ld-path to point at your LDPlayer install)", exe.display()));
            }
        }
        Ok(LdPlayer { console, adb: AdbCli { binary: adb, serial: ld_serial(index) }, index })
    }

    fn console(&self, args: &[&str]) -> Captured {
        let mut argv: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        argv.extend(["--index".to_owned(), self.index.to_string()]);
        run_capture(&self.console, &argv, Duration::from_secs(60))
    }

    /// `quit` returns immediately; wait for the VM to go away or the next trial starts against a
    /// still-shutting-down instance and its timing means nothing.
    fn stop(&self) {
        self.console(&["quit"]);
        for _ in 0..60 {
            let list = run_capture(&self.console, &["list2".to_owned()], Duration::from_secs(30)).text();
            if ld_started(&list).as_deref().is_none_or(|started| started == "0") {
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    fn measure(&self, timeout: Duration, settle: Duration) -> Trial {
        self.stop();
        self.adb.global(&["kill-server"]);
        std::thread::sleep(settle);
        let started = Instant::now();
        self.console(&["launch"]);
        poll_events(&self.adb, true, started, timeout)
    }
}

/// The CSV bench.sh also appends to; the column order is shared.
const CSV_HEADER: &str = "timestamp,label,mode,trial,t1_boot_s,t2_usable_s,t3_frame_s,note";

/// One LDPlayer row. t3 stays empty (no mirror hop to time) and so does bench.sh's note column.
/// Numbers are formatted with Rust's locale-free `Display`, never a regional decimal comma.
pub(crate) fn csv_row(stamp: &str, label: &str, trial: u32, result: Trial) -> String {
    format!("{stamp},{label},ldplayer,{trial},{},{},,", show(result.boot), show(result.usable))
}

/// `yyyy-MM-ddTHH:mm:ssZ` for a Unix time, without a date library.
pub(crate) fn utc_stamp(unix: u64) -> String {
    let (days, secs) = ((unix / 86_400) as i64, unix % 86_400);
    // Howard Hinnant's days-to-civil conversion.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// Appends `row` to the CSV, creating it, and widening a header written before the note column
/// existed so new rows line up with it.
fn append_csv(path: &Path, row: &str) -> Result<(), String> {
    let io = |e: std::io::Error| format!("{}: {e}", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io)?;
    }
    let mut text = match std::fs::read_to_string(path) {
        Ok(text) if !text.is_empty() => text,
        _ => format!("{CSV_HEADER}\n"),
    };
    let first_end = text.find('\n').unwrap_or(text.len());
    if text[..first_end].trim_end().ends_with(",t3_frame_s") {
        text.replace_range(..first_end, CSV_HEADER);
    }
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(row);
    text.push('\n');
    std::fs::write(path, text).map_err(io)
}

pub(crate) fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

fn ldplayer(args: &[String]) -> Result<(), String> {
    let p = parse_args(args, &["trials", "label", "index", "ld-path", "csv", "timeout"], &["help"])?;
    if p.flag("help") {
        println!("{BENCH_USAGE}");
        return Ok(());
    }
    let trials: u32 = p.int("trials", 5)?;
    let index: u32 = p.int("index", 0)?;
    let timeout = Duration::from_secs(p.int("timeout", 300)?);
    let label = p.str("label").unwrap_or("ldplayer-default");
    let csv = p.str("csv").map_or_else(|| repo_root().join("android/logs/bench.csv"), PathBuf::from);
    let ld = LdPlayer::new(p.str("ld-path").unwrap_or(r"C:\LDPlayer\LDPlayer9"), index)?;

    println!("LDPlayer benchmark - {trials} trial(s), instance {index}, serial {}\n", ld.adb.serial);
    let mut results = Vec::new();
    for trial in 1..=trials {
        print!("trial {trial}/{trials}: ");
        let result = ld.measure(timeout, Duration::from_secs(3));
        match result.boot {
            Some(boot) => println!("boot={boot}s usable={}", result.usable.map_or("timeout".to_owned(), |u| format!("{u}s"))),
            None => println!("TIMEOUT - no boot_completed"),
        }
        if result.boot.is_some() {
            results.push(result);
        }
        let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        append_csv(&csv, &csv_row(&utc_stamp(unix), label, trial, result))?;
    }
    ld.stop();

    let boots: Vec<_> = results.iter().map(|r| r.boot).collect();
    let usables: Vec<_> = results.iter().map(|r| r.usable).collect();
    println!("\nmedian boot:   {}s", show(upper_median(&boots)));
    println!("median usable: {}s", show(upper_median(&usables)));
    println!("appended to {}", csv.display());
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Paired: LDPlayer against the native open-emulator, alternating
// ---------------------------------------------------------------------------------------------

/// One round of the paired benchmark.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Round {
    pub ld: Trial,
    pub oe: Trial,
}

impl Round {
    fn boot_ratio(&self) -> Option<f64> {
        ratio(self.ld.boot, self.oe.boot)
    }

    fn usable_ratio(&self) -> Option<f64> {
        ratio(self.ld.usable, self.oe.usable)
    }
}

pub(crate) fn round_lines(n: u32, round: &Round) -> [String; 2] {
    [
        format!(
            "round {n}: boot   LDPlayer={:>6}s  open-emulator={:>6}s  ratio={}x",
            show(round.ld.boot),
            show(round.oe.boot),
            show(round.boot_ratio())
        ),
        format!(
            "         usable LDPlayer={:>6}s  open-emulator={:>6}s  ratio={}x",
            show(round.ld.usable),
            show(round.oe.usable),
            show(round.usable_ratio())
        ),
    ]
}

/// The closing lines. The median of the per-round ratios is the number to quote, not the ratio of
/// the medians: host throttling drifts between rounds but hits both sides of one round alike.
pub(crate) fn summary_lines(rounds: &[Round]) -> [String; 3] {
    let med = |f: fn(&Round) -> Option<f64>| show(upper_median(&rounds.iter().map(f).collect::<Vec<_>>()));
    [
        format!("median boot:   LDPlayer {}s, open-emulator {}s", med(|r| r.ld.boot), med(|r| r.oe.boot)),
        format!("median usable: LDPlayer {}s, open-emulator {}s", med(|r| r.ld.usable), med(|r| r.oe.usable)),
        format!(
            "median ratio:  boot {}x, usable {}x  (>1 means open-emulator is faster)",
            med(Round::boot_ratio),
            med(Round::usable_ratio)
        ),
    ]
}

/// The native emulator side: starts `emulator.exe` the way the app's engine does and tears it
/// down again after each trial.
struct NativeEmulator {
    emulator: PathBuf,
    adb: AdbCli,
    layout: SdkLayout,
    args: Vec<String>,
}

const NATIVE_PORT: u16 = 5554;

impl NativeEmulator {
    fn new(p: &Parsed, mode: &str) -> Result<NativeEmulator, String> {
        let layout = SdkLayout::new(native_root(p.str("root").map(Path::new)));
        for path in [&layout.emulator, &layout.adb] {
            if !path.exists() {
                return Err(format!("missing: {} (download Android in the app first, or pass --root)", path.display()));
            }
        }
        let android = repo_root().join("android");
        let profile = load_profile(&android, p.str("profile").unwrap_or("fast")).map_err(|e| e.to_string())?;
        let device = load_device(&android, p.str("device").unwrap_or("generic")).map_err(|e| e.to_string())?;
        let accelerated = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?.block_on(detect_acceleration()).available;
        // Headless, like the old ANDROID_HEADLESS=1 run, so LDPlayer's own window is the only
        // window in the comparison. Installed RAM is not probed here; 8 GiB picks the same 3072 MB
        // guest as any machine above the app's floor, and `--ram-mb` overrides it.
        let facts = HostFacts {
            cpus: std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
            total_ram_mb: 8192,
            accelerated,
            has_window: false,
        };
        let number = |name: &str| -> Result<Option<f64>, String> {
            p.str(name).map(|v| v.trim().parse().map_err(|_| format!("--{name} needs a number, not `{v}`"))).transpose()
        };
        let overrides = TuningOverrides { cores: number("cores")?, ram_mb: number("ram-mb")?, ..TuningOverrides::default() };
        let tuning = tune_for_host(&facts, overrides);
        let mut args = emulator_args(&EmulatorArgsInput {
            avd_name: &profile.avd_name,
            tuning: &tuning,
            device: &device,
            use_snapshot: (mode == "snapshot").then_some("default_boot"),
            headless: true,
            writable_system: false,
        });
        args.extend(["-port".to_owned(), NATIVE_PORT.to_string()]);
        Ok(NativeEmulator {
            emulator: layout.emulator.clone(),
            adb: AdbCli { binary: layout.adb.clone(), serial: format!("emulator-{NATIVE_PORT}") },
            layout,
            args,
        })
    }

    fn spawn(&self) -> Result<Child, String> {
        let mut command = Command::new(&self.emulator);
        command
            .args(&self.args)
            .env("ANDROID_SDK_ROOT", &self.layout.sdk_root)
            .env("ANDROID_HOME", &self.layout.sdk_root)
            .env("ANDROID_AVD_HOME", &self.layout.avd_home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        no_window(&mut command);
        command.spawn().map_err(|e| format!("could not start {}: {e}", self.emulator.display()))
    }

    /// Asks the emulator to exit cleanly (a snapshot-mode trial saves its snapshot that way), and
    /// kills it only if that does not work within a minute.
    fn stop(&self, child: Option<Child>) {
        self.adb.run(&["emu", "kill"], ADB_QUICK);
        if let Some(mut child) = child {
            let deadline = Instant::now() + Duration::from_secs(60);
            while child.try_wait().ok().flatten().is_none() {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }

    fn measure(&self, timeout: Duration) -> Result<Trial, String> {
        self.adb.global(&["start-server"]);
        let started = Instant::now();
        let child = self.spawn()?;
        let trial = poll_events(&self.adb, false, started, timeout);
        self.stop(Some(child));
        Ok(trial)
    }
}

fn paired(args: &[String]) -> Result<(), String> {
    let p = parse_args(args, &["rounds", "mode", "profile", "device", "ld-path", "timeout", "root", "cores", "ram-mb"], &["help"])?;
    if p.flag("help") {
        println!("{BENCH_USAGE}");
        return Ok(());
    }
    let rounds: u32 = p.int("rounds", 3)?;
    let mode = p.str("mode").unwrap_or("cold");
    if !matches!(mode, "cold" | "snapshot") {
        return Err(format!("--mode must be cold or snapshot, not `{mode}`"));
    }
    let timeout = Duration::from_secs(p.int("timeout", 300)?);
    let profile = p.str("profile").unwrap_or("fast");
    let ld = LdPlayer::new(p.str("ld-path").unwrap_or(r"C:\LDPlayer\LDPlayer9"), 0)?;
    let oe = NativeEmulator::new(&p, mode)?;

    println!("Paired benchmark - {rounds} round(s), mode={mode}, profile={profile}");
    println!("(alternating so host throttling affects both equally)\n");

    // Nothing from an earlier run may still be up under the first trial.
    oe.stop(None);
    let mut all = Vec::new();
    for n in 1..=rounds {
        let ld_trial = ld.measure(timeout, Duration::from_secs(5));
        ld.stop();
        std::thread::sleep(Duration::from_secs(5));
        let oe_trial = oe.measure(timeout)?;
        std::thread::sleep(Duration::from_secs(5));
        let round = Round { ld: ld_trial, oe: oe_trial };
        for line in round_lines(n, &round) {
            println!("{line}");
        }
        all.push(round);
    }
    println!();
    for line in summary_lines(&all) {
        println!("{line}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn options_parse_in_both_spellings_and_defaults_apply() {
        let p = parse_args(&strings(&["--rounds", "4", "--mode=snapshot", "--help", "word"]), &["rounds", "mode"], &["help"]).unwrap();
        assert_eq!(p.int("rounds", 3).unwrap(), 4);
        assert_eq!(p.str("mode"), Some("snapshot"));
        assert!(p.flag("help"));
        assert_eq!(p.positional, vec!["word"]);
        assert_eq!(p.int("timeout", 300).unwrap(), 300);
    }

    #[test]
    fn a_typo_or_a_bad_number_is_an_error_not_a_default() {
        assert!(parse_args(&strings(&["--roundz", "4"]), &["rounds"], &[]).is_err());
        assert!(parse_args(&strings(&["--rounds"]), &["rounds"], &[]).is_err());
        let p = parse_args(&strings(&["--rounds", "many"]), &["rounds"], &[]).unwrap();
        assert!(p.int::<u32>("rounds", 3).is_err());
    }

    #[test]
    fn the_median_is_the_upper_middle_value_and_ignores_missing_trials() {
        assert_eq!(upper_median(&[Some(3.0), None, Some(1.0), Some(2.0)]), Some(2.0));
        assert_eq!(upper_median(&[Some(4.0), Some(1.0), Some(2.0), Some(3.0)]), Some(3.0));
        assert_eq!(upper_median(&[None]), None);
    }

    #[test]
    fn ratios_are_rounded_and_need_both_sides() {
        assert_eq!(ratio(Some(30.0), Some(20.0)), Some(1.5));
        assert_eq!(ratio(Some(10.0), Some(3.0)), Some(3.33));
        assert_eq!(ratio(None, Some(1.0)), None);
        assert_eq!(ratio(Some(1.0), Some(0.0)), None);
    }

    #[test]
    fn focus_counts_only_when_the_window_is_not_null() {
        assert!(has_focus("  mCurrentFocus=Window{1a2b u0 com.android.launcher3/.Launcher}\n"));
        assert!(!has_focus("  mCurrentFocus=null\n"));
        assert!(!has_focus("nothing relevant"));
    }

    #[test]
    fn ldplayer_serials_step_by_two_per_instance() {
        assert_eq!(ld_serial(0), "127.0.0.1:5555");
        assert_eq!(ld_serial(2), "127.0.0.1:5559");
    }

    #[test]
    fn the_started_flag_is_the_fifth_field_of_the_first_list2_line() {
        assert_eq!(ld_started("0,LDPlayer,0,0,0,-1,-1,1080,1920,240\r\n").as_deref(), Some("0"));
        assert_eq!(ld_started("0,LDPlayer,1,2,1,123,456,1080,1920,240").as_deref(), Some("1"));
        assert_eq!(ld_started(""), None);
    }

    #[test]
    fn csv_rows_leave_the_frame_and_note_columns_empty_and_never_use_a_decimal_comma() {
        let row = csv_row("2026-01-02T03:04:05Z", "ldplayer-default", 2, Trial { boot: Some(31.25), usable: None });
        assert_eq!(row, "2026-01-02T03:04:05Z,ldplayer-default,ldplayer,2,31.25,,,");
        assert_eq!(row.split(',').count(), CSV_HEADER.split(',').count());
    }

    #[test]
    fn unix_time_formats_as_a_utc_stamp() {
        assert_eq!(utc_stamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_stamp(1_709_164_800 + 3661), "2024-02-29T01:01:01Z");
        assert_eq!(utc_stamp(1_798_761_599), "2026-12-31T23:59:59Z");
    }

    #[test]
    fn an_old_csv_header_is_widened_and_rows_are_appended() {
        let dir = std::env::temp_dir().join(format!("xtask-bench-csv-{}", std::process::id()));
        let file = dir.join("bench.csv");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, "timestamp,label,mode,trial,t1_boot_s,t2_usable_s,t3_frame_s\nold,row").unwrap();
        append_csv(&file, "new,row").unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text, format!("{CSV_HEADER}\nold,row\nnew,row\n"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_paired_report_prints_per_round_ratios_and_their_median() {
        let round = |ld: f64, oe: f64| Round {
            ld: Trial { boot: Some(ld), usable: Some(ld + 5.0) },
            oe: Trial { boot: Some(oe), usable: Some(oe + 5.0) },
        };
        let rounds = [round(30.0, 20.0), round(40.0, 20.0), round(60.0, 20.0)];
        let lines = round_lines(1, &rounds[0]);
        assert_eq!(lines[0], "round 1: boot   LDPlayer=    30s  open-emulator=    20s  ratio=1.5x");
        let summary = summary_lines(&rounds);
        assert_eq!(summary[0], "median boot:   LDPlayer 40s, open-emulator 20s");
        assert!(summary[2].starts_with("median ratio:  boot 2x, usable 1.8x"), "{}", summary[2]);
    }

    #[test]
    fn the_native_side_asks_for_a_cold_boot_or_a_quick_boot_restore() {
        let device = oe_engine::env_file::DeviceIdentity { name: "generic".into(), props: Vec::new(), lcd_width: None, lcd_height: None, lcd_density: None };
        let tuning = tune_for_host(&HostFacts { cpus: 8, total_ram_mb: 8192, accelerated: true, has_window: false }, TuningOverrides::default());
        let line = |snapshot: Option<&'static str>| {
            emulator_args(&EmulatorArgsInput { avd_name: "A", tuning: &tuning, device: &device, use_snapshot: snapshot, headless: true, writable_system: false })
        };
        assert!(line(None).contains(&"-no-snapshot-load".to_owned()));
        assert!(!line(Some("default_boot")).contains(&"-no-snapshot-load".to_owned()));
        assert!(line(None).contains(&"-no-window".to_owned()));
    }

    #[test]
    fn a_missing_program_is_an_empty_answer_not_a_panic() {
        let r = run_capture("definitely-not-a-real-program-xyz", &[], Duration::from_secs(2));
        assert!(!r.ok() && r.stdout.is_empty());
    }

    #[test]
    fn an_unknown_bench_subcommand_is_rejected() {
        assert!(bench(&strings(&["nope"])).is_err());
        assert!(bench(&[]).is_err());
    }
}
