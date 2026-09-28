import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { FillField } from '../shared/account-types';
import type { DeviceState, ProfileId } from '../shared/device-types';
import type { Settings } from '../shared/settings-types';
import type { InstallJob, SourceId, StoreState } from '../shared/store-types';
import type { LogEvent, OpenEmuApi, SetupStepStatus } from '../shared/ipc-types';
import type { UpdateState } from '../shared/update-types';

// Whitelisted IPC surface exposed to the renderer. The renderer never gets direct access to
// ipcRenderer/child_process — only these specific, typed calls.
const api: OpenEmuApi = {
  runStatus: () => ipcRenderer.invoke('bridge:run-status'),
  getSetupSteps: () => ipcRenderer.invoke('setup:get-steps'),
  runSetupChecks: () => ipcRenderer.invoke('setup:run-checks'),
  runSetupAuto: () => ipcRenderer.invoke('setup:run-auto'),
  runSetupFix: (id: string) => ipcRenderer.invoke('setup:run-fix', id),

  deviceState: () => ipcRenderer.invoke('device:state'),
  deviceStart: () => ipcRenderer.invoke('device:start'),
  deviceStop: () => ipcRenderer.invoke('device:stop'),
  devicePrepare: () => ipcRenderer.invoke('device:prepare'),
  deviceSetProfile: (id: ProfileId) => ipcRenderer.invoke('device:set-profile', id),
  onDeviceState: (callback) => {
    ipcRenderer.on('device:state', (_event, state: DeviceState) => callback(state));
  },
  onSetupStep: (callback) => {
    ipcRenderer.on('setup:step-update', (_event, status: SetupStepStatus) => callback(status));
  },
  onLog: (callback) => {
    ipcRenderer.on('bridge:log', (_event, payload: LogEvent) => callback(payload));
  },
  startMirror: () => ipcRenderer.send('mirror:start'),
  stopMirror: () => ipcRenderer.send('mirror:stop'),
  onFrame: (callback) => {
    ipcRenderer.on('mirror:frame', (_event, data: Uint8Array) => callback(data));
  },
  tap: (x: number, y: number) => ipcRenderer.send('input:tap', x, y),
  swipe: (x1: number, y1: number, x2: number, y2: number, durationMs: number) =>
    ipcRenderer.send('input:swipe', x1, y1, x2, y2, durationMs),
  key: (keycode: string) => ipcRenderer.send('input:key', keycode),
  typeText: (value: string) => ipcRenderer.invoke('input:text', value),
  listApps: () => ipcRenderer.invoke('apps:list'),
  launchApp: (packageName: string) => ipcRenderer.invoke('apps:launch', packageName),

  storeState: () => ipcRenderer.invoke('store:state'),
  storeProbeGuest: (force = false) => ipcRenderer.invoke('store:probe-guest', force),
  storeRefreshIndex: (force = false) => ipcRenderer.invoke('store:refresh-index', force),
  storeSearch: (query: string, source: SourceId | null, limit = 60) =>
    ipcRenderer.invoke('store:search', query, source, limit),
  storeDetail: (source: SourceId, packageName: string) => ipcRenderer.invoke('store:detail', source, packageName),
  storeInstall: (source: SourceId, packageName: string, versionCode: number | null) =>
    ipcRenderer.invoke('store:install', source, packageName, versionCode),
  storeJobs: () => ipcRenderer.invoke('store:jobs'),
  storeImportApk: (filePath: string) => ipcRenderer.invoke('store:import-apk', filePath),
  onStoreJob: (callback) => {
    ipcRenderer.on('store:job-update', (_event, job: InstallJob) => callback(job));
  },
  onStoreInstalled: (callback) => {
    ipcRenderer.on('store:installed', (_event, packageName: string) => callback(packageName));
  },
  onStoreIndexUpdated: (callback) => {
    ipcRenderer.on('store:index-updated', (_event, state: StoreState) => callback(state));
  },
  // `File.path` is gone in current Electron; this is the supported way to learn where a dropped
  // file actually lives, and it stays on the preload side of the bridge.
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  playOpen: () => ipcRenderer.invoke('store:play-open'),
  playSearch: (query: string) => ipcRenderer.invoke('store:play-search', query),
  playDetails: (packageName: string) => ipcRenderer.invoke('store:play-details', packageName),
  playBack: () => ipcRenderer.invoke('store:play-back'),

  accountState: () => ipcRenderer.invoke('account:state'),
  accountRefresh: (force = false) => ipcRenderer.invoke('account:refresh', force),
  accountSetEmail: (email: string | null) => ipcRenderer.invoke('account:set-email', email),
  accountSetDisplayName: (name: string) => ipcRenderer.invoke('account:set-display-name', name),
  accountSetPassword: (password: string | null) => ipcRenderer.invoke('account:set-password', password),
  accountSetAutofill: (enabled: boolean) => ipcRenderer.invoke('account:set-autofill', enabled),
  accountSignOut: () => ipcRenderer.invoke('account:sign-out'),
  accountBeginSignIn: () => ipcRenderer.invoke('account:begin-signin'),
  accountFill: (field: FillField) => ipcRenderer.invoke('account:fill', field),

  settingsState: () => ipcRenderer.invoke('settings:state'),
  settingsSet: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  settingsFreeSpace: () => ipcRenderer.invoke('settings:free-space'),
  settingsChooseDownloadFolder: () => ipcRenderer.invoke('settings:choose-download-folder'),
  settingsRestartApp: () => ipcRenderer.invoke('settings:restart-app'),

  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback) => {
    ipcRenderer.on('update:state', (_event, state: UpdateState) => callback(state));
  },
};

contextBridge.exposeInMainWorld('openEmu', api);
