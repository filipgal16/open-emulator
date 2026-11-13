import { useEffect, useState } from 'react';
import type { DeviceState } from '../../shared/device-types';
import { GuestSurface } from './GuestSurface';

interface Props {
  device: DeviceState;
  /** Fires once, when the guest first paints — the signal that the boot wait is over. */
  onFirstFrame?: () => void;
  /** The guest's own window is showing here, so there is no frame to mirror. */
  embedded?: boolean;
}

/**
 * The device workspace.
 *
 * When the guest is up, this is the mirrored screen. Before that — the usual case, someone has
 * just opened the app — it is a panel that says what this is and offers the one action that
 * matters. Starting is its own state: a wait of up to a minute, not a blank viewport.
 */
export function AndroidScreen({ device, onFirstFrame, embedded }: Props) {
  return (
    <GuestSurface
      onFirstFrame={onFirstFrame}
      embedded={embedded}
      placeholder={<DevicePlaceholder device={device} />}
    />
  );
}

function DevicePlaceholder({ device }: { device: DeviceState }) {
  const kind = placeholderKind(device);
  // The three kinds that are one wait, seen from three points along it. The clock runs across all
  // of them without restarting, so it reads as how long the start has taken, not the current stage.
  const stage = STAGE_OF[kind];
  const coming = stage !== undefined;
  const elapsed = useElapsed(coming);
  const failed = kind === 'idle' && Boolean(device.error);

  return (
    <div className={`device-idle device-idle-${kind}${failed ? ' device-idle-error' : ''}`}>
      <span className={`waiting-mark ${coming ? 'waiting-mark-live' : ''}`} aria-hidden="true">
        <span className="waiting-screen" />
      </span>

      <h2 className="device-idle-title" aria-live="polite">
        {titleFor(kind, device)}
      </h2>
      <p className="device-idle-copy">{copyFor(kind, device)}</p>

      {coming && (
        <>
          <ol className="boot-stages" aria-label="Start progress">
            {STAGES.map((label, index) => (
              <li
                key={label}
                className={`boot-stage ${index < stage ? 'is-done' : index === stage ? 'is-now' : ''}`}
                aria-current={index === stage ? 'step' : undefined}
              >
                <span className="boot-stage-pip" aria-hidden="true" />
                {label}
              </li>
            ))}
          </ol>
          <div
            className="device-idle-bar setup-bar setup-bar-pulsing"
            role="progressbar"
            aria-label={titleFor(kind, device)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className="setup-bar-fill" style={{ width: 0 }} />
          </div>
          <p className="device-idle-elapsed" aria-live="off">
            {formatElapsed(elapsed)}
          </p>
        </>
      )}

      {failed && <p className="device-idle-error-text">{device.error}</p>}

      {kind === 'idle' && (
        <button
          type="button"
          className="setup-primary"
          disabled={device.busy}
          onClick={() => void window.openEmu.deviceStart()}
        >
          {device.error ? 'Try again' : 'Start device'}
        </button>
      )}
    </div>
  );
}

type IdleKind = 'checking' | 'idle' | 'starting' | 'booting' | 'waiting' | 'stopping';

/**
 * What a start passes through, in the words the screen shows: the emulator comes up, Android boots
 * inside it, and the first picture arrives. Each is something the device state actually reports —
 * there is no percentage to give, so this says where the wait is instead of pretending to one.
 */
const STAGES = ['Start', 'Boot', 'Display'] as const;

const STAGE_OF: Partial<Record<IdleKind, number>> = { starting: 0, booting: 1, waiting: 2 };

const FIRST_RUN_COPY =
  'First-time setup takes about a minute. You can browse Apps and the Store while this finishes — the device will be ready when you come back.';

function placeholderKind(device: DeviceState): IdleKind {
  if (device.phase === 'stopping') return 'stopping';
  if (device.phase === 'starting' || (device.busy && device.phase !== 'running')) return 'starting';
  if (device.phase === 'running') return device.bootCompleted ? 'waiting' : 'booting';
  if (device.phase === 'unknown') return 'checking';
  return 'idle';
}

function titleFor(kind: IdleKind, device: DeviceState): string {
  switch (kind) {
    case 'checking':
      return 'Looking for the device';
    case 'idle':
      return device.error ? 'Couldn’t start' : 'Your Android device';
    case 'starting':
      return device.provisioned ? 'Starting Android' : 'Preparing your device';
    case 'booting':
      return device.provisioned ? 'Booting Android' : 'Preparing your device';
    case 'waiting':
      return 'Android is running';
    case 'stopping':
      return 'Stopping';
  }
}

function copyFor(kind: IdleKind, device: DeviceState): string {
  switch (kind) {
    case 'checking':
      return 'Checking whether Android is already running.';
    case 'idle':
      return device.provisioned
        ? 'A real Android phone, on this PC. Start it to install apps and use them here.'
        : 'A real Android phone, on this PC. The first start prepares the device and can take a few minutes; later ones come back from a snapshot.';
    case 'starting':
      if (!device.provisioned) return FIRST_RUN_COPY;
      return device.snapshot
        ? 'Coming back from a snapshot — this is usually quick.'
        : 'The first boot can take up to a minute. Later starts resume from a snapshot.';
    case 'booting':
      return device.provisioned
        ? 'Android is up. Waiting for it to finish booting — this can take a minute the first time.'
        : FIRST_RUN_COPY;
    case 'waiting':
      return 'Waiting for the first frame.';
    case 'stopping':
      return 'The device is shutting down.';
  }
}

function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [active]);

  return seconds;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
