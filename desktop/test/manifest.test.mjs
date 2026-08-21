import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { parseManifest } = loadDist('ads/manifest.js');

const good = {
  id: 'c1',
  slots: ['rail'],
  advertiser: 'Advertiser',
  headline: 'Headline',
  cta: 'Go',
  clickUrl: 'https://example.com/offer?sub={{subid}}',
};

const wrap = (...campaigns) => parseManifest({ version: 1, ttlSeconds: 3600, campaigns });

test('a valid campaign survives with defaults filled in', () => {
  const { manifest, dropped } = wrap(good);
  assert.equal(dropped.length, 0);
  const c = manifest.campaigns[0];
  assert.equal(c.id, 'c1');
  assert.equal(c.weight, 1);
  assert.equal(c.body, '');
  assert.equal(c.imageUrl, null);
  assert.equal(c.regions, null);
  assert.deepEqual(c.excludeRegions, []);
});

test('one bad campaign is dropped without taking the others with it', () => {
  const { manifest, dropped } = wrap(good, { id: 'broken', slots: ['rail'] }, { ...good, id: 'c2' });
  assert.deepEqual(manifest.campaigns.map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(dropped, ['broken']);
});

test('campaigns without a usable destination are dropped', () => {
  for (const clickUrl of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'nonsense', '']) {
    const { manifest } = wrap({ ...good, clickUrl });
    assert.equal(manifest.campaigns.length, 0, `accepted clickUrl: ${clickUrl}`);
  }
});

test('a placeholder cannot smuggle a non-https scheme past validation', () => {
  // The template only parses once placeholders are substituted, so a scheme hidden behind one
  // would sail through a naive check and reappear at click time.
  const { manifest } = wrap({ ...good, clickUrl: '{{subid}}://evil/path' });
  assert.equal(manifest.campaigns.length, 0);
});

test('unknown slot ids are filtered, and a campaign left with none is dropped', () => {
  const kept = wrap({ ...good, slots: ['rail', 'not-a-slot'] });
  assert.deepEqual(kept.manifest.campaigns[0].slots, ['rail']);

  const gone = wrap({ ...good, slots: ['not-a-slot'] });
  assert.equal(gone.manifest.campaigns.length, 0);
});

test('duplicate ids are dropped so capping stays unambiguous', () => {
  const { manifest, dropped } = wrap(good, { ...good, headline: 'Other' });
  assert.equal(manifest.campaigns.length, 1);
  assert.equal(manifest.campaigns[0].headline, 'Headline');
  assert.deepEqual(dropped, ['c1 (duplicate)']);
});

test('regions are normalised and junk entries discarded', () => {
  const { manifest } = wrap({ ...good, regions: ['us', 'GB', 'nope', 42], excludeRegions: ['de'] });
  assert.deepEqual(manifest.campaigns[0].regions, ['US', 'GB']);
  assert.deepEqual(manifest.campaigns[0].excludeRegions, ['DE']);
});

test('an empty region allowlist means untargeted, not unservable', () => {
  const { manifest } = wrap({ ...good, regions: [] });
  assert.equal(manifest.campaigns[0].regions, null);
});

test('image URLs must be https, and a bad one degrades to text rather than dropping the ad', () => {
  const { manifest } = wrap({ ...good, imageUrl: 'http://cdn.example.com/a.png' });
  assert.equal(manifest.campaigns.length, 1);
  assert.equal(manifest.campaigns[0].imageUrl, null);
});

test('ttl is clamped so a publishing mistake cannot pin every client', () => {
  assert.equal(parseManifest({ ttlSeconds: 1, campaigns: [] }).manifest.ttlSeconds, 60);
  assert.equal(parseManifest({ ttlSeconds: 99_999_999, campaigns: [] }).manifest.ttlSeconds, 86_400);
});

test('a non-object manifest yields nothing instead of throwing', () => {
  for (const raw of [null, 'nope', 42, []]) {
    assert.equal(parseManifest(raw).manifest.campaigns.length, 0);
  }
});

test('dates parse to epoch ms and bad ones become null', () => {
  const { manifest } = wrap({ ...good, startsAt: '2026-01-01T00:00:00Z', endsAt: 'whenever' });
  assert.equal(manifest.campaigns[0].startsAt, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(manifest.campaigns[0].endsAt, null);
});
