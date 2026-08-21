import { useEffect, useState } from 'react';
import { AdSlot } from './AdSlot';
import type { InstalledApp } from '../../shared/ipc-types';

/** Where the sponsored tile sits in the grid. Third position: visible, but not the first thing. */
const SPONSORED_INDEX = 2;

/**
 * The apps installed in the guest, with one clearly-labelled sponsored tile mixed into the grid.
 *
 * A sponsored tile is worth more than a banner because it's in context — someone browsing for
 * something to run is the audience an install campaign is paying for. That only holds while the
 * label is honest: the tile is visibly an ad, it never imitates an installed app, and clicking it
 * opens a store page in the browser rather than installing anything.
 */
export function AppLibrary() {
  const [apps, setApps] = useState<InstalledApp[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.openEmu.listApps().then((list) => {
      if (live) setApps(list);
    });
    return () => {
      live = false;
    };
  }, []);

  async function launch(packageName: string) {
    setBusy(packageName);
    try {
      await window.openEmu.launchApp(packageName);
    } finally {
      setBusy(null);
    }
  }

  if (apps === null) return <div className="library library-loading">Reading installed apps…</div>;

  const tiles = apps.map((app) => (
    <button
      key={app.packageName}
      type="button"
      className="app-tile"
      disabled={busy === app.packageName}
      onClick={() => void launch(app.packageName)}
    >
      <span className="app-icon" aria-hidden="true">
        {app.label.slice(0, 1).toUpperCase()}
      </span>
      <span className="app-label">{app.label}</span>
      <span className="app-package">{app.packageName}</span>
    </button>
  ));

  // Splice rather than append: a sponsored tile pinned to the end of a long list is never seen,
  // and one pinned to the front reads as a hijack of the user's own library.
  const sponsored = <AdSlot key="sponsored" slot="library-tile" />;
  tiles.splice(Math.min(SPONSORED_INDEX, tiles.length), 0, sponsored);

  return (
    <div className="library">
      <h2>Your apps</h2>
      {apps.length === 0 && (
        <p className="library-empty">
          No third-party apps installed yet. Install one with <code>open-emu install app.apk</code>.
        </p>
      )}
      <div className="app-grid">{tiles}</div>
    </div>
  );
}
