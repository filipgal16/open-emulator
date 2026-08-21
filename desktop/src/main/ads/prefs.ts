import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

export interface AdPrefs {
  optedOut: boolean;
  /** Null until the user answers the consent prompt. Only meaningful for third-party tags. */
  consent: boolean | null;
  /** Remove-ads licence key, re-verified on every launch rather than trusted as a stored flag. */
  license: string | null;
}

const DEFAULTS: AdPrefs = { optedOut: false, consent: null, license: null };

/**
 * User-facing ad preferences, kept separate from frequency counters so that clearing rotation
 * state can never silently re-enable ads for someone who turned them off.
 */
export class AdPrefsStore {
  private prefs: AdPrefs;

  constructor(private readonly file: string) {
    this.prefs = this.read();
  }

  get(): AdPrefs {
    return { ...this.prefs };
  }

  setOptedOut(optedOut: boolean): AdPrefs {
    return this.patch({ optedOut });
  }

  setConsent(consent: boolean | null): AdPrefs {
    return this.patch({ consent });
  }

  setLicense(license: string | null): AdPrefs {
    return this.patch({ license });
  }

  private patch(changes: Partial<AdPrefs>): AdPrefs {
    this.prefs = { ...this.prefs, ...changes };
    this.write();
    return this.get();
  }

  private read(): AdPrefs {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AdPrefs>;
      return {
        optedOut: raw.optedOut === true,
        consent: typeof raw.consent === 'boolean' ? raw.consent : null,
        license: typeof raw.license === 'string' ? raw.license : null,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private write(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.prefs), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // Opt-out failing to persist is bad but not fatal — it still holds for this session.
    }
  }
}
