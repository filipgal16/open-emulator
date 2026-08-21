import { useEffect, useState } from 'react';
import { AdSlot } from './AdSlot';

/** How long before the user can dismiss it by hand. */
const SKIP_AFTER_MS = 5000;

interface Props {
  /** Called when the user skips. The boot itself dismisses this by unmounting the component. */
  onSkip: () => void;
}

/**
 * Covers the boot wait, and only the boot wait.
 *
 * Three rules keep this on the right side of the line between an ad and a hostage situation: it
 * appears only while the guest is booting and nothing else could be on screen anyway, it
 * disappears by itself the moment the first frame arrives, and the skip control is real — after
 * five seconds it dismisses immediately, with no second prompt.
 *
 * If nothing fills, the overlay never appears at all rather than showing an empty box.
 */
export function AdInterstitial({ onSkip }: Props) {
  const [filled, setFilled] = useState<boolean | null>(null);
  const [skippable, setSkippable] = useState(false);
  const [countdown, setCountdown] = useState(Math.ceil(SKIP_AFTER_MS / 1000));

  useEffect(() => {
    if (filled !== true) return;
    const tick = window.setInterval(() => setCountdown((n) => Math.max(0, n - 1)), 1000);
    const timer = window.setTimeout(() => setSkippable(true), SKIP_AFTER_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
  }, [filled]);

  if (filled === false) return null;

  return (
    <div className={`ad-interstitial${filled ? '' : ' ad-interstitial-probing'}`} role="dialog" aria-label="Sponsored message">
      <div className="ad-interstitial-card">
        <AdSlot slot="boot-interstitial" onFill={setFilled} />
        <div className="ad-interstitial-actions">
          <span className="ad-interstitial-status">Starting Android…</span>
          <button type="button" className="ad-skip" disabled={!skippable} onClick={onSkip}>
            {skippable ? 'Skip' : `Skip in ${countdown}`}
          </button>
        </div>
      </div>
    </div>
  );
}
