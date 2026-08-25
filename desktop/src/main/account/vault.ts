import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * The slice of electron's `safeStorage` this needs. Injected rather than imported so the vault
 * stays testable and so `account/` keeps the same "one file imports electron" rule as `store/`.
 */
export interface VaultBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * A single secret, encrypted by the OS keychain.
 *
 * The important property is what it refuses to do: with no working keychain it stores *nothing*
 * rather than falling back to a file the next process to read the disk could lift. A password
 * manager that silently degrades to plaintext is worse than no password manager, because the user
 * believes the first one.
 */
export class SecretVault {
  constructor(
    private readonly file: string,
    private readonly backend: VaultBackend,
  ) {}

  available(): boolean {
    try {
      return this.backend.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  has(): boolean {
    return existsSync(this.file);
  }

  /** Stores (or, with null, removes) the secret. False means nothing was written. */
  set(secret: string | null): boolean {
    if (secret === null || secret.length === 0) {
      try {
        rmSync(this.file, { force: true });
        return true;
      } catch {
        return false;
      }
    }

    if (!this.available()) return false;

    try {
      const encrypted = this.backend.encryptString(secret);
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, encrypted);
      renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Decrypts the secret. Callers must not keep the result: read it, use it, drop it.
   * Null when there is nothing stored, or when the keychain can no longer decrypt it (which
   * happens legitimately — a different OS user, or a restored profile).
   */
  get(): string | null {
    if (!this.has() || !this.available()) return null;
    try {
      return this.backend.decryptString(readFileSync(this.file));
    } catch {
      return null;
    }
  }
}
