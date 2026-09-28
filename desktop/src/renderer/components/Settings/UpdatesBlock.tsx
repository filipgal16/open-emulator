import { useState } from 'react';
import type { UpdateState } from '../../../shared/update-types';
import { useUpdateState } from '../../hooks/useUpdateState';
import { Icon } from '../Icon';

/**
 * Settings → Updates.
 *
 * A check can run on its own; a download never does. Every step past "a new version exists" is a
 * button someone presses, and the copy says so, so nobody wonders whether the app is about to
 * restart under them.
 */
export function UpdatesBlock() {
  const state = useUpdateState();
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  const { title, detail } = describe(state);
  const failed = state.phase === 'error';

  return (
    <section className="settings-block" aria-labelledby="settings-updates-title">
      <h3 className="settings-label" id="settings-updates-title">
        Updates
      </h3>

      <div
        className={failed ? 'settings-apply is-warn settings-update-card' : 'settings-quiet settings-update-card'}
        role="status"
        aria-live="polite"
      >
        <p className={failed ? undefined : 'settings-quiet-title'}>{title}</p>
        {detail && <p className="settings-copy">{detail}</p>}
        {state.phase === 'downloading' && (
          <div
            className="setup-bar settings-update-bar"
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.percent ?? 0}
          >
            <span className="setup-bar-fill" style={{ width: `${state.percent ?? 0}%` }} />
          </div>
        )}
      </div>

      <UpdateAction state={state} busy={busy} run={run} />
    </section>
  );
}

function UpdateAction({
  state,
  busy,
  run,
}: {
  state: UpdateState;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  switch (state.phase) {
    case 'available':
      return (
        <button
          type="button"
          className="setup-primary settings-update-action"
          disabled={busy}
          onClick={() => void run(() => window.openEmu.updateDownload())}
        >
          Download {state.latestVersion}
        </button>
      );
    case 'ready':
      return (
        <button
          type="button"
          className="setup-primary settings-update-action"
          disabled={busy}
          onClick={() => void run(() => window.openEmu.updateInstall())}
        >
          Restart to update
        </button>
      );
    case 'idle':
    case 'up-to-date':
    case 'error':
      return (
        <button
          type="button"
          className="setup-secondary settings-update-action"
          disabled={busy}
          onClick={() => void run(() => window.openEmu.updateCheck())}
        >
          {busy ? (
            <>
              <Icon name="loader" size={14} />
              Checking…
            </>
          ) : state.phase === 'idle' ? (
            'Check for updates'
          ) : state.phase === 'error' ? (
            'Try again'
          ) : (
            'Check again'
          )}
        </button>
      );
    default:
      // unsupported, checking, downloading: there is nothing to press.
      return null;
  }
}

function describe(state: UpdateState): { title: string; detail: string | null } {
  const current = state.currentVersion;
  switch (state.phase) {
    case 'unsupported':
      return { title: `open-emulator ${current}`, detail: state.message };
    case 'idle':
      return {
        title: `open-emulator ${current}`,
        detail: 'New versions are looked for in the background. Nothing is downloaded until you choose to.',
      };
    case 'checking':
      return { title: 'Checking for updates…', detail: null };
    case 'up-to-date':
      return {
        title: "You're up to date",
        detail: `${current} is the latest version.${state.checkedAt ? ` Last checked ${formatWhen(state.checkedAt)}.` : ''}`,
      };
    case 'available':
      return {
        title: `Version ${state.latestVersion} is available`,
        detail: `You have ${current}. It downloads only when you press the button.`,
      };
    case 'downloading':
      return { title: `Downloading ${state.latestVersion ?? 'the update'}… ${state.percent ?? 0}%`, detail: null };
    case 'ready':
      return {
        title: `${state.latestVersion ?? 'The update'} is ready to install`,
        detail: 'open-emulator restarts to install it. If you close the app instead, it installs then.',
      };
    case 'error':
      return { title: state.message ?? 'Updating failed.', detail: null };
  }
}

function formatWhen(epochMs: number): string {
  const when = new Date(epochMs);
  const today = new Date().toDateString() === when.toDateString();
  return today
    ? `at ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : `on ${when.toLocaleDateString()}`;
}
