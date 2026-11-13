import { useEffect, useState } from 'react';
import type { DefenderState } from '../../../shared/ipc-types';
import { DEVICES, DEVICE_IDS, type DeviceId, type Settings, type SettingsState, type ThemeChoice } from '../../../shared/settings-types';
import { formatBytes } from '../../../shared/store-types';
import { SHORTCUT_HELP } from '../../keyboard';
import { applyDocumentTheme } from '../../theme';
import { Icon } from '../Icon';

const THEMES: Array<{ id: ThemeChoice; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const CORE_PRESETS = [2, 4, 6, 8, 12];
const RAM_PRESETS_MB = [2048, 3072, 4096, 6144, 8192];

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
  // `tuning.cores` / `tuning.ramMb` are the effective values (override applied). The Automatic
  // chip still needs the measured default beside a pin, so that is derived from the host facts
  // using the same rules the engine uses — and taken from `tuning` itself when nothing is pinned.
  const autoCores = settings.cores === null ? tuning.cores : automaticCores(tuning.hostCpus, tuning.accelerated);
  const autoRamMb = settings.ramMb === null ? tuning.ramMb : automaticRamMb(tuning.hostRamMb, tuning.accelerated);
  const coreOptions = numberedChoices(CORE_PRESETS, tuning.hostCpus, settings.cores, autoCores, 1, 32);
  const ramOptions = numberedChoices(RAM_PRESETS_MB, Math.min(tuning.hostRamMb, 16_384), settings.ramMb, autoRamMb, 1024, 16_384);
  const ramRaised = settings.ramMb !== null && settings.ramMb > autoRamMb;

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

          <div className="settings-field">
            <p className="settings-field-label" id="settings-cores-label">Processor</p>
            <div className="settings-pills" role="radiogroup" aria-labelledby="settings-cores-label">
              <AutoPill
                selected={settings.cores === null}
                detail={`${autoCores} ${autoCores === 1 ? 'core' : 'cores'}`}
                onSelect={() => void patch({ cores: null })}
              />
              {coreOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={settings.cores === value}
                  className={settings.cores === value ? 'settings-pill on' : 'settings-pill'}
                  onClick={() => void patch({ cores: value })}
                >
                  {value}
                </button>
              ))}
            </div>
            <p className="settings-hint">
              {tuning.accelerated
                ? 'Automatic leaves one core for Windows and caps at twelve — past that, boots stop getting faster.'
                : 'Without acceleration, two cores is the measured default. More threads just fight the software CPU.'}
            </p>
          </div>

          <div className="settings-field">
            <p className="settings-field-label" id="settings-ram-label">Memory</p>
            <div className="settings-pills" role="radiogroup" aria-labelledby="settings-ram-label">
              <AutoPill
                selected={settings.ramMb === null}
                detail={formatRam(autoRamMb)}
                onSelect={() => void patch({ ramMb: null })}
              />
              {ramOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={settings.ramMb === value}
                  className={settings.ramMb === value ? 'settings-pill on' : 'settings-pill'}
                  onClick={() => void patch({ ramMb: value })}
                >
                  {formatRam(value)}
                </button>
              ))}
            </div>
            <p className={ramRaised ? 'settings-hint is-warn' : 'settings-hint'}>
              {ramRaised
                ? `This is more than the automatic ${formatRam(autoRamMb)}. Resume will take longer — warm start is dominated by restoring the snapshot's memory image, which grows with this setting.`
                : "More memory makes the guest slower to resume. Warm start is dominated by restoring the snapshot's memory image, which grows with the setting."}
            </p>
          </div>

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

function AutoPill({
  selected,
  detail,
  onSelect,
}: {
  selected: boolean;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={selected ? 'settings-pill settings-pill-auto on' : 'settings-pill settings-pill-auto'}
      onClick={onSelect}
    >
      Automatic
      <span className="settings-pill-detail">{detail}</span>
    </button>
  );
}

/** Unique sorted values: presets that fit this machine, plus the automatic answer and any override. */
function numberedChoices(
  presets: number[],
  cap: number,
  current: number | null,
  automatic: number,
  min: number,
  max: number,
): number[] {
  const ceiling = Math.min(max, Math.max(min, cap));
  const values = new Set(presets.filter((value) => value >= min && value <= ceiling));
  if (automatic >= min && automatic <= ceiling) values.add(automatic);
  if (current !== null && current >= min && current <= max) values.add(current);
  return [...values].sort((a, b) => a - b);
}

function automaticCores(hostCpus: number, accelerated: boolean): number {
  if (!accelerated) return 2;
  return Math.min(12, Math.max(1, hostCpus - 1));
}

function automaticRamMb(hostRamMb: number, accelerated: boolean): number {
  return hostRamMb < (accelerated ? 4096 : 5120) ? 2048 : 3072;
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
