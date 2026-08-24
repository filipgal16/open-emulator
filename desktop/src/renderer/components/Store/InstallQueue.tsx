import type { InstallJob, InstallState } from '../../../shared/store-types';
import { formatBytes } from '../../../shared/store-types';
import { Icon, type IconName } from '../Icon';

interface Props {
  jobs: InstallJob[];
  onDismiss: (id: string) => void;
}

const PIPELINE: InstallState[] = ['queued', 'downloading', 'verifying', 'installing'];

function stageIndex(state: InstallState): number {
  if (state === 'done') return PIPELINE.length;
  if (state === 'failed') return -1;
  return PIPELINE.indexOf(state);
}

function describe(job: InstallJob): { title: string; detail: string } {
  switch (job.state) {
    case 'queued':
      return { title: 'Queued', detail: 'Waiting to start' };
    case 'downloading': {
      const percent = job.bytesTotal > 0 ? Math.round((job.bytesDone / job.bytesTotal) * 100) : null;
      return {
        title: percent !== null ? `Downloading · ${percent}%` : 'Downloading',
        detail:
          job.bytesTotal > 0
            ? `${formatBytes(job.bytesDone)} of ${formatBytes(job.bytesTotal)}`
            : formatBytes(job.bytesDone),
      };
    }
    case 'verifying':
      return { title: 'Verifying', detail: 'Checking the file against its published digest' };
    case 'installing':
      return { title: 'Installing', detail: 'Writing into the device' };
    case 'done':
      return { title: 'Installed', detail: 'Ready to open from Apps' };
    case 'failed':
      return { title: 'Couldn’t install', detail: job.error ?? 'Something went wrong' };
  }
}

function statusIcon(state: InstallState): IconName {
  switch (state) {
    case 'done':
      return 'check';
    case 'failed':
      return 'alert';
    case 'queued':
      return 'circle';
    default:
      return 'loader';
  }
}

/**
 * Progress for whatever is being installed.
 *
 * Only shown when there is something to say. A permanently-present empty panel is just a strip of
 * wasted vertical space in a window that also has to hold a phone screen.
 */
export function InstallQueue({ jobs, onDismiss }: Props) {
  if (jobs.length === 0) return null;

  return (
    <div className="install-queue" role="region" aria-label="Install progress">
      {jobs.map((job) => {
        const fraction = job.bytesTotal > 0 ? Math.min(1, job.bytesDone / job.bytesTotal) : 0;
        const indeterminate = job.state === 'installing' || job.state === 'verifying';
        const current = stageIndex(job.state);
        const copy = describe(job);
        const barWidth =
          job.state === 'done' ? 100 : job.state === 'queued' ? 0 : indeterminate ? 100 : fraction * 100;

        return (
          <div key={job.id} className={`install-row install-${job.state}`}>
            <div className="install-row-head">
              <span className="install-state-icon" aria-hidden="true">
                <Icon name={statusIcon(job.state)} size={14} />
              </span>
              <span className="install-label">{job.label}</span>
              {(job.state === 'done' || job.state === 'failed') && (
                <button
                  type="button"
                  className="install-dismiss"
                  onClick={() => onDismiss(job.id)}
                  aria-label="Dismiss"
                >
                  <Icon name="x" size={16} />
                </button>
              )}
            </div>

            <ol className="install-pipeline" aria-label="Install stages">
              {PIPELINE.map((step, index) => {
                const reached = current > index || job.state === 'done';
                const on = current === index;
                return (
                  <li
                    key={step}
                    className={`install-pipe-step ${reached ? 'is-done' : ''} ${on ? 'is-on' : ''} ${job.state === 'failed' ? 'is-fail' : ''}`}
                  >
                    <span className="install-pipe-dot" />
                    {index < PIPELINE.length - 1 && <span className="install-pipe-line" />}
                  </li>
                );
              })}
            </ol>

            <span
              className="install-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={indeterminate ? undefined : Math.round(barWidth)}
              aria-label={copy.title}
            >
              <span
                className={`install-fill ${indeterminate ? 'install-fill-pulsing' : ''}`}
                style={{ width: `${barWidth}%` }}
              />
            </span>

            <div className="install-meta">
              <span className="install-status" aria-live="polite">
                {copy.title}
              </span>
              <span className="install-detail">{copy.detail}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
