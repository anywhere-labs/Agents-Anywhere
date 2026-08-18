import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopWorkbench", {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  openExternal: (url: string) => ipcRenderer.invoke("workbench:openExternal", url),
});

