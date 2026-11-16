import { contextBridge, ipcRenderer } from 'electron';
import { desktopBridge } from './desktop-bridge';
import type { SessionEvent } from './shared';

const api = desktopBridge(
  (name, ...args) => ipcRenderer.invoke('td:' + name, ...args),
  (name, ...args) => ipcRenderer.send('td:' + name, ...args),
  callback => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionEvent) => callback(payload);
    ipcRenderer.on('td:session', listener);
    return () => ipcRenderer.removeListener('td:session', listener);
  },
);
contextBridge.exposeInMainWorld('termDock', api);
