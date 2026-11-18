const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { mkdir, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { createServer } = require('node:net');
const { setTimeout: sleep } = require('node:timers/promises');
const { build } = require('esbuild');
const { chromium } = require('playwright');
const { releaseVersion } = require('../package.json');
async function until(fn, label) {
  for (let n = 0; n < 180; n++) { const result = await fn(); if (result) return result; await sleep(80); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  await mkdir('test-output', { recursive: true });
  const folder = await mkdtemp(resolve('test-output/portable-chat-'));
  const archive = resolve(`release/TermDock-${releaseVersion}-win-x64.zip`);
  assert.equal(spawnSync('tar.exe', ['-xf', archive, '-C', folder], { windowsHide: true }).status, 0);
  const worker = join(folder, 'TermDock/backend/worker.cjs');
  const productionWorker = await readFile(worker);
  const records = join(folder, 'test-records.jsonl');
  // Replace only this isolated copy with the same controller/AI/session sources plus simulated transport/device.
  // The release ZIP remains unchanged. The unmodified production worker is tested by portable.cjs.
  await build({ entryPoints: ['tests/portable-chat-worker.ts'], outfile: worker, bundle: true, platform: 'node', target: 'node22', external: ['serialport', 'ssh2'] });
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const debugPort = probe.address().port; await new Promise(r => probe.close(r));
  const child = spawn(join(folder, 'TermDock/TermDock.exe'), [], { stdio: 'ignore', env: { ...process.env,
    TERMDOCK_DATA_DIR: join(folder, 'profile'), TD_TEST_RECORDS: records,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
  } });
  let browser;
  try {
    const endpoint = `http://127.0.0.1:${debugPort}`;
    await until(() => fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(300) }).then(r => r.ok, () => false), 'native startup');
    browser = await chromium.connectOverCDP(endpoint);
    const page = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('termdock.local/index.html')), 'native UI');
    const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(8000);
    const state = (selector, text) => page.waitForFunction(([s, t]) => document.querySelector(s)?.textContent.includes(t), [selector, text], { timeout: 8000 });
    const ids = [];
    for (const path of ['COM77', 'COM78']) {
      await page.locator('#quick-serial').click(); await page.locator('#connect-form [name=path]').fill(path); await page.locator('#connect-form [name=name]').fill(path + ' 模拟板卡');
      await page.locator('#connect-now').click(); await state('#global-state', '已连接');
      ids.push((await page.locator('#tabs [aria-selected=true]').getAttribute('id')).slice(4)); await page.locator('.surface:visible .timer-collapse').click();
    }
    await page.locator('#open-ai-chat').click();
    assert(await page.locator('#ai-dialog').evaluate(el => el.open && !el.matches(':modal')));
    await page.locator('#ai-configure').click(); await state('#ai-key-status', '尚未保存');
    await page.locator('#ai-key').fill('portable-chat-fixture'); await page.locator('#ai-save').click(); await state('#ai-settings-status', '配置已保存');
    await page.locator('#settings-dialog [data-dismiss]').first().click();
    await page.locator(`#ai-sources input[data-source-id="${ids[1]}"]`).uncheck(); await page.locator(`#ai-sources input[data-source-id="${ids[0]}"]`).check();
    await page.locator('#ai-question').fill('直接解释当前 COM77 的内容'); await page.locator('#ai-send').click(); await page.locator('.ai-assistant').waitFor();
    const readRecords = async () => (await readFile(records, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    let rows = await readRecords(); assert(!rows.some(row => row.type === 'write'));
    assert(JSON.stringify(rows.find(row => row.type === 'request').body.messages).includes('NATIVE_READY_COM77'));
    await page.locator('#ai-mode').selectOption('serial'); await page.locator('#ai-serial-target').selectOption(ids[0]);
    await page.locator('#ai-question').fill('自动检查 COM77 内存与系统信息'); await page.locator('#ai-send').click();
    await page.locator('#tab-' + ids[1]).click(); await state('#ai-status', '本轮结束：2 次实际写入');
    rows = await readRecords();
    assert.deepEqual(rows.filter(row => row.type === 'write').map(row => [row.port, row.text]), [['COM77', 'free -m\r'], ['COM77', 'uname -a\n']]);
    const requests = rows.filter(row => row.type === 'request');
    assert(requests.every(row => row.authenticated && row.url === 'https://llm.amlogic.com/v1/chat/completions'));
    assert(JSON.stringify(requests.at(-2).body.messages).includes('NATIVE_REPLY_COM77_free -m'));
    assert(JSON.stringify(requests.at(-1).body.messages).includes('NATIVE_REPLY_COM77_uname -a'));
    assert((await page.locator('#ai-run-target').textContent()).includes('COM77'));
    assert.equal((await page.locator('#tabs [aria-selected=true]').getAttribute('id')).slice(4), ids[1]);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(folder, 'native-dialog-verified.png') });
    console.log('Portable TermDock.exe: non-modal direct chat and real native IPC -> shared backend -> simulated serial write/drain/new reply -> AI continuation, with fixed target across tab switch OK. Evidence: ' + folder);
  } finally {
    if (child.exitCode === null && child.pid) {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid} -ErrorAction Stop).CloseMainWindow() | Out-Null`], { windowsHide: true });
      await until(() => child.exitCode !== null, 'native close');
    }
    await browser?.close().catch(() => {});
    await writeFile(worker, productionWorker);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
