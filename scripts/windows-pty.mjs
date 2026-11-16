import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export function buildLocalPty(output) {
  if (process.platform !== 'win32') return;
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const result = spawnSync(compiler, [
    '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/utf8output', '/codepage:65001',
    '/out:' + resolve(output), resolve('src/windows/LocalPty.cs'),
  ], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ConPTY helper compilation failed with status ${result.status}`);
}
