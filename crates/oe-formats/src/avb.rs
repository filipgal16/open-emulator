//! Android Verified Boot (AVB 2.0) metadata: reading it, re-signing the top-level vbmeta with our
//! own key, and the digest the emulator passes on the kernel command line.
//!
//! Why re-sign rather than patch: `/system` is protected by dm-verity with FEC, which repairs every
//! edit back to Google's bytes at read time. Setting `HASHTREE_DISABLED` in the top-level vbmeta
//! turns that off, but the flag is inside the signed header, so patching it alone makes libfs_avb
//! reject the image (`PUBLIC_KEY_REJECTED`, `/system` fails to mount). Re-signing with any key
//! works because libfs_avb checks the signature against the key embedded in the same vbmeta and
//! leaves *which* key to the bootloader, whose check on the emulator trusts any key. What binds
//! the image is `androidboot.vbmeta.digest`, which is why the digest is recomputed and written into
//! `VerifiedBootParams.textproto` in step with the signature.
//!
//! All vbmeta integers are big-endian. Offsets inside the authentication and auxiliary blocks are
//! relative to the start of each block, not of the vbmeta.

use std::path::{Path, PathBuf};

use num_bigint::BigUint;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use rsa::traits::PublicKeyParts;
use rsa::{BoxedUint, Pkcs1v15Sign, PrivateKey, PublicKey};
use sha2::{Digest, Sha256, Sha512};

use crate::bytes::{c_string, js_is_space, json_quote, latin1, put_u32be, split_lines, u32be, u64be};
use crate::{err, fail, Result, MAX_SAFE_INTEGER};

pub const AVB_FLAG_HASHTREE_DISABLED: u32 = 1;
pub const AVB_FLAG_VERIFICATION_DISABLED: u32 = 2;

pub const VBMETA_HEADER_SIZE: usize = 256;
pub const AVB_FOOTER_SIZE: usize = 64;
pub const SIGNING_KEY_FILE: &str = "openemu-avb.pem";

const VBMETA_MAGIC: &str = "AVB0";
const FOOTER_MAGIC: &[u8; 4] = b"AVBf";
const FLAGS_OFFSET: usize = 120;
/// libavb's block sizes must be multiples of this, or it refuses the vbmeta.
const BLOCK_ALIGNMENT: u64 = 64;
/// libavb's RSA verifier hard-codes this exponent; the encoded key does not even carry one.
const RSA_EXPONENT: u32 = 65537;
const AVB_KEY_BITS: [usize; 3] = [2048, 4096, 8192];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DigestKind {
    Sha256,
    Sha512,
}

impl DigestKind {
    fn hash(self, parts: &[&[u8]]) -> Vec<u8> {
        match self {
            DigestKind::Sha256 => {
                let mut hash = Sha256::new();
                parts.iter().for_each(|part| hash.update(part));
                hash.finalize().to_vec()
            }
            DigestKind::Sha512 => {
                let mut hash = Sha512::new();
                parts.iter().for_each(|part| hash.update(part));
                hash.finalize().to_vec()
            }
        }
    }

