import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const { releaseVersion } = JSON.parse(await readFile('package.json', 'utf8'));
const filename = `TermDock-${releaseVersion}-source.zip`;
await mkdir('release', { recursive: true });
const archive = resolve('release', filename);
const files = ['.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md',
  'ACCEPTANCE.md', 'ACCEPTANCE-0.0.2.md', 'ACCEPTANCE-0.0.3.md', 'ACCEPTANCE-0.0.4.md', 'scripts', 'src', 'tests', 'docs', 'vendor'];
const result = spawnSync('tar.exe', ['-a', '-cf', archive, ...files], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('源码 ZIP 创建失败');
const bytes = await readFile(archive);
await writeFile(archive + '.sha256', createHash('sha256').update(bytes).digest('hex') + '  ' + filename + '\n');
console.log(`${archive} (${bytes.length} bytes)`);
