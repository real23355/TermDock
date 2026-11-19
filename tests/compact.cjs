const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { build } = require('esbuild');
const { _electron } = require('playwright');
async function until(fn, label) {
  for (let n = 0; n < 100; n++) { if (await fn()) return; await sleep(60); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/compact-'));
  const groups = [
    { id: randomUUID(), name: 'Default', buttons: Array.from({ length: 12 }, (_, n) => ({ id: randomUUID(), name: `命令 ${n + 1} 查询板卡状态`, command: `echo ${n + 1}`, lineEnding: n === 11 ? 'CRLF' : 'CR' })) },
    { id: randomUUID(), name: 'Small', buttons: [{ id: randomUUID(), name: 'env', command: 'env', lineEnding: 'LF' }] },
  ];
  await writeFile(join(directory, 'command-buttons.json'), JSON.stringify({ commandGroups: groups }));
  await build({ entryPoints: ['tests/app-fixture.ts'], outfile: 'dist/test-compact.cjs', bundle: true, platform: 'node', external: ['electron', 'serialport', 'ssh2'] });
  const electron = await _electron.launch({ args: ['dist/test-compact.cjs'], env: { ...process.env, TERMDOCK_TEST_DATA: directory } });
  try {
    const page = await electron.firstWindow(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const state = text => page.waitForFunction(text => document.querySelector('#global-state').textContent === text, text);
    const more = async name => { await page.locator('#top-more').click(); await page.getByRole('menuitem', { name, exact: true }).click(); };
    const ids = [];
    for (const path of ['COM3', 'COM12']) {
      await page.locator('#quick-serial').click();
      await page.locator('#connect-form [name=path]').fill(path);
      await page.locator('#connect-form [name=name]').fill(path + ' 开发板 / 一个用于省略显示的长会话名称');
      await page.locator('#connect-now').click(); await state('已连接');
      ids.push((await page.locator('#tabs [aria-selected=true]').getAttribute('id')).slice(4));
      await page.locator('.surface:visible .timer-collapse').click();
    }
    for (let n = 0; n < 5; n++) await page.locator('button[data-shell=cmd]').click();
    await state('已连接');
    await page.locator('#quick-ssh').click();
    for (const [name, value] of Object.entries({ host: '127.0.0.1', port: 1, username: 'long-user-name', name: 'SSH / 长名称用于窄窗口验证', password: 'fixture-unused' })) {
      await page.locator(`#connect-form [name=${name}]`).fill(String(value));
    }
    await page.locator('#connect-now').click(); await state('已断开');
    await page.locator('#tab-' + ids[0]).click();
    await page.locator('#split-side').click();
    await page.locator('#split-first').selectOption(ids[0]); await page.locator('#split-second').selectOption(ids[1]);
    await page.getByRole('button', { name: '应用分屏', exact: true }).click();
    const pane = id => page.locator('#surface-' + id);
    const sent = path => electron.evaluate((_e, path) => Buffer.from(globalThis.fixture.sentPort(path)).toString(), path);
    await pane(ids[0]).locator('.xterm-helper-textarea').focus();
    await page.locator('.top-tools .search-toggle').click();
    assert.equal(await pane(ids[0]).locator('.searchbar').isVisible(), true);
    assert.equal(await pane(ids[1]).locator('.searchbar').isVisible(), false);
    await pane(ids[0]).locator('.search-close').click();
    const leftLog = await page.locator('.top-tools .session-logs').getAttribute('title');
    await pane(ids[1]).locator('.xterm-helper-textarea').focus();
    assert((await page.locator('#active-endpoint').textContent()).includes('COM12'));
    assert.notEqual(await page.locator('.top-tools .session-logs').getAttribute('title'), leftLog);
    await page.locator('.top-tools .record-log').click();
    await until(async () => (await page.locator('.top-tools .record-log').getAttribute('aria-pressed')) === 'false', 'record flag');
    await pane(ids[0]).locator('.xterm-helper-textarea').focus();
    assert.equal(await page.locator('.top-tools .record-log').getAttribute('aria-pressed'), 'true');
    await page.locator('#command-group').selectOption(groups[1].id);
    await page.getByRole('button', { name: 'env', exact: true }).click();
    await until(async () => (await sent('COM3')) === 'env\n', 'direct command routes left');
    assert.equal(await sent('COM12'), '');
    assert(await pane(ids[0]).locator('.xterm-helper-textarea').evaluate(el => el === document.activeElement));
    await pane(ids[1]).locator('.xterm-helper-textarea').focus();
    await page.locator('#command-group').selectOption(groups[0].id);
    await page.locator('#command-overflow').click();
    await page.locator('#command-overflow-menu button').last().click();
    await until(async () => (await sent('COM12')) === 'echo 12\r\n', 'overflow command routes right');
    assert.equal(await sent('COM3'), 'env\n');
    assert(await pane(ids[1]).locator('.xterm-helper-textarea').evaluate(el => el === document.activeElement));

    const checks = async () => {
      const geometry = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const bar = rect('.command-bar'); const tools = rect('.top-tools'); const address = rect('#active-endpoint'); const tabs = rect('#tabs');
        const visible = [...document.querySelectorAll('#command-button-list button')].map(el => el.getBoundingClientRect());
        return { top: rect('.tabs-bar').height, commands: bar.height, status: rect('.statusbar').height,
          overlap: tabs.right > address.left + 1 || address.right > tools.left + 1,
          clipped: visible.some(r => r.top < bar.top || r.bottom > bar.bottom || r.right > rect('#command-buttons').right + 1),
          rows: [...new Set(visible.map(r => r.top))].length,
          horizontalScroll: document.querySelector('#command-button-list').scrollWidth > document.querySelector('#command-button-list').clientWidth,
          order: [...document.querySelectorAll('#command-button-list button, #command-overflow-menu button')].map(el => el.dataset.buttonId),
          manageVisible: rect('#manage-commands').right <= innerWidth,
          oldRows: document.querySelectorAll('.surface-tools,.workspace-toolbar').length,
        };
      });
      assert.equal(geometry.top, 32); assert.equal(geometry.commands, 28); assert.equal(geometry.status, 20);
      assert.equal(geometry.overlap, false); assert.equal(geometry.clipped, false); assert.equal(geometry.horizontalScroll, false);
      assert(geometry.rows <= 1); assert(geometry.manageVisible); assert.equal(geometry.oldRows, 0);
      assert.deepEqual(geometry.order, groups[0].buttons.map(item => item.id));
    };
    const originalVisible = await page.locator('#command-button-list button').count();
    await electron.evaluate(() => globalThis.fixture.resize(850, 650));
    await sleep(250); await checks();
    assert((await page.locator('#command-button-list button').count()) < originalVisible);
    await page.locator('#top-more').click();
    for (const name of ['SFTP', '端口转发', '日志', '左右分屏', '上下分屏', '断开', 'AI 助手']) {
      assert.equal(await page.getByRole('menuitem', { name, exact: true }).isVisible(), true);
    }
    assert.deepEqual((await page.getByRole('menuitem').allTextContents()).filter(text => /AI|分析选中日志|ADB/.test(text)), ['AI 助手']);
    await page.keyboard.press('Escape');
    const cdp = await page.context().newCDPSession(page);
    const metrics = [];
    for (const scale of [1, 1.25, 1.5]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 850, height: 650, deviceScaleFactor: scale, mobile: false });
      await sleep(180); await checks();
      await page.screenshot({ path: join(directory, `compact-${scale}.png`) });
      metrics.push({ scale, ...await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })) });
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await electron.evaluate(() => globalThis.fixture.resize(1600, 900)); await sleep(250); await checks();
    assert((await page.locator('#command-button-list button').count()) > originalVisible);
    await page.locator('#command-group').selectOption(groups[1].id); await sleep(100);
    assert.equal(await page.locator('#command-overflow').isVisible(), false);
    await page.locator('#command-group').selectOption(groups[0].id); await sleep(100);
    await page.locator('#sidebar-toggle').click(); await sleep(100); await checks();
    await pane(ids[1]).locator('.xterm-helper-textarea').focus();
    const connection = page.locator('#session-connection');
    assert.equal(await connection.getAttribute('aria-label'), '断开');
    await connection.click(); await state('已断开');
    assert(await electron.evaluate(() => globalThis.fixture.connectedPort('COM3')));
    assert(!await electron.evaluate(() => globalThis.fixture.connectedPort('COM12')));
    assert.equal(await connection.getAttribute('aria-label'), '连接');
    assert.equal(await connection.getAttribute('data-icon'), 'reconnect');
    await connection.click();
    assert.equal(await page.locator('#connect-form [name=path]').inputValue(), 'COM12');
    await page.locator('#connect-now').click();
    await until(() => electron.evaluate(() => globalThis.fixture.connectedPort('COM12')), 'same COM port reconnects');
    await state('已连接');
    assert((await page.locator('#active-endpoint').textContent()).includes('COM12'));
    assert.equal(await connection.getAttribute('aria-label'), '断开');
    assert(await electron.evaluate(() => globalThis.fixture.connectedPort('COM3')));
    assert.deepEqual(errors, []);
    await writeFile(join(directory, 'dpi-emulation.json'), JSON.stringify(metrics, null, 2));
    console.log('Compact layout, unified AI menu, active-pane connection toggle, command overflow and 100/125/150% DPI emulation OK. Evidence: ' + directory);
  } finally { await electron.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
