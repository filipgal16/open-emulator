import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPair, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadDist, withTempDir } from '../helpers.mjs';

const {
  AVB_FLAG_HASHTREE_DISABLED,
  AVB_FLAG_VERIFICATION_DISABLED,
  parseVbmetaHeader,
  parseAvbFooter,
  avbPublicKey,
  resignVbmeta,
  vbmetaDigest,
  loadOrCreateSigningKey,
  upsertVerifiedBootParams,
} = loadDist('rom/avb.js');

const rsa = async (bits, publicExponent = 65537) =>
  (await promisify(generateKeyPair)('rsa', { modulusLength: bits, publicExponent })).privateKey;

// RSA-4096 generation takes a good fraction of a second, so every key is made once, in parallel,
// and shared: "Google's" key signs the synthetic image, "ours" re-signs it.
const [googleKey, ourKey, smallKey, exponent3Key] = await Promise.all([rsa(4096), rsa(4096), rsa(2048), rsa(2048, 3)]);

const ALGORITHMS = {
  1: { digest: 'sha256', hashSize: 32, bits: 2048 },
  2: { digest: 'sha256', hashSize: 32, bits: 4096 },
  5: { digest: 'sha512', hashSize: 64, bits: 4096 },
};

const align64 = (n) => Math.ceil(n / 64) * 64;
const pattern = (length, seed) => Buffer.from(Array.from({ length }, (_, i) => (i * 131 + seed) & 0xff));

/**
 * A signed vbmeta laid out the way avbtool lays out the real top-level one: hash then signature in
 * the auth block; descriptors, public key, then key metadata in the aux block. With the defaults it
 * has the measured shape — 4480 bytes, auth 576, aux 3648, key at 2592.
 */
function buildVbmeta({ algorithm = 2, key = googleKey, flags = 0, descriptors = pattern(2592, 7) } = {}) {
  const { digest, hashSize, bits } = ALGORITHMS[algorithm];
  const publicKey = avbPublicKey(key);
  const signatureSize = bits / 8;
  const authSize = align64(hashSize + signatureSize);
  const auxSize = align64(descriptors.length + publicKey.length);

  const vbmeta = Buffer.alloc(256 + authSize + auxSize);
  vbmeta.write('AVB0', 0, 'latin1');
  vbmeta.writeUInt32BE(1, 4);
  vbmeta.writeBigUInt64BE(BigInt(authSize), 12);
  vbmeta.writeBigUInt64BE(BigInt(auxSize), 20);
  vbmeta.writeUInt32BE(algorithm, 28);
  vbmeta.writeBigUInt64BE(0n, 32);
  vbmeta.writeBigUInt64BE(BigInt(hashSize), 40);
  vbmeta.writeBigUInt64BE(BigInt(hashSize), 48);
  vbmeta.writeBigUInt64BE(BigInt(signatureSize), 56);
  vbmeta.writeBigUInt64BE(BigInt(descriptors.length), 64);
  vbmeta.writeBigUInt64BE(BigInt(publicKey.length), 72);
  vbmeta.writeBigUInt64BE(BigInt(descriptors.length + publicKey.length), 80);
  vbmeta.writeBigUInt64BE(0n, 88);
  vbmeta.writeBigUInt64BE(0n, 96);
  vbmeta.writeBigUInt64BE(BigInt(descriptors.length), 104);
  vbmeta.writeUInt32BE(flags, 120);
  vbmeta.write('avbtool 1.1.0', 128, 'latin1');

  const aux = 256 + authSize;
  descriptors.copy(vbmeta, aux);
  publicKey.copy(vbmeta, aux + descriptors.length);

  const signed = Buffer.concat([vbmeta.subarray(0, 256), vbmeta.subarray(aux)]);
  createHash(digest).update(signed).digest().copy(vbmeta, 256);
  sign(digest, signed, key).copy(vbmeta, 256 + hashSize);
  return vbmeta;
}

const signedPart = (vbmeta, header) =>
  Buffer.concat([vbmeta.subarray(0, 256), vbmeta.subarray(256 + header.authSize, header.totalSize)]);

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────

test('the synthetic vbmeta has the measured shape', () => {
  const header = parseVbmetaHeader(buildVbmeta());

  assert.equal(header.totalSize, 4480);
  assert.equal(header.algorithm, 2);
  assert.equal(header.authSize, 576);
  assert.equal(header.auxSize, 3648);
  assert.deepEqual([header.hashOffset, header.hashSize, header.signatureOffset, header.signatureSize], [0, 32, 32, 512]);
  assert.deepEqual([header.publicKeyOffset, header.publicKeySize], [2592, 1032]);
  assert.equal(header.releaseString, 'avbtool 1.1.0');
});

