import { ipcMain, safeStorage } from 'electron';
import path from 'path';
import type { AccountState, FillField, FillResult } from '../../shared/account-types';
import type { OpenEmuClient } from '../open-emu-client';
import { GuestAccountMonitor } from './guest-account';
import { ProfileStore } from './profile';
import { SignInDriver } from './signin-driver';
import { SecretVault } from './vault';

export { GOOGLE_ACCOUNT_TYPE, parseAccounts } from './guest-account';

export interface AccountRuntimeOptions {
  userData: string;
  /** Which AVD is answering, so status isn't attributed to the wrong guest profile. */
  avdName: () => string | null;
  onLog?: (message: string) => void;
}

export interface AccountRuntime {
  state(): AccountState;
  refresh(force?: boolean): Promise<AccountState>;
  registerIpc(): void;
}

/**
 * The device-wide account.
 *
 * The only file under `account/` that imports electron — the stores and the driver stay plain Node
 * so they can be exercised without an Electron runtime, exactly as `store/` is arranged.
 */
export function createAccount(openEmu: OpenEmuClient, options: AccountRuntimeOptions): AccountRuntime {
  const log = (message: string) => options.onLog?.(`[account] ${message}`);

  const profile = new ProfileStore(path.join(options.userData, 'account.json'));
  const vault = new SecretVault(path.join(options.userData, 'account-secret.bin'), safeStorage);
  const monitor = new GuestAccountMonitor(openEmu, { onLog: log });
  const driver = new SignInDriver(openEmu, profile, vault, log);

  const state = (): AccountState => ({
    profile: profile.get(),
    guest: monitor.current(),
    vaultAvailable: vault.available(),
  });

  const refresh = async (force = false): Promise<AccountState> => {
    await monitor.refresh(options.avdName(), force);
    return state();
  };

  return {
    state,
    refresh,

    registerIpc() {
      ipcMain.handle('account:state', (): AccountState => state());

      ipcMain.handle('account:refresh', (_event, force: unknown): Promise<AccountState> => refresh(force === true));

      ipcMain.handle('account:set-email', (_event, email: unknown): AccountState => {
        profile.setEmail(typeof email === 'string' ? email : null);
        return state();
      });

      ipcMain.handle('account:set-display-name', (_event, name: unknown): AccountState => {
        if (typeof name === 'string') profile.setDisplayName(name);
        return state();
      });

      /**
       * Storing the password is the one place a secret crosses IPC, and it crosses inbound only —
       * the user typed it into the dialog a moment ago. Nothing ever reads it back out to the
       * renderer; `fillPassword` sends the *action*, not the value.
       */
      ipcMain.handle('account:set-password', (_event, password: unknown): AccountState => {
        if (password === null) {
          vault.set(null);
          profile.setHasStoredPassword(false);
          log('stored password cleared');
          return state();
        }
        if (typeof password !== 'string' || password.length === 0) return state();

        const stored = vault.set(password);
        profile.setHasStoredPassword(stored);
        log(stored ? 'password stored in the OS keychain' : 'refused to store password: no keychain available');
        return state();
      });

      ipcMain.handle('account:set-autofill', (_event, enabled: unknown): AccountState => {
        profile.setAutoFill(enabled === true);
        return state();
      });

      ipcMain.handle('account:sign-out', (): AccountState => {
        // Local only, and it says so in the UI: this forgets the credential on this machine. The
        // guest keeps its own account until it is removed in the guest's settings.
        vault.set(null);
        profile.clear();
        log('local account cleared');
        return state();
      });

      ipcMain.handle('account:begin-signin', (): Promise<FillResult> => driver.begin());

      ipcMain.handle('account:fill', (_event, field: unknown): Promise<FillResult> => {
        const target = field as FillField;
        if (target === 'email') return driver.fillEmail();
        if (target === 'password') return driver.fillPassword();
        return Promise.resolve({ ok: false, message: 'Unknown field.' });
      });
    },
  };
}
