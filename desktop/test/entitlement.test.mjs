import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { loadDist } from './helpers.mjs';

const { verifyLicense } = loadDist('ads/entitlement.js');

const NOW = new Date(2026, 7, 21, 12, 0, 0).getTime();

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Mirrors scripts/ads-license.mjs, so the test proves the issuer and the checker agree. */
function issue(payload, privateKey) {
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${b64url(sign(null, Buffer.from(encoded, 'utf8'), privateKey))}`;
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

test('a licence issued by the matching private key verifies', () => {
  const { privateKey, publicB64 } = keypair();
  const key = issue({ sub: 'order_1', iat: NOW, plan: 'remove-ads' }, privateKey);

  const result = verifyLicense(key, publicB64, NOW);
  assert.equal(result.valid, true);
  assert.equal(result.payload.sub, 'order_1');
});

test('a licence from a different key is refused', () => {
  const mine = keypair();
  const theirs = keypair();
  const forged = issue({ sub: 'order_1', iat: NOW, plan: 'remove-ads' }, theirs.privateKey);

  assert.deepEqual(verifyLicense(forged, mine.publicB64, NOW).valid, false);
  assert.equal(verifyLicense(forged, mine.publicB64, NOW).reason, 'bad-signature');
});

test('editing the payload invalidates the signature', () => {
  const { privateKey, publicB64 } = keypair();
  const key = issue({ sub: 'order_1', iat: NOW, plan: 'remove-ads' }, privateKey);
  const [, signature] = key.split('.');

  // Swap in a payload the holder would prefer, keeping the original signature.
  const tampered = `${b64url(JSON.stringify({ sub: 'anyone', iat: NOW, plan: 'remove-ads' }))}.${signature}`;
  assert.equal(verifyLicense(tampered, publicB64, NOW).reason, 'bad-signature');
});

test('expiry is enforced', () => {
  const { privateKey, publicB64 } = keypair();
  const key = issue({ sub: 'order_1', iat: NOW, exp: NOW + 1000, plan: 'remove-ads' }, privateKey);

  assert.equal(verifyLicense(key, publicB64, NOW).valid, true);
  assert.equal(verifyLicense(key, publicB64, NOW + 5000).valid, false);
  assert.equal(verifyLicense(key, publicB64, NOW + 5000).reason, 'expired');
});

test('a licence with no expiry is perpetual', () => {
  const { privateKey, publicB64 } = keypair();
  const key = issue({ sub: 'order_1', iat: NOW, plan: 'remove-ads' }, privateKey);
  assert.equal(verifyLicense(key, publicB64, NOW + 20 * 365 * 24 * 60 * 60_000).valid, true);
});

test('a validly signed licence for another plan does not remove ads', () => {
  const { privateKey, publicB64 } = keypair();
  const key = issue({ sub: 'order_1', iat: NOW, plan: 'something-else' }, privateKey);
  assert.equal(verifyLicense(key, publicB64, NOW).reason, 'wrong-plan');
});

test('malformed input is rejected without throwing', () => {
  const { publicB64 } = keypair();
  for (const key of ['', 'nope', 'a.b.c', 'not-base64!.also-not', '.', 'eyJ9.']) {
    const result = verifyLicense(key, publicB64, NOW);
    assert.equal(result.valid, false, `accepted: ${key}`);
  }
});

test('a build with no public key cannot be tricked into accepting anything', () => {
  const { privateKey } = keypair();
  const key = issue({ sub: 'order_1', iat: NOW, plan: 'remove-ads' }, privateKey);
  const result = verifyLicense(key, null, NOW);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'no-public-key');
});
