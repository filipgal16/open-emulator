// Shared between main, preload, and renderer. Type-only content plus plain data constants —
// safe to import from both the tsc-compiled (CommonJS/Node) side and the esbuild-bundled
// (browser) renderer side. Nothing here may import electron or node builtins.

/**
 * Master switch for the ad subsystem in this build.
 *
 * False here: nothing under `ads/` is constructed, no ad IPC is registered, and no ad markup
 * reaches the DOM — not an inactive slot that renders null, but no component mounted at all.
 *
 * The subsystem itself is untouched and still covered by its tests, so this is a switch rather
 * than a removal: flipping it back to true restores the ad-supported build. It is deliberately a
 * plain constant rather than config, because an ad-free build should not depend on a file being
 * absent at runtime.
 */
// Annotated `boolean` rather than left as the literal `false`: that keeps both branches
// type-checked, so the ad-supported path cannot rot while the switch is off.
export const ADS_ENABLED: boolean = false;

export type SlotId = 'wizard-footer' | 'rail' | 'boot-interstitial' | 'library-tile' | 'store-tile';

export type CreativeSource = 'network' | 'offer' | 'house';

export interface SlotSpec {
  id: SlotId;
  width: number;
  height: number;
  /** How long a filled creative stays put before the slot asks for another one. */
  rotateAfterMs: number;
  /**
   * Whether house ads may fill this slot when nothing paid does.
   *
   * True for inline slots: the space is already reserved, so a project notice there costs the
   * user nothing. False for interruptive slots, which must not appear at all without paid
   * demand — an interstitial shown to promote our own GitHub is pure annoyance for zero revenue.
   */
  houseFloor: boolean;
}

export const SLOTS: Record<SlotId, SlotSpec> = {
  // Shown while the setup wizard downloads the SDK and provisions the AVD — minutes of dwell
  // where nothing else is competing for attention, so it rotates faster than the rail.
  'wizard-footer': { id: 'wizard-footer', width: 728, height: 90, rotateAfterMs: 30_000, houseFloor: true },
  rail: { id: 'rail', width: 300, height: 600, rotateAfterMs: 45_000, houseFloor: true },
  // Covers the boot wait only. It never rotates: it is dismissed by the first frame arriving,
  // and swapping the creative under a user who is about to dismiss it would be pure churn.
  'boot-interstitial': { id: 'boot-interstitial', width: 640, height: 400, rotateAfterMs: 0, houseFloor: false },
  // Sponsored entries in the app library grid. Rotates slowly — the grid is browsed, not watched.
  'library-tile': { id: 'library-tile', width: 240, height: 200, rotateAfterMs: 120_000, houseFloor: true },
  // The store's results grid. Someone browsing for something to install is the audience an app
  // campaign actually wants, so this is the most valuable inline slot in the shell — which is
  // exactly why it stays a labelled card in the flow and never a fake search result.
  'store-tile': { id: 'store-tile', width: 240, height: 210, rotateAfterMs: 120_000, houseFloor: true },
};

export const SLOT_IDS = Object.keys(SLOTS) as SlotId[];

/**
 * One filled ad, as handed to the renderer.
 *
 * Deliberately carries no destination URL: the renderer echoes `token` back and the main process
 * resolves it to a real URL. A compromised renderer therefore can't turn the ad system into an
 * "open any URL" primitive, and affiliate subid construction stays out of reach of page script.
 */
export interface Creative {
  /** Unique per fill (not per campaign). Echoed back for impression + click reporting. */
  token: string;
  campaignId: string;
  source: CreativeSource;
  slot: SlotId;
  headline: string;
  body: string;
  cta: string;
  /** Local `file://` URL of a cached image, or null for a text-rendered creative. */
  imageUrl: string | null;
  /** Named next to the "Sponsored" label so the creative is never unattributed. */
  advertiser: string;
}

export type ConsentStatus = 'not-required' | 'pending' | 'granted' | 'denied';

export interface AdsState {
  /** Master switch from ads.config.json. False in unconfigured builds (the repo default). */
  configured: boolean;
  /** User turned ads off from the slot's own control. */
  optedOut: boolean;
  /** A verified remove-ads licence is installed. */
  adsRemoved: boolean;
  /**
   * `not-required` unless this build loads third-party tags — native creatives from our own
   * manifest transmit nothing that consent would govern.
   */
  consent: ConsentStatus;
  /** True only when all of the above allow rendering. Slots check this and nothing else. */
  active: boolean;
}

export const INACTIVE_ADS_STATE: AdsState = {
  configured: false,
  optedOut: false,
  adsRemoved: false,
  consent: 'not-required',
  active: false,
};

/** Tells a slot whether to try a third-party tag before falling back to the native waterfall. */
export interface TagPlan {
  enabled: boolean;
  /** How long to wait for the tag to report a fill before giving up on it. */
  timeoutMs: number;
}

export interface SlotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LicenseResult {
  ok: boolean;
  message: string;
  state: AdsState;
}
