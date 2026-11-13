import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from 'electron';
import os from 'os';
import path from 'path';
import { DevicePrefsStore, parseStatus } from './guest/device-status';
import { DisplayScaler } from './guest/display-scaler';
import { GuestWindow, type EmbedApi } from './guest/guest-window';
import type { Rect } from './engine/window-embed';
import { LogHandler, WslBridge, WslTarget } from './wsl/bridge';
import { createEngine, resolveEngineId } from './engine/factory';
import { OpenEmuClient } from './engine/client';
import { buildSteps, SetupRunner } from './setup-wizard';
import { ScreenMirror } from './wsl/screen-mirror';
import { EngineMirror } from './engine/engine-mirror';
import { buildNativeSteps } from './engine/sdk/setup-steps';
import { loadProfile } from './engine/env-file';
import { repoRootWinPath } from './platform/win-paths';
import { moveDownloadRoot, SettingsStore, storageUsage } from './settings';
import { DEFAULT_SETTINGS } from '../shared/settings-types';
import type { SettingsState, ThemeChoice } from '../shared/settings-types';
import { cleanup } from './engine/sdk/dependencies';
import { tuneForHost } from './engine/sdk/host';
import { detectAcceleration } from './engine/acceleration';
import { addDefenderExclusion, defenderExclusionState, removeDefenderExclusion } from './engine/defender';
import { createAccount } from './account';
import { AppLibrary } from './guest/app-library';
import { createStore, registerStoreSchemes } from './store';
import type { DeviceState, EmuPhase, ProfileId } from '../shared/device-types';
import { INITIAL_DEVICE_STATE, isProfileId } from '../shared/device-types';
import type { CommandResult, DefenderResult, DefenderState, InstalledApp, SetupStepStatus } from '../shared/ipc-types';

/**
 * Chromium must not composite on the GPU, or the embedded guest is invisible.
 *
 * With GPU compositing, Chromium presents the page through a DirectComposition child window
 * (`Intermediate D3D Window`, `WS_EX_NOREDIRECTIONBITMAP`), and DWM draws that surface over every
 * sibling child HWND regardless of z-order. The emulator's window was embedded, at the top of the
 * z-order, rendering Android at 60fps — and the pane showed the page's background. Hiding
 * Chromium's child by hand made the guest appear instantly, which is how this was found.
 *
 * With software compositing there is no such child: Chromium blits the page into the window's
 * ordinary redirection surface, and child windows clip it the way Win32 has always worked. The GPU
 * still rasterises the page; only the final composite moves to the CPU, for a page that is a
 * toolbar and some panels. The guest is drawn by the emulator's own process and is untouched.
 * `--disable-direct-composition` was tried first and is a no-op on this Chromium. Must run before
 * `app` is ready.
 */
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-gpu-compositing');

// Config: hardcoded defaults, overridable via env vars until a first-run UI for choosing/renaming
// the distro exists. `target` is mutated in place by the setup wizard's `distro` step when it
// adopts an existing WSL2 distro under a different name — bridge/mirror read it live.
const target: WslTarget = {
  distro: process.env.OPEN_EMULATOR_WSL_DISTRO ?? 'OpenEmulator',
  remotePath: process.env.OPEN_EMULATOR_REMOTE_PATH ?? '~/open-emulator',
  // `play` selects the Google Play guest. Left unset, open-emu uses its own default profile.
  profile: process.env.OPEN_EMULATOR_ANDROID_PROFILE ?? null,
};

/**
 * Settings load before the engine, because the download location is one of them and the engine
 * bakes its paths in at construction. app.getPath('userData') is available at module scope —
 * only windows and custom protocols have to wait for 'ready'.
 */
const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));

