import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from './Icon';
import { peekGuestFrame } from '../hooks/useGuestScreen';
import { isTypingTarget, rovingIndex } from '../keyboard';

interface Props {
  /** Guest is up and can receive keys. */
  live: boolean;
  theater: boolean;
  theaterButtonRef?: Ref<HTMLButtonElement>;
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
export function ToolRail({ live, theater, theaterButtonRef, onToggleTheater, onRotate }: Props) {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'ArrowLeft' || !event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      if (!live) return;
      send('KEYCODE_BACK');
      event.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live]);

  function onRailKey(event: ReactKeyboardEvent<HTMLElement>) {
    const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const next = rovingIndex(event.key, index, buttons.length);
    if (next < 0) return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  let tabAssigned = false;
  function tabStop(disabled?: boolean): number {
    if (disabled) return -1;
    if (tabAssigned) return -1;
    tabAssigned = true;
    return 0;
  }

  return (
    <aside
      ref={rootRef}
      className="tool-rail"
      role="toolbar"
      aria-label="Device controls"
      aria-orientation="vertical"
      onKeyDown={onRailKey}
    >
      <ToolGroup>
        <ToolButton
          name="back"
          label="Back"
          shortcut="Alt+ArrowLeft"
          disabled={!live}
          tabIndex={tabStop(!live)}
          onClick={() => send('KEYCODE_BACK')}
        />
        <ToolButton name="home" label="Home" disabled={!live} tabIndex={tabStop(!live)} onClick={() => send('KEYCODE_HOME')} />
        <ToolButton name="recents" label="Recents" disabled={!live} tabIndex={tabStop(!live)} onClick={() => send('KEYCODE_APP_SWITCH')} />
      </ToolGroup>
      <span className="tool-rail-rule" aria-hidden="true" />
      <ToolGroup>
        <ToolButton name="rotate" label="Rotate" tabIndex={tabStop()} onClick={onRotate} />
        <ToolButton name="screenshot" label="Screenshot" disabled={!live} tabIndex={tabStop(!live)} onClick={saveScreenshot} />
        <ToolButton
          name={theater ? 'fullscreen-exit' : 'fullscreen'}
          label={theater ? 'Exit fullscreen' : 'Fullscreen'}
          shortcut="Escape"
          pressed={theater}
          tabIndex={tabStop()}
          buttonRef={theaterButtonRef}
          onClick={onToggleTheater}
        />
      </ToolGroup>
      <span className="tool-rail-spacer" />
      <ToolGroup>
        <ToolButton name="volume-down" label="Volume down" disabled={!live} tabIndex={tabStop(!live)} onClick={() => send('KEYCODE_VOLUME_DOWN')} />
        <ToolButton name="volume-up" label="Volume up" disabled={!live} tabIndex={tabStop(!live)} onClick={() => send('KEYCODE_VOLUME_UP')} />
        <ToolButton name="power" label="Power" disabled={!live} tabIndex={tabStop(!live)} onClick={() => send('KEYCODE_POWER')} />
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
  shortcut,
  onClick,
  disabled,
  pressed,
  tabIndex,
  buttonRef,
}: {
  name: IconName;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  tabIndex?: number;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const hint = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      ref={buttonRef}
      type="button"
      className="tool-btn"
      title={hint}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      aria-pressed={pressed}
      tabIndex={tabIndex}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={name} size={18} />
    </button>
  );
}
