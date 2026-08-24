import { useEffect, useRef, useState } from 'react';
import type { StoreState } from '../../../shared/store-types';
import { GuestSurface } from '../GuestSurface';

interface Props {
  state: StoreState;
  onRecheck: () => void;
}

/**
 * The real Google Play client, framed.
 *
 * There is no catalogue behind this tab and no Play API client anywhere in the shell. Google's own
 * app runs in the guest, this mirrors it, and the search box fires a `market://` intent at it. The
 * upside is not just legal tidiness: Play's UI, its account handling, and its installs are always
 * exactly current, because they are Play's, and nothing here can break when Google changes an
 * interface we were never calling.
 */
export function PlayFrame({ state, onRecheck }: Props) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const opened = useRef(false);

  /**
   * Switch this device to the Play-enabled Android and prepare it.
   *
   * Two steps rather than one because they fail differently: switching is refused outright while
   * the emulator is running, and only if it succeeded is there any point downloading 4 GB.
   */
  async function enablePlay() {
    setSwitching(true);
    setSwitchError(null);
    try {
      const switched = await window.openEmu.deviceSetProfile('play');
      if (switched.error) {
        setSwitchError(switched.error);
        return;
      }
      const prepared = await window.openEmu.devicePrepare();
      if (prepared.error) setSwitchError(prepared.error);
      onRecheck();
    } catch (err) {
      setSwitchError((err as Error).message);
    } finally {
      setSwitching(false);
    }
  }

  // Bring Play to the front once when the tab is first shown with a guest that has it.
  useEffect(() => {
    if (!state.playAvailable || opened.current) return;
    opened.current = true;
    void window.openEmu.playOpen();
  }, [state.playAvailable]);

  if (!state.playAvailable) {
    return (
      <div className="play-setup">
        <h2>Google Play isn&apos;t on this device</h2>
        <p>
          This device is running the fast version of Android, which leaves Google Play out so it
          starts quickly. Switching to the Play Store version downloads Google&apos;s own
          Play-enabled Android and keeps it as a separate device — your current one is untouched.
        </p>
        <p className="play-note">
          About 4 GB to download, and the first start takes a few minutes. After that it is as quick
          as the others.
        </p>

        <div className="play-setup-actions">
          <button
            type="button"
            className="setup-primary"
            disabled={switching}
            onClick={() => void enablePlay()}
          >
            {switching ? 'Setting up…' : 'Install Google Play'}
          </button>
          <button type="button" className="device-btn" onClick={onRecheck}>
            Check again
          </button>
        </div>

        {switchError && <p className="play-warning">{switchError}</p>}
        <p className="play-note">
          You can also do this from the Android version menu in the status bar, or from a terminal with
          <code> ANDROID_PROFILE=play make android-fetch android-setup android-provision</code>.
        </p>
      </div>
    );
  }

  async function run(action: () => Promise<boolean>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="play-frame">
      {state.identitySpoofed && (
        <p className="play-warning">
          This guest is reporting a spoofed device identity. Play is certified against the image&apos;s
          own fingerprint, so sign-in will likely fail with &ldquo;device is not Play Protect
          certified&rdquo;. Run the Play profile on the stock <code>generic</code> device identity.
        </p>
      )}

      <form
        className="play-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => window.openEmu.playSearch(query));
        }}
      >
        <button type="button" className="play-nav" aria-label="Back" onClick={() => void run(() => window.openEmu.playBack())}>
          ←
        </button>
        <button type="button" className="play-nav" onClick={() => void run(() => window.openEmu.playOpen())}>
          Store
        </button>
        <input
          className="play-search"
          type="search"
          placeholder="Search Google Play…"
          aria-label="Search Google Play"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="store-install" disabled={busy}>
          Search
        </button>
      </form>

      <GuestSurface
        className="play-surface"
        waitingLabel="Waiting for the guest to paint…"
        alt="Live view of Google Play on the Android device"
      />
    </div>
  );
}
