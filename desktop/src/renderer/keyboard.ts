/** True when a key event originated in a field where the key should type, not command. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return type !== 'button' && type !== 'submit' && type !== 'checkbox' && type !== 'radio';
}

export const WORKSPACE_SHORTCUTS: Array<{ digit: string; id: 'screen' | 'apps' | 'store' | 'settings' }> = [
  { digit: '1', id: 'screen' },
  { digit: '2', id: 'apps' },
  { digit: '3', id: 'store' },
  { digit: '4', id: 'settings' },
];

/** Shown in Settings so the Alt shortcuts are a feature, not folklore. */
export const SHORTCUT_HELP: Array<{ keys: string; action: string }> = [
  { keys: 'Alt+1', action: 'Device' },
  { keys: 'Alt+2', action: 'Apps' },
  { keys: 'Alt+3', action: 'Store' },
  { keys: 'Alt+4', action: 'Settings' },
  { keys: 'Alt+S', action: 'Start or stop the device' },
  { keys: 'Alt+←', action: 'Android Back' },
  { keys: 'Esc', action: 'Close the current panel, menu, or fullscreen' },
];

const ARROW_NEXT = new Set(['ArrowDown', 'ArrowRight']);
const ARROW_PREV = new Set(['ArrowUp', 'ArrowLeft']);

/**
 * Move focus among a vertical (or wrapping) group. Returns the index to select, or -1 if the
 * key was not an arrow / Home / End.
 */
export function rovingIndex(key: string, current: number, count: number): number {
  if (count <= 0) return -1;
  if (ARROW_NEXT.has(key)) return (current + 1) % count;
  if (ARROW_PREV.has(key)) return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}
