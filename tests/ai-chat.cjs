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
    const question = page.locator('#ai-question');
    const card = page.locator('#ai-interaction');
    const allow = () => card.getByRole('button', { name: '允许本次' }).click();
    await page.locator('#open-ai-chat').click();
    assert(await page.locator('#ai-dialog').evaluate(el => el.open && !el.matches(':modal')));
    const dialogBefore = await page.locator('#ai-dialog').boundingBox();
    const titleBox = await page.locator('.ai-heading h2').boundingBox();
    await page.mouse.move(titleBox.x + 15, titleBox.y + 5); await page.mouse.down();
    await page.mouse.move(titleBox.x + 55, titleBox.y + 15, { steps: 5 }); await page.mouse.up();
    assert((await page.locator('#ai-dialog').boundingBox()).x > dialogBefore.x + 20);
    await page.locator('#ai-configure').click(); await state('#ai-key-status', '尚未保存');
    await page.locator('#ai-key').fill('fixture-chat-key'); await page.locator('#ai-save').click(); await state('#ai-settings-status', '配置已保存');
    const settingsSecret = page.locator('#ai-settings-key-secret');
    await settingsSecret.getByRole('button', { name: '显示' }).click();
    await state('#ai-settings-key-secret output', 'fixture-chat-key');
    await page.locator('#ai-model-add').click(); await page.locator('#ai-model-new').fill('  Custom-Model-V4  ');
    await page.locator('#ai-model-confirm').click(); await state('#ai-settings-status', '模型已保存并选中');
    assert.equal(await page.locator('#ai-model').inputValue(), 'Custom-Model-V4');
    await page.locator('#ai-model-add').click(); await page.locator('#ai-model-new').fill('Custom-Model-V4');
    await page.locator('#ai-model-confirm').click(); await state('#ai-settings-status', '模型已保存并选中');
    assert.equal(await page.locator('#ai-model option[value="Custom-Model-V4"]').count(), 1);
    await page.locator('#settings-dialog [data-dismiss]').first().click();
    await state('#ai-current-model', 'Custom-Model-V4');
    assert.equal(await page.locator('#ai-panel-key-secret output').textContent(), '••••••••');
    await page.locator('#ai-panel-key-secret button').click(); await state('#ai-panel-key-secret output', 'fixture-chat-key');
    await page.locator('#ai-panel-key-secret button').click();
    await question.fill('我可以直接问 Linux 问题吗？');
    await question.press('End'); await question.press('Alt+Enter'); await question.pressSequentially('second line');
    assert.equal(await question.inputValue(), '我可以直接问 Linux 问题吗？\nsecond line');
    await question.evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    });
    assert.equal((await requests()).length, 0);
    await question.press('Enter'); await until(async () => (await page.locator('.ai-assistant').count()) === 1, 'direct general chat');
    assert.equal((await requests()).at(-1).body.messages.at(-1).content, '我可以直接问 Linux 问题吗？\nsecond line');
    assert.equal((await requests()).at(-1).body.model, 'Custom-Model-V4');
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

    const thinking = page.locator('#ai-effort');
    for (const level of ['', 'low', 'high', 'max']) {
      await thinking.selectOption(level);
      await send('验证思考挡位 ' + (level || 'default'));
      await page.locator('#ai-send:enabled').waitFor();
      assert.equal((await requests()).at(-1).body.reasoning_effort, level || undefined);
    }
    await fixture('aiMode', 'unsupported-effort');
    await send('保留此消息以便重试'); await state('#ai-status', '不支持所选思考挡位');
    await page.waitForFunction(() => document.querySelector('#ai-effort option[value=max]').disabled);
    assert.equal(await question.inputValue(), '保留此消息以便重试');
    await thinking.selectOption('low');
    await fixture('aiMode', 'unsupported-stream');
    const fallbackBefore = (await requests()).length;
    await page.locator('#ai-retry').click(); await page.locator('#ai-send:enabled').waitFor();
    assert.deepEqual((await requests()).slice(fallbackBefore).map(request => request.body.stream), [true, undefined]);
    await fixture('aiMode', 'sse');
    await send('验证实时回复'); await state('#ai-phase', '等待模型响应');
    await state('#ai-elapsed', '0:01'); await state('#ai-phase', '模型思考中');
    await state('#ai-phase', '生成回复中'); await state('.ai-assistant:last-child > div', '实时第一段');
    await page.locator('#ai-send:enabled').waitFor();
    assert.equal(await page.locator('.ai-assistant').last().locator('div').textContent(), '实时第一段，实时第二段。');
    assert(await page.locator('#ai-progress').isHidden());
    await fixture('aiMode', 'ok');

    // Hold half a command while the serial port sends data. A read-only question must still complete.
    await page.locator('#tab-' + serialIds[0]).click();
    await page.locator('#surface-' + serialIds[0] + ' .xterm-helper-textarea').focus(); await page.keyboard.type('half');
    const busyFeeder = setInterval(() => electron.evaluate(() => globalThis.fixture.feedPort('COM3', [...Buffer.from('BUSY_OUTPUT\r\n')])).catch(() => {}), 40);
    try { await send('持续输出期间的只读问题'); await page.locator('#ai-send:enabled').waitFor(); }
    finally { clearInterval(busyFeeder); }
    assert.equal(await sent('COM3'), 'half');
    await page.locator('#ai-mode').selectOption('serial'); await page.locator('#ai-serial-target').selectOption(serialIds[0]);
    await fixture('aiPlans', [{ reply: '手动输入冲突', action: { type: 'send', text: 'MUST_NOT_WRITE', lineEnding: 'CR', waitMs: 250 } }]);
    await send('尝试发送到串口'); await allow(); await state('#ai-status', 'COM3 有未结束的手动输入');
    assert.equal(await sent('COM3'), 'half');
    await page.locator('#surface-' + serialIds[0] + ' .xterm-helper-textarea').focus(); await page.keyboard.press('Control+c');

    await page.locator('#ai-mode').selectOption('serial'); await page.locator('#ai-serial-target').selectOption(serialIds[0]);
    await fixture('aiPlans', [
      { reply: '查看内存', action: { type: 'send', text: 'free -m', lineEnding: 'CR', waitMs: 1000 } },
      { reply: '根据内存结果查看系统', action: { type: 'send', text: 'uname -a', lineEnding: 'LF', waitMs: 1000 } },
      { reply: '已确认内存和系统信息。', action: null },
    ]);
    await electron.evaluate(() => globalThis.fixture.serialReplies('COM3', [['free -m\r', 'MEMORY_RESULT_1024\r\n# '], ['uname -a\n', 'KERNEL_RESULT_LINUX\r\n# ']]));
    const before = (await requests()).length;
    await send('帮我检查这块板卡的内存和系统，直接操作 COM3');
    await card.getByRole('button', { name: '允许本次' }).waitFor();
    assert.equal(await sent('COM3'), 'half\x03');
    assert(await page.locator('#ai-mode').isDisabled()); assert(await page.locator('#ai-serial-target').isDisabled());
    await page.locator('#tab-' + serialIds[1]).click();
    await page.locator('#surface-' + serialIds[1] + ' .xterm-helper-textarea').focus(); await page.keyboard.type('OTHER');
    await allow(); await allow();
    await state('#ai-status', '本轮结束：2 次实际写入');
    assert.equal(await sent('COM3'), 'half\x03free -m\runame -a\n'); assert.equal(await sent('COM12'), 'OTHER');
    const autoRequests = (await requests()).slice(before);
    assert.equal(autoRequests.length, 3);
    assert(JSON.stringify(autoRequests[1].body.messages).includes('MEMORY_RESULT_1024'));
    assert(JSON.stringify(autoRequests[2].body.messages).includes('KERNEL_RESULT_LINUX'));
    assert(autoRequests.every(request => request.body.reasoning_effort === 'low'));
    assert((await page.locator('.ai-action').allTextContents()).some(t => t.includes('串口已确认写入')));
    await page.screenshot({ path: join(directory, 'dialog-verified.png') });
    const count = await page.locator('.ai-message').count(); await page.locator('#ai-popout').click();
    assert.equal(await page.locator('#ai-dialog').evaluate(el => el.open), false);
    assert.equal(await page.locator('.ai-message').count(), count);
    await page.locator('#ai-popout').click(); assert(await page.locator('#ai-dialog').evaluate(el => el.open));

    for (const choice of ['不允许', '关闭确认窗口']) {
      const baseline = await sent('COM3');
      await fixture('aiPlans', [{ reply: '是否授权本轮写入 COM3？', action: { type: 'send', text: 'MUST_NOT_SEND', lineEnding: 'CR', waitMs: 250 } }]);
      await send('验证拒绝及关闭');
      await card.getByRole('button', { name: choice, exact: true }).click();
      await state('.ai-assistant:last-child > div', '写入未获允许');
      assert.equal(await sent('COM3'), baseline);
    }
    await page.locator('#ai-serial-target').selectOption('');
    await fixture('aiPlans', [
      { reply: '', action: { type: 'ask', prompt: '请选择实际串口', answerType: 'serial' } },
      { reply: '', action: { type: 'ask', prompt: '设备提示符是什么？', answerType: 'text' } },
      { reply: '', action: { type: 'ask', prompt: '选择要看的信息', answerType: 'multiple', options: ['内存', '内核', '版本'] } },
      { reply: '', action: { type: 'ask', prompt: '现在结束本轮吗？', answerType: 'confirm' } },
      { reply: '已收到填写的条件', action: null },
    ]);
    await send('按需询问我需要的信息');
    await card.getByRole('radio', { name: /COM3/ }).check(); await card.getByRole('button', { name: '提交回答' }).click();
    await card.getByRole('textbox').fill('~ #'); await card.getByRole('button', { name: '提交回答' }).click();
    await card.getByRole('checkbox', { name: '内存' }).check(); await card.getByRole('checkbox', { name: '版本' }).check();
    await card.getByRole('button', { name: '提交回答' }).click();
    await card.getByRole('button', { name: '是', exact: true }).click(); await state('.ai-assistant:last-child > div', '已收到填写的条件');
    const replies = JSON.stringify((await requests()).at(-1).body.messages.filter(item => item.role === 'user'));
    assert(replies.includes('收到用户回答') && replies.includes('~ #') && replies.includes('内存') && replies.includes('版本'));
    await page.locator('#ai-serial-target').selectOption(serialIds[0]);

    await fixture('aiPlans', [{ reply: '等待', action: { type: 'wait', waitMs: 10000 } }, { reply: '不应发送', action: { type: 'send', text: 'MUST_NOT_SEND', lineEnding: 'CR', waitMs: 250 } }]);
    await send('等一下串口输出'); await page.locator('#ai-cancel').waitFor(); await state('#ai-status', '等待');
    await page.locator('#ai-cancel').click(); await state('#ai-status', '已取消'); await sleep(100);
    assert(!(await sent('COM3')).includes('MUST_NOT_SEND'));
    await fixture('aiPlans', [{ reply: '等待关闭窗口测试', action: { type: 'wait', waitMs: 10000 } }]);
    await send('观察后续输出'); await state('#ai-status', '等待串口新输出');
    await page.locator('#ai-collapse').click(); await page.locator('#open-ai-chat').click(); await state('#ai-status', '已取消');
    await fixture('aiPlans', [{ reply: '等待手动接管测试', action: { type: 'wait', waitMs: 10000 } }]);
    await send('继续观察'); await state('#ai-status', '等待串口新输出');
    await page.locator('#tab-' + serialIds[0]).click(); await page.locator('#surface-' + serialIds[0] + ' .xterm-helper-textarea').focus(); await page.keyboard.type('x');
    await state('#ai-status', '手动输入已停止');
    await fixture('aiPlans', [{ reply: '尝试发送', action: { type: 'send', text: 'MUST_NOT_SEND', lineEnding: 'CR', waitMs: 250 } }]);
    await send('再继续'); await allow(); await state('#ai-status', '未结束的手动输入');
    await page.locator('#surface-' + serialIds[0] + ' .xterm-helper-textarea').focus(); await page.keyboard.press('Control+c');
    await electron.evaluate(() => globalThis.fixture.feedPort('COM3', [...Buffer.from('\r\n# ')])); await sleep(450);
    await fixture('aiPlans', [{ reply: '等待断线测试', action: { type: 'wait', waitMs: 10000 } }]);
    await send('继续等'); await state('#ai-status', '等待串口新输出'); await fixture('disconnectPort', 'COM3'); await state('#ai-status', '串口已断开');
    assert.equal(await page.locator('#ai-serial-target').inputValue(), serialIds[0]);
    await send('断线后继续'); await state('#ai-status', '选择已连接');
    assert.equal(await sent('COM12'), 'OTHER');
    await page.locator('#ai-new-chat').click();
    assert.equal(await page.locator('#ai-mode').inputValue(), 'chat');
    assert.equal(await thinking.inputValue(), '');
    assert.equal(await page.locator('.ai-message').count(), 0);
    assert.deepEqual(errors, []);
    console.log('AI popup/dock, direct questions, live SSH/serial context, automatic serial write/read loop, fixed target across focus changes, stop, manual takeover, pending input and disconnect guards OK. Evidence: ' + directory);
  } finally { await electron.close(); for (const client of clients) client.end(); await new Promise(r => ssh.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
