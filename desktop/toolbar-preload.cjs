// Bridge for the tab toolbar (toolbar.html): receive tab state, send commands.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vybeTabs", {
  onState: (fn) => ipcRenderer.on("tabs:state", (_e, state) => fn(state)),
  command: (cmd) => ipcRenderer.send("tabs:command", cmd),
});