const bridge = new WslBridge(target);
// The one place a runtime is chosen. Everything downstream holds `openEmu` and cannot tell which
// engine is underneath — that is what makes swapping WSL for a native Windows process a local
// change rather than a rewrite.
//
// Native Windows by default: it is the runtime whose window can be embedded, and therefore the
// only one that shows the guest at the emulator's own frame rate. `OPEN_EMULATOR_ENGINE=wsl` keeps
// the headless, mirrored runtime reachable.
const engineId = resolveEngineId(process.env.OPEN_EMULATOR_ENGINE);
const { engine, layout, guestTuning } = createEngine({
  id: engineId,
  profile: target.profile,
  downloadRoot: settings.get().downloadRoot,
  // Read live rather than captured: settings load after this, and a change should apply to the
  // next boot without restarting the app.
  device: () => settings.get().device,
  wsl: { bridge, target },
  onLog: (line) => console.log(line),
});
console.log(`[engine] using the ${engineId} runtime`);
const openEmu = new OpenEmuClient(engine);

/**
 * Keeps the guest's logical display matched to the viewport, so resizing the window resizes
 * Android rather than stretching a fixed-size picture of it.
 *
 * Sits on `shell` rather than on the engine interface because `wm size` is a guest-side command:
 * it reads and behaves identically whichever runtime is underneath, so neither engine needs to
 * know this feature exists.
 */
const displayScaler = new DisplayScaler({
  shell: (command) => openEmu.shell(command, () => undefined),
  log: (message) => console.log(`[display] ${message}`),
});

/**
 * The guest's real window, reparented into ours — the difference between the emulator's own frame
 * rate and the ~2.8fps a screencap poll can manage.
 *
 * Built on first use rather than at import, and behind a try/catch, because `window-embed` loads
 * `user32.dll` through koffi at module scope. A machine where that fails must still start the app
 * and mirror, rather than dying before it opens a window.
 */
let embeddedGuest: GuestWindow | null = null;
let embedUnavailable = false;

