const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, readFile } = require('node:fs/promises');
const { WriteStream } = require('node:fs');
const { Duplex } = require('node:stream');
const { resolve, join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { build } = require('esbuild');
async function until(fn, label) {
  for (let n = 0; n < 100; n++) { if (await fn()) return; await sleep(30); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/ai-serial-'));
  await build({ entryPoints: ['src/main/controller.ts'], outfile: 'dist/test-ai-controller.cjs', bundle: true, platform: 'node', external: ['serialport', 'ssh2'] });
  const { createController } = require('../dist/test-ai-controller.cjs');
  const devices = new Map();
  const events = [];
  const calls = [];
  let plans = [];
  let pending = false;
  let failLog = false;
  let repeat = false;
  const prototype = WriteStream.prototype;
  const originalWrite = prototype._write;
  const originalWritev = prototype._writev;
  const isFailure = chunks => failLog && (Array.isArray(chunks) ? chunks.some(item => item.chunk.includes('AI_DISK_FAIL')) : chunks.includes('AI_DISK_FAIL'));
  prototype._write = function (chunk, encoding, done) { if (isFailure(chunk)) { failLog = false; done(new Error('模拟磁盘写入失败')); } else originalWrite.call(this, chunk, encoding, done); };
  prototype._writev = function (chunks, done) { if (isFailure(chunks)) { failLog = false; done(new Error('模拟磁盘写入失败')); } else originalWritev.call(this, chunks, done); };
  class Port extends Duplex {
    constructor(path) { super(); this.path = path; this.isOpen = false; this.sent = []; this.failDrain = false; this.echo = true; }
    _read() {}
    _write(chunk, _encoding, done) {
      this.sent.push(Buffer.from(chunk));
      if (this.echo) this.push(Buffer.from(`OBSERVED_${this.path}_${chunk.toString().trim()}\r\n# `)); // Synchronous reply, before write callback.
      queueMicrotask(done);
    }
    open(done) { this.isOpen = true; queueMicrotask(() => done(null)); }
    close(done) { this.isOpen = false; queueMicrotask(() => { this.emit('close'); done(null); }); }
    drain(done) { queueMicrotask(() => done(this.failDrain ? new Error('模拟串口 drain 失败') : null)); }
  }
  const controller = createController(directory, event => events.push(event), {
    list: async () => [], openDevice: config => { const port = new Port(config.path); devices.set(config.path, port); return port; },
  }, { timeoutMs: 500,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      if (pending) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('test abort')), { once: true }));
      const next = repeat ? { reply: '继续', action: { type: 'send', text: 'echo repeat', lineEnding: 'CR', waitMs: 250 } } : plans.shift() ?? { reply: '完成', action: null };
      return new Response(JSON.stringify({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }] }));
    },
  });
  const request = controller.requests;
  const ids = { COM3: randomUUID(), COM12: randomUUID(), ssh: randomUUID() };
  const open = async path => {
    await request.open({ id: ids[path], profile: { kind: 'serial', name: path, path, baudRate: 921600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'software', logFormat: 'raw' }, size: { cols: 80, rows: 24 } });
    await until(() => events.some(e => e.id === ids[path] && e.type === 'connection' && e.state === 'connected'), path);
  };
  const input = (id = randomUUID(), target = ids.COM3) => ({ id, serialTargetId: target, sources: [], messages: [{ role: 'user', content: '检查串口并根据回显继续' }] });
  const run = value => request['ai-assist'](value ?? input());
  const allSent = path => Buffer.concat(devices.get(path).sent).toString();
  try {
    await request['ai-save']({ model: 'GLM-5.3-Flash-NVFP4', key: 'serial-fixture-key' });
    await open('COM3'); await open('COM12');
    plans = [{ reply: '第一步', action: { type: 'send', text: 'echo FIRST', lineEnding: 'CR', waitMs: 250 } }, { reply: '第二步', action: { type: 'send', text: 'echo SECOND', lineEnding: 'CRLF', waitMs: 250 } }, { reply: '完成', action: null }];
    const firstRun = input(); const result = await run(firstRun);
    assert.equal(result.writes, 2); assert.equal(result.steps, 2);
    assert.equal(allSent('COM3'), 'echo FIRST\recho SECOND\r\n'); assert.equal(allSent('COM12'), '');
    assert(JSON.stringify(calls[1].body).includes('OBSERVED_COM3_echo FIRST'));
    assert(JSON.stringify(calls[2].body).includes('OBSERVED_COM3_echo SECOND'));
    assert.equal(events.filter(e => e.runId === firstRun.id && e.phase === 'written').length, 2);
    assert(calls.every(call => call.url === 'https://llm.amlogic.com/v1/chat/completions'));

    // A timed task must not reuse a shell prompt from before an AI command with no new reply.
    devices.get('COM3').echo = false;
    plans = [{ reply: '命令尚无回显', action: { type: 'send', text: 'slow command', lineEnding: 'CR', waitMs: 250 } }, { reply: '尚未确认完成', action: null }];
    await run();
    const noReplyCount = devices.get('COM3').sent.length;
    request['timer-start'](ids.COM3, { command: 'reboot', intervalSeconds: 1, lineEnding: 'CR', waitForShell: true, prompt: '', once: true });
    await sleep(600); request['timer-stop'](ids.COM3);
    assert.equal(devices.get('COM3').sent.length, noReplyCount, 'old prompt cannot authorize a later timed reboot');
    devices.get('COM3').echo = true; devices.get('COM3').push(Buffer.from('\r\n# ')); await sleep(450);
    const count = devices.get('COM3').sent.length;
    for (const action of [
      { type: 'send', text: 'echo ok\rreboot', lineEnding: 'CR', waitMs: 250 },
      { type: 'send', text: '\x1b[31m', lineEnding: 'CR', waitMs: 250 },
      { type: 'send', text: 'echo wrong', lineEnding: 'CR', waitMs: 250, serialTargetId: ids.COM12 },
    ]) {
      plans = [{ reply: '不合法', action }]; await assert.rejects(run(), /格式无效/);
      assert.equal(devices.get('COM3').sent.length, count);
    }
    plans = ['建议输入 echo PROSE（仅说明）']; assert.equal((await run()).writes, 0);
    plans = [{ reply: '普通对话中的动作不得执行', action: { type: 'send', text: 'CHAT_MUST_NOT_EXECUTE', lineEnding: 'CR', waitMs: 250 } }];
    await request['ai-chat']({ ...input(), serialTargetId: undefined });
    assert.equal(devices.get('COM3').sent.length, count);
    await request.open({ id: ids.ssh, profile: { kind: 'ssh', name: 'SSH', host: '127.0.0.1', port: 1, username: 'fixture' }, auth: { method: 'password', password: 'fixture' }, size: { cols: 80, rows: 24 } });
    await assert.rejects(run(input(randomUUID(), ids.ssh)), /已连接的串口/);
    const timer = { command: 'reboot', intervalSeconds: 60, lineEnding: 'CR', waitForShell: true, prompt: '' };
    request['timer-start'](ids.COM3, timer); await assert.rejects(run(), /定时任务|重启测试/); request['timer-stop'](ids.COM3);

    pending = true; const cancelRun = input(); const waiting = run(cancelRun);
    const cancellation = assert.rejects(waiting, /已取消/);
    await until(() => calls.length && controller.requests && events.some(e => e.runId === cancelRun.id && e.phase === 'planning'), 'planning');
    await assert.rejects(run(input()), /已有操作/);
    assert.throws(() => request['timer-start'](ids.COM3, timer), /AI 正在操作/);
    request['ai-cancel'](cancelRun.id); await cancellation; pending = false;
    assert.equal(devices.get('COM3').sent.length, count);
    plans = [{ reply: '等待', action: { type: 'wait', waitMs: 10000 } }];
    const manualRun = input(); const manual = run(manualRun); const manualResult = assert.rejects(manual, /手动输入已停止/);
    await until(() => events.some(e => e.runId === manualRun.id && e.phase === 'sending'), 'waiting for input');
    controller.notifications.write(ids.COM3, 'x', false); await manualResult;
    assert.equal(allSent('COM3').slice(-1), 'x');
    await assert.rejects(run(), /未结束的手动输入/);
    controller.notifications.write(ids.COM3, '\x03', false); devices.get('COM3').push(Buffer.from('\r\n# ')); await sleep(450);

    repeat = true; const limited = await run(); repeat = false;
    assert.equal(limited.limited, true); assert.equal(limited.steps, 6); assert.equal(limited.writes, 6);
    plans = [{ reply: '写入失败必须停止', action: { type: 'send', text: 'echo FAIL', lineEnding: 'CR', waitMs: 250 } }, { reply: '不应发送', action: { type: 'send', text: 'AFTER_FAIL', lineEnding: 'CR', waitMs: 250 } }];
    devices.get('COM3').failDrain = true; const failRun = input(); await assert.rejects(run(failRun), /drain 失败/); devices.get('COM3').failDrain = false;
    assert(!allSent('COM3').includes('AFTER_FAIL'));
    assert.equal(events.filter(e => e.runId === failRun.id && e.phase === 'written').length, 0);

    plans = [{ reply: '等待磁盘故障', action: { type: 'wait', waitMs: 10000 } }];
    const diskRun = input(); const disk = run(diskRun); const diskResult = assert.rejects(disk, /日志写入失败/);
    await until(() => events.some(e => e.runId === diskRun.id && e.phase === 'sending'), 'disk wait');
    failLog = true; devices.get('COM3').push(Buffer.from('AI_DISK_FAIL\r\n')); await diskResult;
    await assert.rejects(run(), /日志不可用/);
    plans = [{ reply: '等待断线', action: { type: 'wait', waitMs: 10000 } }];
    const disconnectRun = input(randomUUID(), ids.COM12); const disconnect = run(disconnectRun); const disconnectResult = assert.rejects(disconnect, /串口已断开/);
    await until(() => events.some(e => e.runId === disconnectRun.id && e.phase === 'sending'), 'disconnect wait');
    await request.disconnect(ids.COM12); await disconnectResult;
    const otherLogs = events.find(e => e.id === ids.COM12 && e.type === 'connection' && e.state === 'connected').logDir;
    const log = await readFile(join(otherLogs, 'events.log'), 'utf8'); assert(!log.includes('serial-fixture-key'));
    console.log('AI serial backend: synchronous early bytes, real write/drain acknowledgement, target isolation, invalid actions/prose, no chat writes, SSH denial, timer exclusion, cancellation, manual input, 6-step cap, drain failure, log failure and disconnect OK. Evidence: ' + directory);
  } finally { await controller.closeAll(); prototype._write = originalWrite; prototype._writev = originalWritev; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
