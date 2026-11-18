const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const { mkdir, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { createServer } = require('node:net');
const { chromium } = require('playwright');
const { Server } = require('ssh2');
const { releaseVersion } = require('../package.json');
async function until(fn, label) {
  for (let n = 0; n < 180; n++) { const result = await fn(); if (result) return result; await sleep(80); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  const archive = resolve(`release/TermDock-${releaseVersion}-win-x64.zip`);
  await mkdir('test-output', { recursive: true });
  const folder = await mkdtemp(resolve('test-output/portable-ai-'));
  assert.equal(spawnSync('tar.exe', ['-xf', archive, '-C', folder], { windowsHide: true }).status, 0);
  const profile = join(folder, 'profile'); await mkdir(profile);
  const records = join(folder, 'mock-requests.jsonl');
  const worker = join(folder, 'TermDock/backend/worker.cjs');
  const productionWorker = await readFile(worker, 'utf8');
  // Test-only injection into this extracted copy. The release archive is never modified.
  // This exercises native WebView2 -> C# IPC -> the bundled Node worker -> AI service.
  await writeFile(worker, `{
    const tdFs = require('node:fs');
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      tdFs.appendFileSync(process.env.TD_TEST_RECORDS, JSON.stringify({url,body,
        authenticated: options.headers.Authorization === 'Bearer portable-fixture-key'}) + '\\n');
      return new Response(JSON.stringify({choices:[{message:{content: body.max_tokens === 500 ? 'OK' : '事实：SSH 来源出现 ERROR_NATIVE。推测：待检查配置。'}}]}));
    };
  }\n` + productionWorker);
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set(); let shellCount = 0;
  const ssh = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === 'password' ? ctx.accept() : ctx.reject(['password']));
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', accept => accept()); session.on('window-change', accept => accept?.());
      session.on('shell', accept => { accept().write(`NATIVE_${shellCount++}_ONLY ERROR_NATIVE\r\n$ `); });
    }));
  });
  await new Promise(r => ssh.listen(0, '127.0.0.1', r));
  const launch = () => spawn(join(folder, 'TermDock/TermDock.exe'), [], { stdio: 'ignore', env: {
    ...process.env, TERMDOCK_DATA_DIR: profile, TD_TEST_RECORDS: records,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  } });
  let child;
  const close = async () => {
    if (child && child.exitCode === null && child.pid) {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid} -ErrorAction Stop).CloseMainWindow() | Out-Null`], { windowsHide: true });
      await until(() => child.exitCode !== null, 'graceful native close');
    }
  };
  const connect = async () => {
    const endpoint = `http://127.0.0.1:${port}`;
    await until(() => fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(300) }).then(r => r.ok, () => false), 'WebView2');
    const browser = await chromium.connectOverCDP(endpoint);
    return until(() => browser.contexts().flatMap(ctx => ctx.pages()).find(p => p.url().includes('termdock.local/index.html')), 'native page');
  };
  const requests = async () => (await readFile(records, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  try {
    child = launch(); let page = await connect(); page.setDefaultTimeout(8000);
    const state = (selector, text) => page.waitForFunction(([selector, text]) => document.querySelector(selector)?.textContent.includes(text), [selector, text]);
    const configure = async () => { await page.locator('#settings').click(); await page.locator('#settings-ai-tab').click(); await until(() => page.locator('#ai-key-status').textContent().then(Boolean), 'AI settings loaded'); };
    await configure(); await page.locator('#ai-model').fill('DeepSeek-V4.1-Flash-1017');
    await page.locator('#ai-key').fill('portable-fixture-key'); await page.locator('#ai-save').click(); await state('#ai-settings-status', '配置已保存');
    await page.locator('#ai-test').click(); await state('#ai-settings-status', '调用成功：OK');
    assert((await requests()).at(-1).authenticated);
    assert.equal((await requests()).at(-1).body.model, 'DeepSeek-V4.1-Flash-1017');
    await page.locator('#settings-dialog [data-dismiss]').first().click();
    for (let i = 0; i < 2; i++) {
      await page.locator('#quick-ssh').click();
      for (const [name, value] of Object.entries({ host: '127.0.0.1', port: ssh.address().port, username: 'tester', password: 'password', name: 'Native SSH ' + i })) {
        await page.locator(`#connect-form [name=${name}]`).fill(String(value));
      }
      await page.locator('#connect-now').click();
      if (i === 0) { await page.locator('#key-dialog').waitFor(); await page.locator('#accept-key').click(); }
      await state('#global-state', '已连接');
    }
    await page.locator('#top-more').click(); await page.getByRole('menuitem', { name: 'AI 日志分析', exact: true }).click();
    assert.equal(await page.locator('#ai-sources input').count(), 2);
    const active = await page.locator('#tabs [aria-selected=true]').getAttribute('id');
    await page.locator('#ai-sources input').first().check();
    await page.locator('#ai-read').click(); await page.locator('.ai-assistant').waitFor();
    const req = (await requests()).at(-1);
    assert(req.authenticated);
    assert.equal(req.url, 'https://llm.amlogic.com/v1/chat/completions');
    const context = JSON.stringify(req.body.messages);
    assert(context.includes('NATIVE_0_ONLY') && context.includes('NATIVE_1_ONLY'));
    assert.equal(await page.locator('#tabs [aria-selected=true]').getAttribute('id'), active);
    await page.screenshot({ path: join(folder, 'native-ai-verified.png') });
    await close(); child = launch(); page = await connect();
    await configure(); await state('#ai-key-status', '已保存');
    assert.equal(await page.locator('#ai-model').inputValue(), 'DeepSeek-V4.1-Flash-1017');
    assert.equal(await page.locator('#ai-key').inputValue(), '');
    await page.locator('#ai-test').click(); await state('#ai-settings-status', '调用成功：OK');
    await page.locator('#ai-clear-key').click(); await state('#ai-settings-status', '已清除');
    assert(!(await readFile(join(profile, 'settings.json'), 'utf8')).includes('portable-fixture-key'));
    await close();
    // Also run the unmodified production worker from the same package with an empty Key.
    await writeFile(worker, productionWorker); child = launch(); page = await connect();
    await configure(); await state('#ai-key-status', '尚未保存');
    await page.locator('#ai-test').click(); await state('#ai-settings-status', '请先');
    console.log('Actual portable native AI IPC, multi-source/background read, model, DPAPI restart/clear and no-Key guard OK (HTTP transport mocked only in isolated extracted copy). Evidence: ' + folder);
  } finally { await close(); for (const client of clients) client.end(); await new Promise(r => ssh.close(r)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
