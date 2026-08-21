import { BrowserWindow, WebContentsView, session, shell } from 'electron';
import type { SlotBounds, SlotId } from '../../shared/ads-types';

export const AD_TAG_SCHEME = 'oe-adtag';
export const AD_TAG_PARTITION = 'persist:ads';

/** How long after load to wait before deciding the tag rendered nothing. */
const FILL_PROBE_DELAY_MS = 1200;
/** Smallest rendered element area that counts as a real creative rather than a tracking pixel. */
const MIN_FILL_AREA = 2000;

interface MountedTag {
  view: WebContentsView;
  timer: NodeJS.Timeout | null;
  settled: boolean;
}

export interface NetworkTagHostOptions {
  /** The operator's ad tag snippet, verbatim from ads.config.json. */
  tagHtml: string;
  onLog?: (message: string) => void;
  /** Called with false when the tag rendered nothing, so the slot can fall back to native fill. */
  onResult?: (slot: SlotId, filled: boolean) => void;
}

/**
 * Hosts a third-party ad tag in an isolated `WebContentsView` layered over the app window.
 *
 * The isolation here is the entire point. Partner JavaScript is the least trustworthy code in the
 * product, and the renderer it would otherwise share a process with can drive a virtual machine.
 * So the tag gets: its own session partition, no preload, no node integration, sandboxing on, and
 * no route back into the app — `window.openEmu` does not exist in that world and cannot be
 * reached from it.
 *
 * Fill detection deliberately uses a main-process DOM probe rather than a bridge. Handing the tag
 * a callback would mean exposing an API to untrusted script; measuring what it rendered needs no
 * API at all, and a tag that lies about its own fill can't gain anything by it.
 */
export class NetworkTagHost {
  private readonly mounted = new Map<SlotId, MountedTag>();
  private readonly onLog: (message: string) => void;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly options: NetworkTagHostOptions,
  ) {
    this.onLog = options.onLog ?? (() => undefined);
  }

  /** Serves the wrapper document. Registered against `oe-adtag://` by the ads entry point. */
  handleRequest(personalized: boolean): Response {
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}</style>
  </head>
  <body>
    <script>window.__oeAd = { npa: ${personalized ? 0 : 1} };</script>
    ${this.options.tagHtml}
  </body>
</html>`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  mount(slot: SlotId, bounds: SlotBounds, personalized: boolean): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    this.unmount(slot);

    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(AD_TAG_PARTITION),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // No preload: nothing in this view has a channel back to the app.
        preload: undefined,
        // A tag that tries to open a window gets it handled below instead of spawning chrome.
        webviewTag: false,
      },
    });

    const contents = view.webContents;

    // Popups and target=_blank go to the system browser, never to a new app window. Ad tags open
    // windows on click; an unhandled one would be an un-dismissable chromeless window over the app.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    // In-place navigation away from the wrapper is a redirect hijack, not an ad. Same treatment.
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${AD_TAG_SCHEME}://`)) {
        event.preventDefault();
        if (/^https:\/\//.test(url)) void shell.openExternal(url);
      }
    });
    contents.setAudioMuted(true);

    window.contentView.addChildView(view);
    view.setBounds(bounds);
    void contents.loadURL(`${AD_TAG_SCHEME}://tag/${slot}?npa=${personalized ? 0 : 1}`);

    const entry: MountedTag = { view, timer: null, settled: false };
    this.mounted.set(slot, entry);

    contents.once('did-finish-load', () => {
      entry.timer = setTimeout(() => void this.probeFill(slot), FILL_PROBE_DELAY_MS);
    });
    contents.once('did-fail-load', (_e, code, description) => {
      this.onLog(`tag failed to load for "${slot}": ${description} (${code})`);
      this.settle(slot, false);
    });
  }

  updateBounds(slot: SlotId, bounds: SlotBounds): void {
    const entry = this.mounted.get(slot);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    entry.view.setBounds(bounds);
  }

  unmount(slot: SlotId): void {
    const entry = this.mounted.get(slot);
    if (!entry) return;
    this.mounted.delete(slot);
    if (entry.timer) clearTimeout(entry.timer);

    const window = this.getWindow();
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(entry.view);
      } catch {
        // Window already tearing down.
      }
    }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  unmountAll(): void {
    for (const slot of [...this.mounted.keys()]) this.unmount(slot);
  }

  /**
   * Asks the page how much it actually painted. A tag that returned an empty document, a 1×1
   * pixel, or a collapsed iframe counts as no-fill, and the slot falls back to native inventory
   * rather than showing a blank rectangle.
   */
  private async probeFill(slot: SlotId): Promise<void> {
    const entry = this.mounted.get(slot);
    if (!entry || entry.view.webContents.isDestroyed()) return;

    const script = `(() => {
      const nodes = document.querySelectorAll('iframe,img,canvas,video,ins,div');
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width * rect.height >= ${MIN_FILL_AREA}) return true;
      }
      return false;
    })()`;

    try {
      const filled = await entry.view.webContents.executeJavaScript(script, true);
      this.settle(slot, filled === true);
    } catch (err) {
      this.onLog(`tag fill probe failed for "${slot}": ${(err as Error).message}`);
      this.settle(slot, false);
    }
  }

  private settle(slot: SlotId, filled: boolean): void {
    const entry = this.mounted.get(slot);
    if (!entry || entry.settled) return;
    entry.settled = true;

    if (!filled) this.unmount(slot);
    this.options.onResult?.(slot, filled);
  }
}
