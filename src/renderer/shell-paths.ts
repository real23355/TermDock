export function droppedPathsText(paths: string[]) {
  if (!paths.length || paths.some(path => !/^["']?(?:[a-z]:\\|\\\\[^\\]+\\)/i.test(path) || /[\x00-\x1f\x7f]/.test(path))) {
    throw new Error('无法读取拖入文件的 Windows 绝对路径');
  }
  return paths.join(' ');
}
