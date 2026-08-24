import type { StoreApp } from '../../../shared/store-types';

/**
 * Why an install is blocked, as a sentence a person can act on.
 *
 * The shared helper returns a short machine-ish reason (`Needs API 33 (guest is 30)`). The UI
 * keeps that computation and rewrites it here — the facts are the same; the tone is not a warning.
 */
export function compatibilityCopy(
  app: StoreApp,
  guestSdk: number | null,
): { kind: 'ok' | 'wait' | 'incompatible'; sentence: string | null } {
  if (guestSdk === null) {
    return {
      kind: 'wait',
      sentence: 'Start the device to see whether this app can run on it.',
    };
  }
  if (app.minSdk > guestSdk) {
    return {
      kind: 'incompatible',
      sentence: `This build needs API ${app.minSdk}. This device is on API ${guestSdk}, so it can’t install.`,
    };
  }
  return { kind: 'ok', sentence: null };
}

const ANTI_FEATURES: Record<string, string> = {
  Ads: 'Contains ads',
  Tracking: 'Tracks you',
  NonFreeNet: 'Uses non-free network services',
  NonFreeAdd: 'Promotes non-free add-ons',
  NonFreeDep: 'Depends on non-free software',
  NonFreeAssets: 'Contains non-free assets',
  UpstreamNonFree: 'Upstream includes non-free parts',
  NonFreeComp: 'Includes non-free components',
  KnownVuln: 'Has a known vulnerability',
  DisabledAlgorithm: 'Uses a disabled algorithm',
  NoSourceSince: 'Source is no longer available',
  NSFW: 'Not safe for work',
  TetheredNet: 'Needs a specific online service',
};

export function antiFeatureLabel(id: string): string {
  return ANTI_FEATURES[id] ?? id.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function formatUpdated(timestamp: number): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const days = Math.round((Date.now() - timestamp) / 86_400_000);
  if (days < 1) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 14) return `Updated ${days} days ago`;
  if (days < 60) return `Updated ${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `Updated ${Math.round(days / 30)} months ago`;
  return `Updated ${Math.round(days / 365)} years ago`;
}

export function sourceLabel(source: StoreApp['source']): string {
  if (source === 'fdroid') return 'F-Droid';
  if (source === 'local') return 'Local';
  return 'Play';
}
