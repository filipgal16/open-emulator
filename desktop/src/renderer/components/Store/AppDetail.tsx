import { useEffect, useState } from 'react';
import type { AppDetail as AppDetailData, InstallJob, StoreApp } from '../../../shared/store-types';
import { formatBytes, installBlockedReason } from '../../../shared/store-types';
import { AppMark } from '../AppMark';
import { Icon } from '../Icon';
import { antiFeatureLabel, compatibilityCopy, sourceLabel } from './copy';

interface Props {
  app: StoreApp;
  job: InstallJob | null;
  guestSdk: number | null;
  installed: boolean;
  backLabel?: string;
  onBack: () => void;
  onInstall: (app: StoreApp, versionCode: number | null) => void;
}

function actionLabel(job: InstallJob | null, here: boolean, blocked: string | null, busy: boolean): string {
  if (here) return 'Installed';
  if (job?.state === 'failed') return 'Retry';
  if (busy) {
    switch (job?.state) {
      case 'queued':
        return 'Queued';
      case 'downloading':
        return job.bytesTotal > 0 ? `${Math.round((job.bytesDone / job.bytesTotal) * 100)}%` : 'Downloading';
      case 'verifying':
        return 'Verifying';
      case 'installing':
        return 'Installing';
      default:
        return 'Working…';
    }
  }
  if (blocked) return 'Unavailable';
  return 'Install';
}

/**
 * One app, expanded.
 *
 * Links are rendered as text rather than anchors. The shell deliberately has no "open this URL"
 * primitive reachable from the renderer — the ad system routes clicks through opaque tokens for
 * exactly that reason — and a store page is not a good enough reason to add one.
 */
export function AppDetail({ app, job, guestSdk, installed, backLabel = 'Back', onBack, onInstall }: Props) {
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
  const compat = compatibilityCopy(app, guestSdk);
  const busy = job !== null && job.state !== 'done' && job.state !== 'failed';
  const here = installed || job?.state === 'done';

  return (
    <div className="store-detail">
      <button type="button" className="store-back" onClick={onBack}>
        <Icon name="back" size={16} />
        {backLabel}
      </button>

      <header className="store-detail-head">
        {app.iconUrl ? (
          <img className="store-detail-icon" src={app.iconUrl} alt="" />
        ) : (
          <AppMark name={app.name} seed={app.packageName} size={72} />
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
          title={compat.sentence ?? undefined}
          onClick={() => onInstall(app, null)}
        >
          {actionLabel(job, here, blocked, busy)}
        </button>
      </header>

      {compat.sentence && !here && (
        <p className={`store-compat store-compat-${compat.kind}`}>{compat.sentence}</p>
      )}
      {job?.state === 'failed' && <p className="store-detail-error">{job.error}</p>}

      <ul className="store-facts-strip">
        <li>
          <span className="store-facts-k">Version</span>
          <span className="store-facts-v">{app.versionName || '—'}</span>
        </li>
        <li>
          <span className="store-facts-k">Size</span>
          <span className="store-facts-v">{formatBytes(app.sizeBytes)}</span>
        </li>
        {app.license && (
          <li>
            <span className="store-facts-k">Licence</span>
            <span className="store-facts-v">{app.license}</span>
          </li>
        )}
        <li>
          <span className="store-facts-k">Minimum API</span>
          <span className="store-facts-v">{app.minSdk > 0 ? app.minSdk : '—'}</span>
        </li>
        <li>
          <span className="store-facts-k">Source</span>
          <span className="store-facts-v">{sourceLabel(app.source)}</span>
        </li>
      </ul>

      {detail && detail.screenshotUrls.length > 0 && (
        <div className="store-shots">
          {detail.screenshotUrls.map((url) => (
            <img key={url} src={url} alt="" className="store-shot" />
          ))}
        </div>
      )}

      <dl className="store-facts">
        <dt>Native code</dt>
        <dd>{app.abis.length > 0 ? app.abis.join(', ') : 'None — runs on any device'}</dd>
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
        <div className="store-anti">
          <h3>Things to know</h3>
          <ul>
            {app.antiFeatures.map((flag) => (
              <li key={flag}>{antiFeatureLabel(flag)}</li>
            ))}
          </ul>
        </div>
      )}

      {detail === null ? (
        <p className="store-detail-loading">Loading description…</p>
      ) : (
        detail.description && (
          <div className="store-description-block">
            <h3>About</h3>
            <p className="store-description">{detail.description}</p>
          </div>
        )
      )}

      {detail && detail.otherVersions.length > 0 && (
        <div className="store-versions">
          <h3>Other versions</h3>
          {detail.otherVersions.map((version) => {
            const tooNew = guestSdk !== null && version.minSdk > guestSdk;
            return (
              <div key={version.versionCode} className="store-version-row">
                <span>{version.versionName}</span>
                <span className="store-version-meta">
                  API {version.minSdk}+ · {formatBytes(version.sizeBytes)}
                  {tooNew ? ' · needs a newer Android than this device' : ''}
                </span>
                <button
                  type="button"
                  className="store-install store-install-small"
                  disabled={busy || tooNew}
                  title={
                    tooNew
                      ? `This build needs API ${version.minSdk}. This device is on API ${guestSdk}.`
                      : undefined
                  }
                  onClick={() => onInstall(app, version.versionCode)}
                >
                  Install
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
