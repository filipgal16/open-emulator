#!/usr/bin/env node
// Ad + license server — Node built-ins only (node:http router, no
// Express/Fastify), JSONL append-only storage. Small enough to run on a
// $5 VPS or behind a serverless adapter later; see monetize/README.md.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { env, loadCampaigns, loadPartners, SERVER_ROOT } from "./lib/config.mjs";
import { buildCampaignsResponse, etagFor, findCreative } from "./lib/campaigns.mjs";
import { verifyToken, verifyBodySignature } from "./lib/hmac.mjs";
import { appendEvent } from "./lib/store.mjs";
import { buildReport } from "./lib/report.mjs";
import { verifyLicense } from "./lib/license.mjs";
import { truncateIp, hashInstallId } from "./lib/privacy.mjs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Signature, If-None-Match"
};

function json(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders });
  res.end(text);
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket.remoteAddress;
}

async function loadLicensePublicKey(config) {
  try {
    return JSON.parse(await readFile(config.licensePublicKeyPath, "utf8"));
  } catch {
    return null;
  }
}

async function handleCampaigns(req, res, config) {
  const campaigns = await loadCampaigns();
  const etag = etagFor(campaigns);
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, ...CORS_HEADERS });
    res.end();
    return;
  }
  const body = buildCampaignsResponse(campaigns, config.clickSigningSecret);
  json(res, 200, body, { ETag: etag, "Cache-Control": "public, max-age=60" });
}

async function handleEvents(req, res, config) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    json(res, 400, { ok: false, error: "invalid JSON" });
    return;
  }
  const events = Array.isArray(payload.events) ? payload.events : [];
  if (!events.length) {
    json(res, 400, { ok: false, error: "events[] is required" });
    return;
  }
  const ip = truncateIp(clientIp(req));
  const installIdHash = hashInstallId(payload.installId, config.clickSigningSecret);
  let stored = 0;
  for (const event of events.slice(0, 100)) {
    if (!["impression", "click"].includes(event.type) || !event.id) continue;
    await appendEvent(SERVER_ROOT, {
      ts: Date.now(),
      type: event.type,
      id: String(event.id),
      slot: event.slot ? String(event.slot) : null,
      installIdHash,
      ip
    });
    stored += 1;
  }
  json(res, 202, { ok: true, stored });
}

async function handleClick(req, res, config, id) {
  const url = new URL(req.url, "http://internal");
  const token = url.searchParams.get("t");
  const claims = token ? verifyToken(token, config.clickSigningSecret) : null;
  if (!claims || claims.id !== id) {
    json(res, 400, { ok: false, error: "invalid or expired click token" });
    return;
  }
  const campaigns = await loadCampaigns();
  const creative = findCreative(campaigns, id);
  const destination = claims.url || (creative && creative.url);
  if (!destination) {
    json(res, 404, { ok: false, error: "unknown creative" });
    return;
  }
  await appendEvent(SERVER_ROOT, {
    ts: Date.now(),
    type: "click",
    id,
    slot: claims.slot || null,
    installIdHash: null,
    ip: truncateIp(clientIp(req))
  });
  res.writeHead(302, { Location: destination, ...CORS_HEADERS });
  res.end();
}

async function handlePostback(req, res, config) {
  const raw = await readBody(req);
  const partner = new URL(req.url, "http://internal").searchParams.get("partner") || "example-network";
  const partners = await loadPartners();
  const secret = partners[partner]?.secret;
  if (!secret || !verifyBodySignature(raw, req.headers["x-signature"], secret)) {
    json(res, 401, { ok: false, error: "signature verification failed" });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    json(res, 400, { ok: false, error: "invalid JSON" });
    return;
  }
  if (!payload.subid) {
    json(res, 400, { ok: false, error: "subid is required" });
    return;
  }
  await appendEvent(SERVER_ROOT, {
    ts: Date.now(),
    type: "conversion",
    id: String(payload.subid),
    partner,
    amountCents: Number(payload.amountCents) || 0
  });
  json(res, 200, { ok: true });
}

async function handleLicenseVerify(req, res, config) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    json(res, 400, { ok: false, error: "invalid JSON" });
    return;
  }
  const publicKeyJwk = await loadLicensePublicKey(config);
  if (!publicKeyJwk) {
    json(res, 503, { ok: false, error: "no license public key configured — run monetize/licensing/keygen.mjs" });
    return;
  }
  const result = verifyLicense(payload.license, publicKeyJwk);
  json(res, result.valid ? 200 : 400, { ok: result.valid, ...result });
}

async function handleReport(req, res) {
  const campaigns = await loadCampaigns();
  const sinceDays = Number(new URL(req.url, "http://internal").searchParams.get("days")) || 30;
  const report = await buildReport(SERVER_ROOT, campaigns, { sinceDays });
  json(res, 200, report);
}

export function createApp() {
  const config = env();

  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      const url = new URL(req.url, "http://internal");

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/campaigns") {
        await handleCampaigns(req, res, config);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/events") {
        await handleEvents(req, res, config);
        return;
      }
      const clickMatch = url.pathname.match(/^\/v1\/click\/([^/]+)$/);
      if (req.method === "GET" && clickMatch) {
        await handleClick(req, res, config, decodeURIComponent(clickMatch[1]));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/postback") {
        await handlePostback(req, res, config);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/license/verify") {
        await handleLicenseVerify(req, res, config);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/report") {
        await handleReport(req, res);
        return;
      }

      json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = env();
  createApp().listen(config.port, () => {
    console.log(`[monetize/server] listening on http://localhost:${config.port}`);
  });
}
