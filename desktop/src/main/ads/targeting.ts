import type { SlotId } from '../../shared/ads-types';
import type { ManifestCampaign } from './manifest';

export interface TargetingContext {
  slot: SlotId;
  /** ISO-3166-1 alpha-2, from the OS locale. Null when it can't be determined. */
  region: string | null;
  now: number;
  excluded: ReadonlySet<string>;
}

/**
 * Region comes from the operating system's own locale — never from an IP lookup.
 *
 * That distinction is the whole reason Phases 1 and 2 need no consent dialog: no request leaves
 * the machine to determine where the user is, no identifier is transmitted, and nothing is stored
 * about them. Geo-targeting an affiliate offer is worth having, but not worth acquiring a
 * GDPR obligation for.
 */
export function regionFromLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const match = /[-_]([A-Za-z]{2})(?:$|[-_])/.exec(locale);
  return match ? match[1].toUpperCase() : null;
}

export function isEligible(campaign: ManifestCampaign, ctx: TargetingContext): boolean {
  if (!campaign.slots.includes(ctx.slot)) return false;
  if (ctx.excluded.has(campaign.id)) return false;
  if (campaign.startsAt !== null && ctx.now < campaign.startsAt) return false;
  if (campaign.endsAt !== null && ctx.now > campaign.endsAt) return false;

  if (campaign.regions || campaign.excludeRegions.length > 0) {
    // An unknown region can't be shown to satisfy an allowlist, so a geo-targeted campaign is
    // skipped rather than served blind — serving outside a partner's approved territory is how
    // a payout gets reversed.
    if (!ctx.region) return campaign.regions === null && campaign.excludeRegions.length === 0;
    if (campaign.excludeRegions.includes(ctx.region)) return false;
    if (campaign.regions && !campaign.regions.includes(ctx.region)) return false;
  }

  return true;
}

/** `YYYYMMDD` in local time — the only time granularity that reaches a partner. */
function dayStamp(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}${`${d.getMonth() + 1}`.padStart(2, '0')}${`${d.getDate()}`.padStart(2, '0')}`;
}

export interface TemplateContext {
  affiliates: Record<string, string>;
  campaignId: string;
  slot: SlotId;
  now: number;
}

/**
 * Fills the placeholders in a click or conversion URL.
 *
 * Returns null — meaning "skip this campaign" — when a placeholder can't be resolved. Failing
 * closed matters commercially as much as technically: a click URL with an unresolved affiliate id
 * still *works*, it just sends the user to the advertiser with no attribution, so the traffic is
 * given away for free. Better to show a different ad.
 *
 * Note what `{{subid}}` deliberately is not: there is no per-install or per-user identifier in it.
 * Campaign, slot and date are everything an affiliate network needs to attribute and pay a
 * conversion, and none of it identifies a person.
 */
export function renderUrlTemplate(template: string, ctx: TemplateContext): string | null {
  let failed = false;

  const rendered = template.replace(/\{\{([^{}]*)\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();

    if (key.startsWith('affiliate:')) {
      const id = ctx.affiliates[key.slice('affiliate:'.length)];
      if (!id) {
        failed = true;
        return '';
      }
      return encodeURIComponent(id);
    }

    switch (key) {
      case 'subid':
        return encodeURIComponent(`oe-${ctx.campaignId}-${ctx.slot}-${dayStamp(ctx.now)}`);
      case 'campaign':
        return encodeURIComponent(ctx.campaignId);
      case 'slot':
        return encodeURIComponent(ctx.slot);
      default:
        failed = true;
        return '';
    }
  });

  if (failed) return null;

  try {
    return new URL(rendered).protocol === 'https:' ? rendered : null;
  } catch {
    return null;
  }
}

/** Names the affiliate slugs a campaign needs, so a build can report what it can't yet serve. */
export function requiredAffiliates(template: string): string[] {
  const out = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*affiliate:([^{}]*?)\s*\}\}/g)) out.add(match[1]);
  return [...out];
}
