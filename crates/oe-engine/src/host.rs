//! How much of the machine to give the guest, and which renderer to ask for.
//!
//! The numbers below are *measured*, not guessed, and the measurements are the reason they look
//! unintuitive: see each note. They were taken on a KVM host under WSL2; the shape of the
//! reasoning carries over to WHPX, but the exact figures deserve re-measuring on native Windows
//! before anyone tunes them further.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuMode {
    Host,
    SwiftshaderIndirect,
    AngleIndirect,
}

impl GpuMode {
    /// The value `-gpu` and `hw.gpu.mode` take.
    pub fn name(self) -> &'static str {
        match self {
            GpuMode::Host => "host",
            GpuMode::SwiftshaderIndirect => "swiftshader_indirect",
            GpuMode::AngleIndirect => "angle_indirect",
        }
    }

    pub fn parse(value: &str) -> Option<GpuMode> {
        match value {
            "host" => Some(GpuMode::Host),
            "swiftshader_indirect" => Some(GpuMode::SwiftshaderIndirect),
            "angle_indirect" => Some(GpuMode::AngleIndirect),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostFacts {
    /// Logical processors.
    pub cpus: u32,
    pub total_ram_mb: u64,
    /// Whether a hypervisor the emulator can use (WHPX or AEHD) is actually available.
    pub accelerated: bool,
    /// False in a headless run: the emulator cannot use the real GPU without a window.
    pub has_window: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuestTuning {
    pub cores: u32,
    pub ram_mb: u32,
    pub gpu_mode: GpuMode,
    /// `-accel on|off`. Off means TCG, which is correct but very slow.
    pub accel: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TuningOverrides {
    pub cores: Option<f64>,
    pub ram_mb: Option<f64>,
    pub gpu_mode: Option<GpuMode>,
}

/// Cores.
///
/// A cold-boot sweep across 2/4/6/8/12/16 cores measured 28.0/25.1/26.5/24.9/24.1/25.0 seconds,
/// so returns flatten after about 4 and the best point sits near 12. One core is left for the
/// host.
fn choose_cores(cpus: u32, accelerated: bool) -> u32 {
    // Without acceleration every guest instruction is interpreted, and oversubscribing threads to
    // a software CPU loses to just using two.
    if !accelerated {
        return 2;
    }
    cpus.saturating_sub(1).clamp(1, 12)
}

/// RAM: a measured constant, not a fraction of host memory.
///
/// Scaling with the host was actively harmful: cold boot measured 22.9s at 3072MB, 25.9s at
/// 3782MB and 38.6s at 4096MB, and warm start is dominated by restoring the snapshot's `ram.bin`,
/// which grows with this number. Bigger machines were getting a *slower* emulator.
fn choose_ram_mb(total_ram_mb: u64, accelerated: bool) -> u32 {
    let floor = if accelerated { 4096 } else { 5120 };
    if total_ram_mb < floor { 2048 } else { 3072 }
}

/// The renderer.
///
/// `auto` is never returned, and that is load-bearing rather than fussy: the emulator resolves
/// `auto` to a concrete renderer that varies by system image, and records the *resolved* name in
/// the snapshot's `hardware.ini`. `config.ini` would still say something else, and the next warm
/// start dies with "The emulator hardware cannot load snapshot". Deciding here keeps the two in
/// agreement, which is what makes snapshots reloadable at all.
fn choose_gpu_mode(facts: &HostFacts) -> GpuMode {
    if !facts.has_window || !facts.accelerated {
        return GpuMode::SwiftshaderIndirect;
    }
    GpuMode::Host
}

pub fn tune_for_host(facts: &HostFacts, overrides: TuningOverrides) -> GuestTuning {
    GuestTuning {
        cores: clamp_int(overrides.cores, 1, 32).unwrap_or_else(|| choose_cores(facts.cpus, facts.accelerated)),
        ram_mb: clamp_int(overrides.ram_mb, 512, 16_384).unwrap_or_else(|| choose_ram_mb(facts.total_ram_mb, facts.accelerated)),
        gpu_mode: overrides.gpu_mode.unwrap_or_else(|| choose_gpu_mode(facts)),
        accel: facts.accelerated,
    }
}

fn clamp_int(value: Option<f64>, min: u32, max: u32) -> Option<u32> {
    let value = value.filter(|v| v.is_finite())?;
    Some(oe_formats::js_round(value).clamp(f64::from(min), f64::from(max)) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> HostFacts {
        HostFacts { cpus: 16, total_ram_mb: 15_700, accelerated: true, has_window: true }
    }

    fn tune(facts: HostFacts) -> GuestTuning {
        tune_for_host(&facts, TuningOverrides::default())
    }

    #[test]
    fn a_core_is_left_for_the_host_and_the_count_is_capped_where_returns_flatten() {
        assert_eq!(tune(HostFacts { cpus: 16, ..facts() }).cores, 12, "capped at 12");
        assert_eq!(tune(HostFacts { cpus: 8, ..facts() }).cores, 7);
        assert_eq!(tune(HostFacts { cpus: 1, ..facts() }).cores, 1, "never zero");
    }

    #[test]
    fn without_acceleration_two_cores_beat_oversubscribing_a_software_cpu() {
        assert_eq!(tune(HostFacts { accelerated: false, ..facts() }).cores, 2);
        assert!(!tune(HostFacts { accelerated: false, ..facts() }).accel);
    }

    #[test]
    fn guest_ram_is_a_measured_constant_not_a_share_of_the_host() {
        assert_eq!(tune(HostFacts { total_ram_mb: 15_700, ..facts() }).ram_mb, 3072);
        assert_eq!(tune(HostFacts { total_ram_mb: 65_536, ..facts() }).ram_mb, 3072);
        assert_eq!(tune(HostFacts { total_ram_mb: 3_500, ..facts() }).ram_mb, 2048, "small host steps down");
    }

    #[test]
    fn a_real_window_and_acceleration_earn_the_real_gpu() {
        assert_eq!(tune(facts()).gpu_mode, GpuMode::Host);
    }

    #[test]
    fn headless_falls_back_to_software_rendering() {
        assert_eq!(tune(HostFacts { has_window: false, ..facts() }).gpu_mode, GpuMode::SwiftshaderIndirect);
        assert_eq!(tune(HostFacts { accelerated: false, ..facts() }).gpu_mode, GpuMode::SwiftshaderIndirect);
    }

    #[test]
    fn overrides_win_but_are_clamped_rather_than_trusted() {
        let with = |overrides: TuningOverrides| tune_for_host(&facts(), overrides);
        assert_eq!(with(TuningOverrides { cores: Some(4.0), ..Default::default() }).cores, 4);
        assert_eq!(with(TuningOverrides { cores: Some(9999.0), ..Default::default() }).cores, 32);
        assert_eq!(with(TuningOverrides { cores: Some(0.0), ..Default::default() }).cores, 1);
        assert_eq!(with(TuningOverrides { ram_mb: Some(100.0), ..Default::default() }).ram_mb, 512);
        assert_eq!(
            with(TuningOverrides { gpu_mode: Some(GpuMode::AngleIndirect), ..Default::default() }).gpu_mode,
            GpuMode::AngleIndirect
        );
    }
}
