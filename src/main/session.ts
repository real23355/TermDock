import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { SerialPort } from 'serialport';
import type { Auth, Forward, ForwardOptions, LocalProfile, OpenRequest, PortInfo, SerialProfile, SessionEvent, Size, SshProfile, TimerOptions } from '../shared';
import { SessionLogs } from './logs';
import { LocalPty } from './local-pty';
import { SerialTimer } from './timer';
import { listRemote, transferFile } from './sftp';
import { LocalForward } from './ssh-forward';
import type { Store } from './store';

type SerialDevice = Duplex & {
  isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
  drain(callback: (error: Error | null) => void): void;
  set?(options: { brk: boolean }, callback: (error: Error | null) => void): void;
};
export type SerialProvider = {
  list(): Promise<PortInfo[]>;
  openDevice(profile: SerialProfile): SerialDevice;
};

export const systemSerial: SerialProvider = {
  list: () => SerialPort.list(),
  openDevice: config => new SerialPort({
    path: config.path, baudRate: config.baudRate, dataBits: config.dataBits,
    parity: config.parity, stopBits: config.stopBits,
    rtscts: config.flow === 'hardware', xon: config.flow === 'software', xoff: config.flow === 'software',
    xany: false, autoOpen: false,
  }),
};

export function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

const displayLimit = 1024 * 1024;
const displayBatch = 128 * 1024;
const inputLimit = 4 * 1024 * 1024;

export class Session {
  readonly id: string;
  private state: 'connecting' | 'connected' | 'disconnected' = 'connecting';
  private serial?: SerialDevice;
  private local?: LocalPty;
  private openingSerial?: Promise<void>;
  private ssh?: Client;
  private sftp?: Promise<SFTPWrapper>;
  private forwards = new Map<string, { server: LocalForward; config?: Forward }>();
  private channel?: ClientChannel;
  private key?: { token: string; fingerprint: string; endpoint: string; callback: (valid: boolean) => void };
  private size: Size;
  private logs?: SessionLogs;
  private timer?: SerialTimer;
  private connecting: Promise<void>;
  private ending?: Promise<void>;
  private output: Buffer[] = [];
  private outputBytes = 0;
  private outputSkipped = 0;
  private outputJob?: NodeJS.Timeout;
  private sequence = 0;
  private inFlight = 0;
  private inputOverflow = false;
  private sendingBreak = false;

  constructor(
    request: OpenRequest,
    private store: Store,
    logRoot: string,
    private emit: (event: SessionEvent) => void,
    private serialProvider: SerialProvider,
  ) {
    this.id = request.id;
    this.size = request.size;
    this.connection('connecting', '正在建立连接');
    this.connecting = this.connect(request, logRoot);
    void this.connecting.catch(error => this.end(errorText(error), true));
  }

  get logDir() { return this.logs?.directory; }

  private async connect(request: OpenRequest, logRoot: string) {
    const serial = request.profile.kind === 'serial' ? request.profile : undefined;
    const root = serial?.logDirectory ?? logRoot;
    const logs = await SessionLogs.create(root, request.profile.name, serial?.logFormat === 'timestamped', error => {
      this.timer?.stop('日志写入失败', true);
      this.error(`日志写入失败：${error}`);
    }, paused => {
      const streams = [this.serial, this.channel, this.channel?.stderr, this.local?.output];
      for (const stream of streams) {
        if (paused) stream?.pause();
        else stream?.resume();
      }
    });
    if (this.state === 'disconnected') { await logs.close(); return; }
    this.logs = logs;
    logs.event('connecting', request.profile.kind);
    if (request.profile.kind === 'serial') await this.connectSerial(request.profile, logs);
    else if (request.profile.kind === 'local') await this.connectLocal(request.profile);
    else if (request.auth) await this.connectSsh(request.profile, request.auth);
    else throw new Error('请输入 SSH 认证信息');
  }

  private async connectLocal(config: LocalProfile) {
    const terminal = this.local = new LocalPty(this.size, config);
    terminal.output.on('data', this.receive);
    void terminal.finished.then(result => {
      if (this.state === 'connected') void this.end(result.detail, result.failed);
    });
    await terminal.ready;
    if (this.state !== 'connecting') return;
    this.connection('connected', `本机 ${config.name}`);
    this.resize(this.size);
  }

  private async connectSerial(config: SerialProfile, logs: SessionLogs) {
    const serial = this.serial = this.serialProvider.openDevice(config);
    serial.on('error', error => void this.end(errorText(error), true));
    serial.on('close', (error?: Error) => void this.end(error ? errorText(error) : '串口已断开', true));
    this.timer = new SerialTimer(logs, bytes => this.sendSerial(serial, bytes),
      state => this.emit({ id: this.id, type: 'timer', state }), () => this.state === 'connected');
    serial.on('data', this.receive);
    this.openingSerial = new Promise<void>((resolve, reject) => serial.open(error => error ? reject(error) : resolve()));
    await this.openingSerial;
    if (this.state === 'connecting') this.connection('connected', `${config.path} · ${config.baudRate}`);
  }

