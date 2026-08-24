import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { peekGuestFrame } from '../hooks/useGuestScreen';

interface Props {
  /** Guest is up and can receive keys. */
  live: boolean;
  theater: boolean;
  onToggleTheater: () => void;
  onRotate: () => void;
}

function send(code: string) {
  window.openEmu.key(code);
}

function saveScreenshot() {
  const url = peekGuestFrame();
  if (!url) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const link = document.createElement('a');
  link.href = url;
  link.download = `open-emulator-${stamp}.png`;
  link.click();
}

/**
 * Right rail: Android system keys first, then capture and chrome.
 *
 * Lives beside the viewport on purpose — a native child window will later paint over the device,
 * so these controls must never float on top of it.
 */
export function ToolRail({ live, theater, onToggleTheater, onRotate }: Props) {
  return (
    <aside className="tool-rail" aria-label="Device controls">
      <ToolGroup>
        <ToolButton name="back" label="Back" disabled={!live} onClick={() => send('KEYCODE_BACK')} />
        <ToolButton name="home" label="Home" disabled={!live} onClick={() => send('KEYCODE_HOME')} />
        <ToolButton name="recents" label="Recents" disabled={!live} onClick={() => send('KEYCODE_APP_SWITCH')} />
      </ToolGroup>
      <span className="tool-rail-rule" aria-hidden="true" />
      <ToolGroup>
        <ToolButton name="rotate" label="Rotate" onClick={onRotate} />
        <ToolButton name="screenshot" label="Screenshot" disabled={!live} onClick={saveScreenshot} />
        <ToolButton
          name={theater ? 'fullscreen-exit' : 'fullscreen'}
          label={theater ? 'Exit fullscreen' : 'Fullscreen'}
          pressed={theater}
          onClick={onToggleTheater}
        />
      </ToolGroup>
      <span className="tool-rail-spacer" />
      <ToolGroup>
        <ToolButton name="volume-down" label="Volume down" disabled={!live} onClick={() => send('KEYCODE_VOLUME_DOWN')} />
        <ToolButton name="volume-up" label="Volume up" disabled={!live} onClick={() => send('KEYCODE_VOLUME_UP')} />
        <ToolButton name="power" label="Power" disabled={!live} onClick={() => send('KEYCODE_POWER')} />
      </ToolGroup>
    </aside>
  );
}

function ToolGroup({ children }: { children: ReactNode }) {
  return <div className="tool-rail-group">{children}</div>;
}

function ToolButton({
  name,
  label,
  onClick,
  disabled,
  pressed,
}: {
  name: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className="tool-btn"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={name} size={18} />
    </button>
  );
}
