import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from './Icon';
import { isTypingTarget, rovingIndex } from '../keyboard';

interface Props {
  /** Guest is up and can receive keys. */
  live: boolean;
  /** Bezel is on screen. Kept mounted when hidden so Alt+← still sends Back. */
  visible: boolean;
  theater: boolean;
  theaterButtonRef?: Ref<HTMLButtonElement>;
  onToggleTheater: () => void;
  onRotate: () => void;
}

function send(code: string) {
  window.openEmu.key(code);
}

/**
 * Captures from the guest rather than reusing the last mirrored frame.
 *
 * The old version read `peekGuestFrame()`, which is empty whenever the guest's own window is
 * embedded — there are no mirrored frames then. Asking for a fresh capture works on both paths and
 * saves the guest's full resolution instead of whatever the mirror last managed.
 */
async function saveScreenshot() {
  const png = await window.openEmu.screenshot().catch(() => null);
  if (!png) return;

  const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const link = document.createElement('a');
    link.href = url;
    link.download = `open-emulator-${stamp}.png`;
    link.click();
  } finally {
    // Revoked on a turn of the event loop, not immediately: the click is handled asynchronously
    // and a revoked URL would leave the download with nothing to save.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/**
 * Guest bezel: Android system keys first, then capture and chrome.
 *
 * Lives beside the viewport on purpose — a native child window will later paint over the device,
 * so these controls must never float on top of it. Guest-only keys are omitted while the device
 * is off rather than sitting greyed out.
 */
export function ToolRail({ live, visible, theater, theaterButtonRef, onToggleTheater, onRotate }: Props) {
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
      className={visible ? 'tool-rail' : 'tool-rail is-hidden'}
      role="toolbar"
      aria-label="Device controls"
      aria-orientation="vertical"
      aria-hidden={visible ? undefined : true}
      onKeyDown={onRailKey}
    >
      {live && (
        <ToolGroup>
          <ToolButton
            name="back"
            label="Back"
            shortcut="Alt+ArrowLeft"
            tabIndex={tabStop()}
            onClick={() => send('KEYCODE_BACK')}
          />
          <ToolButton name="home" label="Home" tabIndex={tabStop()} onClick={() => send('KEYCODE_HOME')} />
          <ToolButton name="recents" label="Recents" tabIndex={tabStop()} onClick={() => send('KEYCODE_APP_SWITCH')} />
        </ToolGroup>
      )}
      {live && <span className="tool-rail-rule" aria-hidden="true" />}
      <ToolGroup>
        <ToolButton name="rotate" label="Rotate" tabIndex={tabStop()} onClick={onRotate} />
        {live && <ToolButton name="screenshot" label="Screenshot" tabIndex={tabStop()} onClick={() => void saveScreenshot()} />}
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
      {live && <span className="tool-rail-spacer" />}
      {live && (
        <ToolGroup>
          <ToolButton name="volume-down" label="Volume down" tabIndex={tabStop()} onClick={() => send('KEYCODE_VOLUME_DOWN')} />
          <ToolButton name="volume-up" label="Volume up" tabIndex={tabStop()} onClick={() => send('KEYCODE_VOLUME_UP')} />
          <ToolButton name="power" label="Power" tabIndex={tabStop()} onClick={() => send('KEYCODE_POWER')} />
        </ToolGroup>
      )}
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
