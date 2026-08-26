import { useEffect, useState, type RefObject } from 'react';

interface Options {
  /** Only a running guest has a window to embed or a display to resize. */
  active: boolean;
  /** False while a dialog or another workspace is up — see the airspace rule below. */
  visible: boolean;
}

/**
 * Reports where the device pane is, and answers whether the guest's own window is showing there.
 *
 * Measured with a `ResizeObserver` rather than a window resize listener because the pane changes
 * size for reasons the window does not: entering theater mode, the bezel appearing when the device
 * starts, a panel opening in-flow. The embedded window has to follow all of them.
 *
 * **The airspace rule.** When the guest's window is embedded it is a separate surface painted over
 * the page — nothing in HTML can be drawn on top of it. So `visible` must go false for anything
 * that would overlap the device: a dialog, another workspace. This hook does not decide that; it
 * carries the caller's decision to the main process.
 *
 * Returns true once the real window is embedded, which is the caller's signal to stop mirroring
 * frames. False means the slow path is still needed.
 */
export function useGuestViewport(ref: RefObject<HTMLElement | null>, { active, visible }: Options): boolean {
  const [embedded, setEmbedded] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || !active) {
      setEmbedded(false);
      return;
    }

    let cancelled = false;

    function report() {
      const box = ref.current?.getBoundingClientRect();
      if (!box || box.width <= 0 || box.height <= 0) return;

      // Page coordinates map straight onto the host window's client area, so device pixels are
      // just CSS pixels scaled. Without this the guest would be positioned at two thirds size on a
      // 150% display, and sized for a screen it is not filling.
      const ratio = window.devicePixelRatio || 1;
      const rect = {
        x: Math.round(box.left * ratio),
        y: Math.round(box.top * ratio),
        width: Math.round(box.width * ratio),
        height: Math.round(box.height * ratio),
      };

      void window.openEmu.reportViewport(rect, visible).then((isEmbedded) => {
        if (!cancelled) setEmbedded(isEmbedded);
      });
    }

    report();

    const observer = new ResizeObserver(report);
    observer.observe(element);

    // A ResizeObserver sees the pane's own size, not the page scrolling or the window moving to a
    // monitor with different scaling — both of which move where the guest has to be drawn.
    window.addEventListener('resize', report);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [ref, active, visible]);

  return embedded;
}
