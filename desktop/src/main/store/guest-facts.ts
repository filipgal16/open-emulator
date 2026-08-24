import type { OpenEmuClient } from '../engine/client';
import { posixQuote } from '../platform/shell-quote';

export interface GuestFacts {
  /** API level, or null when the guest isn't answering. */
  sdk: number | null;
  /** Whether `com.android.vending` is actually present in this profile's image. */
  playAvailable: boolean;
  fingerprint: string | null;
  /** True when the build fingerprint has been rewritten to impersonate a real device. */
  identitySpoofed: boolean;
  /** Which AVD answered, so per-profile state isn't attributed to the wrong guest. */
  avdName: string | null;
}

export const UNKNOWN_FACTS: GuestFacts = {
  sdk: null,
  playAvailable: false,
  fingerprint: null,
  identitySpoofed: false,
  avdName: null,
};

/** Every stock emulator image says one of these somewhere in its fingerprint. */
const STOCK_FINGERPRINT_RE = /generic|sdk|emulator|goldfish|ranchu/i;

/**
 * A fingerprint that looks like a real retail device means customize_device.sh has been here.
 *
 * This matters to the Play tab specifically: the Play Store image is certified against its own
 * fingerprint, so a guest wearing a Pixel's identity gets "device is not Play Protect certified"
 * at sign-in. Detecting it lets the UI explain that up front instead of leaving someone staring
 * at a login that will never succeed.
 */
export function looksSpoofed(fingerprint: string | null): boolean {
  if (!fingerprint) return false;
  return !STOCK_FINGERPRINT_RE.test(fingerprint);
}

const TTL_MS = 60_000;

/**
 * What the store needs to know about the running guest.
 *
 * All three facts come back from one `adb shell` round trip. Under TCG each one costs seconds, and
 * the store asks for them on every tab switch, so batching and caching is the difference between
 * a responsive UI and one that stutters.
 */
export class GuestFactsProbe {
  private facts: GuestFacts = { ...UNKNOWN_FACTS };
  private probedAt = 0;
  private inFlight: Promise<GuestFacts> | null = null;

  constructor(
    private readonly openEmu: OpenEmuClient,
    private readonly options: { now?: () => number; onLog?: (message: string) => void } = {},
  ) {}

  /** Last known facts without touching the guest. */
  current(): GuestFacts {
    return { ...this.facts };
  }

  probe(force = false): Promise<GuestFacts> {
    const now = this.options.now?.() ?? Date.now();
    if (!force && this.probedAt > 0 && now - this.probedAt < TTL_MS) {
      return Promise.resolve(this.current());
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.doProbe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doProbe(): Promise<GuestFacts> {
    // One shell, four answers. The quotes survive bash and are consumed by the guest's sh, which
    // is what makes `$(…)`, `;`, and `||` evaluate in the guest rather than on the host.
    //
    // Each answer is labelled rather than positional: `getprop` prints an empty line for an unset
    // property, and a positional parse would then silently read the *next* value as this one.
    const script = [
      'echo "OE_SDK=$(getprop ro.build.version.sdk)"',
      'echo "OE_FP=$(getprop ro.build.fingerprint)"',
      'echo "OE_AVD=$(getprop ro.boot.qemu.avd_name)"',
      'pm path com.android.vending >/dev/null 2>&1 && echo OE_PLAY=1 || echo OE_PLAY=0',
    ].join('; ');

    try {
      const result = await this.openEmu.shell(posixQuote(script), () => undefined, 30_000);
      if (result.code !== 0) {
        this.facts = { ...UNKNOWN_FACTS };
      } else {
        const field = (key: string): string | null => {
          const line = result.stdout.map((l) => l.trim()).find((l) => l.startsWith(`${key}=`));
          const value = line?.slice(key.length + 1).trim();
          return value ? value : null;
        };

        const sdk = Number.parseInt(field('OE_SDK') ?? '', 10);
        const fingerprint = field('OE_FP');
        this.facts = {
          sdk: Number.isFinite(sdk) && sdk > 0 ? sdk : null,
          playAvailable: field('OE_PLAY') === '1',
          fingerprint,
          identitySpoofed: looksSpoofed(fingerprint),
          avdName: field('OE_AVD'),
        };
      }
    } catch (err) {
      this.options.onLog?.(`guest probe failed: ${(err as Error).message}`);
      this.facts = { ...UNKNOWN_FACTS };
    }

    this.probedAt = this.options.now?.() ?? Date.now();
    return this.current();
  }
}
