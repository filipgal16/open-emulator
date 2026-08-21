import { randomUUID } from 'crypto';
import type { AdsState, Creative, SlotId, TagPlan } from '../../shared/ads-types';
import { INACTIVE_ADS_STATE } from '../../shared/ads-types';
import type { AdsConfig } from './config';
import type { AdProvider } from './provider';
import type { FrequencyStore } from './frequency';
import type { AdPrefsStore } from './prefs';
import type { ConsentState } from './consent';
import type { AttributionStore } from './attribution';

interface TokenRecord {
  campaignId: string;
  slot: SlotId;
  clickUrl: string;
  packageName: string | null;
  conversionUrl: string | null;
  mintedAt: number;
  impressed: boolean;
}

export interface AdServiceOptions {
  now?: () => number;
  /** How many outstanding fills stay resolvable. Old tokens are evicted oldest-first. */
  maxTokens?: number;
  onError?: (message: string) => void;
  /** Current consent decision. Absent means "nothing that needs consent is configured". */
  consent?: () => ConsentState;
  /** True when a verified remove-ads licence is installed. */
  entitled?: () => boolean;
  /** Records CPI clicks so a later install can be credited. */
  attribution?: AttributionStore;
  /** Whether a third-party tag should be attempted for a slot before the native waterfall. */
  tagPlan?: (slot: SlotId) => TagPlan | null;
}

/**
 * Orchestrates the fill waterfall and owns everything the renderer isn't trusted with:
 * destination URLs, frequency state, consent, entitlement, and attribution.
 *
 * Providers are consulted in registration order and the first fill wins, so the array passed to
 * the constructor *is* the monetization priority.
 */
export class AdService {
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly now: () => number;
  private readonly maxTokens: number;
  private readonly onError: (message: string) => void;

  constructor(
    private readonly config: AdsConfig,
    private readonly providers: AdProvider[],
    private readonly frequency: FrequencyStore,
    private readonly prefs: AdPrefsStore,
    private readonly options: AdServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.maxTokens = options.maxTokens ?? 128;
    this.onError = options.onError ?? (() => undefined);
  }

  state(): AdsState {
    if (!this.config.enabled) return { ...INACTIVE_ADS_STATE };

    const { optedOut } = this.prefs.get();
    const adsRemoved = this.options.entitled?.() === true;
    const consent = this.options.consent?.().status ?? 'not-required';

    // A pending consent decision blocks the third-party rung, not the whole stack — the native
    // rungs never needed consent, so they keep earning while the dialog is open.
    return { configured: true, optedOut, adsRemoved, consent, active: !optedOut && !adsRemoved };
  }

  setOptedOut(optedOut: boolean): AdsState {
    this.prefs.setOptedOut(optedOut);
    return this.state();
  }

  /** Whether this slot should try a third-party tag first. Null when no network is configured. */
  tagPlan(slot: SlotId): TagPlan | null {
    if (!this.state().active) return null;
    return this.options.tagPlan?.(slot) ?? null;
  }

  /**
   * Walks the waterfall for one slot. Returns null when ads are off or every rung declined —
   * the renderer treats that as "render nothing", never as an error.
   */
  async request(slot: SlotId): Promise<Creative | null> {
    if (!this.state().active) return null;

    const now = this.now();
    const ctx = {
      excluded: this.frequency.excluded(now),
      countFor: (campaignId: string) => this.frequency.countFor(campaignId, now),
      now,
    };

    for (const provider of this.providers) {
      let fill;
      try {
        fill = await provider.fill(slot, ctx);
      } catch (err) {
        // One broken rung must not take down the rungs below it — that would turn a partner
        // outage into a blank slot when the house ad would have filled fine.
        this.onError(`ad provider "${provider.source}" failed: ${(err as Error).message}`);
        continue;
      }
      if (!fill) continue;

      if (!isSafeClickUrl(fill.clickUrl)) {
        this.onError(`ad provider "${provider.source}" returned a non-https clickUrl; skipping`);
        continue;
      }

      const token = randomUUID();
      this.remember(token, {
        campaignId: fill.campaignId,
        slot,
        clickUrl: fill.clickUrl,
        packageName: fill.packageName ?? null,
        conversionUrl: fill.conversionUrl ?? null,
        mintedAt: now,
        impressed: false,
      });

      return {
        token,
        campaignId: fill.campaignId,
        source: provider.source,
        slot,
        headline: fill.headline,
        body: fill.body,
        cta: fill.cta,
        imageUrl: fill.imageUrl,
        advertiser: fill.advertiser,
      };
    }

    return null;
  }

  /**
   * Counted only when the renderer confirms the creative was actually viewable — window focused
   * and the slot on screen. Repeat calls for the same token are ignored, so a re-render or a
   * focus flicker can't inflate the count.
   */
  recordImpression(token: string): boolean {
    const record = this.tokens.get(token);
    if (!record || record.impressed) return false;
    record.impressed = true;
    this.frequency.record(record.campaignId, this.now());
    return true;
  }

  /**
   * Resolves a click token to the URL the main process should open in the system browser, and
   * arms install attribution when the campaign promotes an app.
   *
   * Returns null for unknown or expired tokens — the renderer cannot name a destination itself.
   */
  resolveClick(token: string): string | null {
    const record = this.tokens.get(token);
    if (!record) return null;
    if (!isSafeClickUrl(record.clickUrl)) return null;

    this.options.attribution?.recordClick(
      record.campaignId,
      record.packageName,
      record.conversionUrl,
      this.now(),
    );
    return record.clickUrl;
  }

  private remember(token: string, record: TokenRecord): void {
    this.tokens.set(token, record);
    while (this.tokens.size > this.maxTokens) {
      const oldest = this.tokens.keys().next();
      if (oldest.done) break;
      this.tokens.delete(oldest.value);
    }
  }
}

/**
 * Clicks are handed to `shell.openExternal`, which will happily launch non-http schemes — so the
 * scheme check is the boundary that stops a hostile campaign manifest from becoming local code
 * execution. https only: no http, no file, no custom protocol handlers.
 */
export function isSafeClickUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
