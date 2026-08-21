import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadDist, withTempDir } from './helpers.mjs';

const { FrequencyStore } = loadDist('ads/frequency.js');

const DAY = 24 * 60 * 60_000;
const NOON = new Date(2026, 7, 21, 12, 0, 0).getTime();

test('a campaign is excluded once it reaches its daily cap', async () => {
  await withTempDir(async (dir) => {
    const store = new FrequencyStore(path.join(dir, 'f.json'), { perCampaignPerDay: 2, repeatCooldownMs: 0 }, NOON);

    store.record('c1', NOON);
    assert.equal(store.excluded(NOON).has('c1'), false);

    store.record('c1', NOON + 1000);
    assert.equal(store.excluded(NOON + 2000).has('c1'), true);
  });
});

test('a campaign is held back during its repeat cooldown, then released', async () => {
  await withTempDir(async (dir) => {
    const store = new FrequencyStore(path.join(dir, 'f.json'), { perCampaignPerDay: 99, repeatCooldownMs: 60_000 }, NOON);

    store.record('c1', NOON);
    assert.equal(store.excluded(NOON + 30_000).has('c1'), true);
    assert.equal(store.excluded(NOON + 61_000).has('c1'), false);
  });
});

test('counts survive a restart within the same day', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'f.json');
    const caps = { perCampaignPerDay: 5, repeatCooldownMs: 0 };

    new FrequencyStore(file, caps, NOON).record('c1', NOON);
    assert.equal(new FrequencyStore(file, caps, NOON).countFor('c1', NOON), 1);
  });
});

test('a new calendar day starts from zero', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'f.json');
    const caps = { perCampaignPerDay: 1, repeatCooldownMs: 0 };

    const first = new FrequencyStore(file, caps, NOON);
    first.record('c1', NOON);
    assert.equal(first.excluded(NOON).has('c1'), true);

    // Same instance, next day: the cap must lift without a restart.
    assert.equal(first.excluded(NOON + DAY).has('c1'), false);
    // And a fresh instance must not resurrect yesterday's counts.
    assert.equal(new FrequencyStore(file, caps, NOON + DAY).countFor('c1', NOON + DAY), 0);
  });
});

test('a corrupt state file is discarded rather than thrown', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'f.json');
    writeFileSync(file, '{ this is not json', 'utf8');

    const store = new FrequencyStore(file, { perCampaignPerDay: 3, repeatCooldownMs: 0 }, NOON);
    assert.equal(store.countFor('c1', NOON), 0);
    store.record('c1', NOON);
    assert.equal(store.countFor('c1', NOON), 1);
  });
});

test('caps are per campaign, not global', async () => {
  await withTempDir(async (dir) => {
    const store = new FrequencyStore(path.join(dir, 'f.json'), { perCampaignPerDay: 1, repeatCooldownMs: 0 }, NOON);

    store.record('c1', NOON);
    const excluded = store.excluded(NOON);
    assert.equal(excluded.has('c1'), true);
    assert.equal(excluded.has('c2'), false);
  });
});
