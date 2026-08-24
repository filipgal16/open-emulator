import { useEffect, useState } from 'react';
import type { DeviceState, ProfileId } from '../../shared/device-types';
import { INITIAL_DEVICE_STATE, PROFILE_IDS, PROFILES } from '../../shared/device-types';
import { Icon } from './Icon';

interface Props {
  onState?: (state: DeviceState) => void;
}

function phaseLabel(state: DeviceState): string {
  switch (state.phase) {
    case 'running':
      return state.bootCompleted ? 'Running' : 'Booting…';
    case 'starting':
      return 'Starting…';
    case 'stopping':
      return 'Stopping…';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Checking…';
  }
}

/**
 * The device controls: start, stop, prepare, and which Android to run.
 *
 * All of this used to be terminal-only — `open-emu start`, `ANDROID_PROFILE=play make
 * android-provision`. The CLI still works and is unchanged; this is the same surface with buttons,
 * so that installing the app is enough to use it.
 */
export function DeviceBar({ onState }: Props) {
  const [state, setState] = useState<DeviceState>(INITIAL_DEVICE_STATE);
  const [open, setOpen] = useState(false);

  function apply(next: DeviceState) {
    setState(next);
    onState?.(next);
  }

  useEffect(() => {
    void window.openEmu.deviceState().then(apply);
    window.openEmu.onDeviceState(apply);

    // The guest can also be started or stopped outside this window (the CLI still works), so the
    // panel re-reads periodically rather than trusting its own last action.
    const timer = window.setInterval(() => {
      void window.openEmu.deviceState().then(apply);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const running = state.phase === 'running';
  const profile = PROFILES[state.profile];

  return (
    <div className="device-bar">
      <span className={`device-dot device-dot-${running ? (state.bootCompleted ? 'on' : 'boot') : state.phase}`} />
      <span className="device-phase">{phaseLabel(state)}</span>

      {state.androidVersion && (
        <span className="device-meta">
          Android {state.androidVersion}
          {state.api ? ` · API ${state.api}` : ''}
        </span>
      )}

      <span className="device-spacer" />

      {state.error && <span className="device-error">{state.error}</span>}

      {!state.provisioned && !state.busy && (
        <button type="button" className="device-btn device-btn-primary" onClick={() => void window.openEmu.devicePrepare().then(apply)}>
          Prepare device
        </button>
      )}

      <button
        type="button"
        className={`device-btn ${running ? 'device-btn-stop' : 'device-btn-primary'}`}
        disabled={state.busy}
        onClick={() => void (running ? window.openEmu.deviceStop() : window.openEmu.deviceStart()).then(apply)}
      >
        {state.busy ? 'Working…' : running ? 'Stop' : 'Start'}
      </button>

      <div className="device-profile">
        <button type="button" className="device-btn" onClick={() => setOpen((v) => !v)} disabled={state.busy}>
          {profile.label}
          <Icon name="chevron-down" size={14} />
        </button>
        {open && (
          <>
            <div className="device-menu-backdrop" onClick={() => setOpen(false)} />
            <div className="device-menu">
              <p className="device-menu-head">Android version</p>
              {PROFILE_IDS.map((id) => {
                const spec = PROFILES[id];
                return (
                  <button
                    key={id}
                    type="button"
                    className={`device-menu-item ${id === state.profile ? 'on' : ''}`}
                    onClick={() => {
                      setOpen(false);
                      void window.openEmu.deviceSetProfile(id as ProfileId).then(apply);
                    }}
                  >
                    <span className="device-menu-label">
                      {spec.label}
                      {id === state.profile && (
                        <span className="device-menu-check">
                          <Icon name="check" size={14} />
                        </span>
                      )}
                    </span>
                    <span className="device-menu-desc">{spec.description}</span>
                    {spec.proprietary && (
                      <span className="device-menu-flag">Includes Google software — personal use</span>
                    )}
                  </button>
                );
              })}
              <p className="device-menu-foot">
                Each version keeps its own device and apps. Switching downloads it the first time
                ({PROFILES.play.downloadHint}) and needs the device stopped.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
