import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import path from 'path';
import type { AppDetail, InstallJob, SourceId, StoreApp, StoreState } from '../../shared/store-types';
import { SOURCES } from '../../shared/store-types';
import type { AppLibrary } from '../app-library';
import { ImageCache } from '../image-cache';
import type { OpenEmuClient } from '../open-emu-client';
import { repoRootWinPath } from '../win-paths';
import { Catalog } from './catalog';
import { GuestFactsProbe } from './guest-facts';
import { Installer } from './installer';
import { PlayController } from './play';
import { FdroidSource } from './sources/fdroid';
import { LocalSource } from './sources/local';

export const APP_SCHEME = 'oe-app';

const MAX_SEARCH_LIMIT = 120;
/** Icons are small and there are thousands of them; the cap is generous on purpose. */
const MAX_ICON_BYTES = 4 * 1024 * 1024;

/**
 * Must run before `app.whenReady()`, alongside the ad schemes.
 *
 * App icons and screenshots reach the renderer over `oe-app://` for the same reason ad creatives
 * use `oe-ad://`: the window keeps a CSP with no remote origins, so it cannot be tracked by, or
 * leak anything to, whoever is hosting the art.
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

export function createStore(
  openEmu: OpenEmuClient,
  library: AppLibrary,
  onLog: (line: string) => void = () => undefined,
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
  const installer = new Installer(openEmu, library, path.join(userData, 'store-apks'), { onLog: log });
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

  ipcMain.handle('store:import-apk', (_event, filePath: unknown): boolean => {
    if (typeof filePath !== 'string') return false;
    try {
      local.import(filePath);
      getWindow()?.webContents.send('store:index-updated', state());
      return true;
    } catch (err) {
      log(`could not import APK: ${(err as Error).message}`);
      return false;
    }
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
