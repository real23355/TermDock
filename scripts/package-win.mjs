import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { build } from 'esbuild';
import { buildLocalPty } from './windows-pty.mjs';
import { buildWindowsIcon } from './windows-icon.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 和 x64 Node.js 上打包');
const require = createRequire(import.meta.url);
const release = resolve('release');
const tools = resolve('.tools');
const filename = `TermDock-${require('../package.json').releaseVersion}-win-x64.zip`;
const maximumBytes = 20_000_000;
const nodeVersion = '22.23.4';
const sdkVersion = '1.0.4314.35';
const nodeHash = 'aa39a7741f62832ea50daba0113c8f8b12ccde226abca931326832d5bc47d31f';

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(name, url, expected) {
  const file = join(tools, name);
  if (await digest(file).catch(() => '') === expected) return file;
  const partial = file + '.part';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`下载 ${name} 失败 (${response.status})`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if (await digest(partial) !== expected) throw new Error(`${name} 的 SHA-256 校验失败`);
    await rename(partial, file);
    return file;
  } finally { await rm(partial, { force: true }); }
}

function run(file, args, cwd) {
  const result = spawnSync(file, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed with status ${result.status}`);
}

await Promise.all([mkdir(tools, { recursive: true }), mkdir(release, { recursive: true })]);
const [nodeArchive, sdkArchive, zipArchive, nodeLicense] = await Promise.all([
  download('node22-x86.tgz', `https://registry.npmjs.org/node-win-x86/-/node-win-x86-${nodeVersion}.tgz`,
    'a8784e45a06885358752ddb237ded388691be3d8ee4442f2136d26cdd87d5488'),
  download('webview2.nupkg', `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${sdkVersion}/microsoft.web.webview2.${sdkVersion}.nupkg`,
    '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'),
  download('7zip-bin.tgz', 'https://registry.npmjs.org/7zip-bin/-/7zip-bin-5.2.0.tgz',
    '04f9738ee00be8be53f5d06254a9e6e4b5117b17f8b74058477d870e62764a7d'),
  download('node-22-license.txt', `https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`,
    'c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4'),
]);

const stage = await mkdtemp(join(release, '.build-'));
const portable = join(stage, 'TermDock');
const archive = join(stage, filename);
const destination = join(release, filename);
const bindings = dirname(dirname(require.resolve('@serialport/bindings-cpp')));

