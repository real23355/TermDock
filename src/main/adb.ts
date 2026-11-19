import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { z } from 'zod';
import { adbDirectorySchema, adbPreferencesSchema, type AdbDevice, type AdbSettings } from '../shared';
import type { Store } from './store';

const binaries = {
  'adb.exe': 'f1f654df0a74b171da34750b4ff34f15a49b75d45aed54123b72998aef619968',
  'AdbWinApi.dll': 'd60103a5e99bc9888f786ee916f5d6e45493c3247972cb053833803de7e95cf9',
  'AdbWinUsbApi.dll': '25207c506d29c4e8dceb61b4bd50e8669ba26012988a43fbf26a890b1e60fc97',
};
const argument = z.string().min(1).max(4096).refine(value => !value.startsWith('-') && !/[\x00-\x1f\x7f]/.test(value), 'ADB 参数无效');
const pullSchema = z.object({ serial: argument.max(256), remote: argument, directory: adbDirectorySchema });

type PathValue = { Raw: string | null; Kind: 'String' | 'ExpandString' };
type WindowsPath = { value: PathValue; effectivePath: string };
type CommandResult = { stdout: string; stderr: string };
export type AdbPlatform = {
  sourceDirectory?: string;
  readUserPath?: () => Promise<WindowsPath>;
  writeUserPath?: (before: PathValue, after: PathValue) => Promise<void>;
  command?: (file: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv) => Promise<CommandResult>;
};

