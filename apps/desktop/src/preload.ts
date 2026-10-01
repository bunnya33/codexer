import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, ViewState, WindowState } from './types.js';
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke('codexer:' + name, ...args);
const api: DesktopApi = {
  state: () => invoke('state'),
  subscribe(callback) { const listener = (_event: unknown, state: ViewState) => callback(state); ipcRenderer.on('codexer:state', listener); return () => ipcRenderer.removeListener('codexer:state', listener); },
  login: (username, password) => invoke('login', username, password), logout: () => invoke('logout'), connect: () => invoke('connect'), disconnect: () => invoke('disconnect'), reconnect: () => invoke('reconnect'), save: settings => invoke('save', settings), pick: kind => invoke('pick', kind), exportLogs: () => invoke('exportLogs'), openControl: () => invoke('openControl'),
  window: {
    state: () => invoke('window:state'),
    subscribe(callback) { const listener = (_event: unknown, state: WindowState) => callback(state); ipcRenderer.on('codexer:window:state', listener); return () => ipcRenderer.removeListener('codexer:window:state', listener); },
    minimize: () => invoke('window:minimize'), toggleMaximize: () => invoke('window:toggleMaximize'), close: () => invoke('window:close'),
  },
};
contextBridge.exposeInMainWorld('codexer', api);
