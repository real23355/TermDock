const assert = require('node:assert/strict');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { createHash, generateKeyPairSync, randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { mkdir, mkdtemp, readFile, readdir, stat, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const { Server } = require('ssh2');
const { releaseVersion } = require('../package.json');

const exec = promisify(execFile);

async function until(predicate, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await sleep(80);
  }
  throw new Error('Timed out: ' + label);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function main() {
  const archive = resolve(`release/TermDock-${releaseVersion}-win-x64.zip`);
  const { size } = await stat(archive);
  assert(size <= 20_000_000);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(archive)) hash.update(bytes);
  assert.equal(hash.digest('hex'), (await readFile(archive + '.sha256', 'utf8')).split(' ')[0]);

  await mkdir('test-output', { recursive: true });
  const folder = await mkdtemp(resolve('test-output/webview-'));
  const result = spawnSync('tar.exe', ['-xf', archive, '-C', folder], { stdio: 'inherit', windowsHide: true });
  assert.equal(result.status, 0);
  const profile = join(folder, 'profile');
  await mkdir(profile);
  const legacySettings = {
    profiles: [{
      id: randomUUID(), name: '已有串口会话', kind: 'serial', path: 'COM77', baudRate: 115200,
      dataBits: 8, parity: 'none', stopBits: 1, flow: 'none',
    }],
    preferences: { font: 'Cascadia Mono', fontSize: 15, scrollback: 10000, gpu: true },
    hosts: { '[legacy.invalid]:22': 'SHA256:legacy' },
    commandGroups: [{
      id: randomUUID(), name: '旧版按钮',
      buttons: [{ id: randomUUID(), name: '旧版查询', command: 'echo legacy', lineEnding: 'CR' }],
    }],
  };
  await writeFile(join(profile, 'settings.json'), JSON.stringify(legacySettings));
  const readConfig = async name => JSON.parse(await readFile(join(profile, name), 'utf8'));
  const probe = createServer();
  const debugPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const clientInputs = [];
  const pty = [];
  const sizes = [];
  const sshKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set();
  const ssh = new Server({ hostKeys: [sshKey] }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'tester' && context.password === 'fixture-password') context.accept();
      else context.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', (ok, _reject, info) => { pty.push(info); ok(); });
      session.on('window-change', (_ok, _reject, info) => sizes.push(info));
      session.on('shell', ok => {
        const stream = ok();
        stream.write('PORTABLE_SSH_READY 中文\r\n$ ');
        stream.on('data', bytes => clientInputs.push(...bytes));
      });
    }));
  });
  const sshPort = await listen(ssh);
  const launcher = spawn(join(folder, 'TermDock', 'TermDock.exe'), [], {
    stdio: 'ignore',
    env: {
      ...process.env, TERMDOCK_DATA_DIR: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
    },
  });
  try {
    const endpoint = 'http://127.0.0.1:' + debugPort;
    await until(async () => {
      if (launcher.exitCode !== null) throw new Error('TermDock exited with ' + launcher.exitCode);
      return fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(400) })
        .then(response => response.ok, () => false);
    }, 'WebView2 startup', 20000);
    const browser = await chromium.connectOverCDP(endpoint);
    const page = await until(() => browser.contexts().flatMap(context => context.pages())
      .find(page => page.url() === 'https://termdock.local/index.html'), 'TermDock page');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    const click = name => page.getByRole('button', { name, exact: true }).click();
    const status = text => page.waitForFunction(text => document.querySelector('#global-state').textContent === text, text);
    await page.waitForFunction(() => document.querySelector('#profile-count').textContent === '01');
    assert.equal(await page.title(), 'TermDock');
    assert.equal(await page.locator('html').getAttribute('class'), 'native-window');
    assert.match(await page.locator('#profiles .profile-open').textContent(), /已有串口会话/);
    assert.equal((await readConfig('sessions.json')).profiles[0].id, legacySettings.profiles[0].id);
    assert.deepEqual((await readConfig('command-buttons.json')).commandGroups, legacySettings.commandGroups);

    await page.locator('#quick-serial').click();
    await page.waitForFunction(() => document.querySelector('#refresh-ports').title !== '');
    assert.equal(await page.locator('[name=baudRate]').inputValue(), '921600');
    await page.locator('[name=path]').fill('COM99998');
    await click('连接');
    await status('已断开');
    assert.match(await page.locator('#notice span').textContent(), /COM99998/);
    await click('关闭 PL2303');
    assert.deepEqual((await readConfig('sessions.json')).recentConnections, []);

    await page.locator('#quick-ssh').click();
    const fields = page.locator('#connect-form');
    for (const [name, value] of Object.entries({ host: '127.0.0.1', port: sshPort, username: 'tester', password: 'fixture-password' })) {
      await fields.locator(`[name=${name}]`).fill(String(value));
    }
    await click('连接');
    await page.locator('#key-dialog').waitFor();
    assert.match(await page.locator('#key-fingerprint').textContent(), /^SHA256:[A-Za-z0-9+/]{43}$/);
    await click('信任并连接');
    await status('已连接');
    await page.locator('#recent-connections .profile-open').waitFor();
    const [recent] = (await readConfig('sessions.json')).recentConnections;
    assert.deepEqual(recent.profile, { kind: 'ssh', name: 'SSH', host: '127.0.0.1', port: sshPort, username: 'tester' });
    assert.equal((await readConfig('settings.json')).hosts['[legacy.invalid]:22'], 'SHA256:legacy');
    await click('旧版查询');
    await until(() => Buffer.from(clientInputs).includes('echo legacy\r'), 'migrated command button sends data');
    await click('终端设置');
    await page.locator('#settings-form [name=font]').selectOption('macOS');
    await click('应用');
    await page.waitForFunction(() => {
      const faces = [...document.fonts].filter(font => font.family.includes('IBM Plex Mono'));
      return faces.length === 2 && faces.every(font => font.status === 'loaded');
    });
    assert.equal((await readConfig('settings.json')).preferences.font, 'macOS');
    assert.equal(pty[0].term, 'xterm-256color');
    await until(() => sizes.length, 'initial PTY size');
    const cols = sizes.at(-1).cols;
    await click('收起会话栏');
    await until(() => sizes.at(-1).cols > cols, 'PTY resize after collapsing the sidebar');
    await click('展开会话栏');
    await page.locator('.surface:visible .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+b');
    await until(() => clientInputs.includes(2), 'tmux prefix delivered through the packaged host');
    await page.keyboard.press('Control+Shift+f');
    await page.locator('.surface:visible .search-value').fill('PORTABLE_SSH_READY 中文');
    await page.waitForFunction(() => document.querySelector('.surface:not([hidden]) .search-result').textContent === '1 / 1');
    await click('关闭搜索');

    await click('管理按钮');
    await click('新建分组');
    await page.locator('#command-group-name').fill('Fixture');
    await click('添加按钮');
    await page.locator('.command-edit-row [name=name]').fill('查询系统');
    await page.locator('.command-edit-row [name=command]').fill('uname -a');
    await click('保存');
    await click('查询系统');
    await until(() => Buffer.from(clientInputs).includes('uname -a\r'), 'saved command through the packaged host');

    await page.locator('#quick-local').click();
    await page.getByRole('tab', { name: 'PowerShell', selected: true, exact: true }).waitFor();
    await status('已连接');
    const localTab = page.getByRole('tab', { name: 'PowerShell', exact: true });
    const local = page.locator('#' + await localTab.getAttribute('aria-controls'));
    assert.equal(await local.locator('.endpoint').textContent(), '本机 PowerShell');
    assert.equal(await local.locator('.timer-toggle').isVisible(), false);
    const localLog = join(await local.locator('.session-logs').getAttribute('title'), 'session.log');
    const shellText = async () => (await readFile(localLog, 'utf8')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const enterPowerShell = async command => {
      await local.locator('.xterm-helper-textarea:focus').waitFor({ state: 'attached' });
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
    };
    const findOutput = async (text, exactLine = false) => {
      await until(async () => {
        const log = exactLine ? await shellText() : await readFile(localLog, 'utf8');
        return exactLine ? log.includes('\r\n' + text + '\r\n') : log.includes(text);
      }, 'PowerShell output: ' + text);
      await click('搜索');
      await local.locator('.search-value').fill(text);
      await page.waitForFunction(() => /\/ [1-9]\d*$/.test(document.querySelector('.surface:not([hidden]) .search-result').textContent));
      await click('关闭搜索');
    };
    await findOutput('PS ');
    await local.locator('.terminal-mount .xterm-screen').click();
    await enterPowerShell('echo termdock-ok');
    await findOutput('termdock-ok', true);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await until(async () => (await shellText()).split('\r\ntermdock-ok\r\n').length >= 3, 'previous command via ArrowUp');
    await page.keyboard.type('Write-Outpu');
    await page.keyboard.press('Tab');
    await page.keyboard.type(" ('TAB_' + 'OK')");
    await page.keyboard.press('Enter');
    await findOutput('TAB_OK');
    await page.keyboard.type("Write-Output ('UTF8_' + '");
    await page.keyboard.insertText('中文');
    await page.keyboard.type("')");
    await page.keyboard.press('Enter');
    await findOutput('UTF8_中文', true);
    await enterPowerShell("Write-Output ('TERMDOCK_' + 'LOCAL_PTY_READY')");
    await findOutput('TERMDOCK_LOCAL_PTY_READY');
    await enterPowerShell("Write-Output ('TERMDOCK_' + 'WAITING'); Start-Sleep -Seconds 30");
    await findOutput('TERMDOCK_WAITING');
    await page.keyboard.press('Control+c');
    await sleep(450);
    const currentSize = () => page.locator('#global-size').textContent();
    const originalSize = await currentSize();
    await click('收起会话栏');
    await until(async () => (await currentSize()) !== originalSize, 'terminal width changes when the sidebar is hidden');
    await click('展开会话栏');
    await until(async () => (await currentSize()) === originalSize, 'terminal width changes when the sidebar is restored');
    const localColumns = Number(originalSize.split(' × ')[0]);
    await enterPowerShell("Write-Output ('TERMDOCK_SIZE_' + [Console]::WindowWidth)");
    await findOutput('TERMDOCK_SIZE_' + localColumns);
    await click('终端设置');
    await click('取消');
    await enterPowerShell("Write-Output ('AFTER_' + 'DIALOG')");
    await findOutput('AFTER_DIALOG');
    await click('本机 Shell…');
    await page.locator('#local-form [name=shell]').selectOption('cmd');
    await page.locator('#local-form [name=cwd]').fill(folder);
    await page.locator('#local-form [name=environment]').fill('TERMDOCK_FIXTURE=cmd-env-ok');
    await click('打开 Shell');
    await page.getByRole('tab', { name: 'CMD', selected: true }).waitFor();
    await status('已连接');
    await page.keyboard.type('echo %TERMDOCK_FIXTURE%');
    await page.keyboard.press('Enter');
    const cmd = page.locator('.surface:visible');
    const cmdLog = join(await cmd.locator('.session-logs').getAttribute('title'), 'session.log');
    await until(async () => {
      const log = await readFile(cmdLog, 'utf8');
      return log.includes('cmd-env-ok') && log.includes(folder);
    }, 'CMD cwd and environment');
    await click('左右分屏');
    assert.equal(await page.locator('.surface:visible').count(), 2);
    await local.locator('.xterm-screen').click();
    await enterPowerShell("Write-Output ('SIDE_' + 'PANE')");
    await until(async () => (await readFile(localLog, 'utf8')).includes('SIDE_PANE'), 'input in side-by-side pane');
    await click('上下分屏');
    await enterPowerShell("Write-Output ('STACKED_' + 'PANE')");
    await until(async () => (await readFile(localLog, 'utf8')).includes('STACKED_PANE'), 'input in stacked pane');
    await click('上下分屏');
    assert.equal(await page.locator('.surface:visible').count(), 1);
    await page.getByRole('tab', { name: 'CMD', exact: true }).click();
    await localTab.click();
    await enterPowerShell('exit 7');
    await status('已断开');
    assert.match(await page.locator('#global-endpoint').textContent(), /7/);
    assert.equal((await readConfig('sessions.json')).recentConnections.length, 1);
    console.log('Local PowerShell shortcut, interactive input, Ctrl+C, native PTY resize and exit passed');

    assert.deepEqual(errors, []);
    const runtime = join(profile, 'cache', 'runtime');
    const [runtimeHash] = await readdir(runtime);
    const runtimeSize = (await stat(join(runtime, runtimeHash, 'node.exe'))).size;
    assert(runtimeSize > size);
    console.log(`Portable ZIP verified (${size} bytes), first-run runtime extracted (${runtimeSize} bytes), migration, native COM and SSH UI passed`);
  } finally {
    if (launcher.exitCode === null && launcher.pid) {
      await exec('powershell.exe', [
        '-NoProfile', '-Command', `(Get-Process -Id ${launcher.pid} -ErrorAction Stop).CloseMainWindow() | Out-Null`,
      ], { windowsHide: true }).catch(() => {});
      if (!await until(() => launcher.exitCode !== null, 'graceful shutdown', 12000).catch(() => false)) launcher.kill();
    }
    for (const client of clients) client.end();
    await new Promise(resolve => ssh.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
