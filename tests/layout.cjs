const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { mkdir, mkdtemp, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { chromium } = require('playwright');
const { createServer } = require('node:net');

async function main() {
  const archive = resolve(process.argv[2]);
  const label = process.argv[3];
  const scale = process.argv[4] || '1';
  const output = resolve('test-output/layout-comparison');
  await mkdir(output, { recursive: true });
  const folder = await mkdtemp(resolve('test-output/layout-'));
  assert.equal(spawnSync('tar.exe', ['-xf', archive, '-C', folder], { windowsHide: true }).status, 0);
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const child = spawn(join(folder, 'TermDock/TermDock.exe'), [], {
    stdio: 'ignore', env: { ...process.env, TERMDOCK_DATA_DIR: join(folder, 'profile'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --force-device-scale-factor=${scale}` },
  });
  let browser;
  try {
    for (let i = 0; i < 150 && !browser; i++) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
      if (!browser) await sleep(100);
    }
    assert(browser, 'WebView2 starts');
    const page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('#quick-local');
    await page.locator('#quick-local').click();
    await page.waitForFunction(() => document.querySelector('#global-state')?.textContent === '已连接');
    await page.waitForSelector('.xterm-helper-textarea');
    await page.locator('.xterm-helper-textarea').pressSequentially('echo termdock-ok', { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    if (label === 'before') {
      // Reproduce the 0.0.2 form bug without connecting or storing a password.
      await page.locator('#quick-ssh').click();
      await page.locator('#connect-form [name=host]').fill('EXAMPLE.invalid');
      await page.locator('#connect-form [name=password]').fill('fixture-only-never-saved');
      await page.locator('#connect-form [name=rememberPassword]').check();
      await page.locator('#connect-form [name=host]').fill('example.invalid');
      const result = await page.evaluate(() => ({
        remember: document.querySelector('[name=rememberPassword]').checked,
        passwordLength: document.querySelector('[name=password]').value.length,
      }));
      assert.deepEqual(result, { remember: false, passwordLength: 0 });
      await writeFile(join(output, 'baseline-password-reproduction.json'), JSON.stringify(result, null, 2));
      await page.locator('#connect-dialog [data-dismiss]').first().click();
    }
    await page.screenshot({ path: join(output, label + '.png') });
    const metrics = await page.evaluate(() => {
      const rect = s => document.querySelector(s)?.getBoundingClientRect().toJSON();
      const mount = document.querySelector('.terminal-mount').getBoundingClientRect();
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
      const rows = document.querySelector('#global-size').textContent;
      return { viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
        terminalFontSize: 15, uiFontSize: getComputedStyle(document.querySelector('.xterm')).fontSize,
        top: rect('.tabs-bar'), oldSplitRow: rect('.workspace-toolbar'), oldSurfaceRow: rect('.surface-tools'),
        commandBar: rect('.command-bar'), status: rect('.statusbar'), terminal: mount.toJSON(), screen: screen.toJSON(), rows,
        toolbarTotalHeight: mount.top + innerHeight - mount.bottom };
    });
    if (label !== 'before') {
      assert.equal(metrics.top.height, 32);
      assert.equal(metrics.commandBar.height, 28);
      assert.equal(metrics.status.height, 20);
      const clipped = await page.locator('.top-tools').evaluate(tools => {
        const bar = document.querySelector('.tabs-bar').getBoundingClientRect();
        return [...tools.querySelectorAll('button')].filter(el => getComputedStyle(el).display !== 'none').some(el => {
          const r = el.getBoundingClientRect(); return r.bottom > bar.bottom || r.top < bar.top || r.right > innerWidth;
        });
      });
      assert.equal(clipped, false);
    }
    await writeFile(join(output, label + '.json'), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify({ label, ...metrics }));
  } finally {
    if (child.exitCode === null && child.pid) execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process -Id ${child.pid} -ErrorAction Stop).CloseMainWindow() | Out-Null`], { windowsHide: true });
    await sleep(1500);
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
