import { app, dialog } from 'electron';
import { SerialPortMock } from 'serialport';
import { WriteStream } from 'node:fs';
import { startApp } from '../src/main/app';

let device: SerialPortMock;
const path = 'COM77';
SerialPortMock.binding.createPort(path, { record: true, manufacturer: 'TermDock mock' });
for (const path of ['COM3', 'COM12']) SerialPortMock.binding.createPort(path, { record: true, manufacturer: 'TermDock mock' });
const devices = new Map<string, SerialPortMock>();

// Fault injection targets an actual WriteStream write in the backend.
const streamPrototype = WriteStream.prototype as any;
const write = streamPrototype._write;
const writev = streamPrototype._writev;
let fail = false;
const aiRequests: { url: string; authorization: string; body: any }[] = [];
let aiMode = 'ok';
let aiPlans: unknown[] = [];
const serialReplies = new Map<string, Map<string, string>>();
// FileHandle-created streams have no path property. Target their first write containing the marker.
function failChunk(chunk: Buffer | { chunk: Buffer }[]) {
  return fail && (Array.isArray(chunk) ? chunk.some(value => value.chunk.includes('INJECT_DISK_FAILURE')) :
    chunk.includes('INJECT_DISK_FAILURE'));
}
streamPrototype._write = function (chunk: Buffer, encoding: string, done: (error?: Error) => void) {
  if (failChunk(chunk)) { fail = false; done(new Error('模拟磁盘空间不足')); }
  else write.call(this, chunk, encoding, done);
};
streamPrototype._writev = function (chunks: { chunk: Buffer }[], done: (error?: Error) => void) {
  if (failChunk(chunks)) { fail = false; done(new Error('模拟磁盘空间不足')); }
  else writev.call(this, chunks, done);
};

Object.assign(globalThis, {
  fixture: {
    feed: (bytes: number[]) => device.port!.emitData(Buffer.from(bytes)),
    sent: () => [...device.port!.recording],
    connected: () => device?.isOpen,
    sentPort: (path: string) => [...devices.get(path)!.port!.recording],
    connectedPort: (path: string) => devices.get(path)?.isOpen,
    disconnect: () => device.close(() => {}),
    disconnectPort: (path: string) => devices.get(path)!.close(() => {}),
    diskFailure: () => { fail = true; device.port!.emitData(Buffer.from('INJECT_DISK_FAILURE\r\n')); },
    choosePath: (path: string) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    },
    resize: (width: number, height: number) => {
      // The test uses the real BrowserWindow sizing path.
      require('electron').BrowserWindow.getAllWindows()[0].setSize(width, height);
    },
    quit: () => app.quit(),
    aiRequests: () => aiRequests,
    aiMode: (mode: string) => { aiMode = mode; },
    aiPlans: (plans: unknown[]) => { aiPlans = plans; aiMode = 'plans'; },
    serialReplies: (path: string, replies: [string, string][]) => { serialReplies.set(path, new Map(replies)); },
    feedPort: (path: string, bytes: number[]) => devices.get(path)!.port!.emitData(Buffer.from(bytes)),
  },
});
startApp({
  dataDirectory: process.env.TERMDOCK_TEST_DATA,
  aiTransport: {
    timeoutMs: 500,
    fetch: async (url, options) => {
      const body = JSON.parse(String(options?.body));
      aiRequests.push({ url: String(url), authorization: (options?.headers as Record<string, string>).Authorization, body });
      if (aiMode === 'plans') {
        const plan = aiPlans.shift() ?? { reply: '已完成本次操作。', action: null };
        return new Response(JSON.stringify({ choices: [{ message: { content: typeof plan === 'string' ? plan : JSON.stringify(plan) } }] }));
      }
      if (aiMode === 'pending') return await new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('test abort')), { once: true });
      });
      if (aiMode === 'network') throw new TypeError('fetch failed: fixture-key-must-never-leak');
      if (aiMode === 'auth') return new Response('{"error":{"message":"fixture-key-must-never-leak"}}', { status: 401 });
      if (aiMode === 'model') return new Response('{"error":{"message":"model not found"}}', { status: 404 });
      if (aiMode === 'length') return new Response('{"error":{"message":"maximum context length"}}', { status: 400 });
      if (aiMode === 'empty') return new Response('{"choices":[{"message":{"content":""}}]}');
      if (aiMode === 'invalid') return new Response('not json');
      return new Response(JSON.stringify({ choices: [{ message: { content: body.max_tokens === 500 ? 'OK' : '事实：串口日志确认到达 U-Boot；SSH 日志包含 ERROR。证据分别来自所标明的会话。推测：需进一步核对启动配置。建议检查电源及 kernel 日志。' } }] }));
    },
  },
  serial: {
    list: () => SerialPortMock.list(),
    openDevice: config => {
      device = new SerialPortMock({ path: config.path, baudRate: config.baudRate, autoOpen: false });
      devices.set(config.path, device);
      const current = device;
      const originalWrite = current.write.bind(current);
      current.write = ((...args: any[]) => {
        const result = (originalWrite as any)(...args);
        const reply = serialReplies.get(config.path)?.get(Buffer.from(args[0]).toString('utf8'));
        if (reply) setTimeout(() => { if (current.isOpen) current.port!.emitData(Buffer.from(reply)); }, 1);
        return result;
      }) as typeof current.write;
      return device;
    },
  },
});
