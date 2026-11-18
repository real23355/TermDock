const paths = {
  side: 'M3 3h18v18H3z M12 3v18', stack: 'M3 3h18v18H3z M3 12h18',
  search: 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  logs: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7',
  record: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0 M9 9h6v6H9z',
  disconnect: 'M7 3v5 M17 3v5 M5 8h14v3a7 7 0 0 1-14 0z M12 18v4',
  sftp: 'M3 6h7l2 3h9v11H3z M14 11v6 M11 14l3 3 3-3',
  forward: 'M3 8h17 M16 4l4 4-4 4 M21 16H4 M8 12l-4 4 4 4',
  reconnect: 'M20 10a8 8 0 1 0 0 6 M20 3v7h-7',
  timer: 'M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0 M12 8v5l3 2 M9 2h6',
  command: 'M4 5l6 7-6 7 M12 19h8',
  ai: 'M4 4h16v13h-9l-5 4v-4H4z M8 9h8 M8 12h5',
} as const;
export type IconName = keyof typeof paths;
export function icon(name: IconName) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('tool-icon');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name]);
  svg.append(path);
  return svg;
}
