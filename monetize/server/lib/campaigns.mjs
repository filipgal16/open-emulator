import { createHash } from "node:crypto";
import { signToken } from "./hmac.mjs";

// Click tokens carry the creative id + slot + issue time so /v1/click can
// log an attributable click and 302 to the right partner URL without a
// database lookup — the token itself is the record. They're long-lived on
// purpose (a campaigns response might sit in a client's ETag cache for a
// while before anything is actually clicked).
export function buildCampaignsResponse(config, secret) {
  const slots = {};
  for (const [slot, creatives] of Object.entries(config.slots || {})) {
    slots[slot] = (creatives || []).map((creative) => ({
      id: creative.id,
      title: creative.title,
      body: creative.body || "",
      imageUrl: creative.imageUrl || "",
      cta: creative.cta || "Learn more",
      weight: Number(creative.weight) || 1,
      clickUrl: `/v1/click/${encodeURIComponent(creative.id)}?t=${encodeURIComponent(
        signToken({ id: creative.id, slot, url: creative.url, iat: Date.now() }, secret)
      )}`
    }));
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    dismissHours: config.dismissHours || 24,
    slots
  };
}

export function etagFor(config) {
  const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  return `"${hash.slice(0, 16)}"`;
}

export function findCreative(config, id) {
  for (const creatives of Object.values(config.slots || {})) {
    const match = (creatives || []).find((c) => c.id === id);
    if (match) return match;
  }
  return null;
}