function guestWindow(): GuestWindow | null {
  if (embeddedGuest) return embeddedGuest;
  if (embedUnavailable) return null;

  try {
    // Required lazily on purpose — see above.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const embed = require('./engine/window-embed') as EmbedApi;
    embeddedGuest = new GuestWindow({ embed, log: (message) => console.log(`[guest-window] ${message}`) });
    return embeddedGuest;
  } catch (err) {
    console.log(`[guest-window] embedding unavailable, mirroring instead: ${(err as Error).message}`);
    embedUnavailable = true;
    return null;
  }
}

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
        profile: () => loadProfile(path.join(repoRootWinPath(), 'android'), target.profile ?? 'openemu'),
        tuning: guestTuning,
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

  // `close`, not `closed`, and not `before-quit` either. Closing the window with its ✕ runs
  // 'close' → destroy → 'window-all-closed' → app.quit() → 'before-quit', so by the time either of
  // the app-level hooks fires the HWND is gone — and Windows has already destroyed every child
  // window with it, the embedded emulator screen included. The emulator process survives that with
  // nothing but its floating toolbar left, and every later start finds no window to embed. 'close'
  // is the last moment the parent still exists, so it is the only place the hand-back can work.
  mainWindow.on('close', () => {
    embeddedGuest?.detach();
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
  const results = await setupRunner.runAuto(
    (status) => {
      // Also to the console. When someone reports "setup won't finish", this transcript is the
      // difference between a diagnosis and a guess — the in-app log only carries command output,
      // not which check decided what.
      if (status.status !== 'running') console.log(`[setup] ${status.id}: ${status.status} — ${status.detail}`);
      event.sender.send('setup:step-update', status);
    },
    (stream, line) => event.sender.send('bridge:log', { stream, line }),
  );

  // The wizard has now handed the user into the app — provisioning was deferred out of the run
  // above. Start it in the background, but only once the blocking steps have actually passed:
  // provisioning a half-downloaded SDK would just fail loudly.
  const blockingOk = results.filter((r) => r.blocking).every((r) => r.status === 'pass');
  if (blockingOk) void startBackgroundProvisioning();

  return results;
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

/**
 * One screenshot of the guest, captured on demand.
 *
 * The button used to save whatever frame the mirror had last produced, which stops working the
 * moment the guest's own window is embedded — there are no mirrored frames then. Capturing here
 * also means the file is at the guest's full resolution rather than whatever the mirror managed.
 *
 * Null when the engine cannot capture (nothing running, or a runtime with no `screencap`).
 */
/**
 * Rotates the guest a quarter turn.
 *
 * Rotates *Android*, not a picture of it. The old Rotate button applied a CSS transform to the
 * mirrored image, which does nothing at all once the guest's own window is embedded — and even on
 * the mirror it only turned the image, so the guest still laid out for the old orientation.
 *
 * `accelerometer_rotation` has to be cleared first or the guest's own sensor immediately overrides
 * `user_rotation` and the turn silently reverts.
 */
ipcMain.handle('device:rotate', async (): Promise<number | null> => {
  const current = await openEmu.shell('settings get system user_rotation', () => undefined).catch(() => null);
  const parsed = Number.parseInt((current?.stdout.join('') ?? '').trim(), 10);
  const next = (Number.isFinite(parsed) ? parsed + 1 : 1) % 4;

  const applied = await openEmu
    .shell(`settings put system accelerometer_rotation 0 && settings put system user_rotation ${next}`, () => undefined)
    .catch(() => null);

  return applied?.code === 0 ? next : null;
});

ipcMain.handle('device:screenshot', async (): Promise<Uint8Array | null> => {
  if (!engine.screencap) return null;
  const png = await engine.screencap().catch(() => null);
  return png ? new Uint8Array(png) : null;
});

/**
 * Where the device is on screen, in real device pixels, and whether it should be showing.
 *
 * One channel drives both halves of the display, because they must not disagree: `wm size` sets
 * how large Android believes its screen is, and `moveWindow` sets how large the window showing it
 * is. Split across two channels they would drift apart during a drag and the guest would render at
 * one size into a pane sized for another.
 *
 * Returns whether the guest's own window is embedded. False means the renderer has to fall back to
 * mirroring frames — on the WSL runtime, which has no window at all, or when embedding was refused.
 */
ipcMain.handle('display:viewport', async (_event, rect: unknown, visible: unknown): Promise<boolean> => {
  if (!isRect(rect) || typeof visible !== 'boolean') return false;

  const guest = guestWindow();

  // Hiding is the airspace escape hatch and must work even mid-attach, so it is answered before
  // anything that could wait on the emulator.
  if (guest && !visible) {
    guest.setVisible(false);
    return guest.isAttached();
  }

  if (guest?.isAttached()) {
    guest.setBounds(rect);
    guest.setVisible(true);
    return true;
  }

  if (guest && visible) {
    const pid = await waitForDisplayPid();
    if (pid && mainWindow && (await guest.attach(pid, mainWindow.getNativeWindowHandle(), rect))) {
      // The display scaler is for the mirror, and is actively harmful here. The emulator's window
      // keeps the panel's aspect ratio and letterboxes any other logical display inside it, so a
      // `wm size` matching a landscape pane shows up as a thin strip inside a portrait window.
      // Embedded, the guest keeps its own panel geometry and the window is fitted to the pane.
      displayScaler.setEnabled(false);
      void displayScaler.reset();
      // A guest adopted from a previous app instance has usually let its screen time out, and an
      // embedded window showing a sleeping display is a black rectangle with no explanation.
      // Waking it is what `device:start` already does; a guest already awake ignores the key.
      void openEmu.key('KEYCODE_WAKEUP', () => undefined).catch(() => false);
      return true;
    }
  }

  // Mirroring — the WSL runtime, or an embed that was refused. Here the logical display follows
  // the pane, because a screencap of a display the pane's shape is the one that fills the pane.
  displayScaler.setEnabled(true);
  displayScaler.request({ width: rect.width, height: rect.height });
  return false;
});

/**
 * The emulator's pid, waiting for it while a start is in flight.
 *
 * The renderer reports its viewport when the device enters 'starting', which is before the
 * emulator has been spawned — the AVD config is synced first. Answering "no pid" there would be
 * final: the renderer only reports again on a resize, so the window would stay a separate one on
 * the desktop until the user happened to drag something. Waiting here instead means the window is
 * captured within a poll of appearing. One wait is shared, so a burst of viewport reports during a
 * start does not become a burst of pollers.
 */
let pidWait: Promise<number | null> | null = null;

function waitForDisplayPid(timeoutMs = 60_000): Promise<number | null> {
  if (pidWait) return pidWait;
  pidWait = (async () => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pid = await openEmu.displayPid().catch(() => null);
      if (pid) return pid;
      // Only worth waiting while something is actually starting.
      if (busyPhase !== 'starting' || Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })().finally(() => {
    pidWait = null;
  });
  return pidWait;
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k] as number));
}

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

