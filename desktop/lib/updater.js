// Update *notifier* built on electron-updater's generic-provider feed, but
// deliberately not wired for silent auto-install:
//   - autoDownload is off. Auto-downloading and installing unsigned binaries
//     is unsafe (Windows/macOS refuse or scare-warn on unsigned installers),
//     and real code-signing certificates aren't set up yet — see
//     docs/ROADMAP.md. Once builds are signed, flip autoDownload on.
//   - The feed URL comes from desktop/config/update.json, not a baked-in
//     electron-builder.yml publish target, so update checks stay a no-op
//     until an operator actually deploys web/dist/updates/ and points this
//     at it. No repo clone should phone home to a URL nobody deployed.
const fs = require("fs");
const path = require("path");

let electronApp = null;
let autoUpdater = null;
try {
  electronApp = require("electron").app;
  autoUpdater = require("electron-updater").autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
} catch {
  electronApp = null;
  autoUpdater = null;
}

const CONFIG_FILE = path.join(__dirname, "..", "config", "update.json");
let feedConfigured = false;

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

function ensureFeedConfigured() {
  const { feedUrl } = readConfig();
  if (!feedUrl || !autoUpdater) return false;
  if (!feedConfigured) {
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl, channel: "latest" });
    feedConfigured = true;
  }
  return true;
}

async function checkForUpdate() {
  const current = currentVersion();
  if (!ensureFeedConfigured()) {
    return { ok: true, checked: false, current, reason: "no feed configured" };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result && result.updateInfo;
    const latest = (info && info.version) || current;
    return {
      ok: true,
      checked: true,
      current,
      latest,
      available: Boolean(info) && latest !== current,
      url: (info && info.releaseNotesUrl) || releaseDownloadUrl()
    };
  } catch (err) {
    return { ok: false, checked: true, current, error: err.message };
  }
}

// Not called automatically — exposed for a future "Download update" button.
// Safe on Linux (AppImage self-replaces without OS-level signature checks);
// gated behind signed builds everywhere else, see docs/ROADMAP.md.
async function downloadAndInstall() {
  if (!ensureFeedConfigured() || !autoUpdater) {
    throw new Error("no update feed configured");
  }
  await autoUpdater.downloadUpdate();
  autoUpdater.quitAndInstall();
}

function releaseDownloadUrl() {
  const pkg = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    } catch {
      return {};
    }
  })();
  return pkg.homepage ? `${pkg.homepage}/releases` : null;
}

module.exports = { checkForUpdate, downloadAndInstall, currentVersion };
