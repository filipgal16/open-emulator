import { readFileSync } from 'fs';
import path from 'path';

/**
 * Contents of `ads.config.json` — the only file an operator edits to turn monetization on.
 *
 * The file is gitignored and absent from the repo, so a source build (and any fork or distro
 * package) is ad-free by default. Shipping populated keys in a public repo is how they get
 * scraped and how an ad account gets terminated for invalid traffic, so "off unless explicitly
 * configured" is the safe default rather than a courtesy.
 */
export interface AdsConfig {
  enabled: boolean;
  /** Phase 2: campaign manifest endpoint. Ignored while null. */
  manifestUrl: string | null;
  /** Phase 2: affiliate program ids, keyed by program slug. */
  affiliates: Record<string, string>;
  /** Phase 3: third-party network. Ignored unless both `provider` and `tagHtml` are set. */
  network: {
    provider: string | null;
    publisherId: string | null;
    /** The network's own ad tag snippet, pasted verbatim. Runs only in the isolated tag view. */
    tagHtml: string | null;
    /** Slot ids the tag is allowed to occupy. Empty means every slot. */
    slots: string[];
    /** How long to wait for the tag to paint before falling back to native inventory. */
    timeoutMs: number;
  };
  /** Phase 4: base64 DER SPKI Ed25519 public key that remove-ads licences are verified against. */
  entitlement: { publicKey: string | null };
}

export const DISABLED_ADS_CONFIG: AdsConfig = {
  enabled: false,
  manifestUrl: null,
  affiliates: {},
  network: { provider: null, publisherId: null, tagHtml: null, slots: [], timeoutMs: 4000 },
  entitlement: { publicKey: null },
};

export const ADS_CONFIG_FILENAME = 'ads.config.json';

function coerce(raw: unknown): AdsConfig {
  if (typeof raw !== 'object' || raw === null) return { ...DISABLED_ADS_CONFIG };
  const obj = raw as Record<string, unknown>;
  const network = (typeof obj.network === 'object' && obj.network !== null ? obj.network : {}) as Record<string, unknown>;
  const affiliates = (typeof obj.affiliates === 'object' && obj.affiliates !== null ? obj.affiliates : {}) as Record<
    string,
    unknown
  >;
  const entitlement = (
    typeof obj.entitlement === 'object' && obj.entitlement !== null ? obj.entitlement : {}
  ) as Record<string, unknown>;

  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

  return {
    enabled: obj.enabled === true,
    manifestUrl: text(obj.manifestUrl),
    affiliates: Object.fromEntries(
      Object.entries(affiliates).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    network: {
      provider: text(network.provider),
      publisherId: text(network.publisherId),
      tagHtml: text(network.tagHtml),
      slots: Array.isArray(network.slots) ? network.slots.filter((s): s is string => typeof s === 'string') : [],
      timeoutMs:
        typeof network.timeoutMs === 'number' && network.timeoutMs > 0
          ? Math.min(30_000, Math.floor(network.timeoutMs))
          : 4000,
    },
    entitlement: { publicKey: text(entitlement.publicKey) },
  };
}

/** A third-party tag runs only when the operator has supplied both a name for it and its code. */
export function usesThirdPartyTags(config: AdsConfig): boolean {
  return config.enabled && Boolean(config.network.provider) && Boolean(config.network.tagHtml);
}

/**
 * Reads the first `ads.config.json` found in `searchDirs`. A missing or unparseable file is not an
 * error — it simply means this build has no ad configuration, which is the normal state for a
 * source checkout.
 *
 * `OPEN_EMULATOR_ADS=1` force-enables ads with house-only inventory so the slots can be exercised
 * in development without any real configuration; `OPEN_EMULATOR_ADS=0` force-disables them.
 */
export function loadAdsConfig(searchDirs: string[], env: NodeJS.ProcessEnv = process.env): AdsConfig {
  let config: AdsConfig = { ...DISABLED_ADS_CONFIG };

  for (const dir of searchDirs) {
    try {
      config = coerce(JSON.parse(readFileSync(path.join(dir, ADS_CONFIG_FILENAME), 'utf8')));
      break;
    } catch {
      // Not in this directory (or malformed) — keep looking.
    }
  }

  const override = env.OPEN_EMULATOR_ADS;
  if (override === '1') config.enabled = true;
  if (override === '0') config.enabled = false;

  return config;
}
