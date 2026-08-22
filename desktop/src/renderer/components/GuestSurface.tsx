import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useGuestScreen } from '../hooks/useGuestScreen';

interface Props {
  /** Fires once, when the guest first paints — the signal that the boot wait is over. */
  onFirstFrame?: () => void;
  className?: string;
  waitingLabel?: string;
}

/** Below this much movement, a drag was someone tapping with an unsteady hand. */
const SWIPE_THRESHOLD_PX = 12;

/**
 * The mirrored guest, with pointer input forwarded.
 *
 * Shared by the Screen tab and the Store's Play frame so both behave identically — a scroll that
 * works in one and not the other would be a bug report waiting to happen, and the Play client is
 * unusable without scrolling.
 */
export function GuestSurface({ onFirstFrame, className, waitingLabel = 'Waiting for first frame…' }: Props) {
  const frameUrl = useGuestScreen();
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
   * factor directly — no separate `wm size` round trip needed.
   */
  function toGuest(clientX: number, clientY: number): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const rect = img.getBoundingClientRect();
    return {
      x: Math.round((clientX - rect.left) * (img.naturalWidth / rect.width)),
      y: Math.round((clientY - rect.top) * (img.naturalHeight / rect.height)),
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

  return (
    <div className={className ?? 'android-screen'}>
      {frameUrl ? (
        <img
          ref={imgRef}
          src={frameUrl}
          alt="Android screen"
          draggable={false}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
        />
      ) : (
        <div className="waiting">
          <span className="waiting-mark" aria-hidden="true" />
          <span>{waitingLabel}</span>
        </div>
      )}
    </div>
  );
}
