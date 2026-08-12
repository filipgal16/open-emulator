const { ipcMain, dialog } = require("electron");
const openemu = require("./openemu");

function registerIpc() {
  ipcMain.handle("oe:status", () => openemu.status());
  ipcMain.handle("oe:start", (_event, options) => openemu.start(options || {}));
  ipcMain.handle("oe:stop", () => openemu.stop());
  ipcMain.handle("oe:install", (_event, apkPath) => openemu.install(apkPath));
  ipcMain.handle("oe:pick-apk", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Android package", extensions: ["apk"] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("oe:screenshot", async () => {
    try {
      const buf = await openemu.screenshot();
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
  ipcMain.handle("oe:keymap-fire", (_event, key) => openemu.fireKey(key));
  ipcMain.handle("oe:instances", () => openemu.instances());
  ipcMain.handle("oe:instance-create", (_event, input) => openemu.createInstance(input));
  ipcMain.handle("oe:instance-start", (_event, name) => openemu.startInstance(name));
  ipcMain.handle("oe:instance-stop", (_event, name) => openemu.stopInstance(name));
  ipcMain.handle("oe:instance-clone", (_event, { name, target }) => openemu.cloneInstance(name, target));
  ipcMain.handle("oe:macros", () => openemu.macros());
  ipcMain.handle("oe:macro-run", (_event, { name, loop }) => openemu.runMacro(name, loop));
  ipcMain.handle("oe:performance-get", () => openemu.performance());
  ipcMain.handle("oe:performance-set", (_event, value) => openemu.performance(value));
  ipcMain.handle("oe:files-push", (_event, body) => openemu.sharePush(body.local, body.remote));
  ipcMain.handle("oe:files-pull", (_event, body) => openemu.sharePull(body.remote, body.local));
  ipcMain.handle("oe:gps", (_event, body) => openemu.gps(body.lat, body.lng));
  ipcMain.handle("oe:display", (_event, body) => openemu.display(body || {}));
  ipcMain.handle("oe:audio", (_event, body) => openemu.audio(body || {}));
  ipcMain.handle("oe:network", (_event, body) => openemu.network(body || {}));
}

module.exports = { registerIpc };