try {
  const sdk = join(stage, 'sdk');
  const bin = join(stage, 'bin');
  const ui = join(portable, 'ui');
  const backend = join(portable, 'backend');
  await mkdir(portable);
  await Promise.all([sdk, bin, ui, backend].map(path => mkdir(path)));
  run('tar.exe', ['-xf', sdkArchive, '-C', sdk, 'LICENSE.txt', 'NOTICE.txt', 'lib/net462', 'runtimes/win-x64/native/WebView2Loader.dll']);
  run('tar.exe', ['-xf', nodeArchive, '-C', bin, 'package/bin/node.exe']);
  run('tar.exe', ['-xf', zipArchive, '-C', bin, 'package/win/x64/7za.exe']);
  const nodeDirectory = join(bin, 'package', 'bin');
  if (await digest(join(nodeDirectory, 'node.exe')) !== nodeHash) throw new Error('Node.js 可执行文件校验失败');

  const core = join(sdk, 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll');
  const forms = join(sdk, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll');
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const icon = join(stage, 'TermDock.ico');
  await buildWindowsIcon(icon);
  run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output', '/codepage:65001',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll',
    '/win32icon:' + icon, '/r:' + core, '/r:' + forms, '/out:' + join(portable, 'TermDock.exe'),
    resolve('src/windows/Launcher.cs'), resolve('src/windows/StartMenuShortcut.cs')]);
  buildLocalPty(join(backend, 'termdock-pty.exe'));

  const nativeBinding = join(bindings, 'prebuilds', 'win32-ia32', '@serialport+bindings-cpp.node');
  const worker = await build({
    entryPoints: ['src/main/worker-entry.ts'], outfile: join(backend, 'worker.cjs'),
    bundle: true, platform: 'node', target: 'node22', minify: true, metafile: true,
    external: ['cpu-features', './crypto/build/Release/sshcrypto.node', './serialport.node'],
    plugins: [{
      name: 'serialport-windows-binding',
      setup(build) {
        // The only native module in this build is the pinned Windows ia32 Node-API binding.
        build.onResolve({ filter: /^\.\/serialport-bindings$/ }, args => {
          if (dirname(args.importer) === join(bindings, 'dist')) {
            return { path: 'serialport.node', namespace: 'termdock-binding' };
          }
        });
        build.onLoad({ filter: /.*/, namespace: 'termdock-binding' }, () => ({
          contents: "exports.binding = require('./serialport.node');", resolveDir: backend,
        }));
      },
    }],
  });
  const renderer = await build({
    entryPoints: { renderer: 'src/renderer/index.ts' }, outdir: ui, bundle: true,
    platform: 'browser', target: 'chrome130', minify: true, metafile: true,
    loader: { '.woff2': 'file' }, assetNames: 'fonts/[name]-[hash]',
  });
  await Promise.all([
    cp('src/renderer/index.html', join(ui, 'index.html')),
    cp(nativeBinding, join(backend, 'serialport.node')),
    cp(core, join(portable, 'Microsoft.Web.WebView2.Core.dll')),
    cp(forms, join(portable, 'Microsoft.Web.WebView2.WinForms.dll')),
    cp(join(sdk, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll'), join(portable, 'WebView2Loader.dll')),
    cp('README.md', join(portable, 'README.md')),
    writeFile(join(portable, 'Create-Start-Menu-Shortcut.cmd'), '@echo off\r\nstart "" "%~dp0TermDock.exe" --register-start-menu\r\n'),
    writeFile(join(portable, 'runtime.sha256'), nodeHash + '\n'),
  ]);
  const bundled = new Set(Object.keys({ ...worker.metafile.inputs, ...renderer.metafile.inputs }).flatMap(file => {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file);
    return match ? [match[1]] : [];
  }));
  const notices = [];
  for (const name of [...bundled].sort()) {
    for (const license of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING']) {
      const contents = await readFile(join('node_modules', name, license), 'utf8').catch(() => '');
      if (contents) { notices.push(`\n${name}\n${contents}`); break; }
    }
  }
  await writeFile(join(portable, 'THIRD-PARTY-NOTICES.txt'), [
    'Node.js', await readFile(nodeLicense, 'utf8'), 'Microsoft WebView2 SDK',
    await readFile(join(sdk, 'LICENSE.txt'), 'utf8'), await readFile(join(sdk, 'NOTICE.txt'), 'utf8'),
    'IBM Plex Mono', await readFile('src/renderer/fonts/OFL.txt', 'utf8'), ...notices,
  ].join('\n'));
  run(join(bin, 'package', 'win', 'x64', '7za.exe'), [
    'a', '-t7z', '-mx=9', '-m0=BCJ2', '-m1=LZMA2:d=96m', '-m2=LZMA2:d=8m', '-m3=LZMA2:d=8m',
    '-mb0:1', '-mb0s1:2', '-mb0s2:3', '-mmt=2', join(portable, 'runtime.7z'), 'node.exe',
  ], nodeDirectory);
  run('tar.exe', ['-a', '-cf', archive, 'TermDock'], stage);
  const { size } = await stat(archive);
  if (size > maximumBytes) throw new Error(`便携包 ${size} 字节，超过 ${maximumBytes} 字节`);
  const hash = await digest(archive);
  await rename(archive, destination);
  await writeFile(destination + '.sha256', `${hash}  ${filename}\n`);
  console.log(`${destination} (${size} bytes)`);
} finally {
  // mkdtemp created this exact directory directly under the resolved release directory.
  if (stage.startsWith(release + sep) && dirname(stage) === release) await rm(stage, { recursive: true, force: true });
}
