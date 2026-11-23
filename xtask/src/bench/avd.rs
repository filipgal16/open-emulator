//! `cargo xtask start-game-avd`: starts a game AVD natively, the way the app's native engine does.
//!
//! Starts are Quick Boot starts: the emulator restores the snapshot it saved when it last exited
//! (about 8 s on the openemu-compat image against about 47 s cold). Close the emulator window or
//! `adb emu kill` rather than killing the process, so that snapshot is saved. `--cold` boots from
//! scratch and still saves a snapshot on exit.
//!
//! On a stock Google APIs image it then gives ARM apps a `/proc/cpuinfo` that lists every guest
//! core instead of one; without that, Unity games log "Cores = 1" and run with no job worker or
//! render threads. That takes `adb root`, so it works on userdebug images and not Play Store ones.
//! The openemu-compat ROM has it built into the image and the step is skipped.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use oe_engine::layout::{native_root, SdkLayout};

use super::{no_window, parse_args, AdbCli};

const USAGE: &str = "\
cargo xtask start-game-avd [--avd OpenEmulator_API34_compat] [--cold] [--root DIR] [--port 5554]
                           [--launch <package>] [--boot-timeout 400]";

/// The cpuinfo feature lists the two ARM translators read, in the order they are written.
const CPUINFO_VARIANTS: [(&str, &str); 2] = [
    ("cpuinfo.arm64.txt", "fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp"),
    ("cpuinfo.arm.txt", "neon vfp swp half thumb fastmult edsp vfpv3 vfpv4 idiva idivt"),
];

