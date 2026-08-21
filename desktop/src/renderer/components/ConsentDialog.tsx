import { useState } from 'react';
import type { AdsState } from '../../shared/ads-types';

interface Props {
  onResolved: (state: AdsState) => void;
}

/**
 * Shown only when a third-party ad network is configured and the user is in a jurisdiction where
 * loading its tag needs prior consent.
 *
 * Both buttons are equally weighted and equally final. A consent prompt where refusing is harder
 * than accepting is not consent, and regulators have said so repeatedly — quite apart from it
 * being a rotten thing to do to someone who just wanted to run an emulator.
 *
 * Declining is genuinely safe to do: it turns off the third-party rung only. Affiliate and house
 * ads keep running, because neither ever needed consent.
 */
export function ConsentDialog({ onResolved }: Props) {
  const [busy, setBusy] = useState(false);

  async function answer(granted: boolean) {
    setBusy(true);
    try {
      onResolved(await window.openEmu.adsSetConsent(granted));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="modal">
        <h2 id="consent-title">Personalised ads?</h2>
        <p>
          open-emulator is free and paid for by ads. With your permission, our ad partner can use
          cookies to choose which ads you see and to measure whether they worked.
        </p>
        <p className="modal-note">
          You can say no. You'll still see ads — they just won't be personalised, and nothing about
          you leaves this machine. You can change this later in Settings.
        </p>
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => answer(false)}>
            No, keep it anonymous
          </button>
          <button type="button" disabled={busy} onClick={() => answer(true)}>
            Yes, personalise
          </button>
        </div>
      </div>
    </div>
  );
}
