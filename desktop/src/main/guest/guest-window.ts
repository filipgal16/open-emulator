import type { Rect, WindowStyles } from '../engine/window-embed';

/**
 * The Win32 calls this controller needs, injected so it can be tested without a real window —
 * and so a machine where `koffi` fails to load degrades to the mirror instead of crashing.
 */
export interface EmbedApi {
  waitForWindow(pid: number, timeoutMs?: number, pollMs?: number): Promise<unknown | null>;
  embedWindow(child: unknown, parent: Buffer, bounds: Rect): boolean;
  moveWindow(child: unknown, bounds: Rect): boolean;
  setWindowVisible(child: unknown, visible: boolean): boolean;
  isLiveWindow(child: unknown): boolean;
  captureWindowStyles(child: unknown): WindowStyles | null;
  releaseWindow(child: unknown, styles: WindowStyles | null): boolean;
  /** Where the child actually is, in the parent's client coordinates. */
  childBounds(child: unknown, parent: Buffer): Rect | null;
  /** The child's own client size — how the emulator has shaped itself. */
  clientSize(child: unknown): { width: number; height: number } | null;
  /** Hides the floating tool windows the child owns. Returns how many it hid. */
  hideOwnedWindows(child: unknown): number;
}

export interface GuestWindowDeps {
  embed: EmbedApi;
  log?(message: string): void;
  /** How long to wait for the emulator to paint before giving up and mirroring instead. */
  attachTimeoutMs?: number;
  /** How often to check that the window is still where it was put. */
  watchIntervalMs?: number;
}

// Qt reshapes the window two or three times while the emulator is starting; each is visible until
// the next tick puts it back, so the tick is the ceiling on how long a misplaced frame is shown.
const DEFAULT_WATCH_MS = 200;
/** Rectangles this close are the same rectangle: Qt rounds, and so do we. */
const TOLERANCE_PX = 2;

/**
 * The guest's real window, reparented into ours.
 *
 * This is what makes the device run at the emulator's own frame rate instead of ~2.8fps. The
 * emulator already renders the guest on the GPU into a Qt window; embedding shows that window
 * directly, so there is no capture, no PNG encode, no decode, and no polling interval to cap it.
 * Mouse and keyboard reach the emulator directly too, rather than paying an `adb shell input`
 * round trip per gesture.
 *
 * **The emulator owns its shape.** The Qt window keeps the device panel's aspect ratio no matter
 * what size it is given: asked to fill a landscape pane, it comes back a moment later as a
 * portrait rectangle of its own choosing. Fighting that on a timer made the window flicker between
 * the two shapes forever. So this controller never dictates a shape — it fits the largest
 * rectangle of the emulator's *current* aspect into the pane, centres it, and when the emulator
 * changes shape on its own (a rotation, a display change) it adopts the new aspect and re-fits
 * once. The pane's own background shows around it, which is what every desktop emulator does.
 *
 * **Every operation is allowed to fail.** `SetParent` across processes can be refused, a driver
 * can dislike a reparented Qt surface, and the emulator can exit underneath us at any moment. So
 * nothing here throws: each method reports success, and a false answer means the caller should
 * fall back to mirroring rather than show the user an empty rectangle.
 */
