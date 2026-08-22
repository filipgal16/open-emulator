import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import path from 'path';
import type { AdsState, Creative, LicenseResult, SlotBounds, SlotId, TagPlan } from '../../shared/ads-types';
import { SLOTS } from '../../shared/ads-types';
import type { AppLibrary } from '../app-library';
import { AdService } from './ad-service';
import { AttributionStore } from './attribution';
import { loadAdsConfig, usesThirdPartyTags } from './config';
import { resolveConsent, tagsAllowed } from './consent';
import { AD_SCHEME, CreativeCache } from './creative-cache';
import { licenseErrorMessage, verifyLicense } from './entitlement';
import { FrequencyStore } from './frequency';
import { HouseProvider } from './house-provider';
import { ManifestClient } from './manifest-client';
import { AD_TAG_PARTITION, AD_TAG_SCHEME, NetworkTagHost } from './network-tag-host';
import { OfferProvider } from './offer-provider';
import { AdPrefsStore } from './prefs';
import { regionFromLocale } from './targeting';

export { AdService } from './ad-service';

/** How often to check the guest for a pending sponsored install. */
const ATTRIBUTION_POLL_MS = 60_000;

/**
 * Must run before `app.whenReady()`.
 *
 * `oe-ad` carries cached campaign art; `oe-adtag` serves the wrapper document that a third-party
 * tag runs inside. Both are registered as standard and secure so pages served from them get a
 * real origin — an opaque origin breaks most ad tags, and `fetch` from a non-standard scheme is
 * blocked outright.
 */
export function registerAdSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: AD_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    {
      scheme: AD_TAG_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export interface AdsRuntime {
  service: AdService;
  registerIpc(getWindow: () => BrowserWindow | null, library: AppLibrary | null): void;
  dispose(): void;
}

/**
 * Builds the whole ad stack and wires it to Electron.
 *
 * This is the only file under `ads/` that imports electron — the service, providers, and stores
 * stay plain Node so they can be unit-tested with `node --test` against the compiled output.
 */
export function createAds(onLog: (line: string) => void = () => undefined): AdsRuntime {
  const log = (message: string) => onLog(`[ads] ${message}`);

  // dist/main/ads → desktop/. In a packaged build the config ships alongside the asar instead,
  // so `resourcesPath` gets first look.
  const appRoot = path.resolve(__dirname, '../../..');
  const searchDirs = process.resourcesPath ? [process.resourcesPath, appRoot] : [appRoot];
  const config = loadAdsConfig(searchDirs);

  const userData = app.getPath('userData');
  const frequency = new FrequencyStore(path.join(userData, 'ads-frequency.json'));
  const prefs = new AdPrefsStore(path.join(userData, 'ads-prefs.json'));
  const attribution = new AttributionStore(path.join(userData, 'ads-attribution.json'), { onLog: log });
  const manifest = new ManifestClient(config.manifestUrl, path.join(userData, 'ads-manifest.json'), { onLog: log });
  const creatives = new CreativeCache(path.join(userData, 'ads-creatives'), { onLog: log });

  const region = () => regionFromLocale(app.getLocale());
  const thirdParty = usesThirdPartyTags(config);
  const consent = () =>
    resolveConsent({ usesThirdPartyTags: thirdParty, region: region(), answer: prefs.get().consent });

  const entitled = () => {
    const key = prefs.get().license;
    return key ? verifyLicense(key, config.entitlement.publicKey, Date.now()).valid : false;
  };

  const offers = new OfferProvider(manifest, creatives, { affiliates: config.affiliates, region, onLog: log });

  // Registration order is the fill priority: paid inventory first, house ads last so a slot that
  // chose to render never comes back empty. The third-party tag isn't a rung here — it can't
  // produce a native creative, so it runs ahead of the waterfall via `tagPlan` instead.
  const providers = [offers, new HouseProvider()];

  const tagPlan = (slot: SlotId): TagPlan | null => {
    if (!thirdParty || !tagsAllowed(consent())) return null;
    const allowed = config.network.slots;
    if (allowed.length > 0 && !allowed.includes(slot)) return null;
    return { enabled: true, timeoutMs: config.network.timeoutMs };
  };

  const service = new AdService(config, providers, frequency, prefs, {
    onError: log,
    consent,
    entitled,
    attribution,
    tagPlan,
  });

  if (config.enabled) {
    void manifest.refresh().then(() => {
      const art = manifest
        .campaigns()
        .map((c) => c.imageUrl)
        .filter((url): url is string => Boolean(url));
      void creatives.prefetch(art);
      const unservable = offers.unservable();
      for (const entry of unservable) {
        log(`campaign "${entry.id}" cannot serve: missing affiliate id(s) ${entry.missing.join(', ')}`);
      }
    });
  }

  log(
    `${config.enabled ? 'enabled' : 'disabled'} · ${providers.length} provider(s)` +
      ` · tags ${thirdParty ? config.network.provider : 'none'} · consent ${consent().status}`,
  );

  let tagHost: NetworkTagHost | null = null;
  let attributionTimer: NodeJS.Timeout | null = null;

  return {
    service,

    registerIpc(getWindow, library) {
      registerProtocols(creatives, () => tagHost, consent);

      if (thirdParty && config.network.tagHtml) {
        tagHost = new NetworkTagHost(getWindow, {
          tagHtml: config.network.tagHtml,
          onLog: log,
          onResult: (slot, filled) => {
            getWindow()?.webContents.send('ads:tag-result', slot, filled);
          },
        });
      }

      registerAdsIpc(service, () => tagHost, consent, prefs, config.entitlement.publicKey, log);

      if (config.enabled && library) {
        attributionTimer = setInterval(() => {
          void reconcileInstalls(attribution, library, log);
        }, ATTRIBUTION_POLL_MS);
      }
    },

    dispose() {
      if (attributionTimer) clearInterval(attributionTimer);
      tagHost?.unmountAll();
    },
  };
}

/**
 * Polls the guest for sponsored installs that have landed.
 *
 * Only runs while something is actually pending — the package list costs an adb round trip, and
 * spending one every minute to learn nothing would be a real cost on a TCG-backed emulator.
 */
async function reconcileInstalls(
  attribution: AttributionStore,
  library: AppLibrary,
  log: (message: string) => void,
): Promise<void> {
  try {
    if (attribution.pendingPackages(Date.now()).length === 0) return;
    await attribution.reconcile(await library.listPackageNames(), Date.now());
  } catch (err) {
    log(`install reconcile failed: ${(err as Error).message}`);
  }
}

function registerProtocols(
  creatives: CreativeCache,
  getTagHost: () => NetworkTagHost | null,
  consent: () => { personalized: boolean },
): void {
  protocol.handle(AD_SCHEME, (request) => {
    // `oe-ad://creative/<id>` and nothing else. The id is hex-validated inside the cache, so no
    // attacker-controlled text is ever joined onto a filesystem path.
    const id = new URL(request.url).pathname.replace(/^\/+/, '');
    const found = creatives.read(id);
    if (!found) return new Response('not found', { status: 404 });
    // Copied into a standalone ArrayBuffer: a Buffer view can point into a shared pool slab, and
    // handing that to Response would expose neighbouring bytes.
    const body = found.bytes.buffer.slice(
      found.bytes.byteOffset,
      found.bytes.byteOffset + found.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: { 'content-type': found.mime, 'cache-control': 'no-store' },
    });
  });

  protocol.handle(AD_TAG_SCHEME, () => {
    const host = getTagHost();
    if (!host) return new Response('no tag configured', { status: 404 });
    return host.handleRequest(consent().personalized);
  });
}

