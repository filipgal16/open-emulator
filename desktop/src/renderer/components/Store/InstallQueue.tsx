import type { InstallJob } from '../../../shared/store-types';
import { formatBytes } from '../../../shared/store-types';

interface Props {
  jobs: InstallJob[];
  onDismiss: (id: string) => void;
}

function describe(job: InstallJob): string {
  switch (job.state) {
    case 'queued':
      return 'Waiting';
    case 'downloading':
      return job.bytesTotal > 0
        ? `${formatBytes(job.bytesDone)} of ${formatBytes(job.bytesTotal)}`
        : formatBytes(job.bytesDone);
    case 'verifying':
      return 'Checking the download against its published digest';
    case 'installing':
      return 'Installing into the guest';
    case 'done':
      return 'Installed';
    case 'failed':
      return job.error ?? 'Failed';
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
    <div className="install-queue">
      {jobs.map((job) => {
        const fraction = job.bytesTotal > 0 ? Math.min(1, job.bytesDone / job.bytesTotal) : 0;
        const indeterminate = job.state === 'installing' || job.state === 'verifying';

        return (
          <div key={job.id} className={`install-row install-${job.state}`}>
            <span className="install-label">{job.label}</span>
            <span className="install-bar" role="progressbar" aria-valuenow={Math.round(fraction * 100)}>
              <span
                className={`install-fill ${indeterminate ? 'install-fill-pulsing' : ''}`}
                style={{ width: indeterminate ? '100%' : `${fraction * 100}%` }}
              />
            </span>
            <span className="install-status">{describe(job)}</span>
            {(job.state === 'done' || job.state === 'failed') && (
              <button type="button" className="install-dismiss" onClick={() => onDismiss(job.id)} aria-label="Dismiss">
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
