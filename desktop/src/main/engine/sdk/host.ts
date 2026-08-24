/**
 * How much of the machine to give the guest, and which renderer to ask for.
 *
 * Ports `detect_host_profile` from `android/lib/common.sh`. The numbers below are *measured*, not
 * guessed, and the measurements are the reason they look unintuitive — see each note. They were
 * taken on a KVM host under WSL2; the shape of the reasoning carries over to WHPX, but the exact
 * figures deserve re-measuring on native Windows before anyone tunes them further.
 */

export type GpuMode = 'host' | 'swiftshader_indirect' | 'angle_indirect';

export interface HostFacts {
  /** Logical processors. */
  cpus: number;
  totalRamMb: number;
  /** Whether a hypervisor the emulator can use (WHPX or AEHD) is actually available. */
  accelerated: boolean;
  /** False in a headless run — the emulator cannot use the real GPU without a window. */
  hasWindow: boolean;
}

export interface GuestTuning {
  cores: number;
  ramMb: number;
  gpuMode: GpuMode;
  /** `-accel on|off`. Off means TCG, which is correct but very slow. */
  accel: 'on' | 'off';
}

export interface TuningOverrides {
  cores?: number;
  ramMb?: number;
  gpuMode?: GpuMode;
}

/**
 * Cores.
 *
 * A cold-boot sweep across 2/4/6/8/12/16 cores measured 28.0/25.1/26.5/24.9/24.1/25.0 seconds, so
 * returns flatten after about 4 and the best point sits near 12. One core is left for the host;
 * the old ceiling of 6 was arbitrary.
 */
function chooseCores(cpus: number, accelerated: boolean): number {
  // Without acceleration every guest instruction is interpreted, and oversubscribing threads to a
  // software CPU loses to just using two.
  if (!accelerated) return 2;
  return Math.min(12, Math.max(1, cpus - 1));
}

/**
 * RAM — a measured constant, not a fraction of host memory.
 *
 * Scaling with the host was actively harmful: cold boot measured 22.9s at 3072MB, 25.9s at 3782MB
 * and 38.6s at 4096MB, and warm start is dominated by restoring the snapshot's `ram.bin`, which
 * grows with this number. Bigger machines were getting a *slower* emulator.
 */
function chooseRamMb(totalRamMb: number, accelerated: boolean): number {
  const floor = accelerated ? 4096 : 5120;
  return totalRamMb < floor ? 2048 : 3072;
}

/**
 * The renderer.
 *
 * This is the one decision that genuinely changes on native Windows. Under WSL the emulator ran
 * headless, `-gpu host` hung, and the best available was a software rasteriser. Natively there is a
 * real GPU and a real window, so `host` is both available and dramatically faster.
 *
 * `auto` is never returned, and that is load-bearing rather than fussy: the emulator resolves
 * `auto` to a concrete renderer that varies by system image, and records the *resolved* name in
 * the snapshot's `hardware.ini`. `config.ini` would still say something else, and the next warm
 * start dies with "The emulator hardware cannot load snapshot". Deciding here keeps the two in
 * agreement, which is what makes snapshots reloadable at all.
 */
function chooseGpuMode(facts: HostFacts): GpuMode {
  if (!facts.hasWindow) return 'swiftshader_indirect';
  if (!facts.accelerated) return 'swiftshader_indirect';
  return 'host';
}

export function tuneForHost(facts: HostFacts, overrides: TuningOverrides = {}): GuestTuning {
  const cores = clampInt(overrides.cores, 1, 32) ?? chooseCores(facts.cpus, facts.accelerated);
  const ramMb = clampInt(overrides.ramMb, 512, 16_384) ?? chooseRamMb(facts.totalRamMb, facts.accelerated);

  return {
    cores,
    ramMb,
    gpuMode: overrides.gpuMode ?? chooseGpuMode(facts),
    accel: facts.accelerated ? 'on' : 'off',
  };
}

function clampInt(value: number | undefined, min: number, max: number): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}
