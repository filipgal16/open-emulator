import { constants, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * Android Verified Boot (AVB 2.0) metadata: reading it, re-signing the top-level vbmeta with our
 * own key, and the digest the emulator passes on the kernel command line.
 *
 * Why re-sign rather than patch: `/system` is protected by dm-verity with FEC, which repairs every
 * edit back to Google's bytes at read time. Setting `HASHTREE_DISABLED` in the top-level vbmeta
 * turns that off, but the flag is inside the signed header, so patching it alone makes libfs_avb
 * reject the image (`PUBLIC_KEY_REJECTED`, `/system` fails to mount). Re-signing with any key
 * works because libfs_avb checks the signature against the key embedded in the same vbmeta and
 * leaves *which* key to the bootloader — whose check on the emulator trusts any key. What binds the
 * image is `androidboot.vbmeta.digest`, which is why the digest is recomputed and written into
 * `VerifiedBootParams.textproto` in step with the signature.
 *
 * All vbmeta integers are big-endian. Offsets inside the authentication and auxiliary blocks are
 * relative to the start of each block, not of the vbmeta.
 */

export const AVB_FLAG_HASHTREE_DISABLED = 1;
export const AVB_FLAG_VERIFICATION_DISABLED = 2;

export const VBMETA_HEADER_SIZE = 256;
export const AVB_FOOTER_SIZE = 64;
export const SIGNING_KEY_FILE = 'openemu-avb.pem';

const VBMETA_MAGIC = 'AVB0';
const FOOTER_MAGIC = 'AVBf';
const FLAGS_OFFSET = 120;
/** libavb's block sizes must be multiples of this, or it refuses the vbmeta. */
const BLOCK_ALIGNMENT = 64;
/** libavb's RSA verifier hard-codes this exponent; the encoded key does not even carry one. */
const RSA_EXPONENT = 65537n;
const AVB_KEY_BITS = [2048, 4096, 8192];

interface Algorithm {
  name: string;
  digest: 'sha256' | 'sha512';
  hashSize: number;
  keyBits: number;
}

/** `AvbAlgorithmType`. 0 is NONE (unsigned) and has no entry. */
const ALGORITHMS: ReadonlyMap<number, Algorithm> = new Map([
  [1, { name: 'SHA256_RSA2048', digest: 'sha256', hashSize: 32, keyBits: 2048 }],
  [2, { name: 'SHA256_RSA4096', digest: 'sha256', hashSize: 32, keyBits: 4096 }],
  [3, { name: 'SHA256_RSA8192', digest: 'sha256', hashSize: 32, keyBits: 8192 }],
  [4, { name: 'SHA512_RSA2048', digest: 'sha512', hashSize: 64, keyBits: 2048 }],
  [5, { name: 'SHA512_RSA4096', digest: 'sha512', hashSize: 64, keyBits: 4096 }],
  [6, { name: 'SHA512_RSA8192', digest: 'sha512', hashSize: 64, keyBits: 8192 }],
]);

export interface VbmetaHeader {
  requiredLibavbMajor: number;
  requiredLibavbMinor: number;
  /** Size of the authentication block (hash + signature), after the 256-byte header. */
  authSize: number;
  /** Size of the auxiliary block (descriptors, public key, key metadata), after the auth block. */
  auxSize: number;
  /** `AvbAlgorithmType`: 0 NONE, 1–3 SHA256_RSA{2048,4096,8192}, 4–6 SHA512_RSA{…}. */
  algorithm: number;
  /** Relative to the authentication block. */
  hashOffset: number;
  hashSize: number;
  /** Relative to the authentication block. */
  signatureOffset: number;
  signatureSize: number;
  /** Relative to the auxiliary block. */
  publicKeyOffset: number;
  publicKeySize: number;
  /** Relative to the auxiliary block. */
  publicKeyMetadataOffset: number;
  publicKeyMetadataSize: number;
  /** Relative to the auxiliary block. */
  descriptorsOffset: number;
  descriptorsSize: number;
  rollbackIndex: bigint;
  flags: number;
  rollbackIndexLocation: number;
  releaseString: string;
  /** 256 + authSize + auxSize: the bytes the vbmeta occupies, and what the digest covers. */
  totalSize: number;
}

export interface AvbFooter {
  /** Size of the filesystem image before the hashtree, FEC and vbmeta were appended. */
  originalImageSize: number;
  /** Where the partition's own vbmeta starts, from the start of the partition. */
  vbmetaOffset: number;
  vbmetaSize: number;
}

// ── Parsing ───────────────────────────────────────────────────────────────────────────────────

/**
 * The vbmeta header, checked the way libavb checks it before trusting any offset in it: magic,
 * major version, 64-byte-aligned blocks, every region inside its block, and sizes that match the
 * algorithm. `buf` may be longer than the vbmeta (a whole partition, say); `totalSize` says how
 * much of it is vbmeta.
 */
export function parseVbmetaHeader(buf: Buffer): VbmetaHeader {
  if (buf.length < VBMETA_HEADER_SIZE) {
    throw new Error(`vbmeta is ${buf.length} bytes, shorter than its ${VBMETA_HEADER_SIZE}-byte header`);
  }
  const magic = buf.subarray(0, 4).toString('latin1');
  if (magic !== VBMETA_MAGIC) {
    throw new Error(`vbmeta magic is ${JSON.stringify(magic)}, expected "${VBMETA_MAGIC}"`);
  }

  const requiredLibavbMajor = buf.readUInt32BE(4);
  const requiredLibavbMinor = buf.readUInt32BE(8);
  if (requiredLibavbMajor !== 1) {
    throw new Error(`vbmeta requires libavb ${requiredLibavbMajor}.${requiredLibavbMinor}; only 1.x is understood`);
  }

  const authSize = u64be(buf, 12, 'vbmeta authentication block size');
  const auxSize = u64be(buf, 20, 'vbmeta auxiliary block size');
  if (authSize % BLOCK_ALIGNMENT !== 0 || auxSize % BLOCK_ALIGNMENT !== 0) {
    throw new Error(`vbmeta block sizes (auth ${authSize}, aux ${auxSize}) are not multiples of ${BLOCK_ALIGNMENT}; libavb would refuse it`);
  }
  const totalSize = VBMETA_HEADER_SIZE + authSize + auxSize;
  if (totalSize > buf.length) {
    throw new Error(`vbmeta claims ${totalSize} bytes (256 + auth ${authSize} + aux ${auxSize}) but only ${buf.length} were given`);
  }

  const header: VbmetaHeader = {
    requiredLibavbMajor,
    requiredLibavbMinor,
    authSize,
    auxSize,
    algorithm: buf.readUInt32BE(28),
    hashOffset: u64be(buf, 32, 'vbmeta hash offset'),
    hashSize: u64be(buf, 40, 'vbmeta hash size'),
    signatureOffset: u64be(buf, 48, 'vbmeta signature offset'),
    signatureSize: u64be(buf, 56, 'vbmeta signature size'),
    publicKeyOffset: u64be(buf, 64, 'vbmeta public key offset'),
    publicKeySize: u64be(buf, 72, 'vbmeta public key size'),
    publicKeyMetadataOffset: u64be(buf, 80, 'vbmeta public key metadata offset'),
    publicKeyMetadataSize: u64be(buf, 88, 'vbmeta public key metadata size'),
    descriptorsOffset: u64be(buf, 96, 'vbmeta descriptors offset'),
    descriptorsSize: u64be(buf, 104, 'vbmeta descriptors size'),
    rollbackIndex: buf.readBigUInt64BE(112),
    flags: buf.readUInt32BE(FLAGS_OFFSET),
    rollbackIndexLocation: buf.readUInt32BE(124),
    releaseString: cString(buf.subarray(128, 176)),
    totalSize,
  };

  inside('hash', header.hashOffset, header.hashSize, 'authentication', authSize);
  inside('signature', header.signatureOffset, header.signatureSize, 'authentication', authSize);
  inside('public key', header.publicKeyOffset, header.publicKeySize, 'auxiliary', auxSize);
  inside('public key metadata', header.publicKeyMetadataOffset, header.publicKeyMetadataSize, 'auxiliary', auxSize);
  inside('descriptors', header.descriptorsOffset, header.descriptorsSize, 'auxiliary', auxSize);

  if (header.algorithm !== 0) {
    const algorithm = ALGORITHMS.get(header.algorithm);
    if (!algorithm) {
      throw new Error(`vbmeta algorithm type ${header.algorithm} is unknown (0 is NONE, 1–6 are SHA256/SHA512 with RSA)`);
    }
    // libavb refuses a hash, signature or key whose size disagrees with the algorithm.
    if (header.hashSize !== algorithm.hashSize) {
      throw new Error(`vbmeta hash is ${header.hashSize} bytes; ${algorithm.name} uses ${algorithm.hashSize}`);
    }
    if (header.signatureSize !== algorithm.keyBits / 8) {
      throw new Error(`vbmeta signature is ${header.signatureSize} bytes; ${algorithm.name} uses ${algorithm.keyBits / 8}`);
    }
    if (header.publicKeySize !== avbPublicKeySize(algorithm.keyBits)) {
      throw new Error(`vbmeta public key is ${header.publicKeySize} bytes; an encoded ${algorithm.name} key is ${avbPublicKeySize(algorithm.keyBits)}`);
    }
  }

  return header;
}

/**
 * The AVB footer, from the last 64 bytes of a partition (a longer `tail` is fine; its last 64
 * bytes are used). Null if there is no footer.
 *
 * `partitionSize`, when given, is checked against: a footer pointing past the partition would send
 * the reader into the next volume, and the digest built from those bytes would boot nothing.
 */
export function parseAvbFooter(tail: Buffer, partitionSize?: number): AvbFooter | null {
  if (tail.length < AVB_FOOTER_SIZE) {
    throw new Error(`an AVB footer is the last ${AVB_FOOTER_SIZE} bytes of a partition; only ${tail.length} were given`);
  }
  const footer = tail.subarray(tail.length - AVB_FOOTER_SIZE);
  if (footer.subarray(0, 4).toString('latin1') !== FOOTER_MAGIC) return null;

  const major = footer.readUInt32BE(4);
  const minor = footer.readUInt32BE(8);
  if (major !== 1) throw new Error(`AVB footer version ${major}.${minor}; only 1.x is understood`);

  const originalImageSize = u64be(footer, 12, 'AVB footer original image size');
  const vbmetaOffset = u64be(footer, 20, 'AVB footer vbmeta offset');
  const vbmetaSize = u64be(footer, 28, 'AVB footer vbmeta size');

  if (vbmetaSize < VBMETA_HEADER_SIZE) {
    throw new Error(`AVB footer says the vbmeta is ${vbmetaSize} bytes, smaller than a vbmeta header`);
  }
  // avbtool appends the hashtree, FEC and vbmeta after the filesystem; a vbmeta inside it is not
  // something avbtool wrote.
  if (vbmetaOffset < originalImageSize) {
    throw new Error(`AVB footer puts the vbmeta at ${vbmetaOffset}, inside the ${originalImageSize}-byte filesystem image`);
  }
  if (partitionSize !== undefined && vbmetaOffset + vbmetaSize > partitionSize - AVB_FOOTER_SIZE) {
    throw new Error(`AVB footer puts the vbmeta at [${vbmetaOffset}, +${vbmetaSize}), past the footer of a ${partitionSize}-byte partition`);
  }

  return { originalImageSize, vbmetaOffset, vbmetaSize };
}

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────

/**
 * An RSA public key in AVB's encoding (`AvbRSAPublicKeyHeader` + data), as avbtool's
 * `extract_public_key` writes it: u32 key bits, u32 n0inv = −1/n mod 2^32, n, then
 * rr = 2^(2·bits) mod n — the Montgomery constants libavb's verifier uses instead of computing
 * them. All big-endian. Accepts a private key too, and encodes its public half.
 */
export function avbPublicKey(publicKey: KeyObject): Buffer {
  const key = publicKey.type === 'private' ? createPublicKey(publicKey) : publicKey;
  if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') {
    throw new Error(`AVB keys are RSA; this is a ${key.asymmetricKeyType ?? key.type} key`);
  }
  const jwk = key.export({ format: 'jwk' });
  if (!jwk.n || !jwk.e) throw new Error('RSA key export has no modulus or exponent');

  const n = bigFromBase64url(jwk.n);
  const e = bigFromBase64url(jwk.e);
  if (e !== RSA_EXPONENT) {
    throw new Error(`RSA public exponent is ${e}; libavb hard-codes ${RSA_EXPONENT}, so this key could never verify`);
  }
  const bits = n.toString(2).length;
  if (bits % 8 !== 0 || (n & 1n) === 0n) {
    throw new Error(`RSA modulus of ${bits} bits is not a whole number of bytes, or is even; not an AVB key`);
  }

  const two32 = 1n << 32n;
  const n0inv = two32 - modInverse(n % two32, two32);
  const rr = (1n << (2n * BigInt(bits))) % n;

  const head = Buffer.alloc(8);
  head.writeUInt32BE(bits, 0);
  head.writeUInt32BE(Number(n0inv), 4);
  return Buffer.concat([head, bigToBytes(n, bits / 8), bigToBytes(rr, bits / 8)]);
}

