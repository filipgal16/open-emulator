// Lightweight update *notifier* — not a silent auto-updater.
//
// Auto-downloading and installing unsigned binaries is unsafe (most OSes
// warn heavily or refuse it outright), and real code-signing certificates
// (Apple Developer ID, a Windows EV/OV cert) aren't set up yet. Until they
// are, this just checks a static JSON feed and tells the user a newer
// version exists, linking out to the download page. See docs/ROADMAP.md.
const fs = require("fs");
const path = require("path");

let electronApp = null;
try {
  electronApp = require("electron").app;
} catch {
  electronApp = null;
}

const CONFIG_FILE = path.join(__dirname, "..", "config", "update.json");

function currentVersion() {
  if (electronApp) return electronApp.getVersion();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { feedUrl: "" };
  }
}

// Minimal semver compare (major.minor.patch, ignores pre-release tags) —
// avoids depending on a transitive `semver` install that may not be hoisted.
function isNewer(candidate, current) {
  const a = String(candidate || "").split(".").map((n) => parseInt(n, 10) || 0);
  const b = String(current || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const ai = a[i] || 0;
    const bi = b[i] || 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

async function checkForUpdate() {
  const current = currentVersion();
  const { feedUrl } = readConfig();
  if (!feedUrl) {
    return { ok: true, checked: false, current, reason: "no feed configured" };
  }
  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`update feed responded ${res.status}`);
    const data = await res.json();
    const latest = data.version || "";
    return {
      ok: true,
      checked: true,
      current,
      latest: latest || current,
      available: latest ? isNewer(latest, current) : false,
      url: data.url || feedUrl
    };
  } catch (err) {
    return { ok: false, checked: true, current, error: err.message };
  }
}

module.exports = { checkForUpdate, currentVersion, isNewer };
