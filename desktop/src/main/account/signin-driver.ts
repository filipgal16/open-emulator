import type { FillResult } from '../../shared/account-types';
import type { OpenEmuClient } from '../engine/client';
import type { ProfileStore } from './profile';
import type { SecretVault } from './vault';

/**
 * Assisted sign-in: autofill for the guest's real Google login.
 *
 * What this is *not* is important. It does not bypass anything, it does not drive the flow to
 * completion, and it does not touch a Google API. It opens Google's own add-account screen in the
 * guest, and offers to type a credential the user chose to store into whichever field they have
 * focused — the same job a password manager does, with the person still in the loop for the "Next"
 * taps, 2FA, and any challenge Google decides to present.
 *
 * That division is deliberate rather than a limitation we ran into: automating past a
 * human-verification step is exactly the behaviour those steps exist to stop.
 */
export class SignInDriver {
  constructor(
    private readonly openEmu: OpenEmuClient,
    private readonly profile: ProfileStore,
    private readonly vault: SecretVault,
    private readonly onLog: (message: string) => void = () => undefined,
  ) {}

  /** Opens the guest's add-account flow, filtered to Google. */
  async begin(): Promise<FillResult> {
    try {
      const ok = await this.openEmu.startAddGoogleAccount(() => undefined);
      return ok
        ? { ok: true, message: 'Sign-in opened in the guest — complete it on the screen.' }
        : { ok: false, message: 'Could not open the guest sign-in screen. Is Android running?' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async fillEmail(): Promise<FillResult> {
    const email = this.profile.get().email;
    if (!email) return { ok: false, message: 'No address saved for this account.' };

    try {
      const ok = await this.openEmu.text(email, () => undefined);
      return ok
        ? { ok: true, message: 'Address typed into the focused field.' }
        : { ok: false, message: 'The guest did not accept the text. Tap the field first.' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * Types the stored password.
   *
   * Read late and dropped immediately: the plaintext exists only for the duration of this call,
   * and never crosses IPC — the renderer asks for the *action*, not the secret.
   */
  async fillPassword(): Promise<FillResult> {
    const profile = this.profile.get();
    if (!profile.hasStoredPassword) return { ok: false, message: 'No password saved for this account.' };
    if (!profile.autoFill) return { ok: false, message: 'Autofill is turned off for this account.' };

    const secret = this.vault.get();
    if (secret === null) {
      return { ok: false, message: 'The saved password could not be read from the OS keychain.' };
    }

    try {
      const ok = await this.openEmu.textSecret(secret, () => undefined);
      if (!ok) this.onLog('password autofill was refused by the guest');
      return ok
        ? { ok: true, message: 'Password typed into the focused field.' }
        : { ok: false, message: 'The guest did not accept the text. Tap the password field first.' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
