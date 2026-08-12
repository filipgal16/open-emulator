const { ipcMain, dialog } = require("electron");
const openemu = require("./openemu");
const setup = require("./setup");
const { installShortcut } = require("./shortcut");

function registerIpc(getWindow) {
  ipcMain.handle("oe:status", (_event, name) => openemu.status(name));
  ipcMain.handle("oe:start", (_event, options) => openemu.start(options || {}));
  ipcMain.handle("oe:stop", (_event, name) => openemu.stop(name));
  ipcMain.handle("oe:install", (_event, { path: apkPath, instance }) => openemu.install(apkPath, instance));
  ipcMain.handle("oe:pick-apk", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Android package", extensions: ["apk"] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("oe:screenshot", async (_event, name) => {
    try {
      const buf = await openemu.screenshot(name);
      return { ok: true, dataUrl: `data:image/png;base64,${buf.toString("base64")}` };
    } catch (err) {
      return {
        ok: false,
        dataUrl: `data:image/png;base64,${openemu.PLACEHOLDER_PNG.toString("base64")}`,
        error: err.message
      };
    }
  });
  ipcMain.handle("oe:keymap-get", () => openemu.keymap());
  ipcMain.handle("oe:keymap-save", (_event, value) => openemu.saveKeymap(value));
  ipcMain.handle("oe:keymap-fire", (_event, { key, instance }) => openemu.fireKey(key, instance));
  ipcMain.handle("oe:instances", () => openemu.instances());
  ipcMain.handle("oe:instance-create", (_event, input) => openemu.createInstance(input));
  ipcMain.handle("oe:instance-start", (_event, name) => openemu.startInstance(name));
  ipcMain.handle("oe:instance-stop", (_event, name) => openemu.stopInstance(name));
  ipcMain.handle("oe:instance-clone", (_event, { name, target }) => openemu.cloneInstance(name, target));
  ipcMain.handle("oe:instance-delete", (_event, name) => openemu.deleteInstance(name));
  ipcMain.handle("oe:macros", () => openemu.macros());
  ipcMain.handle("oe:macro-run", (_event, { name, loop }) => openemu.runMacro(name, loop));
  ipcMain.handle("oe:performance-get", () => openemu.performance());
  ipcMain.handle("oe:performance-set", (_event, value) => openemu.performance(value));
  ipcMain.handle("oe:files-push", (_event, body) => openemu.sharePush(body.local, body.remote, body.instance));
  ipcMain.handle("oe:files-pull", (_event, body) => openemu.sharePull(body.remote, body.local, body.instance));
  ipcMain.handle("oe:gps", (_event, body) => openemu.gps(body.lat, body.lng, body.instance));
  ipcMain.handle("oe:display", (_event, body) => openemu.display(body || {}));
  ipcMain.handle("oe:audio", (_event, body) => openemu.audio(body || {}));
  ipcMain.handle("oe:network", (_event, body) => openemu.network(body || {}));
  ipcMain.handle("oe:setup-status", () => setup.setupStatus());
  ipcMain.handle("oe:setup-run", async (event, step) => {
    const send = (line) => event.sender.send("oe:setup-log", { step, line });
    return setup.runStep(step, send);
  });
  ipcMain.handle("oe:setup-complete", (_event, options) => setup.complete(options || {}));
  ipcMain.handle("oe:shortcut-install", (_event, options) => installShortcut(options || {}));
  ipcMain.handle("oe:open-shell", () => {
    const win = getWindow && getWindow();
    if (win) win.loadFile(require("path").join(__dirname, "..", "public", "index.html"));
    return { ok: true };
  });
}

module.exports = { registerIpc };