test('a vbmeta that is not one is refused', () => {
  const vbmeta = buildVbmeta();
  const broken = (change) => {
    const copy = Buffer.from(vbmeta);
    change(copy);
    return copy;
  };

  assert.throws(() => parseVbmetaHeader(broken((b) => b.write('AVBf', 0, 'latin1'))), /vbmeta magic is "AVBf"/);
  assert.throws(() => parseVbmetaHeader(vbmeta.subarray(0, 4000)), /claims 4480 bytes .* only 4000/);
  assert.throws(() => parseVbmetaHeader(broken((b) => b.writeBigUInt64BE(577n, 12))), /not multiples of 64/);
  assert.throws(() => parseVbmetaHeader(broken((b) => b.writeBigUInt64BE(560n, 48))), /signature \[560, \+512\) lies outside the 576-byte authentication block/);
  assert.throws(() => parseVbmetaHeader(broken((b) => b.writeUInt32BE(9, 28))), /algorithm type 9 is unknown/);
  assert.throws(() => parseVbmetaHeader(broken((b) => b.writeBigUInt64BE(64n, 40))), /hash is 64 bytes; SHA256_RSA4096 uses 32/);
});

test('the footer is read from the last 64 bytes, and its absence is null', () => {
  const tail = Buffer.alloc(4096);
  const footer = tail.subarray(4096 - 64);
  footer.write('AVBf', 0, 'latin1');
  footer.writeUInt32BE(1, 4);
  footer.writeBigUInt64BE(1061564416n, 12);
  footer.writeBigUInt64BE(1078390784n, 20);
  footer.writeBigUInt64BE(1664n, 28);

  const expected = { originalImageSize: 1061564416, vbmetaOffset: 1078390784, vbmetaSize: 1664 };
  assert.deepEqual(parseAvbFooter(footer), expected);
  assert.deepEqual(parseAvbFooter(tail, 1078669312), expected, 'a longer tail uses its last 64 bytes');
  assert.equal(parseAvbFooter(Buffer.alloc(64)), null);
  assert.throws(() => parseAvbFooter(footer, 1078390784 + 1000), /past the footer of a/);
  assert.throws(() => parseAvbFooter(Buffer.alloc(63)), /last 64 bytes/);

  const future = Buffer.from(footer);
  future.writeUInt32BE(2, 4);
  assert.throws(() => parseAvbFooter(future), /AVB footer version 2\.0/);
});

// ── The public key encoding ───────────────────────────────────────────────────────────────────

test('the AVB public key carries n and the Montgomery constants libavb expects', () => {
  const encoded = avbPublicKey(createPublicKey(ourKey));
  const bits = encoded.readUInt32BE(0);
  const n0inv = BigInt(encoded.readUInt32BE(4));
  const n = BigInt(`0x${encoded.subarray(8, 8 + 512).toString('hex')}`);
  const rr = BigInt(`0x${encoded.subarray(8 + 512).toString('hex')}`);
  const jwkN = BigInt(`0x${Buffer.from(createPublicKey(ourKey).export({ format: 'jwk' }).n, 'base64url').toString('hex')}`);

  assert.equal(encoded.length, 1032);
  assert.equal(bits, 4096);
  assert.equal(n, jwkN);
  assert.equal((n * n0inv) % (1n << 32n), (1n << 32n) - 1n, 'n * n0inv must be -1 mod 2^32');
  assert.equal(rr, (1n << 8192n) % n);
});

test('a private key encodes as its public half, and a 2048-bit key is 520 bytes', () => {
  assert.deepEqual(avbPublicKey(ourKey), avbPublicKey(createPublicKey(ourKey)));
  assert.equal(avbPublicKey(smallKey).length, 520);
});

test('a key whose exponent is not 65537 is refused', () => {
  // libavb's verifier hard-codes e = 65537; the encoding does not even carry an exponent.
  assert.throws(() => avbPublicKey(exponent3Key), /public exponent is 3/);
});

// ── Re-signing ────────────────────────────────────────────────────────────────────────────────

