import type { InstallJob, StoreState } from '../../shared/store-types';

/**
 * Fan-out for the store's push events.
 *
 * The preload bridge registers listeners with `ipcRenderer.on` and offers no way to remove one, so
 * a component that subscribes directly would stack up a duplicate listener every time its tab was
 * revisited — and fire its handler once per visit ever made. Registration happens once here;
 * components come and go from the subscriber sets.
 */
type Listener<T> = (value: T) => void;

const jobListeners = new Set<Listener<InstallJob>>();
const installedListeners = new Set<Listener<string>>();
const indexListeners = new Set<Listener<StoreState>>();

let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  window.openEmu.onStoreJob((job) => {
    for (const listener of jobListeners) listener(job);
  });
  window.openEmu.onStoreInstalled((packageName) => {
    for (const listener of installedListeners) listener(packageName);
  });
  window.openEmu.onStoreIndexUpdated((state) => {
    for (const listener of indexListeners) listener(state);
  });
}

function subscribe<T>(set: Set<Listener<T>>, listener: Listener<T>): () => void {
  wire();
  set.add(listener);
  return () => set.delete(listener);
}

export const onJob = (listener: Listener<InstallJob>) => subscribe(jobListeners, listener);
export const onInstalled = (listener: Listener<string>) => subscribe(installedListeners, listener);
export const onIndexUpdated = (listener: Listener<StoreState>) => subscribe(indexListeners, listener);
