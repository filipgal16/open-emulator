import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type { AccountProfile } from '../../shared/account-types';
import { EMPTY_PROFILE } from '../../shared/account-types';

/**
 * The device-wide account profile, on disk.
 *
 * Holds no secret. The password, if the user chose to store one, lives in the OS keychain via
 * `SecretVault`; this file only records *that* one exists, so the UI can offer to use it.
 */
export class ProfileStore {
  private profile: AccountProfile;

  constructor(private readonly file: string) {
    this.profile = this.read();
  }

  get(): AccountProfile {
    return { ...this.profile };
  }

  setEmail(email: string | null): AccountProfile {
    const trimmed = email?.trim() ?? '';
    return this.patch({
      email: trimmed || null,
      // A profile with no name yet takes the local part of the address, which is nearly always
      // what someone would have typed anyway.
      displayName: this.profile.displayName || trimmed.split('@')[0] || '',
      createdAt: this.profile.createdAt || Date.now(),
    });
  }

  setDisplayName(displayName: string): AccountProfile {
    return this.patch({ displayName: displayName.trim().slice(0, 64) });
  }

  setHasStoredPassword(hasStoredPassword: boolean): AccountProfile {
    // Turning the stored password off must also turn autofill off; leaving it on would leave the
    // UI offering to type a credential that is no longer there.
    return this.patch({ hasStoredPassword, autoFill: hasStoredPassword && this.profile.autoFill });
  }

  setAutoFill(autoFill: boolean): AccountProfile {
    return this.patch({ autoFill: autoFill && this.profile.hasStoredPassword });
  }

  clear(): AccountProfile {
    this.profile = { ...EMPTY_PROFILE };
    this.write();
    return this.get();
  }

  private patch(changes: Partial<AccountProfile>): AccountProfile {
    this.profile = { ...this.profile, ...changes };
    this.write();
    return this.get();
  }

  private read(): AccountProfile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AccountProfile>;
      return {
        displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
        email: typeof raw.email === 'string' && raw.email.trim() ? raw.email.trim() : null,
        hasStoredPassword: raw.hasStoredPassword === true,
        autoFill: raw.autoFill === true && raw.hasStoredPassword === true,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      };
    } catch {
      return { ...EMPTY_PROFILE };
    }
  }

  private write(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.profile), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // Held for this session only.
    }
  }
}