/// The emulator's command line for this script: host GPU, acceleration on, no snapshot flag at
/// all for a warm start.
///
/// No flag is what makes Quick Boot restore `default_boot`; `-snapshot <name>` is silently
/// ignored by this emulator (see `avd_config.rs`).
pub(crate) fn emulator_command(avd: &str, port: u16, cold: bool) -> Vec<String> {
    let mut args: Vec<String> = [
        "-avd", avd, "-port", &port.to_string(), "-gpu", "host", "-accel", "on", "-feature", "GLESDynamicVersion",
        "-no-boot-anim", "-no-metrics", "-netdelay", "none", "-netspeed", "full",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if cold {
        args.push("-no-snapshot-load".to_owned());
    }
    args
}

/// Quick Boot only restores a snapshot when the AVD's own config asks for a fast boot; an AVD
/// created with cold-boot settings would ignore the snapshot it saved. Only lines that already
/// exist are rewritten, as the script's regex did.
pub(crate) fn force_quick_boot(config: &str) -> String {
    config
        .split('\n')
        .map(|line| {
            if line.starts_with("fastboot.forceColdBoot=") {
                "fastboot.forceColdBoot=no"
            } else if line.starts_with("fastboot.forceFastBoot=") {
                "fastboot.forceFastBoot=yes"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A `/proc/cpuinfo` listing `cores` identical processors with the given feature string.
pub(crate) fn cpuinfo_text(cores: u32, features: &str) -> String {
    let mut text = String::new();
    for i in 0..cores {
        text.push_str(&format!("processor\t: {i}\nBogoMIPS\t: 1.00\nFeatures\t: {features}\n"));
        text.push_str("CPU implementer\t: 0x41\nCPU architecture: 8\nCPU variant\t: 0x6\nCPU part\t: 0x802\nCPU revision\t: 13\n\n");
    }
    text
}

/// What the ARM translator's cpuinfo says about the guest's cores.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ArmCpuinfo {
    /// The image already lists every core.
    Complete,
    /// No `cpuinfo.arm64.txt`, so no ARM translator to fix.
    Missing,
    NeedsFix,
}

pub(crate) fn classify_arm_cpuinfo(arm_cores: &str, guest_cores: u32) -> ArmCpuinfo {
    if arm_cores == guest_cores.to_string() {
        ArmCpuinfo::Complete
    } else if arm_cores.is_empty() {
        ArmCpuinfo::Missing
    } else {
        ArmCpuinfo::NeedsFix
    }
}

pub(crate) fn run(args: &[String]) -> Result<(), String> {
    let p = parse_args(args, &["avd", "root", "port", "launch", "boot-timeout"], &["cold", "help"])?;
    if p.flag("help") {
        println!("{USAGE}");
        return Ok(());
    }
    let avd = p.str("avd").unwrap_or("OpenEmulator_API34_compat");
    let port: u16 = p.int("port", 5554)?;
    let boot_timeout = Duration::from_secs(p.int("boot-timeout", 400)?);
    let layout = SdkLayout::new(native_root(
        p.str("root").or(std::env::var("OPEN_EMULATOR_DOWNLOAD_ROOT").ok().as_deref().filter(|v| !v.is_empty())).map(Path::new),
    ));
    let avd_dir = layout.avd_home.join(format!("{avd}.avd"));
    for path in [&layout.emulator, &layout.adb, &avd_dir] {
        if !path.exists() {
            return Err(format!("missing: {}", path.display()));
        }
    }
    std::fs::create_dir_all(&layout.logs).map_err(|e| format!("{}: {e}", layout.logs.display()))?;
    let adb = AdbCli { binary: layout.adb.clone(), serial: format!("emulator-{port}") };
    let ask = |args: &[&str]| String::from_utf8_lossy(&adb.run(args, Duration::from_secs(60)).stdout).replace('\r', "").trim().to_owned();
    let shell = |command: &str| ask(&["shell", command]);

    if shell("getprop sys.boot_completed") == "1" {
        println!("{avd} is already running");
    } else {
        let config_path = avd_dir.join("config.ini");
        let config = std::fs::read_to_string(&config_path).map_err(|e| format!("{}: {e}", config_path.display()))?;
        let wanted = force_quick_boot(&config);
        if wanted != config {
            std::fs::write(&config_path, wanted).map_err(|e| format!("{}: {e}", config_path.display()))?;
        }

        let has_snapshot = avd_dir.join("snapshots").join("default_boot").exists();
        let cold = p.flag("cold");
        println!("starting {avd} ({}) ...", if cold || !has_snapshot { "cold boot" } else { "Quick Boot snapshot" });
        let started = Instant::now();
        let log = |name: &str| {
            let path = layout.logs.join(format!("{avd}.{name}.log"));
            std::fs::File::create(&path).map_err(|e| format!("{}: {e}", path.display()))
        };
        let mut command = Command::new(&layout.emulator);
        command
            .args(emulator_command(avd, port, cold))
            .env("ANDROID_SDK_ROOT", &layout.sdk_root)
            .env("ANDROID_HOME", &layout.sdk_root)
            .env("ANDROID_AVD_HOME", &layout.avd_home)
            .stdin(Stdio::null())
            .stdout(log("out")?)
            .stderr(log("err")?);
        no_window(&mut command);
        let mut child = command.spawn().map_err(|e| format!("could not start {}: {e}", layout.emulator.display()))?;
        loop {
            if started.elapsed() >= boot_timeout {
                return Err(format!("Android did not finish booting within {} s", boot_timeout.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(500));
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!(
                    "emulator exited with code {}; see {}",
                    status.code().map_or("?".to_owned(), |c| c.to_string()),
                    layout.logs.join(format!("{avd}.out.log")).display()
                ));
            }
            if shell("getprop sys.boot_completed") == "1" {
                break;
            }
        }
        println!("booted in {:.1} s", started.elapsed().as_secs_f64());
    }

    // The openemu-compat ROM carries the cpuinfo fix in the image; only a stock Google image
    // needs it applied at run time, which takes root.
    let guest_cores: u32 = shell("nproc").parse().unwrap_or(0);
    let arm_cores = shell("grep -c ^processor /system/etc/cpuinfo.arm64.txt 2>/dev/null");
    match classify_arm_cpuinfo(&arm_cores, guest_cores) {
        ArmCpuinfo::Complete => println!("ARM apps see all {guest_cores} CPU cores (built into the image)"),
        ArmCpuinfo::Missing => println!("this image has no ARM translator; nothing to fix"),
        ArmCpuinfo::NeedsFix => {
            ask(&["root"]);
            std::thread::sleep(Duration::from_secs(2));
            ask(&["wait-for-device"]);
            if shell("id -u") != "0" {
                eprintln!("warning: adb root refused (Play Store image?): ARM apps will see a single CPU core.");
            } else {
                let cores: u32 = shell("nproc").parse().unwrap_or(guest_cores);
                let tmp = std::env::temp_dir().join(format!("open-emu-cpuinfo-{}", std::process::id()));
                std::fs::create_dir_all(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
                for (name, features) in CPUINFO_VARIANTS {
                    let local = tmp.join(name);
                    std::fs::write(&local, cpuinfo_text(cores, features)).map_err(|e| format!("{}: {e}", local.display()))?;
                    let remote = format!("/data/local/tmp/{name}");
                    ask(&["push", &local.to_string_lossy(), &remote]);
                    // Unmount a previous overlay first so re-running does not stack mounts.
                    shell(&format!(
                        "umount /system/etc/{name} 2>/dev/null; chmod 644 {remote} && chcon u:object_r:system_file:s0 {remote} && mount --bind {remote} /system/etc/{name}"
                    ));
                }
                let _ = std::fs::remove_dir_all(&tmp);
                let seen = shell("grep -c ^processor /system/etc/cpuinfo.arm64.txt");
                println!("ARM apps now see {seen} of {cores} CPU cores");
            }
        }
    }

    // Keep the screen on while playing.
    shell("settings put system screen_off_timeout 2147483647; svc power stayon true; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard");

    if let Some(package) = p.str("launch").filter(|v| !v.is_empty()) {
        shell(&format!("monkey -p {package} -c android.intent.category.LAUNCHER 1"));
        println!("launched {package}");
    }
    println!("ready: adb serial {}", adb.serial);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_warm_start_passes_no_snapshot_flag_and_a_cold_one_skips_the_load() {
        let warm = emulator_command("A", 5556, false);
        assert_eq!(&warm[..4], ["-avd", "A", "-port", "5556"]);
        assert!(warm.windows(2).any(|w| w == ["-gpu", "host"]));
        assert!(warm.windows(2).any(|w| w == ["-feature", "GLESDynamicVersion"]));
        assert!(!warm.iter().any(|a| a.contains("snapshot")));
        assert_eq!(emulator_command("A", 5556, true).last().map(String::as_str), Some("-no-snapshot-load"));
    }

    #[test]
    fn quick_boot_is_forced_on_only_where_the_config_already_says_otherwise() {
        let config = "a=1\nfastboot.forceColdBoot=yes\nfastboot.forceFastBoot=no\nb=2\n";
        assert_eq!(force_quick_boot(config), "a=1\nfastboot.forceColdBoot=no\nfastboot.forceFastBoot=yes\nb=2\n");
        let untouched = "a=1\nhw.ramSize=3072\n";
        assert_eq!(force_quick_boot(untouched), untouched);
    }

    #[test]
    fn the_generated_cpuinfo_lists_every_core() {
        let text = cpuinfo_text(3, "fp asimd");
        assert_eq!(text.matches("processor\t:").count(), 3);
        assert!(text.contains("processor\t: 2\nBogoMIPS\t: 1.00\nFeatures\t: fp asimd\n"));
        assert!(text.ends_with("CPU revision\t: 13\n\n"));
    }

    #[test]
    fn the_arm_cpuinfo_is_judged_against_the_guests_core_count() {
        assert_eq!(classify_arm_cpuinfo("4", 4), ArmCpuinfo::Complete);
        assert_eq!(classify_arm_cpuinfo("", 4), ArmCpuinfo::Missing);
        assert_eq!(classify_arm_cpuinfo("1", 4), ArmCpuinfo::NeedsFix);
    }
}
