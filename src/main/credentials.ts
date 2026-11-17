import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SshProfile } from '../shared';

function endpoint(config: SshProfile) {
  return createHash('sha256').update(JSON.stringify([config.host.toLowerCase(), config.port, config.username])).digest('hex');
}

function dpapi(mode: 'protect' | 'unprotect', key: string, input: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(join(__dirname, 'termdock-pty.exe'), ['--' + mode, key], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    const fail = () => reject(new Error('Windows 无法处理此 SSH 凭据，请重新输入密码'));
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : fail());
    child.stdin.end(input);
  }).finally(() => { input.fill(0); });
}

export class Credentials {
  private readonly directory: string;
  constructor(directory: string) { this.directory = join(directory, 'credentials'); }
  private path(config: SshProfile) { return join(this.directory, endpoint(config) + '.dpapi'); }
  async has(config: SshProfile) {
    try { await access(this.path(config)); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  async get(config: SshProfile) {
    if (!await this.has(config)) throw new Error('此主机、端口和用户名没有已保存密码');
    const bytes = await dpapi('unprotect', endpoint(config), await readFile(this.path(config)));
    try { return bytes.toString('utf8'); }
    finally { bytes.fill(0); }
  }
  async save(config: SshProfile, password: string) {
    const bytes = await dpapi('protect', endpoint(config), Buffer.from(password));
    await mkdir(this.directory, { recursive: true });
    const path = this.path(config);
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, bytes, { flag: 'wx', flush: true });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  async clear(config: SshProfile) { await rm(this.path(config), { force: true }); }
}
