const http = require("http");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");

const PORT = Number(process.env.OPEN_EMULATOR_DESKTOP_PORT || 8787);
const URL = `http://127.0.0.1:${PORT}`;
let serverProcess = null;

function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(`${URL}/api/status`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`desktop server did not respond at ${URL}`));
          return;
        }
        setTimeout(probe, 300);
      });
      req.setTimeout(1000, () => {
        req.destroy();
      });
    };
    probe();
  });
}

function ensureServer() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/status`, (res) => {
      res.resume();
      resolve();
    });
    req.on("error", () => {
      serverProcess = spawn(process.execPath, [path.join(__dirname, "server.js")], {
        cwd: __dirname,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "inherit"
      });
      resolve(waitForServer());
    });
    req.setTimeout(1000, () => req.destroy());
  });
}

async function createWindow() {
  await ensureServer();
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#080d10",
    title: "open-emulator",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await win.loadURL(URL);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
  }
});
