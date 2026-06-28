const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("connectorDesktop", {
  getState: () => ipcRenderer.invoke("connector:getState"),
  getConfig: () => ipcRenderer.invoke("connector:getConfig"),
  saveConfig: (config) => ipcRenderer.invoke("connector:saveConfig", config),
  start: (config) => ipcRenderer.invoke("connector:start", config),
  stop: () => ipcRenderer.invoke("connector:stop"),
  restart: () => ipcRenderer.invoke("connector:restart"),
  startPairing: (input) => ipcRenderer.invoke("connector:startPairing", input),
  cancelPairing: () => ipcRenderer.invoke("connector:cancelPairing"),
  saveSettings: (settings) => ipcRenderer.invoke("connector:saveSettings", settings),
  openConfigFolder: () => ipcRenderer.invoke("connector:openConfigFolder"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("connector:state", listener);
    return () => ipcRenderer.removeListener("connector:state", listener);
  },
  onLog: (callback) => {
    const listener = (_event, log) => callback(log);
    ipcRenderer.on("connector:log", listener);
    return () => ipcRenderer.removeListener("connector:log", listener);
  },
  onPairing: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("connector:pairing", listener);
    return () => ipcRenderer.removeListener("connector:pairing", listener);
  },
});
