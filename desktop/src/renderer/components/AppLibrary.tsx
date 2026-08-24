import { useEffect, useState } from 'react';
import type { InstalledApp } from '../../shared/ipc-types';

/** The apps installed in the guest. Click one to launch it. */
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

  if (apps === null) {
    return (
      <div className="library library-loading">
        <div className="empty-state empty-state-center">
          <p className="empty-title">Reading installed apps…</p>
        </div>
      </div>
    );
  }

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

  return (
    <div className="library">
      <div className="library-head">
        <h2>Your apps</h2>
        <p className="library-sub">Installed on this device</p>
      </div>
      {apps.length === 0 && (
        <div className="empty-state">
          <p className="empty-title">Nothing installed yet</p>
          <p className="library-empty">
            Open the Store to browse F-Droid, or drop an APK onto the Store to install one
            directly.
          </p>
        </div>
      )}
      <div className="app-grid">{tiles}</div>
    </div>
  );
}
