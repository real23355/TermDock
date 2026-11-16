import { open, unlink } from 'node:fs/promises';
import { basename, isAbsolute, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { SFTPWrapper } from 'ssh2';
import type { RemoteEntry } from '../shared';

export async function listRemote(sftp: SFTPWrapper, location: string) {
  const path = await promisify(sftp.realpath.bind(sftp))(location);
  const list = await promisify(sftp.readdir.bind(sftp))(path);
  const entries: RemoteEntry[] = [];
  for (const { filename: name, attrs } of list) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) continue;
    const kind = attrs.isDirectory() ? 'directory' : attrs.isFile() ? 'file' : attrs.isSymbolicLink() ? 'link' : 'other';
    entries.push({ name, kind, size: attrs.size });
  }
  return { path, entries };
}

export async function transferFile(sftp: SFTPWrapper, mode: 'upload' | 'download', remote: string, local: string) {
  if (!isAbsolute(local)) throw new Error('请选择本机文件的绝对路径');
  if (mode === 'download') {
    const stat = await promisify(sftp.stat.bind(sftp))(remote);
    if (!stat.isFile()) throw new Error('SFTP 下载只支持文件');
    const result = await open(local, 'wx');
    try {
      await pipeline(sftp.createReadStream(remote), result.createWriteStream());
    } catch (error) {
      await result.close().catch(() => {});
      await unlink(local).catch(() => {});
      throw error;
    }
    return;
  }

  const source = await open(local, 'r');
  const destination = posix.join(remote, basename(local));
  try {
    if (!(await source.stat()).isFile()) throw new Error('请选择有效的本机文件');
    const handle = await promisify(sftp.open.bind(sftp))(destination, 'wx');
    try {
      await pipeline(source.createReadStream(), sftp.createWriteStream(destination, { handle, autoClose: false }));
      await promisify(sftp.close.bind(sftp))(handle);
    } catch (error) {
      await promisify(sftp.close.bind(sftp))(handle).catch(() => {});
      await promisify(sftp.unlink.bind(sftp))(destination).catch(() => {});
      throw error;
    }
  } finally { await source.close(); }
}
