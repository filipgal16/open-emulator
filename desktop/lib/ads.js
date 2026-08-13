// Native ad rail — Example 1 from docs/MONETIZATION.md, actually wired up.
// Hard rules, enforced here rather than left to convention:
//   - Creatives are JSON only (title/body/imageUrl/cta/url). Nothing here
//     ever renders third-party HTML/JS/iframes in the trusted renderer —
//     desktop/public/app.js only ever reads these fields into text nodes
//     and an <img src>, never innerHTML from a remote string.
//   - Pro tier is a hard short-circuit: every path below checks
//     entitlement first and returns "no ads" before touching config,
//     consent, or the network at all.
//   - No consent, no ads — house creatives included. This is stricter
//     than strictly necessary (house creatives make zero network calls)
//     but matches the wizard's framing: accept ads, or pay instead.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const paths = require("./paths");
const entitlement = require("./entitlement");

const CONFIG_FILE = path.join(__dirname, "..", "config", "ads.json");
const CACHE_FILE = () => path.join(paths.desktopDataRoot(), "ads-cache.json");
const CONSENT_FILE = () => path.join(paths.desktopDataRoot(), "consent.json");
const SESSION_FILE = () => path.join(paths.desktopDataRoot(), "ads-session.json");
const QUEUE_FILE = () => path.join(paths.desktopDataRoot(), "ads-events-queue.json");
const LOG_FILE = () => path.join(paths.desktopDataRoot(), "ads.log");

const REMOTE_REFRESH_MS = 5 * 60 * 1000;
let remoteCache = null; // { fetchedAt, etag, campaigns } — in-memory, mirrors CACHE_FILE

function loadHouseConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { serverUrl: "", perSlotSessionCap: 6, dismissHours: 24, house: {} };
  }
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

// --- Consent -----------------------------------------------------------

function getConsent() {
  const stored = readJsonSafe(CONSENT_FILE(), null);
  return stored && typeof stored.adsAccepted === "boolean" ? stored.adsAccepted : null;
}

async function setConsent(accepted) {
  await writeJson(CONSENT_FILE(), { adsAccepted: Boolean(accepted), decidedAt: new Date().toISOString() });
  return { ok: true, adsAccepted: Boolean(accepted) };
}

// --- Session state (per-slot caps + dismiss window) ---------------------

function readSession() {
  return readJsonSafe(SESSION_FILE(), { impressions: {}, dismissedUntil: {} });
}

async function writeSession(state) {
  await writeJson(SESSION_FILE(), state);
}

async function dismissSlot(slot, hours) {
  const config = loadHouseConfig();
  const state = readSession();
  state.dismissedUntil[slot] = Date.now() + (Number(hours) || config.dismissHours || 24) * 3600 * 1000;
  await writeSession(state);
  return { ok: true, slot, dismissedUntil: state.dismissedUntil[slot] };
}

function isDismissed(state, slot) {
  const until = state.dismissedUntil[slot];
  return Boolean(until && until > Date.now());
}

function underSessionCap(state, slot, cap) {
  return (state.impressions[slot] || 0) < cap;
}

// --- Remote campaigns (optional, off unless serverUrl is configured) ---

