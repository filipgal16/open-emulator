// Symmetric signing for two things that never need Ed25519's asymmetric
// property (both are verified by the same server that issued them):
// click-redirect tokens, and inbound partner postback signatures. License
// keys are the asymmetric one — see license.mjs.
import { createHmac, timingSafeEqual } from "node:crypto";

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function signToken(payload, secret) {
  const json = JSON.stringify(payload);
  const body = base64url(json);
  const mac = base64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = base64url(createHmac("sha256", secret).update(body).digest());
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// Stripe-style webhook verification: signature is HMAC-SHA256 over the raw
// request body (never the parsed/re-serialized one — whitespace or key
// order would change the bytes and break the signature).
export function verifyBodySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const provided = signatureHeader.replace(/^sha256=/, "").trim();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
