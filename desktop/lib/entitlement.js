// Offline license verification + tier limits. Deliberately has zero
// network dependency for the actual entitlement check — once a license
// string verifies against the public key baked in at build time
// (config/license-public-key.json), Pro keeps working forever, even if
// monetize/server disappears entirely.
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const path = require("path");
const paths = require("./paths");

const PUBLIC_KEY_FILE = path.join(__dirname, "..", "config", "license-public-key.json");
const LICENSE_FILE = () => path.join(paths.desktopDataRoot(), "license.json");
const STATE_FILE = () => path.join(paths.desktopDataRoot(), "entitlement-state.json");

const TIERS = {
  free: { maxInstances: 2, adsEnabled: true },
  pro: { maxInstances: Infinity, adsEnabled: false }
};

const REWARDED_BONUS_INSTANCES = 1;

// Must match monetize/server/lib/license.mjs's canonicalize() byte for
// byte — this is what actually got signed.
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function loadPublicKeyJwk() {
  try {
    return JSON.parse(fs.readFileSync(PUBLIC_KEY_FILE, "utf8"));
  } catch {
    return null;
  }
}

function verifyLicenseOffline(licenseString) {
  if (!licenseString) return { valid: false, reason: "no license provided" };
  const publicKeyJwk = loadPublicKeyJwk();
  if (!publicKeyJwk) {
    return { valid: false, reason: "no license public key bundled with this build" };
  }

  let decoded;
  try {
    const json = Buffer.from(String(licenseString).trim(), "base64url").toString("utf8");
    decoded = JSON.parse(json);
  } catch (err) {
    return { valid: false, reason: `unreadable license: ${err.message}` };
  }
  if (!decoded || !decoded.payload || !decoded.signature) {
    return { valid: false, reason: "malformed license" };
  }

  let ok = false;
  try {
    const publicKey = crypto.createPublicKey({ key: publicKeyJwk, format: "jwk" });
    ok = crypto.verify(
      null,
      Buffer.from(canonicalize(decoded.payload)),
      publicKey,
      Buffer.from(decoded.signature, "base64url")
    );
  } catch (err) {
    return { valid: false, reason: `signature check failed: ${err.message}` };
  }
  if (!ok) return { valid: false, reason: "signature does not match" };

  if (decoded.payload.expiresAt && new Date(decoded.payload.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: "license expired", payload: decoded.payload };
  }

  return { valid: true, payload: decoded.payload };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function currentTier() {
  const stored = readJsonSafe(LICENSE_FILE());
  if (!stored || !stored.license) return { tier: "free", payload: null };
  const result = verifyLicenseOffline(stored.license);
  if (!result.valid) return { tier: "free", payload: null, invalidReason: result.reason };
  return { tier: TIERS[result.payload.tier] ? result.payload.tier : "pro", payload: result.payload };
}

function rewardedUntil() {
  const state = readJsonSafe(STATE_FILE());
  const until = state && Number(state.rewardedUntil);
  return until && until > Date.now() ? until : null;
}

async function getEntitlement() {
  const { tier, payload, invalidReason } = currentTier();
  const base = TIERS[tier] || TIERS.free;
  const until = tier === "free" ? rewardedUntil() : null;
  const bonus = until ? REWARDED_BONUS_INSTANCES : 0;
  return {
    tier,
    license: payload,
    licenseInvalidReason: invalidReason || null,
    adsEnabled: base.adsEnabled,
    maxInstances: base.maxInstances === Infinity ? Infinity : base.maxInstances + bonus,
    rewardedUntil: until
  };
}

async function activateLicense(licenseString) {
  const result = verifyLicenseOffline(licenseString);
  if (!result.valid) {
    throw new Error(`License not accepted: ${result.reason}`);
  }
  await writeJson(LICENSE_FILE(), { license: licenseString, activatedAt: new Date().toISOString() });
  return getEntitlement();
}

async function deactivateLicense() {
  try {
    await fsp.unlink(LICENSE_FILE());
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return getEntitlement();
}

async function grantRewardedUnlock(hours = 24) {
  const until = Date.now() + Math.max(1, Number(hours) || 24) * 3600 * 1000;
  await writeJson(STATE_FILE(), { rewardedUntil: until });
  return getEntitlement();
}

// Called before actually starting a machine — throws with a message the UI
// can show as-is rather than returning a bare boolean, since "why" matters
// here (upsell vs. just a limit).
async function assertCanStartInstance(runningCount) {
  const entitlement = await getEntitlement();
  if (runningCount < entitlement.maxInstances) return entitlement;
  if (entitlement.tier === "pro") return entitlement; // maxInstances is Infinity for pro; unreachable, kept for clarity
  const err = new Error(
    entitlement.rewardedUntil
      ? `Free tier (+ today's unlock) is limited to ${entitlement.maxInstances} running machines.`
      : `Free tier is limited to ${entitlement.maxInstances} running machines — upgrade to Pro, or unlock a 3rd for today from the Game Center.`
  );
  err.code = "ENTITLEMENT_LIMIT";
  err.entitlement = entitlement;
  throw err;
}

module.exports = {
  getEntitlement,
  activateLicense,
  deactivateLicense,
  grantRewardedUnlock,
  assertCanStartInstance,
  verifyLicenseOffline
};
