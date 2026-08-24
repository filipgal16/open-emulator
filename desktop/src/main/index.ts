import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'path';
import { DevicePrefsStore, parseStatus } from './device-status';
import { LogHandler, WslBridge, WslTarget } from './wsl-bridge';
import { createEngine, resolveEngineId } from './engine/factory';
import { OpenEmuClient } from './open-emu-client';
import { buildSteps, SetupRunner } from './setup-wizard';
import { ScreenMirror } from './screen-mirror';
import { EngineMirror } from './engine/engine-mirror';
import { buildNativeSteps } from './engine/sdk/setup-steps';
import { loadProfile } from './engine/env-file';
import { repoRootWinPath } from './win-paths';
import { createAccount } from './account';
import { AppLibrary } from './app-library';
import { createStore, registerStoreSchemes } from './store';
import type { DeviceState, EmuPhase, ProfileId } from '../shared/device-types';
import { INITIAL_DEVICE_STATE, isProfileId } from '../shared/device-types';
import type { CommandResult, InstalledApp, SetupStepStatus } from '../shared/ipc-types';

// Config: hardcoded defaults, overridable via env vars until a first-run UI for choosing/renaming
// the distro exists. `target` is mutated in place by the setup wizard's `distro` step when it
// adopts an existing WSL2 distro under a different name — bridge/mirror read it live.
const target: WslTarget = {
  distro: process.env.OPEN_EMULATOR_WSL_DISTRO ?? 'OpenEmulator',
  remotePath: process.env.OPEN_EMULATOR_REMOTE_PATH ?? '~/open-emulator',
  // `play` selects the Google Play guest. Left unset, open-emu uses its own default profile.
  profile: process.env.OPEN_EMULATOR_ANDROID_PROFILE ?? null,
};

const bridge = new WslBridge(target);
// The one place a runtime is chosen. Everything downstream holds `openEmu` and cannot tell which
// engine is underneath — that is what makes swapping WSL for a native Windows process a local
// change rather than a rewrite.
//
// `OPEN_EMULATOR_ENGINE=sdk` opts into the native Windows runtime. WSL stays the default until the
// native engine has booted a guest on a real machine: shipping an untested runtime as the default
// would trade a slow product for a broken one.
const engineId = resolveEngineId(process.env.OPEN_EMULATOR_ENGINE);
const { engine, layout } = createEngine({
  id: engineId,
  profile: target.profile,
  wsl: { bridge, target },
  onLog: (line) => console.log(line),
});
console.log(`[engine] using the ${engineId} runtime`);
const openEmu = new OpenEmuClient(engine);

/**
 * The setup steps and the mirror both follow the engine, and have to.
 *
 * A native run driven through the WSL wizard would try to install a Linux distribution it will
 * never use, and a native guest mirrored through `ScreenMirror` would have `wsl.exe` photograph a
 * distro that is not running the emulator. Neither fails loudly — the first wastes twenty minutes,
 * the second shows a blank screen — so the choice is made once, here, alongside the engine.
 */
const setupRunner = new SetupRunner(
  engineId === 'wsl'
    ? buildSteps(bridge, openEmu, target)
    : buildNativeSteps({
        layout,
        openEmu,
        profile: () => loadProfile(path.join(repoRootWinPath(), 'android'), target.profile ?? 'fast'),
      }),
);

const mirror = engineId === 'wsl' ? new ScreenMirror(target) : new EngineMirror(engine);
const library = new AppLibrary(openEmu);

// Custom schemes have to be declared before the app is ready, so this runs at module scope.
registerStoreSchemes();

let mainWindow: BrowserWindow | null = null;
let store: ReturnType<typeof createStore> | null = null;

function createWindow(): void {
  // No File/Edit/View/Window/Help bar. Electron's default menu is a developer convenience; on a
  // consumer app it is five menus of things the user cannot act on.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#1e1e1e',
    // Paint only once there is something to paint — otherwise the window flashes white on open.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const page = path.join(__dirname, '../renderer/index.html');

  // A window that fails to load its page just shows white, with nothing anywhere saying why —
  // which is indistinguishable from the app hanging. These three turn that into a log line.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.log(`[window] failed to load ${url}: ${description} (${code})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[window] renderer gone: ${details.reason}`);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.loadFile(page).catch((err) => {
    console.log(`[window] loadFile(${page}) rejected: ${(err as Error).message}`);
    // Show it anyway: a hidden window with a failed load looks like the app never started.
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mirror.stop();
    store?.dispose();
    mainWindow = null;
  });
}

