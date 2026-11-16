import type { IMarker, Terminal } from '@xterm/xterm';

export function highlightKeywords(term: Terminal, text: string) {
  const keywords = [...new Set(text.split(/[,，]/).map(value => value.trim()).filter(Boolean))];
  if (!keywords.length) return;
  const rows = new Map<IMarker, string>();

  term.onWriteParsed(() => {
    const buffer = term.buffer.active;
    if (buffer.type !== 'normal') return;
    const cursor = buffer.baseY + buffer.cursorY;
    const visible = new Map<number, IMarker>();
    for (const marker of rows.keys()) {
      if (marker.line >= buffer.baseY) visible.set(marker.line, marker);
      else rows.delete(marker);
    }
    for (let row = buffer.baseY; row < buffer.baseY + term.rows; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const previous = visible.get(row);
      const contents = line.translateToString(true);
      if (previous && rows.get(previous) === contents) continue;
      previous?.dispose();
      if (!keywords.some(keyword => contents.includes(keyword))) continue;

      // xterm reports cell columns, whereas substring indices count UTF-16 units.
      const columns: number[] = [];
      const ends: number[] = [];
      for (let col = 0; col < Math.min(line.length, term.cols); col++) {
        const cell = line.getCell(col);
        if (!cell?.getWidth()) continue;
        const length = cell.getChars().length || 1;
        for (let unit = 0; unit < length; unit++) {
          columns.push(col);
          ends.push(col + cell.getWidth());
        }
      }
      const marker = term.registerMarker(row - cursor);
      if (!marker) continue;
      rows.set(marker, contents);
      marker.onDispose(() => { rows.delete(marker); });
      let remaining = 64;
      for (const keyword of keywords) {
        for (let at = contents.indexOf(keyword); at >= 0 && remaining > 0; at = contents.indexOf(keyword, at + keyword.length)) {
          const x = columns[at];
          const end = ends[at + keyword.length - 1];
          if (x === undefined || end === undefined) continue;
          term.registerDecoration({ marker, x, width: end - x, backgroundColor: '#563f28', foregroundColor: '#ffdc9e' });
          remaining--;
        }
      }
    }
  });
}
