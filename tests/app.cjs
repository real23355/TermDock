const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { once } = require('node:events');
const { mkdir, mkdtemp, readdir, readFile, writeFile } = require('node:fs/promises');
const { createConnection } = require('node:net');
const { join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { build } = require('esbuild');
const { _electron } = require('playwright');
const { Server, utils } = require('ssh2');

const password = 'td-integration-password';
const passphrase = 'td-integration-key-passphrase';
const fullTiming = process.env.TERMDOCK_FULL_TIMING === '1';
const newHostKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });

function serveSftp(stream) {
  const { STATUS_CODE, OPEN_MODE } = utils.sftp;
  const files = new Map([['/fixture/remote.txt', Buffer.from([0, 255, 13, 10, 65])]]);
  const attrs = path => ({ mode: 0o100644, size: files.get(path).length });
  const handles = new Map();
  let current = 0;
  const handle = (id, path) => {
    const key = String(++current);
    handles.set(key, { path, listed: false });
    stream.handle(id, Buffer.from(key));
  };
  stream.on('REALPATH', (id, path) => stream.name(id, [{ filename: path === '.' ? '/fixture' : path, longname: '', attrs: {} }]));
  stream.on('OPENDIR', (id, path) => handle(id, path));
  stream.on('READDIR', (id, key) => {
    const directory = handles.get(key.toString());
    if (directory.listed) stream.status(id, STATUS_CODE.EOF);
    else {
      directory.listed = true;
      stream.name(id, [...files.keys()].map(path => ({ filename: path.split('/').pop(), longname: '', attrs: attrs(path) })));
    }
  });
  stream.on('STAT', (id, path) => files.has(path) ? stream.attrs(id, attrs(path)) : stream.status(id, STATUS_CODE.NO_SUCH_FILE));
  stream.on('OPEN', (id, path, flags) => {
    if (flags & OPEN_MODE.CREAT) {
      if (files.has(path) && flags & OPEN_MODE.EXCL) return stream.status(id, STATUS_CODE.FAILURE);
      files.set(path, Buffer.alloc(0));
    }
    if (!files.has(path)) return stream.status(id, STATUS_CODE.NO_SUCH_FILE);
    handle(id, path);
  });
  stream.on('READ', (id, key, offset, length) => {
    const bytes = files.get(handles.get(key.toString()).path);
    if (offset >= bytes.length) stream.status(id, STATUS_CODE.EOF);
    else stream.data(id, bytes.subarray(offset, offset + length));
  });
  stream.on('WRITE', (id, key, offset, bytes) => {
    const path = handles.get(key.toString()).path;
    const before = files.get(path);
    const output = Buffer.alloc(Math.max(before.length, offset + bytes.length));
    before.copy(output);
    bytes.copy(output, offset);
    files.set(path, output);
    stream.status(id, STATUS_CODE.OK);
  });
  stream.on('CLOSE', (id, key) => { handles.delete(key.toString()); stream.status(id, STATUS_CODE.OK); });
}

async function until(predicate, label, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(50);
  }
  throw new Error('Timed out: ' + label);
}

