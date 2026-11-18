const assert = require('node:assert/strict');
const { generateKeyPairSync, createHash } = require('node:crypto');
const { mkdir, mkdtemp, readFile, readdir, writeFile, rename, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { build } = require('esbuild');
const { _electron } = require('playwright');
const { Server } = require('ssh2');

async function until(fn, label) {
  for (let n = 0; n < 100; n++) { const result = await fn(); if (result) return result; await sleep(60); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/ai-'));
  await build({ entryPoints: ['tests/app-fixture.ts'], outfile: 'dist/test-ai.cjs', bundle: true,
    platform: 'node', external: ['electron', 'serialport', 'ssh2'] });
  const streams = [];
  const inputs = [];
  const clients = new Set();
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const ssh = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === 'test-password' ? ctx.accept() : ctx.reject(['password']));
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', accept => accept()); session.on('window-change', accept => accept?.());
      session.on('shell', accept => {
        const stream = accept(); const n = streams.length;
        streams.push(stream); inputs.push([]);
        stream.on('data', data => inputs[n].push(...data));
        stream.write(`SSH_${n}_ONLY ERROR fixture\r\n$ `);
      });
    }));
  });
  await new Promise(r => ssh.listen(0, '127.0.0.1', r));
  const port = ssh.address().port;
  let electron;
  const errors = [];
  const launch = () => _electron.launch({ args: ['dist/test-ai.cjs'], env: { ...process.env, TERMDOCK_TEST_DATA: directory } });
  try {
    electron = await launch();
    let page = await electron.firstWindow();
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => errors.push(e.message));
    const state = (selector, text) => page.waitForFunction(([selector, text]) => document.querySelector(selector)?.textContent.includes(text), [selector, text]);
    const button = name => page.getByRole('button', { name, exact: true }).click();
    const more = async name => { await page.locator('#top-more').click(); await page.getByRole('menuitem', { name, exact: true }).click(); };
    const configure = async () => { await page.locator('#settings').click(); await page.locator('#settings-ai-tab').click(); await until(() => page.locator('#ai-settings-status').textContent().then(t => t !== '读取配置…'), 'settings loaded'); };
    const save = async () => { await page.locator('#ai-save').click(); await state('#ai-settings-status', '配置已保存'); };
    const test = async () => { await page.locator('#ai-test').click(); };
    const requests = () => electron.evaluate(() => globalThis.fixture.aiRequests());
    const mode = value => electron.evaluate((_e, value) => globalThis.fixture.aiMode(value), value);
    const closeSettings = () => page.locator('#settings-dialog [data-dismiss]').first().click();
    await configure();
    assert.equal(await page.locator('#ai-model').inputValue(), 'GLM-5.3-Flash-NVFP4');
    assert.equal(await page.locator('#ai-key').getAttribute('type'), 'password');
    await page.locator('#ai-key').fill('fixture-ai-old');
    await save();
    await state('#ai-key-status', '已保存');
    assert.equal(await page.locator('#ai-key').inputValue(), '');
    await test(); await state('#ai-settings-status', '调用成功：OK');
    let sent = (await requests()).at(-1);
    assert.equal(sent.url, 'https://llm.amlogic.com/v1/chat/completions');
    assert.equal(sent.authorization, 'Bearer fixture-ai-old');
    assert.deepEqual(sent.body, { model: 'GLM-5.3-Flash-NVFP4', messages: [{ role: 'user', content: 'Reply with OK only.' }], max_tokens: 500 });
    await page.locator('#ai-model').fill('DeepSeek-V4.1-Flash-1017'); await save(); await test();
    await state('#ai-settings-status', '调用成功：OK');
    assert.equal((await requests()).at(-1).body.model, 'DeepSeek-V4.1-Flash-1017');
    assert.equal((await requests()).at(-1).authorization, 'Bearer fixture-ai-old');
    await page.locator('#ai-model').fill('custom-exact-model.20261118');
    await page.locator('#ai-key').fill('fixture-ai-new'); await save(); await test();
    await state('#ai-settings-status', '调用成功：OK');
    assert.equal((await requests()).at(-1).authorization, 'Bearer fixture-ai-new');
    assert.equal((await requests()).at(-1).body.model, 'custom-exact-model.20261118');
    for (const [failure, expected] of [['auth', '认证失败'], ['model', '模型不可用'], ['network', '连接失败'], ['empty', '空响应'], ['length', '上下文过长'], ['invalid', '格式无效'], ['pending', '超时']]) {
      await mode(failure); await test(); await state('#ai-settings-status', expected);
      assert(!(await page.locator('#ai-settings-status').textContent()).includes('fixture-key-must-never-leak'));
    }
    await mode('ok');
    const aiPath = join(directory, 'credentials', createHash('sha256').update('TermDock.AI.ApiKey.v1').digest('hex') + '.dpapi');
    assert(!(await readFile(aiPath)).includes('fixture-ai-new'));
    await closeSettings();
    await writeFile(aiPath, Buffer.from('corrupt-dpapi-fixture'));
    await configure(); await state('#ai-settings-status', 'Windows 无法');
    await page.locator('#ai-key').fill('fixture-ai-new'); await save(); await closeSettings();
    const credentialsDir = join(directory, 'credentials');
    const backupDir = join(directory, 'credentials-backup');
    await rename(credentialsDir, backupDir);
    await writeFile(credentialsDir, 'test-only directory obstruction');
    try {
      await configure(); await page.locator('#ai-key').fill('fixture-write-must-fail');
      await page.locator('#ai-save').click(); await state('#ai-settings-status', '保存失败');
      assert(!(await page.locator('#ai-key-status').textContent()).startsWith('已保存'));
      assert(!(await readFile(join(directory, 'settings.json'), 'utf8')).includes('fixture-write-must-fail'));
      await closeSettings();
    } finally { await rm(credentialsDir); await rename(backupDir, credentialsDir); }
    console.log('AI fixed URL, exact models, DPAPI replacement, model-only save, corrupt-key recovery and safe error classes OK');

    // Two SSH buffers, one serial buffer and a local shell; only SSH/serial are eligible.
    for (let i = 0; i < 2; i++) {
      await page.locator('#quick-ssh').click();
      for (const [name, value] of Object.entries({ host: '127.0.0.1', port, username: 'tester', name: 'AI SSH ' + i, password: 'test-password' })) {
        await page.locator(`#connect-form [name=${name}]`).fill(String(value));
      }
      await button('连接');
      if (i === 0) { await page.locator('#key-dialog').waitFor(); await button('信任并连接'); }
      await state('#global-state', '已连接');
    }
    await page.locator('#quick-serial').click();
    await page.locator('#connect-form [name=path]').fill('COM77');
    await button('连接'); await state('#global-state', '已连接');
    await electron.evaluate(() => globalThis.fixture.feed([...Buffer.from('SERIAL_ONLY U-Boot BOOT_FAILED\r\n# ')]));
    const serialTab = page.getByRole('tab', { name: 'PL2303', exact: true });
    const serialId = (await serialTab.getAttribute('id')).slice(4);
    await more('AI 日志分析');
    assert.equal(await page.locator('#ai-sources input:checked').count(), 1);
    assert.equal(await page.locator('#ai-sources input:checked').getAttribute('data-source-id'), serialId);
    await page.locator('#ai-collapse').click();
    await page.locator('#quick-local').click(); await state('#global-state', '已连接');
    await page.getByRole('tab', { name: 'AI SSH 0', exact: true }).click();
    await button('左右分屏');
    await page.locator('#split-first').selectOption({ label: await page.locator('#split-first option').filter({ hasText: 'AI SSH 0' }).textContent() });
    await page.locator('#split-second').selectOption(serialId);
    await button('应用分屏');
    await more('AI 日志分析');
    assert.equal(await page.locator('#ai-sources input').count(), 3);
    const ssh0 = page.getByRole('tab', { name: 'AI SSH 0', exact: true });
    const ssh0Id = (await ssh0.getAttribute('id')).slice(4);
    await page.locator(`#ai-sources input[data-source-id="${ssh0Id}"]`).check();
    const activeBefore = await page.locator('#tabs [role=tab][aria-selected=true]').getAttribute('id');
    const countBefore = (await requests()).length;
    await sleep(100);
    assert.equal((await requests()).length, countBefore, 'checkboxes never submit');
    await page.locator('#ai-read').click();
    await page.locator('.ai-assistant').waitFor();
    assert.equal(await page.locator('#tabs [role=tab][aria-selected=true]').getAttribute('id'), activeBefore);
    let context = JSON.stringify((await requests()).at(-1).body.messages);
    assert(context.includes('SSH_0_ONLY') && context.includes('SERIAL_ONLY'));
    assert(!context.includes('SSH_1_ONLY'));
    assert(context.includes('左侧窗格') && context.includes('右侧窗格'));
    await page.locator('#ai-question').fill('继续比较两个来源'); await page.locator('#ai-send').click();
    await until(async () => (await page.locator('.ai-assistant').count()) === 2, 'follow-up reply');
    assert((await requests()).at(-1).body.messages.some(item => item.role === 'assistant'));
    await electron.evaluate(() => globalThis.fixture.feed([...Buffer.from('\r\nSERIAL_UPDATED kernel panic\r\n# ')]));
    await page.locator(`#ai-sources input[data-source-id="${ssh0Id}"]`).uncheck();
    await sleep(100); await page.locator('#ai-read').click();
    await until(async () => (await page.locator('.ai-assistant').count()) === 3, 'refreshed reply');
    context = JSON.stringify((await requests()).at(-1).body.messages);
    assert(context.includes('SERIAL_UPDATED') && !context.includes('SSH_0_ONLY') && !context.includes('SSH_1_ONLY'));
    assert.equal((await requests()).at(-1).body.messages.filter(item => item.role === 'assistant').length, 0, 'old context is replaced');

    // Read the hidden SSH tab without selecting it.
    const ssh1Id = (await page.getByRole('tab', { name: 'AI SSH 1', exact: true }).getAttribute('id')).slice(4);
    await page.locator(`#ai-sources input[data-source-id="${serialId}"]`).uncheck();
    await page.locator(`#ai-sources input[data-source-id="${ssh1Id}"]`).check();
    await page.locator('#ai-read').click(); await until(async () => (await page.locator('.ai-assistant').count()) === 4, 'background read');
    context = JSON.stringify((await requests()).at(-1).body.messages);
    assert(context.includes('SSH_1_ONLY') && !context.includes('SERIAL_UPDATED'));
    assert.equal(await page.locator('#tabs [role=tab][aria-selected=true]').getAttribute('id'), activeBefore);
    await button('关闭 AI SSH 1');
    const beforeClosed = (await requests()).length;
    await page.locator('#ai-read').click(); await state('#ai-status', '已关闭');
    assert.equal((await requests()).length, beforeClosed, 'all closed sources never submit');
    await page.locator(`#ai-sources input[data-source-id="${serialId}"]`).check();
    await page.locator('#ai-read').click(); await until(async () => (await page.locator('.ai-assistant').count()) === 5, 'partial closed read');
    await state('#ai-context', '已关闭');
    await page.locator(`#ai-sources input[data-source-id="${serialId}"]`).uncheck();
    await page.locator(`#ai-sources input[data-source-id="${ssh0Id}"]`).check();
    streams[0].write('\x1b[2J\x1b[H'); await sleep(120);
    const beforeEmpty = (await requests()).length;
    await page.locator('#ai-read').click(); await state('#ai-status', '当前视口为空');
    assert.equal((await requests()).length, beforeEmpty, 'empty and closed sources never submit');
    await page.locator(`#ai-sources input[data-source-id="${ssh0Id}"]`).uncheck();
    await page.locator(`#ai-sources input[data-source-id="${serialId}"]`).check();

    // Select actual xterm text by mouse, then open the menu (which must retain the original selection).
    await serialTab.click();
    const serialSurface = page.locator('#surface-' + serialId);
    const screen = await serialSurface.locator('.xterm-screen').boundingBox();
    await page.mouse.move(screen.x + 1, screen.y + 10); await page.mouse.down();
    await page.mouse.move(screen.x + Math.min(240, screen.width - 10), screen.y + 10, { steps: 8 }); await page.mouse.up();
    await more('分析选中日志');
    await until(async () => (await page.locator('.ai-assistant').count()) === 6, 'selected log reply');
    context = JSON.stringify((await requests()).at(-1).body.messages);
    assert(context.includes('选中日志') && context.includes('SERIAL_ONLY') && !context.includes('SERIAL_UPDATED'));
    await mode('pending');
    await page.locator('#ai-read').click(); await page.locator('#ai-cancel').waitFor();
    await serialSurface.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('typing-live');
    await until(() => electron.evaluate(() => Buffer.from(globalThis.fixture.sent()).includes('typing-live')), 'terminal usable during AI request');
    await page.locator('#ai-cancel').click(); await state('#ai-status', '已取消');
    await mode('ok');
    const widthBefore = (await page.locator('.terminal-area').boundingBox()).width;
    const messageCount = await page.locator('.ai-message').count();
    await page.locator('#ai-collapse').click();
    await until(async () => (await page.locator('.terminal-area').boundingBox()).width > widthBefore, 'collapse restores width');
    await more('AI 日志分析'); assert.equal(await page.locator('.ai-message').count(), messageCount);
    await page.screenshot({ path: join(directory, 'ai-verified.png') });
    for (const filename of ['settings.json', 'sessions.json']) {
      const text = await readFile(join(directory, filename), 'utf8');
      assert(!text.includes('fixture-ai-new') && !text.includes('fixture-ai-old'));
    }
    console.log('AI multi-pane same-batch read, background read, scope isolation, follow-up, refresh, closed sources, real selection, cancellation and live terminal OK');
    assert.deepEqual(errors, []);

    await electron.close(); electron = await launch(); page = await electron.firstWindow();
    await configure();
    assert.equal(await page.locator('#ai-model').inputValue(), 'custom-exact-model.20261118');
    await state('#ai-key-status', '已保存');
    await test(); await state('#ai-settings-status', '调用成功：OK');
    assert.equal((await requests()).at(-1).authorization, 'Bearer fixture-ai-new');
    await page.locator('#ai-clear-key').click(); await state('#ai-settings-status', '已清除');
    assert(!(await readdir(join(directory, 'credentials'))).includes(aiPath.split(/[\\/]/).at(-1)));
    await electron.close(); electron = await launch(); page = await electron.firstWindow();
    await configure(); await state('#ai-key-status', '尚未保存'); await test(); await state('#ai-settings-status', '请先');
    assert.equal((await requests()).length, 0);
    console.log('AI Windows DPAPI save/restart, clear/restart and no-Key guard OK. Evidence: ' + directory);
  } finally {
    if (electron) await electron.close();
    for (const client of clients) client.end();
    await new Promise(r => ssh.close(r));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
