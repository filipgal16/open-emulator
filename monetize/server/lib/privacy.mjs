import { createHash } from "node:crypto";

// Truncates an IP to a coarse network prefix — enough for basic abuse/rate
// context, never enough to pin an individual. Matches the "truncated IP, no
// guest content ever" constraint from the plan.
export function truncateIp(ip) {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, "");
  if (clean.includes(".")) {
    const parts = clean.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (clean.includes(":")) {
    const parts = clean.split(":");
    return `${parts.slice(0, 3).join(":")}::`;
  }
  return null;
}

export function hashInstallId(rawId, secret) {
  if (!rawId) return null;
  // Callers pass an already-hashed id in the common case (the client hashes
  // its own install id before ever sending it); this just re-hashes with a
  // server-side salt so even a leaked event log can't be joined back to a
  // client-generated id from another context.
  return createHash("sha256").update(`${secret}:${rawId}`).digest("hex").slice(0, 32);
}
