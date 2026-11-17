import { StringDecoder } from 'node:string_decoder';
import { setTimeout as wait } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { lineEndings, type TimerOptions } from '../shared';

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class Transcript {
  private decoder = new StringDecoder('utf8');
  private text = '';
  private offset = 0;
  get position() { return this.offset + this.text.length; }
  append(bytes: Buffer) {
    this.text += this.decoder.write(bytes);
    if (this.text.length > 32_768) {
      const excess = this.text.length - 16_384;
      this.offset += excess;
      this.text = this.text.slice(excess);
    }
  }
  sees(pattern: RegExp, after: number) {
    const index = Math.max(0, after - this.offset);
    const text = this.text.slice(index).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    return pattern.test(text);
  }
}

export class SerialWorkflow {
  private transcript = new Transcript();
  private loginAfter = 0;
  private previousSend?: number;
  constructor(
    private signal: AbortSignal,
    private write: (bytes: Buffer) => Promise<void>,
    private show: (text: string) => void,
    private event: (event: string, detail: string) => void,
    private mask: (secret: string) => void,
    private resetShell: () => void,
    private shellReady: () => boolean,
  ) {}

  receive(bytes: Buffer) { this.transcript.append(bytes); }

  private async until(check: () => boolean, seconds: number, failure: string) {
    const deadline = performance.now() + seconds * 1000;
    for (;;) {
      this.signal.throwIfAborted();
      if (check()) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(failure);
      await wait(Math.min(10, remaining), undefined, { signal: this.signal });
    }
  }

  private async send(value: string, step: string, kind: string) {
    this.signal.throwIfAborted();
    const started = performance.now();
    const elapsed = this.previousSend === undefined ? '-' : (started - this.previousSend).toFixed(3);
    this.previousSend = started;
    await this.write(Buffer.from(value, 'utf8'));
    this.event('step_written', `${step} ${kind} send_gap_ms=${elapsed} drain_ms=${(performance.now() - started).toFixed(3)}`);
    this.signal.throwIfAborted();
  }

  async run(options: TimerOptions) {
    const steps = options.steps!;
    const ending = lineEndings[options.lineEnding];
    for (const [index, step] of steps.entries()) {
      this.signal.throwIfAborted();
      const label = `${index + 1}/${steps.length}`;
      if (step.type === 'send') {
        this.show(`步骤 ${label}：正在写入命令`);
        await this.send(step.command + lineEndings[step.lineEnding], label, 'command');
      } else if (step.type === 'wait') {
        this.show(`步骤 ${label}：等待 ${step.milliseconds} ms`);
        const started = performance.now();
        await wait(step.milliseconds, undefined, { signal: this.signal });
        this.event('step_delay', `${label} configured_ms=${step.milliseconds} actual_ms=${(performance.now() - started).toFixed(3)}`);
      } else if (options.login) {
        const { username, password, loginPrompt, passwordPrompt, timeoutSeconds } = options.login;
        const prompt = (value: string) => new RegExp('(?:^|[\\r\\n])[^\\r\\n]{0,128}?' + escaped(value.trim()) + '[ \\t]*(?=$|[\\r\\n])', 'i');
        const login = prompt(loginPrompt);
        const pass = prompt(passwordPrompt);
        const rejected = /login incorrect|authentication fail(?:ed|ure)|invalid password|access denied/i;
        this.show(`步骤 ${label}：等待本轮登录提示`);
        await this.until(() => this.transcript.sees(login, this.loginAfter), timeoutSeconds, '等待登录提示超时');
        const afterUser = this.transcript.position;
        this.show(`步骤 ${label}：正在发送用户名`);
        await this.send(username + ending, label, 'username');
        this.show(`步骤 ${label}：等待密码提示`);
        await this.until(() => {
          if (this.transcript.sees(rejected, afterUser) || this.transcript.sees(login, afterUser)) throw new Error('设备拒绝登录');
          return this.transcript.sees(pass, afterUser);
        }, timeoutSeconds, '等待密码提示超时');
        const afterPassword = this.transcript.position;
        this.resetShell();
        this.mask(password);
        this.show(`步骤 ${label}：正在发送凭据`);
        await this.send(password + ending, label, 'password');
        this.show(`步骤 ${label}：凭据已写入，等待 Shell 确认`);
        await this.until(() => {
          if (this.transcript.sees(rejected, afterPassword) || this.transcript.sees(login, afterPassword) ||
              this.transcript.sees(pass, afterPassword)) throw new Error('设备拒绝登录');
          return this.shellReady();
        }, timeoutSeconds, '凭据已写入，但未在限时内收到 Shell 提示');
        this.loginAfter = this.transcript.position;
        this.show(`步骤 ${label}：已确认登录`);
        this.event('login_confirmed', label);
      } else {
        this.show(`步骤 ${label}：自动登录已关闭，跳过`);
        this.event('login_skipped', label);
      }
    }
  }
}
