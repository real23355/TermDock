import type { DesktopApi } from '../shared';

export function createSftpBrowser(api: DesktopApi, dialog: HTMLDialogElement) {
  const form = dialog.querySelector<HTMLFormElement>('#sftp-path-form')!;
  const input = dialog.querySelector<HTMLInputElement>('#sftp-path')!;
  const list = dialog.querySelector<HTMLDivElement>('#sftp-entries')!;
  const status = dialog.querySelector('#sftp-status')!;
  let session: string;
  let location = '.';
  let busy = false;

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    status.textContent = '处理中…';
    try { await action(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; dialog.removeAttribute('aria-busy'); }
  }

  function child(name: string) { return location.replace(/\/+$/, '') + '/' + name; }

  async function transfer(mode: 'upload' | 'download', remote: string) {
    const local = await api.pickTransferPath(mode);
    if (!local) { status.textContent = ''; return; }
    await api.sftpTransfer(session, mode, remote, local);
    if (mode === 'upload') await refresh(location);
    status.textContent = mode === 'upload' ? '上传完成' : '下载完成';
  }

  async function refresh(path: string) {
    const result = await api.sftpList(session, path);
    location = input.value = result.path;
    const ordered = result.entries.sort((a, b) =>
      Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
    list.replaceChildren(...ordered.map(entry => {
      const row = document.createElement('div');
      row.className = 'sftp-entry';
      const label = document.createElement('span');
      label.textContent = entry.name + (entry.kind === 'directory' ? '/' : '');
      row.append(label);
      if (entry.kind === 'directory' || entry.kind === 'file') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.kind === 'directory' ? '打开' : '下载';
        button.onclick = () => { void run(() => entry.kind === 'directory'
          ? refresh(child(entry.name)) : transfer('download', child(entry.name))); };
        row.append(button);
      }
      return row;
    }));
    status.textContent = ordered.length ? '' : '目录为空';
  }

  form.onsubmit = event => { event.preventDefault(); void run(() => refresh(input.value)); };
  dialog.querySelector<HTMLButtonElement>('#sftp-parent')!.onclick = () => { void run(() => refresh(child('..'))); };
  dialog.querySelector<HTMLButtonElement>('#sftp-upload')!.onclick = () => { void run(() => transfer('upload', location)); };
  return (id: string) => {
    if (busy || dialog.open) return;
    session = id;
    location = input.value = '.';
    list.replaceChildren();
    dialog.showModal();
    void run(() => refresh('.'));
  };
}
