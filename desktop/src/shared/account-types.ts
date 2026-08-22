// Shared between main, preload, and renderer. Type-only content plus plain data constants.
// Nothing here may import electron or node builtins — and nothing here may carry a secret: the
// stored password never appears in any of these shapes, because they all cross IPC.

export type SignInState =
  /** The guest hasn't been asked yet. */
  | 'unknown'
  /** The guest isn't running, or isn't answering adb. */
  | 'guest-unavailable'
  | 'signed-out'
  | 'signed-in';

export interface GuestAccount {
  name: string;
  type: string;
}

export interface GuestAccountState {
  state: SignInState;
  /** Google accounts found in the guest. Empty unless `state` is 'signed-in'. */
  accounts: GuestAccount[];
  checkedAt: number | null;
  /** Which AVD these accounts belong to, so a profile switch doesn't show stale status. */
  avd: string | null;
}

/**
 * The device-wide account.
 *
 * "Device-wide" means it spans every AVD and device profile the shell manages, rather than living
 * inside one guest: the shell remembers who you are, and each guest gets signed in to that
 * identity as it becomes available.
 */
export interface AccountProfile {
  displayName: string;
  /** Not a secret — the address is shown in the UI. The password never leaves the main process. */
  email: string | null;
  /** Whether a password is held in the OS keychain. */
  hasStoredPassword: boolean;
  /** Whether assisted sign-in may type the stored credential. Off unless explicitly turned on. */
  autoFill: boolean;
  createdAt: number;
}

export const EMPTY_PROFILE: AccountProfile = {
  displayName: '',
  email: null,
  hasStoredPassword: false,
  autoFill: false,
  createdAt: 0,
};

export interface AccountState {
  profile: AccountProfile;
  guest: GuestAccountState;
  /** False when the OS keychain is unavailable — the vault then refuses to store anything. */
  vaultAvailable: boolean;
  /** Surfaced here so "the account" means one thing across the whole shell. */
  adsRemoved: boolean;
}

export const INITIAL_ACCOUNT_STATE: AccountState = {
  profile: EMPTY_PROFILE,
  guest: { state: 'unknown', accounts: [], checkedAt: null, avd: null },
  vaultAvailable: false,
  adsRemoved: false,
};

export type FillField = 'email' | 'password';

export interface FillResult {
  ok: boolean;
  message: string;
}