  private async connectSsh(config: SshProfile, auth: Auth) {
    let privateKey: Buffer | undefined;
    if (auth.method === 'key') {
      const file = await open(auth.privateKey, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('私钥文件无效或超过 1 MiB');
        privateKey = Buffer.alloc(stat.size);
        const { bytesRead } = await file.read(privateKey, 0, privateKey.length, 0);
        if (bytesRead !== privateKey.length) throw new Error('读取私钥时文件发生变化');
      } finally { await file.close(); }
    }
    try {
      if (this.state !== 'connecting') return;
      const client = this.ssh = new Client();
      const endpoint = `[${config.host.toLowerCase()}]:${config.port}`;
      client.on('error', error => void this.end(errorText(error), true));
      client.on('close', () => void this.end('SSH 连接已关闭', this.state === 'connecting'));
      client.on('ready', () => {
        if (this.state !== 'connecting') return;
        client.shell({ term: 'xterm-256color', ...this.size }, (error, channel) => {
          if (error) { void this.end(errorText(error), true); return; }
          if (this.state !== 'connecting') { channel.close(); return; }
          this.channel = channel;
          channel.on('error', (problem: Error) => void this.end(errorText(problem), true));
          channel.on('data', this.receive);
          channel.stderr.on('data', this.receive);
          channel.on('close', () => void this.end('远程 shell 已退出'));
          this.connection('connected', `${config.username}@${config.host} · ${config.port}`);
          this.resize(this.size);
        });
      });
      client.connect({
        host: config.host, port: config.port, username: config.username, privateKey,
        passphrase: auth.method === 'key' ? auth.passphrase || undefined : undefined,
        password: auth.method === 'password' ? auth.password : undefined,
        agent: auth.method === 'agent' ? (process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent') : undefined,
        readyTimeout: 120000, keepaliveInterval: 15000, keepaliveCountMax: 3,
        hostVerifier: (bytes: Buffer, callback: (valid: boolean) => void) => {
          const fingerprint = 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');
          const known = this.store.host(endpoint);
          if (known === fingerprint) { callback(true); return; }
          if (known || this.state === 'disconnected') {
            if (known) void this.end(`主机密钥已变化。已保存 ${known}，当前 ${fingerprint}。请向管理员核对。`, true);
            callback(false);
            return;
          }
          const token = randomUUID();
          this.key = { token, fingerprint, endpoint, callback };
          this.emit({ id: this.id, type: 'host-key', key: { id: this.id, token, host: config.host, port: config.port, fingerprint } });
        },
      });
    } finally {
      // ssh2 parses the private key synchronously before starting the handshake.
      privateKey?.fill(0);
    }
  }

  acceptKey(token: string, accept: boolean) {
    if (this.key?.token !== token || this.state !== 'connecting') throw new Error('主机密钥请求已过期');
    const key = this.key;
    this.key = undefined;
    if (!accept) {
      void this.end('已拒绝主机密钥');
      key.callback(false);
      return;
    }
    try {
      this.store.trust(key.endpoint, key.fingerprint);
      key.callback(true);
    } catch (error) {
      void this.end(errorText(error), true);
      key.callback(false);
    }
  }

  private receive = (bytes: Buffer) => {
    if (this.state === 'disconnected') return;
    this.logs?.receive(bytes);
    this.timer?.receive(bytes);
    this.output.push(bytes);
    this.outputBytes += bytes.length;
    while (this.outputBytes > displayLimit && this.output.length) {
      const chunk = this.output.shift()!;
      this.outputBytes -= chunk.length;
      this.outputSkipped += chunk.length;
    }
    this.queueOutput();
  };

  private queueOutput() {
    if (this.outputJob || this.inFlight || (!this.outputBytes && !this.outputSkipped)) return;
    this.outputJob = setTimeout(() => {
      this.outputJob = undefined;
      const batch: Buffer[] = [];
      let length = 0;
      while (length < displayBatch && this.output.length) {
        const bytes = this.output.shift()!;
        batch.push(bytes);
        length += bytes.length;
      }
      this.outputBytes -= length;
      const skipped = this.outputSkipped;
      this.outputSkipped = 0;
      if (skipped) this.logs?.event('display_overflow', 'skipped_bytes=' + skipped);
      this.inFlight = ++this.sequence;
      this.emit({ id: this.id, type: 'output', data: Buffer.concat(batch, length), sequence: this.sequence, skipped });
    }, 12);
  }

  ack(sequence: number) {
    if (this.inFlight !== sequence) return;
    this.inFlight = 0;
    this.queueOutput();
  }

  private sendSerial(serial: SerialDevice, bytes: Buffer) {
    return new Promise<void>((resolve, reject) => {
      if (!serial.isOpen) { reject(new Error('串口已关闭')); return; }
      serial.write(bytes, error => {
        if (error || !serial.isOpen) { reject(error ?? new Error('串口已关闭')); return; }
        serial.drain(error => error ? reject(error) : resolve());
      });
    });
  }

  write(data: string, binary: boolean) {
    if (this.state !== 'connected') return false;
    const stream = this.serial ?? this.channel ?? this.local?.input;
    if (!stream?.writable) return false;
    const bytes = Buffer.from(data, binary ? 'latin1' : 'utf8');
    if (stream.writableLength + bytes.length > inputLimit) {
      if (!this.inputOverflow) this.error('终端发送缓冲区已满，部分输入未发送');
      this.inputOverflow = true;
      return false;
    }
    this.inputOverflow = false;
    if (!binary) this.timer?.input(data);
    const done = (error?: Error | null) => { if (error) void this.end(errorText(error), true); };
    if (this.local) this.local.write(bytes, done);
    else stream.write(bytes, done);
    return true;
  }

  resize(size: Size) {
    this.size = size;
    if (this.state === 'connected') {
      this.channel?.setWindow(size.rows, size.cols, 0, 0);
      this.local?.resize(size);
    }
  }

  startTimer(options: TimerOptions) {
    if (!this.timer) throw new Error('当前会话没有可用的串口');
    this.timer.start(options);
  }
  stopTimer() { this.timer?.stop(); }

  private getSftp() {
    const client = this.ssh;
    if (!client || this.state !== 'connected') throw new Error('当前 SSH 会话不可用');
    if (!this.sftp) {
      this.sftp = new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, connection) => {
        if (error) { reject(error); return; }
        connection.on('error', (problem: Error) => this.error('SFTP：' + errorText(problem)));
        connection.once('close', () => { this.sftp = undefined; });
        resolve(connection);
      })).catch(error => { this.sftp = undefined; throw error; });
    }
    return this.sftp;
  }

  async sftpList(path: string) { return listRemote(await this.getSftp(), path); }

  async sftpTransfer(mode: 'upload' | 'download', remote: string, local: string) {
    await transferFile(await this.getSftp(), mode, remote, local);
  }

  listForwards() {
    return Array.from(this.forwards.values()).flatMap(entry => entry.config ? [entry.config] : []);
  }

  async startForward(options: ForwardOptions) {
    if (!this.ssh || this.state !== 'connected') throw new Error('当前 SSH 会话不可用');
    const id = randomUUID();
    const server = new LocalForward(this.ssh, options.host, options.port,
      error => this.error('SSH 转发：' + error.message));
    const entry: { server: LocalForward; config?: Forward } = { server };
    this.forwards.set(id, entry);
    try {
      const localPort = await server.start(options.localPort);
      entry.config = { ...options, id, localPort };
    } catch (error) {
      this.stopForward(id);
      throw error;
    }
  }

  stopForward(id: string) {
    this.forwards.get(id)?.server.close();
    this.forwards.delete(id);
  }

  record(enabled: boolean) {
    if (!this.logs || this.state !== 'connected' || this.serial) throw new Error('当前会话不支持切换日志');
    this.logs.record(enabled);
  }

  async serialBreak() {
    const port = this.serial;
    if (this.state !== 'connected' || !port?.isOpen || !port.set || this.sendingBreak) {
      throw new Error('串口 Break 当前不可用');
    }
    const setBreak = (brk: boolean) => new Promise<void>((resolve, reject) => {
      port.set!({ brk }, error => error ? reject(error) : resolve());
    });
    this.sendingBreak = true;
    try {
      await setBreak(true);
      this.logs?.event('serial_break', '250ms');
      await delay(250);
    } finally {
      try { if (port.isOpen) await setBreak(false); }
      finally { this.sendingBreak = false; }
    }
  }

  private connection(state: Session['state'], detail: string) {
    this.state = state;
    this.emit({ id: this.id, type: 'connection', state, detail, logDir: this.logDir });
  }
  private error(detail: string) { this.emit({ id: this.id, type: 'error', detail }); }

  end(detail = '连接已关闭', failed = false) {
    if (this.ending) return this.ending;
    if (this.state === 'disconnected') return Promise.resolve();
    // Stop writes immediately. Update the UI after releasing the device so that
    // a flashing tool can open the COM port as soon as disconnection is shown.
    this.state = 'disconnected';
    if (failed) this.timer?.stop(detail, true);
    const pendingWrite = this.timer?.dispose();
    this.logs?.event(failed ? 'connection_error' : 'disconnected', detail);
    this.ending = this.disconnect(pendingWrite).finally(() => this.connection('disconnected', detail));
    return this.ending;
  }

  private async disconnect(pendingWrite?: Promise<void>) {
    const key = this.key;
    this.key = undefined;
    for (const id of this.forwards.keys()) this.stopForward(id);
    this.ssh?.destroy();
    key?.callback(false);
    if (this.local) {
      this.local.output.resume();
      await this.local.close();
    }
    await this.openingSerial?.catch(() => {});
    const serial = this.serial;
    if (serial?.isOpen) await new Promise<void>(resolve => serial.close(error => {
      if (error) this.error(errorText(error));
      resolve();
    }));
    await this.connecting.catch(() => {});
    await pendingWrite;
    await this.logs?.close();
  }
}
