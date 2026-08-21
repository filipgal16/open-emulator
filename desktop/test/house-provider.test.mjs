import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { HouseProvider, DEFAULT_HOUSE_CAMPAIGNS } = loadDist('ads/house-provider.js');
const { isSafeClickUrl } = loadDist('ads/ad-service.js');

const CAMPAIGNS = [
  { id: 'a', slots: ['rail'], weight: 1, headline: 'A', body: '', cta: 'Go', advertiser: 'x', clickUrl: 'https://a.test' },
  { id: 'b', slots: ['rail', 'wizard-footer'], weight: 3, headline: 'B', body: '', cta: 'Go', advertiser: 'x', clickUrl: 'https://b.test' },
];

const ctx = { excluded: new Set(), now: 0 };

test('only campaigns targeting the slot are eligible', async () => {
  const provider = new HouseProvider(CAMPAIGNS, () => 0.99);
  const result = await provider.fill('wizard-footer', ctx);
  assert.equal(result.campaignId, 'b');
});

test('excluded campaigns are skipped', async () => {
  const provider = new HouseProvider(CAMPAIGNS, () => 0.99);
  const result = await provider.fill('rail', { excluded: new Set(['b']), now: 0 });
  assert.equal(result.campaignId, 'a');
});

test('no fill when every eligible campaign is capped out', async () => {
  const provider = new HouseProvider(CAMPAIGNS, () => 0.5);
  assert.equal(await provider.fill('rail', { excluded: new Set(['a', 'b']), now: 0 }), null);
});

test('selection is weighted', async () => {
  // Weights are a=1, b=3 over a total of 4: tickets below 1 land on `a`, the rest on `b`.
  const pickAt = async (r) => (await new HouseProvider(CAMPAIGNS, () => r).fill('rail', ctx)).campaignId;
  assert.equal(await pickAt(0.0), 'a');
  assert.equal(await pickAt(0.2), 'a');
  assert.equal(await pickAt(0.25), 'b');
  assert.equal(await pickAt(0.99), 'b');
});

test('the shipped house campaigns are well-formed', async () => {
  for (const campaign of DEFAULT_HOUSE_CAMPAIGNS) {
    assert.ok(campaign.slots.length > 0, `${campaign.id} targets no slot`);
    assert.ok(campaign.weight > 0, `${campaign.id} has a non-positive weight`);
    assert.ok(campaign.headline && campaign.cta, `${campaign.id} is missing copy`);
    assert.ok(isSafeClickUrl(campaign.clickUrl), `${campaign.id} has an unsafe clickUrl`);
  }
});

test('house inventory exists for exactly the slots that declare a floor', async () => {
  const { SLOT_IDS, SLOTS } = loadDist('../shared/ads-types.js');
  const provider = new HouseProvider();

  for (const slot of SLOT_IDS) {
    const fill = await provider.fill(slot, ctx);
    if (SLOTS[slot].houseFloor) {
      assert.notEqual(fill, null, `"${slot}" declares a house floor but has no inventory`);
    } else {
      // Interruptive slots must stay empty without paid demand. An interstitial that appears on
      // every boot to promote our own repo is annoyance at zero revenue.
      assert.equal(fill, null, `"${slot}" has no house floor but house inventory targets it`);
    }
  }
});