/**
 * The per-machine signing key: `dir/openemu-avb.pem`, PKCS#8, created (with `dir`) if missing.
 *
 * **This key is not a secret, and it is deliberately not in the repository.** The guest's
 * libfs_avb accepts any key on the top-level vbmeta — it checks the signature against the key
 * embedded next to it, and leaves trusting that key to the bootloader, whose check on the emulator
 * accepts anything. What binds the image is the digest on the kernel command line, not the key. The
 * key exists only so that rebuilding on the same machine is byte-identical: a fresh key per build
 * would change the digest, hence the ROM id, and reset every AVD's system snapshot for nothing.
 * Committed, it would look like a leaked signing key and invite someone to treat it as one.
 *
 * An existing file must hold an RSA key of `bits` bits with exponent 65537, or this throws naming
 * the file — a key of the wrong size cannot replace the one in the vbmeta without moving offsets.
 */
export function loadOrCreateSigningKey(dir: string, bits = 4096): KeyObject {
  if (!AVB_KEY_BITS.includes(bits)) {
    throw new Error(`AVB signs with RSA-${AVB_KEY_BITS.join('/')}; ${bits} bits is not one of them`);
  }
  const file = path.join(dir, SIGNING_KEY_FILE);

  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: Number(RSA_EXPONENT) });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    // Written aside and renamed, so a crash mid-write leaves no half a key for the next run to
    // choke on.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, pem);
    renameSync(temp, file);
  }

  // Always read back from disk, so the key returned is the key the next build will load.
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(file));
  } catch (error) {
    throw new Error(`${file} does not hold a readable private key (${(error as Error).message}); delete it and a new one will be made`);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`${file} holds a ${key.asymmetricKeyType} key; AVB signs with RSA`);
  }
  const details = key.asymmetricKeyDetails ?? {};
  if (details.modulusLength !== bits) {
    throw new Error(`${file} holds a ${details.modulusLength}-bit key; ${bits} bits are needed to replace the key in the vbmeta without moving offsets`);
  }
  if (details.publicExponent !== RSA_EXPONENT) {
    throw new Error(`${file} holds a key with public exponent ${details.publicExponent}; libavb only verifies ${RSA_EXPONENT}`);
  }
  return key;
}

