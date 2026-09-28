import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../../shared/update-types';
import { scheduleChecks, UpdateService, type Updater } from './update-service';

export interface UpdatesRuntime {
  registerIpc(getWindow: () => BrowserWindow | null): void;
  /**
   * Restarts through the installer if a downloaded update is waiting, and says whether it did.
   *
   * For any other restart the app does: relaunching normally while an update is downloaded would
   * start the new instance at the same moment the install-on-quit runs over its files.
   */
  installIfReady(): boolean;
  dispose(): void;
}

/**
 * Self-update, from this repository's GitHub releases.
 *
 * Where to look comes from the `publish` block in package.json: electron-builder writes it into the
 * installed app as `app-update.yml`, and publishes `latest.yml` next to each installer. No URL is
 * configured anywhere else, so a development run has nothing to check and says so.
 */
export function createUpdates(onLog: (line: string) => void = () => undefined): UpdatesRuntime {
  const log = (message: unknown) => onLog(`[update] ${String(message)}`);
  autoUpdater.logger = { info: log, warn: log, error: log };

  let getWindow: () => BrowserWindow | null = () => null;
  const service = new UpdateService({
    updater: app.isPackaged ? (autoUpdater as unknown as Updater) : null,
    currentVersion: app.getVersion(),
    onChange: (state: UpdateState) => getWindow()?.webContents.send('update:state', state),
  });
  let stopSchedule: (() => void) | null = null;

  return {
    registerIpc(windowGetter) {
      getWindow = windowGetter;
      ipcMain.handle('update:state', (): UpdateState => service.get());
      ipcMain.handle('update:check', (): Promise<UpdateState> => service.check());
      ipcMain.handle('update:download', (): Promise<UpdateState> => service.download());
      ipcMain.handle('update:install', (): boolean => service.install());
      stopSchedule = scheduleChecks(service);
    },
    installIfReady: () => service.install(),
    dispose() {
      stopSchedule?.();
      stopSchedule = null;
    },
  };
}