ipcMain.handle('bridge:run-status', async (event): Promise<CommandResult> => {
  try {
    return await openEmu.status((stream, line) => event.sender.send('bridge:log', { stream, line }));
  } catch (err) {
    event.sender.send('bridge:log', { stream: 'stderr', line: `[bridge error] ${(err as Error).message}` });
    return { code: null, signal: null, stdout: [], stderr: [] };
  }
});

ipcMain.handle('setup:get-steps', (): SetupStepStatus[] => setupRunner.list());

ipcMain.handle('setup:run-checks', async (event): Promise<SetupStepStatus[]> => {
  return setupRunner.runAll((status) => event.sender.send('setup:step-update', status));
});

/** First-run path: check everything and repair whatever can repair itself, unattended. */
ipcMain.handle('setup:run-auto', async (event): Promise<SetupStepStatus[]> => {
  return setupRunner.runAuto(
    (status) => {
      // Also to the console. When someone reports "setup won't finish", this transcript is the
      // difference between a diagnosis and a guess — the in-app log only carries command output,
      // not which check decided what.
      if (status.status !== 'running') console.log(`[setup] ${status.id}: ${status.status} — ${status.detail}`);
      event.sender.send('setup:step-update', status);
    },
    (stream, line) => event.sender.send('bridge:log', { stream, line }),
  );
});

ipcMain.handle('setup:run-fix', async (event, id: string): Promise<SetupStepStatus> => {
  return setupRunner.runFix(
    id,
    (stream, line) => event.sender.send('bridge:log', { stream, line }),
    (status) => event.sender.send('setup:step-update', status),
  );
});

ipcMain.on('mirror:start', (event) => {
  mirror.start(
    (png) => event.sender.send('mirror:frame', new Uint8Array(png)),
    (stream, line) => event.sender.send('bridge:log', { stream, line }),
  );
});

ipcMain.on('mirror:stop', () => mirror.stop());

ipcMain.on('input:tap', (_event, x: number, y: number) => {
  openEmu.tap(x, y, () => undefined).catch(() => undefined);
});

// Swipe, keys, and text exist for the embedded Play client: a store you can only tap is not one
// anybody can scroll, search, or sign into.
ipcMain.on('input:swipe', (_event, x1: number, y1: number, x2: number, y2: number, durationMs: number) => {
  openEmu.swipe(x1, y1, x2, y2, durationMs, () => undefined).catch(() => undefined);
});

ipcMain.on('input:key', (_event, keycode: unknown) => {
  if (typeof keycode !== 'string') return;
  openEmu.key(keycode, () => undefined).catch(() => undefined);
});

ipcMain.handle('input:text', async (_event, value: unknown): Promise<boolean> => {
  if (typeof value !== 'string') return false;
  try {
    return await openEmu.text(value, () => undefined);
  } catch {
    return false;
  }
});

/**
 * The installed-app list, for the Apps tab and the Store's "already installed" marks.
 *
 * Registered here rather than inside the ads module, which is where it used to live. That coupling
 * meant an ad-free build had no way to list or launch apps at all — the core feature depended on
 * the optional one.
 */
ipcMain.handle('apps:list', async (): Promise<InstalledApp[]> => {
  try {
    return await library.list();
  } catch (err) {
    console.log(`[apps] list failed: ${(err as Error).message}`);
    return [];
  }
});

ipcMain.handle('apps:launch', async (_event, packageName: unknown): Promise<boolean> => {
  if (typeof packageName !== 'string') return false;
  try {
    return await library.launch(packageName);
  } catch {
    return false;
  }
});

/**
 * GUI control of the emulator itself — start, stop, prepare, and which guest to run.
 *
 * All of it was previously terminal-only (`open-emu start`, `ANDROID_PROFILE=play make …`). The
 * CLI is still there and unchanged; this is the same surface with buttons on it.
 */
let devicePrefs: DevicePrefsStore | null = null;
let lastStatus: Partial<DeviceState> = {};
let busyPhase: EmuPhase | null = null;
let deviceError: string | null = null;

