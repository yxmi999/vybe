// Bridge for the desktop-only Settings page (src/lib/desktop-bridge.ts types
// it). Exposes a few narrow calls — never Node or ipcRenderer itself.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vybeDesktop", {
  getKeys: () => ipcRenderer.invoke("vybe:getKeys"),
  saveKeys: (values) => ipcRenderer.invoke("vybe:saveKeys", values),
  getInfo: () => ipcRenderer.invoke("vybe:getInfo"),
  openDataDir: () => ipcRenderer.invoke("vybe:openDataDir"),
  openExternal: (url) => ipcRenderer.invoke("vybe:openExternal", url),
});