// ── Signing ───────────────────────────────────────────────────────────────────────────────────

/**
 * A re-signed copy of `vbmeta`: exactly `totalSize` bytes, `flags` in the header, our public key in
 * place of the old one, and a fresh hash and RSASSA-PKCS1-v1_5 signature over header ‖ auxiliary
 * block. Nothing else changes — descriptors, key metadata and every offset stay as they were, which
 * is why our key must be the same size as the one it replaces.
 *
 * The result is verified before it is returned, the way libavb will: hash recomputed, signature
 * checked against the key decoded from the vbmeta's own bytes.
 */
export function resignVbmeta(vbmeta: Buffer, privateKey: KeyObject, flags: number): Buffer {
  const header = parseVbmetaHeader(vbmeta);
  if (header.algorithm === 0) {
    throw new Error('vbmeta is unsigned (algorithm NONE); it has no room for a signature, and adding one would move every offset');
  }
  const algorithm = ALGORITHMS.get(header.algorithm) as Algorithm;
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) {
    throw new Error(`vbmeta flags ${flags} are not an unsigned 32-bit value`);
  }
  if (privateKey.type !== 'private') throw new Error('re-signing a vbmeta needs a private key');

  const ourKey = avbPublicKey(privateKey);
  if (ourKey.length !== header.publicKeySize) {
    throw new Error(
      `our AVB public key is ${ourKey.length} bytes but the vbmeta holds a ${header.publicKeySize}-byte one; ${algorithm.name} needs an RSA-${algorithm.keyBits} key, and any other size would move every offset after it`,
    );
  }

  // Writing the hash would clobber the signature (or vice versa), and writing the key would clobber
  // descriptors or key metadata: in each case the result verifies over the wrong bytes.
  if (overlaps(header.hashOffset, header.hashSize, header.signatureOffset, header.signatureSize)) {
    throw new Error('vbmeta hash and signature overlap in the authentication block');
  }
  if (overlaps(header.publicKeyOffset, header.publicKeySize, header.descriptorsOffset, header.descriptorsSize)) {
    throw new Error('vbmeta public key overlaps its descriptors in the auxiliary block');
  }
  if (overlaps(header.publicKeyOffset, header.publicKeySize, header.publicKeyMetadataOffset, header.publicKeyMetadataSize)) {
    throw new Error('vbmeta public key overlaps its public key metadata in the auxiliary block');
  }

  const out = Buffer.from(vbmeta.subarray(0, header.totalSize));
  const authStart = VBMETA_HEADER_SIZE;
  const auxStart = VBMETA_HEADER_SIZE + header.authSize;

  out.writeUInt32BE(flags, FLAGS_OFFSET);
  ourKey.copy(out, auxStart + header.publicKeyOffset);

  const signed = signedBytes(out, header);
  const hash = createHash(algorithm.digest).update(signed).digest();
  const signature = sign(algorithm.digest, signed, { key: privateKey, padding: constants.RSA_PKCS1_PADDING });
  if (signature.length !== header.signatureSize) {
    throw new Error(`signature is ${signature.length} bytes; the vbmeta has room for ${header.signatureSize}`);
  }
  hash.copy(out, authStart + header.hashOffset);
  signature.copy(out, authStart + header.signatureOffset);

  verifyAsLibavb(out, algorithm);
  return out;
}