async function sshServer(key, acceptedKey, port = 0) {
  const state = { clients: new Set(), pty: [], resizes: [], inputs: [], shellInputs: [], methods: [] };
  const server = new Server({ hostKeys: [key] }, client => {
    state.clients.add(client);
    client.on('close', () => state.clients.delete(client));
    client.on('error', () => {});
    client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== 8080) { reject(); return; }
      const channel = accept();
      channel.on('data', data => channel.write(data));
    });
    client.on('authentication', context => {
      if (context.username !== 'tester') return context.reject();
      if (context.method === 'password' && context.password === password) {
        state.methods.push('password');
        return context.accept();
      }
      if (context.method === 'publickey' && context.key.data.equals(acceptedKey.getPublicSSH())) {
        if (!context.signature) return context.accept();
        if (acceptedKey.verify(context.blob, context.signature, context.hashAlgo) === true) {
          state.methods.push('key');
          return context.accept();
        }
      }
      context.reject(['password', 'publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', ok => serveSftp(ok()));
      session.on('pty', (ok, _reject, info) => { state.pty.push(info); ok(); });
      session.on('window-change', (_ok, _reject, info) => state.resizes.push(info));
      session.on('shell', ok => {
        const stream = ok();
        const shellInput = [];
        state.shellInputs.push(shellInput);
        stream.write('\x1b[38;5;203mSSH_PTY_READY 中文\x1b[0m\r\n$ ');
        stream.on('data', bytes => {
          state.inputs.push(...bytes);
          shellInput.push(...bytes);
          if (bytes.includes(0x25)) stream.write('\x1b[?1049h\x1b[2J\x1b[2;4HPTY_ALTERNATE');
          if (bytes.includes(0x04)) stream.write('\x1b[?1049l');
          if (bytes.includes('MOUSE_ENABLE')) stream.write('\x1b[?1000h\x1b[?1006hMOUSE_READY');
          if (bytes.includes('MOUSE_DISABLE')) stream.write('\x1b[?1000l\x1b[?1006l');
        });
      });
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    ...state, port: server.address().port,
    close: () => new Promise(resolve => {
      for (const client of state.clients) client.end();
      server.close(resolve);
    }),
  };
}

async function main() {
  await mkdir('test-output', { recursive: true });
  const dataDirectory = await mkdtemp(resolve('test-output/app-'));
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase,
  });
  const keyPath = join(dataDirectory, 'fixture-key.pem');
  await writeFile(keyPath, privateKey);
  const acceptedKey = utils.parseKey(privateKey, passphrase);
  assert(!(acceptedKey instanceof Error));
  let server = await sshServer(newHostKey(), acceptedKey);
  let electron;
  const errors = [];
  try {
    await build({
      entryPoints: ['tests/app-fixture.ts'], outfile: 'dist/test-app.cjs', bundle: true,
      platform: 'node', external: ['electron', 'serialport', 'ssh2'],
    });
    electron = await _electron.launch({ args: ['dist/test-app.cjs'], env: { ...process.env, TERMDOCK_TEST_DATA: dataDirectory } });
    electron.process().stderr?.on('data', bytes => {
      const text = bytes.toString();
      if (text.includes('Uncaught') || text.includes('Error occurred')) errors.push(text);
    });
    const page = await electron.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    const status = page.locator('#global-state');
    const surface = () => page.locator('.surface:visible');
    const value = (selector, expected, timeout = 8000) => page.waitForFunction(
      ([selector, expected]) => document.querySelector(selector)?.textContent?.includes(expected), [selector, expected], { timeout },
    );
    const click = async text => {
      const button = page.getByRole('button', { name: text, exact: true });
      if (!['重连', '交换窗格', '关闭分屏', 'Serial Break', '定时发送 / 重启测试'].includes(text)) return button.click();
      await page.locator('#top-more').click();
      return page.getByRole('menuitem', { name: text, exact: true }).click();
    };
    const fill = (name, text) => page.locator(`#connect-form [name="${name}"]`).fill(String(text));
    const press = key => page.keyboard.press(key);
    const addGroup = async name => {
      await click('新建分组');
      await page.locator('#command-group-name').fill(name);
    };
    const addCommand = async (name, command, ending = 'CR') => {
      await click('添加按钮');
      const row = page.locator('.command-edit-row').last();
      await row.locator('[name=name]').fill(name);
      await row.locator('[name=command]').fill(command);
      await row.locator('[name=lineEnding]').selectOption(ending);
    };
    const feed = data => electron.evaluate((_e, bytes) => globalThis.fixture.feed(bytes), [...Buffer.from(data)]);
    const sent = async () => Buffer.from(await electron.evaluate(() => globalThis.fixture.sent()));
    const shellState = text => value('.surface:not([hidden]) .shell-state', text);
    const timerState = (text, timeout) => value('.surface:not([hidden]) .send-state', text, timeout);
    const focus = () => surface().locator('.xterm-helper-textarea').focus();
    const sshFields = async () => {
      await page.locator('#quick-ssh').click();
      await fill('host', '127.0.0.1');
      await fill('port', server.port);
      await fill('username', 'tester');
      await fill('name', 'SSH fixture');
    };

    await value('#profile-count', '00');
    await click('管理按钮');
    await addGroup('板卡');
    await addCommand('查询板卡', 'echo board', 'CRLF');
    await addGroup('Linux');
    await addCommand('系统信息', 'uname -a', 'LF');
    await click('保存');
    assert.equal(await page.getByRole('button', { name: '系统信息', exact: true }).isDisabled(), true);

    await sshFields();
    await fill('password', password);
    await click('保存');
    await page.locator('#profiles .profile-open').filter({ hasText: 'SSH fixture' }).click();
    assert.equal(await page.locator('[name=password]').inputValue(), '');
    await fill('password', password);
    await click('连接');
    await page.locator('#key-dialog').waitFor();
    assert.match(await page.locator('#key-fingerprint').textContent(), /^SHA256:[A-Za-z0-9+/]{43}$/);
    await click('信任并连接');
    await value('#global-state', '已连接');
    await click('SFTP');
    const sftp = page.locator('#sftp-dialog');
    await sftp.getByText('remote.txt', { exact: true }).waitFor();
    const downloaded = join(dataDirectory, 'downloaded.bin');
    const choosePath = path => electron.evaluate((_electron, choice) => globalThis.fixture.choosePath(choice), path);
    await choosePath(downloaded);
    await sftp.getByRole('button', { name: '下载', exact: true }).click();
    await value('#sftp-status', '下载完成');
    assert.deepEqual(await readFile(downloaded), Buffer.from([0, 255, 13, 10, 65]));
    const uploaded = join(dataDirectory, 'upload.bin');
    const payload = Buffer.from([2, 100, 0, 255]);
    await writeFile(uploaded, payload);
    await choosePath(uploaded);
    await sftp.getByRole('button', { name: '上传', exact: true }).click();
    await value('#sftp-status', '上传完成');
    const copy = join(dataDirectory, 'copy.bin');
    await choosePath(copy);
    await sftp.locator('.sftp-entry').filter({ hasText: 'upload.bin' }).getByRole('button', { name: '下载' }).click();
    await value('#sftp-status', '下载完成');
    assert.deepEqual(await readFile(copy), payload);
    await sftp.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '导入会话…' }).count(), 0);
    console.log('SFTP list, binary download, upload, and absence of import entry OK');
    await click('端口转发');
    const forwards = page.locator('#forward-dialog');
    await forwards.locator('[name=port]').fill('8080');
    await click('开始转发');
    await forwards.getByRole('button', { name: '停止转发' }).waitFor();
    const forwardPort = Number((await forwards.locator('#active-forwards span').textContent()).match(/127\.0\.0\.1:(\d+)/)[1]);
    const tunnel = createConnection({ host: '127.0.0.1', port: forwardPort });
    try {
      await once(tunnel, 'connect', { signal: AbortSignal.timeout(5000) });
      const echoed = once(tunnel, 'data', { signal: AbortSignal.timeout(5000) });
      tunnel.write('forward-ok');
      assert.equal(String((await echoed)[0]), 'forward-ok');
    } finally { tunnel.destroy(); }
    await click('停止转发');
    await forwards.getByRole('button', { name: '停止转发' }).waitFor({ state: 'detached' });
    const closedTunnel = createConnection({ host: '127.0.0.1', port: forwardPort });
    try {
      await assert.rejects(once(closedTunnel, 'connect', { signal: AbortSignal.timeout(5000) }), { code: 'ECONNREFUSED' });
    } finally { closedTunnel.destroy(); }
    await forwards.getByRole('button', { name: '关闭', exact: true }).click();
    console.log('Local SSH forwarding round-trip and listener release OK');
    await value('#global-state', '已连接');
    await until(() => server.pty.length === 1, 'PTY requested');
    assert.equal(server.pty[0].term, 'xterm-256color');
    assert(server.pty[0].cols > 70);
    console.log('Initial renderer: ' + await page.locator('#global-renderer').textContent());
    await page.locator('#settings').click();
    await page.locator('#settings-form [name=gpu]').uncheck();
    await click('应用');
    await value('#global-renderer', 'DOM');
    await electron.evaluate(() => globalThis.fixture.resize(1120, 690));
    await until(() => server.resizes.some(size => size.cols < server.pty[0].cols && size.rows < server.pty[0].rows), 'remote PTY resize');
    const expandedCols = server.resizes.at(-1).cols;
    await click('收起会话栏');
    assert.equal(await page.locator('#session-sidebar').isVisible(), false);
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
    await until(() => server.resizes.at(-1).cols > expandedCols, 'PTY expands when sidebar is hidden');
    await click('展开会话栏');
    assert.equal(await page.locator('#session-sidebar').isVisible(), true);
    await until(() => server.resizes.at(-1).cols === expandedCols, 'PTY shrinks when sidebar is restored');
    assert.equal(server.clients.size, 1);
    await focus();
    for (const key of ['Control+b', 'ArrowUp', 'Tab', 'Control+c', '%']) await press(key);
    await until(() => Buffer.from(server.inputs).includes(Buffer.from([2, 27, 91, 65, 9, 3, 37])), 'terminal keys');
    await value('.surface:not([hidden]) .xterm-accessibility-tree, .surface:not([hidden]) .xterm-rows', 'PTY_ALTERNATE');
    await press('Control+d');
    await value('.surface:not([hidden]) .xterm-rows', 'SSH_PTY_READY 中文');
    assert.match(await surface().locator('.xterm-fg-203').first().textContent(), /SSH_PTY_READY/);
    await press('Control+Shift+f');
    await surface().locator('.search-value').fill('SSH_PTY_READY');
    await value('.surface:not([hidden]) .search-result', '1 / 1');
    await focus();
    await page.evaluate(() => window.termDock.copy('COPY_PLACEHOLDER'));
    await press('Control+Shift+c');
    await until(async () => (await page.evaluate(() => window.termDock.paste())) === 'SSH_PTY_READY', 'clipboard copy');
    await surface().getByRole('button', { name: '关闭搜索' }).click();
    await page.evaluate(() => window.termDock.copy('PASTE_TEST'));
    await press('Control+Shift+v');
    await until(() => Buffer.from(server.inputs).includes('PASTE_TEST'), 'clipboard paste');
    await page.evaluate(() => window.termDock.copy('MOUSE_ENABLE'));
    await press('Control+Shift+v');
    await value('.surface:not([hidden]) .xterm-rows', 'MOUSE_READY');
    await surface().locator('.xterm-screen').click({ position: { x: 40, y: 25 } });
    await until(() => Buffer.from(server.inputs).includes('\x1b[<0;'), 'SGR mouse input');
    const selection = await page.evaluate(() => {
      const root = document.querySelector('.surface:not([hidden]) .xterm-rows');
      const texts = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = texts.nextNode(); node; node = texts.nextNode()) {
        const offset = node.textContent.indexOf('MOUSE_READY');
        if (offset < 0) continue;
        const range = new Range();
        range.setStart(node, offset);
        range.setEnd(node, offset + 'MOUSE_READY'.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.left, y: rect.top + rect.height / 2, end: rect.right };
      }
    });
    assert(selection, 'DOM renderer contains the mouse-mode fixture text');
    await page.keyboard.down('Shift');
    await page.mouse.move(selection.x + 1, selection.y);
    await page.mouse.down();
    await page.mouse.move(selection.end + 1, selection.y, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await until(async () => (await page.evaluate(() => window.termDock.paste())).includes('MOUSE_READY'), 'shift mouse selection auto-copy while mouse reporting is enabled');
    await page.evaluate(() => window.termDock.copy('MOUSE_DISABLE'));
    await press('Control+Shift+v');
    console.log('SSH password, fingerprint, PTY, keys, alternate screen, UTF-8, color, search, clipboard and mouse OK');

    await sshFields();
    await page.locator('[name=method]').selectOption('key');
    await electron.evaluate((_e, path) => globalThis.fixture.choosePath(path), keyPath);
    await click('浏览');
    await until(async () => (await page.locator('[name=privateKey]').inputValue()) === keyPath, 'key file dialog');
    await fill('passphrase', passphrase);
    await click('连接');
    await value('#global-state', '已连接');
    assert.equal(await page.locator('#key-dialog').isVisible(), false);
    assert.deepEqual(server.methods, ['password', 'key']);
    assert.equal(await page.getByRole('tab').count(), 2);
    await page.getByRole('button', { name: '关闭 SSH fixture' }).last().click();
    await until(() => server.clients.size === 1, 'close only selected SSH transport');
    assert.equal(await status.textContent(), '已连接');
    console.log('Encrypted SSH private key and independent tabs OK');

    await page.locator('#quick-serial').click();
    await until(() => page.locator('#ports option[value=COM77]').count(), 'COM enumeration');
    assert.equal(await page.locator('[name=baudRate]').inputValue(), '921600');
    assert.equal(await page.locator('[name=flow]').inputValue(), 'software');
    await page.locator('[name=logFormat]').selectOption('raw');
    await fill('path', 'COM77');
    await fill('name', 'Serial fixture');
    await click('连接');
    await value('#global-state', '已连接');
    const serialLogs = async () => {
      const root = join(dataDirectory, 'logs');
      const paths = (await readdir(root)).filter(name => name.includes('_Serial_fixture_'));
      return join(root, paths[0]);
    };
    const directory = await serialLogs();
    const start = () => surface().getByRole('button', { name: '开始', exact: true }).click();
    const stop = () => surface().getByRole('button', { name: '停止', exact: true }).click();
    const timerInput = name => surface().locator(`.timer-form [name=${name}]`);
    const raw = [];
    async function serialOutput(data) { raw.push(Buffer.from(data)); await feed(data); }
    await serialOutput('PRELUDE\r\n\x1b[32mroot@board:~');
    await serialOutput('#\x1b[0m ');
    await shellState('已就绪');
    assert.equal(await timerInput('intervalSeconds').inputValue(), '60');
    if (!fullTiming) await timerInput('intervalSeconds').fill('1');
    await timerInput('maxRounds').fill('2');
    const started = Date.now();
    await start();
    await timerState('倒计时');
    assert.equal((await sent()).length, 0);
    await until(async () => (await sent()).toString() === 'reboot\r', 'first reboot', fullTiming ? 65000 : 4000);
    assert(Date.now() - started >= (fullTiming ? 59950 : 950));
    const round1 = Buffer.concat([Buffer.from('\r\nROUND1 BL2\r\n'), Buffer.from([0x00, 0xff]), Buffer.from('\r\nHit any key to stop autoboot: 0\r\n=> ')]);
    await serialOutput(round1);
    await shellState('引导程序');
    await value('.surface:not([hidden]) .boot-marker', '已看到');
    await timerState('等待', fullTiming ? 65000 : 8000);
    assert.equal((await sent()).toString(), 'reboot\r');
    await serialOutput('\r\nLinux starting\r\nboard login: ');
    await shellState('登录提示');
    await sleep(fullTiming ? 1700 : 1100);
    assert.equal((await sent()).toString(), 'reboot\r');
    await focus();
    await page.keyboard.type('root');
    await press('Enter');
    await serialOutput('\r\n/ # ');
    await until(async () => (await sent()).toString() === 'reboot\rroot\rreboot\r', 'one reboot after shell recovery');
    await timerState('已完成');
    const round2 = Buffer.from('\r\nROUND2\r\n# ');
    await serialOutput(round2);
    await shellState('已就绪');
    await value('.surface:not([hidden]) .recovered-rounds', '2');
    await page.screenshot({ path: join(dataDirectory, 'serial.png') });
    const files = (await readdir(directory)).filter(name => name.startsWith('reboot_')).sort();
    assert.equal(files.length, 2);
    assert.deepEqual(await readFile(join(directory, files[0])), Buffer.concat(raw.slice(2, 5)));
    await until(async () => (await readFile(join(directory, files[1]))).equals(round2), 'raw second round');
    console.log('Two serial reboot rounds, U-Boot, login gate, long recovery and raw boundaries OK');

    await timerInput('intervalSeconds').fill('1');
    await timerInput('maxRounds').fill('');
    await timerInput('lineEnding').selectOption('CRLF');
    await focus();
    await page.keyboard.type('echo');
    await serialOutput('\r# ');
    await shellState('手动交互');
    await start();
    await timerState('等待');
    assert.equal((await sent()).toString(), 'reboot\rroot\rreboot\recho');
    await press('Enter');
    await serialOutput('\r\n# ');
    await until(async () => (await sent()).toString().endsWith('echo\rreboot\r\n'), 'manual command gate and CRLF');
    await stop();
    await timerState('已停止');
    const tail = Buffer.from('\r\nAFTER_STOP\r\n# ');
    await serialOutput(tail);
    await shellState('已就绪');
    await sleep(1100);
    assert.equal((await sent()).toString(), 'reboot\rroot\rreboot\recho\rreboot\r\n');
    const lastRound = (await readdir(directory)).find(name => name.startsWith('reboot_0003_'));
    assert.deepEqual(await readFile(join(directory, lastRound)), tail);
    const segment = /^COM77-\d{8}_\d{6}(?:-\d+)?\.log$/;
    const segments = async path => (await readdir(path)).filter(name => segment.test(name));
    const originalSegment = (await segments(directory))[0];
    assert.deepEqual(await readFile(join(directory, originalSegment)), Buffer.concat(raw));
    const events = await readFile(join(directory, 'events.log'), 'utf8');
    assert.equal((events.match(/\tsent\t/g) || []).length, 3);
    assert.match(events, /test_stopped/);
    console.log('Manual input gating, configurable CRLF, stop and continuous session/round logs OK');

    await click('停止记录');
    await feed('SESSION_RECORDING_PAUSED\r\n# ');
    await value('.surface:not([hidden]) .round-recording', '记录中');
    await until(async () => (await readFile(join(directory, lastRound))).includes('SESSION_RECORDING_PAUSED'), 'round keeps recording during pause');
    assert.deepEqual(await readFile(join(directory, originalSegment)), Buffer.concat(raw));
    await click('开始记录');
    await feed('SESSION_RECORDING_RESUMED\r\n# ');
    const nextSegment = (await segments(directory)).find(name => name !== originalSegment);
    assert(nextSegment);
    await until(async () => (await readFile(join(directory, nextSegment))).toString() === 'SESSION_RECORDING_RESUMED\r\n# ', 'new COM named segment');
    console.log('Manual serial recording closes the old file while the per-round log continues');

    await start();
    await electron.evaluate(() => globalThis.fixture.diskFailure());
    await timerState('异常停止');
    await value('#notice span', '日志写入失败');
    await sleep(1100);
    assert.equal((await sent()).toString(), 'reboot\rroot\rreboot\recho\rreboot\r\n');
    await electron.evaluate(() => globalThis.fixture.disconnect());
    await value('#global-state', '已断开');
    await click('重连');
    await click('连接');
    await value('#global-state', '已连接');
    await timerState('未开始');
    await start();
    await electron.evaluate(() => globalThis.fixture.disconnect());
    await value('#global-state', '已断开');
    await timerState('异常停止');
    assert.equal((await sent()).length, 0);
    console.log('Disk failure, serial disconnect and manual restart after reconnect OK');

    await click('关闭 Serial fixture');
    await page.locator('#quick-serial').click();
    await fill('path', 'COM77');
    await fill('name', 'Timestamp fixture');
    const defaultRoot = join(dataDirectory, 'logs');
    const customRoot = join(dataDirectory, '自定义 串口日志');
    const directoryField = page.locator('[name=logDirectory]');
    assert.equal(await directoryField.getAttribute('placeholder'), defaultRoot);
    assert.equal(await page.locator('[name=logFormat]').inputValue(), 'timestamped');
    await mkdir(customRoot);
    await electron.evaluate((_e, path) => globalThis.fixture.choosePath(path), customRoot);
    await click('浏览');
    await until(async () => (await directoryField.inputValue()) === customRoot, 'custom log directory');
    await click('默认');
    assert.equal(await directoryField.inputValue(), '');
    await click('浏览');
    await until(async () => (await directoryField.inputValue()) === customRoot, 'restore custom directory');
    await click('保存');
    await page.locator('#profiles .profile-open').filter({ hasText: 'Timestamp fixture' }).click();
    await value('#global-state', '已连接');
    const [timestampFolder] = await readdir(customRoot);
    const timestampDir = join(customRoot, timestampFolder);
    const sessionLog = join(timestampDir, (await segments(timestampDir))[0]);
    assert.equal(await page.locator('.top-tools .session-logs').getAttribute('title'), timestampDir);
    const timestamp = /\[\d{4}_\d{2}_\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] /g;
    const withoutTimes = text => text.replace(timestamp, '<time>');
    await feed('FIRST\r');
    await until(async () => withoutTimes(await readFile(sessionLog, 'latin1')) === '<time>FIRST\r', 'flush before split LF');
    await feed(Buffer.from('\nSECOND\x00\xff\n\nBARE\rNEXT\n# ', 'latin1'));
    await shellState('已就绪');
    const beforeRound = '<time>FIRST\r\n<time>SECOND\x00\xff\n<time>\n<time>BARE\r<time>NEXT\n<time># ';
    assert.equal(withoutTimes(await readFile(sessionLog, 'latin1')), beforeRound);
    await timerInput('intervalSeconds').fill('1');
    await timerInput('maxRounds').fill('1');
    await start();
    await timerState('已完成');
    await feed('CONTINUED\r\nFINAL');
    const roundLog = (await readdir(timestampDir)).find(name => name.startsWith('reboot_0001_') && name.endsWith('.log'));
    await until(async () => withoutTimes(await readFile(join(timestampDir, roundLog), 'latin1')) ===
      '<time>CONTINUED\r\n<time>FINAL', 'independent timestamp boundaries in round log');
    assert.equal(await readFile(join(timestampDir, roundLog.replace(/\.log$/, '.raw')), 'latin1'), 'CONTINUED\r\nFINAL');
    assert.equal(await readFile(sessionLog.replace(/\.log$/, '.raw'), 'latin1'),
      'FIRST\r\nSECOND\x00\xff\n\nBARE\rNEXT\n# CONTINUED\r\nFINAL');
    assert.equal(withoutTimes(await readFile(sessionLog, 'latin1')), beforeRound + 'CONTINUED\r\n<time>FINAL');
    console.log('Default and custom log paths, saved settings, millisecond prefixes and split line endings OK');

    await timerInput('workflowMode').selectOption('steps');
    await timerInput('once').check();
    await timerInput('waitForShell').uncheck();
    const rows = surface().locator('.workflow-list li');
    const addStep = async (type, command) => {
      await surface().locator('.add-step').click();
      const row = rows.last();
      await row.locator('.step-type').selectOption(type);
      if (command) await row.locator('.step-command').fill(command);
      return row;
    };
    await rows.first().locator('.step-command').fill('A');
    await addStep('send', 'B');
    await addStep('wait');
    await rows.last().locator('[data-step=up]').click();
    await surface().locator('.timer-collapse').click();
    assert.equal(await surface().locator('.timer-panel').isVisible(), false);
    await surface().locator('.timer-expand').click();
    assert.equal(await rows.first().locator('.step-command').inputValue(), 'A');
    await start();
    await timerState('已完成');
    assert((await sent()).toString().endsWith('A\rB\r'));
    const workflowEvents = join(timestampDir, 'events.log');
    await until(async () => (await readFile(workflowEvents, 'utf8')).includes('configured_ms=1'), '1 ms delay measurement');
    const timing = (await readFile(workflowEvents, 'utf8')).split(/\r?\n/).filter(line => /configured_ms=1|step=3\/3 command/.test(line)).slice(-2);
    console.log('Windows simulated serial timing: ' + timing.map(line => line.split('\t').slice(1).join(' ')).join('; '));

    await rows.first().locator('.step-command').fill('reboot');
    await rows.nth(1).locator('.step-time').fill('90');
    await addStep('login');
    await rows.last().locator('[data-step=up]').click();
    await addStep('wait');
    await rows.last().locator('.step-time').fill('0.01');
    await rows.last().locator('.step-unit').selectOption('s');
    await rows.last().locator('[data-step=up]').click();
    await timerInput('loginEnabled').check();
    const loginSecret = 'example-fixture-login-password';
    const loginConfig = async () => {
      await timerInput('loginUsername').fill('serial-user');
      await timerInput('loginPassword').fill(loginSecret);
      await timerInput('loginTimeout').fill('1');
    };
    const suffix = async (base, expected) =>
      until(async () => (await sent()).subarray(base).toString() === expected, 'serial workflow writes ' + expected.replace(loginSecret, '(masked)'));
    const stepState = text => value('.surface:not([hidden]) .timer-detail', text);
    await loginConfig();
    await feed('\r\nold login:\r\n# ');
    await shellState('已就绪');
    let base = (await sent()).length;
    await start();
    await suffix(base, 'reboot\r');
    await feed('\r\nBL2 fresh boot\r\nboard lo');
    await feed('gin: ');
    await suffix(base, 'reboot\rserial-user\r');
    await feed('\r\nPass');
    await feed('word: ');
    await suffix(base, 'reboot\rserial-user\r' + loginSecret + '\r');
    await stepState('凭据已写入');
    await feed(loginSecret.slice(0, 9));
    await feed(loginSecret.slice(9) + '\r\n# ');
    await suffix(base, 'reboot\rserial-user\r' + loginSecret + '\rB\r');
    await timerState('已完成');
    for (const file of (await readdir(timestampDir)).filter(name => name.endsWith('.log') || name.endsWith('.raw'))) {
      assert(!(await readFile(join(timestampDir, file))).includes(loginSecret), file);
    }
    assert.match(await readFile(workflowEvents, 'utf8'), /login_confirmed/);
    await loginConfig();
    base = (await sent()).length;
    await start();
    await suffix(base, 'reboot\r');
    await stepState('等待本轮登录提示');
    await feed('\r\n# ');
    await timerState('异常停止');
    await stepState('等待登录提示超时');
    assert.equal((await sent()).subarray(base).toString(), 'reboot\r');

    await loginConfig();
    base = (await sent()).length;
    await start();
    await suffix(base, 'reboot\r');
    await feed('\r\nboard login: ');
    await suffix(base, 'reboot\rserial-user\r');
    await feed('\r\nPassword: ');
    await suffix(base, 'reboot\rserial-user\r' + loginSecret + '\r');
    await feed('\r\nLogin incorrect\r\nboard login: ');
    await timerState('异常停止');
    await stepState('设备拒绝登录');
    assert.equal((await sent()).subarray(base).toString(), 'reboot\rserial-user\r' + loginSecret + '\r');

    await timerInput('loginEnabled').uncheck();
    await feed('\r\n# ');
    await shellState('已就绪');
    base = (await sent()).length;
    await start();
    await suffix(base, 'reboot\rB\r');
    await timerState('已完成');
    assert.match(await readFile(workflowEvents, 'utf8'), /login_skipped/);

    await rows.nth(1).locator('.step-time').fill('5500');
    base = (await sent()).length;
    await start();
    await suffix(base, 'reboot\r');
    await stepState('等待 5500 ms');
    await stop();
    await timerState('已停止');
    await sleep(250);
    assert.equal((await sent()).subarray(base).toString(), 'reboot\r');
    const serialBeforeCommands = (await sent()).length;
    console.log('Workflow steps, early and fragmented prompts, redacted echo, timeout, rejection, skip and stop OK');

    for (let index = 3; index <= 6; index++) {
      await sshFields();
      await fill('name', `SSH ${index}`);
      await fill('password', password);
      await click('连接');
      await value('#global-state', '已连接');
    }
    const tabNames = () => page.getByRole('tab').allTextContents();
    const selected = () => page.getByRole('tab', { selected: true }).textContent();
    assert.deepEqual(await tabNames(), ['SSH fixture', 'Timestamp fixture', 'SSH 3', 'SSH 4', 'SSH 5', 'SSH 6']);
    assert.equal(server.clients.size, 5);
    const inputCount = server.inputs.length;
    await press('Alt+1');
    assert.equal(await selected(), 'SSH fixture');
    await press('Alt+2');
    assert.equal(await selected(), 'Timestamp fixture');
    await press('Alt+6');
    assert.equal(await selected(), 'SSH 6');
    await page.getByRole('tab', { name: 'SSH 6', exact: true })
      .dragTo(page.getByRole('tab', { name: 'SSH fixture', exact: true }));
    assert.deepEqual(await tabNames(), ['SSH 6', 'Timestamp fixture', 'SSH 3', 'SSH 4', 'SSH 5', 'SSH fixture']);
    await press('Alt+6');
    assert.equal(await selected(), 'SSH fixture');
    await press('Alt+1');
    assert.equal(await selected(), 'SSH 6');
    assert.equal(server.inputs.length, inputCount);
    assert.equal((await sent()).length, serialBeforeCommands);
    console.log('Six live sessions, mouse drag swap and Alt shortcuts in display order OK');

    const shellSizes = server.shellInputs.map(bytes => bytes.length);
    await click('系统信息');
    await until(() => Buffer.from(server.shellInputs.at(-1)).subarray(shellSizes.at(-1)).toString() === 'uname -a\n',
      'command button sends LF only to the active SSH shell');
    assert.deepEqual(server.shellInputs.slice(0, -1).map(bytes => bytes.length), shellSizes.slice(0, -1));
    assert.equal((await sent()).length, serialBeforeCommands);
    await press('Alt+2');
    await page.locator('#command-group').selectOption({ label: '板卡' });
    await click('查询板卡');
    await suffix(serialBeforeCommands, 'echo board\r\n');
    await page.locator('#command-group').selectOption({ label: 'Linux' });
    await click('管理按钮');
    for (let index = 1; index <= 16; index++) {
      await addCommand(`测试换行滚动的自定义命令按钮 ${index}`, `echo test ${index}`, 'none');
    }
    await click('保存');
    await page.locator('#command-overflow').waitFor();
    const ordering = await page.locator('#command-button-list button, #command-overflow-menu button').allTextContents();
    assert.equal(ordering.length, 17);
    assert(ordering.at(-1).endsWith('16'));
    assert.equal(await page.locator('.command-bar').evaluate(el => el.getBoundingClientRect().height), 28);
    await page.locator('#command-overflow').click();
    const menuBox = await page.locator('#command-overflow-menu').boundingBox();
    assert(menuBox.y + menuBox.height <= (await page.locator('.command-bar').boundingBox()).y);
    await page.locator('#command-overflow-menu button').last().click();
    await suffix(serialBeforeCommands, 'echo board\r\necho test 16');
    await click('管理按钮');
    await page.locator('.command-edit-row').last().getByRole('button', { name: '删除按钮' }).click();
    await addGroup('待删除分组');
    await click('删除分组');
    await click('保存');
    assert.deepEqual(await page.locator('#command-group option').allTextContents(), ['板卡', 'Linux']);
    await page.locator('#command-group').selectOption({ label: 'Linux' });
    assert.equal(await page.locator('#command-button-list button, #command-overflow-menu button').count(), 16);
    console.log('Grouped command buttons, active-tab routing, line endings, single-line overflow menu and deletion OK');
    await focus();
    await press('Control+c');
    await feed('\r\n# ');
    await shellState('已就绪');
    base = (await sent()).length;
    await start();
    await suffix(base, 'reboot\r');
    await electron.evaluate(() => globalThis.fixture.disconnect());
    await value('#global-state', '已断开');
    await timerState('异常停止');
    assert.equal((await sent()).subarray(base).toString(), 'reboot\r');
    console.log('Disconnect cancels pending workflow steps');

    const port = server.port;
    await server.close();
    server = await sshServer(newHostKey(), acceptedKey, port);
    await sshFields();
    await fill('password', password);
    await click('连接');
    await value('#notice span', '主机密钥已变化');
    assert.equal(await page.locator('#key-dialog').isVisible(), false);
    assert.equal(server.methods.length, 0);
    await page.getByRole('button', { name: '编辑 SSH fixture', exact: true }).click();
    await fill('name', 'SSH fixture edited');
    await click('保存');
    await page.locator('#profiles .profile-open').filter({ hasText: 'SSH fixture edited' }).waitFor();
    const settings = await readFile(join(dataDirectory, 'settings.json'), 'utf8');
    const sessions = await readFile(join(dataDirectory, 'sessions.json'), 'utf8');
    const buttons = await readFile(join(dataDirectory, 'command-buttons.json'), 'utf8');
    for (const file of [settings, sessions, buttons]) {
      assert(!file.includes(password) && !file.includes(passphrase) && !file.includes(keyPath));
    }
    assert.equal(JSON.parse(settings).profiles, undefined);
    assert.equal(JSON.parse(settings).commandGroups, undefined);
    const { profiles, recentConnections } = JSON.parse(sessions);
    assert.equal(profiles.length, 2);
    assert.equal(profiles[0].name, 'SSH fixture edited');
    assert.equal(profiles[1].logDirectory, customRoot);
    assert.equal(profiles[1].logFormat, 'timestamped');
    assert.deepEqual(recentConnections.map(connection => connection.profile.name), ['SSH 6', 'Timestamp fixture']);
    assert(recentConnections.every(connection => connection.profile.id === undefined));
    assert.deepEqual(JSON.parse(buttons).commandGroups.map(group => [group.name, group.buttons.length]), [['板卡', 1], ['Linux', 16]]);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(dataDirectory, 'verified.png') });
    console.log('Changed SSH host key blocked before authentication and config contains no auth fields');
    await electron.close();
    electron = await _electron.launch({ args: ['dist/test-app.cjs'], env: { ...process.env, TERMDOCK_TEST_DATA: dataDirectory } });
    const restarted = await electron.firstWindow();
    const recent = restarted.locator('#recent-connections .profile-open');
    await recent.filter({ hasText: 'SSH 6' }).click();
    assert.equal(await restarted.locator('#connect-form [name=host]').inputValue(), '127.0.0.1');
    assert.equal(await restarted.locator('#connect-form [name=password]').inputValue(), '');
    await restarted.getByRole('button', { name: '取消', exact: true }).click();
    await recent.filter({ hasText: 'Timestamp fixture' }).click();
    await restarted.waitForFunction(() => document.querySelector('#global-state').textContent === '已连接');
    const logPath = await restarted.locator('.top-tools .session-logs').getAttribute('title');
    assert(logPath.startsWith(customRoot));
    assert.deepEqual(await restarted.locator('#command-group option').allTextContents(), ['板卡', 'Linux']);
    console.log('Independent connection history and command groups survived restart');
    console.log('Verified through the desktop application. Logs: ' + dataDirectory);
  } finally {
    if (electron) await electron.close();
    await server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