test('re-signing sets the flags, swaps the key and signs with ours — and changes nothing else', () => {
  const original = buildVbmeta();
  const before = Buffer.from(original);
  const header = parseVbmetaHeader(original);

  const resigned = resignVbmeta(original, ourKey, AVB_FLAG_HASHTREE_DISABLED);

  assert.deepEqual(original, before, 'the input is not modified');
  assert.equal(resigned.length, 4480, 'size unchanged, so the digest covers the same span');
  assert.equal(parseVbmetaHeader(resigned).flags, 1);

  assert.deepEqual(resigned.subarray(0, 120), original.subarray(0, 120), 'header before the flags');
  assert.deepEqual(resigned.subarray(124, 256), original.subarray(124, 256), 'header after the flags');

  const aux = 256 + header.authSize;
  const keyStart = aux + header.publicKeyOffset;
  const keyEnd = keyStart + header.publicKeySize;
  assert.deepEqual(resigned.subarray(aux, keyStart), original.subarray(aux, keyStart), 'descriptors');
  assert.deepEqual(resigned.subarray(keyEnd), original.subarray(keyEnd), 'aux after the key');
  assert.deepEqual(resigned.subarray(keyStart, keyEnd), avbPublicKey(ourKey), 'our key is embedded');

  const signed = signedPart(resigned, header);
  const hash = resigned.subarray(256, 256 + 32);
  const signature = resigned.subarray(256 + 32, 256 + 32 + 512);
  assert.deepEqual(hash, createHash('sha256').update(signed).digest());
  assert.ok(verify('sha256', signed, createPublicKey(ourKey), signature), 'verifies against our key');
  assert.ok(!verify('sha256', signed, createPublicKey(googleKey), signature), 'and not against the old one');
});

test('a whole partition in is exactly one vbmeta out', () => {
  const partition = Buffer.concat([buildVbmeta(), Buffer.alloc(8192, 0)]);

  assert.equal(resignVbmeta(partition, ourKey, AVB_FLAG_HASHTREE_DISABLED).length, 4480);
});

test('SHA-512 algorithms are hashed and signed with SHA-512', () => {
  const original = buildVbmeta({ algorithm: 5 });
  const header = parseVbmetaHeader(original);

  const resigned = resignVbmeta(original, ourKey, AVB_FLAG_VERIFICATION_DISABLED);
  const signed = signedPart(resigned, header);

  assert.equal(parseVbmetaHeader(resigned).flags, 2);
  assert.deepEqual(resigned.subarray(256, 256 + 64), createHash('sha512').update(signed).digest());
  assert.ok(verify('sha512', signed, createPublicKey(ourKey), resigned.subarray(256 + 64, 256 + 64 + 512)));
});

test('a key of the wrong size is refused, because it would move every offset', () => {
  assert.throws(() => resignVbmeta(buildVbmeta(), smallKey, 1), /520 bytes but the vbmeta holds a 1032-byte one; SHA256_RSA4096 needs an RSA-4096 key/);
});

test('an unsigned vbmeta is refused', () => {
  const vbmeta = buildVbmeta();
  vbmeta.writeUInt32BE(0, 28);

  assert.throws(() => resignVbmeta(vbmeta, ourKey, 1), /unsigned \(algorithm NONE\)/);
});

test('a public key overlapping the descriptors is refused', () => {
  const vbmeta = buildVbmeta();
  vbmeta.writeBigUInt64BE(2600n, 104); // descriptors now run into the key at 2592

  assert.throws(() => resignVbmeta(vbmeta, ourKey, 1), /public key overlaps its descriptors/);
});

test('flags must be an unsigned 32-bit value', () => {
  assert.throws(() => resignVbmeta(buildVbmeta(), ourKey, -1), /not an unsigned 32-bit value/);
});

// ── Digest ────────────────────────────────────────────────────────────────────────────────────

test('the digest is SHA-256 over the images in order', () => {
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

  assert.equal(vbmetaDigest([Buffer.from('a'), Buffer.from('bc')]), abc);
  assert.equal(vbmetaDigest([Buffer.from('abc')]), abc);
  assert.notEqual(vbmetaDigest([Buffer.from('bc'), Buffer.from('a')]), abc, 'top-level first, then chained');
});

// ── The signing key ───────────────────────────────────────────────────────────────────────────

test('the signing key is created once, then reloaded unchanged', async () => {
  await withTempDir(async (root) => {
    const dir = path.join(root, 'nested', 'rom');
    const file = path.join(dir, 'openemu-avb.pem');

    const created = loadOrCreateSigningKey(dir, 2048);
    assert.ok(existsSync(file), 'created, parent directories and all');
    assert.match(readFileSync(file, 'utf8'), /^-----BEGIN PRIVATE KEY-----/, 'PKCS#8 PEM');

    const reloaded = loadOrCreateSigningKey(dir, 2048);
    assert.deepEqual(avbPublicKey(reloaded), avbPublicKey(created), 'the same key, so rebuilds are byte-identical');

    assert.throws(() => loadOrCreateSigningKey(dir, 4096), /holds a 2048-bit key; 4096 bits are needed/);
  });
});

test('an unreadable key file is refused with a way out', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(path.join(dir, 'openemu-avb.pem'), 'not a key');

    assert.throws(() => loadOrCreateSigningKey(dir, 2048), /openemu-avb\.pem does not hold a readable private key.*delete it/);
  });
});

