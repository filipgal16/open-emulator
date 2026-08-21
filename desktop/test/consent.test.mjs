import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { resolveConsent, tagsAllowed, isConsentRegion } = loadDist('ads/consent.js');

test('with no third-party tag configured, consent is not required anywhere', () => {
  for (const region of ['DE', 'US', null]) {
    const state = resolveConsent({ usesThirdPartyTags: false, region, answer: null });
    assert.equal(state.status, 'not-required');
    assert.equal(state.personalized, false);
  }
});

test('a tag in an EEA/UK/CH region blocks until the user answers', () => {
  for (const region of ['DE', 'FR', 'PL', 'GB', 'CH', 'NO']) {
    const state = resolveConsent({ usesThirdPartyTags: true, region, answer: null });
    assert.equal(state.status, 'pending', `expected a prompt for ${region}`);
    assert.equal(tagsAllowed(state), false);
  }
});

test('an unknown region is treated as in scope', () => {
  // Guessing "probably not Europe" to skip a consent prompt is exactly the wrong way to be wrong.
  const state = resolveConsent({ usesThirdPartyTags: true, region: null, answer: null });
  assert.equal(state.status, 'pending');
});

test('outside those regions a tag runs without a prompt, but not personalised', () => {
  const state = resolveConsent({ usesThirdPartyTags: true, region: 'US', answer: null });
  assert.equal(state.status, 'granted');
  assert.equal(state.personalized, false, 'no prompt means no basis for personalisation');
  assert.equal(tagsAllowed(state), true);
});

test('an explicit answer is honoured in both directions and everywhere', () => {
  const yes = resolveConsent({ usesThirdPartyTags: true, region: 'DE', answer: true });
  assert.equal(yes.status, 'granted');
  assert.equal(yes.personalized, true);
  assert.equal(tagsAllowed(yes), true);

  const no = resolveConsent({ usesThirdPartyTags: true, region: 'DE', answer: false });
  assert.equal(no.status, 'denied');
  assert.equal(no.personalized, false);
  assert.equal(tagsAllowed(no), false);
});

test('declining blocks only the tag, never the whole stack', () => {
  // The affiliate and house rungs never needed consent, so refusing must not be a revenue cliff
  // — the service keeps running, it just loses the third-party rung.
  const state = resolveConsent({ usesThirdPartyTags: true, region: 'DE', answer: false });
  assert.equal(tagsAllowed(state), false);
  assert.equal(state.status, 'denied', 'denied is a tag state, not an "ads off" state');
});

test('isConsentRegion agrees with the resolver', () => {
  assert.equal(isConsentRegion('DE'), true);
  assert.equal(isConsentRegion('GB'), true);
  assert.equal(isConsentRegion('US'), false);
  assert.equal(isConsentRegion(null), true);
});
