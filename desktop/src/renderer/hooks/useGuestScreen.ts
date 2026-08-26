import { useEffect, useState } from 'react';

type Listener = (url: string | null) => void;

/**
 * Module-level, not per-component, on purpose.
 *
 * There is one mirror process in the main process and one `mirror:frame` listener allowed — the
 * preload bridge registers with `ipcRenderer.on` and has no way to unregister. So the subscription
 * is wired exactly once and fanned out here, and `startMirror`/`stopMirror` are reference-counted.
 * Without that, switching between the Screen tab and the Play frame would stop the mirror the
 * instant the outgoing tab unmounted — including in the overlap where both are briefly mounted,
 * which is precisely when it must not stop.
 */
const listeners = new Set<Listener>();
let refCount = 0;
let wired = false;
let currentUrl: string | null = null;

function wire(): void {
  if (wired) return;
  wired = true;
  window.openEmu.onFrame((data: Uint8Array) => {
    // TS's DOM lib types Uint8Array's buffer as ArrayBufferLike (possibly SharedArrayBuffer),
    // which BlobPart doesn't accept — this data always comes from a plain ArrayBuffer.
    const blob = new Blob([data as BlobPart], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = url;
    for (const listener of listeners) listener(url);
  });
}

/**
 * The latest mirrored frame as an object URL, or null before the guest has painted.
 *
 * `enabled` exists for the embedded-window path. When the guest's own window is reparented into
 * the viewport it paints there at the emulator's own frame rate, and mirroring the same guest
 * behind it would spend a ~400ms `screencap` per frame producing images nothing can see.
 */
export function useGuestScreen(enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(enabled ? currentUrl : null);

  useEffect(() => {
    if (!enabled) return;

    wire();
    listeners.add(setUrl);
    refCount += 1;
    if (refCount === 1) window.openEmu.startMirror();

    return () => {
      listeners.delete(setUrl);
      refCount -= 1;
      if (refCount === 0) window.openEmu.stopMirror();
    };
  }, [enabled]);

  return enabled ? url : null;
}