function command(file: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv, input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
      if (!error) { resolve({ stdout, stderr }); return; }
      const detail = error.killed ? '操作超时' : (stderr.trim() || stdout.trim() || error.message).slice(0, 3000);
      reject(new Error(detail));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

const helper = join(__dirname, 'termdock-pty.exe');
async function readUserPath(): Promise<WindowsPath> {
  return JSON.parse((await command(helper, ['--adb-user-path', 'read'], 10000)).stdout);
}
async function writeUserPath(before: PathValue, after: PathValue) {
  await command(helper, ['--adb-user-path', 'write'], 10000, undefined, JSON.stringify({ Before: before, After: after }));
}

function normalized(path: string) { return win32.normalize(path.trim().replace(/^"|"$/g, '')).replace(/[\\/]+$/, '').toLowerCase(); }
function editPath(value: PathValue, oldOwned: string | undefined, directory: string | undefined) {
  const entries = value.Raw?.split(';') ?? [];
  const oldIndex = oldOwned ? entries.findLastIndex(entry => normalized(entry) === normalized(oldOwned)) : -1;
  if (oldIndex !== -1 && directory && normalized(oldOwned!) === normalized(directory)) return { value, ownedPath: oldOwned };
  let ownedPath: string | undefined;
  if (oldIndex !== -1) entries.splice(oldIndex, 1);
  if (directory && !entries.some(entry => normalized(entry) === normalized(directory))) {
    entries.splice(oldIndex === -1 ? entries.length : oldIndex, 0, directory);
    ownedPath = directory;
  }
  const raw = entries.join(';');
  if (raw.length > 32767) throw new Error('用户 PATH 太长，无法添加 ADB 工具目录');
  return { value: { ...value, Raw: raw || null }, ownedPath };
}

export function prependPath(env: NodeJS.ProcessEnv, directory: string) {
  const result = { ...env };
  const key = Object.keys(result).find(name => name.toUpperCase() === 'PATH') ?? 'Path';
  const original = result[key];
  result[key] = original ? `${directory};${original}` : directory;
  return result;
}

export class AdbTools {
  private readonly defaultDirectory: string;
  private readonly defaultPull: string;
  private readonly source: string;
  private readonly readPath: () => Promise<WindowsPath>;
  private readonly writePath: (before: PathValue, after: PathValue) => Promise<void>;
  private readonly run: (file: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv) => Promise<CommandResult>;
  private pending = Promise.resolve();
  private installed = new Set<string>();

  constructor(private store: Store, dataDirectory: string, platform: AdbPlatform = {}) {
    const local = process.env.TERMDOCK_DATA_DIR || process.env.TERMDOCK_TEST_DATA ? dataDirectory
      : join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'TermDock');
    this.defaultDirectory = join(local, 'tools', 'adb');
    this.defaultPull = join(homedir(), 'Downloads');
    this.source = platform.sourceDirectory ?? join(__dirname, 'adb');
    this.readPath = platform.readUserPath ?? readUserPath;
    this.writePath = platform.writeUserPath ?? writeUserPath;
    this.run = platform.command ?? command;
  }

  private get config(): AdbSettings {
    return { directory: this.store.adb.directory ?? this.defaultDirectory,
      pullDirectory: this.store.adb.pullDirectory ?? this.defaultPull, systemPath: this.store.adb.systemPath };
  }

  async settings(): Promise<AdbSettings> { return this.config; }

  private queue<T>(operation: () => Promise<T>) {
    const result = this.pending.then(operation);
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  private async install(directory: string) {
    const key = normalized(directory);
    if (this.installed.has(key)) {
      const present = await Promise.all(Object.keys(binaries).map(name => stat(join(directory, name)).then(file => file.isFile(), () => false)));
      if (present.every(Boolean)) return;
      this.installed.delete(key);
    }
    const created: string[] = [];
    try {
      await mkdir(directory, { recursive: true });
      for (const [name, hash] of Object.entries(binaries)) {
        const destination = join(directory, name);
        const existing = await readFile(destination).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        });
        if (existing) {
          if (createHash('sha256').update(existing).digest('hex') !== hash) throw new Error(`${name} 与内置版本不同，请选择其他目录`);
          continue;
        }
        const source = join(this.source, name);
        if (createHash('sha256').update(await readFile(source)).digest('hex') !== hash) throw new Error(`内置 ${name} 校验失败`);
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        created.push(destination);
      }
      this.installed.add(key);
    } catch (error) {
      await Promise.allSettled(created.map(file => rm(file, { force: true })));
      throw new Error(`无法安装 ADB 到 ${directory} · ${(error as Error).message}`);
    }
  }

  ready() {
    return this.queue(async () => {
      const { directory } = this.config;
      await this.install(directory);
      return directory;
    });
  }

  save(raw: unknown) {
    const value = adbPreferencesSchema.parse(raw);
    return this.queue(async () => {
      const directory = value.directory ?? this.defaultDirectory;
      await this.install(directory);
      let ownedPath = this.store.adb.ownedPath;
      let before: PathValue | undefined;
      let after: PathValue | undefined;
      if (value.systemPath || ownedPath) {
        try {
          before = (await this.readPath()).value;
          const next = editPath(before, ownedPath, value.systemPath ? directory : undefined);
          ownedPath = next.ownedPath;
          if (before.Raw !== next.value.Raw) {
            await this.writePath(before, next.value);
            after = next.value;
          }
        } catch (error) { throw new Error(`无法更新用户 PATH · ${(error as Error).message}`); }
      }
      try { this.store.setAdb({ ...value, ownedPath }); }
      catch (error) {
        if (before && after) {
          try { await this.writePath(after, before); }
          catch (rollback) { throw new Error(`配置保存失败，且无法恢复原用户 PATH · ${(rollback as Error).message}`); }
        }
        throw error;
      }
      return this.config;
    });
  }

  async detect() {
    const executable = join(await this.ready(), 'adb.exe');
    const version = (await this.run(executable, ['version'], 10000)).stdout.trim();
    let systemExecutable: string | undefined;
    if (this.store.adb.systemPath) {
      const { effectivePath } = await this.readPath();
      const where = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
      env.Path = effectivePath;
      const result = await this.run(where, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command adb -ErrorAction SilentlyContinue).Source'], 12000, env);
      systemExecutable = result.stdout.trim();
    }
    return { executable, version, systemExecutable };
  }

  private async list(executable: string): Promise<AdbDevice[]> {
    const result = await this.run(executable, ['devices', '-l'], 15000);
    return result.stdout.split(/\r?\n/).flatMap(line => {
      const match = /^(\S+)\s+(no permissions|\S+)(?:\s+(.*))?$/.exec(line.trim());
      return match && !line.startsWith('List of devices') && !line.startsWith('*')
        ? [{ serial: match[1], state: match[2], details: match[3] ?? '' }] : [];
    });
  }

  async devices() { return this.list(join(await this.ready(), 'adb.exe')); }

  async pull(raw: unknown) {
    const { serial, remote, directory } = pullSchema.parse(raw);
    const executable = join(await this.ready(), 'adb.exe');
    if (!(await this.list(executable)).some(device => device.serial === serial && device.state === 'device')) {
      throw new Error('所选 ADB 设备未连接或尚未授权，请刷新设备列表');
    }
    await mkdir(directory, { recursive: true });
    const { stdout, stderr } = await this.run(executable, ['-s', serial, 'pull', remote, directory], 300000);
    return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || '拉取完成';
  }

  settled() { return this.pending; }
}
