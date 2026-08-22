import type { InstallJob, StoreApp } from '../../../shared/store-types';
import { formatBytes, installBlockedReason } from '../../../shared/store-types';

interface Props {
  app: StoreApp;
  /** The in-flight or finished job for this app, if any. */
  job: InstallJob | null;
  guestSdk: number | null;
  installed: boolean;
  onOpen: (app: StoreApp) => void;
  onInstall: (app: StoreApp) => void;
}

function buttonLabel(job: InstallJob | null, installed: boolean, blocked: string | null): string {
  if (job) {
    switch (job.state) {
      case 'queued':
        return 'Queued';
      case 'downloading':
        return job.bytesTotal > 0 ? `${Math.round((job.bytesDone / job.bytesTotal) * 100)}%` : 'Downloading';
      case 'verifying':
        return 'Verifying';
      case 'installing':
        return 'Installing';
      case 'done':
        return 'Installed';
      case 'failed':
        return 'Retry';
    }
  }
  if (installed) return 'Installed';
  if (blocked) return 'Unavailable';
  return 'Install';
}

/**
 * One app in the results grid.
 *
 * The install button is disabled with a stated reason rather than the app being hidden. Someone
 * searching for an app they know exists is better served by "needs API 33" than by a result set
 * that silently pretends it isn't there.
 */
export function AppCard({ app, job, guestSdk, installed, onOpen, onInstall }: Props) {
  const blocked = installBlockedReason(app, guestSdk);
  const busy = job !== null && job.state !== 'done' && job.state !== 'failed';
  // A finished job counts as installed even when the guest's package list doesn't name this entry
  // — a local APK is tracked by filename, and the package it became is only known to the job.
  const here = installed || job?.state === 'done';
  const disabled = busy || here || (blocked !== null && job?.state !== 'failed');

  return (
    <div className="store-card">
      <button type="button" className="store-card-open" onClick={() => onOpen(app)}>
        {app.iconUrl ? (
          <img className="store-card-icon" src={app.iconUrl} alt="" />
        ) : (
          <span className="store-card-icon store-card-icon-fallback" aria-hidden="true">
            {app.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="store-card-text">
          <span className="store-card-name">{app.name}</span>
          <span className="store-card-summary">{app.summary || app.packageName}</span>
        </span>
      </button>

      <div className="store-card-foot">
        <span className="store-card-meta">
          {app.versionName && <span>{app.versionName}</span>}
          <span>{formatBytes(app.sizeBytes)}</span>
          <span className="store-card-source">{app.source}</span>
        </span>
        <button
          type="button"
          className="store-install"
          disabled={disabled}
          title={blocked ?? undefined}
          onClick={() => onInstall(app)}
        >
          {buttonLabel(job, here, blocked)}
        </button>
      </div>

      {job?.state === 'failed' && <p className="store-card-error">{job.error}</p>}
      {!job && blocked && <p className="store-card-note">{blocked}</p>}
      {app.antiFeatures.length > 0 && (
        <p className="store-card-flags">
          {app.antiFeatures.map((flag) => (
            <span key={flag} className="store-flag">
              {flag}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
