const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oe", {
  invoke(channel, payload) {
    return ipcRenderer.invoke(`oe:${channel}`, payload);
  }
});
