const path = require("path");
const { app, BrowserWindow } = require("electron");
const { registerIpc } = require("./lib/ipc");
const setup = require("./lib/setup");
const ads = require("./lib/ads");
const mirror = require("./lib/mirror");

// Two app processes would fight over the same adb/emulator console ports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName("open-emulator");
app.setAppUserModelId("com.openemulator.desktop");

let mainWindow = null;

function createWindow(page) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: page === "wizard.html" ? "#F4FBF8" : "#0f4b37",
    title: "open-emulator",
    icon: path.join(__dirname, "public", "brand", "logo", "app-icon.svg"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "public", page));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  registerIpc(() => mainWindow);
  const status = await setup.setupStatus();
  createWindow(status.completed ? "index.html" : "wizard.html");
  // Best-effort — a no-op whenever no ad server is configured (the
  // default). See desktop/lib/ads.js#flushEvents.
  setInterval(() => ads.flushEvents().catch(() => {}), 5 * 60 * 1000);
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// A live mirror session (adb reverse tunnel + on-device scrcpy-server
// process) has no reason to outlive the window watching it, unlike
// emulator instances themselves, which are meant to keep running.
app.on("before-quit", (event) => {
  event.preventDefault();
  mirror
    .stopAllMirrors()
    .catch(() => {})
    .finally(() => app.exit(0));
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const status = await setup.setupStatus();
    createWindow(status.completed ? "index.html" : "wizard.html");
  }
});
