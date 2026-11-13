import { useEffect, useState } from 'react';
import type { InstalledApp } from '../../shared/ipc-types';
import { AppMark } from './AppMark';
import { Icon } from './Icon';

interface Props {
  onOpenStore: () => void;
}

/** Two rows at the usual window width — enough to read as a grid, not so many it looks like a result. */
const SKELETON_TILES = 10;

/** The apps installed in the guest. Click one to launch it. */
export function AppLibrary({ onOpenStore }: Props) {
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
      // The shape of what is coming, rather than a spinner in an empty room: the head it will
      // have, and tiles where the apps will be.
      <div className="library" aria-busy="true">
        <div className="library-head">
          <h2>Your apps</h2>
          <p className="library-sub" role="status">
            Asking the device what it has…
          </p>
        </div>
        <div className="app-grid" aria-hidden="true">
          {Array.from({ length: SKELETON_TILES }, (_, index) => (
            <div key={index} className="app-tile app-tile-skeleton">
              <span className="skeleton skeleton-icon" />
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-line-short" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="library">
        <div className="library-head">
          <h2>Your apps</h2>
          <p className="library-sub">Installed on this device</p>
        </div>
        <div className="empty-panel">
          <span className="empty-panel-icon" aria-hidden="true">
            <Icon name="apps" size={22} />
          </span>
          <p className="empty-title">Nothing installed yet</p>
          <p className="empty-copy">
            The Store has thousands of free apps, or drop an APK onto it to install one of your
            own. Anything you install shows up here.
          </p>
          <button type="button" className="setup-primary" onClick={onOpenStore}>
            Open the Store
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="library">
      <div className="library-head">
        <h2>Your apps</h2>
        <p className="library-sub">
          {apps.length === 1 ? '1 app installed on this device' : `${apps.length} apps installed on this device`}
        </p>
      </div>
      <div className="app-grid">
        {apps.map((app) => {
          const launching = busy === app.packageName;
          return (
            <button
              key={app.packageName}
              type="button"
              className="app-tile"
              disabled={launching}
              onClick={() => void launch(app.packageName)}
            >
              <span className="app-icon-wrap">
                {launching ? (
                  <span className="app-mark app-mark-busy" aria-hidden="true">
                    <Icon name="loader" size={20} />
                  </span>
                ) : (
                  <AppMark name={app.label} seed={app.packageName} />
                )}
              </span>
              <span className="app-label">{app.label}</span>
              <span className="app-package">{app.packageName}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
