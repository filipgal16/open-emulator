#!/usr/bin/env node
// Issues remove-ads licence keys.
//
//   node scripts/ads-license.mjs keygen
//       Creates an Ed25519 keypair. Writes the private key to ads-license-private.pem (gitignored,
//       keep it safe — anyone with it can mint licences) and prints the public key to paste into
//       ads.config.json as entitlement.publicKey.
//
//   node scripts/ads-license.mjs issue --sub "order_1234" [--exp 2027-01-01]
//       Prints a licence key. Send it to the customer.
//
// There is no licence server: the app verifies the signature offline. Nothing to host, nothing to
// pay for, and no activation call that can fail on a customer who already paid.

import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const privatePath = path.join(root, 'ads-license-private.pem');

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

if (command === 'keygen') {
  if (existsSync(privatePath)) {
    console.error(`${path.basename(privatePath)} already exists. Delete it only if you intend to`);
    console.error('invalidate every licence you have already issued.');
    process.exit(1);
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  console.log(`private key → ${path.basename(privatePath)}  (gitignored; back it up somewhere safe)`);
  console.log('\npaste into ads.config.json:\n');
  console.log(`  "entitlement": { "publicKey": "${publicB64}" }`);
  process.exit(0);
}

if (command === 'issue') {
  const sub = flag('sub');
  if (!sub) {
    console.error('Need --sub, e.g. --sub "order_1234" or --sub "buyer@example.com"');
    process.exit(1);
  }
  if (!existsSync(privatePath)) {
    console.error(`No ${path.basename(privatePath)}. Run: node scripts/ads-license.mjs keygen`);
    process.exit(1);
  }

  const payload = { sub, iat: Date.now(), plan: 'remove-ads' };
  const expRaw = flag('exp');
  if (expRaw) {
    const exp = Date.parse(expRaw);
    if (!Number.isFinite(exp)) {
      console.error(`--exp "${expRaw}" is not a date I can parse. Try 2027-01-01.`);
      process.exit(1);
    }
    payload.exp = exp;
  }

  const encoded = b64url(JSON.stringify(payload));
  const privateKey = createPrivateKey(readFileSync(privatePath, 'utf8'));
  // Signed over the encoded payload exactly as it appears in the key, so re-serialisation on the
  // client can't change what was verified.
  const signature = sign(null, Buffer.from(encoded, 'utf8'), privateKey);

  console.log(`${encoded}.${b64url(signature)}`);
  process.exit(0);
}

console.error('Usage: ads-license.mjs keygen | issue --sub <id> [--exp <date>]');
process.exit(1);
