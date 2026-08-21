import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { WslBridge, WslTarget } from './wsl-bridge';
import { OpenEmuClient } from './open-emu-client';
import { buildSteps, SetupRunner } from './setup-wizard';
import { ScreenMirror } from './screen-mirror';
import { createAds, registerAdSchemes } from './ads';
import { AppLibrary } from './app-library';
import type { CommandResult, SetupStepStatus } from '../shared/ipc-types';

// Config: hardcoded defaults, overridable via env vars until a first-run UI for choosing/renaming
// the distro exists. `target` is mutated in place by the setup wizard's `distro` step when it
// adopts an existing WSL2 distro under a different name — bridge/mirror read it live.
const target: WslTarget = {
  distro: process.env.OPEN_EMULATOR_WSL_DISTRO ?? 'OpenEmulator',
  remotePath: process.env.OPEN_EMULATOR_REMOTE_PATH ?? '~/open-emulator',
};

const bridge = new WslBridge(target);
const openEmu = new OpenEmuClient(bridge);
const setupRunner = new SetupRunner(buildSteps(bridge, openEmu, target));
const mirror = new ScreenMirror(target);
const library = new AppLibrary(openEmu);

// Custom schemes have to be declared before the app is ready, so this runs at module scope.
registerAdSchemes();

let mainWindow: BrowserWindow | null = null;
let ads: ReturnType<typeof createAds> | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    mirror.stop();
    ads?.dispose();
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

app.whenReady().then(() => {
  // Built here rather than at module scope: the ad stores live under `app.getPath('userData')`,
  // which isn't resolvable until the app is ready.
  ads = createAds((line) => console.log(line));
  ads.registerIpc(() => mainWindow, library);
  createWindow();
});

app.on('window-all-closed', () => {
  mirror.stop();
  ads?.dispose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
