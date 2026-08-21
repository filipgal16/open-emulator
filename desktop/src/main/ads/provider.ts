import type { CreativeSource, SlotId } from '../../shared/ads-types';

export interface FillContext {
  /** Campaign ids that have hit their frequency cap and must not be offered again right now. */
  excluded: ReadonlySet<string>;
  /** Today's impression count for a campaign, so a provider can apply its own tighter cap. */
  countFor: (campaignId: string) => number;
  now: number;
}

/** A provider's answer for one slot, before the service turns it into a tokenized `Creative`. */
export interface Fill {
  campaignId: string;
  headline: string;
  body: string;
  cta: string;
  advertiser: string;
  /** Local `file://` URL only. Providers that source remote art must cache it to disk first. */
  imageUrl: string | null;
  /** Must be `https:`. The service refuses anything else at click time. */
  clickUrl: string;
  /** Android package this promotes, for install attribution. Null for non-install campaigns. */
  packageName?: string | null;
  /** Already-rendered CPI postback, fired once the install is observed in the guest. */
  conversionUrl?: string | null;
}

/**
 * One rung of the fill waterfall. `AdService` walks providers in order and takes the first fill,
 * so registration order is the monetization priority: highest-eCPM source first, with a provider
 * that always fills at the bottom so a slot is never left blank.
 *
 * A provider returning null means "no fill" and is entirely normal. A provider that throws is
 * treated as no-fill too — one broken rung must never take the whole waterfall down.
 */
export interface AdProvider {
  readonly source: CreativeSource;
  fill(slot: SlotId, ctx: FillContext): Promise<Fill | null>;
}
