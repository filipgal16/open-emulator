import type { OpenEmuApi } from '../shared/ipc-types';

declare global {
  interface Window {
    openEmu: OpenEmuApi;
  }
}

export {};
