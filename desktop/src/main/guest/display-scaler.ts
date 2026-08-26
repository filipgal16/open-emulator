import {
  applyCommands,
  parsePhysicalDensity,
  parsePhysicalSize,
  resetCommands,
  resolveDisplayGeometry,
  worthApplying,
  type DisplayGeometry,
  type Size,
} from './display';

export interface DisplayScalerDeps {
  /** Runs one command in the guest. Both engines expose this identically. */
  shell(command: string): Promise<{ code: number | null; stdout: string[]; stderr: string[] }>;
  log?(message: string): void;
  /**
   * How long to wait after the last resize before reconfiguring the guest.
   *
   * Dragging a window edge emits a resize per frame. `wm size` is not cheap — it reconfigures the
   * display, and every visible activity re-lays out — so applying one per frame would make the
   * guest thrash and the drag stutter. Injectable so tests need not sleep.
   */
  settleMs?: number;
}

const DEFAULT_SETTLE_MS = 350;

/**
 * Keeps the guest's logical display matched to the viewport.
 *
 * Deliberately stateful, because two things must be remembered across resizes. The **panel** is
 * read from the guest once and cached: `wm size` reports the override once one is set, so asking
 * again after a resize and treating the answer as the baseline would compound each resize on the
 * last, shrinking the display a little with every drag. The **last applied** geometry is kept so a
 * drag that ends where it started costs nothing.
 */
export class DisplayScaler {
  private base: DisplayGeometry | null = null;
  private applied: DisplayGeometry | null = null;
  private pending: Size | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private enabled = true;

  constructor(private readonly deps: DisplayScalerDeps) {}

  /** Off means the guest keeps its panel geometry and the mirror letterboxes instead. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * The guest is gone, or about to be. Drops the cached panel so the next start reads it fresh —
   * a different profile boots a different panel, and reusing the old one would compute densities
   * against a device that no longer exists.
   */
  forget(): void {
    this.cancel();
    this.base = null;
    this.applied = null;
  }

  /** Records a new viewport size and schedules a reconfiguration once the drag settles. */
  request(viewport: Size): void {
    if (!this.enabled) return;
    if (viewport.width <= 0 || viewport.height <= 0) return;

    this.pending = viewport;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.settleMs ?? DEFAULT_SETTLE_MS);
  }

  /** Applies whatever is pending now, without waiting for the settle window. */
  async flush(): Promise<DisplayGeometry | null> {
    if (!this.enabled) return null;
    if (this.inFlight) return null;

    const viewport = this.pending;
    this.pending = null;
    if (!viewport) return null;

    this.inFlight = true;
    try {
      const base = await this.panel();
      if (!base) return null;

      const geometry = resolveDisplayGeometry({ viewport, base });
      if (!worthApplying(this.applied, geometry)) return geometry;

      for (const command of applyCommands(geometry)) {
        const result = await this.deps.shell(command);
        if (result.code !== 0) {
          this.deps.log?.(`display: "${command}" failed — ${result.stderr.join(' ').trim()}`);
          return null;
        }
      }

      this.applied = geometry;
      this.deps.log?.(`display: ${geometry.width}x${geometry.height} @ ${geometry.density}dpi`);
      return geometry;
    } finally {
      this.inFlight = false;
      // A resize that arrived while this was running still has to land, or the guest is left at
      // the second-to-last size the user dragged to.
      if (this.pending) this.request(this.pending);
    }
  }

  /** Returns the display to the panel's own geometry, and stops tracking. */
  async reset(): Promise<void> {
    this.cancel();
    this.applied = null;
    for (const command of resetCommands()) {
      await this.deps.shell(command).catch(() => undefined);
    }
  }

  /** The guest's physical panel, read once and cached. */
  private async panel(): Promise<DisplayGeometry | null> {
    if (this.base) return this.base;

    const size = await this.deps.shell('wm size').catch(() => null);
    const density = await this.deps.shell('wm density').catch(() => null);
    if (!size || !density) return null;

    const dimensions = parsePhysicalSize(size.stdout.join('\n'));
    const dpi = parsePhysicalDensity(density.stdout.join('\n'));
    // Left null rather than guessed, so the next resize tries again. A wrong baseline would be
    // applied silently to every subsequent resize.
    if (!dimensions || !dpi) return null;

    this.base = { ...dimensions, density: dpi };
    return this.base;
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
