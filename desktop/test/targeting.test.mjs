import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { isEligible, regionFromLocale, renderUrlTemplate, requiredAffiliates } = loadDist('ads/targeting.js');

const NOON = new Date(2026, 7, 21, 12, 0, 0).getTime();

const campaign = (over = {}) => ({
  id: 'c1',
  slots: ['rail'],
  weight: 1,
  advertiser: 'A',
  headline: 'H',
  body: '',
  cta: 'Go',
  imageUrl: null,
  clickUrl: 'https://example.com',
  conversionUrl: null,
  packageName: null,
  regions: null,
  excludeRegions: [],
  startsAt: null,
  endsAt: null,
  dailyCap: null,
  ...over,
});

const ctx = (over = {}) => ({ slot: 'rail', region: 'US', now: NOON, excluded: new Set(), ...over });

test('region comes out of the OS locale', () => {
  assert.equal(regionFromLocale('en-US'), 'US');
  assert.equal(regionFromLocale('pl_PL'), 'PL');
  assert.equal(regionFromLocale('zh-Hans-CN'), 'CN');
  assert.equal(regionFromLocale('en'), null);
  assert.equal(regionFromLocale(null), null);
  assert.equal(regionFromLocale(''), null);
});

test('slot and exclusion gate eligibility', () => {
  assert.equal(isEligible(campaign(), ctx()), true);
  assert.equal(isEligible(campaign(), ctx({ slot: 'wizard-footer' })), false);
  assert.equal(isEligible(campaign(), ctx({ excluded: new Set(['c1']) })), false);
});

test('flight dates are respected at both ends', () => {
  const flighted = campaign({ startsAt: NOON - 1000, endsAt: NOON + 1000 });
  assert.equal(isEligible(flighted, ctx()), true);
  assert.equal(isEligible(flighted, ctx({ now: NOON - 5000 })), false);
  assert.equal(isEligible(flighted, ctx({ now: NOON + 5000 })), false);
});

test('geo allowlists and blocklists both apply', () => {
  assert.equal(isEligible(campaign({ regions: ['US', 'GB'] }), ctx({ region: 'US' })), true);
  assert.equal(isEligible(campaign({ regions: ['US', 'GB'] }), ctx({ region: 'DE' })), false);
  assert.equal(isEligible(campaign({ excludeRegions: ['DE'] }), ctx({ region: 'DE' })), false);
  assert.equal(isEligible(campaign({ excludeRegions: ['DE'] }), ctx({ region: 'US' })), true);
});

test('a geo-targeted campaign is skipped when the region is unknown', () => {
  // Serving outside a partner's approved territory is how a payout gets reversed, so an unknown
  // region must not be treated as a match.
  assert.equal(isEligible(campaign({ regions: ['US'] }), ctx({ region: null })), false);
  assert.equal(isEligible(campaign({ excludeRegions: ['DE'] }), ctx({ region: null })), false);
  // An untargeted campaign is unaffected.
  assert.equal(isEligible(campaign(), ctx({ region: null })), true);
});

test('placeholders resolve', () => {
  const url = renderUrlTemplate(
    'https://p.example.com/c?aff={{affiliate:vpn}}&sub={{subid}}&c={{campaign}}&s={{slot}}',
    { affiliates: { vpn: 'AFF 9' }, campaignId: 'c1', slot: 'rail', now: NOON },
  );
  assert.equal(url, 'https://p.example.com/c?aff=AFF%209&sub=oe-c1-rail-20260821&c=c1&s=rail');
});

test('the subid carries no user or device identifier', () => {
  const a = renderUrlTemplate('https://x.test/?s={{subid}}', {
    affiliates: {}, campaignId: 'c1', slot: 'rail', now: NOON,
  });
  const b = renderUrlTemplate('https://x.test/?s={{subid}}', {
    affiliates: {}, campaignId: 'c1', slot: 'rail', now: NOON + 60_000,
  });
  // Two different moments on the same day produce byte-identical subids: there is nothing in
  // there that could distinguish one install, session, or person from another.
  assert.equal(a, b);
  assert.equal(a, 'https://x.test/?s=oe-c1-rail-20260821');
});

test('a missing affiliate id fails closed rather than sending untracked traffic', () => {
  const url = renderUrlTemplate('https://p.example.com/c?aff={{affiliate:vpn}}', {
    affiliates: {}, campaignId: 'c1', slot: 'rail', now: NOON,
  });
  assert.equal(url, null);
});

test('an unknown placeholder fails closed', () => {
  assert.equal(
    renderUrlTemplate('https://p.example.com/?x={{whoknows}}', {
      affiliates: {}, campaignId: 'c1', slot: 'rail', now: NOON,
    }),
    null,
  );
});

test('a template that renders to a non-https URL is refused', () => {
  assert.equal(
    renderUrlTemplate('http://p.example.com/?c={{campaign}}', {
      affiliates: {}, campaignId: 'c1', slot: 'rail', now: NOON,
    }),
    null,
  );
});

test('substituted values are URL-encoded', () => {
  const url = renderUrlTemplate('https://p.example.com/?a={{affiliate:x}}', {
    affiliates: { x: 'a&b=c#d' }, campaignId: 'c1', slot: 'rail', now: NOON,
  });
  assert.equal(url, 'https://p.example.com/?a=a%26b%3Dc%23d');
  assert.equal(new URL(url).searchParams.get('a'), 'a&b=c#d');
});

test('requiredAffiliates names what a build is missing', () => {
  assert.deepEqual(requiredAffiliates('https://x.test/?a={{affiliate:one}}&b={{affiliate:two}}'), ['one', 'two']);
  assert.deepEqual(requiredAffiliates('https://x.test/?s={{subid}}'), []);
});
