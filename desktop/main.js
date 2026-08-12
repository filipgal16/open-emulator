const path = require("path");
const { app, BrowserWindow } = require("electron");
const { registerIpc } = require("./lib/ipc");
const setup = require("./lib/setup");

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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const status = await setup.setupStatus();
    createWindow(status.completed ? "index.html" : "wizard.html");
  }
});