export class GuestWindow {
  private child: unknown = null;
  /** Captured before embedding, so `detach` can put the window back as it found it. */
  private styles: WindowStyles | null = null;
  /** The pane the renderer reported: where the guest is allowed to be. */
  private viewport: Rect | null = null;
  /** The rectangle this controller last set — the fit of `viewport` at `aspect`. */
  private placed: Rect | null = null;
  /** Width over height of the emulator's window, as it last shaped itself. */
  private aspect: number | null = null;
  private parent: Buffer | null = null;
  private visible = false;
  private attaching: Promise<boolean> | null = null;
  private watcher: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: GuestWindowDeps) {}

  /** True once a real window is embedded and being tracked. */
  isAttached(): boolean {
    return this.child !== null && this.deps.embed.isLiveWindow(this.child);
  }

  /** Where the guest is drawn right now, in the parent's client coordinates. */
  placement(): Rect | null {
    return this.placed;
  }

  /**
   * Finds the emulator's window and reparents it into `parent`, fitted inside `viewport`.
   *
   * Concurrent calls share one attempt. The renderer reports its viewport on every resize, and a
   * guest that has just started will get several of those while the window is still being waited
   * for — without this, each would start its own 60-second poll against the same process.
   */
  async attach(pid: number, parent: Buffer, viewport: Rect): Promise<boolean> {
    if (this.isAttached()) {
      this.setBounds(viewport);
      return true;
    }
    if (this.attaching) return this.attaching;

    this.attaching = this.doAttach(pid, parent, viewport).finally(() => {
      this.attaching = null;
    });
    return this.attaching;
  }

  private async doAttach(pid: number, parent: Buffer, viewport: Rect): Promise<boolean> {
    let hwnd: unknown | null = null;
    try {
      hwnd = await this.deps.embed.waitForWindow(pid, this.deps.attachTimeoutMs ?? 60_000);
    } catch (err) {
      this.deps.log?.(`could not look for the guest window: ${(err as Error).message}`);
      return false;
    }

    if (!hwnd) {
      this.deps.log?.('the emulator never showed a window — mirroring instead');
      return false;
    }

    // The emulator's own shape, read before anything is moved, so the very first placement is
    // already the right one rather than a full-pane rectangle Qt immediately shrinks.
    const natural = this.deps.embed.clientSize(hwnd);
    const aspect = natural && natural.width > 0 && natural.height > 0 ? natural.width / natural.height : null;
    const target = fit(viewport, aspect);

    let embedded = false;
    try {
      // Captured before embedWindow overwrites them, or detach has nothing to restore.
      this.styles = this.deps.embed.captureWindowStyles(hwnd);
      embedded = this.deps.embed.embedWindow(hwnd, parent, target);
    } catch (err) {
      this.deps.log?.(`embedding failed: ${(err as Error).message}`);
      return false;
    }

    if (!embedded) {
      this.deps.log?.('the guest window refused to be embedded — mirroring instead');
      return false;
    }

    this.child = hwnd;
    this.parent = parent;
    this.viewport = viewport;
    this.placed = target;
    this.aspect = aspect;
    // embedWindow's SetWindowPos carries SWP_SHOWWINDOW, so it is on screen as of now. Recording
    // that rather than assuming false keeps the first setVisible(true) from being skipped as a
    // no-op when the state is already correct.
    this.visible = true;
    this.deps.log?.(
      `guest window embedded at ${target.width}x${target.height} — running at the emulator’s own frame rate`,
    );

    this.tidy();
    this.startWatching();
    return true;
  }

  /** Hides the emulator's own floating toolbar; ours has every button on it. */
  private tidy(): void {
    try {
      const hidden = this.deps.embed.hideOwnedWindows(this.child);
      if (hidden > 0) this.deps.log?.(`hid ${hidden} floating emulator toolbar window(s)`);
    } catch (err) {
      this.deps.log?.(`could not hide the emulator toolbar: ${(err as Error).message}`);
    }
  }

  /**
   * Watches for the emulator reshaping itself.
   *
   * It does so after a rotation, after the guest's display configuration changes, and once
   * shortly after being embedded. Nothing above notices, because the *requested* viewport never
   * changed. One `GetWindowRect` per tick is cheap; the toolbar re-hide rides along because Qt
   * re-shows it on some of the same events.
   */
  private startWatching(): void {
    this.stopWatching();
    const interval = this.deps.watchIntervalMs ?? DEFAULT_WATCH_MS;
    this.watcher = setInterval(() => this.check(), interval);
    // Never the reason the process stays alive.
    (this.watcher as { unref?: () => void }).unref?.();
  }

  private stopWatching(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
  }

  /** One watchdog tick. Public so tests can drive it without waiting on a timer. */
  check(): void {
    if (!this.isAttached()) {
      this.stopWatching();
      return;
    }
    if (!this.visible || !this.viewport || !this.placed || !this.parent) return;

    let actual: Rect | null = null;
    try {
      actual = this.deps.embed.childBounds(this.child, this.parent);
    } catch {
      return;
    }
    if (!actual || actual.width <= 0 || actual.height <= 0) return;

    if (!nearly(actual, this.placed)) {
      // The emulator reshaped itself. Its new shape is the truth; our job is only where it sits.
      //
      // Its *exact* size is kept, not re-derived from the aspect ratio. Qt believes this window is
      // top-level, and when it corrects a size it dislikes — even by one pixel of rounding — it
      // re-applies its geometry in screen coordinates, which for a child window are parent-relative.
      // The window then lands offset by the parent's origin, gets moved back, and Qt corrects it
      // again: a visible bounce twice a second, forever. Handing back a size Qt already agrees with
      // gives it nothing to correct. Only a shape too large for the pane is scaled down.
      const aspect = actual.width / actual.height;
      this.aspect = aspect;
      const fits = actual.width <= this.viewport.width && actual.height <= this.viewport.height;
      const target = fits ? centre(this.viewport, actual.width, actual.height) : fit(this.viewport, aspect);
      if (nearly(target, actual)) {
        // Already the size we would have chosen, just possibly off-centre by rounding. Accept.
        this.placed = actual;
      } else {
        this.deps.log?.(
          `guest window reshaped to ${describe(actual)} (was placed at ${describe(this.placed)}) — fitting it as ${describe(target)}`,
        );
        if (this.deps.embed.moveWindow(this.child, target)) this.placed = target;
      }
    }
    this.tidy();
  }

  /**
   * Fits the window into a new viewport.
   *
   * Skipped when nothing would move. The renderer reports on a `ResizeObserver`, which fires for
   * layout changes that leave the viewport where it was, and every `SetWindowPos` on a live GPU
   * surface is a real repaint.
   */
  setBounds(viewport: Rect): boolean {
    if (!this.isAttached()) return false;
    this.viewport = viewport;

    const target = fit(viewport, this.aspect);
    if (this.placed && sameRect(this.placed, target)) return true;

    const moved = this.deps.embed.moveWindow(this.child, target);
    if (moved) this.placed = target;
    return moved;
  }

  /**
   * Shows or hides the window — the airspace escape hatch.
   *
   * A child HWND paints over the page, so anything in HTML that would overlap the device is
   * invisible until this is called with false. Workspace switches and dialogs both depend on it.
   */
  setVisible(visible: boolean): boolean {
    if (!this.isAttached()) return false;
    if (this.visible === visible) return true;

    const ok = this.deps.embed.setWindowVisible(this.child, visible);
    if (ok) this.visible = visible;
    return ok;
  }

  /**
   * Gives the window back to the desktop and forgets it.
   *
   * Merely dropping the reference is not enough, and getting this wrong is expensive: Windows
   * destroys child windows along with their parent, so a guest window left parented to ours when
   * the app closes is destroyed with it — while the emulator keeps running, now with no screen.
   * Observed exactly that way, and it poisons every later start, which finds no window to embed.
   */
  detach(): void {
    this.stopWatching();
    if (this.child && this.deps.embed.isLiveWindow(this.child)) {
      try {
        this.deps.embed.releaseWindow(this.child, this.styles);
      } catch (err) {
        this.deps.log?.(`could not release the guest window: ${(err as Error).message}`);
      }
    }
    this.child = null;
    this.styles = null;
    this.viewport = null;
    this.placed = null;
    this.aspect = null;
    this.parent = null;
    this.visible = false;
  }
}

/**
 * The largest rectangle of the given aspect that fits inside `viewport`, centred in it.
 *
 * With no aspect known yet, the viewport itself: the emulator will reshape it, and the watchdog
 * fits it properly a tick later.
 */
export function fit(viewport: Rect, aspect: number | null): Rect {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { ...viewport };
  }

  let width = viewport.width;
  let height = Math.round(width / aspect);
  if (height > viewport.height) {
    height = viewport.height;
    width = Math.round(height * aspect);
  }

  return centre(viewport, width, height);
}

/** A rectangle of exactly this size, centred in the viewport. */
export function centre(viewport: Rect, width: number, height: number): Rect {
  return {
    x: viewport.x + Math.round((viewport.width - width) / 2),
    y: viewport.y + Math.round((viewport.height - height) / 2),
    width,
    height,
  };
}

function describe(rect: Rect): string {
  return `${rect.width}x${rect.height}@${rect.x},${rect.y}`;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function nearly(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= TOLERANCE_PX &&
    Math.abs(a.height - b.height) <= TOLERANCE_PX
  );
}
