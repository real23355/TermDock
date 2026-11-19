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
const { releaseVersion, portableMaximumBytes } = require('../package.json');

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
  assert(size <= portableMaximumBytes);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(archive)) hash.update(bytes);
  assert.equal(hash.digest('hex'), (await readFile(archive + '.sha256', 'utf8')).split(' ')[0]);

  await mkdir('test-output', { recursive: true });
  const folder = await mkdtemp(resolve('test-output/webview-'));
  const result = spawnSync('tar.exe', ['-xf', archive, '-C', folder], { stdio: 'inherit', windowsHide: true });
  assert.equal(result.status, 0);
  const profile = join(folder, 'profile');
  await mkdir(profile);
  const configuredPull = join(folder, 'ADB 保存 目录');
  const legacySettings = {
    profiles: [{
      id: randomUUID(), name: '已有串口会话', kind: 'serial', path: 'COM77', baudRate: 115200,
      dataBits: 8, parity: 'none', stopBits: 1, flow: 'none',
    }],
    preferences: { font: 'Cascadia Mono', fontSize: 15, scrollback: 10000, gpu: true },
    hosts: { '[legacy.invalid]:22': 'SHA256:legacy' },
    adb: { pullDirectory: configuredPull, systemPath: false },
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
  const passwordAttempts = [];
  let testerPassword = 'fixture-password';
  const pty = [];
  const sizes = [];
  const sshKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set();
  const ssh = new Server({ hostKeys: [sshKey] }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', context => {
      if (context.method === 'password') passwordAttempts.push(context.username);
      if (context.method === 'password' && (
        (context.username === 'tester' && context.password === testerPassword) ||
        (context.username === 'new-user' && context.password === 'new-target-password'))) context.accept();
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
  const executable = join(folder, 'TermDock', 'TermDock.exe');
  const launch = () => spawn(executable, [], {
    stdio: 'ignore',
    env: {
      ...process.env, TERMDOCK_DATA_DIR: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
    },
  });
  let launcher = launch();
  const closeLauncher = async () => {
    if (launcher.exitCode === null && launcher.pid) {
      await exec('powershell.exe', [
        '-NoProfile', '-Command', `(Get-Process -Id ${launcher.pid} -ErrorAction Stop).CloseMainWindow() | Out-Null`,
      ], { windowsHide: true }).catch(() => {});
      if (!await until(() => launcher.exitCode !== null, 'graceful shutdown', 12000).catch(() => false)) launcher.kill();
    }
  };
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
    const click = async name => {
      if (name === '连接') return page.locator('#connect-now').click();
      const button = page.getByRole('button', { name, exact: true });
      if (!['交换窗格', '关闭分屏', 'Serial Break', '定时发送 / 重启测试'].includes(name)) return button.click();
      await page.locator('#top-more').click();
      return page.getByRole('menuitem', { name, exact: true }).click();
    };
    const contextAction = async (target, name) => {
      await target.click({ button: 'right' });
      await page.locator('.context-menu').getByRole('button', { name, exact: true }).click();
    };
    const saveSession = async () => {
      await click('保存');
      await page.locator('#connect-dialog').waitFor({ state: 'hidden' });
    };
    const nativeClipboard = (operation, value) => page.evaluate(([operation, value]) => new Promise(resolve => {
      const id = 2_100_000;
      const reply = ({ data }) => {
        if (data.kind !== 'reply' || data.id !== id) return;
        chrome.webview.removeEventListener('message', reply);
        resolve(data);
      };
      chrome.webview.addEventListener('message', reply);
      chrome.webview.postMessage({ kind: 'request', id, name: operation, args: [value] });
    }), [operation, value]);
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
    await fields.locator('[name=rememberPassword]').check();
    await fields.locator('[name=host]').fill('127.0.0.1 ');
    assert.equal(await fields.locator('[name=password]').inputValue(), 'fixture-password');
    assert.equal(await fields.locator('[name=rememberPassword]').isChecked(), true);
    await click('连接');
    await page.locator('#key-dialog').waitFor();
    assert.match(await page.locator('#key-fingerprint').textContent(), /^SHA256:[A-Za-z0-9+/]{43}$/);
    await click('信任并连接');
    await status('已连接');
    await page.locator('#recent-connections .profile-open').waitFor();
    const [recent] = (await readConfig('sessions.json')).recentConnections;
    assert.deepEqual(recent.profile, { kind: 'ssh', name: 'SSH', host: '127.0.0.1', port: sshPort, username: 'tester' });
    const credentialDir = join(profile, 'credentials');
    const credentialFile = await until(async () => (await readdir(credentialDir).catch(() => [])).find(name => name.endsWith('.dpapi')), 'DPAPI file');
    assert(!(await readFile(join(credentialDir, credentialFile))).includes('fixture-password'));
    const recentEntry = page.locator('#recent-connections .profile-open');
    await contextAction(recentEntry, '设置 / 重命名…');
    await fields.locator('[name=name]').fill('测试 SSH 重命名');
    await fields.locator('[name=password]').fill('replacement-fixture-password');
    await fields.locator('[name=rememberPassword]').check();
    await saveSession();
    testerPassword = 'replacement-fixture-password';
    await recentEntry.filter({ hasText: '测试 SSH 重命名' }).waitFor();
    assert.equal((await readdir(credentialDir)).filter(name => name.endsWith('.dpapi')).length, 1);
    const dragSession = async (source, target) => {
      await page.bringToFront();
      await source.scrollIntoViewIfNeeded();
      const from = await source.boundingBox(), to = await target.boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 13 });
      await page.mouse.move(to.x + to.width / 2 + 2, to.y + to.height / 2);
      await page.locator('.drop-target').waitFor({ state: 'visible' });
      await page.mouse.up();
      await page.locator('#connect-dialog').waitFor({ state: 'visible' });
    };
    await dragSession(recentEntry, page.locator('#saved-heading'));
    await fields.locator('[name=group]').fill('Board lab');
    await saveSession();
    const savedSsh = page.locator('#profiles .profile-open').filter({ hasText: '测试 SSH 重命名' });
    await savedSsh.waitFor();
    await dragSession(page.getByRole('tab', { name: 'SSH', exact: true }), page.locator('#profiles details').filter({ hasText: 'Board lab' }).locator('summary'));
    await fields.locator('[name=name]').fill('拖自标签');
    assert.equal(await fields.locator('[name=group]').inputValue(), 'Board lab');
    await saveSession();
    assert.equal((await readConfig('sessions.json')).profiles.length, 3);
    await contextAction(savedSsh, '另存为新会话…');
    await fields.locator('[name=name]').fill('新目标');
    await fields.locator('[name=host]').fill('localhost');
    await fields.locator('[name=username]').fill('new-user');
    assert.equal(await fields.locator('[name=password]').inputValue(), '');
    assert.equal(await fields.locator('#forget-password').isVisible(), false);
    await saveSession();
    const newTarget = page.locator('#profiles .profile-open').filter({ hasText: '新目标' });
    await newTarget.click();
    await fields.locator('[name=password]').fill('new-target-password');
    await click('连接');
    await page.locator('#key-dialog').waitFor();
    await click('信任并连接');
    await status('已连接');
    assert(passwordAttempts.includes('new-user'));
    await click('关闭 新目标');
    await page.getByRole('tab', { name: 'SSH', exact: true }).click();
    for (const name of ['settings.json', 'sessions.json']) assert(!(await readFile(join(profile, name))).includes('fixture-password'));
    assert.equal((await readConfig('settings.json')).hosts['[legacy.invalid]:22'], 'SHA256:legacy');
    await click('旧版查询');
    await until(() => Buffer.from(clientInputs).includes('echo legacy\r'), 'migrated command button sends data');
    await page.locator('#settings').click();
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
    const copyFixture = 'SESSION_FILTER_TEXT';
    const sessionSearch = page.locator('#session-search');
    await nativeClipboard('copy', 'before-selection');
    await sessionSearch.fill(copyFixture);
    await sessionSearch.dblclick({ position: { x: 38, y: 15 } });
    await until(async () => (await nativeClipboard('paste', '')).value === copyFixture, 'ordinary text mouse selection copies');
    await sessionSearch.click({ position: { x: 40, y: 15 } });
    assert.equal((await nativeClipboard('paste', '')).value, copyFixture);
    await sessionSearch.fill('');
    await contextAction(sessionSearch, '粘贴');
    await until(async () => (await sessionSearch.inputValue()) === copyFixture, 'ordinary input context-menu paste');
    await sessionSearch.fill('');
    await page.locator('#quick-ssh').click();
    await fields.locator('[name=password]').fill('masked-test-field');
    await fields.locator('[name=password]').dblclick({ position: { x: 37, y: 15 } });
    assert.equal((await nativeClipboard('paste', '')).value, copyFixture);
    await click('取消');

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
    assert.equal(await page.locator('#active-endpoint').textContent(), '本机 PowerShell');
    assert.equal(await local.locator('.timer-toggle').isVisible(), false);
    const localLog = join(await page.locator('.top-tools .session-logs').getAttribute('title'), 'session.log');
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
    await enterPowerShell("(Get-Command adb -ErrorAction Stop).Source");
    const defaultAdb = join(profile, 'tools', 'adb', 'adb.exe');
    await findOutput(defaultAdb);
    const adbPrefixStart = (await shellText()).length;
    await page.locator('#adb-command').click();
    await until(async () => (await shellText()).slice(adbPrefixStart).includes('adb '), 'ADB toolbar fills the command prefix');
    assert(!(await shellText()).slice(adbPrefixStart).includes('Android Debug Bridge'));
    await enterPowerShell('version');
    await findOutput('Android Debug Bridge version 1.0.41');
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
    await page.locator('#settings').click();
    await click('取消');
    await enterPowerShell("Write-Output ('AFTER_' + 'DIALOG')");
    await findOutput('AFTER_DIALOG');
    await click('自定义启动…');
    await page.locator('#local-form [name=shell]').selectOption('cmd');
    await page.locator('#local-form [name=cwd]').fill(folder);
    await page.locator('#local-form [name=environment]').fill('TERMDOCK_FIXTURE=cmd-env-ok');
    await click('打开 Shell');
    await page.getByRole('tab', { name: 'CMD', selected: true }).waitFor();
    await status('已连接');
    await page.keyboard.type('echo %TERMDOCK_FIXTURE%');
    await page.keyboard.press('Enter');
    const cmdTab = page.getByRole('tab', { name: 'CMD', exact: true });
    const cmd = page.locator('#' + await cmdTab.getAttribute('aria-controls'));
    assert.equal(await page.locator('#adb-command').isVisible(), false);
    const cmdLog = join(await page.locator('.top-tools .session-logs').getAttribute('title'), 'session.log');
    await until(async () => {
      const log = await readFile(cmdLog, 'utf8');
      return log.includes('cmd-env-ok') && log.includes(folder);
    }, 'CMD cwd and environment');
    const fixtures = [join(folder, '含 空格的文件.txt'), join(folder, "O'Brien 文件.txt")];
    for (const [index, path] of fixtures.entries()) await writeFile(path, 'fixture-drop-' + index);
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => {
      globalThis.tdDropTrace = [];
      for (const name of ['dragenter', 'dragover', 'drop']) {
        document.addEventListener(name, event => {
          globalThis.tdDropTrace.push([name, event.target.className, [...event.dataTransfer.types], event.dataTransfer.files.length]);
        }, true);
      }
    });
    const dragFiles = async surface => {
      const box = await surface.locator('.xterm-screen').boundingBox();
      const data = { items: [], files: fixtures, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp.send('Input.dispatchDragEvent', { type, x: box.x + 60, y: box.y + 10, data });
      }
    };
    await page.keyboard.type('echo ');
    await dragFiles(cmd);
    try {
      await until(async () => (await readFile(cmdLog, 'utf8')).includes('含 空格的文件.txt'), 'file drag inserts CMD paths');
    } catch (error) {
      console.error('Drop trace', await page.evaluate(() => globalThis.tdDropTrace), await page.locator('#notice span').textContent());
      throw error;
    }
    await page.keyboard.type(' CMD_END');
    await page.keyboard.press('Enter');
    await until(async () => (await readFile(cmdLog, 'utf8')).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\r?\n/g, '')
      .includes(`${fixtures.join(' ')} CMD_END`), 'literal multi-file CMD input accepts further typing');
    await localTab.click();
    await page.keyboard.type('Write-Output ');
    await dragFiles(local);
    await until(async () => (await shellText()).replace(/\r?\n/g, '').includes(fixtures.join(' ')), 'PowerShell receives the two unescaped absolute paths');
    await page.keyboard.press('Control+c');
    await enterPowerShell("Write-Output ('DROP_' + 'END')");
    await findOutput('DROP_END', true);
    await cmdTab.click();
    await click('左右分屏');
    const sshTab = page.getByRole('tab', { name: 'SSH', exact: true });
    await page.locator('#split-first').selectOption((await sshTab.getAttribute('id')).slice(4));
    await page.locator('#split-second').selectOption((await localTab.getAttribute('id')).slice(4));
    await click('应用分屏');
    assert.equal(await page.locator('.surface:visible').count(), 2);
    const sshSurface = page.locator('#' + await sshTab.getAttribute('aria-controls'));
    assert((await sshSurface.boundingBox()).x < (await local.boundingBox()).x);
    await nativeClipboard('copy', 'RIGHT_BUTTON_FIXTURE');
    const previous = clientInputs.length;
    await sshSurface.locator('.xterm-screen').click({ button: 'right' });
    await until(() => Buffer.from(clientInputs.slice(previous)).includes('RIGHT_BUTTON_FIXTURE'), 'right click pastes only into clicked SSH pane');
    assert(!Buffer.from(clientInputs.slice(previous)).includes(13));
    await click('交换窗格');
    assert((await local.boundingBox()).x < (await sshSurface.boundingBox()).x);
    const divider = await page.locator('.pane-divider').boundingBox();
    await page.mouse.move(divider.x + 3, divider.y + 40);
    await page.mouse.down();
    await page.mouse.move(divider.x + 45, divider.y + 40, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(await page.locator('.pane-divider').getAttribute('aria-valuenow'), '50');
    await sshSurface.locator('.pane-select').selectOption((await cmdTab.getAttribute('id')).slice(4));
    assert.equal(await sshSurface.isVisible(), false);
    assert.equal(await cmd.isVisible(), true);
    await local.locator('.xterm-screen').click();
    await enterPowerShell("Write-Output ('SIDE_' + 'PANE')");
    await until(async () => (await readFile(localLog, 'utf8')).includes('SIDE_PANE'), 'input in side-by-side pane');
    await cmd.locator('.xterm-screen').click();
    await click('取消分屏');
    assert.equal(await page.locator('.surface:visible').count(), 1);
    assert.equal(await cmd.isVisible(), true);
    await localTab.click();
    await findOutput('SIDE_PANE');
    await click('上下分屏');
    await click('应用分屏');
    assert((await local.boundingBox()).y < (await cmd.boundingBox()).y);
    await enterPowerShell("Write-Output ('STACKED_' + 'PANE')");
    await until(async () => (await readFile(localLog, 'utf8')).includes('STACKED_PANE'), 'input in stacked pane');
    await cmd.locator('.xterm-screen').click();
    await click('取消分屏');
    assert.equal(await page.locator('.surface:visible').count(), 1);
    assert.equal(await cmd.isVisible(), true);
    await page.keyboard.type('echo STACK_CANCEL_KEPT_CMD');
    await page.keyboard.press('Enter');
    await until(async () => (await readFile(cmdLog, 'utf8')).includes('\r\nSTACK_CANCEL_KEPT_CMD'), 'cancelled split keeps CMD connection and focus');
    await localTab.click();
    await findOutput('STACKED_PANE');
    await enterPowerShell('exit 7');
    await status('已断开');
    assert.match(await page.locator('#global-endpoint').textContent(), /7/);
    assert.equal((await readConfig('sessions.json')).recentConnections.length, 2);
    await page.locator('#session-connection[aria-label="连接"]').click();
    await page.getByRole('tab', { name: 'PowerShell', selected: true, exact: true }).waitFor();
    await status('已连接');
    assert.equal(await page.locator('#session-connection').getAttribute('aria-label'), '断开');
    console.log('Local PowerShell shortcut, interactive input, Ctrl+C, native PTY resize and exit passed');

    assert.deepEqual(errors, []);
    const runtime = join(profile, 'cache', 'runtime');
    const [runtimeHash] = await readdir(runtime);
    const runtimeSize = (await stat(join(runtime, runtimeHash, 'node.exe'))).size;
    assert(runtimeSize > size);
    const icon = await exec('powershell.exe', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Drawing; $icon = [Drawing.Icon]::ExtractAssociatedIcon($env:TD_FIXTURE_EXE); $bitmap = $icon.ToBitmap(); $bitmap.GetPixel([int]($bitmap.Width * .75), [int]($bitmap.Height * .25)).R; $bitmap.Dispose(); $icon.Dispose()'],
      { windowsHide: true, env: { ...process.env, TD_FIXTURE_EXE: executable } });
    assert(Number(icon.stdout.trim()) >= 220);
    const shortcut = join(folder, 'TermDock.lnk');
    const shortcutResult = await exec('powershell.exe', ['-NoProfile', '-STA', '-Command', [
      "$ErrorActionPreference='Stop'",
      "$asm=[Reflection.Assembly]::LoadFile($env:TD_FIXTURE_EXE)",
      "$tdDir=Split-Path -LiteralPath $env:TD_FIXTURE_EXE",
      "$method=$asm.GetType('StartMenuShortcut',$true).GetMethod('Write',[Reflection.BindingFlags]'Static,NonPublic')",
      "$method.Invoke($null,[string[]]@($env:TD_FIXTURE_SHORTCUT,$env:TD_FIXTURE_EXE,$tdDir,'TermDock.Desktop'))",
      "$link=(New-Object -ComObject WScript.Shell).CreateShortcut($env:TD_FIXTURE_SHORTCUT)",
      "$item=(New-Object -ComObject Shell.Application).Namespace((Split-Path -LiteralPath $env:TD_FIXTURE_SHORTCUT)).ParseName('TermDock.lnk')",
      "[PSCustomObject]@{Target=$link.TargetPath;Icon=$link.IconLocation;AppId=$item.ExtendedProperty('System.AppUserModel.ID')} | ConvertTo-Json -Compress",
    ].join('\n')], { windowsHide: true, env: { ...process.env, TD_FIXTURE_EXE: executable, TD_FIXTURE_SHORTCUT: shortcut } });
    const link = JSON.parse(shortcutResult.stdout);
    assert.equal(link.Target, executable);
    assert(link.Icon.startsWith(executable));
    assert.equal(link.AppId, 'TermDock.Desktop');
    const configuredAdb = join(folder, 'ADB 工具 目录');
    await page.locator('#settings').click();
    await page.locator('#settings-adb-tab').click();
    await until(async () => (await page.locator('#adb-directory').inputValue()) === join(profile, 'tools', 'adb'), 'initial ADB settings');
    assert.deepEqual(await page.locator('#adb-settings-form button').allTextContents(), ['选择目录', '保存']);
    // Supply the value that the native folder picker returns, then exercise the real Save IPC.
    await page.locator('#adb-directory').evaluate((input, directory) => { input.value = directory; }, configuredAdb);
    await page.locator('#adb-settings-form').getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#adb-status').textContent.includes('ADB 设置已保存'));
    assert.deepEqual((await readConfig('settings.json')).adb, { directory: configuredAdb, pullDirectory: configuredPull, systemPath: false });
    await closeLauncher();
    launcher = launch();
    await until(() => fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(400) }).then(r => r.ok, () => false), 'restarted launcher', 20000);
    const restarted = await chromium.connectOverCDP(endpoint);
    const reopenedPage = await until(() => restarted.contexts().flatMap(context => context.pages())
      .find(page => page.url() === 'https://termdock.local/index.html'), 'reopened application page');
    await reopenedPage.locator('#settings').click();
    await reopenedPage.locator('#settings-adb-tab').click();
    await until(async () => (await reopenedPage.locator('#adb-directory').inputValue()) === configuredAdb, 'ADB tool directory persists after restart');
    await reopenedPage.locator('#settings-dialog [data-dismiss]').first().click();
    await reopenedPage.locator('#quick-local').click();
    await reopenedPage.waitForFunction(() => document.querySelector('#global-state').textContent === '已连接');
    const newLocalLog = join(await reopenedPage.locator('.top-tools .session-logs').getAttribute('title'), 'session.log');
    const newShell = reopenedPage.locator('.surface:visible .xterm-helper-textarea');
    await newShell.focus();
    await reopenedPage.keyboard.type('(Get-Command adb -ErrorAction Stop).Source');
    await reopenedPage.keyboard.press('Enter');
    await until(async () => (await readFile(newLocalLog, 'utf8')).includes(join(configuredAdb, 'adb.exe')), 'new PowerShell resolves the configured ADB tool directory');
    await reopenedPage.locator('#top-more').click();
    const visibleMenu = reopenedPage.getByRole('menuitem');
    assert.deepEqual((await visibleMenu.allTextContents()).filter(text => /AI|分析选中日志|ADB/.test(text)), ['ADB 命令', 'AI 助手']);
    await visibleMenu.filter({ hasText: /^ADB 命令$/ }).click();
    await reopenedPage.keyboard.type('version');
    await reopenedPage.keyboard.press('Enter');
    await until(async () => (await readFile(newLocalLog, 'utf8')).includes('Android Debug Bridge version 1.0.41'), 'ADB command from the more menu');
    const reopenedSsh = reopenedPage.locator('#profiles .profile-open').filter({ hasText: '测试 SSH 重命名' });
    await reopenedSsh.click();
    const reopenedForm = reopenedPage.locator('#connect-form');
    await reopenedForm.getByText('密码已保存', { exact: false }).waitFor();
    assert.equal(await reopenedForm.locator('[name=password]').inputValue(), '');
    const savedPassword = reopenedForm.locator('#ssh-saved-secret');
    assert.equal(await savedPassword.locator('output').textContent(), '••••••••');
    await savedPassword.getByRole('button', { name: '显示' }).click();
    await reopenedPage.waitForFunction(() => document.querySelector('#ssh-saved-secret output').textContent === 'replacement-fixture-password');
    await savedPassword.getByRole('button', { name: '隐藏' }).click();
    assert.equal(await savedPassword.locator('output').textContent(), '••••••••');
    await reopenedForm.getByRole('button', { name: '连接', exact: true }).click();
    await reopenedPage.getByRole('tab', { name: '测试 SSH 重命名', selected: true, exact: true }).waitFor();
    await reopenedPage.waitForFunction(() => document.querySelector('#global-state').textContent === '已连接');
    assert.equal(passwordAttempts.at(-1), 'tester');
    await reopenedPage.locator('#session-connection[aria-label="断开"]').click();
    await reopenedPage.locator('#session-connection[aria-label="连接"]').click();
    await reopenedForm.getByText('密码已保存', { exact: false }).waitFor();
    assert.equal(await reopenedForm.locator('[name=host]').inputValue(), '127.0.0.1');
    assert.equal(await reopenedForm.locator('[name=port]').inputValue(), String(sshPort));
    assert.equal(await reopenedForm.locator('[name=username]').inputValue(), 'tester');
    assert.equal(await reopenedForm.locator('[name=password]').inputValue(), '');
    const reconnectAttempts = passwordAttempts.length;
    await reopenedForm.getByRole('button', { name: '连接', exact: true }).click();
    await until(() => passwordAttempts.length > reconnectAttempts, 'SSH connection toggle reuses saved credentials');
    await reopenedPage.getByRole('tab', { name: '测试 SSH 重命名', selected: true, exact: true }).waitFor();
    await reopenedPage.waitForFunction(() => document.querySelector('#global-state').textContent === '已连接');
    await reopenedSsh.click({ button: 'right' });
    await reopenedPage.locator('.context-menu').getByRole('button', { name: '设置 / 重命名…', exact: true }).click();
    await savedPassword.getByRole('button', { name: '显示' }).click();
    await reopenedPage.waitForFunction(() => document.querySelector('#ssh-saved-secret output').textContent === 'replacement-fixture-password');
    await reopenedForm.locator('[name=forgetPassword]').check();
    await reopenedForm.getByRole('button', { name: '保存', exact: true }).click();
    await until(async () => !(await readdir(credentialDir)).length, 'clear saved credential');
    console.log('PowerShell and SSH connection toggle, DPAPI, ADB prefix/menu and custom PATH after restart, file drop, split and session migration OK');
    console.log(`Portable ZIP verified (${size} bytes), first-run runtime extracted (${runtimeSize} bytes), migration, native COM and SSH UI passed`);
  } finally {
    await closeLauncher();
    for (const client of clients) client.end();
    await new Promise(resolve => ssh.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
