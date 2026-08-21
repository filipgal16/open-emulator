import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ENABLED_CONFIG, fill, loadDist, stubProvider, withTempDir } from './helpers.mjs';

const { AdService, isSafeClickUrl } = loadDist('ads/ad-service.js');
const { FrequencyStore } = loadDist('ads/frequency.js');
const { AdPrefsStore } = loadDist('ads/prefs.js');
const { DISABLED_ADS_CONFIG } = loadDist('ads/config.js');

const NO_CAPS = { perCampaignPerDay: 1000, repeatCooldownMs: 0 };

/** Builds a service over throwaway on-disk stores and hands it to `fn`. */
function withService(fn, { config = ENABLED_CONFIG, providers = [], caps = NO_CAPS, options = {} } = {}) {
  return withTempDir((dir) => {
    const frequency = new FrequencyStore(path.join(dir, 'freq.json'), caps);
    const prefs = new AdPrefsStore(path.join(dir, 'prefs.json'));
    const errors = [];
    const service = new AdService(config, providers, frequency, prefs, {
      onError: (m) => errors.push(m),
      ...options,
    });
    return fn({ service, frequency, prefs, errors });
  });
}

test('an unconfigured build serves nothing and reports itself inactive', async () => {
  await withService(
    async ({ service }) => {
      assert.deepEqual(service.state(), {
        configured: false,
        optedOut: false,
        adsRemoved: false,
        consent: 'not-required',
        active: false,
      });
      assert.equal(await service.request('rail'), null);
    },
    { config: DISABLED_ADS_CONFIG, providers: [stubProvider('house', fill())] },
  );
});

test('the waterfall takes the first fill and leaves lower rungs untouched', async () => {
  const network = stubProvider('network', null);
  const offer = stubProvider('offer', fill({ campaignId: 'offer-1' }));
  const house = stubProvider('house', fill({ campaignId: 'house-1' }));

  await withService(
    async ({ service }) => {
      const creative = await service.request('rail');
      assert.equal(creative.campaignId, 'offer-1');
      assert.equal(creative.source, 'offer');
      assert.equal(network.calls.length, 1);
      assert.equal(offer.calls.length, 1);
      assert.equal(house.calls.length, 0, 'house should not be asked once offer filled');
    },
    { providers: [network, offer, house] },
  );
});

test('a provider that throws is skipped rather than breaking the chain', async () => {
  const broken = stubProvider('network', new Error('partner timeout'));
  const house = stubProvider('house', fill({ campaignId: 'house-1' }));

  await withService(
    async ({ service, errors }) => {
      const creative = await service.request('rail');
      assert.equal(creative.campaignId, 'house-1');
      assert.match(errors.join('\n'), /network.*partner timeout/);
    },
    { providers: [broken, house] },
  );
});

test('a non-https destination is refused and the waterfall continues', async () => {
  const hostile = stubProvider('offer', fill({ campaignId: 'bad', clickUrl: 'file:///C:/Windows/System32/cmd.exe' }));
  const house = stubProvider('house', fill({ campaignId: 'house-1' }));

  await withService(
    async ({ service, errors }) => {
      const creative = await service.request('rail');
      assert.equal(creative.campaignId, 'house-1');
      assert.match(errors.join('\n'), /non-https/);
    },
    { providers: [hostile, house] },
  );
});

test('the creative handed to the renderer carries no destination URL', async () => {
  await withService(
    async ({ service }) => {
      const creative = await service.request('rail');
      assert.equal(Object.prototype.hasOwnProperty.call(creative, 'clickUrl'), false);
      assert.equal(JSON.stringify(creative).includes('example.com'), false);
    },
    { providers: [stubProvider('house', fill())] },
  );
});

test('requesting a fill does not count an impression', async () => {
  await withService(
    async ({ service, frequency }) => {
      await service.request('rail');
      assert.equal(frequency.countFor('c1', Date.now()), 0);
    },
    { providers: [stubProvider('house', fill())] },
  );
});

test('an impression counts once per token no matter how often it is reported', async () => {
  await withService(
    async ({ service, frequency }) => {
      const creative = await service.request('rail');
      assert.equal(service.recordImpression(creative.token), true);
      assert.equal(service.recordImpression(creative.token), false);
      assert.equal(service.recordImpression('not-a-token'), false);
      assert.equal(frequency.countFor('c1', Date.now()), 1);
    },
    { providers: [stubProvider('house', fill())] },
  );
});

test('clicks resolve only for live tokens', async () => {
  await withService(
    async ({ service }) => {
      const creative = await service.request('rail');
      assert.equal(service.resolveClick(creative.token), 'https://example.com/offer');
      assert.equal(service.resolveClick('made-up'), null);
    },
    { providers: [stubProvider('house', fill())] },
  );
});

test('tokens beyond the retention limit stop resolving', async () => {
  await withService(
    async ({ service }) => {
      const first = await service.request('rail');
      await service.request('rail');
      await service.request('rail');
      assert.equal(service.resolveClick(first.token), null);
    },
    { providers: [stubProvider('house', fill())], options: { maxTokens: 2 } },
  );
});

test('opting out deactivates the service and blocks fills, and persists', async () => {
  await withTempDir(async (dir) => {
    const freqFile = path.join(dir, 'freq.json');
    const prefsFile = path.join(dir, 'prefs.json');
    const build = () =>
      new AdService(
        ENABLED_CONFIG,
        [stubProvider('house', fill())],
        new FrequencyStore(freqFile, NO_CAPS),
        new AdPrefsStore(prefsFile),
      );

    const service = build();
    assert.equal(service.state().active, true);

    const after = service.setOptedOut(true);
    assert.equal(after.active, false);
    assert.equal(after.optedOut, true);
    assert.equal(await service.request('rail'), null);

    // A fresh service over the same prefs file must still respect the choice.
    assert.equal(build().state().active, false);
  });
});

test('providers are told which campaigns are capped out', async () => {
  const house = stubProvider('house', fill({ campaignId: 'c1' }));
  await withService(
    async ({ service }) => {
      const creative = await service.request('rail');
      service.recordImpression(creative.token);
      await service.request('rail');
      assert.deepEqual(house.calls[1].excluded, ['c1']);
    },
    { providers: [house], caps: { perCampaignPerDay: 1, repeatCooldownMs: 0 } },
  );
});

test('isSafeClickUrl admits https and nothing else', () => {
  assert.equal(isSafeClickUrl('https://example.com'), true);
  assert.equal(isSafeClickUrl('http://example.com'), false);
  assert.equal(isSafeClickUrl('file:///etc/passwd'), false);
  assert.equal(isSafeClickUrl('javascript:alert(1)'), false);
  assert.equal(isSafeClickUrl('steam://run/570'), false);
  assert.equal(isSafeClickUrl('not a url'), false);
});
