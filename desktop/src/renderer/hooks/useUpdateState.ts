import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/update-types';

type Listener = (state: UpdateState) => void;

/**
 * Module-level for the same reason as `useGuestScreen`: the preload bridge registers with
 * `ipcRenderer.on` and has no way to unregister, so the subscription is wired exactly once and
 * fanned out here. The nav rail and the Settings panel both read it.
 */
const listeners = new Set<Listener>();
let current: UpdateState | null = null;
let wired = false;

function publish(state: UpdateState): void {
  current = state;
  for (const listener of listeners) listener(state);
}

function wire(): void {
  if (wired) return;
  wired = true;
  window.openEmu.onUpdateState(publish);
  // A push that lands before this reply is newer than it, so the reply only fills an empty slot.
  void window.openEmu
    .updateState()
    .then((state) => {
      if (!current) publish(state);
    })
    .catch(() => undefined);
}

/** The app's self-update state, or null until the main process has answered once. */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(current);
  useEffect(() => {
    wire();
    listeners.add(setState);
    if (current) setState(current);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/** Whether there is something for the person to do: a version to download, or one to install. */
export function updateNeedsAttention(state: UpdateState | null): boolean {
  return state?.phase === 'available' || state?.phase === 'ready';
}
