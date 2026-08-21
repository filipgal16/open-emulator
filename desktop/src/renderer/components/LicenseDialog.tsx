import { useState } from 'react';
import type { AdsState } from '../../shared/ads-types';

interface Props {
  onClose: () => void;
  onActivated: (state: AdsState) => void;
}

/**
 * Remove-ads licence entry.
 *
 * Verification is a local signature check — no activation call, no licence server, no account.
 * A paying user is never locked out because a backend was down, and there is no backend to run.
 */
export function LicenseDialog({ onClose, onActivated }: Props) {
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function activate() {
    if (!key.trim()) return;
    setBusy(true);
    try {
      const result = await window.openEmu.adsActivateLicense(key);
      setMessage(result.message);
      setOk(result.ok);
      if (result.ok) onActivated(result.state);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="license-title">
      <div className="modal">
        <h2 id="license-title">Remove ads</h2>
        <p>Paste the licence key from your purchase confirmation.</p>
        <input
          className="license-input"
          value={key}
          spellCheck={false}
          autoComplete="off"
          placeholder="eyJzdWIiOi….MEUCIQ…"
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void activate();
          }}
        />
        {message && <p className={ok ? 'license-ok' : 'license-error'}>{message}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {ok ? 'Done' : 'Cancel'}
          </button>
          <button type="button" disabled={busy || !key.trim()} onClick={() => void activate()}>
            {busy ? 'Checking…' : 'Activate'}
          </button>
        </div>
      </div>
    </div>
  );
}
