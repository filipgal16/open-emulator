import type { SlotId } from '../../shared/ads-types';
import type { AdProvider, Fill, FillContext } from './provider';
import type { CreativeCache } from './creative-cache';
import type { ManifestClient } from './manifest-client';
import type { ManifestCampaign } from './manifest';
import { isEligible, renderUrlTemplate } from './targeting';

export interface OfferProviderOptions {
  affiliates: Record<string, string>;
  /** Resolves the current ISO-3166-1 alpha-2 region, or null. Called per request; keep it cheap. */
  region: () => string | null;
  random?: () => number;
  onLog?: (message: string) => void;
}

/**
 * Affiliate and CPI inventory from the hosted manifest — the rung that actually earns money.
 *
 * Sits above the house ads and below any third-party network. Fills synchronously from cached
 * manifest data, so a request never blocks on the network.
 */
export class OfferProvider implements AdProvider {
  readonly source = 'offer' as const;
  private readonly random: () => number;
  private readonly onLog: (message: string) => void;

  constructor(
    private readonly manifest: ManifestClient,
    private readonly cache: CreativeCache,
    private readonly options: OfferProviderOptions,
  ) {
    this.random = options.random ?? Math.random;
    this.onLog = options.onLog ?? (() => undefined);
  }

  async fill(slot: SlotId, ctx: FillContext): Promise<Fill | null> {
    const region = this.options.region();
    const eligible = this.manifest
      .campaigns()
      .filter((c) => isEligible(c, { slot, region, now: ctx.now, excluded: ctx.excluded }))
      // A campaign's own cap is tighter than the global one when a partner has bought a fixed
      // number of daily impressions; overshooting is unbilled inventory given away.
      .filter((c) => c.dailyCap === null || ctx.countFor(c.id) < c.dailyCap);
    if (eligible.length === 0) return null;

    // Try in weighted-random order rather than picking once: a campaign whose affiliate id isn't
    // configured must not consume the request, or an unconfigured program would silently starve
    // every other offer behind it.
    for (const campaign of shuffleWeighted(eligible, this.random)) {
      const clickUrl = renderUrlTemplate(campaign.clickUrl, {
        affiliates: this.options.affiliates,
        campaignId: campaign.id,
        slot,
        now: ctx.now,
      });
      if (!clickUrl) {
        this.onLog(`campaign "${campaign.id}" skipped: click URL has unresolved placeholders`);
        continue;
      }

      // Rendered now, alongside the click, so the postback carries the same subid the network
      // recorded against the click. A conversion URL that can't be rendered isn't fatal — the ad
      // still runs, it just can't be credited as an install.
      const conversionUrl = campaign.conversionUrl
        ? renderUrlTemplate(campaign.conversionUrl, {
            affiliates: this.options.affiliates,
            campaignId: campaign.id,
            slot,
            now: ctx.now,
          })
        : null;

      return this.toFill(campaign, clickUrl, conversionUrl);
    }

    return null;
  }

  private toFill(campaign: ManifestCampaign, clickUrl: string, conversionUrl: string | null): Fill {
    let imageUrl: string | null = null;
    if (campaign.imageUrl) {
      // Only art already on disk is used. A cache miss renders text-only now and warms the cache
      // for next time, which is far better than holding the slot blank waiting on a download.
      imageUrl = this.cache.urlIfReady(campaign.imageUrl);
      if (!imageUrl) void this.cache.ensure(campaign.imageUrl);
    }

    return {
      campaignId: campaign.id,
      headline: campaign.headline,
      body: campaign.body,
      cta: campaign.cta,
      advertiser: campaign.advertiser,
      imageUrl,
      clickUrl,
      packageName: campaign.packageName,
      conversionUrl,
    };
  }

  /** Campaigns a build can't serve because their affiliate ids are missing — surfaced by `doctor`. */
  unservable(): Array<{ id: string; missing: string[] }> {
    const out: Array<{ id: string; missing: string[] }> = [];
    for (const campaign of this.manifest.campaigns()) {
      const missing = [...campaign.clickUrl.matchAll(/\{\{\s*affiliate:([^{}]*?)\s*\}\}/g)]
        .map((m) => m[1])
        .filter((slug) => !this.options.affiliates[slug]);
      if (missing.length > 0) out.push({ id: campaign.id, missing: [...new Set(missing)] });
    }
    return out;
  }
}

/** Weighted shuffle: repeatedly draws without replacement, proportional to weight. */
function shuffleWeighted(campaigns: ManifestCampaign[], random: () => number): ManifestCampaign[] {
  const pool = [...campaigns];
  const order: ManifestCampaign[] = [];

  while (pool.length > 0) {
    const total = pool.reduce((sum, c) => sum + c.weight, 0);
    let ticket = random() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      ticket -= pool[i].weight;
      if (ticket < 0) {
        index = i;
        break;
      }
    }
    order.push(pool.splice(index, 1)[0]);
  }
  return order;
}
