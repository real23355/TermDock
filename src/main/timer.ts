import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { lineEndings, type ShellState, type TimerOptions, type TimerState } from '../shared';
import type { SessionLogs } from './logs';
import { SerialWorkflow } from './serial-workflow';

const settleMs = 400;

class PromptTracker {
  private decoder = new StringDecoder('utf8');
  private line = '';
  private overflow = false;
  private escape = '';
  private mode: 'text' | 'esc' | 'csi' | 'string' | 'string-end' = 'text';
  private manual: 'idle' | 'typing' | 'submitted' = 'idle';
  private recovering = false;
  private blocked: 'login' | 'bootloader' | undefined;
  private lastOutput = 0;
  bootSeen = false;

  private resetLine() {
    this.line = '';
    this.overflow = false;
  }

  beforeSend() {
    this.resetLine();
    this.decoder = new StringDecoder('utf8');
    this.escape = '';
    this.mode = 'text';
    this.recovering = true;
    this.blocked = undefined;
    this.bootSeen = false;
  }

  resetShell() {
    const bootSeen = this.bootSeen;
    this.beforeSend();
    this.bootSeen = bootSeen;
  }

  input(data: string) {
    // Ignore terminal-generated device replies and mouse reports.
    if (/^(?:\x1b\[(?:[?><]?[\d;]+[cRnMmu]|\?\d+;\d+\$y)|\x1b\[M[\s\S]{3})$/.test(data)) return false;
    const bracketedPaste = data.includes('\x1b[200~');
    this.manual = !bracketedPaste && /[\r\n\x03\x04]$/.test(data) ? 'submitted' : 'typing';
    this.resetLine();
    return true;
  }

  feed(bytes: Buffer, now: number) {
    this.lastOutput = now;
    for (const ch of this.decoder.write(bytes)) {
      if (this.mode === 'string' || this.mode === 'string-end') {
        if (ch === '\x07' || ch === '\x9c' || (this.mode === 'string-end' && ch === '\\')) this.mode = 'text';
        else this.mode = ch === '\x1b' ? 'string-end' : 'string';
        continue;
      }
      if (this.mode === 'esc') {
        if (ch === '[') { this.mode = 'csi'; this.escape = ''; }
        else if (']P^_X'.includes(ch)) this.mode = 'string';
        else { this.mode = 'text'; this.resetLine(); }
        continue;
      }
      if (this.mode === 'csi') {
        if (ch >= '@' && ch <= '~') {
          if (!(ch === 'm' || ((ch === 'h' || ch === 'l') && this.escape.startsWith('?')) ||
            (ch === 'K' && (this.escape === '' || this.escape === '0')))) this.resetLine();
          this.mode = 'text';
        } else if (this.escape.length < 64) this.escape += ch;
        continue;
      }
      if (ch === '\x1b') { this.mode = 'esc'; continue; }
      if (ch === '\r' || ch === '\n') {
        this.checkBootMarker();
        this.blocked = this.blockReason() ?? this.blocked;
        this.resetLine();
      } else if (ch === '\b') this.line = this.line.slice(0, -1);
      else if (ch >= ' ' && ch !== '\x7f') {
        if (this.line.length < 512) this.line += ch;
        else this.overflow = true;
      }
    }
    this.checkBootMarker();
  }

  private checkBootMarker() {
    if (this.recovering && /(?:\bBL2\b|\bU-Boot\b|Linux version |Starting kernel|reboot: Restarting system)/i.test(this.line)) {
      this.bootSeen = true;
    }
  }

  private blockReason() {
    if (/\b(?:login|password)\s*:\s*$/i.test(this.line)) return 'login' as const;
    if (/^\s*(?:=>|(?:u-boot|barebox)[>#])\s*$/i.test(this.line) ||
      /hit any key to stop autoboot/i.test(this.line)) return 'bootloader' as const;
  }

  state(now: number, prompt: string): ShellState {
    const blocked = this.blockReason();
    if (blocked) this.blocked = blocked;
    const line = this.line.trim();
    const matches = prompt ? line === prompt : /^(?:[#\$]|\/ #|[\w.-]+@[\w.-]+:[^\r\n]*?[#$])$/.test(line);
    const settled = this.mode === 'text' && !this.overflow && now - this.lastOutput >= settleMs;
    if (!blocked && matches && settled && this.manual !== 'typing') {
      this.manual = 'idle';
      this.recovering = false;
      this.blocked = undefined;
      return 'ready';
    }
    if (this.blocked) return this.blocked;
    if (this.manual !== 'idle') return 'manual';
    return this.recovering ? 'recovering' : 'unknown';
  }

  get manualPending() { return this.manual !== 'idle'; }
}

export class SerialTimer {
  private tracker = new PromptTracker();
  private options?: TimerOptions;
  private interval: NodeJS.Timeout;
  private active = false;
  private writing = false;
  private pending?: Promise<void>;
  private generation = 0;
  private due = 0;
  private rounds = 0;
  private recovered = 0;
  private recoveryRound?: number;
  private bootSeen = false;
  private send: TimerState['send'] = 'idle';
  private detail = '';
  private lastState = '';
  private waitReason = '';
  private workflow?: SerialWorkflow;
  private abort?: AbortController;

  constructor(
    private logs: SessionLogs,
    private write: (bytes: Buffer) => Promise<void>,
    private publish: (state: TimerState) => void,
    private isConnected: () => boolean,
    private mask: (secret: string) => void,
  ) {
    this.interval = setInterval(() => this.tick(), 100);
    this.tick();
  }

  start(options: TimerOptions) {
    if (!this.logs.healthy || !this.isConnected()) throw new Error('串口或日志不可用');
    if (this.active || this.writing) throw new Error('已有定时任务或命令正在写入');
    this.options = options;
    this.generation++;
    this.rounds = 0;
    this.recovered = 0;
    this.recoveryRound = undefined;
    this.bootSeen = false;
    this.active = true;
    this.due = performance.now() + (options.once ? 0 : options.intervalSeconds * 1000);
    this.waitReason = '';
    this.detail = '';
    this.logs.event('test_started', `interval=${options.intervalSeconds}s max=${options.maxRounds ?? '-'} shell=${options.waitForShell}`);
    this.tick();
  }

  stop(detail = '手动停止', error = false) {
    if (this.active || this.writing) this.logs.event('test_stopped', detail);
    if (!this.active && !this.writing && !error) return;
    this.generation++;
    this.abort?.abort();
    if (this.options?.login) {
      const { login: _login, ...rest } = this.options;
      this.options = rest;
    }
    this.active = false;
    this.send = error ? 'error' : 'stopped';
    this.detail = detail;
    this.tick();
  }

  dispose() {
    if (this.active) this.stop('连接已关闭');
    clearInterval(this.interval);
    return this.pending;
  }

  input(data: string) {
    if (this.tracker.input(data) && this.workflow && this.active) this.stop('手动输入已停止自动流程');
    this.tick();
  }
  receive(bytes: Buffer) {
    this.tracker.feed(bytes, performance.now());
    this.workflow?.receive(bytes);
  }

  private waitFor(shell: ShellState) {
    if (shell === 'login') return '等待登录';
    if (shell === 'bootloader') return '等待退出引导程序';
    if (this.tracker.manualPending) return '等待手动命令结束';
    if (this.options?.waitForShell && shell !== 'ready') return '等待新的 shell 提示符';
    return '';
  }

  private tick() {
    const now = performance.now();
    const shell = this.tracker.state(now, this.options?.prompt ?? '');
    if (this.recoveryRound !== undefined) {
      if (this.tracker.bootSeen && !this.bootSeen) {
        this.bootSeen = true;
        this.logs.event('boot_seen', 'round=' + this.recoveryRound);
      }
      if (this.recoveryRound <= this.rounds && shell === 'ready') {
        this.recovered++;
        this.logs.event('shell_recovered', 'round=' + this.recoveryRound);
        this.recoveryRound = undefined;
      }
    }
    const seconds = this.active && !this.writing ? Math.max(0, Math.ceil((this.due - now) / 1000)) : 0;
    if (this.active && !this.writing) {
      this.send = seconds ? 'countdown' : 'waiting';
      const wait = seconds ? '' : this.waitFor(shell);
      this.detail = wait;
      if (wait && wait !== this.waitReason) this.logs.event('waiting', `round=${this.rounds + 1} ${wait}`);
      this.waitReason = wait;
      if (!seconds && !wait) this.pending = this.sendRound(this.generation, this.options!);
    }
    const state = { send: this.send, shell, rounds: this.rounds, recovered: this.recovered,
      bootSeen: this.bootSeen, seconds, detail: this.detail, roundRecording: this.logs.roundRecording };
    const key = JSON.stringify(state);
    if (key !== this.lastState) {
      this.lastState = key;
      this.publish(state);
    }
  }

  private async sendRound(generation: number, options: TimerOptions) {
    this.writing = true;
    this.send = 'sending';
    const round = this.rounds + 1;
    try {
      const label = options.steps ? 'workflow' : options.command;
      const file = await this.logs.prepareRound(label);
      const now = performance.now();
      if (generation !== this.generation || !this.isConnected() || !this.logs.healthy ||
        this.waitFor(this.tracker.state(now, options.prompt))) {
        await this.logs.discardRound(file);
        return;
      }
      this.logs.activateRound(file);
      this.tracker.beforeSend();
      this.recoveryRound = round;
      this.bootSeen = false;
      this.logs.event('send_attempt', `round=${round}`);
      if (options.steps) {
        const abort = this.abort = new AbortController();
        let firstWrite = true;
        const workflow = this.workflow = new SerialWorkflow(
          abort.signal,
          bytes => {
            if (firstWrite) { this.due = performance.now() + options.intervalSeconds * 1000; firstWrite = false; }
            return this.write(bytes);
          },
          detail => { this.detail = detail; this.tick(); },
          (event, detail) => this.logs.event(event, `round=${round} step=${detail}`),
          this.mask,
          () => this.tracker.resetShell(),
          () => this.tracker.state(performance.now(), options.prompt) === 'ready',
        );
        await workflow.run(options);
      } else {
        await this.write(Buffer.from(options.command + lineEndings[options.lineEnding]));
        this.due = performance.now() + options.intervalSeconds * 1000;
      }
      this.rounds = round;
      this.logs.event('sent', `round=${round}`);
      if (this.active && (options.once || options.maxRounds === round)) {
        this.active = false;
        this.send = 'finished';
        this.detail = options.steps ? '流程已完成' : this.detail;
        if (this.options?.login) {
          const { login: _login, ...rest } = this.options;
          this.options = rest;
        }
        this.logs.event('test_finished', `rounds=${round}`);
      }
    } catch (error) {
      if (this.recoveryRound === round) this.recoveryRound = undefined;
      if (generation === this.generation) {
        const detail = error instanceof Error ? error.message : String(error);
        const failed = options.steps && this.detail ? `${this.detail} · ${detail}` : detail;
        this.logs.event('send_error', `round=${round} ${failed}`);
        this.stop(failed, true);
      }
    } finally {
      this.workflow = undefined;
      this.abort = undefined;
      this.writing = false;
      this.pending = undefined;
      this.tick();
    }
  }
}
