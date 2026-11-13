import { useEffect, useRef, type ReactNode } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useGuestScreen } from '../hooks/useGuestScreen';

interface Props {
  /** Fires once, when the guest first paints — the signal that the boot wait is over. */
  onFirstFrame?: () => void;
  className?: string;
  waitingLabel?: string;
  /** Accessible name for the live mirror. Kept off the tab order so a focus ring cannot cover the native window. */
  alt?: string;
  /** Replaces the default waiting copy. Must not float — it sits where the frame will. */
  placeholder?: ReactNode;
  /**
   * The guest's own window is painting over this pane, so there is nothing to mirror or draw.
   *
   * The pane still has to occupy its space in the layout — the embedded window is positioned to
   * match it — so this renders an empty box rather than nothing at all.
   */
  embedded?: boolean;
}

/** Below this much movement, a drag was someone tapping with an unsteady hand. */
const SWIPE_THRESHOLD_PX = 12;

function cssRotation(el: HTMLElement): 0 | 90 | 180 | 270 {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  const m = new DOMMatrix(t);
  const a = Math.round(m.a);
  const b = Math.round(m.b);
  if (a === 0 && b === 1) return 90;
  if (a === -1 && b === 0) return 180;
  if (a === 0 && b === -1) return 270;
  return 0;
}

/**
 * The mirrored guest, with pointer input forwarded.
 *
 * Shared by the device workspace and the Store's Play frame so both behave identically — a scroll that
 * works in one and not the other would be a bug report waiting to happen, and the Play client is
 * unusable without scrolling.
 */
export function GuestSurface({
  onFirstFrame,
  className,
  waitingLabel = 'Waiting for first frame…',
  alt = 'Live view of the Android device',
  placeholder,
  embedded = false,
}: Props) {
  const frameUrl = useGuestScreen(!embedded);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const downRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const firedFirstFrame = useRef(false);

  useEffect(() => {
    if (frameUrl && !firedFirstFrame.current) {
      firedFirstFrame.current = true;
      onFirstFrame?.();
    }
  }, [frameUrl, onFirstFrame]);

  /**
   * Display coordinates → guest coordinates.
   *
   * The captured PNG is at full device resolution, so naturalWidth/naturalHeight give the scale
   * factor directly — no separate `wm size` round trip needed. A CSS rotate on the image (the
   * tool-rail control) is inverted here so taps still land on the pixel that was clicked.
   */
  function toGuest(clientX: number, clientY: number): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const turn = cssRotation(img);
    if (turn === 0) {
      return {
        x: Math.round((clientX - rect.left) * (img.naturalWidth / rect.width)),
        y: Math.round((clientY - rect.top) * (img.naturalHeight / rect.height)),
      };
    }

    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    const localX = turn === 90 ? 1 - ny : turn === 180 ? 1 - nx : ny;
    const localY = turn === 90 ? nx : turn === 180 ? 1 - ny : 1 - nx;
    return {
      x: Math.round(localX * img.naturalWidth),
      y: Math.round(localY * img.naturalHeight),
    };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLImageElement>) {
    downRef.current = { x: event.clientX, y: event.clientY, at: Date.now() };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLImageElement>) {
    const down = downRef.current;
    downRef.current = null;
    if (!down) return;

    const start = toGuest(down.x, down.y);
    const end = toGuest(event.clientX, event.clientY);
    if (!start || !end) return;

    const travelled = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (travelled < SWIPE_THRESHOLD_PX) {
      window.openEmu.tap(end.x, end.y);
      return;
    }

    // Real elapsed time, so a slow drag scrolls and a flick flings — Android reads velocity from
    // the gesture's duration, and a fixed value would make every swipe feel the same.
    const duration = Math.min(1500, Math.max(60, Date.now() - down.at));
    window.openEmu.swipe(start.x, start.y, end.x, end.y, duration);
  }

  // The guest's window is over this pane. Anything drawn here would be hidden behind it, and the
  // pointer handlers below would never see an event — the child window takes its own input, which
  // is exactly why embedding removes the per-gesture adb round trip.
  if (embedded) return <div className={className ?? 'android-screen'} aria-label={alt} role="img" />;

  return (
    <div className={className ?? 'android-screen'}>
      {frameUrl ? (
        <img
          ref={imgRef}
          src={frameUrl}
          alt={alt}
          draggable={false}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
        />
      ) : (
        (placeholder ?? (
          <div className="waiting">
            <span className="waiting-mark waiting-mark-live" aria-hidden="true">
              <span className="waiting-screen" />
            </span>
            <span>{waitingLabel}</span>
          </div>
        ))
      )}
    </div>
  );
}
