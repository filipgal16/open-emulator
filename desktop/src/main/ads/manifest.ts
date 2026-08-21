import type { SlotId } from '../../shared/ads-types';
import { SLOTS } from '../../shared/ads-types';

/**
 * One campaign as published in the remote manifest.
 *
 * Everything optional in the JSON is normalised to an explicit null here, so downstream code never
 * has to distinguish "absent" from "empty".
 */
export interface ManifestCampaign {
  id: string;
  slots: SlotId[];
  weight: number;
  advertiser: string;
  headline: string;
  body: string;
  cta: string;
  /** https URL of the creative art, or null for a text-rendered campaign. */
  imageUrl: string | null;
  /** May contain `{{affiliate:slug}}`, `{{subid}}`, `{{campaign}}`, `{{slot}}` placeholders. */
  clickUrl: string;
  /** CPI postback fired once an attributed install is observed in the guest. */
  conversionUrl: string | null;
  /** Android package this campaign promotes — the attribution target for `conversionUrl`. */
  packageName: string | null;
  /** ISO-3166-1 alpha-2 allowlist. Null means "anywhere not excluded". */
  regions: string[] | null;
  excludeRegions: string[];
  startsAt: number | null;
  endsAt: number | null;
  /** Overrides the global per-campaign daily cap when set. */
  dailyCap: number | null;
}

export interface Manifest {
  version: number;
  updatedAt: number;
  ttlSeconds: number;
  campaigns: ManifestCampaign[];
}

export const EMPTY_MANIFEST: Manifest = { version: 1, updatedAt: 0, ttlSeconds: 3600, campaigns: [] };

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function httpsUrl(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * A click URL is a *template*, so it won't parse until the placeholders are filled. Substituting a
 * benign literal first lets the same https-only rule apply to templates and plain URLs alike —
 * and rejecting here means a hostile manifest can't smuggle a `file:` or `javascript:` destination
 * past the click-time check by hiding the scheme behind a placeholder.
 */
function httpsUrlTemplate(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const probe = raw.replace(/\{\{[^{}]*\}\}/g, 'x');
  try {
    return new URL(probe).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

function regionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => str(v)?.toUpperCase() ?? '')
    .filter((v) => /^[A-Z]{2}$/.test(v));
}

function timestamp(value: unknown): number | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSlotId(value: unknown): value is SlotId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SLOTS, value);
}

function parseCampaign(raw: unknown): ManifestCampaign | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const id = str(obj.id);
  const headline = str(obj.headline);
  const cta = str(obj.cta);
  const advertiser = str(obj.advertiser);
  const clickUrl = httpsUrlTemplate(obj.clickUrl);
  const slots = Array.isArray(obj.slots) ? obj.slots.filter(isSlotId) : [];
  const weight = typeof obj.weight === 'number' && obj.weight > 0 ? obj.weight : 1;

  // Every one of these is load-bearing: a campaign with no destination earns nothing, and one
  // with no advertiser can't be honestly labelled.
  if (!id || !headline || !cta || !advertiser || !clickUrl || slots.length === 0) return null;

  const dailyCap = typeof obj.dailyCap === 'number' && obj.dailyCap > 0 ? Math.floor(obj.dailyCap) : null;
  const regions = Array.isArray(obj.regions) ? regionList(obj.regions) : null;

  return {
    id,
    slots,
    weight,
    advertiser,
    headline,
    body: str(obj.body) ?? '',
    cta,
    imageUrl: httpsUrl(obj.imageUrl),
    clickUrl,
    conversionUrl: httpsUrlTemplate(obj.conversionUrl),
    packageName: str(obj.packageName),
    regions: regions && regions.length > 0 ? regions : null,
    excludeRegions: regionList(obj.excludeRegions),
    startsAt: timestamp(obj.startsAt),
    endsAt: timestamp(obj.endsAt),
    dailyCap,
  };
}

export interface ParsedManifest {
  manifest: Manifest;
  /** Ids (or positions) of entries that failed validation, for logging. */
  dropped: string[];
}

/**
 * Parses and validates a manifest.
 *
 * One malformed campaign drops that campaign, not the whole manifest — a typo in a single entry
 * should cost one line of inventory, not every slot in the product.
 */
export function parseManifest(raw: unknown): ParsedManifest {
  if (typeof raw !== 'object' || raw === null) return { manifest: { ...EMPTY_MANIFEST }, dropped: ['<root>'] };
  const obj = raw as Record<string, unknown>;

  const dropped: string[] = [];
  const campaigns: ManifestCampaign[] = [];
  const seen = new Set<string>();

  const rawCampaigns = Array.isArray(obj.campaigns) ? obj.campaigns : [];
  rawCampaigns.forEach((entry, index) => {
    const campaign = parseCampaign(entry);
    if (!campaign) {
      const label = (entry as { id?: unknown })?.id;
      dropped.push(typeof label === 'string' ? label : `#${index}`);
      return;
    }
    // Duplicate ids would make frequency capping ambiguous — the second one is dropped.
    if (seen.has(campaign.id)) {
      dropped.push(`${campaign.id} (duplicate)`);
      return;
    }
    seen.add(campaign.id);
    campaigns.push(campaign);
  });

  const ttlRaw = typeof obj.ttlSeconds === 'number' ? obj.ttlSeconds : EMPTY_MANIFEST.ttlSeconds;

  return {
    manifest: {
      version: typeof obj.version === 'number' ? obj.version : 1,
      updatedAt: timestamp(obj.updatedAt) ?? 0,
      // Clamped so a publishing mistake can't pin clients to a 1-second refresh loop (hammering
      // the CDN) or a one-year cache (making campaigns unretractable).
      ttlSeconds: Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(ttlRaw))),
      campaigns,
    },
    dropped,
  };
}