function isSlotId(value: unknown): value is SlotId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SLOTS, value);
}

function isBounds(value: unknown): value is SlotBounds {
  const b = value as SlotBounds;
  return (
    typeof b?.x === 'number' &&
    typeof b?.y === 'number' &&
    typeof b?.width === 'number' &&
    typeof b?.height === 'number' &&
    b.width >= 0 &&
    b.height >= 0
  );
}

function registerAdsIpc(
  service: AdService,
  getTagHost: () => NetworkTagHost | null,
  consent: () => { personalized: boolean },
  prefs: AdPrefsStore,
  publicKey: string | null,
  log: (message: string) => void,
): void {
  ipcMain.handle('ads:state', (): AdsState => service.state());

  ipcMain.handle('ads:request', async (_event, slot: unknown): Promise<Creative | null> => {
    // The renderer is untrusted input even though we wrote it — an unknown slot id gets no fill
    // rather than reaching a provider.
    if (!isSlotId(slot)) return null;
    return service.request(slot);
  });

  ipcMain.handle('ads:set-opted-out', (_event, optedOut: unknown): AdsState => service.setOptedOut(optedOut === true));

  ipcMain.handle('ads:set-consent', (_event, granted: unknown): AdsState => {
    prefs.setConsent(granted === true);
    return service.state();
  });

  ipcMain.handle('ads:activate-license', (_event, key: unknown): LicenseResult => {
    if (typeof key !== 'string') {
      return { ok: false, message: licenseErrorMessage('malformed'), state: service.state() };
    }
    const check = verifyLicense(key, publicKey, Date.now());
    if (!check.valid) {
      return { ok: false, message: licenseErrorMessage(check.reason), state: service.state() };
    }
    prefs.setLicense(key.trim());
    log(`remove-ads licence activated for ${check.payload?.sub}`);
    return { ok: true, message: 'Ads removed. Thank you for supporting open-emulator.', state: service.state() };
  });

  ipcMain.handle('ads:tag-plan', (_event, slot: unknown): TagPlan | null =>
    isSlotId(slot) ? service.tagPlan(slot) : null,
  );

  ipcMain.on('ads:mount-tag', (_event, slot: unknown, bounds: unknown) => {
    if (!isSlotId(slot) || !isBounds(bounds)) return;
    if (!service.tagPlan(slot)) return;
    getTagHost()?.mount(slot, bounds, consent().personalized);
  });

  ipcMain.on('ads:update-tag-bounds', (_event, slot: unknown, bounds: unknown) => {
    if (!isSlotId(slot) || !isBounds(bounds)) return;
    getTagHost()?.updateBounds(slot, bounds);
  });

  ipcMain.on('ads:unmount-tag', (_event, slot: unknown) => {
    if (isSlotId(slot)) getTagHost()?.unmount(slot);
  });

  ipcMain.on('ads:impression', (_event, token: unknown) => {
    if (typeof token === 'string') service.recordImpression(token);
  });

  ipcMain.on('ads:click', (_event, token: unknown) => {
    if (typeof token !== 'string') return;
    const url = service.resolveClick(token);
    // Opening in the system browser rather than an in-app view is both the safe choice (no
    // remote origin ever enters this app) and the correct one commercially: affiliate cookies
    // have to land in the user's real browser for a conversion to attribute back.
    if (url) void shell.openExternal(url);
  });
}

export { AD_TAG_PARTITION };
