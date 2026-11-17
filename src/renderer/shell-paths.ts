export function quoteDroppedPaths(shell: string, paths: string[]) {
  if (!paths.length || paths.some(path => !/^(?:[a-z]:\\|\\\\[^\\]+\\)/i.test(path) || /[\x00-\x1f"]/.test(path))) {
    throw new Error('无法读取拖入文件的 Windows 绝对路径');
  }
  if (shell === 'cmd') {
    if (paths.some(path => /[%!]/.test(path))) {
      throw new Error('CMD 可能展开路径里的 % 或 !；请使用 PowerShell 拖入这些文件');
    }
    return paths.map(path => '"' + path + '"').join(' ');
  }
  if (shell === 'powershell' || shell === 'pwsh') {
    return paths.map(path => "'" + path.replace(/['‘’]/g, ch => ch + ch) + "'").join(' ');
  }
  throw new Error('请将 Windows 文件拖到 PowerShell 或 CMD');
}
