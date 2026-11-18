import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SshProfile } from '../shared';

function endpoint(config: SshProfile) {
  return createHash('sha256').update(JSON.stringify([config.host.toLowerCase(), config.port, config.username])).digest('hex');
}
type Target = SshProfile | 'ai';
const secretKey = (target: Target) => typeof target === 'string'
  ? createHash('sha256').update('TermDock.AI.ApiKey.v1').digest('hex') : endpoint(target);

function dpapi(mode: 'protect' | 'unprotect', key: string, input: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(join(__dirname, 'termdock-pty.exe'), ['--' + mode, key], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    const fail = () => reject(new Error('Windows 无法解密或保护凭据，请使用保存时的 Windows 用户，或重新保存凭据'));
    const timeout = setTimeout(() => { child.kill(); fail(); }, 15000);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve(Buffer.concat(chunks)) : fail(); });
    child.stdin.end(input);
  }).finally(() => { input.fill(0); });
}

export class Credentials {
  private readonly directory: string;
  constructor(directory: string) { this.directory = join(directory, 'credentials'); }
  private operations = new Set<Promise<unknown>>();
  private queues = new Map<string, Promise<void>>();
  private path(config: Target) { return join(this.directory, secretKey(config) + '.dpapi'); }
  async has(config: Target) {
    await this.queues.get(secretKey(config))?.catch(() => {});
    try { await access(this.path(config)); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error('无法读取 Windows 凭据存储，请检查数据目录访问权限');
    }
  }
  async get(config: Target) {
    if (!await this.has(config)) throw new Error(config === 'ai' ? '请先在设置 → AI 保存 API Key' : '此主机、端口和用户名没有已保存密码');
    let encrypted: Buffer;
    try { encrypted = await readFile(this.path(config)); }
    catch { throw new Error('无法读取 Windows 凭据存储，请检查数据目录访问权限'); }
    const bytes = await dpapi('unprotect', secretKey(config), encrypted);
    try { return bytes.toString('utf8'); }
    finally { bytes.fill(0); }
  }
  async status(config: Target) {
    if (!await this.has(config)) return false;
    await this.get(config); // A file alone is not proof that the current user can recover it.
    return true;
  }
  save(config: Target, password: string) {
    return this.change(config, () => this.saveSecret(config, password));
  }
  private change(config: Target, run: () => Promise<void>) {
    const key = secretKey(config);
    const operation = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(key, operation);
    this.operations.add(operation);
    void operation.finally(() => {
      this.operations.delete(operation);
      if (this.queues.get(key) === operation) this.queues.delete(key);
    }).catch(() => {});
    return operation;
  }
  private async saveSecret(config: Target, password: string) {
    const bytes = await dpapi('protect', secretKey(config), Buffer.from(password));
    const path = this.path(config);
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(temporary, bytes, { flag: 'wx', flush: true });
      // Verify the on-disk bytes before replacing a previously usable credential.
      const recovered = await dpapi('unprotect', secretKey(config), await readFile(temporary));
      try { if (recovered.toString('utf8') !== password) throw new Error('凭据验证失败'); }
      finally { recovered.fill(0); }
      await rename(temporary, path);
    } catch { throw new Error('Windows 凭据保存失败，请检查数据目录是否可写及当前 Windows 用户权限'); }
    finally { bytes.fill(0); await rm(temporary, { force: true }).catch(() => {}); }
  }
  clear(config: Target) {
    return this.change(config, async () => {
      try { await rm(this.path(config), { force: true }); }
      catch { throw new Error('无法清除 Windows 凭据，请检查数据目录访问权限'); }
    });
  }
  async settled() { await Promise.allSettled(this.operations); }
}
