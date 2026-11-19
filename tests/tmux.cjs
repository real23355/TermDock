const assert = require('node:assert/strict');
const { execFile, execFileSync, spawn, spawnSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const { Server } = require('ssh2');
const { releaseVersion } = require('../package.json');
if (!process.env.TERMDOCK_TMUX_MSYS) {
  throw new Error('Set TERMDOCK_TMUX_MSYS to the MSYS2 root with tmux and python installed');
}

const exec = promisify(execFile);
const msys = resolve(process.env.TERMDOCK_TMUX_MSYS);
const usrBin = join(msys, 'usr', 'bin');
const tmux = join(usrBin, 'tmux.exe');
const python = join(usrBin, 'python.exe');
const shell = existsSync(join(usrBin, 'bash.exe')) ? '/usr/bin/bash --noprofile --norc' : '/usr/bin/sh -i';
const socket = 'termdock-ssh-test-' + process.pid;
const env = {
  ...process.env,
  TERM: 'xterm-256color',
  TERMINFO: '/usr/lib/terminfo',
  MSYSTEM: 'MSYS',
  MSYS: 'disable_pcon',
  HOME: '/tmp',
  SHELL: existsSync(join(usrBin, 'bash.exe')) ? '/usr/bin/bash' : '/usr/bin/sh',
  PATH: usrBin + ';' + process.env.SystemRoot + '\\System32',
};
delete env.TMUX;
delete env.TMUX_PANE;
mkdirSync(join(msys, 'tmp'), { recursive: true });
const ptyFixture = execFileSync(join(usrBin, 'cygpath.exe'), ['-u', resolve(__dirname, 'tmux-pty.py')],
  { env, cwd: msys, windowsHide: true, encoding: 'utf8' }).trim();

function tmuxCommand(...args) {
  return spawnSync(tmux, ['-L', socket, ...args], { env, cwd: msys, windowsHide: true, encoding: 'utf8', timeout: 3000 });
}

function tmuxQuery(...args) {
  const result = tmuxCommand(...args);
  return result.status === 0 ? result.stdout.trim() : '';
}

function ptyPacket(operation, payload) {
  const header = Buffer.alloc(5);
  header[0] = operation;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function ptySize({ rows, cols, width, height }) {
  const packet = Buffer.alloc(8);
  [rows, cols, width ?? 0, height ?? 0].forEach((value, index) => packet.writeUInt16LE(value, index * 2));
  return ptyPacket(2, packet);
}

async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(100);
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
  const archive = resolve(process.argv[2] ?? `release/TermDock-${releaseVersion}-win-x64.zip`);
  mkdirSync('test-output', { recursive: true });
  const folder = mkdtempSync(resolve('test-output/tmux-'));
  assert.equal(spawnSync('tar.exe', ['-xf', archive, '-C', folder], { windowsHide: true, stdio: 'inherit' }).status, 0);
  const probe = createServer();
  const debugPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set();
  const resize = [];
  const input = [];
  const measurements = [];
  const exits = [];
  const ptyErrors = [];
  let output = '';
  let initialSize;
  const version = execFileSync(tmux, ['-V'], { env, cwd: msys, windowsHide: true, encoding: 'utf8' }).trim();
  const ssh = new Server({ hostKeys: [key] }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', auth => {
      if (auth.method === 'password' && auth.username === 'tester' && auth.password === 'fixture-password') auth.accept();
      else auth.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      let terminal;
      session.on('pty', (ok, _reject, info) => { initialSize = info; ok(); });
      session.on('window-change', (_ok, _reject, info) => {
        resize.push(info);
        terminal?.stdin.write(ptySize(info));
      });
      session.on('shell', ok => {
        const stream = ok();
        terminal = spawn(python, [ptyFixture, initialSize.rows, initialSize.cols, initialSize.width ?? 0, initialSize.height ?? 0,
          '/usr/bin/tmux', '-L', socket, '-v', '-f', '/dev/null', 'new-session', '-A', '-s', 'verify', shell].map(String),
        { cwd: folder, env: { ...env, TERM: initialSize.term }, windowsHide: true });
        terminal.stdout.on('data', data => {
          output += data.toString('utf8');
          if (!stream.destroyed) stream.write(data);
        });
        terminal.on('error', error => { ptyErrors.push(error.message); stream.end(); });
        terminal.stdin.on('error', error => ptyErrors.push(error.message));
        terminal.stderr.on('data', data => ptyErrors.push(data.toString('utf8')));
        terminal.on('close', (code, signal) => { exits.push({ code, signal }); stream.end(); });
        stream.on('data', bytes => {
          input.push(Buffer.from(bytes));
          terminal.stdin.write(ptyPacket(1, bytes));
        });
        stream.on('close', () => terminal.stdin.end());
      });
    }));
  });
  const sshPort = await listen(ssh);
  const launcher = spawn(join(folder, 'TermDock', 'TermDock.exe'), [], {
    stdio: 'ignore',
    env: {
      ...process.env,
      TERMDOCK_DATA_DIR: join(folder, 'profile'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
    },
  });
  const setWindowState = async state => {
    const command = [
      `Add-Type -Name TermDockFixtureWindow -Namespace Test -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);'`,
      `$handle = (Get-Process -Id ${launcher.pid} -ErrorAction Stop).MainWindowHandle`,
      `if (!$handle -or ![Test.TermDockFixtureWindow]::ShowWindowAsync($handle, ${state})) { throw 'Could not resize the TermDock fixture window' }`,
    ].join('\n');
    await exec('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
  };
  try {
    const endpoint = 'http://127.0.0.1:' + debugPort;
    await until(async () => {
      if (launcher.exitCode !== null) throw new Error('TermDock exited with ' + launcher.exitCode);
      return fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(400) }).then(response => response.ok, () => false);
    }, 'WebView2 startup', 25000);
    const browser = await chromium.connectOverCDP(endpoint);
    const page = await until(() => browser.contexts().flatMap(context => context.pages())
      .find(page => page.url() === 'https://termdock.local/index.html'), 'TermDock page');
    page.setDefaultTimeout(9000);
    const click = async name => {
      const button = page.getByRole('button', { name, exact: true });
      if (name !== 'AI 助手') return button.click();
      await page.locator('#top-more').click();
      return page.getByRole('menuitem', { name, exact: true }).click();
    };
    const selectedId = async () => (await page.locator('#tabs [aria-selected=true]').getAttribute('id')).slice(4);
    await page.locator('[data-shell=cmd]').click();
    await page.waitForFunction(() => document.querySelector('#global-state').textContent === '已连接');
    const cmdId = await selectedId();
    await page.locator('#quick-ssh').click();
    for (const [name, value] of Object.entries({ host: '127.0.0.1', port: sshPort, username: 'tester', password: 'fixture-password' })) {
      await page.locator(`#connect-form [name=${name}]`).fill(String(value));
    }
    await click('连接');
    await click('信任并连接');
    await page.waitForFunction(() => document.querySelector('#global-state').textContent === '已连接');
    assert.equal(initialSize.term, 'xterm-256color');
    let sshId = await selectedId();
    const clientSize = () => tmuxQuery('list-clients').match(/\[(\d+x\d+) /)?.[1];
    const windowSize = () => tmuxQuery('list-windows', '-t', 'verify').match(/\[(\d+x\d+)\]/)?.[1];
    const dimensions = info => `${info.cols}x${info.rows}`;
    const uiSize = async () => {
      const [cols, rows] = (await page.locator('#global-size').textContent()).split(' × ').map(Number);
      return { cols, rows };
    };
    async function assertFit(label, changed = () => true, expectedWindow) {
      let last;
      const result = await until(async () => {
        const size = await uiSize();
        const info = resize.at(-1) ?? initialSize;
        const client = clientSize();
        const window = windowSize();
        last = { label, ...size, ssh: info, client, window };
        return changed(size) && dimensions(size) === client && dimensions(info) === client &&
          window === (expectedWindow ?? `${size.cols}x${size.rows - 1}`) && last;
      }, `${label} UI, SSH PTY, tmux client and tmux window`).catch(error => {
        console.error('Last size sample:', JSON.stringify(last));
        throw error;
      });
      const bounds = await page.locator('#surface-' + sshId + ' .terminal-mount').evaluate(mount => {
        const screen = mount.querySelector('.xterm-screen');
        return { height: mount.clientHeight, width: mount.clientWidth, screenHeight: screen.offsetHeight, screenWidth: screen.offsetWidth };
      });
      assert(bounds.height - bounds.screenHeight >= -1 && bounds.height - bounds.screenHeight <= bounds.screenHeight / result.rows + 2);
      assert(bounds.width - bounds.screenWidth >= -1 && bounds.width - bounds.screenWidth <= bounds.screenWidth / result.cols + 18);
      assert.equal(result.ssh.width, bounds.screenWidth);
      assert.equal(result.ssh.height, bounds.screenHeight);
      measurements.push(result);
      return result;
    }
    const before = await assertFit('initial PTY');
    assert.equal(dimensions(initialSize), before.client);
    const paneList = () => tmuxQuery('list-panes', '-t', 'verify:').split('\n');
    const paneId = line => line?.match(/ %\d+/)?.[0].trim();
    const activePane = () => paneId(paneList().find(line => line.includes('(active)')));
    const firstPane = await until(activePane, 'first pane');
    await page.locator('.surface:visible .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+b');
    await page.keyboard.press('%');
    const panes = await until(() => {
      const values = paneList().map(paneId).filter(Boolean);
      return values.length === 2 ? values : null;
    }, 'Ctrl+B % made two panes');
    assert.notEqual(activePane(), firstPane);
    console.log('tmux panes', panes);
    await page.keyboard.press('Control+b');
    await page.keyboard.press('o');
    await until(() => activePane() === firstPane, 'Ctrl+B o selected the first pane');
    console.log('tmux selected the other pane', firstPane);
    await page.keyboard.type("printf 'TERMDOCK_%s\\n' 'TMUX_REAL'");
    await page.keyboard.press('Enter');
    await until(() => output.includes('TERMDOCK_TMUX_REAL'), 'command reached real tmux pane');
    await page.keyboard.press('Control+Shift+f');
    await page.locator('.surface:visible .search-value').fill('TERMDOCK_TMUX_REAL');
    await page.waitForFunction(() => document.querySelector('.surface:not([hidden]) .search-result').textContent === '1 / 1');
    await click('关闭搜索');
    await assertFit('search closed', size => dimensions(size) === before.client);
    await setWindowState(3);
    const maximized = await assertFit('maximized', size => size.cols > before.cols && size.rows > before.rows);
    await setWindowState(9);
    await assertFit('restored', size => size.cols < maximized.cols && size.rows < maximized.rows);
    await click('收起会话栏');
    const sidebar = await assertFit('session tree collapsed', size => size.cols > before.cols);
    const drag = async (selector, dx, dy) => {
      const box = await page.locator(selector).boundingBox();
      assert(box);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 5 });
      await page.mouse.up();
    };
    await click('AI 助手');
    await page.locator('#ai-popout').click();
    const docked = await assertFit('AI dock opened', size => size.cols < sidebar.cols);
    await drag('#ai-dock-divider', -100, 0);
    const expanded = await assertFit('AI dock widened', size => size.cols < docked.cols);
    await drag('#ai-dock-divider', 150, 0);
    await assertFit('AI dock narrowed', size => size.cols > expanded.cols);
    await click('收起 AI 栏');
    await assertFit('AI dock closed', size => dimensions(size) === sidebar.client);

    async function split(selector) {
      await page.locator(selector).click();
      await page.locator('#split-first').selectOption(sshId);
      await page.locator('#split-second').selectOption(cmdId);
      await click('应用分屏');
      assert.equal(await selectedId(), sshId);
    }
    await split('#split-side');
    const side = await assertFit('left and right split', size => size.cols < sidebar.cols);
    await drag('.pane-divider', 105, 0);
    await assertFit('left pane widened', size => size.cols > side.cols && size.cols < sidebar.cols);
    await click('取消分屏');
    await split('#split-stack');
    const stack = await assertFit('top and bottom split', size => size.rows < sidebar.rows);
    await drag('.pane-divider', 0, 60);
    await assertFit('top pane enlarged', size => size.rows > stack.rows && size.rows < sidebar.rows);
    await click('取消分屏');
    assert.equal(await selectedId(), sshId);
    const after = await assertFit('both splits cancelled', size => dimensions(size) === sidebar.client);

    tmuxQuery('resize-window', '-t', 'verify:0', '-x', '40', '-y', '10');
    await assertFit('server manual window size', size => dimensions(size) === after.client, '40x10');
    tmuxQuery('set-option', '-w', '-t', 'verify:0', 'window-size', 'latest');
    await assertFit('server automatic window size restored', size => dimensions(size) === after.client);
    await page.locator('#surface-' + sshId + ' .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+b');
    await page.keyboard.press('d');
    await until(() => !clientSize() && paneList().map(paneId).filter(Boolean).length === 2, 'detached tmux session keeps the panes');
    await page.waitForFunction(() => document.querySelector('#global-state').textContent === '已断开');
    await page.locator('#session-connection[aria-label="连接"]').click();
    await page.locator('#connect-form [name=password]').fill('fixture-password');
    await page.locator('#connect-now').click();
    await page.waitForFunction(() => document.querySelector('#global-state').textContent === '已连接');
    sshId = await selectedId();
    await assertFit('reattached to tmux', size => dimensions(size) === after.client);
    assert.equal(dimensions(initialSize), after.client);
    assert.deepEqual(paneList().map(paneId).filter(Boolean), panes);
    const report = { version, fixture: 'MSYS2 tmux on a POSIX PTY over loopback SSH', panes, measurements, markerRendered: true, detachAttach: true };
    writeFileSync(join(folder, 'measurements.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, evidence: folder }));
  } catch (error) {
    console.error('PTY events:', JSON.stringify({ initialSize, resize, exits, ptyErrors }));
    const server = tmuxCommand('list-sessions');
    console.error('tmux server:', server.status, server.stdout.trim(), server.stderr.trim(), folder);
    console.error('SSH input:', JSON.stringify(Buffer.concat(input).toString()));
    console.error('PTY tail:', JSON.stringify(output.slice(-2000)));
    throw error;
  } finally {
    tmuxQuery('kill-server');
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
