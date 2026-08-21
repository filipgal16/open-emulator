import { createPublicKey, verify as verifySignature } from 'crypto';

export interface LicensePayload {
  /** Order id or email the licence was issued against. Shown back to the user, never transmitted. */
  sub: string;
  /** Issued-at, epoch ms. */
  iat: number;
  /** Expiry, epoch ms. Absent for a perpetual licence. */
  exp?: number;
  plan: string;
}

export interface LicenseCheck {
  valid: boolean;
  reason?: 'malformed' | 'bad-signature' | 'expired' | 'wrong-plan' | 'no-public-key';
  payload?: LicensePayload;
}

const REMOVE_ADS_PLAN = 'remove-ads';

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verifies a remove-ads licence key entirely offline.
 *
 * Deliberately server-free: an Ed25519 signature over a tiny payload means there is no licence
 * server to run, pay for, or keep up — and no activation call, so a paying user is never told
 * "no" because a backend was down or because they were on a plane. The private key stays with
 * whoever issues keys; only the public key ships.
 *
 * This is anti-casual-copying, not anti-tamper. Someone determined can patch the check out of an
 * open-source Electron app, and pretending otherwise would mean building DRM that punishes
 * legitimate users to slightly inconvenience the rest.
 */
export function verifyLicense(key: string, publicKeyB64: string | null, now: number): LicenseCheck {
  if (!publicKeyB64) return { valid: false, reason: 'no-public-key' };

  const parts = key.trim().split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };

  let payload: LicensePayload;
  let signature: Buffer;
  try {
    payload = JSON.parse(b64urlDecode(parts[0]).toString('utf8')) as LicensePayload;
    signature = b64urlDecode(parts[1]);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (typeof payload?.sub !== 'string' || typeof payload?.plan !== 'string') {
    return { valid: false, reason: 'malformed' };
  }

  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    // Signed over the encoded payload exactly as it appears in the key, so re-serialisation can't
    // change what was signed.
    const ok = verifySignature(null, Buffer.from(parts[0], 'utf8'), publicKey, signature);
    if (!ok) return { valid: false, reason: 'bad-signature' };
  } catch {
    return { valid: false, reason: 'bad-signature' };
  }

  if (payload.plan !== REMOVE_ADS_PLAN) return { valid: false, reason: 'wrong-plan', payload };
  if (typeof payload.exp === 'number' && now > payload.exp) return { valid: false, reason: 'expired', payload };

  return { valid: true, payload };
}

export function licenseErrorMessage(reason: LicenseCheck['reason']): string {
  switch (reason) {
    case 'expired':
      return 'That licence has expired. Renew it to remove ads again.';
    case 'wrong-plan':
      return "That licence is valid but isn't a remove-ads licence.";
    case 'no-public-key':
      return 'This build has no licence public key configured, so licences cannot be checked.';
    default:
      return "That licence key wasn't recognised. Check for a missing character and try again.";
  }
}
