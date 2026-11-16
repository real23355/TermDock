import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { errorText, type SerialProvider } from './session';
import { createController } from './controller';

export function startApp(options: { serial?: SerialProvider; dataDirectory?: string } = {}) {
  app.setName('TermDock');
  if (options.dataDirectory) app.setPath('userData', options.dataDirectory);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let window: BrowserWindow | undefined;
  let quitting = false;
  let controller: ReturnType<typeof createController> | undefined;
  const index = join(__dirname, 'index.html');
  const pageURL = pathToFileURL(index).href;
  const permitted = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === window?.webContents &&
    !!event.senderFrame && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pageURL;

  const handle = (name: string, run: (...args: unknown[]) => unknown) => {
    ipcMain.handle('td:' + name, (event, ...args: unknown[]) => {
      if (!permitted(event)) throw new Error('IPC 来源无效');
      try {
        return run(...args);
      } catch (error) {
        if (error instanceof z.ZodError) throw new Error(error.issues[0]?.message ?? '参数无效');
        throw error;
      }
    });
  };
  const on = (name: string, run: (...args: unknown[]) => void) => {
    ipcMain.on('td:' + name, (event, ...args: unknown[]) => {
      if (permitted(event)) run(...args);
    });
  };

  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (controller?.closeAll() ?? Promise.resolve()).then(() => app.quit());
  });

  void app.whenReady().then(() => {
    controller = createController(app.getPath('userData'), event => {
      if (window && !window.isDestroyed()) window.webContents.send('td:session', event);
    }, options.serial);
    Menu.setApplicationMenu(null);

    for (const [name, run] of Object.entries(controller.requests)) {
      if (name === 'show-logs') {
        handle(name, async (...args) => {
          const error = await shell.openPath(await run(...args) as string);
          if (error) throw new Error(error);
        });
      } else handle(name, run);
    }
    for (const [name, run] of Object.entries(controller.notifications)) on(name, run);
    handle('copy', value => clipboard.writeText(z.string().max(4 * 1024 * 1024).parse(value)));
    handle('paste', async () => (await clipboard.readText()).slice(0, 512 * 1024));
    handle('pick-key', async () => {
      const result = await dialog.showOpenDialog(window!, { title: '选择 SSH 私钥文件', properties: ['openFile'] });
      return result.filePaths[0];
    });
    handle('pick-log-directory', async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: '选择串口日志目录', properties: ['openDirectory', 'createDirectory'],
      });
      return result.filePaths[0];
    });
    handle('pick-transfer-path', async mode => {
      if (mode === 'upload') return (await dialog.showOpenDialog(window!, { title: '选择上传文件', properties: ['openFile'] })).filePaths[0];
      if (mode === 'download') return (await dialog.showSaveDialog(window!, { title: '保存下载文件' })).filePath;
      throw new Error('文件选择操作无效');
    });

    window = new BrowserWindow({
      title: 'TermDock', width: 1360, height: 860, minWidth: 850, minHeight: 540,
      backgroundColor: '#101319', show: false,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#101319', symbolColor: '#bac5d6', height: 40 },
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.once('ready-to-show', () => window?.show());
    window.on('close', event => {
      if (!quitting) { event.preventDefault(); app.quit(); }
    });
    return window.loadFile(index);
  }).catch(error => {
    dialog.showErrorBox('TermDock 启动失败', errorText(error));
    app.quit();
  });
}
