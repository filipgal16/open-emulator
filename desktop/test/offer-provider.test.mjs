import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { OfferProvider } = loadDist('ads/offer-provider.js');
const { parseManifest } = loadDist('ads/manifest.js');

const NOW = new Date(2026, 7, 21, 12, 0, 0).getTime();

const raw = (over = {}) => ({
  id: 'c1',
  slots: ['rail'],
  advertiser: 'Advertiser',
  headline: 'Headline',
  cta: 'Go',
  clickUrl: 'https://p.example.test/c?sub={{subid}}',
  ...over,
});

/** Stands in for ManifestClient with a fixed, already-validated campaign set. */
function manifestOf(...campaigns) {
  const parsed = parseManifest({ campaigns });
  assert.equal(parsed.dropped.length, 0, `fixture rejected: ${parsed.dropped.join(', ')}`);
  return { campaigns: () => parsed.manifest.campaigns };
}

const noCache = { urlIfReady: () => null, ensure: async () => null };

const ctx = (over = {}) => ({ excluded: new Set(), countFor: () => 0, now: NOW, ...over });

function provider(manifest, options = {}) {
  return new OfferProvider(manifest, options.cache ?? noCache, {
    affiliates: {},
    region: () => 'US',
    random: () => 0,
    ...options,
  });
}

test('an eligible campaign fills with its placeholders resolved', async () => {
  const fill = await provider(manifestOf(raw())).fill('rail', ctx());
  assert.equal(fill.campaignId, 'c1');
  assert.equal(fill.clickUrl, 'https://p.example.test/c?sub=oe-c1-rail-20260821');
  assert.equal(fill.advertiser, 'Advertiser');
});

test('no fill when nothing targets the slot', async () => {
  assert.equal(await provider(manifestOf(raw())).fill('wizard-footer', ctx()), null);
});

test('a campaign missing its affiliate id is skipped, not allowed to starve the rest', async () => {
  // Without this, an unconfigured program at the front of the rotation would consume every
  // request and the configured campaigns behind it would never serve.
  const manifest = manifestOf(
    raw({ id: 'needs-aff', weight: 1000, clickUrl: 'https://p.example.test/c?a={{affiliate:missing}}' }),
    raw({ id: 'servable' }),
  );
  const fill = await provider(manifest).fill('rail', ctx());
  assert.equal(fill.campaignId, 'servable');
});

test('nothing fills when every campaign needs a missing affiliate id', async () => {
  const manifest = manifestOf(raw({ clickUrl: 'https://p.example.test/c?a={{affiliate:missing}}' }));
  assert.equal(await provider(manifest).fill('rail', ctx()), null);
});

test('a configured affiliate id is substituted', async () => {
  const manifest = manifestOf(raw({ clickUrl: 'https://p.example.test/c?a={{affiliate:vpn}}' }));
  const fill = await provider(manifest, { affiliates: { vpn: 'AFF-7' } }).fill('rail', ctx());
  assert.equal(fill.clickUrl, 'https://p.example.test/c?a=AFF-7');
});

test('unservable() names exactly what is missing', async () => {
  const manifest = manifestOf(
    raw({ id: 'a', clickUrl: 'https://p.example.test/c?x={{affiliate:one}}&y={{affiliate:two}}' }),
    raw({ id: 'b' }),
  );
  assert.deepEqual(provider(manifest, { affiliates: { one: 'X' } }).unservable(), [{ id: 'a', missing: ['two'] }]);
});

test('geo targeting follows the reported region', async () => {
  const manifest = manifestOf(raw({ regions: ['DE'] }));

  const inRegion = await provider(manifest, { region: () => 'DE' }).fill('rail', ctx());
  assert.equal(inRegion.campaignId, 'c1');

  assert.equal(await provider(manifest, { region: () => 'US' }).fill('rail', ctx()), null);
  assert.equal(await provider(manifest, { region: () => null }).fill('rail', ctx()), null);
});

test("a campaign's own daily cap is honoured", async () => {
  const manifest = manifestOf(raw({ dailyCap: 2 }));
  assert.notEqual(await provider(manifest).fill('rail', ctx({ countFor: () => 1 })), null);
  assert.equal(await provider(manifest).fill('rail', ctx({ countFor: () => 2 })), null);
});

test('frequency exclusions are respected', async () => {
  const manifest = manifestOf(raw());
  assert.equal(await provider(manifest).fill('rail', ctx({ excluded: new Set(['c1']) })), null);
});

test('art already on disk is used; a cache miss renders text and warms the cache', async () => {
  const manifest = manifestOf(raw({ imageUrl: 'https://cdn.example.test/a.png' }));

  const hit = await provider(manifest, {
    cache: { urlIfReady: () => 'oe-ad://creative/abc', ensure: async () => null },
  }).fill('rail', ctx());
  assert.equal(hit.imageUrl, 'oe-ad://creative/abc');

  const warmed = [];
  const miss = await provider(manifest, {
    cache: { urlIfReady: () => null, ensure: async (url) => warmed.push(url) },
  }).fill('rail', ctx());
  assert.equal(miss.imageUrl, null, 'renders text rather than holding the slot blank');
  assert.deepEqual(warmed, ['https://cdn.example.test/a.png']);
});

test('a CPI campaign carries its package and rendered conversion URL', async () => {
  const manifest = manifestOf(
    raw({
      packageName: 'com.example.game',
      conversionUrl: 'https://track.example.test/i?sub={{subid}}',
    }),
  );
  const fill = await provider(manifest).fill('rail', ctx());
  assert.equal(fill.packageName, 'com.example.game');
  // Same subid as the click, or the network cannot tie the install to it.
  assert.equal(fill.conversionUrl, 'https://track.example.test/i?sub=oe-c1-rail-20260821');
});

test('weights bias the rotation without ever hard-excluding', async () => {
  const manifest = manifestOf(raw({ id: 'light', weight: 1 }), raw({ id: 'heavy', weight: 9 }));
  const counts = { light: 0, heavy: 0 };
  // mulberry32 — a real PRNG, seeded so the test is deterministic. A naive LCG written in floats
  // converges into a narrow band and would make this pass or fail for the wrong reason.
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const p = provider(manifest, { random });
  for (let i = 0; i < 400; i += 1) counts[(await p.fill('rail', ctx())).campaignId] += 1;

  assert.ok(counts.heavy > counts.light * 3, `expected heavy bias, got ${JSON.stringify(counts)}`);
  assert.ok(counts.light > 0, 'a low weight must still serve sometimes');
});