// ── VerifiedBootParams.textproto ──────────────────────────────────────────────────────────────

const OLD = 'aa516f360594014de86105695b13f1df5e00b81539011aafdd58e68e859134a1';
const NEW = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const STOCK = [
  `# androidboot.vbmeta.size=6144 androidboot.vbmeta.hash_alg=sha256 androidboot.vbmeta.digest=${OLD}`,
  'major_version: 2',
  'param: "androidboot.vbmeta.size=6144"',
  'param: "androidboot.vbmeta.hash_alg=sha256"',
  `param: "androidboot.vbmeta.digest=${OLD}"`,
  '',
].join('\n');

test('an existing param is replaced in place, and the summary follows', () => {
  const out = upsertVerifiedBootParams(STOCK, { 'androidboot.vbmeta.digest': NEW });

  assert.equal(out, STOCK.replaceAll(OLD, NEW));
});

test('a new param is appended after the last one', () => {
  const out = upsertVerifiedBootParams(`${STOCK}# trailing note\n`, { 'androidboot.openemu': '1' });

  assert.deepEqual(out.split('\n'), [
    `# androidboot.vbmeta.size=6144 androidboot.vbmeta.hash_alg=sha256 androidboot.vbmeta.digest=${OLD} androidboot.openemu=1`,
    'major_version: 2',
    'param: "androidboot.vbmeta.size=6144"',
    'param: "androidboot.vbmeta.hash_alg=sha256"',
    `param: "androidboot.vbmeta.digest=${OLD}"`,
    'param: "androidboot.openemu=1"',
    '# trailing note',
    '',
  ]);
});

test('a removed param is dropped, from the lines and the summary', () => {
  const out = upsertVerifiedBootParams(STOCK, {}, ['androidboot.vbmeta.hash_alg']);

  assert.ok(!out.includes('hash_alg'));
  assert.match(out, /^# androidboot\.vbmeta\.size=6144 androidboot\.vbmeta\.digest=/);
  assert.match(out, /major_version: 2\n/);
});

test('duplicate keys collapse to one, at the first position', () => {
  // A stale digest left above a fresh one would win: ro.boot.* takes the first value it is given.
  const doubled = `${STOCK}param: "androidboot.vbmeta.digest=${NEW}"\nparam: "androidboot.vbmeta.size=4096"\n`;

  const out = upsertVerifiedBootParams(doubled, { 'androidboot.vbmeta.digest': NEW });

  assert.equal(out.match(/androidboot\.vbmeta\.digest=/g).length, 2, 'once in the summary, once as a param');
  assert.equal(out.match(/param: "androidboot\.vbmeta\.size=/g).length, 1);
  assert.equal(out, STOCK.replaceAll(OLD, NEW), 'the first size (6144) is the one kept');
});

test('a file without a summary line does not gain one', () => {
  const bare = 'major_version: 2\n';

  assert.equal(
    upsertVerifiedBootParams(bare, { 'androidboot.vbmeta.size': '6144' }),
    'major_version: 2\nparam: "androidboot.vbmeta.size=6144"\n',
  );
});

test('CRLF line endings are kept', () => {
  const out = upsertVerifiedBootParams(STOCK.replaceAll('\n', '\r\n'), { 'androidboot.vbmeta.digest': NEW });

  assert.equal(out, STOCK.replaceAll(OLD, NEW).replaceAll('\n', '\r\n'));
});

test('keys and values that would break the textproto or the command line are refused', () => {
  for (const value of ['a b', 'a"b', 'a\\b', 'a\nb', 'a\tb']) {
    assert.throws(() => upsertVerifiedBootParams(STOCK, { 'androidboot.x': value }), /value for "androidboot\.x"/, JSON.stringify(value));
  }
  for (const key of ['', 'a=b', 'a b', 'a"b', 'a\\b', 'a\nb']) {
    assert.throws(() => upsertVerifiedBootParams(STOCK, { [key]: 'v' }), /VerifiedBootParams key/, JSON.stringify(key));
    assert.throws(() => upsertVerifiedBootParams(STOCK, {}, [key]), /VerifiedBootParams key/, JSON.stringify(key));
  }
  assert.throws(() => upsertVerifiedBootParams(STOCK, { k: 'v' }, ['k']), /both set and removed/);
});

test('a param line with escapes is refused rather than half-read', () => {
  const escaped = `${STOCK}param: "androidboot.vbmeta.digest=\\"x\\""\n`;

  assert.throws(() => upsertVerifiedBootParams(escaped, { 'androidboot.vbmeta.digest': NEW }), /line 6 is a param this cannot read safely/);
});
