import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { buildLocalPty } from './windows-pty.mjs';
import { buildWindowsIcon } from './windows-icon.mjs';

await mkdir('dist', { recursive: true });
buildLocalPty('dist/termdock-pty.exe');
await Promise.all([
  buildWindowsIcon('dist/TermDock.ico'),
  build({
    entryPoints: { main: 'src/main/index.ts', preload: 'src/preload.ts' },
    outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true,
    platform: 'node', target: 'node22',
    external: ['electron', 'serialport', 'ssh2'],
  }),
  build({
    entryPoints: { renderer: 'src/renderer/index.ts' }, outdir: 'dist',
    bundle: true, platform: 'browser', target: 'chrome130',
    loader: { '.woff2': 'file' }, assetNames: 'fonts/[name]-[hash]',
  }),
  copyFile('src/renderer/index.html', 'dist/index.html'),
]);
