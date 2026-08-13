import { createPublicKey, verify as cryptoVerify } from "node:crypto";

// Deterministic JSON so the signer and every verifier hash the exact same
// bytes regardless of object key insertion order.
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function decodeLicense(licenseString) {
  const json = Buffer.from(String(licenseString).trim(), "base64url").toString("utf8");
  const parsed = JSON.parse(json);
  if (!parsed || !parsed.payload || !parsed.signature) {
    throw new Error("malformed license: missing payload/signature");
  }
  return parsed;
}

export function verifyLicense(licenseString, publicKeyJwk) {
  let decoded;
  try {
    decoded = decodeLicense(licenseString);
  } catch (err) {
    return { valid: false, reason: `unreadable license: ${err.message}` };
  }

  const { payload, signature } = decoded;
  let ok = false;
  try {
    const publicKey = createPublicKey({ key: publicKeyJwk, format: "jwk" });
    ok = cryptoVerify(null, Buffer.from(canonicalize(payload)), publicKey, Buffer.from(signature, "base64url"));
  } catch (err) {
    return { valid: false, reason: `signature check failed: ${err.message}` };
  }
  if (!ok) return { valid: false, reason: "signature does not match" };

  if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: "license expired", payload };
  }

  return { valid: true, payload };
}
