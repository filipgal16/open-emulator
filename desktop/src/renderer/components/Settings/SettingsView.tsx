import { useEffect, useState } from 'react';
import type { DefenderState } from '../../../shared/ipc-types';
import {
  DENSITY_MAX,
  DENSITY_MIN,
  DENSITY_STEP,
  DEVICES,
  DEVICE_IDS,
  RAM_HOST_RESERVE_MB,
  RAM_MAX_MB,
  RAM_MIN_MB,
  RAM_STEP_MB,
  type DeviceId,
  type Settings,
  type SettingsState,
  type ThemeChoice,
} from '../../../shared/settings-types';
import { formatBytes } from '../../../shared/store-types';
import { SHORTCUT_HELP } from '../../keyboard';
import { applyDocumentTheme } from '../../theme';
import { Icon } from '../Icon';
import { SliderField } from './SliderField';
import { UpdatesBlock } from './UpdatesBlock';

const THEMES: Array<{ id: ThemeChoice; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/**
 * Settings. A full-area panel in the stage, never a overlay on the device — a native child
 * window will later paint over the viewport, so this replaces the device rather than covering it.
 */
export function SettingsView() {
  const [state, setState] = useState<SettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freeing, setFreeing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let live = true;
    void window.openEmu.settingsState().then((next) => {
      if (!live) return;
      applyDocumentTheme(next.settings.theme);
      setState(next);
    }).catch((err: unknown) => {
      if (live) setError(err instanceof Error ? err.message : 'Could not load settings');
    });
    return () => {
      live = false;
    };
  }, []);

  async function patch(partial: Partial<Settings>) {
    adopt(await window.openEmu.settingsSet(partial));
  }

  async function freeSpace() {
    setFreeing(true);
    try {
      adopt(await window.openEmu.settingsFreeSpace());
    } finally {
      setFreeing(false);
    }
  }

  async function chooseFolder() {
    setMoving(true);
    try {
      adopt(await window.openEmu.settingsChooseDownloadFolder());
    } catch (err: unknown) {
      setState((prev) =>
        prev
          ? { ...prev, lastMessage: err instanceof Error ? err.message : 'Could not change the folder.' }
          : prev,
      );
    } finally {
      setMoving(false);
    }
  }

  function adopt(next: SettingsState) {
    applyDocumentTheme(next.settings.theme);
    setState((prev) => ({
      ...next,
      lastMessage: next.lastMessage ?? prev?.lastMessage,
    }));
  }

  async function restartApp() {
    setRestarting(true);
    try {
      await window.openEmu.settingsRestartApp();
    } catch (err: unknown) {
      setRestarting(false);
      setState((prev) =>
        prev
          ? { ...prev, lastMessage: err instanceof Error ? err.message : 'Could not restart.' }
          : prev,
      );
    }
  }

  if (error) {
    return (
      <div className="settings">
        <div className="empty-panel">
          <span className="empty-panel-icon" aria-hidden="true">
            <Icon name="alert" size={22} />
          </span>
          <p className="empty-title">Settings didn't load</p>
          <p className="empty-copy">{error}</p>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <section className="settings" aria-labelledby="settings-title" aria-busy="true">
        <div className="settings-sheet">
          <header className="settings-head">
            <h2 id="settings-title">Settings</h2>
            <p className="settings-lead" role="status">
              Reading what this machine is using, and what you can change…
            </p>
          </header>
          <div className="skeleton-stack" aria-hidden="true">
            <span className="skeleton skeleton-title" />
            <span className="skeleton skeleton-block" />
            <span className="skeleton skeleton-block" />
            <span className="skeleton skeleton-title" />
            <span className="skeleton skeleton-block" />
          </div>
        </div>
      </section>
    );
  }

  const { settings, tuning, storage, engine, lastMessage } = state;
  // The live session still uses `storage.root` until relaunch; after a successful move the
  // chosen folder is `downloadRoot` and the two differ until then.
  const pendingRestart =
    settings.downloadRoot !== null && !sameFolder(settings.downloadRoot, storage.root);
  const shownRoot = pendingRestart && settings.downloadRoot ? settings.downloadRoot : storage.root;
  const storageBusy = moving || freeing || restarting;

  return (
    <section className="settings" aria-labelledby="settings-title">
      <div className="settings-sheet">
        <header className="settings-head">
          <h2 id="settings-title">Settings</h2>
          <p className="settings-lead">
            Theme applies immediately. Device identity and performance take effect the next time
            you start the device — they are baked in at boot.
          </p>
        </header>

        {!tuning.accelerated && (
          <aside className="settings-banner" role="status">
            <span className="settings-banner-icon" aria-hidden="true">
              <Icon name="circle" size={16} />
            </span>
            <div>
              <p className="settings-banner-title">Left to do before a fast start</p>
              <p className="settings-banner-copy">{tuning.accelerationDetail}</p>
            </div>
          </aside>
        )}

        <section className="settings-block">
          <h3 className="settings-label">Appearance</h3>
          <div className="settings-seg" role="radiogroup" aria-label="Theme">
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={settings.theme === theme.id}
                className={settings.theme === theme.id ? 'settings-seg-item on' : 'settings-seg-item'}
                onClick={() => void patch({ theme: theme.id })}
              >
                {theme.label}
              </button>
            ))}
          </div>
          <p className="settings-hint">
            {settings.theme === 'system'
              ? 'Follows Windows. Light or dark is an override that stays put.'
              : 'This window only — Windows itself is unchanged.'}
          </p>
        </section>

        <section className="settings-block">
          <h3 className="settings-label">Device identity</h3>
          <p className="settings-copy">
            Stock images identify as brand "Android", model "mainline", and plenty of apps refuse
            to run on that. Picking a real handset is a compatibility feature, not a skin.
          </p>
          <div className="settings-devices" role="radiogroup" aria-label="Device identity">
            {DEVICE_IDS.map((id) => (
              <DeviceChoice
                key={id}
                id={id}
                selected={settings.device === id}
                onSelect={() => void patch({ device: id })}
              />
            ))}
          </div>
          <p className="settings-pending">
            Takes effect the next time you start the device. The identity is baked in at boot, so
            a running device keeps reporting the previous one until then.
          </p>
        </section>

        <section className="settings-block">
          <h3 className="settings-label">Display</h3>
          <p className="settings-note">
            The screen follows this window: make the window larger and Android has more room.
            What is set here is how big Android draws things inside it.
          </p>

          <SliderField
            label="Interface size"
            value={settings.density}
            automatic={tuning.autoDensity}
            min={DENSITY_MIN}
            max={DENSITY_MAX}
            step={DENSITY_STEP}
            unit="dpi"
            describe={(density) => `${density} dpi`}
            minLabel="Smaller, more on screen"
            maxLabel="Larger"
            hint={densityHint}
            onCommit={(density) => void patch({ density })}
          />
        </section>

        <section className="settings-block">
          <h3 className="settings-label">Performance</h3>
          <dl className="settings-facts">
            <div>
              <dt>This PC</dt>
              <dd>
                {tuning.hostCpus} {tuning.hostCpus === 1 ? 'core' : 'cores'} · {formatRam(tuning.hostRamMb)}
              </dd>
            </div>
            <div>
              <dt>Graphics</dt>
              <dd>{gpuLabel(tuning.gpuMode)}</dd>
            </div>
            {tuning.accelerated && (
              <div>
                <dt>Acceleration</dt>
                <dd>{tuning.accelerationDetail}</dd>
              </div>
            )}
          </dl>

          <SliderField
            label="Processor"
            value={settings.cores}
            automatic={tuning.autoCores}
            min={1}
            max={Math.min(32, Math.max(1, tuning.hostCpus))}
            step={1}
            unit="cores"
            describe={coresLabel}
            hint={(cores, automatic) => coresHint(cores, automatic, tuning.hostCpus, tuning.accelerated)}
            onCommit={(cores) => void patch({ cores })}
          />

          <SliderField
            label="Memory"
            value={settings.ramMb}
            automatic={tuning.autoRamMb}
            min={RAM_MIN_MB}
            max={ramCeilingMb(tuning.hostRamMb)}
            step={RAM_STEP_MB}
            unit="GB"
            toShown={(mb) => mb / 1024}
            fromShown={(gb) => gb * 1024}
            describe={formatRam}
            hint={(ramMb, automatic) => ramHint(ramMb, automatic, tuning.autoRamMb, tuning.hostRamMb)}
            onCommit={(ramMb) => void patch({ ramMb })}
          />

          <p className="settings-pending">
            Processor and memory take effect the next time you start the device. The first start
            after a change takes longer, because Android boots fresh instead of resuming.
          </p>

          <DefenderField />
        </section>

        <section className="settings-block">
          <h3 className="settings-label">Storage</h3>

          <div className="settings-folder" aria-busy={moving}>
            <div className="settings-folder-head">
              <p className="settings-field-label">Where Android is downloaded</p>
              <button
                type="button"
                className="setup-secondary"
                disabled={storageBusy}
                onClick={() => void chooseFolder()}
              >
                {moving ? (
                  <>
                    <Icon name="loader" size={14} />
                    Moving…
                  </>
                ) : (
                  'Change folder'
                )}
              </button>
            </div>
            <p className="settings-path">{shownRoot}</p>
            <p className="settings-hint">{downloadHint(storage.totalBytes, pendingRestart)}</p>
          </div>

          {(lastMessage || pendingRestart) && (
            <div
              className={
                lastMessage && !lastMessage.includes('takes effect when open-emulator restarts')
                  ? 'settings-apply is-warn'
                  : 'settings-apply'
              }
              role="status"
              aria-live="polite"
            >
              <p>
                {lastMessage ??
                  'The new location takes effect when open-emulator restarts.'}
              </p>
              {pendingRestart && (
                <button
                  type="button"
                  className="setup-primary"
                  disabled={storageBusy}
                  onClick={() => void restartApp()}
                >
                  {restarting ? 'Restarting…' : 'Restart to apply'}
                </button>
              )}
            </div>
          )}

          {storage.reclaimableBytes > 0 ? (
            <>
              <p className="settings-copy">
                {formatBytes(storage.reclaimableBytes)} of archives and scratch can be removed.
                This never touches the extracted SDK or apps installed on the device.
              </p>
              <button
                type="button"
                className="setup-primary"
                disabled={storageBusy}
                onClick={() => void freeSpace()}
              >
                {freeing ? 'Freeing…' : `Free ${formatBytes(storage.reclaimableBytes)}`}
              </button>
            </>
          ) : (
            <div className="settings-quiet">
              <p className="settings-quiet-title">Nothing to free</p>
              <p className="settings-copy">
                There are no leftover archives or scratch files. Freeing space never deletes the
                SDK or a guest's installed apps — and right now there is nothing else to take.
              </p>
            </div>
          )}
        </section>

        <UpdatesBlock />

        <section className="settings-block">
          <h3 className="settings-label">Keyboard</h3>
          <p className="settings-copy">
            These work anywhere except while typing in a field.
          </p>
          <ul className="settings-shortcuts">
            {SHORTCUT_HELP.map((row) => (
              <li key={row.keys}>
                <kbd>{row.keys}</kbd>
                <span>{row.action}</span>
              </li>
            ))}
          </ul>
        </section>

        <p className="settings-engine">{engineLabel(engine)}</p>
      </div>
    </section>
  );
}

