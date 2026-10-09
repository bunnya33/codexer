import { BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { trustedSetupRequest } from "./policy.js";
import type { WindowState } from "./types.js";

export const TITLEBAR_HEIGHT = 46;
const owners = new Map<
  Electron.WebContents,
  { window: BrowserWindow; url: string; menu(): void }
>();

function state(window: BrowserWindow): WindowState {
  return {
    maximized: window.isMaximized() || window.isFullScreen(),
    focused: window.isFocused(),
  };
}

/** Only the exact local main frame owns window controls; the server view has no native bridge. */
function owner(event: IpcMainInvokeEvent) {
  const entry = owners.get(event.sender);
  if (
    !entry ||
    entry.window.isDestroyed() ||
    !trustedSetupRequest(event, {
      sender: entry.window.webContents,
      frame: entry.window.webContents.mainFrame,
      url: entry.url,
    })
  )
    throw new Error("untrusted-sender");
  return entry;
}

export function toggleMaximize(window: BrowserWindow): void {
  if (window.isFullScreen()) window.setFullScreen(false);
  else if (window.isMaximized()) window.unmaximize();
  else window.maximize();
}

export function registerChromeIpc(): void {
  ipcMain.handle("relaydesk:window:state", (event) => state(owner(event).window));
  ipcMain.handle("relaydesk:window:minimize", (event) => owner(event).window.minimize());
  ipcMain.handle("relaydesk:window:toggleMaximize", (event) => toggleMaximize(owner(event).window));
  ipcMain.handle("relaydesk:window:close", (event) => owner(event).window.close());
  ipcMain.handle("relaydesk:window:menu", (event) => owner(event).menu());
}

export function attachChrome(window: BrowserWindow, url: string, menu: () => void): void {
  owners.set(window.webContents, { window, url, menu });
  const publish = () => {
    if (!window.isDestroyed()) window.webContents.send("relaydesk:window:state", state(window));
  };
  window.on("maximize", publish);
  window.on("unmaximize", publish);
  window.on("focus", publish);
  window.on("blur", publish);
  window.on("enter-full-screen", publish);
  window.on("leave-full-screen", publish);
  window.webContents.on("did-finish-load", publish);
  window.on("closed", () => owners.delete(window.webContents));
}
