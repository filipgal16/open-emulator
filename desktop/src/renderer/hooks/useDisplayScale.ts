import { useEffect, type RefObject } from 'react';

interface Options {
  /** Only a running guest can be reconfigured; a stopped one would just fail the shell call. */
  active: boolean;
  /** Degrees of CSS rotation applied to the mirror, from the bezel's Rotate control. */
  rotation: number;
}

/**
 * Keeps Android's logical display the same size as the element showing it.
 *
 * Measured with a `ResizeObserver` rather than a window resize listener because the viewport
 * changes size for reasons the window does not: entering theater mode, the bezel appearing when
 * the device starts, a panel opening in-flow. All of those should resize the guest too.
 *
 * `ResizeObserver` reports the **layout** box, before any CSS transform, which is what is wanted
 * here — the rotation below is applied deliberately rather than being read back out of a matrix.
 */
export function useDisplayScale(ref: RefObject<HTMLElement | null>, { active, rotation }: Options): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || !active) return;

    function report(cssWidth: number, cssHeight: number) {
      if (cssWidth <= 0 || cssHeight <= 0) return;

      // The mirror is scaled to CSS pixels, but the guest renders real ones. On a 150% display,
      // asking for the CSS width would hand back a picture at two thirds of the resolution the
      // screen can actually show, which reads as a soft, slightly blurry device.
      const ratio = window.devicePixelRatio || 1;
      let width = Math.round(cssWidth * ratio);
      let height = Math.round(cssHeight * ratio);

      // A quarter turn means the guest's long axis runs across the viewport's short one, so the
      // dimensions have to be swapped or the rotated image no longer fits the space it is in.
      if (rotation === 90 || rotation === 270) [width, height] = [height, width];

      window.openEmu.resizeDisplay(width, height);
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) report(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);

    // Dragging the window to a monitor with different scaling changes devicePixelRatio without
    // changing the layout box, so the observer alone would never notice.
    function onWindowResize() {
      const box = ref.current?.getBoundingClientRect();
      if (box) report(box.width, box.height);
    }
    window.addEventListener('resize', onWindowResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
  }, [ref, active, rotation]);
}
