import { useEffect, useRef, useState } from 'react';
import type { DeviceState, ProfileId } from '../../shared/device-types';
import { INITIAL_DEVICE_STATE, PROFILE_IDS, PROFILES } from '../../shared/device-types';
import { Icon } from './Icon';
import { isTypingTarget, rovingIndex } from '../keyboard';

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
 * Ambient status bar: start, stop, prepare, and which Android to run.
 *
 * All of this used to be terminal-only — `open-emu start`, `ANDROID_PROFILE=play make
 * android-provision`. The CLI still works and is unchanged; this is the same surface with buttons,
 * so that installing the app is enough to use it.
 */
export function DeviceBar({ onState }: Props) {
  const [state, setState] = useState<DeviceState>(INITIAL_DEVICE_STATE);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function apply(next: DeviceState) {
    setState(next);
    onState?.(next);
  }

  function closeMenu() {
    setOpen(false);
    triggerRef.current?.focus();
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

  useEffect(() => {
    if (!open) return;
    const selected = Math.max(0, PROFILE_IDS.indexOf(state.profile));
    optionRefs.current[selected]?.focus();
  }, [open, state.profile]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenu();
        return;
      }
      if (event.key !== 's' && event.key !== 'S') return;
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      if (state.busy) return;
      event.preventDefault();
      const running = state.phase === 'running';
      void (running ? window.openEmu.deviceStop() : window.openEmu.deviceStart()).then(apply);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, state.busy, state.phase]);

  const running = state.phase === 'running';
  const profile = PROFILES[state.profile];
  const startLabel = state.busy ? 'Working…' : running ? 'Stop' : 'Start';

  return (
    <div className="device-status">
      {open && (
        <div className="device-menu" role="listbox" aria-label="Android version" id="device-version-menu">
          <p className="device-menu-head" id="device-version-label">
            Android version
          </p>
          {PROFILE_IDS.map((id, index) => {
            const spec = PROFILES[id];
            return (
              <button
                key={id}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={id === state.profile}
                className={`device-menu-item ${id === state.profile ? 'on' : ''}`}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                  void window.openEmu.deviceSetProfile(id as ProfileId).then(apply);
                }}
                onKeyDown={(event) => {
                  const next = rovingIndex(event.key, index, PROFILE_IDS.length);
                  if (next < 0) return;
                  event.preventDefault();
                  optionRefs.current[next]?.focus();
                }}
              >
                <span className="device-menu-label">
                  {spec.label}
                  {id === state.profile && (
                    <span className="device-menu-check" aria-hidden="true">
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
      )}

      <div className="device-bar">
        <span
          className={`device-dot device-dot-${running ? (state.bootCompleted ? 'on' : 'boot') : state.phase}`}
          aria-hidden="true"
        />
        <span className="device-phase" aria-live="polite" aria-atomic="true">
          {phaseLabel(state)}
        </span>

        {state.androidVersion && (
          <span className="device-meta">
            Android {state.androidVersion}
            {state.api ? ` · API ${state.api}` : ''}
          </span>
        )}

        <span className="device-spacer" />

        {state.error && (
          <span className="device-error" role="status">
            {state.error}
          </span>
        )}

        {!state.provisioned && !state.busy && (
          <button type="button" className="device-btn device-btn-primary" onClick={() => void window.openEmu.devicePrepare().then(apply)}>
            Prepare device
          </button>
        )}

        <button
          type="button"
          className={`device-btn ${running ? 'device-btn-stop' : 'device-btn-primary'}`}
          disabled={state.busy}
          aria-keyshortcuts="Alt+S"
          title={`${startLabel} (Alt+S)`}
          onClick={() => void (running ? window.openEmu.deviceStop() : window.openEmu.deviceStart()).then(apply)}
        >
          {startLabel}
        </button>

        <div className="device-profile">
          <button
            ref={triggerRef}
            type="button"
            className="device-btn"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls="device-version-menu"
            aria-label={`Android version, ${profile.label}`}
            onClick={() => setOpen((value) => !value)}
            disabled={state.busy}
          >
            {profile.label}
            <Icon name="chevron-down" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
