const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oe", {
  invoke(channel, payload) {
    return ipcRenderer.invoke(`oe:${channel}`, payload);
  },
  onSetupLog(handler) {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on("oe:setup-log", wrapped);
    return () => ipcRenderer.removeListener("oe:setup-log", wrapped);
  },
  onMirrorEvent(handler) {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on("oe:mirror-event", wrapped);
    return () => ipcRenderer.removeListener("oe:mirror-event", wrapped);
  }
});