    fn padding(self) -> Pkcs1v15Sign {
        match self {
            DigestKind::Sha256 => Pkcs1v15Sign::new::<Sha256>(),
            DigestKind::Sha512 => Pkcs1v15Sign::new::<Sha512>(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Algorithm {
    name: &'static str,
    digest: DigestKind,
    hash_size: u64,
    key_bits: u64,
}

/// `AvbAlgorithmType`. 0 is NONE (unsigned) and has no entry.
fn algorithm(kind: u32) -> Option<Algorithm> {
    let (name, digest, hash_size, key_bits) = match kind {
        1 => ("SHA256_RSA2048", DigestKind::Sha256, 32, 2048),
        2 => ("SHA256_RSA4096", DigestKind::Sha256, 32, 4096),
        3 => ("SHA256_RSA8192", DigestKind::Sha256, 32, 8192),
        4 => ("SHA512_RSA2048", DigestKind::Sha512, 64, 2048),
        5 => ("SHA512_RSA4096", DigestKind::Sha512, 64, 4096),
        6 => ("SHA512_RSA8192", DigestKind::Sha512, 64, 8192),
        _ => return None,
    };
    Some(Algorithm { name, digest, hash_size, key_bits })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VbmetaHeader {
    pub required_libavb_major: u32,
    pub required_libavb_minor: u32,
    /// Size of the authentication block (hash + signature), after the 256-byte header.
    pub auth_size: u64,
    /// Size of the auxiliary block (descriptors, public key, key metadata), after the auth block.
    pub aux_size: u64,
    /// `AvbAlgorithmType`: 0 NONE, 1–3 SHA256_RSA{2048,4096,8192}, 4–6 SHA512_RSA{…}.
    pub algorithm: u32,
    /// Relative to the authentication block.
    pub hash_offset: u64,
    pub hash_size: u64,
    /// Relative to the authentication block.
    pub signature_offset: u64,
    pub signature_size: u64,
    /// Relative to the auxiliary block.
    pub public_key_offset: u64,
    pub public_key_size: u64,
    /// Relative to the auxiliary block.
    pub public_key_metadata_offset: u64,
    pub public_key_metadata_size: u64,
    /// Relative to the auxiliary block.
    pub descriptors_offset: u64,
    pub descriptors_size: u64,
    pub rollback_index: u64,
    pub flags: u32,
    pub rollback_index_location: u32,
    pub release_string: String,
    /// 256 + auth_size + aux_size: the bytes the vbmeta occupies, and what the digest covers.
    pub total_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvbFooter {
    /// Size of the filesystem image before the hashtree, FEC and vbmeta were appended.
    pub original_image_size: u64,
    /// Where the partition's own vbmeta starts, from the start of the partition.
    pub vbmeta_offset: u64,
    pub vbmeta_size: u64,
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────

/// The vbmeta header, checked the way libavb checks it before trusting any offset in it: magic,
/// major version, 64-byte-aligned blocks, every region inside its block, and sizes that match the
/// algorithm. `buf` may be longer than the vbmeta (a whole partition, say); `total_size` says how
/// much of it is vbmeta.
pub fn parse_vbmeta_header(buf: &[u8]) -> Result<VbmetaHeader> {
    if buf.len() < VBMETA_HEADER_SIZE {
        fail!("vbmeta is {} bytes, shorter than its {VBMETA_HEADER_SIZE}-byte header", buf.len());
    }
    let magic = latin1(&buf[0..4]);
    if magic != VBMETA_MAGIC {
        fail!("vbmeta magic is {}, expected \"{VBMETA_MAGIC}\"", json_quote(&magic));
    }

    let required_libavb_major = u32be(buf, 4);
    let required_libavb_minor = u32be(buf, 8);
    if required_libavb_major != 1 {
        fail!("vbmeta requires libavb {required_libavb_major}.{required_libavb_minor}; only 1.x is understood");
    }

    let auth_size = safe_u64be(buf, 12, "vbmeta authentication block size")?;
    let aux_size = safe_u64be(buf, 20, "vbmeta auxiliary block size")?;
    if auth_size % BLOCK_ALIGNMENT != 0 || aux_size % BLOCK_ALIGNMENT != 0 {
        fail!(
            "vbmeta block sizes (auth {auth_size}, aux {aux_size}) are not multiples of {BLOCK_ALIGNMENT}; libavb would refuse it"
        );
    }
    let total_size = VBMETA_HEADER_SIZE as u64 + auth_size + aux_size;
    if total_size > buf.len() as u64 {
        fail!(
            "vbmeta claims {total_size} bytes (256 + auth {auth_size} + aux {aux_size}) but only {} were given",
            buf.len()
        );
    }

    let header = VbmetaHeader {
        required_libavb_major,
        required_libavb_minor,
        auth_size,
        aux_size,
        algorithm: u32be(buf, 28),
        hash_offset: safe_u64be(buf, 32, "vbmeta hash offset")?,
        hash_size: safe_u64be(buf, 40, "vbmeta hash size")?,
        signature_offset: safe_u64be(buf, 48, "vbmeta signature offset")?,
        signature_size: safe_u64be(buf, 56, "vbmeta signature size")?,
        public_key_offset: safe_u64be(buf, 64, "vbmeta public key offset")?,
        public_key_size: safe_u64be(buf, 72, "vbmeta public key size")?,
        public_key_metadata_offset: safe_u64be(buf, 80, "vbmeta public key metadata offset")?,
        public_key_metadata_size: safe_u64be(buf, 88, "vbmeta public key metadata size")?,
        descriptors_offset: safe_u64be(buf, 96, "vbmeta descriptors offset")?,
        descriptors_size: safe_u64be(buf, 104, "vbmeta descriptors size")?,
        rollback_index: u64be(buf, 112),
        flags: u32be(buf, FLAGS_OFFSET),
        rollback_index_location: u32be(buf, 124),
        release_string: c_string(&buf[128..176]),
        total_size,
    };

    inside("hash", header.hash_offset, header.hash_size, "authentication", auth_size)?;
    inside("signature", header.signature_offset, header.signature_size, "authentication", auth_size)?;
    inside("public key", header.public_key_offset, header.public_key_size, "auxiliary", aux_size)?;
    inside(
        "public key metadata",
        header.public_key_metadata_offset,
        header.public_key_metadata_size,
        "auxiliary",
        aux_size,
    )?;
    inside("descriptors", header.descriptors_offset, header.descriptors_size, "auxiliary", aux_size)?;

    if header.algorithm != 0 {
        let Some(algorithm) = algorithm(header.algorithm) else {
            fail!(
                "vbmeta algorithm type {} is unknown (0 is NONE, 1–6 are SHA256/SHA512 with RSA)",
                header.algorithm
            );
        };
        // libavb refuses a hash, signature or key whose size disagrees with the algorithm.
        if header.hash_size != algorithm.hash_size {
            fail!("vbmeta hash is {} bytes; {} uses {}", header.hash_size, algorithm.name, algorithm.hash_size);
        }
        if header.signature_size != algorithm.key_bits / 8 {
            fail!(
                "vbmeta signature is {} bytes; {} uses {}",
                header.signature_size,
                algorithm.name,
                algorithm.key_bits / 8
            );
        }
        if header.public_key_size != avb_public_key_size(algorithm.key_bits) {
            fail!(
                "vbmeta public key is {} bytes; an encoded {} key is {}",
                header.public_key_size,
                algorithm.name,
                avb_public_key_size(algorithm.key_bits)
            );
        }
    }

    Ok(header)
}

/// The AVB footer, from the last 64 bytes of a partition (a longer `tail` is fine; its last 64
/// bytes are used). `None` if there is no footer.
///
/// `partition_size`, when given, is checked against: a footer pointing past the partition would
/// send the reader into the next volume, and the digest built from those bytes would boot nothing.
pub fn parse_avb_footer(tail: &[u8], partition_size: Option<u64>) -> Result<Option<AvbFooter>> {
    if tail.len() < AVB_FOOTER_SIZE {
        fail!(
            "an AVB footer is the last {AVB_FOOTER_SIZE} bytes of a partition; only {} were given",
            tail.len()
        );
    }
    let footer = &tail[tail.len() - AVB_FOOTER_SIZE..];
    if &footer[0..4] != FOOTER_MAGIC {
        return Ok(None);
    }

    let major = u32be(footer, 4);
    let minor = u32be(footer, 8);
    if major != 1 {
        fail!("AVB footer version {major}.{minor}; only 1.x is understood");
    }

    let original_image_size = safe_u64be(footer, 12, "AVB footer original image size")?;
    let vbmeta_offset = safe_u64be(footer, 20, "AVB footer vbmeta offset")?;
    let vbmeta_size = safe_u64be(footer, 28, "AVB footer vbmeta size")?;

    if vbmeta_size < VBMETA_HEADER_SIZE as u64 {
        fail!("AVB footer says the vbmeta is {vbmeta_size} bytes, smaller than a vbmeta header");
    }
    // avbtool appends the hashtree, FEC and vbmeta after the filesystem; a vbmeta inside it is not
    // something avbtool wrote.
    if vbmeta_offset < original_image_size {
        fail!("AVB footer puts the vbmeta at {vbmeta_offset}, inside the {original_image_size}-byte filesystem image");
    }
    if let Some(partition_size) = partition_size {
        if (vbmeta_offset + vbmeta_size) as i128 > partition_size as i128 - AVB_FOOTER_SIZE as i128 {
            fail!(
                "AVB footer puts the vbmeta at [{vbmeta_offset}, +{vbmeta_size}), past the footer of a {partition_size}-byte partition"
            );
        }
    }

    Ok(Some(AvbFooter { original_image_size, vbmeta_offset, vbmeta_size }))
}

// ── Keys ────────────────────────────────────────────────────────────────────────────────────────

/// An RSA public key in AVB's encoding (`AvbRSAPublicKeyHeader` + data), as avbtool's
/// `extract_public_key` writes it: u32 key bits, u32 n0inv = −1/n mod 2^32, n, then
/// rr = 2^(2·bits) mod n: the Montgomery constants libavb's verifier uses instead of computing
/// them. All big-endian. A private key encodes as its public half.
pub fn avb_public_key<K: PublicKeyParts>(key: &K) -> Result<Vec<u8>> {
    let n_bytes = key.n_bytes();
    let n = BigUint::from_bytes_be(&n_bytes);
    let e = BigUint::from_bytes_be(&key.e_bytes());
    if e != BigUint::from(RSA_EXPONENT) {
        fail!(
            "RSA public exponent is {e}; libavb hard-codes {RSA_EXPONENT}, so this key could never verify"
        );
    }
    let bits = n.bits() as usize;
    let n_low = low_u32(&n_bytes);
    if bits % 8 != 0 || n_low & 1 == 0 {
        fail!("RSA modulus of {bits} bits is not a whole number of bytes, or is even; not an AVB key");
    }

    // The inverse of an odd number modulo 2^32 by Newton's iteration: each step doubles the
    // number of correct low bits, and an odd n is its own inverse to 3 bits.
    let mut inverse = n_low;
    for _ in 0..5 {
        inverse = inverse.wrapping_mul(2u32.wrapping_sub(n_low.wrapping_mul(inverse)));
    }
    let n0inv = 0u32.wrapping_sub(inverse);
    let rr = (BigUint::from(1u32) << (2 * bits)) % &n;

    let length = bits / 8;
    let mut out = Vec::with_capacity(8 + 2 * length);
    out.extend_from_slice(&(bits as u32).to_be_bytes());
    out.extend_from_slice(&n0inv.to_be_bytes());
    out.extend_from_slice(&big_to_bytes(&n, length)?);
    out.extend_from_slice(&big_to_bytes(&rr, length)?);
    Ok(out)
}

/// The low 32 bits of a big-endian integer.
fn low_u32(big_endian: &[u8]) -> u32 {
    let mut last = [0u8; 4];
    let take = big_endian.len().min(4);
    last[4 - take..].copy_from_slice(&big_endian[big_endian.len() - take..]);
    u32::from_be_bytes(last)
}

fn modulus_bits<K: PublicKeyParts>(key: &K) -> usize {
    BigUint::from_bytes_be(&key.n_bytes()).bits() as usize
}

fn exponent<K: PublicKeyParts>(key: &K) -> BigUint {
    BigUint::from_bytes_be(&key.e_bytes())
}

/// The per-machine signing key: `dir/openemu-avb.pem`, PKCS#8, created (with `dir`) if missing.
///
/// **This key is not a secret, and it is deliberately not in the repository.** The guest's
/// libfs_avb accepts any key on the top-level vbmeta; it checks the signature against the key
/// embedded next to it, and leaves trusting that key to the bootloader, whose check on the emulator
/// accepts anything. What binds the image is the digest on the kernel command line, not the key.
/// The key exists only so that rebuilding on the same machine is byte-identical: a fresh key per
/// build would change the digest, hence the ROM id, and reset every AVD's system snapshot for
/// nothing. Committed, it would look like a leaked signing key and invite someone to treat it as
/// one.
///
/// An existing file must hold an RSA key of `bits` bits with exponent 65537, or this fails naming
/// the file: a key of the wrong size cannot replace the one in the vbmeta without moving offsets.
pub fn load_or_create_signing_key(dir: &Path, bits: usize) -> Result<PrivateKey> {
    if !AVB_KEY_BITS.contains(&bits) {
        fail!("AVB signs with RSA-2048/4096/8192; {bits} bits is not one of them");
    }
    let file = dir.join(SIGNING_KEY_FILE);

    if !file.exists() {
        std::fs::create_dir_all(dir)?;
        let key = PrivateKey::new(&mut getrandom::SysRng, bits)
            .map_err(|error| err!("could not generate an RSA-{bits} key: {error}"))?;
        let pem = key
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|error| err!("could not encode the signing key: {error}"))?;
        // Written aside and renamed, so a crash mid-write leaves no half a key for the next run to
        // choke on.
        let temp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
        std::fs::write(&temp, pem.as_bytes())?;
        std::fs::rename(&temp, &file)?;
    }

    // Always read back from disk, so the key returned is the key the next build will load.
    let text = std::fs::read_to_string(&file).map_err(|error| unreadable(&file, &error.to_string()))?;
    let key = PrivateKey::from_pkcs8_pem(&text)
        .or_else(|pkcs8| PrivateKey::from_pkcs1_pem(&text).map_err(|_| pkcs8.to_string()))
        .map_err(|error| unreadable(&file, &error))?;

    let modulus_length = modulus_bits(&key);
    if modulus_length != bits {
        fail!(
            "{} holds a {modulus_length}-bit key; {bits} bits are needed to replace the key in the vbmeta without moving offsets",
            file.display()
        );
    }
    let e = exponent(&key);
    if e != BigUint::from(RSA_EXPONENT) {
        fail!("{} holds a key with public exponent {e}; libavb only verifies {RSA_EXPONENT}", file.display());
    }
    Ok(key)
}

fn unreadable(file: &Path, reason: &str) -> crate::Error {
    err!(
        "{} does not hold a readable private key ({reason}); delete it and a new one will be made",
        file.display()
    )
}

// ── Signing ─────────────────────────────────────────────────────────────────────────────────────

/// A re-signed copy of `vbmeta`: exactly `total_size` bytes, `flags` in the header, our public key
/// in place of the old one, and a fresh hash and RSASSA-PKCS1-v1_5 signature over header ‖
/// auxiliary block. Nothing else changes: descriptors, key metadata and every offset stay as they
/// were, which is why our key must be the same size as the one it replaces.
///
/// The result is verified before it is returned, the way libavb will: hash recomputed, signature
/// checked against the key decoded from the vbmeta's own bytes.
pub fn resign_vbmeta(vbmeta: &[u8], private_key: &PrivateKey, flags: u32) -> Result<Vec<u8>> {
    let header = parse_vbmeta_header(vbmeta)?;
    if header.algorithm == 0 {
        fail!("vbmeta is unsigned (algorithm NONE); it has no room for a signature, and adding one would move every offset");
    }
    let algorithm = algorithm(header.algorithm).expect("checked by parse_vbmeta_header");

    let our_key = avb_public_key(private_key)?;
    if our_key.len() as u64 != header.public_key_size {
        fail!(
            "our AVB public key is {} bytes but the vbmeta holds a {}-byte one; {} needs an RSA-{} key, and any other size would move every offset after it",
            our_key.len(),
            header.public_key_size,
            algorithm.name,
            algorithm.key_bits
        );
    }

    // Writing the hash would clobber the signature (or vice versa), and writing the key would
    // clobber descriptors or key metadata: in each case the result verifies over the wrong bytes.
    if overlaps(header.hash_offset, header.hash_size, header.signature_offset, header.signature_size) {
        fail!("vbmeta hash and signature overlap in the authentication block");
    }
    if overlaps(header.public_key_offset, header.public_key_size, header.descriptors_offset, header.descriptors_size) {
        fail!("vbmeta public key overlaps its descriptors in the auxiliary block");
    }
    if overlaps(
        header.public_key_offset,
        header.public_key_size,
        header.public_key_metadata_offset,
        header.public_key_metadata_size,
    ) {
        fail!("vbmeta public key overlaps its public key metadata in the auxiliary block");
    }

    let mut out = vbmeta[..header.total_size as usize].to_vec();
    let auth_start = VBMETA_HEADER_SIZE;
    let aux_start = VBMETA_HEADER_SIZE + header.auth_size as usize;

    put_u32be(&mut out, FLAGS_OFFSET, flags);
    let key_at = aux_start + header.public_key_offset as usize;
    out[key_at..key_at + our_key.len()].copy_from_slice(&our_key);

    let hash = algorithm.digest.hash(&signed_parts(&out, &header));
    let signature = private_key
        .sign(algorithm.digest.padding(), &hash)
        .map_err(|error| err!("could not sign the vbmeta: {error}"))?;
    if signature.len() as u64 != header.signature_size {
        fail!("signature is {} bytes; the vbmeta has room for {}", signature.len(), header.signature_size);
    }
    let hash_at = auth_start + header.hash_offset as usize;
    out[hash_at..hash_at + hash.len()].copy_from_slice(&hash);
    let signature_at = auth_start + header.signature_offset as usize;
    out[signature_at..signature_at + signature.len()].copy_from_slice(&signature);

    verify_as_libavb(&out, algorithm)?;
    Ok(out)
}

/// SHA-256 hex over the vbmeta images in order, top-level first, then each chained one.
pub fn vbmeta_digest(images: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for image in images {
        hash.update(image);
    }
    crate::bytes::hex(&hash.finalize())
}

/// What libavb hashes and signs: the 256-byte header followed by the auxiliary block.
fn signed_parts<'a>(vbmeta: &'a [u8], header: &VbmetaHeader) -> [&'a [u8]; 2] {
    let aux_start = VBMETA_HEADER_SIZE + header.auth_size as usize;
    [&vbmeta[..VBMETA_HEADER_SIZE], &vbmeta[aux_start..aux_start + header.aux_size as usize]]
}

/// Re-parses a signed vbmeta and checks it the way the guest will: the stored hash matches, and the
/// signature verifies against the key *embedded in the vbmeta*, not the one we signed with. A
/// mismatch here is a bug in this file, and it is far cheaper to find at build time than as a
/// guest that will not mount `/system`.
fn verify_as_libavb(vbmeta: &[u8], algorithm: Algorithm) -> Result<()> {
    let header = parse_vbmeta_header(vbmeta)?;
    let hash = algorithm.digest.hash(&signed_parts(vbmeta, &header));
    let auth_start = VBMETA_HEADER_SIZE;
    let aux_start = VBMETA_HEADER_SIZE + header.auth_size as usize;

    let hash_at = auth_start + header.hash_offset as usize;
    if hash != vbmeta[hash_at..hash_at + header.hash_size as usize] {
        fail!("re-signed vbmeta fails its own hash check");
    }

    let key_at = aux_start + header.public_key_offset as usize;
    let embedded = &vbmeta[key_at..key_at + header.public_key_size as usize];
    let bits = u64::from(u32be(embedded, 0));
    if bits != algorithm.key_bits {
        fail!("re-signed vbmeta embeds a {bits}-bit key; {} needs {}", algorithm.name, algorithm.key_bits);
    }
    let modulus = BoxedUint::from_be_slice(&embedded[8..8 + (bits / 8) as usize], bits as u32)
        .map_err(|error| err!("re-signed vbmeta embeds a modulus that cannot be read: {error:?}"))?;
    let key = PublicKey::new(modulus, BoxedUint::from(u64::from(RSA_EXPONENT)))
        .map_err(|error| err!("re-signed vbmeta embeds a key that is not one: {error}"))?;
    let signature_at = auth_start + header.signature_offset as usize;
    let signature = &vbmeta[signature_at..signature_at + header.signature_size as usize];
    if key.verify(algorithm.digest.padding(), &hash, signature).is_err() {
        fail!("re-signed vbmeta signature does not verify against the key embedded in it");
    }
    Ok(())
}

// ── VerifiedBootParams.textproto ────────────────────────────────────────────────────────────────

/// `^\s*param\s*:`
fn is_param_start(line: &str) -> bool {
    line.trim_start_matches(js_is_space)
        .strip_prefix("param")
        .map(|rest| rest.trim_start_matches(js_is_space).starts_with(':'))
        .unwrap_or(false)
}

/// `^\s*param\s*:\s*"([^"\\]*)"\s*$`, returning the quoted content.
fn param_content(line: &str) -> Option<&str> {
    let rest = line.trim_start_matches(js_is_space).strip_prefix("param")?;
    let rest = rest.trim_start_matches(js_is_space).strip_prefix(':')?;
    let rest = rest.trim_start_matches(js_is_space).strip_prefix('"')?;
    let end = rest.find(['"', '\\'])?;
    if rest.as_bytes()[end] != b'"' {
        return None;
    }
    let after = &rest[end + 1..];
    if after.chars().all(js_is_space) {
        Some(&rest[..end])
    } else {
        None
    }
}

/// `^\s*major_version\s*:`
fn is_major_version(line: &str) -> bool {
    line.trim_start_matches(js_is_space)
        .strip_prefix("major_version")
        .map(|rest| rest.trim_start_matches(js_is_space).starts_with(':'))
        .unwrap_or(false)
}

/// Quotes and backslashes would need textproto escaping; whitespace would split the kernel command
/// line.
fn has_unsafe_characters(text: &str) -> bool {
    text.chars().any(|c| c == '"' || c == '\\' || js_is_space(c) || (c as u32) <= 0x1f || c == '\u{7f}')
}

/// Sets, replaces and removes `param: "key=value"` lines in the emulator's
/// `VerifiedBootParams.textproto`, which it turns into kernel command-line arguments.
///
/// An existing param keeps its line and its position; a new one goes after the last param.
/// Duplicate keys collapse to the first: the guest copies `androidboot.*` into read-only
/// `ro.boot.*` properties, where the first value set is the one that sticks, so a stale digest left
/// above a fresh one would win. `major_version` and any line not understood are kept. A leading `#`
/// line is the emulator's human-readable summary and is rewritten to list the params that result.
///
/// `set` is in the order new params are appended.
pub fn upsert_verified_boot_params(text: &str, set: &[(&str, &str)], remove: &[&str]) -> Result<String> {
    for (key, value) in set {
        check_param_key(key)?;
        if has_unsafe_characters(value) {
            fail!(
                "VerifiedBootParams value for \"{key}\" contains a quote, backslash, whitespace or control character: {}",
                json_quote(value)
            );
        }
    }
    let value_of = |key: &str| set.iter().find(|(k, _)| *k == key).map(|(_, v)| *v);
    for key in remove {
        check_param_key(key)?;
        if value_of(key).is_some() {
            fail!("VerifiedBootParams key \"{key}\" is both set and removed");
        }
    }

    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let ends_with_newline = text.is_empty() || text.ends_with('\n');
    let mut lines: Vec<&str> = if text.is_empty() { Vec::new() } else { split_lines(text) };
    if ends_with_newline && !lines.is_empty() {
        lines.pop();
    }

    let mut out: Vec<String> = Vec::new();
    let mut present: Vec<String> = Vec::new();
    let mut last_param: Option<usize> = None;
    let mut major_version: Option<usize> = None;

    for (index, line) in lines.iter().enumerate() {
        if is_param_start(line) {
            let Some(content) = param_content(line) else {
                // An escaped or oddly quoted param could hide a duplicate key from this reader.
                fail!("VerifiedBootParams line {} is a param this cannot read safely: {line}", index + 1);
            };
            let key = content.split_once('=').map(|(k, _)| k).unwrap_or(content);
            if remove.contains(&key) || present.iter().any(|p| p == key) {
                continue;
            }
            present.push(key.to_owned());
            out.push(match value_of(key) {
                Some(value) => param_line(key, value),
                None => (*line).to_owned(),
            });
            last_param = Some(out.len() - 1);
            continue;
        }
        if is_major_version(line) {
            major_version = Some(out.len());
        }
        out.push((*line).to_owned());
    }

    let mut seen_new: Vec<&str> = Vec::new();
    let missing: Vec<String> = set
        .iter()
        .filter(|(key, _)| !present.iter().any(|p| p == key))
        .filter(|(key, _)| {
            let first = !seen_new.contains(key);
            seen_new.push(key);
            first
        })
        .map(|(key, value)| param_line(key, value))
        .collect();
    let insert_at = match (last_param, major_version) {
        (Some(last), _) => last + 1,
        (None, Some(major)) => major + 1,
        (None, None) => out.len(),
    };
    out.splice(insert_at..insert_at, missing);

    if out.first().is_some_and(|line| line.starts_with('#')) {
        let params: Vec<String> = out.iter().filter_map(|line| param_content(line).map(str::to_owned)).collect();
        out[0] = if params.is_empty() { "#".to_owned() } else { format!("# {}", params.join(" ")) };
    }

    let mut result = out.join(eol);
    if ends_with_newline {
        result.push_str(eol);
    }
    Ok(result)
}

fn check_param_key(key: &str) -> Result<()> {
    if key.is_empty() || key.contains('=') || has_unsafe_characters(key) {
        fail!(
            "VerifiedBootParams key {} is empty or contains \"=\", a quote, backslash, whitespace or control character",
            json_quote(key)
        );
    }
    Ok(())
}

fn param_line(key: &str, value: &str) -> String {
    format!("param: \"{key}={value}\"")
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

fn avb_public_key_size(bits: u64) -> u64 {
    8 + 2 * (bits / 8)
}

fn inside(what: &str, offset: u64, size: u64, block: &str, block_size: u64) -> Result<()> {
    if u128::from(offset) + u128::from(size) > u128::from(block_size) {
        fail!("vbmeta {what} [{offset}, +{size}) lies outside the {block_size}-byte {block} block");
    }
    Ok(())
}

fn overlaps(a_offset: u64, a_size: u64, b_offset: u64, b_size: u64) -> bool {
    a_size > 0 && b_size > 0 && a_offset < b_offset + b_size && b_offset < a_offset + a_size
}

/// A u64 about to become an offset or size, so it must stay within the range both builders accept.
fn safe_u64be(data: &[u8], at: usize, what: &str) -> Result<u64> {
    let value = u64be(data, at);
    if value > MAX_SAFE_INTEGER {
        fail!("{what} {value} is too large to be real");
    }
    Ok(value)
}

fn big_to_bytes(value: &BigUint, length: usize) -> Result<Vec<u8>> {
    let bytes = value.to_bytes_be();
    let bytes: &[u8] = if bytes == [0] { &[] } else { &bytes };
    if bytes.len() > length {
        fail!("a value of {} bits does not fit in {length} bytes", value.bits());
    }
    let mut out = vec![0u8; length - bytes.len()];
    out.extend_from_slice(bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::put_u64be;
    use std::sync::LazyLock;

    fn rsa(bits: usize, exponent: u64) -> PrivateKey {
        PrivateKey::new_with_exp(&mut getrandom::SysRng, bits, BoxedUint::from(exponent)).unwrap()
    }

    // RSA-4096 generation is slow, so every key is made once and shared: "Google's" key signs the
    // synthetic image, "ours" re-signs it.
    static GOOGLE_KEY: LazyLock<PrivateKey> = LazyLock::new(|| rsa(4096, 65537));
    static OUR_KEY: LazyLock<PrivateKey> = LazyLock::new(|| rsa(4096, 65537));
    static SMALL_KEY: LazyLock<PrivateKey> = LazyLock::new(|| rsa(2048, 65537));
    static EXPONENT_3_KEY: LazyLock<PrivateKey> = LazyLock::new(|| rsa(2048, 3));

    fn align64(n: usize) -> usize {
        n.div_ceil(64) * 64
    }

    fn pattern(length: usize, seed: usize) -> Vec<u8> {
        (0..length).map(|i| ((i * 131 + seed) & 0xff) as u8).collect()
    }

    /// A signed vbmeta laid out the way avbtool lays out the real top-level one: hash then
    /// signature in the auth block; descriptors, public key, then key metadata in the aux block.
    /// With the defaults it has the measured shape: 4480 bytes, auth 576, aux 3648, key at 2592.
    fn build_vbmeta(kind: u32, key: &PrivateKey, flags: u32, descriptors: &[u8]) -> Vec<u8> {
        let algorithm = algorithm(kind).unwrap();
        let hash_size = algorithm.hash_size as usize;
        let public_key = avb_public_key(key).unwrap();
        let signature_size = (algorithm.key_bits / 8) as usize;
        let auth_size = align64(hash_size + signature_size);
        let aux_size = align64(descriptors.len() + public_key.len());

        let mut vbmeta = vec![0u8; 256 + auth_size + aux_size];
        vbmeta[0..4].copy_from_slice(b"AVB0");
        put_u32be(&mut vbmeta, 4, 1);
        put_u64be(&mut vbmeta, 12, auth_size as u64);
        put_u64be(&mut vbmeta, 20, aux_size as u64);
        put_u32be(&mut vbmeta, 28, kind);
        put_u64be(&mut vbmeta, 32, 0);
        put_u64be(&mut vbmeta, 40, hash_size as u64);
        put_u64be(&mut vbmeta, 48, hash_size as u64);
        put_u64be(&mut vbmeta, 56, signature_size as u64);
        put_u64be(&mut vbmeta, 64, descriptors.len() as u64);
        put_u64be(&mut vbmeta, 72, public_key.len() as u64);
        put_u64be(&mut vbmeta, 80, (descriptors.len() + public_key.len()) as u64);
        put_u64be(&mut vbmeta, 88, 0);
        put_u64be(&mut vbmeta, 96, 0);
        put_u64be(&mut vbmeta, 104, descriptors.len() as u64);
        put_u32be(&mut vbmeta, 120, flags);
        vbmeta[128..141].copy_from_slice(b"avbtool 1.1.0");

        let aux = 256 + auth_size;
        vbmeta[aux..aux + descriptors.len()].copy_from_slice(descriptors);
        vbmeta[aux + descriptors.len()..aux + descriptors.len() + public_key.len()].copy_from_slice(&public_key);

        let hash = algorithm.digest.hash(&[&vbmeta[..256], &vbmeta[aux..]]);
        let signature = key.sign(algorithm.digest.padding(), &hash).unwrap();
        vbmeta[256..256 + hash_size].copy_from_slice(&hash);
        vbmeta[256 + hash_size..256 + hash_size + signature_size].copy_from_slice(&signature);
        vbmeta
    }

    fn default_vbmeta() -> Vec<u8> {
        build_vbmeta(2, &GOOGLE_KEY, 0, &pattern(2592, 7))
    }

    fn signed_part(vbmeta: &[u8], header: &VbmetaHeader) -> Vec<u8> {
        [&vbmeta[..256], &vbmeta[256 + header.auth_size as usize..header.total_size as usize]].concat()
    }

    fn verifies(key: &PrivateKey, digest: DigestKind, signed: &[u8], signature: &[u8]) -> bool {
        key.to_public_key().verify(digest.padding(), &digest.hash(&[signed]), signature).is_ok()
    }

    fn message<T: std::fmt::Debug>(result: Result<T>) -> String {
        result.expect_err("expected a refusal").to_string()
    }

    // ── Parsing ─────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_synthetic_vbmeta_has_the_measured_shape() {
        let header = parse_vbmeta_header(&default_vbmeta()).unwrap();

        assert_eq!(header.total_size, 4480);
        assert_eq!(header.algorithm, 2);
        assert_eq!(header.auth_size, 576);
        assert_eq!(header.aux_size, 3648);
        assert_eq!(
            [header.hash_offset, header.hash_size, header.signature_offset, header.signature_size],
            [0, 32, 32, 512]
        );
        assert_eq!([header.public_key_offset, header.public_key_size], [2592, 1032]);
        assert_eq!(header.release_string, "avbtool 1.1.0");
    }

    #[test]
    fn a_vbmeta_that_is_not_one_is_refused() {
        let vbmeta = default_vbmeta();
        let broken = |change: &dyn Fn(&mut Vec<u8>)| {
            let mut copy = vbmeta.clone();
            change(&mut copy);
            copy
        };

        assert!(message(parse_vbmeta_header(&broken(&|b| b[0..4].copy_from_slice(b"AVBf"))))
            .contains("vbmeta magic is \"AVBf\""));
        let text = message(parse_vbmeta_header(&vbmeta[..4000]));
        assert!(text.contains("claims 4480 bytes") && text.contains("only 4000"), "{text}");
        assert!(message(parse_vbmeta_header(&broken(&|b| put_u64be(b, 12, 577)))).contains("not multiples of 64"));
        assert!(message(parse_vbmeta_header(&broken(&|b| put_u64be(b, 48, 560))))
            .contains("signature [560, +512) lies outside the 576-byte authentication block"));
        assert!(message(parse_vbmeta_header(&broken(&|b| put_u32be(b, 28, 9)))).contains("algorithm type 9 is unknown"));
        assert!(message(parse_vbmeta_header(&broken(&|b| put_u64be(b, 40, 64))))
            .contains("hash is 64 bytes; SHA256_RSA4096 uses 32"));
    }

    #[test]
    fn the_footer_is_read_from_the_last_64_bytes_and_its_absence_is_none() {
        let mut tail = vec![0u8; 4096];
        {
            let footer = &mut tail[4096 - 64..];
            footer[0..4].copy_from_slice(b"AVBf");
            put_u32be(footer, 4, 1);
            put_u64be(footer, 12, 1061564416);
            put_u64be(footer, 20, 1078390784);
            put_u64be(footer, 28, 1664);
        }
        let footer = tail[4096 - 64..].to_vec();

        let expected = AvbFooter { original_image_size: 1061564416, vbmeta_offset: 1078390784, vbmeta_size: 1664 };
        assert_eq!(parse_avb_footer(&footer, None).unwrap(), Some(expected));
        assert_eq!(parse_avb_footer(&tail, Some(1078669312)).unwrap(), Some(expected), "a longer tail uses its last 64 bytes");
        assert_eq!(parse_avb_footer(&[0u8; 64], None).unwrap(), None);
        assert!(message(parse_avb_footer(&footer, Some(1078390784 + 1000))).contains("past the footer of a"));
        assert!(message(parse_avb_footer(&[0u8; 63], None)).contains("last 64 bytes"));

        let mut future = footer.clone();
        put_u32be(&mut future, 4, 2);
        assert!(message(parse_avb_footer(&future, None)).contains("AVB footer version 2.0"));
    }

    // ── The public key encoding ─────────────────────────────────────────────────────────────────

    #[test]
    fn the_avb_public_key_carries_n_and_the_montgomery_constants_libavb_expects() {
        let encoded = avb_public_key(&OUR_KEY.to_public_key()).unwrap();
        let bits = u32be(&encoded, 0);
        let n0inv = BigUint::from(u32be(&encoded, 4));
        let n = BigUint::from_bytes_be(&encoded[8..8 + 512]);
        let rr = BigUint::from_bytes_be(&encoded[8 + 512..]);
        let two32 = BigUint::from(1u64 << 32);

        assert_eq!(encoded.len(), 1032);
        assert_eq!(bits, 4096);
        assert_eq!(n, BigUint::from_bytes_be(&OUR_KEY.n_bytes()));
        assert_eq!((&n * &n0inv) % &two32, &two32 - BigUint::from(1u32), "n * n0inv must be -1 mod 2^32");
        assert_eq!(rr, (BigUint::from(1u32) << 8192usize) % &n);
    }

    #[test]
    fn a_private_key_encodes_as_its_public_half_and_a_2048_bit_key_is_520_bytes() {
        assert_eq!(avb_public_key(&*OUR_KEY).unwrap(), avb_public_key(&OUR_KEY.to_public_key()).unwrap());
        assert_eq!(avb_public_key(&*SMALL_KEY).unwrap().len(), 520);
    }

    #[test]
    fn a_key_whose_exponent_is_not_65537_is_refused() {
        // libavb's verifier hard-codes e = 65537; the encoding does not even carry an exponent.
        assert!(message(avb_public_key(&*EXPONENT_3_KEY)).contains("public exponent is 3"));
    }

    // ── Re-signing ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn re_signing_sets_the_flags_swaps_the_key_and_signs_with_ours_and_changes_nothing_else() {
        let original = default_vbmeta();
        let header = parse_vbmeta_header(&original).unwrap();

        let resigned = resign_vbmeta(&original, &OUR_KEY, AVB_FLAG_HASHTREE_DISABLED).unwrap();

        assert_eq!(resigned.len(), 4480, "size unchanged, so the digest covers the same span");
        assert_eq!(parse_vbmeta_header(&resigned).unwrap().flags, 1);

        assert_eq!(resigned[..120], original[..120], "header before the flags");
        assert_eq!(resigned[124..256], original[124..256], "header after the flags");

        let aux = 256 + header.auth_size as usize;
        let key_start = aux + header.public_key_offset as usize;
        let key_end = key_start + header.public_key_size as usize;
        assert_eq!(resigned[aux..key_start], original[aux..key_start], "descriptors");
        assert_eq!(resigned[key_end..], original[key_end..], "aux after the key");
        assert_eq!(resigned[key_start..key_end], avb_public_key(&*OUR_KEY).unwrap()[..], "our key is embedded");

        let signed = signed_part(&resigned, &header);
        assert_eq!(resigned[256..256 + 32], DigestKind::Sha256.hash(&[&signed])[..]);
        let signature = &resigned[256 + 32..256 + 32 + 512];
        assert!(verifies(&OUR_KEY, DigestKind::Sha256, &signed, signature), "verifies against our key");
        assert!(!verifies(&GOOGLE_KEY, DigestKind::Sha256, &signed, signature), "and not against the old one");
    }

    #[test]
    fn a_whole_partition_in_is_exactly_one_vbmeta_out() {
        let partition = [default_vbmeta(), vec![0u8; 8192]].concat();
        assert_eq!(resign_vbmeta(&partition, &OUR_KEY, AVB_FLAG_HASHTREE_DISABLED).unwrap().len(), 4480);
    }

    #[test]
    fn sha512_algorithms_are_hashed_and_signed_with_sha512() {
        let original = build_vbmeta(5, &GOOGLE_KEY, 0, &pattern(2592, 7));
        let header = parse_vbmeta_header(&original).unwrap();

        let resigned = resign_vbmeta(&original, &OUR_KEY, AVB_FLAG_VERIFICATION_DISABLED).unwrap();
        let signed = signed_part(&resigned, &header);

        assert_eq!(parse_vbmeta_header(&resigned).unwrap().flags, 2);
        assert_eq!(resigned[256..256 + 64], DigestKind::Sha512.hash(&[&signed])[..]);
        assert!(verifies(&OUR_KEY, DigestKind::Sha512, &signed, &resigned[256 + 64..256 + 64 + 512]));
    }

    #[test]
    fn a_key_of_the_wrong_size_is_refused_because_it_would_move_every_offset() {
        assert!(message(resign_vbmeta(&default_vbmeta(), &SMALL_KEY, 1))
            .contains("520 bytes but the vbmeta holds a 1032-byte one; SHA256_RSA4096 needs an RSA-4096 key"));
    }

    #[test]
    fn an_unsigned_vbmeta_is_refused() {
        let mut vbmeta = default_vbmeta();
        put_u32be(&mut vbmeta, 28, 0);
        assert!(message(resign_vbmeta(&vbmeta, &OUR_KEY, 1)).contains("unsigned (algorithm NONE)"));
    }

    #[test]
    fn a_public_key_overlapping_the_descriptors_is_refused() {
        let mut vbmeta = default_vbmeta();
        put_u64be(&mut vbmeta, 104, 2600); // descriptors now run into the key at 2592
        assert!(message(resign_vbmeta(&vbmeta, &OUR_KEY, 1)).contains("public key overlaps its descriptors"));
    }

    // ── Digest ──────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_digest_is_sha256_over_the_images_in_order() {
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(vbmeta_digest(&[b"a", b"bc"]), abc);
        assert_eq!(vbmeta_digest(&[b"abc"]), abc);
        assert_ne!(vbmeta_digest(&[b"bc", b"a"]), abc, "top-level first, then chained");
    }

    // ── The signing key ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_signing_key_is_created_once_then_reloaded_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("nested").join("rom");
        let file = dir.join("openemu-avb.pem");

        let created = load_or_create_signing_key(&dir, 2048).unwrap();
        assert!(file.exists(), "created, parent directories and all");
        assert!(std::fs::read_to_string(&file).unwrap().starts_with("-----BEGIN PRIVATE KEY-----"), "PKCS#8 PEM");

        let reloaded = load_or_create_signing_key(&dir, 2048).unwrap();
        assert_eq!(
            avb_public_key(&reloaded).unwrap(),
            avb_public_key(&created).unwrap(),
            "the same key, so rebuilds are byte-identical"
        );

        assert!(message(load_or_create_signing_key(&dir, 4096)).contains("holds a 2048-bit key; 4096 bits are needed"));
    }

    #[test]
    fn an_unreadable_key_file_is_refused_with_a_way_out() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("openemu-avb.pem"), "not a key").unwrap();

        let text = message(load_or_create_signing_key(dir.path(), 2048));
        assert!(text.contains("openemu-avb.pem does not hold a readable private key") && text.contains("delete it"), "{text}");
    }

    // ── VerifiedBootParams.textproto ────────────────────────────────────────────────────────────

    const OLD: &str = "aa516f360594014de86105695b13f1df5e00b81539011aafdd58e68e859134a1";
    const NEW: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn stock() -> String {
        [
            format!("# androidboot.vbmeta.size=6144 androidboot.vbmeta.hash_alg=sha256 androidboot.vbmeta.digest={OLD}"),
            "major_version: 2".into(),
            "param: \"androidboot.vbmeta.size=6144\"".into(),
            "param: \"androidboot.vbmeta.hash_alg=sha256\"".into(),
            format!("param: \"androidboot.vbmeta.digest={OLD}\""),
            String::new(),
        ]
        .join("\n")
    }

    #[test]
    fn an_existing_param_is_replaced_in_place_and_the_summary_follows() {
        let out = upsert_verified_boot_params(&stock(), &[("androidboot.vbmeta.digest", NEW)], &[]).unwrap();
        assert_eq!(out, stock().replace(OLD, NEW));
    }

    #[test]
    fn a_new_param_is_appended_after_the_last_one() {
        let out = upsert_verified_boot_params(&format!("{}# trailing note\n", stock()), &[("androidboot.openemu", "1")], &[])
            .unwrap();
        let expected = vec![
            format!("# androidboot.vbmeta.size=6144 androidboot.vbmeta.hash_alg=sha256 androidboot.vbmeta.digest={OLD} androidboot.openemu=1"),
            "major_version: 2".into(),
            "param: \"androidboot.vbmeta.size=6144\"".into(),
            "param: \"androidboot.vbmeta.hash_alg=sha256\"".into(),
            format!("param: \"androidboot.vbmeta.digest={OLD}\""),
            "param: \"androidboot.openemu=1\"".into(),
            "# trailing note".into(),
            String::new(),
        ];
        assert_eq!(out.split('\n').collect::<Vec<_>>(), expected);
    }

    #[test]
    fn a_removed_param_is_dropped_from_the_lines_and_the_summary() {
        let out = upsert_verified_boot_params(&stock(), &[], &["androidboot.vbmeta.hash_alg"]).unwrap();
        assert!(!out.contains("hash_alg"));
        assert!(out.starts_with("# androidboot.vbmeta.size=6144 androidboot.vbmeta.digest="));
        assert!(out.contains("major_version: 2\n"));
    }

    #[test]
    fn duplicate_keys_collapse_to_one_at_the_first_position() {
        // A stale digest left above a fresh one would win: ro.boot.* takes the first value given.
        let doubled = format!("{}param: \"androidboot.vbmeta.digest={NEW}\"\nparam: \"androidboot.vbmeta.size=4096\"\n", stock());

        let out = upsert_verified_boot_params(&doubled, &[("androidboot.vbmeta.digest", NEW)], &[]).unwrap();

        assert_eq!(out.matches("androidboot.vbmeta.digest=").count(), 2, "once in the summary, once as a param");
        assert_eq!(out.matches("param: \"androidboot.vbmeta.size=").count(), 1);
        assert_eq!(out, stock().replace(OLD, NEW), "the first size (6144) is the one kept");
    }

    #[test]
    fn a_file_without_a_summary_line_does_not_gain_one() {
        assert_eq!(
            upsert_verified_boot_params("major_version: 2\n", &[("androidboot.vbmeta.size", "6144")], &[]).unwrap(),
            "major_version: 2\nparam: \"androidboot.vbmeta.size=6144\"\n"
        );
    }

    #[test]
    fn crlf_line_endings_are_kept() {
        let out =
            upsert_verified_boot_params(&stock().replace('\n', "\r\n"), &[("androidboot.vbmeta.digest", NEW)], &[]).unwrap();
        assert_eq!(out, stock().replace(OLD, NEW).replace('\n', "\r\n"));
    }

    #[test]
    fn keys_and_values_that_would_break_the_textproto_or_the_command_line_are_refused() {
        for value in ["a b", "a\"b", "a\\b", "a\nb", "a\tb"] {
            let text = message(upsert_verified_boot_params(&stock(), &[("androidboot.x", value)], &[]));
            assert!(text.contains("value for \"androidboot.x\""), "{value:?}: {text}");
        }
        for key in ["", "a=b", "a b", "a\"b", "a\\b", "a\nb"] {
            assert!(message(upsert_verified_boot_params(&stock(), &[(key, "v")], &[])).contains("VerifiedBootParams key"));
            assert!(message(upsert_verified_boot_params(&stock(), &[], &[key])).contains("VerifiedBootParams key"));
        }
        assert!(message(upsert_verified_boot_params(&stock(), &[("k", "v")], &["k"])).contains("both set and removed"));
    }

    #[test]
    fn a_param_line_with_escapes_is_refused_rather_than_half_read() {
        let escaped = format!("{}param: \"androidboot.vbmeta.digest=\\\"x\\\"\"\n", stock());
        assert!(message(upsert_verified_boot_params(&escaped, &[("androidboot.vbmeta.digest", NEW)], &[]))
            .contains("line 6 is a param this cannot read safely"));
    }
}
