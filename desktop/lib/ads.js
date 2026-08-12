const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_CONFIG = path.join(REPO_ROOT, "android", "config", "ads.json");
const STATE_CONFIG = path.join(REPO_ROOT, "android", "state", "ads.json");
const DISMISS_FILE = path.join(REPO_ROOT, "android", "state", "ads_dismissed_until");
const LOG_FILE = path.join(__dirname, "..", "data", "ads.log");

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const base = readJsonSync(DEFAULT_CONFIG, { enabled: true, campaigns: [] });
  const state = readJsonSync(STATE_CONFIG, {});
  if (process.env.ANDROID_ADS === "0") {
    return { ...base, enabled: false };
  }
  if (typeof state.enabled === "boolean") {
    return { ...base, enabled: state.enabled };
  }
  return base;
}

function isDismissed() {
  try {
    const until = Number(fs.readFileSync(DISMISS_FILE, "utf8"));
    return until > Date.now();
  } catch {
    return false;
  }
}

function pickCampaign(config) {
  const campaigns = Array.isArray(config.campaigns) ? config.campaigns : [];
  if (!campaigns.length) {
    return {
      id: "house",
      title: "open-emulator",
      cta: "Map keys to on-screen taps",
      url: "#keymap",
      image: ""
    };
  }
  const total = campaigns.reduce((sum, c) => sum + (Number(c.weight) || 1), 0);
  let roll = Math.random() * total;
  for (const c of campaigns) {
    roll -= Number(c.weight) || 1;
    if (roll <= 0) return c;
  }
  return campaigns[0];
}

async function appendLog(line) {
  await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
  await fsp.appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
}

async function current() {
  const config = loadConfig();
  if (!config.enabled || isDismissed()) {
    return { enabled: false, campaign: null, height_px: config.height_px || 72 };
  }
  return {
    enabled: true,
    height_px: config.height_px || 72,
    rotate_s: config.rotate_s || 30,
    campaign: pickCampaign(config)
  };
}

async function settings(body) {
  if (body === undefined || body === null) {
    return loadConfig();
  }
  await fsp.mkdir(path.dirname(STATE_CONFIG), { recursive: true });
  const existing = readJsonSync(STATE_CONFIG, {});
  const next = { ...existing };
  if (typeof body.enabled === "boolean") {
    next.enabled = body.enabled;
  }
  await fsp.writeFile(STATE_CONFIG, `${JSON.stringify(next, null, 2)}\n`);
  return { ...loadConfig(), ...next };
}

async function dismiss(hours) {
  const config = loadConfig();
  const h = Number(hours) || config.dismiss_hours || 24;
  const until = Date.now() + h * 3600 * 1000;
  await fsp.mkdir(path.dirname(DISMISS_FILE), { recursive: true });
  await fsp.writeFile(DISMISS_FILE, String(until));
  return { dismissed_until: until };
}

module.exports = {
  current,
  settings,
  dismiss,
  impression: (id) => appendLog(`impression id=${id}`),
  click: (id) => appendLog(`click id=${id}`)
};
