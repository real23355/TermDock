import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import type { LocalProfile, Size } from '../shared';
import { prependPath } from './adb';

const inputFrame = 1;
const resizeFrame = 2;
const closeFrame = 3;

function frame(operation: number, payload: Buffer) {
  const header = Buffer.alloc(5);
  header[0] = operation;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export class LocalPty {
  private readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly finished: Promise<{ detail: string; failed: boolean }>;

  constructor(size: Size, config: LocalProfile, adbDirectory?: string) {
    if (config.cwd && !isAbsolute(config.cwd)) throw new Error('工作目录必须是绝对路径');
    const env = { ...process.env };
    for (const [name, value] of Object.entries(config.env ?? {})) {
      for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
      env[name] = value;
    }
    const child = this.child = spawn(join(__dirname, 'termdock-pty.exe'),
      [String(size.cols), String(size.rows), config.shell, config.cwd || '', String(Object.keys(config.env ?? {})
        .some(key => key.toUpperCase() === 'PSMODULEPATH'))], { windowsHide: true, env: adbDirectory ? prependPath(env, adbDirectory) : env });
    let diagnostic = '';
    let started = false;
    const stderr = createInterface({ input: child.stderr });
    child.stdin.on('error', error => { diagnostic ||= error.message; });
    child.stdout.on('error', error => { diagnostic ||= error.message; });
    child.once('error', error => { diagnostic ||= error.message; });
    this.finished = new Promise(resolve => {
      child.once('close', code => {
        stderr.close();
        const detail = diagnostic || `${config.name} 已退出（${code ?? '异常'}）`;
        resolve({ detail, failed: code !== 0 });
      });
    });
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${config.name} 启动超时`)), 15000);
      stderr.on('line', line => {
        if (line === 'READY') {
          started = true;
          clearTimeout(timeout);
          resolve();
        } else if (line.trim()) diagnostic = line.trim();
      });
      void this.finished.then(result => {
        clearTimeout(timeout);
        if (!started) reject(new Error(result.detail));
      });
    });
  }

  get input() { return this.child.stdin; }
  get output() { return this.child.stdout; }

  write(bytes: Buffer, done: (error?: Error | null) => void) {
    this.input.write(frame(inputFrame, bytes), done);
  }

  resize(size: Size) {
    if (!this.input.writable) return;
    const payload = Buffer.alloc(4);
    payload.writeUInt16LE(size.cols, 0);
    payload.writeUInt16LE(size.rows, 2);
    this.input.write(frame(resizeFrame, payload));
  }

  async close() {
    if (this.input.writable) this.input.end(frame(closeFrame, Buffer.alloc(0)));
    const timeout = setTimeout(() => this.child.kill(), 4000);
    try { await this.finished; }
    finally { clearTimeout(timeout); }
  }
}
