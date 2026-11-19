const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdir, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { basename, join, resolve } = require('node:path');
const { promisify } = require('node:util');
const { build } = require('esbuild');

const exec = promisify(execFile);
async function main() {
  await mkdir('test-output', { recursive: true });
  const root = await mkdtemp(resolve('test-output/adb-'));
  const source = resolve('vendor/adb');
  const output = join(root, 'test-adb.cjs');
  const input = "export { AdbTools, prependPath } from './src/main/adb'; export { Store } from './src/main/store';";
  await build({ stdin: { contents: input, resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, platform: 'node' });
  const { AdbTools, Store, prependPath } = require(output);
  const first = join(root, '工具 目录 A');
  const second = join(root, '工具 目录 B');
  const downloads = join(root, '保存 文件');
  const foreign = '%JAVA_HOME%\\bin;C:\\Existing ADB';
  let registry = { Raw: foreign, Kind: 'ExpandString' };
  const changes = [];
  const commands = [];
  const platform = {
    sourceDirectory: source,
    readUserPath: async () => ({ value: { ...registry }, effectivePath: `C:\\Windows\\System32;${registry.Raw}` }),
    writeUserPath: async (before, after) => {
      assert.deepEqual(before, registry);
      changes.push(after.Raw);
      registry = { ...after };
    },
    command: async (file, args, timeout, env) => {
      commands.push({ file, args, timeout, env });
      if (args[0] === 'version') return { stdout: 'Android Debug Bridge version 1.0.41\r\n', stderr: '' };
      if (args[0] === '-NoProfile') return { stdout: 'C:\\Existing ADB\\adb.exe\r\n', stderr: '' };
      if (args[0] === 'devices') return { stdout: 'List of devices attached\r\nTEST123 device usb:1 product:board\r\nTEST456 unauthorized usb:2\r\n', stderr: '' };
      await writeFile(join(args[4], basename(args[3])), 'fixture payload');
      return { stdout: '1 file pulled', stderr: '' };
    },
  };
  let tools = new AdbTools(new Store(root), root, platform);
  await tools.save({ directory: first, pullDirectory: downloads, systemPath: true });
  assert.equal(registry.Raw, `${foreign};${first}`);
  assert.equal(registry.Kind, 'ExpandString');
  for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
    const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
    assert.equal(await sha(join(first, name)), await sha(join(source, name)));
  }
  assert.equal(prependPath({ Path: foreign, OTHER: 'preserved' }, first).Path, `${first};${foreign}`);
  await tools.save({ directory: second, pullDirectory: downloads, systemPath: true });
  assert.equal(registry.Raw, `${foreign};${second}`);
  tools = new AdbTools(new Store(root), root, platform);
  assert.deepEqual(await tools.settings(), { directory: second, pullDirectory: downloads, systemPath: true });
  assert.equal((await tools.detect()).systemExecutable, 'C:\\Existing ADB\\adb.exe');
  assert(commands.at(-1).env.Path.endsWith(second));

  const collision = join(root, '已有工具');
  await mkdir(collision);
  await writeFile(join(collision, 'AdbWinApi.dll'), 'different file owned by user');
  await assert.rejects(tools.save({ directory: collision, pullDirectory: downloads, systemPath: true }), /与内置版本不同/);
  assert.equal((await tools.settings()).directory, second);
  assert.equal(registry.Raw, `${foreign};${second}`);
  await assert.rejects(readFile(join(collision, 'adb.exe')), /ENOENT/);
  assert.equal(await readFile(join(collision, 'AdbWinApi.dll'), 'utf8'), 'different file owned by user');
  const devices = await tools.devices();
  assert.deepEqual(devices.map(device => [device.serial, device.state]), [['TEST123', 'device'], ['TEST456', 'unauthorized']]);
  await assert.rejects(tools.pull({ serial: 'TEST456', remote: '/data/local/tmp/fixture.txt', directory: downloads }), /尚未授权/);
  assert.equal(await tools.pull({ serial: 'TEST123', remote: '/data/local/tmp/含 空格.txt', directory: downloads }), '1 file pulled');
  assert.deepEqual(commands.at(-1).args, ['-s', 'TEST123', 'pull', '/data/local/tmp/含 空格.txt', downloads]);
  assert.equal(await readFile(join(downloads, '含 空格.txt'), 'utf8'), 'fixture payload');
  await tools.save({ directory: second, pullDirectory: downloads, systemPath: false });
  assert.equal(registry.Raw, foreign);
  assert.equal(changes.length, 3);

  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const real = join(first, 'adb.exe');
  const privateProfile = join(root, 'adb-profile');
  await mkdir(privateProfile);
  const env = { ...process.env, ANDROID_SDK_HOME: privateProfile, ANDROID_USER_HOME: privateProfile, ADB_SERVER_SOCKET: '' };
  const runtimeOptions = { windowsHide: true, env, timeout: 12000 };
  assert.match((await exec(real, ['version'], runtimeOptions)).stdout, /1\.0\.41/);
  try {
    const detected = await exec(real, ['-P', String(port), 'devices', '-l'], runtimeOptions);
    assert.match(detected.stdout, /List of devices attached/);
    console.log(detected.stdout.trim());
  } finally { await exec(real, ['-P', String(port), 'kill-server'], runtimeOptions).catch(() => {}); }
  console.log('ADB actual Windows binaries, isolated device list, install/rollback, Unicode directories, persisted config, PATH ownership and simulated pull OK. Evidence: ' + root);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
