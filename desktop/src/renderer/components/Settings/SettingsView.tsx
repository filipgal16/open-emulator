import { useEffect, useState } from 'react';
import { DEVICES, DEVICE_IDS, type DeviceId, type Settings, type SettingsState, type ThemeChoice } from '../../../shared/settings-types';
import { formatBytes } from '../../../shared/store-types';
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
    const next = await window.openEmu.settingsSet(partial);
    applyDocumentTheme(next.settings.theme);
    setState(next);
  }

  async function freeSpace() {
    setFreeing(true);
    try {
      setState(await window.openEmu.settingsFreeSpace());
    } finally {
      setFreeing(false);
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
      <div className="settings settings-loading">
        <div className="empty-panel">
          <span className="empty-panel-icon" aria-hidden="true">
            <Icon name="loader" size={22} />
          </span>
          <p className="empty-title">Reading settings</p>
          <p className="empty-copy">What this machine is using, and what you can change.</p>
        </div>
      </div>
    );
  }

  const { settings, tuning, storage, engine } = state;
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
          <aside className="settings-banner is-warn" role="status">
            <span className="settings-banner-icon" aria-hidden="true">
              <Icon name="alert" size={16} />
            </span>
            <div>
              <p className="settings-banner-title">This device will be drastically slower</p>
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
        </section>

        <section className="settings-block">
          <h3 className="settings-label">Storage</h3>
          <dl className="settings-facts">
            <div>
              <dt>In use</dt>
              <dd>{formatBytes(storage.totalBytes)}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd className="settings-path">{storage.root}</dd>
            </div>
          </dl>

          {storage.reclaimableBytes > 0 ? (
            <>
              <p className="settings-copy">
                {formatBytes(storage.reclaimableBytes)} of archives and scratch can be removed.
                This never touches the extracted SDK or apps installed on the device.
              </p>
              <button
                type="button"
                className="setup-primary"
                disabled={freeing}
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

        <p className="settings-engine">{engineLabel(engine)}</p>
      </div>
    </section>
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

function engineLabel(engine: string): string {
  if (engine === 'sdk') return 'Running natively on Windows';
  if (engine === 'wsl') return 'Running through WSL2';
  if (engine === 'qemu') return 'Running under QEMU';
  return `Runtime: ${engine}`;
}
