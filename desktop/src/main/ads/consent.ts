/**
 * EEA + UK + Switzerland. These are the jurisdictions where loading a third-party ad tag without
 * prior consent is unlawful, not merely impolite.
 */
const CONSENT_REQUIRED_REGIONS = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH',
]);

import type { ConsentStatus } from '../../shared/ads-types';

export type { ConsentStatus };

export interface ConsentState {
  status: ConsentStatus;
  /** True only on an explicit grant. Everything else runs non-personalized. */
  personalized: boolean;
}

export interface ConsentInputs {
  /** Whether this build actually loads a third-party tag. */
  usesThirdPartyTags: boolean;
  region: string | null;
  /** Persisted answer, if the user has given one. */
  answer: boolean | null;
}

/**
 * Decides whether a consent prompt is owed, and what personalization the ad stack may use.
 *
 * Two properties worth keeping:
 *
 * 1. Phases 1–2 never reach `pending`. Native creatives from our own manifest set no cookies,
 *    transmit no identifier, and derive region from the OS locale rather than an IP lookup, so
 *    there is nothing to consent *to*. The prompt appears only when a real tag is configured.
 * 2. Refusing consent is not a revenue cliff. It disables the third-party rung; the affiliate and
 *    house rungs keep filling, because they never needed consent in the first place.
 */
export function resolveConsent({ usesThirdPartyTags, region, answer }: ConsentInputs): ConsentState {
  if (!usesThirdPartyTags) return { status: 'not-required', personalized: false };

  if (answer === true) return { status: 'granted', personalized: true };
  if (answer === false) return { status: 'denied', personalized: false };

  // An unknown region is treated as in-scope. Guessing "probably not Europe" in order to skip a
  // consent prompt is exactly the wrong way to be wrong.
  const inScope = region === null || CONSENT_REQUIRED_REGIONS.has(region);
  return inScope ? { status: 'pending', personalized: false } : { status: 'granted', personalized: false };
}

/** Whether a third-party tag may load right now. */
export function tagsAllowed(state: ConsentState): boolean {
  return state.status === 'granted';
}

export function isConsentRegion(region: string | null): boolean {
  return region === null || CONSENT_REQUIRED_REGIONS.has(region);
}