/** The installed-app list, for the Apps tab and the Store's "already installed" marks. */
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
    profile: (target.profile as ProfileId | null) ?? devicePrefs?.get() ?? 'openemu',
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
    // A different profile boots a different panel, so anything cached from the last guest would
    // compute densities against a device that no longer exists.
    displayScaler.forget();
    embeddedGuest?.detach();
    await openEmu.start(onLog);
    // A guest resumed from a snapshot comes back with its display asleep, so the mirror shows a
    // black rectangle and the app looks broken. Waking it is what every other emulator does on
    // start; failing to wake is not worth failing the start over.
    await openEmu.key('KEYCODE_WAKEUP', () => undefined).catch(() => false);
  }),
);

ipcMain.handle('device:stop', (): Promise<DeviceState> =>
  runDeviceAction('stopping', async (onLog) => {
    // Dropped rather than reset: `wm size reset` on a guest that is about to die buys nothing, and
    // the override that persists into the snapshot is harmless — the panel is still reported as
    // physical, and the first resize after the next start re-applies from it.
    displayScaler.forget();
    // Before the stop, not after: the window belongs to a process that is about to exit, and a
    // stale handle that still answers IsWindow would have the next start think it was attached.
    embeddedGuest?.detach();
    await openEmu.stop(onLog);
  }),
);

/** Same work the setup wizard's last step does, reachable later from the device panel. */
ipcMain.handle('device:prepare', (): Promise<DeviceState> =>
  runDeviceAction('starting', (onLog) => setupRunner.runFix('provisioned', onLog, () => undefined)),
);

/**
 * The one cold boot, moved off the critical path.
 *
 * Setup hands the user into the app as soon as the download is banked; this then runs the first
 * boot and snapshot save in the background, reporting through the same `device:state` channel the
 * panel already renders as "Starting". So nobody watches a cold boot — by the time the Device tab
 * is opened the guest is live, and if it is never opened the snapshot still lands and the first
 * explicit Start is warm.
 *
 * Fire-and-forget, and guarded so it runs at most once per session and never while another device
 * action is in flight.
 */
let provisioningStarted = false;
async function startBackgroundProvisioning(): Promise<void> {
  if (provisioningStarted || busyPhase) return;

  // Nothing to do if it is already provisioned — otherwise every launch would cold-boot again.
  const status = await openEmu.status(() => undefined).catch(() => null);
  if (status?.stdout.some((line) => line.startsWith('provisioned_at='))) return;

  // Without a hypervisor the boot hangs for an hour and fails. The provisioned step's fix skips in
  // that case too, but not starting keeps the panel out of a "starting" state that never resolves.
  const acceleration = await detectAcceleration().catch(() => null);
  if (!acceleration?.available) return;

  provisioningStarted = true;
  console.log('[provision] starting in the background — the user is already in the app');
  // Deliberately not awaited: the setup handler must return so the wizard can hand over.
  void runDeviceAction('starting', (onLog) => setupRunner.runFix('provisioned', onLog, () => undefined));
}

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

/**
 * Settings.
 *
 * The store lives under `userData` — the user's own preferences — while everything the runtime
 * downloads lives under `%LOCALAPPDATA%\open-emulator`. Keeping them apart is what lets "free up
 * space" delete gigabytes without touching the account or a single preference.
 */