/**
 * Opt-in Windows Defender exclusion. Only flips on an explicit click — the OS then shows a UAC
 * prompt — and never pretends the folder is unprotected when the status cannot be read.
 */
function DefenderField() {
  const [state, setState] = useState<DefenderState | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.openEmu.defenderState().then(
      (next) => {
        if (live) setState(next);
      },
      () => {
        if (live) setState('unknown');
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const known = state === 'excluded' || state === 'not-excluded';
  const on = state === 'excluded';
  const unavailable = state === 'unknown' || state === null;

  async function toggle() {
    if (pending || !known) return;
    const next = !on;
    const previous = state;
    setPending(true);
    setMessage(null);
    setState(next ? 'excluded' : 'not-excluded');
    try {
      const result = await window.openEmu.defenderSetExcluded(next);
      setState(result.state);
      if (result.error) setMessage('Change cancelled');
    } catch {
      setState(previous);
      setMessage('Change cancelled');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="settings-field">
      <div className="settings-toggle-row">
        <p className="settings-field-label" id="settings-defender-label">
          Speed up Android
        </p>
        <div className="settings-toggle-control">
          {pending && <Icon name="loader" size={14} />}
          <button
            type="button"
            role={unavailable ? undefined : 'switch'}
            className={
              [
                'settings-toggle',
                on ? 'on' : '',
                unavailable ? 'is-unknown' : '',
              ].filter(Boolean).join(' ')
            }
            aria-checked={unavailable ? undefined : on}
            aria-labelledby="settings-defender-label"
            aria-busy={pending}
            disabled={pending || unavailable}
            onClick={() => void toggle()}
          />
        </div>
      </div>
      <p className="settings-hint">
        {state === 'unknown'
          ? "Antivirus status couldn't be read."
          : "Skips antivirus scanning of this app's folder so Android boots faster — Windows will ask for administrator permission, and you can turn this off here anytime."}
      </p>
      {message && state !== 'unknown' && (
        <p className="settings-hint" role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}

function DeviceChoice({
  id,
  selected,
  onSelect,
}: {
  id: DeviceId;
  selected: boolean;
  onSelect: () => void;
}) {
  const spec = DEVICES[id];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={selected ? 'settings-device on' : 'settings-device'}
      onClick={onSelect}
    >
      <span className="settings-device-label">
        {spec.label}
        {selected && (
          <span className="settings-device-check" aria-hidden="true">
            <Icon name="check" size={14} />
          </span>
        )}
      </span>
      <span className="settings-device-desc">{spec.description}</span>
    </button>
  );
}

function coresLabel(cores: number): string {
  return cores === 1 ? '1 core' : `${cores} cores`;
}

function coresHint(cores: number, automatic: boolean, hostCpus: number, accelerated: boolean): { text: string; warn?: boolean } {
  if (!accelerated) {
    return automatic
      ? { text: 'Without acceleration Android runs in software, and two cores is the measured best. More just fight each other.' }
      : { text: 'Without acceleration, more than two cores usually makes Android slower, not faster.', warn: cores > 2 };
  }
  if (automatic) {
    return { text: `Uses ${coresLabel(cores)} of this PC's ${hostCpus}, leaving the rest for Windows.` };
  }
  if (cores >= hostCpus) {
    return { text: 'That is every core this PC has. Windows and Android will compete for them, and both get slower.', warn: true };
  }
  return { text: `${coresLabel(cores)} of this PC's ${hostCpus}. Games rarely use more than six.` };
}

/** The most the slider offers: what the PC has, less what Windows keeps, on a step the slider can rest on. */
function ramCeilingMb(hostRamMb: number): number {
  const usable = Math.min(RAM_MAX_MB, hostRamMb - RAM_HOST_RESERVE_MB);
  return Math.max(RAM_MIN_MB, Math.floor(usable / RAM_STEP_MB) * RAM_STEP_MB);
}

function ramHint(ramMb: number, automatic: boolean, autoRamMb: number, hostRamMb: number): { text: string; warn?: boolean } {
  if (automatic) {
    return { text: `Gives Android ${formatRam(ramMb)}: enough for most apps, and quick to resume.` };
  }
  if (ramMb > hostRamMb / 2) {
    return {
      text: `More than half of this PC's ${formatRam(hostRamMb)}. Windows may slow down while Android is running.`,
      warn: true,
    };
  }
  if (ramMb > autoRamMb) {
    return { text: 'More memory helps large games. Resuming takes a little longer, because there is more to bring back.' };
  }
  if (ramMb < autoRamMb) {
    return { text: `Less than the automatic ${formatRam(autoRamMb)}. Lighter on this PC, but large games may close themselves.` };
  }
  return { text: 'The same as automatic.' };
}

function densityHint(density: number, automatic: boolean): { text: string } {
  if (automatic) return { text: "Keeps the chosen device's own size." };
  if (density <= 200) return { text: 'Tablet-sized: small text and a lot of room. Takes effect the next time you start the device.' };
  if (density >= 400) return { text: 'Phone-sized: large text and buttons. Takes effect the next time you start the device.' };
  return { text: 'Takes effect the next time you start the device.' };
}

function formatRam(mb: number): string {
  return formatBytes(mb * 1024 * 1024);
}

function gpuLabel(mode: string): string {
  if (mode === 'host') return "This PC's GPU";
  if (mode === 'swiftshader_indirect') return 'Software (SwiftShader)';
  if (mode === 'angle_indirect') return 'ANGLE';
  return mode;
}

/** Windows paths from the picker and from the live layout can differ by slash and trailing slash. */
function sameFolder(a: string, b: string): boolean {
  const norm = (value: string) =>
    value.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function downloadHint(totalBytes: number, pending: boolean): string {
  const lead =
    'This is several gigabytes — the largest thing the app puts on a disk, and the usual reason to move it is a small system drive.';
  const move = 'Changing the folder moves what has already been downloaded; nothing is re-downloaded.';
  if (pending) return `${lead} ${move}`;
  const size = totalBytes > 0 ? `${formatBytes(totalBytes)} is here right now.` : 'Nothing is here yet.';
  return `${lead} ${size} ${move}`;
}

function engineLabel(engine: string): string {
  if (engine === 'sdk') return 'Running natively on Windows';
  if (engine === 'wsl') return 'Running through WSL2';
  if (engine === 'qemu') return 'Running under QEMU';
  return `Runtime: ${engine}`;
}