/** SHA-256 hex over the vbmeta images in order — top-level first, then each chained one. */
export function vbmetaDigest(images: Buffer[]): string {
  const hash = createHash('sha256');
  for (const image of images) hash.update(image);
  return hash.digest('hex');
}

/** What libavb hashes and signs: the 256-byte header followed by the auxiliary block. */
function signedBytes(vbmeta: Buffer, header: VbmetaHeader): Buffer {
  const auxStart = VBMETA_HEADER_SIZE + header.authSize;
  return Buffer.concat([vbmeta.subarray(0, VBMETA_HEADER_SIZE), vbmeta.subarray(auxStart, auxStart + header.auxSize)]);
}

/**
 * Re-parses a signed vbmeta and checks it the way the guest will: the stored hash matches, and the
 * signature verifies against the key *embedded in the vbmeta*, not the one we signed with. A
 * mismatch here is a bug in this file, and it is far cheaper to find at build time than as a
 * guest that will not mount `/system`.
 */
function verifyAsLibavb(vbmeta: Buffer, algorithm: Algorithm): void {
  const header = parseVbmetaHeader(vbmeta);
  const signed = signedBytes(vbmeta, header);
  const authStart = VBMETA_HEADER_SIZE;
  const auxStart = VBMETA_HEADER_SIZE + header.authSize;

  const storedHash = vbmeta.subarray(authStart + header.hashOffset, authStart + header.hashOffset + header.hashSize);
  if (!createHash(algorithm.digest).update(signed).digest().equals(storedHash)) {
    throw new Error('re-signed vbmeta fails its own hash check');
  }

  const embedded = vbmeta.subarray(auxStart + header.publicKeyOffset, auxStart + header.publicKeyOffset + header.publicKeySize);
  const bits = embedded.readUInt32BE(0);
  if (bits !== algorithm.keyBits) {
    throw new Error(`re-signed vbmeta embeds a ${bits}-bit key; ${algorithm.name} needs ${algorithm.keyBits}`);
  }
  const modulus = embedded.subarray(8, 8 + bits / 8);
  const key = createPublicKey({ key: { kty: 'RSA', n: modulus.toString('base64url'), e: 'AQAB' }, format: 'jwk' });
  const signature = vbmeta.subarray(authStart + header.signatureOffset, authStart + header.signatureOffset + header.signatureSize);
  if (!verify(algorithm.digest, signed, { key, padding: constants.RSA_PKCS1_PADDING }, signature)) {
    throw new Error('re-signed vbmeta signature does not verify against the key embedded in it');
  }
}

