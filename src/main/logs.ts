import { mkdir, mkdtemp, open, unlink } from 'node:fs/promises';
import type { WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function stamp(date: Date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function lineStamp(date: Date) {
  return Buffer.from(`[${date.getFullYear()}_${pad(date.getMonth() + 1)}_${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}] `, 'ascii');
}

class LogLines {
  private atStart = true;
  private afterCR = false;

  prefix(bytes: Buffer, timestamp: Buffer) {
    const parts: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      // A CR followed by LF is one line ending, even across separate reads.
      if (this.atStart && !(this.afterCR && byte === 0x0a)) {
        if (index > start) parts.push(bytes.subarray(start, index));
        parts.push(timestamp);
        start = index;
      }
      this.afterCR = byte === 0x0d;
      this.atStart = this.afterCR || byte === 0x0a;
    }
    if (!parts.length) return bytes;
    parts.push(bytes.subarray(start));
    return Buffer.concat(parts);
  }
}

type LogFile = { path: string; stream: WriteStream; done: Promise<void>; lines?: LogLines };
type Capture = { readable: LogFile; raw?: LogFile };

export class SessionLogs {
  private session?: Capture;
  private events?: LogFile;
  private round?: Capture;
  private files = new Set<LogFile>();
  private blocked = new Set<LogFile>();
  private roundNumber = 0;
  private failed = false;
  private closing = false;
  private recording = true;

  private constructor(
    readonly directory: string,
    private timestamped: boolean,
    private onError: (message: string) => void,
    private onBackpressure: (paused: boolean) => void,
  ) {}

  static async create(root: string, name: string, timestamped: boolean,
    onError: (message: string) => void, onBackpressure: (paused: boolean) => void) {
    await mkdir(root, { recursive: true });
    const safeName = name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 32);
    const directory = await mkdtemp(join(root, `${stamp(new Date())}_${safeName}_`));
    const logs = new SessionLogs(directory, timestamped, onError, onBackpressure);
    try {
      logs.session = await logs.openCapture('session.log');
      logs.events = await logs.openFile('events.log');
      return logs;
    } catch (error) {
      await logs.close();
      throw error;
    }
  }

  get healthy() { return !this.failed && !this.closing; }
  record(enabled: boolean) {
    if (!this.healthy) throw new Error('日志不可用');
    this.recording = enabled;
    this.event(enabled ? 'recording_started' : 'recording_stopped');
  }

  private async openCapture(name: string): Promise<Capture> {
    const readable = await this.openFile(name, this.timestamped);
    try {
      const raw = this.timestamped ? await this.openFile(name.replace(/\.log$/, '.raw')) : undefined;
      return { readable, raw };
    } catch (error) {
      readable.stream.end();
      await readable.done;
      throw error;
    }
  }

  private async openFile(name: string, timestamped = false): Promise<LogFile> {
    const path = join(this.directory, name);
    const handle = await open(path, 'wx');
    const stream = handle.createWriteStream({ highWaterMark: 256 * 1024 });
    const file = { path, stream, done: Promise.resolve(), lines: timestamped ? new LogLines() : undefined };
    this.files.add(file);
    file.done = finished(stream, { cleanup: true })
      .catch(error => { this.fail(`${name}：${error.message}`); })
      .finally(() => {
        this.files.delete(file);
        this.release(file);
      });
    stream.on('drain', () => this.release(file));
    return file;
  }

  fail(message: string) {
    if (this.failed) return;
    this.failed = true;
    this.event('log_error', message);
    this.onError(message);
  }

  private release(file: LogFile) {
    if (this.blocked.delete(file) && !this.blocked.size) this.onBackpressure(false);
  }

  private write(file: LogFile | undefined, bytes: Buffer | string) {
    if (!file || file.stream.destroyed || file.stream.writableEnded) return;
    if (!file.stream.write(bytes) && !this.blocked.has(file)) {
      if (!this.blocked.size) this.onBackpressure(true);
      this.blocked.add(file);
    }
  }

  receive(bytes: Buffer) {
    if (!bytes.length) return;
    const timestamp = this.timestamped ? lineStamp(new Date()) : undefined;
    for (const capture of [this.recording ? this.session : undefined, this.round]) {
      const file = capture?.readable;
      this.write(file, file?.lines && timestamp ? file.lines.prefix(bytes, timestamp) : bytes);
      this.write(capture?.raw, bytes);
    }
  }

  event(event: string, detail = '') {
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const zone = (offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
    const local = new Date(now.getTime() + offset * 60000).toISOString().slice(0, -1) + zone;
    this.write(this.events, `${local}\t${event}\t${detail.replace(/[\r\n\t]/g, ' ')}\r\n`);
  }

  async prepareRound(command: string) {
    if (!this.healthy) throw new Error('日志不可用');
    const prefix = command.trim().split(/\s+/, 1)[0].replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
    const number = String(this.roundNumber + 1).padStart(4, '0');
    return this.openCapture(`${prefix || 'command'}_${number}_${stamp(new Date())}.log`);
  }

  activateRound(file: Capture) {
    this.roundNumber++;
    this.round?.readable.stream.end();
    this.round?.raw?.stream.end();
    this.round = file;
  }

  async discardRound(capture: Capture) {
    for (const file of [capture.readable, capture.raw]) {
      if (!file) continue;
      file.stream.end();
      await file.done;
      await unlink(file.path).catch(error => this.fail(error.message));
    }
  }

  async close() {
    this.closing = true;
    const files = Array.from(this.files);
    for (const file of files) file.stream.end();
    await Promise.all(files.map(file => file.done));
  }
}
