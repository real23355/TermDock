const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { mkdir, mkdtemp } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { build } = require('esbuild');
const { _electron } = require('playwright');
const { Server } = require('ssh2');
async function until(fn, label) {
  for (let n = 0; n < 100; n++) { if (await fn()) return; await sleep(60); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/ai-chat-'));
  await build({ entryPoints: ['tests/app-fixture.ts'], outfile: 'dist/test-ai-chat.cjs', bundle: true, platform: 'node', external: ['electron', 'serialport', 'ssh2'] });
  let stream;
  const clients = new Set();
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const ssh = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === 'fixture-password' ? ctx.accept() : ctx.reject(['password']));
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', accept => accept()); session.on('window-change', accept => accept?.());
      session.on('shell', accept => { stream = accept(); stream.write('SSH_LIVE_FIRST\r\n$ '); });
    }));
  });
  await new Promise(r => ssh.listen(0, '127.0.0.1', r));
  const electron = await _electron.launch({ args: ['dist/test-ai-chat.cjs'], env: { ...process.env, TERMDOCK_TEST_DATA: directory } });
  try {
    const page = await electron.firstWindow(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const state = (selector, text) => page.waitForFunction(([s, t]) => document.querySelector(s)?.textContent.includes(t), [selector, text], { timeout: 8000 });
    const fixture = (name, arg) => electron.evaluate((_e, [name, arg]) => globalThis.fixture[name](arg), [name, arg]);
    const requests = () => fixture('aiRequests');
    const sent = path => electron.evaluate((_e, path) => Buffer.from(globalThis.fixture.sentPort(path)).toString(), path);
    const send = async text => { await page.locator('#ai-question').fill(text); await page.locator('#ai-send').click(); };
    await page.locator('#open-ai-chat').click();
    assert(await page.locator('#ai-dialog').evaluate(el => el.open && !el.matches(':modal')));
    const dialogBefore = await page.locator('#ai-dialog').boundingBox();
    const titleBox = await page.locator('.ai-heading h2').boundingBox();
    await page.mouse.move(titleBox.x + 15, titleBox.y + 5); await page.mouse.down();
    await page.mouse.move(titleBox.x + 55, titleBox.y + 15, { steps: 5 }); await page.mouse.up();
    assert((await page.locator('#ai-dialog').boundingBox()).x > dialogBefore.x + 20);
    await page.locator('#ai-configure').click(); await state('#ai-key-status', '尚未保存');
    await page.locator('#ai-key').fill('fixture-chat-key'); await page.locator('#ai-save').click(); await state('#ai-settings-status', '配置已保存');
    await page.locator('#settings-dialog [data-dismiss]').first().click();
    await send('我可以直接问 Linux 问题吗？'); await until(async () => (await page.locator('.ai-assistant').count()) === 1, 'direct general chat');
    assert.equal((await requests()).at(-1).body.messages.at(-1).content, '我可以直接问 Linux 问题吗？');
    assert((await requests()).at(-1).body.messages[0].content.includes('不要把每个问题都套成日志报告'));
    await page.locator('#ai-collapse').click();
    await page.locator('#quick-ssh').click();
    for (const [name, value] of Object.entries({ host: '127.0.0.1', port: ssh.address().port, username: 'tester', password: 'fixture-password', name: '对话 SSH' })) await page.locator(`#connect-form [name=${name}]`).fill(String(value));
    await page.locator('#connect-now').click(); await page.locator('#accept-key').click(); await state('#global-state', '已连接');
    const sshId = (await page.locator('#tabs [aria-selected=true]').getAttribute('id')).slice(4);
    const serialIds = [];
    for (const path of ['COM3', 'COM12']) {
      await page.locator('#quick-serial').click(); await page.locator('#connect-form [name=path]').fill(path); await page.locator('#connect-form [name=name]').fill(path + ' 测试板');
      await page.locator('#connect-now').click(); await state('#global-state', '已连接');
      serialIds.push((await page.locator('#tabs [aria-selected=true]').getAttribute('id')).slice(4));
      await page.locator('.surface:visible .timer-collapse').click();
      await electron.evaluate((_e, path) => globalThis.fixture.feedPort(path, [...Buffer.from(path + '_LIVE_FIRST\r\n# ')]), path);
    }
    await page.locator('#open-ai-chat').click();
    for (const input of await page.locator('#ai-sources input:checked').all()) await input.uncheck();
    await page.locator(`#ai-sources input[data-source-id="${sshId}"]`).check();
    await page.locator(`#ai-sources input[data-source-id="${serialIds[0]}"]`).check();
    await send('比较 SSH 和 COM3 当前发生了什么');
    await until(async () => (await page.locator('.ai-assistant').count()) === 2, 'automatic viewport read');
    let body = JSON.stringify((await requests()).at(-1).body.messages);
    assert(body.includes('SSH_LIVE_FIRST') && body.includes('COM3_LIVE_FIRST') && !body.includes('COM12_LIVE_FIRST'));
    assert.equal(await sent('COM3'), ''); assert.equal(await sent('COM12'), '');
    stream.write('\r\nSSH_UPDATED_WITHOUT_MANUAL_READ\r\n$ ');
    await sleep(100); await send('现在的新输出是什么？');
    await until(async () => (await page.locator('.ai-assistant').count()) === 3, 'follow-up refresh');
    assert(JSON.stringify((await requests()).at(-1).body.messages).includes('SSH_UPDATED_WITHOUT_MANUAL_READ'));
    await page.locator(`#ai-sources input[data-source-id="${sshId}"]`).uncheck();
    await send('只看当前所选串口'); await until(async () => (await page.locator('.ai-assistant').count()) === 4, 'changed scope');
    body = JSON.stringify((await requests()).at(-1).body.messages);
    assert(!body.includes('SSH_UPDATED_WITHOUT_MANUAL_READ'));
    assert(!(await requests()).at(-1).body.messages.some(m => m.role === 'assistant'));

    await page.locator('#ai-mode').selectOption('serial'); await page.locator('#ai-serial-target').selectOption(serialIds[0]);
    await fixture('aiPlans', [
      { reply: '查看内存', action: { type: 'send', text: 'free -m', lineEnding: 'CR', waitMs: 1000 } },
      { reply: '根据内存结果查看系统', action: { type: 'send', text: 'uname -a', lineEnding: 'LF', waitMs: 1000 } },
      { reply: '已确认内存和系统信息。', action: null },
    ]);
    await electron.evaluate(() => globalThis.fixture.serialReplies('COM3', [['free -m\r', 'MEMORY_RESULT_1024\r\n# '], ['uname -a\n', 'KERNEL_RESULT_LINUX\r\n# ']]));
    const before = (await requests()).length;
    await send('帮我检查这块板卡的内存和系统，直接操作 COM3');
    await page.locator('#ai-cancel').waitFor();
    assert(await page.locator('#ai-mode').isDisabled()); assert(await page.locator('#ai-serial-target').isDisabled());
    await page.locator('#surface-' + serialIds[1] + ' .xterm-helper-textarea').focus(); await page.keyboard.type('OTHER');
    await state('#ai-status', '本轮结束：2 次实际写入');
    assert.equal(await sent('COM3'), 'free -m\runame -a\n'); assert.equal(await sent('COM12'), 'OTHER');
    const autoRequests = (await requests()).slice(before);
    assert.equal(autoRequests.length, 3);
    assert(JSON.stringify(autoRequests[1].body.messages).includes('MEMORY_RESULT_1024'));
    assert(JSON.stringify(autoRequests[2].body.messages).includes('KERNEL_RESULT_LINUX'));
    assert((await page.locator('.ai-action').allTextContents()).some(t => t.includes('串口已确认写入')));
    await page.screenshot({ path: join(directory, 'dialog-verified.png') });
    const count = await page.locator('.ai-message').count(); await page.locator('#ai-popout').click();
    assert.equal(await page.locator('#ai-dialog').evaluate(el => el.open), false);
    assert.equal(await page.locator('.ai-message').count(), count);
    await page.locator('#ai-popout').click(); assert(await page.locator('#ai-dialog').evaluate(el => el.open));

    await fixture('aiPlans', [{ reply: '等待', action: { type: 'wait', waitMs: 10000 } }, { reply: '不应发送', action: { type: 'send', text: 'MUST_NOT_SEND', lineEnding: 'CR', waitMs: 250 } }]);
    await send('等一下串口输出'); await page.locator('#ai-cancel').waitFor(); await state('#ai-status', '等待');
    await page.locator('#ai-cancel').click(); await state('#ai-status', '已取消'); await sleep(100);
    assert(!(await sent('COM3')).includes('MUST_NOT_SEND'));
    await fixture('aiPlans', [{ reply: '等待关闭窗口测试', action: { type: 'wait', waitMs: 10000 } }]);
    await send('观察后续输出'); await state('#ai-status', '等待关闭窗口');
    await page.locator('#ai-collapse').click(); await page.locator('#open-ai-chat').click(); await state('#ai-status', '已取消');
    await fixture('aiPlans', [{ reply: '等待手动接管测试', action: { type: 'wait', waitMs: 10000 } }]);
    await send('继续观察'); await state('#ai-status', '等待手动接管');
    await page.locator('#tab-' + serialIds[0]).click(); await page.locator('#surface-' + serialIds[0] + ' .xterm-helper-textarea').focus(); await page.keyboard.type('x');
    await state('#ai-status', '手动输入已停止');
    await send('再继续'); await state('#ai-status', '未结束的手动输入');
    await page.locator('#surface-' + serialIds[0] + ' .xterm-helper-textarea').focus(); await page.keyboard.press('Control+c');
    await electron.evaluate(() => globalThis.fixture.feedPort('COM3', [...Buffer.from('\r\n# ')])); await sleep(450);
    await fixture('aiPlans', [{ reply: '等待断线测试', action: { type: 'wait', waitMs: 10000 } }]);
    await send('继续等'); await state('#ai-status', '等待断线'); await fixture('disconnectPort', 'COM3'); await state('#ai-status', '串口已断开');
    assert.equal(await page.locator('#ai-serial-target').inputValue(), serialIds[0]);
    await send('断线后继续'); await state('#ai-status', '选择已连接');
    assert.equal(await sent('COM12'), 'OTHER');
    await page.locator('#ai-new-chat').click();
    assert.equal(await page.locator('#ai-mode').inputValue(), 'chat');
    assert.equal(await page.locator('.ai-message').count(), 0);
    assert.deepEqual(errors, []);
    console.log('AI popup/dock, direct questions, live SSH/serial context, automatic serial write/read loop, fixed target across focus changes, stop, manual takeover, pending input and disconnect guards OK. Evidence: ' + directory);
  } finally { await electron.close(); for (const client of clients) client.end(); await new Promise(r => ssh.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