function currentDeviceState(): DeviceState {
  return {
    ...INITIAL_DEVICE_STATE,
    ...lastStatus,
    ...(busyPhase ? { phase: busyPhase } : {}),
    profile: (target.profile as ProfileId | null) ?? devicePrefs?.get() ?? 'fast',
    busy: busyPhase !== null,
    error: deviceError,
  };
}

function pushDeviceState(state: DeviceState): void {
  mainWindow?.webContents.send('device:state', state);
}

async function refreshDeviceState(): Promise<DeviceState> {
  // Never while an action is in flight. `WslBridge` serializes commands, so asking for status
  // during a 20-minute provision would simply queue behind it and the UI would freeze.
  if (busyPhase) return currentDeviceState();
  try {
    const result = await openEmu.status(() => undefined);
    if (result.code === 0) lastStatus = parseStatus(result.stdout);
  } catch {
    // Keep the last good reading rather than blanking the panel on one failed call.
  }
  return currentDeviceState();
}

async function runDeviceAction(phase: EmuPhase, action: (onLog: LogHandler) => Promise<unknown>): Promise<DeviceState> {
  if (busyPhase) return currentDeviceState();
  busyPhase = phase;
  deviceError = null;
  pushDeviceState(currentDeviceState());

  try {
    await action((stream, line) => mainWindow?.webContents.send('bridge:log', { stream, line }));
  } catch (err) {
    deviceError = (err as Error).message;
  } finally {
    busyPhase = null;
  }

  const state = await refreshDeviceState();
  pushDeviceState(state);
  return state;
}

ipcMain.handle('device:state', (): Promise<DeviceState> => refreshDeviceState());

ipcMain.handle('device:start', (): Promise<DeviceState> =>
  runDeviceAction('starting', async (onLog) => {
    await openEmu.start(onLog);
    // A guest resumed from a snapshot comes back with its display asleep, so the mirror shows a
    // black rectangle and the app looks broken. Waking it is what every other emulator does on
    // start; failing to wake is not worth failing the start over.
    await openEmu.key('KEYCODE_WAKEUP', () => undefined).catch(() => false);
  }),
);

ipcMain.handle('device:stop', (): Promise<DeviceState> =>
  runDeviceAction('stopping', (onLog) => openEmu.stop(onLog)),
);

/** Same work the setup wizard's last step does, reachable later from the device panel. */
ipcMain.handle('device:prepare', (): Promise<DeviceState> =>
  runDeviceAction('starting', (onLog) => setupRunner.runFix('provisioned', onLog, () => undefined)),
);

ipcMain.handle('device:set-profile', async (_event, id: unknown): Promise<DeviceState> => {
  if (!isProfileId(id)) return currentDeviceState();

  // Switching guests under a running emulator would leave the old one orphaned and point every
  // later command at a different AVD. Refused with a reason the UI can show.
  if (busyPhase || currentDeviceState().phase === 'running') {
    deviceError = 'Stop the device before switching to a different Android version.';
    return currentDeviceState();
  }

  deviceError = null;
  openEmu.setProfile(id);
  devicePrefs?.set(id);
  lastStatus = {};
  return refreshDeviceState();
});

app.whenReady().then(() => {
  devicePrefs = new DevicePrefsStore(path.join(app.getPath('userData'), 'device.json'));
  // An explicit environment override still wins — it is how a developer pins a guest for a run.
  if (!process.env.OPEN_EMULATOR_ANDROID_PROFILE) openEmu.setProfile(devicePrefs.get());

  // Built here rather than at module scope: these stores live under `app.getPath('userData')`,
  // which isn't resolvable until the app is ready.
  store = createStore(openEmu, library, (line) => console.log(line));
  store.registerIpc(() => mainWindow);

  const account = createAccount(openEmu, {
    userData: app.getPath('userData'),
    // The store's guest probe already reports which AVD replied, so the account reads the answer
    // from there rather than asking the guest a second time.
    avdName: () => store?.avdName() ?? null,
    onLog: (line) => console.log(line),
  });
  account.registerIpc();

  createWindow();
});

app.on('window-all-closed', () => {
  mirror.stop();
  store?.dispose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
