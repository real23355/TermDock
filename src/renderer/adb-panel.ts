import type { Bridge } from '../desktop-bridge';

export function bindAdbPanel(api: Bridge, message: (error: unknown) => string) {
  const settings = document.querySelector<HTMLFormElement>('#adb-settings-form')!;
  const directory = settings.querySelector<HTMLInputElement>('#adb-directory')!;
  const status = settings.querySelector('#adb-status')!;
  const buttons = settings.querySelectorAll<HTMLButtonElement>('button');
  let busy = false;

  function showDirectory(path: string) {
    directory.value = directory.title = path;
  }

  async function settingsTask(task: () => Promise<void>, progress = '') {
    if (busy) return;
    busy = true;
    for (const button of buttons) button.disabled = true;
    status.textContent = progress;
    try { await task(); }
    catch (error) { status.textContent = message(error); }
    finally {
      busy = false;
      for (const button of buttons) button.disabled = false;
    }
  }

  settings.querySelector<HTMLButtonElement>('#adb-pick-tools')!.onclick = () => {
    void settingsTask(async () => {
      const path = await api.pickAdbDirectory('tools');
      if (path) {
        showDirectory(path);
        status.textContent = '点击保存以应用新目录。';
      }
    });
  };
  settings.onsubmit = event => {
    event.preventDefault();
    void settingsTask(async () => {
      const saved = await api.adbSettings();
      const updated = await api.saveAdbSettings({ ...saved, directory: directory.value });
      showDirectory(updated.directory);
      status.textContent = 'ADB 设置已保存。新开的 PowerShell 会使用该工具路径。';
    }, '正在安装 ADB 并保存设置…');
  };

  return () => settingsTask(async () => showDirectory((await api.adbSettings()).directory));
}
