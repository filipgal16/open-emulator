import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

/** How long after a click an install still counts. Beyond this, networks won't pay anyway. */
const ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60_000;
const POSTBACK_TIMEOUT_MS = 10_000;

interface PendingInstall {
  campaignId: string;
  packageName: string;
  /** Rendered at click time so its subid matches the click the network recorded. */
  conversionUrl: string;
  clickedAt: number;
}

interface Persisted {
  pending: PendingInstall[];
  /** Campaign ids already converted, so a reinstall can't be billed twice. */
  converted: string[];
}

export interface AttributionOptions {
  fetchImpl?: typeof fetch;
  onLog?: (message: string) => void;
}

/**
 * Cost-per-install attribution for sponsored app campaigns.
 *
 * A sponsored tile click is recorded as pending; when that package later shows up in the guest's
 * installed list, the campaign's postback fires and the install is credited. This is the mechanism
 * that makes CPI inventory — the highest-value thing an emulator can sell — actually payable.
 *
 * What crosses the wire is only the campaign's own conversion URL. There is no device identifier
 * and no report of what else is installed: the package list is read locally, matched locally, and
 * discarded.
 */
export class AttributionStore {
  private state: Persisted;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog: (message: string) => void;

  constructor(private readonly file: string, options: AttributionOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.onLog = options.onLog ?? (() => undefined);
    this.state = this.read();
  }

  /** Called when a sponsored install campaign is clicked. No-op for non-install campaigns. */
  recordClick(campaignId: string, packageName: string | null, conversionUrl: string | null, now: number): void {
    if (!packageName || !conversionUrl) return;
    if (this.state.converted.includes(campaignId)) return;

    this.state.pending = this.state.pending.filter((p) => p.campaignId !== campaignId);
    this.state.pending.push({ campaignId, packageName, conversionUrl, clickedAt: now });
    this.prune(now);
    this.write();
  }

  /**
   * Matches the guest's installed packages against pending clicks and fires postbacks for any
   * that landed. Safe to call repeatedly — a converted campaign never fires twice.
   */
  async reconcile(installedPackages: string[], now: number): Promise<string[]> {
    this.prune(now);
    const installed = new Set(installedPackages);
    const landed = this.state.pending.filter((p) => installed.has(p.packageName));
    if (landed.length === 0) return [];

    const credited: string[] = [];
    for (const entry of landed) {
      const ok = await this.postback(entry.conversionUrl);
      if (!ok) continue; // Left pending; the next reconcile retries.
      credited.push(entry.campaignId);
      this.state.converted.push(entry.campaignId);
      this.state.pending = this.state.pending.filter((p) => p.campaignId !== entry.campaignId);
      this.onLog(`install attributed: ${entry.campaignId} (${entry.packageName})`);
    }

    if (credited.length > 0) this.write();
    return credited;
  }

  /** Packages worth watching for — lets the poller skip work when nothing is pending. */
  pendingPackages(now: number): string[] {
    this.prune(now);
    return [...new Set(this.state.pending.map((p) => p.packageName))];
  }

  private async postback(url: string): Promise<boolean> {
    try {
      if (new URL(url).protocol !== 'https:') throw new Error('not https');
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(POSTBACK_TIMEOUT_MS),
        credentials: 'omit',
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (err) {
      this.onLog(`conversion postback failed (will retry): ${(err as Error).message}`);
      return false;
    }
  }

  private prune(now: number): void {
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((p) => now - p.clickedAt <= ATTRIBUTION_WINDOW_MS);
    if (this.state.pending.length !== before) this.write();
  }

  private read(): Persisted {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Persisted>;
      return {
        pending: Array.isArray(raw.pending) ? raw.pending.filter(isPending) : [],
        converted: Array.isArray(raw.converted) ? raw.converted.filter((c) => typeof c === 'string') : [],
      };
    } catch {
      return { pending: [], converted: [] };
    }
  }

  private write(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // In-memory for this session; a missed postback retries on the next launch that can write.
    }
  }
}

function isPending(value: unknown): value is PendingInstall {
  const p = value as PendingInstall;
  return (
    typeof p?.campaignId === 'string' &&
    typeof p?.packageName === 'string' &&
    typeof p?.conversionUrl === 'string' &&
    typeof p?.clickedAt === 'number'
  );
}
