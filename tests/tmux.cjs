const assert = require('node:assert/strict');
const { execFile, execFileSync, spawn, spawnSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync } = require('node:fs');
const { createServer } = require('node:net');
const { join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const { Server } = require('ssh2');
const { releaseVersion } = require('../package.json');
if (!process.env.TERMDOCK_TMUX_MSYS || !process.env.TERMDOCK_TMUX_NODE_PTY) {
  throw new Error('Set TERMDOCK_TMUX_MSYS to the MSYS2 root and TERMDOCK_TMUX_NODE_PTY to the node-pty package directory');
}
const pty = require(resolve(process.env.TERMDOCK_TMUX_NODE_PTY));

const exec = promisify(execFile);
const msys = resolve(process.env.TERMDOCK_TMUX_MSYS);
const usrBin = join(msys, 'usr', 'bin');
const tmux = join(usrBin, 'tmux.exe');
const shell = existsSync(join(usrBin, 'bash.exe')) ? '/usr/bin/bash --noprofile --norc' : '/usr/bin/sh -i';
const socket = 'termdock-ssh-test-' + process.pid;
const env = {
  ...process.env,
  TERM: 'xterm-256color',
  TERMINFO: '/usr/lib/terminfo',
  MSYSTEM: 'MSYS',
  MSYS: 'enable_pcon',
  HOME: '/tmp',
  SHELL: existsSync(join(usrBin, 'bash.exe')) ? '/usr/bin/bash' : '/usr/bin/sh',
  PATH: usrBin + ';' + process.env.SystemRoot + '\\System32',
};
delete env.TMUX;
delete env.TMUX_PANE;
mkdirSync(join(msys, 'tmp'), { recursive: true });

function tmuxQuery(...args) {
  const result = spawnSync(tmux, ['-L', socket, ...args], { env, cwd: msys, windowsHide: true, encoding: 'utf8', timeout: 3000 });
  return result.status === 0 ? result.stdout.trim() : '';
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
        terminal?.resize(info.cols, info.rows);
      });
      session.on('shell', ok => {
        const stream = ok();
        terminal = pty.spawn(tmux, ['-L', socket, '-f', '/dev/null', 'new-session', '-A', '-s', 'verify', shell], {
          name: initialSize.term, cols: initialSize.cols, rows: initialSize.rows, cwd: msys, env,
        });
        terminal.onData(data => {
          output += data;
          if (!stream.destroyed) stream.write(data);
        });
        terminal.onExit(() => stream.end());
        stream.on('data', bytes => {
          input.push(Buffer.from(bytes));
          terminal.write(bytes.toString('utf8'));
        });
        stream.on('close', () => {
          try { terminal.kill(); } catch {}
        });
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
    const click = name => page.getByRole('button', { name, exact: true }).click();
    await page.locator('#quick-ssh').click();
    for (const [name, value] of Object.entries({ host: '127.0.0.1', port: sshPort, username: 'tester', password: 'fixture-password' })) {
      await page.locator(`#connect-form [name=${name}]`).fill(String(value));
    }
    await click('连接');
    await click('信任并连接');
    await page.waitForFunction(() => document.querySelector('#global-state').textContent === '已连接');
    assert.equal(initialSize.term, 'xterm-256color');
    const clientSize = () => tmuxQuery('list-clients').match(/\[(\d+x\d+) /)?.[1];
    const before = await until(clientSize, 'tmux client');
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
    await click('收起会话栏');
    const after = await until(() => {
      const value = clientSize();
      return value && value !== before ? value : '';
    }, 'terminal resize reached real tmux');
    assert(resize.some(info => `${info.cols}x${info.rows}` === after));
    assert(Number(after.split('x')[0]) > Number(before.split('x')[0]));
    await page.keyboard.press('Control+b');
    await page.keyboard.press('d');
    await until(() => !clientSize() && paneList().map(paneId).filter(Boolean).length === 2, 'detached tmux session keeps the panes');
    await page.waitForFunction(() => document.querySelector('#global-state').textContent === '已断开');
    await click('重连');
    await page.locator('#connect-form [name=password]').fill('fixture-password');
    await click('连接');
    await page.waitForFunction(() => document.querySelector('#global-state').textContent === '已连接');
    await until(clientSize, 'reattached tmux client');
    assert.deepEqual(paneList().map(paneId).filter(Boolean), panes);
    console.log(JSON.stringify({ version, fixture: 'MSYS2 tmux via ConPTY over loopback SSH', panes, before, after, markerRendered: true, detachAttach: true }));
  } catch (error) {
    console.error('SSH input:', JSON.stringify(Buffer.concat(input).toString()));
    console.error('ConPTY tail:', JSON.stringify(output.slice(-2000)));
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
