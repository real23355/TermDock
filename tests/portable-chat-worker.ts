import { Duplex } from 'node:stream';
import { appendFileSync } from 'node:fs';
import { startWorker } from '../src/main/worker';

// Built only into an isolated extracted package by portable-chat.cjs.
// The shipped worker continues to use the real Windows serial binding and fixed AI endpoint.
const record = (value: object) => appendFileSync(process.env.TD_TEST_RECORDS!, JSON.stringify(value) + '\n');
class Port extends Duplex {
  isOpen = false;
  constructor(readonly path: string) { super(); }
  _read() {}
  _write(bytes: Buffer, _encoding: string, done: (error?: Error | null) => void) {
    record({ type: 'write', port: this.path, text: bytes.toString() });
    this.push(Buffer.from(`NATIVE_REPLY_${this.path}_${bytes.toString().trim()}\r\n# `));
    queueMicrotask(done);
  }
  open(done: (error: Error | null) => void) {
    this.isOpen = true;
    queueMicrotask(() => { done(null); this.push(Buffer.from(`NATIVE_READY_${this.path}\r\n# `)); });
  }
  close(done: (error: Error | null) => void) { this.isOpen = false; queueMicrotask(() => { this.emit('close'); done(null); }); }
  drain(done: (error: Error | null) => void) { queueMicrotask(() => done(null)); }
}
startWorker(process.argv[2], {
  list: async () => ['COM77', 'COM78'].map(path => ({ path, manufacturer: 'TermDock test fixture' })),
  openDevice: profile => new Port(profile.path),
}, { fetch: async (url, options) => {
  const body = JSON.parse(String(options?.body));
  record({ type: 'request', url: String(url), body, authenticated: (options?.headers as Record<string, string>).Authorization === 'Bearer portable-chat-fixture' });
  const automatic = body.messages[0]?.content.includes('本轮用户选择了 TermDock 串口操作');
  const steps = body.messages.filter((message: { role: string; content: string }) => message.role === 'assistant' && message.content.startsWith('{')).length;
  const plans = [
    { reply: '先查看内存', action: { type: 'send', text: 'free -m', lineEnding: 'CR', waitMs: 250 } },
    { reply: '再查看系统', action: { type: 'send', text: 'uname -a', lineEnding: 'LF', waitMs: 250 } },
    { reply: '已根据两次新回显完成检查。', action: null },
  ];
  const content = body.max_tokens === 500 ? 'OK' : automatic ? JSON.stringify(plans[steps] ?? plans[2]) : '可以直接根据当前串口内容提问，当前为普通对话，没有发送字符。';
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
} });
