import { contextBridge, ipcRenderer } from "electron";
import type { ControlSetupApi, WindowApi, WindowState } from "./types.js";

const api: ControlSetupApi = {
  state: () => ipcRenderer.invoke("control-setup:state"),
  connect: (url) => ipcRenderer.invoke("control-setup:connect", url),
};
contextBridge.exposeInMainWorld("controlSetup", api);

const windowApi: WindowApi = {
  state: () => ipcRenderer.invoke("relaydesk:window:state"),
  subscribe(callback) {
    const listener = (_event: unknown, state: WindowState) => callback(state);
    ipcRenderer.on("relaydesk:window:state", listener);
    return () => ipcRenderer.removeListener("relaydesk:window:state", listener);
  },
  minimize: () => ipcRenderer.invoke("relaydesk:window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("relaydesk:window:toggleMaximize"),
  close: () => ipcRenderer.invoke("relaydesk:window:close"),
  menu: () => ipcRenderer.invoke("relaydesk:window:menu"),
};
contextBridge.exposeInMainWorld("relayDesk", windowApi);
