import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

export interface FrequencyCaps {
  /** Hard ceiling on impressions of one campaign per calendar day, across all slots. */
  perCampaignPerDay: number;
  /** Minimum gap before the same campaign may be shown again. Keeps rotation from stuttering. */
  repeatCooldownMs: number;
}

export const DEFAULT_CAPS: FrequencyCaps = { perCampaignPerDay: 12, repeatCooldownMs: 5 * 60_000 };

interface Persisted {
  day: string;
  counts: Record<string, number>;
}

/** Local calendar day, so a cap resets at the user's midnight rather than UTC's. */
function dayKey(now: number): string {
  const d = new Date(now);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Per-campaign impression counting, persisted across restarts.
 *
 * Capping is a revenue feature, not a concession: uncapped repetition burns out an audience, and
 * a user who uninstalls is worth nothing at any eCPM. It also keeps a single campaign from eating
 * a whole session's inventory when the waterfall is only filling from one rung.
 *
 * Counts advance on *impression*, never on fill, so a creative that was requested but never
 * actually seen (window unfocused, slot scrolled away) doesn't consume its own cap.
 */
export class FrequencyStore {
  private state: Persisted;
  private readonly lastShown = new Map<string, number>();

  constructor(
    private readonly file: string,
    private readonly caps: FrequencyCaps = DEFAULT_CAPS,
    now: number = Date.now(),
  ) {
    this.state = this.read(now);
  }

  /** Campaign ids that are capped out or still cooling down, for the providers to skip. */
  excluded(now: number): Set<string> {
    this.rollover(now);
    const out = new Set<string>();

    for (const [id, count] of Object.entries(this.state.counts)) {
      if (count >= this.caps.perCampaignPerDay) out.add(id);
    }
    for (const [id, at] of this.lastShown) {
      if (now - at < this.caps.repeatCooldownMs) out.add(id);
    }
    return out;
  }

  record(campaignId: string, now: number): void {
    this.rollover(now);
    this.state.counts[campaignId] = (this.state.counts[campaignId] ?? 0) + 1;
    this.lastShown.set(campaignId, now);
    this.write();
  }

  countFor(campaignId: string, now: number): number {
    this.rollover(now);
    return this.state.counts[campaignId] ?? 0;
  }

  private rollover(now: number): void {
    const today = dayKey(now);
    if (this.state.day === today) return;
    this.state = { day: today, counts: {} };
    this.write();
  }

  private read(now: number): Persisted {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Persisted>;
      if (typeof raw.day === 'string' && typeof raw.counts === 'object' && raw.counts !== null) {
        const counts = Object.fromEntries(
          Object.entries(raw.counts).filter((e): e is [string, number] => typeof e[1] === 'number'),
        );
        // A stale file from a previous day starts clean rather than carrying counts forward.
        if (raw.day === dayKey(now)) return { day: raw.day, counts };
      }
    } catch {
      // Missing or corrupt: start fresh. Losing yesterday's counts is harmless.
    }
    return { day: dayKey(now), counts: {} };
  }

  private write(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      // Write-then-rename so a crash mid-write can't leave a truncated file that we'd then have
      // to discard on the next launch.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // Capping degrades to in-memory-only for this session. Not worth failing an ad request over.
    }
  }
}