async function fetchRemoteCampaigns(serverUrl) {
  const cached = remoteCache || readJsonSafe(CACHE_FILE(), null);
  const headers = cached && cached.etag ? { "If-None-Match": cached.etag } : {};
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/v1/campaigns`, {
      headers,
      signal: AbortSignal.timeout(5000)
    });
    if (res.status === 304 && cached) {
      remoteCache = { ...cached, fetchedAt: Date.now() };
      return remoteCache.campaigns;
    }
    if (!res.ok) throw new Error(`campaigns feed responded ${res.status}`);
    const campaigns = await res.json();
    const etag = res.headers.get("etag") || null;
    remoteCache = { fetchedAt: Date.now(), etag, campaigns };
    await writeJson(CACHE_FILE(), remoteCache);
    return campaigns;
  } catch {
    return cached ? cached.campaigns : null;
  }
}

async function loadCampaigns(config) {
  if (!config.serverUrl) return null;
  if (remoteCache && Date.now() - remoteCache.fetchedAt < REMOTE_REFRESH_MS) {
    return remoteCache.campaigns;
  }
  return fetchRemoteCampaigns(config.serverUrl);
}

// --- Selection -----------------------------------------------------------

function weightedPick(creatives) {
  const total = creatives.reduce((sum, c) => sum + (Number(c.weight) || 1), 0);
  let roll = Math.random() * total;
  for (const creative of creatives) {
    roll -= Number(creative.weight) || 1;
    if (roll <= 0) return creative;
  }
  return creatives[0];
}

function normalizeCreative(creative, slot) {
  return {
    id: creative.id,
    slot,
    title: creative.title,
    body: creative.body || "",
    imageUrl: creative.imageUrl || "",
    cta: creative.cta || "Learn more",
    // Remote creatives already carry a server-signed clickUrl; house
    // creatives use their own `url` directly (config-authored, nothing to
    // attribute or sign).
    clickUrl: creative.clickUrl || creative.url
  };
}

// Unlike pickCreativeForSlot (one rotating pick, session-capped), this is
// for slots that are an actual directory a person navigated to on purpose
// (Game Center) — show everything available, don't apply the rail/boot
// frequency caps meant to keep passive placements unobtrusive.
async function listCreativesForSlot(slot) {
  const entitlementState = await entitlement.getEntitlement();
  if (!entitlementState.adsEnabled) return { enabled: false, creatives: [] };
  if (getConsent() !== true) return { enabled: false, creatives: [] };

  const config = loadHouseConfig();
  const remote = await loadCampaigns(config);
  const pool = (remote && remote.slots && remote.slots[slot]) || config.house[slot] || [];
  return { enabled: true, creatives: pool.map((creative) => normalizeCreative(creative, slot)) };
}

async function pickCreativeForSlot(slot) {
  const entitlementState = await entitlement.getEntitlement();
  if (!entitlementState.adsEnabled) return { enabled: false, creative: null, reason: "pro tier" };

  if (getConsent() !== true) return { enabled: false, creative: null, reason: "no consent" };

  const config = loadHouseConfig();
  const state = readSession();
  if (isDismissed(state, slot)) return { enabled: true, creative: null, reason: "dismissed" };
  // The rail is the one persistent, low-key placement — it's meant to sit
  // there and rotate for as long as the app is open, so it's exempt from
  // the session cap that exists to stop the more interruptive placements
  // (boot interstitial, the New machine modal card) from nagging. It still
  // honors a dismiss.
  const capExempt = (config.sessionCapExemptSlots || ["rail"]).includes(slot);
  if (!capExempt && !underSessionCap(state, slot, config.perSlotSessionCap || 6)) {
    return { enabled: true, creative: null, reason: "session cap reached" };
  }

  const remote = await loadCampaigns(config);
  const pool = (remote && remote.slots && remote.slots[slot]) || config.house[slot] || [];
  if (!pool.length) return { enabled: true, creative: null, reason: "no creatives for slot" };

  const creative = normalizeCreative(weightedPick(pool), slot);
  return { enabled: true, creative };
}

// --- Events (impressions/clicks) ----------------------------------------

async function appendLocalLog(line) {
  await fsp.mkdir(path.dirname(LOG_FILE()), { recursive: true });
  await fsp.appendFile(LOG_FILE(), `${new Date().toISOString()} ${line}\n`);
}

async function queueEvent(event) {
  const queue = readJsonSafe(QUEUE_FILE(), []);
  queue.push({ ...event, ts: Date.now() });
  await writeJson(QUEUE_FILE(), queue.slice(-500));
}

async function recordImpression(slot, id) {
  const state = readSession();
  state.impressions[slot] = (state.impressions[slot] || 0) + 1;
  await writeSession(state);
  await appendLocalLog(`impression slot=${slot} id=${id}`);
  await queueEvent({ type: "impression", slot, id });
  return { ok: true };
}

async function flushEvents() {
  const config = loadHouseConfig();
  if (!config.serverUrl) return { ok: true, flushed: 0, reason: "no server configured" };
  const queue = readJsonSafe(QUEUE_FILE(), []);
  if (!queue.length) return { ok: true, flushed: 0 };
  try {
    const res = await fetch(`${config.serverUrl.replace(/\/$/, "")}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId: installIdHash(), events: queue }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error(`events endpoint responded ${res.status}`);
    await writeJson(QUEUE_FILE(), []);
    return { ok: true, flushed: queue.length };
  } catch (err) {
    return { ok: false, flushed: 0, error: err.message };
  }
}

let cachedInstallId = null;
function installIdHash() {
  if (cachedInstallId) return cachedInstallId;
  const seedFile = path.join(paths.desktopDataRoot(), "install-id");
  let seed = readSeed(seedFile);
  if (!seed) {
    seed = crypto.randomUUID();
    fs.mkdirSync(path.dirname(seedFile), { recursive: true });
    fs.writeFileSync(seedFile, seed);
  }
  cachedInstallId = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return cachedInstallId;
}

function readSeed(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

// --- Click dispatch --------------------------------------------------

// `open-emulator://` is an internal-action scheme this app invents for its
// own house creatives — never dereferenced as a real URL. Everything else
// (an absolute https:// URL, or a relative /v1/click/... path from the
// configured ad server) is opened externally via shell.openExternal, never
// loaded inside the trusted renderer.
async function resolveClick(slot, id, clickUrl) {
  await appendLocalLog(`click slot=${slot} id=${id} url=${clickUrl}`);
  await queueEvent({ type: "click", slot, id });

  if (typeof clickUrl === "string" && clickUrl.startsWith("open-emulator://")) {
    const action = clickUrl.slice("open-emulator://".length);
    if (action === "dismiss") return { action: "dismiss" };
    if (action === "upgrade") return { action: "upgrade" };
    if (action.startsWith("panel/")) return { action: "panel", panel: action.slice("panel/".length) };
    if (action === "reward/instance-slot") {
      const entitlementState = await entitlement.grantRewardedUnlock(24);
      return { action: "rewarded", entitlement: entitlementState };
    }
    return { action: "dismiss" };
  }

  const config = loadHouseConfig();
  let external = clickUrl;
  if (typeof clickUrl === "string" && clickUrl.startsWith("/v1/click/") && config.serverUrl) {
    external = `${config.serverUrl.replace(/\/$/, "")}${clickUrl}`;
  }
  return { action: "external", url: external };
}

module.exports = {
  getConsent,
  setConsent,
  dismissSlot,
  pickCreativeForSlot,
  listCreativesForSlot,
  recordImpression,
  resolveClick,
  flushEvents
};
