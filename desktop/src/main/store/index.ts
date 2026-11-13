import { app, BrowserWindow, dialog, ipcMain, protocol, type OpenDialogOptions } from 'electron';
import path from 'path';
import type { AppDetail, InstallJob, SourceId, StoreApp, StoreState } from '../../shared/store-types';
import { SOURCES } from '../../shared/store-types';
import type { AppLibrary } from '../guest/app-library';
import { ImageCache } from '../image-cache';
import type { OpenEmuClient } from '../engine/client';
import { repoRootWinPath } from '../platform/win-paths';
import { inspectPackageFile, PACKAGE_EXTENSIONS, PackageFileError, packageFileLabel } from './bundle';
import { Catalog } from './catalog';
import { GuestFactsProbe } from './guest-facts';
import { Installer } from './installer';
import { PlayController } from './play';
import { FdroidSource } from './sources/fdroid';
import { LocalSource } from './sources/local';

export const APP_SCHEME = 'oe-app';

const MAX_SEARCH_LIMIT = 120;
const MAX_FILES_AT_ONCE = 20;
/** Icons are small and there are thousands of them; the cap is generous on purpose. */
const MAX_ICON_BYTES = 4 * 1024 * 1024;

/**
 * Must run before `app.whenReady()`.
 *
 * App icons and screenshots reach the renderer over `oe-app://` rather than their real URLs: the
 * window keeps a CSP with no remote origins, so it cannot be tracked by, or leak anything to,
 * whoever is hosting the art.
 */
export function registerStoreSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export interface StoreRuntime {
  registerIpc(getWindow: () => BrowserWindow | null): void;
  /** Last known guest facts — the account module needs the AVD name from the same probe. */
  avdName(): string | null;
  dispose(): void;
}

/**
 * @param scratchDir Where game bundles are unpacked on their way to the guest. The engine's own
 *   `downloads` directory rather than userData: it is the multi-gigabyte cache that "free up space"
 *   empties, and an unpacked bundle is exactly that kind of file.
 */
export function createStore(
  openEmu: OpenEmuClient,
  library: AppLibrary,
  onLog: (line: string) => void = () => undefined,
  scratchDir?: string,
): StoreRuntime {
  const log = (message: string) => onLog(`[store] ${message}`);
  const userData = app.getPath('userData');

  const icons = new ImageCache(path.join(userData, 'store-icons'), {
    scheme: APP_SCHEME,
    host: 'icon',
    maxBytes: MAX_ICON_BYTES,
    onLog: log,
  });

  const fdroid = new FdroidSource(path.join(userData, 'store-fdroid-index.json'), icons, { onLog: log });
  const local = new LocalSource(
    [path.join(repoRootWinPath(), 'android', 'apps')],
    path.join(userData, 'local-apks'),
  );

  const catalog = new Catalog([local, fdroid]);
  const facts = new GuestFactsProbe(openEmu, { onLog: log });
  const installer = new Installer(openEmu, library, path.join(userData, 'store-apks'), { onLog: log, scratchDir });
  const play = new PlayController(openEmu, library, log);

  const state = (): StoreState => {
    const current = facts.current();
    return {
      indexReady: fdroid.ready,
      indexUpdatedAt: fdroid.updatedAt,
      indexAppCount: fdroid.appCount,
      guestSdk: current.sdk,
      playAvailable: current.playAvailable,
      identitySpoofed: current.identitySpoofed,
    };
  };

  let unsubscribe: (() => void) | null = null;

  return {
    avdName: () => facts.current().avdName,

    registerIpc(getWindow) {
      protocol.handle(APP_SCHEME, (request) => {
        // `oe-app://icon/<id>` and nothing else. The id is hex-validated inside the cache, so no
        // attacker-controlled text is ever joined onto a filesystem path.
        const id = new URL(request.url).pathname.replace(/^\/+/, '');
        const found = icons.read(id);
        if (!found) return new Response('not found', { status: 404 });
        // Copied into a standalone ArrayBuffer: a Buffer view can point into a shared pool slab,
        // and handing that to Response would expose neighbouring bytes.
        const body = found.bytes.buffer.slice(
          found.bytes.byteOffset,
          found.bytes.byteOffset + found.bytes.byteLength,
        ) as ArrayBuffer;
        return new Response(body, {
          headers: { 'content-type': found.mime, 'cache-control': 'no-store' },
        });
      });

      unsubscribe = installer.onUpdate((job) => {
        getWindow()?.webContents.send('store:job-update', job);
        // The Apps tab reads its list from the guest, so it only needs a nudge once something has
        // actually landed there.
        if (job.state === 'done') {
          getWindow()?.webContents.send('store:installed', job.resolvedPackage ?? job.packageName);
        }
      });

      registerStoreIpc(catalog, fdroid, local, installer, facts, play, state, getWindow, log);

      // Warm both the catalogue and the guest probe so the first visit to the tab is not the
      // first time anything is fetched.
      void fdroid.refresh().then(() => {
        getWindow()?.webContents.send('store:index-updated', state());
      });
      void facts.probe();
    },

    dispose() {
      unsubscribe?.();
    },
  };
}

function isSourceId(value: unknown): value is SourceId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SOURCES, value);
}