// ── VerifiedBootParams.textproto ──────────────────────────────────────────────────────────────

const PARAM_START = /^\s*param\s*:/;
const PARAM_LINE = /^\s*param\s*:\s*"([^"\\]*)"\s*$/;
const MAJOR_VERSION_LINE = /^\s*major_version\s*:/;
/** Quotes and backslashes would need textproto escaping; whitespace would split the kernel command line. */
const UNSAFE_PARAM_CHARACTERS = /["\\\s\u0000-\u001f\u007f]/;

/**
 * Sets, replaces and removes `param: "key=value"` lines in the emulator's
 * `VerifiedBootParams.textproto`, which it turns into kernel command-line arguments.
 *
 * An existing param keeps its line and its position; a new one goes after the last param. Duplicate
 * keys collapse to the first — the guest copies `androidboot.*` into read-only `ro.boot.*`
 * properties, where the first value set is the one that sticks, so a stale digest left above a
 * fresh one would win. `major_version` and any line not understood are kept. A leading `#` line is
 * the emulator's human-readable summary and is rewritten to list the params that result.
 */
export function upsertVerifiedBootParams(text: string, set: Record<string, string>, remove: string[] = []): string {
  for (const [key, value] of Object.entries(set)) {
    checkParamKey(key);
    if (UNSAFE_PARAM_CHARACTERS.test(value)) {
      throw new Error(`VerifiedBootParams value for "${key}" contains a quote, backslash, whitespace or control character: ${JSON.stringify(value)}`);
    }
  }
  for (const key of remove) {
    checkParamKey(key);
    if (Object.hasOwn(set, key)) throw new Error(`VerifiedBootParams key "${key}" is both set and removed`);
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = text === '' || text.endsWith('\n');
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (endsWithNewline && lines.length > 0) lines.pop();

  const out: string[] = [];
  const present = new Set<string>();
  let lastParam = -1;
  let majorVersion = -1;

  lines.forEach((line, index) => {
    if (PARAM_START.test(line)) {
      const match = PARAM_LINE.exec(line);
      if (!match) {
        // An escaped or oddly quoted param could hide a duplicate key from this reader.
        throw new Error(`VerifiedBootParams line ${index + 1} is a param this cannot read safely: ${line}`);
      }
      const key = paramKey(match[1]);
      if (remove.includes(key) || present.has(key)) return;
      present.add(key);
      out.push(Object.hasOwn(set, key) ? paramLine(key, set[key]) : line);
      lastParam = out.length - 1;
      return;
    }
    if (MAJOR_VERSION_LINE.test(line)) majorVersion = out.length;
    out.push(line);
  });

  const missing = Object.keys(set)
    .filter((key) => !present.has(key))
    .map((key) => paramLine(key, set[key]));
  const insertAt = lastParam !== -1 ? lastParam + 1 : majorVersion !== -1 ? majorVersion + 1 : out.length;
  out.splice(insertAt, 0, ...missing);

  if (out.length > 0 && out[0].startsWith('#')) {
    const params = out.flatMap((line) => {
      const match = PARAM_LINE.exec(line);
      return match ? [match[1]] : [];
    });
    out[0] = params.length > 0 ? `# ${params.join(' ')}` : '#';
  }

  return out.join(eol) + (endsWithNewline ? eol : '');
}

function checkParamKey(key: string): void {
  if (key === '' || key.includes('=') || UNSAFE_PARAM_CHARACTERS.test(key)) {
    throw new Error(`VerifiedBootParams key ${JSON.stringify(key)} is empty or contains "=", a quote, backslash, whitespace or control character`);
  }
}

function paramKey(content: string): string {
  const eq = content.indexOf('=');
  return eq === -1 ? content : content.slice(0, eq);
}

function paramLine(key: string, value: string): string {
  return `param: "${key}=${value}"`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

function avbPublicKeySize(bits: number): number {
  return 8 + 2 * (bits / 8);
}

function inside(what: string, offset: number, size: number, block: string, blockSize: number): void {
  if (offset + size > blockSize) {
    throw new Error(`vbmeta ${what} [${offset}, +${size}) lies outside the ${blockSize}-byte ${block} block`);
  }
}

function overlaps(aOffset: number, aSize: number, bOffset: number, bSize: number): boolean {
  return aSize > 0 && bSize > 0 && aOffset < bOffset + bSize && bOffset < aOffset + aSize;
}

/** A u64 about to become an offset or size, so it must survive conversion to a number. */
function u64be(buffer: Buffer, offset: number, what: string): number {
  const value = buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${what} ${value} is too large to be real`);
  return Number(value);
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('latin1');
}

function bigFromBase64url(text: string): bigint {
  const hex = Buffer.from(text, 'base64url').toString('hex');
  return hex === '' ? 0n : BigInt(`0x${hex}`);
}

function bigToBytes(value: bigint, length: number): Buffer {
  const hex = value.toString(16);
  if (hex.length > length * 2) throw new Error(`a value of ${hex.length * 4} bits does not fit in ${length} bytes`);
  return Buffer.from(hex.padStart(length * 2, '0'), 'hex');
}

/** a⁻¹ mod m by the extended Euclidean algorithm; `a` and `m` must be coprime. */
function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('value has no inverse modulo the given modulus');
  return ((oldS % m) + m) % m;
}