async function settingsState(): Promise<SettingsState> {
  const current = settings.get();
  const acceleration = await detectAcceleration();

  const hostCpus = os.cpus().length;
  const hostRamMb = Math.round(os.totalmem() / (1024 * 1024));
  const tuning = tuneForHost(
    { cpus: hostCpus, totalRamMb: hostRamMb, accelerated: acceleration.available, hasWindow: true },
    { cores: current.cores ?? undefined, ramMb: current.ramMb ?? undefined },
  );

  return {
    settings: current,
    engine: engineId,
    tuning: {
      ...tuning,
      accelerated: acceleration.available,
      accelerationDetail: acceleration.detail,
      hostCpus,
      hostRamMb,
    },
    storage: storageUsage(layout.root, [
      path.join(layout.root, 'downloads'),
      path.join(layout.sdkRoot, '.temp'),
      path.join(layout.sdkRoot, '.downloadIntermediates'),
    ]),
  };
}

/** `system` follows the OS; the other two are an explicit override the renderer stamps on <html>. */
function applyTheme(choice: ThemeChoice): void {
  nativeTheme.themeSource = choice;
}

app.whenReady().then(() => {
  devicePrefs = new DevicePrefsStore(path.join(app.getPath('userData'), 'device.json'));
  applyTheme(settings.get().theme);

  ipcMain.handle('settings:state', (): Promise<SettingsState> => settingsState());

  ipcMain.handle('settings:set', async (_event, patch: unknown): Promise<SettingsState> => {
    const next = settings.set(patch);
    applyTheme(next.theme);
    // The device identity is baked in at boot, so a change only takes effect on the next start —
    // the engine is told now so it is not left describing the previous choice.
    return settingsState();
  });

  /**
   * Choosing where the multi-gigabyte download lives.
   *
   * A native folder picker rather than a text field: this path has to be absolute and has to
   * exist, and both are things a picker guarantees and a text box invites people to get wrong.
   */
  ipcMain.handle('settings:choose-download-folder', async (): Promise<SettingsState> => {
    const window = mainWindow;
    const chosen = await dialog.showOpenDialog(window ?? undefined!, {
      title: 'Where should Android be downloaded?',
      defaultPath: layout.root,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    if (chosen.canceled || chosen.filePaths.length === 0) return settingsState();

    // Someone picking "D:\Android" almost certainly means a folder for this app, not for its
    // contents to be strewn across whatever else is in there.
    const target = path.join(chosen.filePaths[0], 'open-emulator');
    const moved = moveDownloadRoot(layout.root, target);
    console.log(`[settings] download folder: ${moved.message}`);

    if (!moved.ok) return { ...(await settingsState()), lastMessage: moved.message };

    settings.set({ downloadRoot: target });
    return {
      ...(await settingsState()),
      lastMessage: `${moved.message} The change takes effect when open-emulator restarts.`,
    };
  });

  /** Relaunches so a changed download location takes effect without the user hunting for it. */
  ipcMain.handle('settings:restart-app', (): void => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('settings:free-space', async (): Promise<SettingsState> => {
    const freed = cleanup(layout);
    console.log(`[settings] freed ${freed.bytesFreed} bytes across ${freed.removed.length} paths`);
    return settingsState();
  });

  ipcMain.handle('defender:state', (): Promise<DefenderState> => defenderExclusionState(layout.root));

  // Only reached from an explicit toggle in Settings. The change is a UAC prompt; a decline comes
  // back as an error the UI shows, not a thrown handler, and the reported state is re-read from
  // Defender afterwards rather than assumed.
  ipcMain.handle('defender:set-excluded', async (_event, enabled: unknown): Promise<DefenderResult> => {
    try {
      if (enabled === true) await addDefenderExclusion(layout.root);
      else await removeDefenderExclusion(layout.root);
    } catch (err) {
      return { state: await defenderExclusionState(layout.root), error: (err as Error).message };
    }
    return { state: await defenderExclusionState(layout.root) };
  });

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

/**
 * Hand the guest's window back before ours goes away.
 *
 * The primary hand-back is the window's own 'close' handler (see `createWindow`); this covers a
 * quit that arrives while the window is still open — `app.quit()` from code — where 'before-quit'
 * fires first. Detaching twice is harmless.
 */
app.on('before-quit', () => {
  embeddedGuest?.detach();
});

app.on('window-all-closed', () => {
  embeddedGuest?.detach();
  mirror.stop();
  store?.dispose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