function registerStoreIpc(
  catalog: Catalog,
  fdroid: FdroidSource,
  local: LocalSource,
  installer: Installer,
  facts: GuestFactsProbe,
  play: PlayController,
  state: () => StoreState,
  getWindow: () => BrowserWindow | null,
  log: (message: string) => void,
): void {
  ipcMain.handle('store:state', (): StoreState => state());

  ipcMain.handle('store:probe-guest', async (_event, force: unknown): Promise<StoreState> => {
    await facts.probe(force === true);
    return state();
  });

  ipcMain.handle('store:refresh-index', async (_event, force: unknown): Promise<StoreState> => {
    await fdroid.refresh(force === true);
    return state();
  });

  ipcMain.handle('store:search', async (_event, query: unknown, source: unknown, limit: unknown): Promise<StoreApp[]> => {
    if (typeof query !== 'string') return [];
    try {
      return await catalog.search({
        query: query.slice(0, 200),
        // A source id we don't know means "all", not an error — the renderer is untrusted input
        // even though we wrote it.
        source: isSourceId(source) && source !== 'play' ? source : null,
        guestSdk: facts.current().sdk,
        limit: typeof limit === 'number' && limit > 0 ? Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)) : 60,
      });
    } catch (err) {
      log(`search failed: ${(err as Error).message}`);
      return [];
    }
  });

  ipcMain.handle('store:detail', async (_event, source: unknown, packageName: unknown): Promise<AppDetail | null> => {
    if (!isSourceId(source) || typeof packageName !== 'string') return null;
    try {
      return await catalog.detail(source, packageName, facts.current().sdk);
    } catch (err) {
      log(`detail failed: ${(err as Error).message}`);
      return null;
    }
  });

  ipcMain.handle(
    'store:install',
    async (_event, source: unknown, packageName: unknown, versionCode: unknown): Promise<InstallJob | null> => {
      if (!isSourceId(source) || typeof packageName !== 'string') return null;
      try {
        const spec = await catalog.resolve(
          source,
          packageName,
          typeof versionCode === 'number' ? versionCode : null,
          facts.current().sdk,
        );
        if (!spec) return null;
        return installer.enqueue(spec);
      } catch (err) {
        log(`install could not start: ${(err as Error).message}`);
        return null;
      }
    },
  );

  ipcMain.handle('store:jobs', (): InstallJob[] => installer.jobs());

  /**
   * Checks one file, keeps a copy under Local, and queues its install.
   *
   * The file is looked inside before it is copied, so something that is not an app never lands
   * in the Local list — it comes back as a failed job saying why, in the list the person is
   * watching.
   */
  async function installFile(filePath: string): Promise<InstallJob> {
    const label = packageFileLabel(filePath);
    try {
      inspectPackageFile(filePath);
    } catch (err) {
      return installer.refuse(label, err instanceof PackageFileError ? err.message : 'This file couldn’t be read.');
    }

    let stored: string;
    try {
      stored = await local.import(filePath);
    } catch (err) {
      log(`could not import ${filePath}: ${(err as Error).message}`);
      return installer.refuse(label, 'This file couldn’t be copied. Check there is free disk space, then try again.');
    }

    const spec = await local.resolve(path.basename(stored));
    return spec ? installer.enqueue(spec) : installer.refuse(label, 'This file couldn’t be read.');
  }

  async function installFiles(paths: string[]): Promise<InstallJob[]> {
    const jobs: InstallJob[] = [];
    for (const filePath of paths) jobs.push(await installFile(filePath));
    getWindow()?.webContents.send('store:index-updated', state());
    return jobs;
  }

  ipcMain.handle('store:install-files', (_event, paths: unknown): Promise<InstallJob[]> => {
    if (!Array.isArray(paths)) return Promise.resolve([]);
    // A drop is a handful of files; a cap keeps a stray drag of a whole folder's worth bounded.
    return installFiles(paths.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_FILES_AT_ONCE));
  });

  /**
   * The native file picker, so installing a downloaded game never needs a terminal or a drag.
   * The paths come from the dialog, not from the renderer.
   */
  ipcMain.handle('store:install-from-file', async (): Promise<InstallJob[]> => {
    const options: OpenDialogOptions = {
      title: 'Choose an app to install',
      buttonLabel: 'Install',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Android apps', extensions: PACKAGE_EXTENSIONS.map((extension) => extension.slice(1)) }],
    };
    const window = getWindow();
    const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (chosen.canceled || chosen.filePaths.length === 0) return [];
    return installFiles(chosen.filePaths.slice(0, MAX_FILES_AT_ONCE));
  });

  ipcMain.handle('store:play-open', (): Promise<boolean> => play.open());

  ipcMain.handle('store:play-search', (_event, query: unknown): Promise<boolean> => {
    return typeof query === 'string' ? play.search(query.slice(0, 200)) : Promise.resolve(false);
  });

  ipcMain.handle('store:play-details', (_event, packageName: unknown): Promise<boolean> => {
    return typeof packageName === 'string' ? play.details(packageName) : Promise.resolve(false);
  });

  ipcMain.handle('store:play-back', (): Promise<boolean> => play.back());
}
