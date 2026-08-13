// Resolves filesystem locations for both dev (running from the repo with
// `npm start`) and packaged (installed AppImage/deb/nsis/dmg) contexts.
//
// Split in two halves:
//   - "code" roots (android/, brand/) — read-only, ship inside the app
//     package as extraResources next to the executable.
//   - "data" roots (SDK download, AVDs, logs, desktop state) — must live in
//     a writable, update-safe location. In dev that's still the repo tree
//     (so `make android-*` and this checkout keep working unchanged). When
//     packaged it's Electron's per-OS userData directory, because the
//     install directory itself is frequently read-only (e.g. /opt, or a
//     read-only AppImage mount).
const os = require("os");
const path = require("path");

let electronApp = null;
try {
  // Only present when required from Electron's main process.
  electronApp = require("electron").app;
} catch {
  electronApp = null;
}

const DESKTOP_ROOT = path.resolve(__dirname, "..");
const DEV_REPO_ROOT = path.resolve(DESKTOP_ROOT, "..");

function isPackaged() {
  return Boolean(electronApp && electronApp.isPackaged);
}

// Where extraResources (android/, brand/) land: process.resourcesPath when
// packaged, the repo root when running from source.
function resourcesRoot() {
  if (isPackaged()) return process.resourcesPath;
  return DEV_REPO_ROOT;
}

function androidCodeRoot() {
  return path.join(resourcesRoot(), "android");
}

function brandRoot() {
  return path.join(resourcesRoot(), "brand");
}

// Per-OS writable app-data directory (~/.config/open-emulator on Linux,
// ~/Library/Application Support/open-emulator on macOS, %APPDATA% on
// Windows). Falls back to a plain XDG-style path if Electron isn't ready
// yet (e.g. called from a script before app.whenReady()).
function userDataRoot() {
  if (electronApp) return electronApp.getPath("userData");
  return path.join(os.homedir(), ".local", "share", "open-emulator");
}

// Mutable Android runtime data: SDK download, AVD disks, per-instance
// state, logs. Dev keeps everything colocated with the code (today's
// behavior); packaged installs relocate it to userData so a 4+ GiB SDK
// download never lands inside a read-only install path.
function androidDataRoot() {
  if (isPackaged()) return path.join(userDataRoot(), "android");
  return androidCodeRoot();
}

function desktopDataRoot() {
  if (isPackaged()) return path.join(userDataRoot(), "desktop-data");
  return path.join(DESKTOP_ROOT, "data");
}

function desktopUploadsRoot() {
  if (isPackaged()) return path.join(userDataRoot(), "uploads");
  return path.join(DESKTOP_ROOT, "uploads");
}

function openEmuBin() {
  return path.join(androidCodeRoot(), "bin", "open-emu");
}

// Env overrides forwarded to every open-emu / fetch_android.sh / setup_avd.sh
// child process. common.sh already reads ANDROID_SDK_ROOT / ANDROID_AVD_HOME
// / ANDROID_LOG_DIR; ANDROID_APPS_DIR / ANDROID_STATE_DIR are the two this
// product adds so the whole data tree can move as one unit.
function androidEnvOverrides() {
  if (!isPackaged()) return {};
  const root = androidDataRoot();
  return {
    ANDROID_SDK_ROOT: path.join(root, "sdk"),
    ANDROID_AVD_HOME: path.join(root, "avd"),
    ANDROID_LOG_DIR: path.join(root, "logs"),
    ANDROID_APPS_DIR: path.join(root, "apps"),
    ANDROID_STATE_DIR: path.join(root, "state")
  };
}

// The stable, on-disk path to the running app, for writing desktop shortcuts.
// AppImages re-exec themselves from a temporary FUSE mount whose path changes
// every launch — the AppImage runtime sets $APPIMAGE to the real, stable
// path of the .AppImage file itself, which is what a shortcut must point at.
function launcherExec(devLauncherPath) {
  if (process.env.APPIMAGE) return process.env.APPIMAGE;
  if (isPackaged()) return process.execPath;
  return devLauncherPath;
}

module.exports = {
  DESKTOP_ROOT,
  DEV_REPO_ROOT,
  isPackaged,
  resourcesRoot,
  androidCodeRoot,
  brandRoot,
  userDataRoot,
  androidDataRoot,
  desktopDataRoot,
  desktopUploadsRoot,
  openEmuBin,
  androidEnvOverrides,
  launcherExec
};
