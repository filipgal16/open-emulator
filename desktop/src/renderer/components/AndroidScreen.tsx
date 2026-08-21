import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';

interface Props {
  /** Fires once, when the guest first paints — the signal that the boot wait is over. */
  onFirstFrame?: () => void;
}

export function AndroidScreen({ onFirstFrame }: Props = {}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const seenFrame = useRef(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);

  useEffect(() => {
    window.openEmu.onFrame((data: Uint8Array) => {
      if (!seenFrame.current) {
        seenFrame.current = true;
        onFirstFrame?.();
      }
      // TS's DOM lib types Uint8Array's buffer as ArrayBufferLike (possibly SharedArrayBuffer),
      // which BlobPart doesn't accept — this data always comes from a plain ArrayBuffer.
      const blob = new Blob([data as BlobPart], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = url;
      setFrameUrl(url);
    });
    window.openEmu.startMirror();
    return () => {
      window.openEmu.stopMirror();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  // The captured PNG is at full device resolution, so naturalWidth/naturalHeight give us the
  // scale factor directly — no separate `wm size` round trip needed.
  function handleClick(e: MouseEvent<HTMLImageElement>) {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    window.openEmu.tap(x, y);
  }

  return (
    <div className="android-screen">
      {frameUrl ? (
        <img ref={imgRef} src={frameUrl} onClick={handleClick} alt="Android screen" />
      ) : (
        <div className="waiting">Waiting for first frame…</div>
      )}
    </div>
  );
}
