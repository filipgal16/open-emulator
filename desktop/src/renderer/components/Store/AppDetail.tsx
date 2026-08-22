import { useEffect, useState } from 'react';
import type { AppDetail as AppDetailData, InstallJob, StoreApp } from '../../../shared/store-types';
import { formatBytes, installBlockedReason } from '../../../shared/store-types';

interface Props {
  app: StoreApp;
  job: InstallJob | null;
  guestSdk: number | null;
  installed: boolean;
  onBack: () => void;
  onInstall: (app: StoreApp, versionCode: number | null) => void;
}

/**
 * One app, expanded.
 *
 * Links are rendered as text rather than anchors. The shell deliberately has no "open this URL"
 * primitive reachable from the renderer — the ad system routes clicks through opaque tokens for
 * exactly that reason — and a store page is not a good enough reason to add one.
 */
export function AppDetail({ app, job, guestSdk, installed, onBack, onInstall }: Props) {
  const [detail, setDetail] = useState<AppDetailData | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    window.openEmu.storeDetail(app.source, app.packageName).then((next) => {
      if (live) setDetail(next);
    });
    return () => {
      live = false;
    };
  }, [app.source, app.packageName]);

  const blocked = installBlockedReason(app, guestSdk);
  const busy = job !== null && job.state !== 'done' && job.state !== 'failed';
  const here = installed || job?.state === 'done';

  return (
    <div className="store-detail">
      <button type="button" className="store-back" onClick={onBack}>
        ← Back to results
      </button>

      <header className="store-detail-head">
        {app.iconUrl ? (
          <img className="store-detail-icon" src={app.iconUrl} alt="" />
        ) : (
          <span className="store-detail-icon store-card-icon-fallback" aria-hidden="true">
            {app.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="store-detail-title">
          <h2>{app.name}</h2>
          <p className="store-detail-summary">{app.summary}</p>
          <p className="store-detail-package">{app.packageName}</p>
        </div>
        <button
          type="button"
          className="store-install store-install-large"
          disabled={busy || here || (blocked !== null && job?.state !== 'failed')}
          title={blocked ?? undefined}
          onClick={() => onInstall(app, null)}
        >
          {here ? 'Installed' : busy ? 'Working…' : blocked ? 'Unavailable' : 'Install'}
        </button>
      </header>

      {blocked && !here && <p className="store-detail-blocked">{blocked}</p>}
      {job?.state === 'failed' && <p className="store-detail-blocked">{job.error}</p>}

      {detail && detail.screenshotUrls.length > 0 && (
        <div className="store-shots">
          {detail.screenshotUrls.map((url) => (
            <img key={url} src={url} alt="" className="store-shot" />
          ))}
        </div>
      )}

      <dl className="store-facts">
        <dt>Version</dt>
        <dd>
          {app.versionName || '—'} ({app.versionCode || '—'})
        </dd>
        <dt>Size</dt>
        <dd>{formatBytes(app.sizeBytes)}</dd>
        <dt>Minimum API</dt>
        <dd>{app.minSdk > 0 ? app.minSdk : '—'}</dd>
        <dt>Native code</dt>
        <dd>{app.abis.length > 0 ? app.abis.join(', ') : 'none — runs on any guest'}</dd>
        {app.license && (
          <>
            <dt>Licence</dt>
            <dd>{app.license}</dd>
          </>
        )}
        {app.categories.length > 0 && (
          <>
            <dt>Categories</dt>
            <dd>{app.categories.join(', ')}</dd>
          </>
        )}
        {detail?.webSite && (
          <>
            <dt>Website</dt>
            <dd className="store-facts-url">{detail.webSite}</dd>
          </>
        )}
        {detail?.sourceCode && (
          <>
            <dt>Source</dt>
            <dd className="store-facts-url">{detail.sourceCode}</dd>
          </>
        )}
      </dl>

      {app.antiFeatures.length > 0 && (
        <p className="store-card-flags">
          {app.antiFeatures.map((flag) => (
            <span key={flag} className="store-flag">
              {flag}
            </span>
          ))}
        </p>
      )}

      {detail === null ? (
        <p className="store-detail-loading">Loading…</p>
      ) : (
        detail.description && <p className="store-description">{detail.description}</p>
      )}

      {detail && detail.otherVersions.length > 0 && (
        <div className="store-versions">
          <h3>Other versions</h3>
          {detail.otherVersions.map((version) => (
            <div key={version.versionCode} className="store-version-row">
              <span>{version.versionName}</span>
              <span className="store-version-meta">
                API {version.minSdk}+ · {formatBytes(version.sizeBytes)}
              </span>
              <button
                type="button"
                className="store-install store-install-small"
                disabled={busy || (guestSdk !== null && version.minSdk > guestSdk)}
                onClick={() => onInstall(app, version.versionCode)}
              >
                Install
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
