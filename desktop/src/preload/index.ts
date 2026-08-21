import { contextBridge, ipcRenderer } from 'electron';
import type { SlotBounds, SlotId } from '../shared/ads-types';
import type { LogEvent, OpenEmuApi, SetupStepStatus } from '../shared/ipc-types';

// Whitelisted IPC surface exposed to the renderer. The renderer never gets direct access to
// ipcRenderer/child_process — only these specific, typed calls.
const api: OpenEmuApi = {
  runStatus: () => ipcRenderer.invoke('bridge:run-status'),
  getSetupSteps: () => ipcRenderer.invoke('setup:get-steps'),
  runSetupChecks: () => ipcRenderer.invoke('setup:run-checks'),
  runSetupFix: (id: string) => ipcRenderer.invoke('setup:run-fix', id),
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
  adsState: () => ipcRenderer.invoke('ads:state'),
  adsRequest: (slot) => ipcRenderer.invoke('ads:request', slot),
  adsSetOptedOut: (optedOut: boolean) => ipcRenderer.invoke('ads:set-opted-out', optedOut),
  adsImpression: (token: string) => ipcRenderer.send('ads:impression', token),
  adsClick: (token: string) => ipcRenderer.send('ads:click', token),
  adsSetConsent: (granted: boolean) => ipcRenderer.invoke('ads:set-consent', granted),
  adsActivateLicense: (key: string) => ipcRenderer.invoke('ads:activate-license', key),
  adsTagPlan: (slot: SlotId) => ipcRenderer.invoke('ads:tag-plan', slot),
  adsMountTag: (slot: SlotId, bounds: SlotBounds) => ipcRenderer.send('ads:mount-tag', slot, bounds),
  adsUpdateTagBounds: (slot: SlotId, bounds: SlotBounds) => ipcRenderer.send('ads:update-tag-bounds', slot, bounds),
  adsUnmountTag: (slot: SlotId) => ipcRenderer.send('ads:unmount-tag', slot),
  onAdsTagResult: (callback) => {
    ipcRenderer.on('ads:tag-result', (_event, slot: SlotId, filled: boolean) => callback(slot, filled));
  },
  listApps: () => ipcRenderer.invoke('apps:list'),
  launchApp: (packageName: string) => ipcRenderer.invoke('apps:launch', packageName),
};

contextBridge.exposeInMainWorld('openEmu', api);
