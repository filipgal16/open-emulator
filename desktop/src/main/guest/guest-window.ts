import type { Rect } from '../engine/window-embed';

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
}

export interface GuestWindowDeps {
  embed: EmbedApi;
  log?(message: string): void;
  /** How long to wait for the emulator to paint before giving up and mirroring instead. */
  attachTimeoutMs?: number;
}

/**
 * The guest's real window, reparented into ours.
 *
 * This is what makes the device run at the emulator's own frame rate instead of ~2.8fps. The
 * emulator already renders the guest on the GPU into a Qt window; embedding shows that window
 * directly, so there is no capture, no PNG encode, no decode, and no polling interval to cap it.
 * Mouse and keyboard reach the emulator directly too, rather than paying an `adb shell input`
 * round trip per gesture.
 *
 * **Every operation is allowed to fail.** `SetParent` across processes can be refused, a driver
 * can dislike a reparented Qt surface, and the emulator can exit underneath us at any moment. So
 * nothing here throws: each method reports success, and a false answer means the caller should
 * fall back to mirroring rather than show the user an empty rectangle.
 */
export class GuestWindow {
  private child: unknown = null;
  private bounds: Rect | null = null;
  private visible = false;
  private attaching: Promise<boolean> | null = null;

  constructor(private readonly deps: GuestWindowDeps) {}

  /** True once a real window is embedded and being tracked. */
  isAttached(): boolean {
    return this.child !== null && this.deps.embed.isLiveWindow(this.child);
  }

  /**
   * Finds the emulator's window and reparents it into `parent`.
   *
   * Concurrent calls share one attempt. The renderer reports its viewport on every resize, and a
   * guest that has just started will get several of those while the window is still being waited
   * for — without this, each would start its own 60-second poll against the same process.
   */
  async attach(pid: number, parent: Buffer, bounds: Rect): Promise<boolean> {
    if (this.isAttached()) {
      this.setBounds(bounds);
      return true;
    }
    if (this.attaching) return this.attaching;

    this.attaching = this.doAttach(pid, parent, bounds).finally(() => {
      this.attaching = null;
    });
    return this.attaching;
  }

  private async doAttach(pid: number, parent: Buffer, bounds: Rect): Promise<boolean> {
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

    let embedded = false;
    try {
      embedded = this.deps.embed.embedWindow(hwnd, parent, bounds);
    } catch (err) {
      this.deps.log?.(`embedding failed: ${(err as Error).message}`);
      return false;
    }

    if (!embedded) {
      this.deps.log?.('the guest window refused to be embedded — mirroring instead');
      return false;
    }

    this.child = hwnd;
    this.bounds = bounds;
    // embedWindow's SetWindowPos carries SWP_SHOWWINDOW, so it is on screen as of now. Recording
    // that rather than assuming false keeps the first setVisible(true) from being skipped as a
    // no-op when the state is already correct.
    this.visible = true;
    this.deps.log?.('guest window embedded — running at the emulator’s own frame rate');
    return true;
  }

  /**
   * Repositions the window to match the viewport.
   *
   * Skipped when the rectangle has not moved. The renderer reports on a `ResizeObserver`, which
   * fires for layout changes that leave the viewport where it was, and every `SetWindowPos` on a
   * live GPU surface is a real repaint.
   */
  setBounds(bounds: Rect): boolean {
    if (!this.isAttached()) return false;
    if (this.bounds && sameRect(this.bounds, bounds)) return true;

    const moved = this.deps.embed.moveWindow(this.child, bounds);
    if (moved) this.bounds = bounds;
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
   * Forgets the window. Called when the guest stops.
   *
   * Deliberately does not destroy or un-parent it: the emulator owns that window and is being
   * asked to exit, so tearing its window out from under it during shutdown risks a crash for no
   * benefit. Dropping the reference is enough.
   */
  detach(): void {
    this.child = null;
    this.bounds = null;
    this.visible = false;
  }
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
