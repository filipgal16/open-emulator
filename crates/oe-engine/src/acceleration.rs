//! Hardware acceleration on Windows.
//!
//! Without it the guest still runs (QEMU falls back to interpreting every instruction), but a
//! cold boot goes from well under a minute to the better part of an hour. It is the single largest
//! factor in whether this feels like a product.
//!
//! Two mechanisms exist and they are mutually exclusive:
//!
//!   **WHPX** (Windows Hypervisor Platform) is a Windows feature. It works on Intel and AMD, and it
//!   coexists with Hyper-V, WSL2, Docker, and WSA. Enabling it costs one elevated command and a
//!   restart. This is the default, and the reason is compatibility rather than speed: a machine
//!   running this app is quite likely running WSL2 or Docker too.
//!
//!   **AEHD** (Android Emulator Hypervisor Driver, Google's successor to Intel HAXM) is a kernel
//!   driver that benchmarks faster on AMD, but it requires Hyper-V and the Virtual Machine
//!   Platform to be **off**, which breaks WSL2 and everything built on it. Detected and used when
//!   already present; never installed automatically, because doing so would silently disable other
//!   software the user depends on.

use std::time::Duration;

use crate::{LogHandler, LogStream, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccelMethod {
    Whpx,
    Aehd,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccelerationState {
    pub available: bool,
    pub method: AccelMethod,
    /// Plain-language explanation, suitable for the setup UI.
    pub detail: String,
    /// True when the fix is "enable a Windows feature", which this app can offer to do.
    pub fixable: bool,
}

const WHPX_FEATURE: &str = "HypervisorPlatform";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AccelerationProbes {
    pub windows: bool,
    pub aehd_running: bool,
    pub whpx_enabled: bool,
    pub firmware_virtualization: bool,
    /// Windows has staged feature changes that need a restart.
    ///
    /// Only meaningful alongside `whpx_enabled`: the feature reports itself enabled the moment
    /// DISM finishes, and stays that way, while doing nothing at all, until the machine
    /// restarts.
    pub reboot_pending: bool,
    /// The Hyper-V hypervisor is loaded. Decides whether `reboot_pending` is about *this* feature
    /// or about something unrelated: a running hypervisor means WHPX has what it needs regardless.
    pub hypervisor_running: bool,
}

fn state(available: bool, method: AccelMethod, detail: &str, fixable: bool) -> AccelerationState {
    AccelerationState { available, method, detail: detail.to_owned(), fixable }
}

/// Turns the probes into an answer and a sentence.
///
/// Split from the probing so the branch that matters can be tested: distinguishing "your BIOS has
/// virtualization switched off" from "Windows needs a feature enabled" decides whether the UI
/// shows a button that fixes it or instructions that the button cannot. Offering a fix that
/// cannot work is worse than offering none.
pub fn decide_acceleration(probes: AccelerationProbes) -> AccelerationState {
    if !probes.windows {
        return state(false, AccelMethod::None, "not a Windows host", false);
    }

    // AEHD first: if it is running, WHPX is necessarily off, and reporting WHPX as the missing
    // piece on a machine that is already accelerated would be simply wrong.
    if probes.aehd_running {
        return state(true, AccelMethod::Aehd, "Android Emulator Hypervisor Driver is running", false);
    }

    if probes.whpx_enabled {
        // Enabled is not the same as working. DISM reports success and flips the feature's state
        // immediately, but nothing actually changes until the machine restarts, so believing the
        // flag here would have the app pass `-accel whpx` to an emulator that then refuses to
        // start, and blame the emulator.
        //
        // Unless the hypervisor is already running. The reboot flag is machine-wide (any Windows
        // Update sets it) and with Hyper-V loaded the feature has nothing left to wait for.
        if probes.reboot_pending && !probes.hypervisor_running {
            return state(
                false,
                AccelMethod::None,
                "Hardware acceleration is switched on but needs a restart to take effect. \
                 Restart Windows, then reopen open-emulator.",
                // Not fixable from here: the fix is a restart, which is the user's to perform.
                false,
            );
        }
        return state(true, AccelMethod::Whpx, "Windows Hypervisor Platform is enabled", false);
    }

    if !probes.firmware_virtualization {
        return state(
            false,
            AccelMethod::None,
            "Virtualization is turned off in your PC’s firmware. Enable it in the BIOS or UEFI settings: \
             it is usually called Intel VT-x, AMD-V, or SVM.",
            false,
        );
    }

    state(
        false,
        AccelMethod::None,
        "Windows Hypervisor Platform is not enabled yet. Android would run very slowly without it.",
        true,
    )
}

/// Asks the machine. Blocking, WMI and the service manager, so it runs on a worker thread.
#[cfg(windows)]
fn probe() -> AccelerationProbes {
    use oe_win::{system, wmi_probe};

    // Both names are checked: the driver shipped as `gvm` before it was renamed `aehd`, and
    // machines set up against older SDK releases still have the old one.
    let aehd_running = ["aehd", "gvm"].iter().any(|name| system::is_service_running(name));
    let whpx_enabled = !aehd_running && wmi_probe::is_optional_feature_enabled(WHPX_FEATURE);
    // Either is enough: once a hypervisor is running, the firmware flag often reads False because
    // the setting has already been consumed by it.
    let firmware_virtualization = aehd_running
        || whpx_enabled
        || wmi_probe::is_hypervisor_present()
        || wmi_probe::is_virtualization_firmware_enabled();
    // Only asked when it could change the answer.
    let reboot_pending = whpx_enabled && system::is_reboot_pending();
    let hypervisor_running = reboot_pending && wmi_probe::is_hypervisor_present();
    AccelerationProbes {
        windows: true,
        aehd_running,
        whpx_enabled,
        firmware_virtualization,
        reboot_pending,
        hypervisor_running,
    }
}

#[cfg(not(windows))]
fn probe() -> AccelerationProbes {
    AccelerationProbes::default()
}

/// Whether the guest can be hardware-accelerated on this machine, and if not, what to say.
pub async fn detect_acceleration() -> AccelerationState {
    let probes = tokio::task::spawn_blocking(probe).await.unwrap_or_default();
    decide_acceleration(probes)
}

/// Turns the Windows Hypervisor Platform on.
///
/// One UAC prompt, then a restart. `/NoRestart` is deliberate: rebooting a machine out from under
/// someone is never acceptable, and the caller reports the pending restart instead.
#[cfg(windows)]
pub async fn enable_whpx(on_log: LogHandler) -> Result<()> {
    on_log(LogStream::Stdout, "requesting administrator approval to enable the Windows Hypervisor Platform");
    let feature = format!("/FeatureName:{WHPX_FEATURE}");
    let outcome = tokio::task::spawn_blocking(move || {
        oe_win::system::run_elevated(
            "dism.exe",
            &["/Online", "/Enable-Feature", &feature, "/All", "/NoRestart"],
            Duration::from_secs(15 * 60),
        )
    })
    .await
    .map_err(|error| crate::err!("the elevated command did not finish: {error}"))?;
    match outcome {
        Ok(()) => {
            on_log(LogStream::Stdout, "the feature was enabled; Windows needs a restart before it takes effect");
            Ok(())
        }
        Err(oe_win::system::ElevationError::Failed(3010)) => {
            // DISM's "succeeded, restart required".
            on_log(LogStream::Stdout, "the feature was enabled; Windows needs a restart before it takes effect");
            Ok(())
        }
        Err(error) => Err(crate::err!("{error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probes() -> AccelerationProbes {
        AccelerationProbes { windows: true, firmware_virtualization: true, ..AccelerationProbes::default() }
    }

    #[test]
    fn whpx_enabled_is_accelerated_and_needs_no_fix() {
        let state = decide_acceleration(AccelerationProbes { whpx_enabled: true, ..probes() });
        assert!(state.available);
        assert_eq!(state.method, AccelMethod::Whpx);
        assert!(!state.fixable);
    }

    #[test]
    fn aehd_is_reported_even_though_whpx_is_off() {
        let state = decide_acceleration(AccelerationProbes { aehd_running: true, ..probes() });
        assert!(state.available);
        assert_eq!(state.method, AccelMethod::Aehd);
        assert!(!state.fixable);
    }

    #[test]
    fn a_missing_windows_feature_is_offered_as_fixable() {
        let state = decide_acceleration(probes());
        assert!(!state.available);
        assert!(state.fixable, "this one the app can actually fix");
        assert!(state.detail.contains("Hypervisor Platform"));
    }

    #[test]
    fn virtualization_off_in_firmware_is_not_offered_as_fixable() {
        let state = decide_acceleration(AccelerationProbes { firmware_virtualization: false, ..probes() });
        assert!(!state.available);
        assert!(!state.fixable);
        assert!(state.detail.contains("BIOS") || state.detail.contains("UEFI"));
    }

    #[test]
    fn a_non_windows_host_is_simply_unaccelerated_not_broken() {
        let state = decide_acceleration(AccelerationProbes { windows: false, ..probes() });
        assert!(!state.available);
        assert!(!state.fixable);
    }

    #[test]
    fn every_outcome_carries_a_sentence_the_setup_screen_can_show() {
        for p in [
            AccelerationProbes { whpx_enabled: true, ..probes() },
            AccelerationProbes { aehd_running: true, ..probes() },
            probes(),
            AccelerationProbes { firmware_virtualization: false, ..probes() },
            AccelerationProbes { windows: false, ..probes() },
        ] {
            assert!(!decide_acceleration(p).detail.is_empty());
        }
    }

    #[test]
    fn a_feature_enabled_but_not_yet_live_is_not_reported_as_available() {
        let state = decide_acceleration(AccelerationProbes { whpx_enabled: true, reboot_pending: true, ..probes() });
        assert!(!state.available);
        assert!(state.detail.to_lowercase().contains("restart"));
        assert!(!state.fixable, "a restart is the user’s to perform, not a button");
    }

    #[test]
    fn a_pending_reboot_with_the_hypervisor_already_running_is_a_working_whpx() {
        let state = decide_acceleration(AccelerationProbes {
            whpx_enabled: true,
            reboot_pending: true,
            hypervisor_running: true,
            ..probes()
        });
        assert!(state.available);
        assert_eq!(state.method, AccelMethod::Whpx);
    }

    #[test]
    fn a_pending_reboot_does_not_mask_acceleration_that_is_already_working() {
        let state = decide_acceleration(AccelerationProbes { aehd_running: true, reboot_pending: true, ..probes() });
        assert!(state.available);
        assert_eq!(state.method, AccelMethod::Aehd);
    }
}
