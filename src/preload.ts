import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { desktopBridge } from './desktop-bridge';
import type { SessionEvent } from './shared';

// Resolve File in the isolated world; contextBridge cannot clone DOM File objects.
let latestDrop: string[] = [];
window.addEventListener('drop', event => {
  latestDrop = Array.from(event.dataTransfer?.files ?? [], file => webUtils.getPathForFile(file));
  setTimeout(() => { latestDrop = []; }, 0);
}, true);
const api = desktopBridge(
  (name, ...args) => ipcRenderer.invoke('td:' + name, ...args),
  (name, ...args) => ipcRenderer.send('td:' + name, ...args),
  callback => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SessionEvent) => callback(payload);
    ipcRenderer.on('td:session', listener);
    return () => ipcRenderer.removeListener('td:session', listener);
  },
  async () => latestDrop,
);
contextBridge.exposeInMainWorld('termDock', api);
