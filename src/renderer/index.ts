import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { createCommandBar } from './command-bar';
import { connectWebView } from './webview';
import { highlightKeywords } from './keyword-highlight';
import { createSftpBrowser } from './sftp-browser';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import {
  authSchema, defaults, lineEndings, localDefaults, localProfile, preferencesSchema, profile as profileSchema, serialDefaults, timerSchema,
  type Auth, type ConnectionState, type DesktopApi, type HostKey, type Preferences, type Profile, type RecentConnection,
  type SavedProfile, type SessionEvent, type SessionProfile, type SshProfile, type TimerState,
} from '../shared';

declare global {
  interface Window {
    termDock: DesktopApi & { copy(value: string): Promise<void>; paste(): Promise<string> };
  }
}

const api = window.termDock ?? connectWebView();
function find<T extends HTMLElement = HTMLElement>(selector: string, scope: ParentNode = document) {
  return scope.querySelector<T>(selector)!;
}
const connectDialog = find<HTMLDialogElement>('#connect-dialog');
const connectForm = find<HTMLFormElement>('#connect-form');
const settingsDialog = find<HTMLDialogElement>('#settings-dialog');
const keyDialog = find<HTMLDialogElement>('#key-dialog');
const tabList = find('#tabs');
const surfaces = find('#surfaces');
const notice = find('#notice');
const openSftp = createSftpBrowser(api, find<HTMLDialogElement>('#sftp-dialog'));
const forwardDialog = find<HTMLDialogElement>('#forward-dialog');
const sshDefaults: SshProfile = { kind: 'ssh', name: 'SSH', host: '', port: 22, username: 'root' };
const sendLabels = {
  idle: '未开始', countdown: '倒计时', waiting: '等待', sending: '正在写入', stopped: '已停止', finished: '已完成', error: '异常停止',
};
const shellLabels = {
  unknown: '未识别', ready: '已就绪', login: '登录提示', bootloader: '引导程序', manual: '手动交互', recovering: '等待恢复',
};
const connectionLabels = { connecting: '连接中', connected: '已连接', disconnected: '已断开' };

type Tab = {
  id: string; profile: SessionProfile; term: Terminal; fit: FitAddon; search: SearchAddon; gl?: WebglAddon;
  gpuFailed?: boolean; surface: HTMLElement; tab: HTMLButtonElement; wrapper: HTMLElement; state: ConnectionState; closing?: boolean;
  detail: string; timer?: TimerState; warning?: string; logDir?: string;
};

const tabs = new Map<string, Tab>();
const keys: HostKey[] = [];
let pendingKey: HostKey | undefined;
let active: Tab | undefined;
let previouslyFocused: Tab | undefined;
let split: [Tab, Tab] | undefined;
let draggedTab: Tab | undefined;
let profiles: SavedProfile[] = [];
let preferences: Preferences = defaults;
let editing: SavedProfile | undefined;
let reconnecting: Tab | undefined;
let forwardTab: Tab | undefined;
let connectMode: 'quick' | 'save' | 'edit' | 'auth' = 'quick';

function message(error: unknown) {
  if (error && typeof error === 'object' && 'issues' in error) {
    return (error.issues as { message: string }[])[0]?.message ?? '参数无效';
  }
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
}
function showNotice(text: string) {
  find('span', notice).textContent = text;
  notice.hidden = false;
}
function safe(promise: Promise<unknown>) { void promise.catch(error => showNotice(message(error))); }
find('button', notice).onclick = () => { notice.hidden = true; };

function control(form: HTMLFormElement, name: string) {
  return form.elements.namedItem(name) as HTMLInputElement;
}
const field = (name: string) => control(connectForm, name);
function assign(form: HTMLFormElement, values: object) {
  for (const [name, value] of Object.entries(values)) {
    const input = control(form, name);
    if (!input) continue;
    if (typeof value === 'boolean') input.checked = value;
    else input.value = String(value);
  }
}
function cleanAuth() {
  assign(connectForm, { method: 'password', password: '', passphrase: '', privateKey: '' });
}

function endpoint(config: SessionProfile) {
  if (config.kind === 'local') return '本机 ' + config.name;
  return config.kind === 'ssh' ? `${config.username}@${config.host}:${config.port}` : `${config.path}  /  ${config.baudRate}`;
}
function profileButton(config: Profile) {
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'profile-open';
  open.title = endpoint(config);
  const badge = document.createElement('span');
  badge.className = 'profile-badge';
  badge.textContent = config.kind === 'ssh' ? 'SSH' : 'COM';
  const text = document.createElement('span');
  text.className = 'profile-text';
  const name = document.createElement('b');
  name.textContent = (config.favorite ? '★ ' : '') + config.name;
  const hint = document.createElement('small');
  hint.textContent = endpoint(config);
  text.append(name, hint);
  open.append(badge, text);
  open.onclick = () => {
    if (config.kind === 'ssh') openConnect('ssh', 'auth', config);
    else safe(openTab(config));
  };
  return open;
}

function emptyProfiles(list: HTMLElement, text: string) {
  const placeholder = document.createElement('p');
  placeholder.className = 'profiles-empty';
  placeholder.textContent = text;
  list.append(placeholder);
}

function renderProfiles() {
  const list = find('#profiles');
  list.replaceChildren();
  find('#profile-count').textContent = String(profiles.length).padStart(2, '0');
  if (!profiles.length) emptyProfiles(list, '保存常用板卡和服务器，下次一键打开。');
  const query = find<HTMLInputElement>('#session-search').value.trim().toLocaleLowerCase();
  const groups = new Map<string, HTMLElement>();
  const sorted = [...profiles].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite));
  for (const saved of sorted) {
    if (![saved.name, saved.group, endpoint(saved)].some(value => value?.toLocaleLowerCase().includes(query))) continue;
    const group = saved.group ?? '';
    let target = groups.get(group);
    if (!target) {
      if (group) {
        const section = document.createElement('details');
        const heading = document.createElement('summary');
        heading.textContent = group;
        section.open = true;
        section.append(heading);
        list.append(section);
        target = section;
      } else {
        target = document.createElement('div');
        list.append(target);
      }
      groups.set(group, target);
    }
    const row = document.createElement('div');
    row.className = 'profile';
    const edit = document.createElement('button');
    edit.className = 'profile-edit';
    edit.textContent = '⋯';
    edit.title = edit.ariaLabel = `编辑 ${saved.name}`;
    edit.onclick = () => openConnect(saved.kind, 'edit', saved);
    row.append(profileButton(saved), edit);
    target.append(row);
  }
  if (profiles.length && !groups.size) emptyProfiles(list, '没有匹配的会话');
}
find('#session-search').oninput = renderProfiles;

const connectionDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
function renderRecentConnections(connections: RecentConnection[]) {
  const list = find('#recent-connections');
  list.replaceChildren();
  if (!connections.length) emptyProfiles(list, '暂无连接记录');
  for (const { profile, connectedAt } of connections) {
    const row = document.createElement('div');
    row.className = 'profile';
    const open = profileButton(profile);
    open.title = `${endpoint(profile)} · 最近连接 ${connectionDate.format(new Date(connectedAt))}`;
    row.append(open);
    list.append(row);
  }
}

async function refreshPorts() {
  const button = find<HTMLButtonElement>('#refresh-ports');
  button.disabled = true;
  try {
    const ports = await api.ports();
    find('#ports').replaceChildren(...ports.map(port => {
      const option = document.createElement('option');
      option.value = port.path;
      option.label = port.friendlyName || port.manufacturer || port.path;
      return option;
    }));
    button.title = ports.length ? `已找到 ${ports.length} 个串口` : '未找到串口，可手动输入 COM 口';
  } finally { button.disabled = false; }
}

function setLogDirectory(path: string) {
  const input = field('logDirectory');
  input.value = path;
  input.title = path || input.placeholder;
  find<HTMLButtonElement>('#reset-log-directory').disabled = !path;
}

function updateForm() {
  const serial = field('kind').value === 'serial';
  const authNeeded = connectMode === 'quick' || connectMode === 'auth';
  const serialFields = find<HTMLFieldSetElement>('#serial-fields');
  const sshFields = find<HTMLFieldSetElement>('#ssh-fields');
  serialFields.hidden = serialFields.disabled = !serial;
  sshFields.hidden = sshFields.disabled = serial;
  find('#auth-fields').hidden = !authNeeded;
  field('path').required = field('baudRate').required = serial;
  field('host').required = field('port').required = field('username').required = !serial;
  const key = field('method').value === 'key';
  find('#key-fields').hidden = !key;
  find('#password-fields').hidden = field('method').value !== 'password';
}

function openConnect(kind: Profile['kind'], mode: typeof connectMode = 'quick', config?: Profile, previous?: Tab) {
  connectMode = mode;
  editing = config?.id ? config as SavedProfile : undefined;
  reconnecting = previous;
  connectForm.reset();
  assign(connectForm, { ...serialDefaults, ...sshDefaults, ...(config ?? (kind === 'ssh' ? sshDefaults : serialDefaults)), kind });
  setLogDirectory(config?.kind === 'serial' ? config.logDirectory ?? '' : '');
  cleanAuth();
  field('kind').disabled = mode === 'auth';
  for (const name of ['name', 'host', 'port', 'username']) field(name).readOnly = mode === 'auth';
  find('#connect-title').textContent = ({ quick: '快速连接', save: '新建会话', edit: '编辑会话', auth: '连接 SSH' })[mode];
  find<HTMLButtonElement>('#save-profile').hidden = mode === 'auth';
  find<HTMLButtonElement>('#connect-now').hidden = mode === 'save' || mode === 'edit';
  find<HTMLButtonElement>('#delete-profile').hidden = mode !== 'edit';
  find('#connect-error').hidden = true;
  updateForm();
  connectDialog.showModal();
  if (kind === 'serial') safe(refreshPorts());
  if (mode === 'auth') field('password').focus();
}

function parseProfile(): Profile {
  const text = (name: string) => field(name).value;
  const number = (name: string) => Number(text(name));
  const base = { id: editing?.id, name: text('name'), kind: text('kind'),
    group: text('group') || undefined, favorite: field('favorite').checked || undefined,
    keywords: text('keywords') || undefined };
  return profileSchema.parse(base.kind === 'serial' ? {
    ...base, path: text('path').trim().toUpperCase(), baudRate: number('baudRate'), dataBits: number('dataBits'),
    parity: text('parity'), stopBits: number('stopBits'), flow: text('flow'),
    logDirectory: text('logDirectory') || undefined, logFormat: text('logFormat'),
    inputEnding: text('inputEnding'), localEcho: field('localEcho').checked,
  } : { ...base, host: text('host'), port: number('port'), username: text('username') });
}

async function submitConnect(event: SubmitEvent) {
  event.preventDefault();
  const button = event.submitter as HTMLButtonElement | null;
  if (button) button.disabled = true;
  const errorBox = find('#connect-error');
  errorBox.hidden = true;
  try {
    const config = parseProfile();
    if (button?.value === 'save' || connectMode === 'save' || connectMode === 'edit') {
      const saved = await api.saveProfile(config);
      const index = profiles.findIndex(p => p.id === saved.id);
      if (index < 0) profiles.push(saved);
      else profiles[index] = saved;
      renderProfiles();
      connectDialog.close();
    } else {
      const auth = config.kind === 'ssh' ? authSchema.parse({
        method: field('method').value, password: field('password').value,
        privateKey: field('privateKey').value, passphrase: field('passphrase').value,
      }) : undefined;
      const previous = reconnecting;
      connectDialog.close();
      cleanAuth();
      if (previous) await closeTab(previous);
      await openTab(config, auth);
    }
  } catch (error) {
    if (connectDialog.open) {
      errorBox.textContent = message(error);
      errorBox.hidden = false;
    } else showNotice(message(error));
  } finally { if (button) button.disabled = false; }
}
connectForm.onsubmit = event => { void submitConnect(event); };
connectDialog.addEventListener('close', () => { cleanAuth(); nextKey(); });
field('kind').onchange = () => {
  field('name').value = field('kind').value === 'ssh' ? sshDefaults.name : serialDefaults.name;
  updateForm();
  if (field('kind').value === 'serial') safe(refreshPorts());
};
field('method').onchange = updateForm;
find('#refresh-ports').onclick = () => safe(refreshPorts());
find('#pick-log-directory').onclick = () => safe(api.pickLogDirectory().then(path => {
  if (path) setLogDirectory(path);
}));
find('#reset-log-directory').onclick = () => setLogDirectory('');
find('#pick-key').onclick = () => safe(api.pickKey().then(path => { if (path) field('privateKey').value = path; }));
find('#delete-profile').onclick = () => {
  const id = editing?.id;
  if (!id) return;
  safe(api.deleteProfile(id).then(() => {
    profiles = profiles.filter(p => p.id !== id);
    renderProfiles();
    connectDialog.close();
  }));
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-dismiss]')) {
  button.onclick = () => button.closest('dialog')?.close();
}

const terminalTheme = {
  background: '#0c1017', foreground: '#d4dfec', cursor: '#ffb075', cursorAccent: '#101319',
  selectionBackground: '#405473', black: '#232b3b', red: '#f17979', green: '#9ed399',
  yellow: '#ecc789', blue: '#8ab4f8', magenta: '#d9a6ec', cyan: '#8fdbd8', white: '#d7e1ef',
  brightBlack: '#7a879c', brightRed: '#ffa4a4', brightGreen: '#b4e6a4', brightYellow: '#ffe0a0',
  brightBlue: '#abcaff', brightMagenta: '#ecc5ff', brightCyan: '#b2efea', brightWhite: '#f5f7fa',
};
function terminalTypography(value: Preferences) {
  const mac = value.font === 'macOS';
  return {
    fontFamily: (mac ? '"SF Mono", Menlo, "IBM Plex Mono"' : `"${value.font}"`) + ', Consolas, "Microsoft YaHei UI", monospace',
    fontSize: value.fontSize,
    lineHeight: mac ? 1.14 : 1,
  };
}

let bundledFontReady: Promise<unknown> | undefined;
async function loadTerminalFont(font: Preferences['font']) {
  if (font !== 'macOS') return;
  // xterm measures its cells when it opens or changes font options.
  bundledFontReady ??= Promise.allSettled([
    document.fonts.load('400 15px "IBM Plex Mono"', 'W'),
    document.fonts.load('700 15px "IBM Plex Mono"', 'W'),
  ]);
  await bundledFontReady;
}

const observer = new ResizeObserver(() => {
  for (const tab of split ?? (active ? [active] : [])) fitTab(tab);
});

function fitTab(tab: Tab) {
  if (tab.surface.hidden) return;
  tab.fit.fit();
  updateFooter();
}

function enableGpu(tab: Tab) {
  if (!preferences.gpu || tab.gl || tab.gpuFailed || tab.surface.hidden) return;
  const addon = new WebglAddon();
  try {
    tab.term.loadAddon(addon);
    tab.gl = addon;
    addon.onContextLoss(() => {
      tab.gpuFailed = true;
      disableGpu(tab);
      updateFooter();
    });
  } catch {
    tab.gpuFailed = true;
    try { addon.dispose(); } catch { /* Renderer remains on the xterm default. */ }
  }
}
function disableGpu(tab: Tab) {
  tab.gl?.dispose();
  tab.gl = undefined;
}

function restoreTerminalFocus() {
  if (!document.querySelector('dialog[open]')) active?.term.focus();
}

function renderPanes() {
  const shown: readonly Tab[] = split ?? (active ? [active] : []);
  for (const tab of tabs.values()) {
    const index = shown.indexOf(tab);
    const mount = find('.terminal-mount', tab.surface);
    tab.tab.setAttribute('aria-selected', String(tab === active));
    tab.surface.hidden = index < 0;
    if (index < 0) {
      observer.unobserve(mount);
      disableGpu(tab);
    } else {
      tab.surface.style.order = String(index);
      observer.observe(mount);
    }
  }
  for (const tab of shown) { fitTab(tab); enableGpu(tab); }
  find('#empty').hidden = !!active;
  find('#tabs-empty').hidden = !!active;
  for (const [id, direction] of [['#split-side', 'side'], ['#split-stack', 'stack']]) {
    const button = find<HTMLButtonElement>(id);
    button.disabled = tabs.size < 2;
    button.setAttribute('aria-pressed', String(surfaces.dataset.split === direction));
  }
  updateFooter();
}

function focusTab(tab: Tab) {
  if (split && active && !split.includes(tab)) split[split[0] === active ? 0 : 1] = tab;
  if (active && active !== tab) previouslyFocused = active;
  active = tab;
  tab.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderPanes();
  restoreTerminalFocus();
}

function toggleSplit(direction: string) {
  if (!active) return;
  if (surfaces.dataset.split === direction) {
    split = undefined;
    delete surfaces.dataset.split;
  } else {
    const other = previouslyFocused && previouslyFocused !== active && tabs.has(previouslyFocused.id)
      ? previouslyFocused : orderedTabs().find(tab => tab !== active);
    if (!other) return;
    split ??= [active, other];
    surfaces.dataset.split = direction;
  }
  focusTab(active);
}

function orderedTabs() {
  return Array.from(tabList.children, wrapper => tabs.get((wrapper as HTMLElement).dataset.sessionId!)!);
}

function updateTabShortcuts() {
  orderedTabs().forEach((tab, index) => {
    const shortcut = index < 9 ? `Alt+${index + 1}` : '';
    if (shortcut) tab.tab.setAttribute('aria-keyshortcuts', shortcut);
    else tab.tab.removeAttribute('aria-keyshortcuts');
    tab.tab.title = [endpoint(tab.profile), shortcut, '拖拽交换位置'].filter(Boolean).join(' · ');
  });
}

window.addEventListener('keydown', event => {
  if (event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || document.querySelector('dialog[open]')) return;
  const digit = /^Digit([1-9])$/.exec(event.code);
  const tab = digit && orderedTabs()[Number(digit[1]) - 1];
  if (!tab) return;
  event.preventDefault();
  event.stopPropagation();
  focusTab(tab);
}, { capture: true });

function bindTabDrag(tab: Tab) {
  tab.tab.draggable = true;
  tab.tab.ondragstart = event => {
    if (!event.dataTransfer) return;
    draggedTab = tab;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-termdock-tab', tab.id);
  };
  tab.tab.ondragend = () => {
    draggedTab = undefined;
    tabList.querySelector('.drop-target')?.classList.remove('drop-target');
  };
  tab.wrapper.ondragover = event => {
    if (!draggedTab || draggedTab === tab) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    tab.wrapper.classList.add('drop-target');
  };
  tab.wrapper.ondragleave = event => {
    if (!(event.relatedTarget instanceof Node) || !tab.wrapper.contains(event.relatedTarget)) {
      tab.wrapper.classList.remove('drop-target');
    }
  };
  tab.wrapper.ondrop = event => {
    const source = draggedTab;
    if (!source || source === tab || !tabs.has(source.id)) return;
    event.preventDefault();
    draggedTab = undefined;
    const position = document.createComment('');
    source.wrapper.replaceWith(position);
    tab.wrapper.replaceWith(source.wrapper);
    position.replaceWith(tab.wrapper);
    tab.wrapper.classList.remove('drop-target');
    updateTabShortcuts();
    if (active) active.term.focus();
  };
}

function updateFooter() {
  commandBar.setConnected(active?.state === 'connected');
  find('#global-dot').dataset.state = active?.state ?? '';
  find('#global-state').textContent = active ? connectionLabels[active.state] : '无活动连接';
  find('#global-endpoint').textContent = active?.warning ?? active?.detail ?? '';
  find('#global-size').textContent = active ? `${active.term.cols} × ${active.term.rows}` : '';
  find('#global-renderer').textContent = active ? (active.gl ? 'WebGL' : 'DOM') : '';
}

function setTimer(tab: Tab) {
  const state = tab.timer;
  const inProgress = state && ['countdown', 'waiting', 'sending'].includes(state.send);
  find('.countdown', tab.surface).textContent = inProgress ? `${state.seconds}s` : '—';
  find('.rounds', tab.surface).textContent = String(state?.rounds ?? 0);
  find('.recovered-rounds', tab.surface).textContent = String(state?.recovered ?? 0);
  find('.boot-marker', tab.surface).textContent = state?.bootSeen ? '已看到' : '—';
  find('.send-state', tab.surface).textContent = sendLabels[state?.send ?? 'idle'];
  const shell = find('.shell-state', tab.surface);
  shell.textContent = tab.state === 'disconnected' ? '已断开' : shellLabels[state?.shell ?? 'unknown'];
  shell.dataset.ready = String(tab.state === 'connected' && state?.shell === 'ready');
  const detail = find('.timer-detail', tab.surface);
  detail.textContent = state?.detail || '';
  detail.hidden = !state?.detail;
  find<HTMLButtonElement>('.timer-start', tab.surface).disabled = !!inProgress || tab.state !== 'connected' || !!tab.warning?.startsWith('日志写入失败');
  find<HTMLButtonElement>('.timer-stop', tab.surface).disabled = !inProgress || tab.state !== 'connected';
  find<HTMLFieldSetElement>('.timer-inputs', tab.surface).disabled = !!inProgress;
}

function bindSurface(tab: Tab) {
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => find<T>(selector, tab.surface);
  const searchbar = get('.searchbar');
  const query = get<HTMLInputElement>('.search-value');
  const result = get('.search-result');
  function search(previous = false, incremental = false) {
    if (!query.value) { tab.search.clearDecorations(); result.textContent = ''; return; }
    const options = {
      incremental,
      decorations: { matchBackground: '#61482e', matchBorder: '#ad8859', matchOverviewRuler: '#ad8859',
        activeMatchBackground: '#ffb075', activeMatchBorder: '#f1bd90', activeMatchColorOverviewRuler: '#ffb075' },
    };
    const found = previous ? tab.search.findPrevious(query.value, options) : tab.search.findNext(query.value, options);
    if (!found) result.textContent = '无匹配';
  }
  function showSearch() { searchbar.hidden = false; query.focus(); query.select(); fitTab(tab); }
  function hideSearch() {
    searchbar.hidden = true;
    tab.search.clearDecorations();
    fitTab(tab);
    tab.term.focus();
  }
  get('.search-toggle').onclick = showSearch;
  get('.search-close').onclick = hideSearch;
  get('.search-next').onclick = () => search();
  get('.search-prev').onclick = () => search(true);
  query.oninput = () => search(false, true);
  query.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); search(event.shiftKey); }
    if (event.key === 'Escape') hideSearch();
  };
  tab.search.onDidChangeResults(({ resultIndex, resultCount }) => {
    result.textContent = resultCount ? `${resultIndex + 1} / ${resultCount}` : '无匹配';
  });
  tab.term.attachCustomKeyEventHandler(event => {
    if (event.isComposing) return true;
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return true;
    const key = event.key.toLowerCase();
    if (!['c', 'v', 'f'].includes(key)) return true;
    if (event.type === 'keydown') {
      event.preventDefault();
      if (key === 'c' && tab.term.hasSelection()) safe(api.copy(tab.term.getSelection()));
      if (key === 'v') safe(api.paste().then(value => {
        if (value && active === tab && !document.querySelector('dialog[open]')) tab.term.paste(value);
      }));
      if (key === 'f') showSearch();
    }
    return false;
  });
  tab.term.onData(data => {
    if (tab.state !== 'connected') return;
    if (tab.profile.kind === 'serial') {
      const { inputEnding = 'CR', localEcho } = tab.profile;
      if (localEcho && !data.includes('\x1b')) {
        tab.term.write(data.replace(/\r\n|\r|\n/g, '\r\n').replace(/\x7f/g, '\b \b'));
      }
      data = data.replace(/\r\n|\r|\n/g, lineEndings[inputEnding]);
    }
    api.write(tab.id, data);
  });
  tab.term.onBinary(data => { if (tab.state === 'connected') api.write(tab.id, data, true); });
  tab.term.onResize(size => api.resize(tab.id, size));
  get('.session-logs').onclick = () => safe(api.showLogs(tab.id));
  get('.open-sftp').onclick = () => openSftp(tab.id);
  get('.open-forward').onclick = () => {
    forwardTab = tab;
    find('#active-forwards').replaceChildren();
    find('#forward-status').textContent = '';
    forwardDialog.showModal();
    safe(refreshForwards(tab));
  };
  get('.disconnect').onclick = () => safe(api.disconnect(tab.id).then(restoreTerminalFocus));
  get('.serial-break').onclick = () => safe(api.serialBreak(tab.id).then(restoreTerminalFocus));
  const recording = get<HTMLButtonElement>('.record-log');
  recording.onclick = () => {
    recording.disabled = true;
    const enabled = recording.getAttribute('aria-pressed') === 'false';
    safe(api.record(tab.id, enabled).then(() => {
      recording.setAttribute('aria-pressed', String(enabled));
      recording.textContent = enabled ? '停止录制' : '开始录制';
      restoreTerminalFocus();
    }).finally(() => { recording.disabled = false; }));
  };
  get('.reconnect').onclick = () => {
    const config = tab.profile;
    if (config.kind === 'local') {
      if (!tab.closing) safe(closeTab(tab).then(() => openTab(config)));
      return;
    }
    openConnect(config.kind, config.kind === 'ssh' ? 'auth' : 'quick', config, tab);
  };
  const timerPanel = get('.timer-panel');
  const timerToggle = get('.timer-toggle');
  timerPanel.hidden = timerToggle.hidden = tab.profile.kind !== 'serial';
  timerToggle.setAttribute('aria-expanded', String(!timerPanel.hidden));
  timerToggle.onclick = () => {
    timerPanel.hidden = !timerPanel.hidden;
    timerToggle.setAttribute('aria-expanded', String(!timerPanel.hidden));
    fitTab(tab);
  };
  const timerForm = get<HTMLFormElement>('.timer-form');
  timerForm.onsubmit = event => {
    event.preventDefault();
    try {
      const input = (name: string) => control(timerForm, name);
      const max = input('maxRounds').value;
      const options = timerSchema.parse({
        command: input('command').value, intervalSeconds: Number(input('intervalSeconds').value),
        maxRounds: max ? Number(max) : undefined, lineEnding: input('lineEnding').value,
        waitForShell: input('waitForShell').checked, prompt: input('prompt').value,
      });
      safe(api.startTimer(tab.id, options).then(() => tab.term.focus()));
    } catch (error) { showNotice(message(error)); }
  };
  get('.timer-stop').onclick = () => safe(api.stopTimer(tab.id));
}

async function openTab(profile: SessionProfile, auth?: Auth) {
  await loadTerminalFont(preferences.font);
  const id = crypto.randomUUID();
  const term = new Terminal({
    theme: terminalTheme, cursorBlink: true, cursorStyle: 'block', ...terminalTypography(preferences),
    scrollback: preferences.scrollback, allowProposedApi: true,
    minimumContrastRatio: 1, macOptionIsMeta: false,
  });
  // The host controls terminal output, so it may not use OSC 52 to access the clipboard.
  term.parser.registerOscHandler(52, () => true);
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const surface = find<HTMLTemplateElement>('#surface-template').content.firstElementChild!.cloneNode(true) as HTMLElement;
  surface.id = 'surface-' + id;
  surface.setAttribute('role', 'tabpanel');
  surface.setAttribute('aria-labelledby', 'tab-' + id);
  find('.endpoint', surface).textContent = endpoint(profile);
  surfaces.append(surface);
  const wrapper = document.createElement('div');
  wrapper.className = 'tab-wrapper';
  wrapper.dataset.sessionId = id;
  const button = document.createElement('button');
  button.className = 'tab';
  button.id = 'tab-' + id;
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', surface.id);
  button.setAttribute('aria-selected', 'false');
  const dot = document.createElement('i');
  dot.className = 'status-dot';
  dot.dataset.state = 'connecting';
  const title = document.createElement('span');
  title.textContent = profile.name;
  button.append(dot, title);
  const close = document.createElement('button');
  close.className = 'tab-close';
  close.textContent = '×';
  close.ariaLabel = `关闭 ${profile.name}`;
  wrapper.append(button, close);
  tabList.append(wrapper);
  const tab: Tab = { id, profile, term, fit, search, surface, tab: button, wrapper, state: 'connecting', detail: endpoint(profile) };
  tabs.set(id, tab);
  bindTabDrag(tab);
  updateTabShortcuts();
  button.onclick = () => focusTab(tab);
  close.onclick = () => safe(closeTab(tab));
  surface.hidden = false;
  term.open(find('.terminal-mount', surface));
  if (profile.kind !== 'local' && profile.keywords) highlightKeywords(term, profile.keywords);
  term.textarea?.addEventListener('focus', () => {
    if (tab !== active && split?.includes(tab)) focusTab(tab);
  });
  bindSurface(tab);
  focusTab(tab);
  try {
    await api.open({ id, profile, auth, size: { cols: term.cols, rows: term.rows } });
  } catch (error) {
    removeTab(tab);
    throw error;
  }
}

function removeTab(tab: Tab) {
  if (previouslyFocused === tab) previouslyFocused = undefined;
  const remainingPane = split?.find(pane => pane !== tab);
  if (split?.includes(tab)) {
    split = undefined;
    delete surfaces.dataset.split;
  }
  observer.unobserve(find('.terminal-mount', tab.surface));
  disableGpu(tab);
  tab.term.dispose();
  tab.surface.remove();
  tab.wrapper.remove();
  tabs.delete(tab.id);
  updateTabShortcuts();
  if (active === tab) {
    active = undefined;
    const next = remainingPane ?? orderedTabs().at(-1);
    if (next) focusTab(next);
    else renderPanes();
  } else renderPanes();
}
async function closeTab(tab: Tab) {
  if (tab.closing) return;
  tab.closing = true;
  try {
    await api.close(tab.id);
    if (tabs.has(tab.id)) removeTab(tab);
  } finally { tab.closing = false; }
}

function nextKey() {
  if (pendingKey || document.querySelector('dialog[open]')) return;
  while (keys.length) {
    const key = keys.shift()!;
    if (tabs.get(key.id)?.state !== 'connecting') continue;
    pendingKey = key;
    find('#key-host').textContent = `${key.host}:${key.port}`;
    find('#key-fingerprint').textContent = key.fingerprint;
    keyDialog.showModal();
    find('#reject-key').focus();
    break;
  }
}
function decideKey(accepted: boolean) {
  const key = pendingKey;
  pendingKey = undefined;
  keyDialog.close();
  if (key) safe(api.acceptKey(key.id, key.token, accepted));
  nextKey();
}
keyDialog.addEventListener('cancel', event => { event.preventDefault(); decideKey(false); });
find('#reject-key').onclick = () => decideKey(false);
find('#accept-key').onclick = () => decideKey(true);

function handleSession(event: SessionEvent) {
  if (event.type === 'history') {
    renderRecentConnections(event.recentConnections);
    return;
  }
  const tab = tabs.get(event.id);
  if (!tab) return;
  if (event.type === 'connection') {
    tab.state = event.state;
    tab.detail = event.detail;
    tab.logDir = event.logDir;
    find('.status-dot', tab.tab).dataset.state = event.state;
    const logs = find<HTMLButtonElement>('.session-logs', tab.surface);
    logs.disabled = !event.logDir;
    if (event.logDir) logs.title = event.logDir;
    find('.reconnect', tab.surface).hidden = event.state !== 'disconnected';
    find('.disconnect', tab.surface).hidden = event.state !== 'connected';
    find('.record-log', tab.surface).hidden = event.state !== 'connected' || tab.profile.kind === 'serial';
    find('.serial-break', tab.surface).hidden = event.state !== 'connected' || tab.profile.kind !== 'serial';
    find('.open-sftp', tab.surface).hidden = event.state !== 'connected' || tab.profile.kind !== 'ssh';
    find('.open-forward', tab.surface).hidden = event.state !== 'connected' || tab.profile.kind !== 'ssh';
    if (event.state === 'disconnected') {
      if (pendingKey?.id === tab.id) { pendingKey = undefined; keyDialog.close(); nextKey(); }
      if (!tab.closing) showNotice(`${tab.profile.name} · ${event.detail}`);
    }
    setTimer(tab);
  } else if (event.type === 'error') {
    tab.warning = event.detail;
    showNotice(`${tab.profile.name} · ${event.detail}`);
    setTimer(tab);
  } else if (event.type === 'timer') {
    tab.timer = event.state;
    setTimer(tab);
  } else if (event.type === 'host-key') {
    keys.push(event.key);
    nextKey();
  } else {
    if (event.skipped) {
      tab.term.write(`\x1b[0m\r\n[TermDock: 显示队列跳过 ${event.skipped} 字节，请查看日志]\r\n`);
    }
    tab.term.write(event.data, () => api.ack(tab.id, event.sequence));
  }
  if (active === tab && (event.type === 'connection' || event.type === 'error')) updateFooter();
}

const commandBar = createCommandBar(api, (groupId, buttonId) => {
  const tab = active;
  if (tab?.state !== 'connected') return;
  safe(api.runCommand(tab.id, groupId, buttonId).then(() => {
    if (active === tab && !document.querySelector('dialog[open]')) tab.term.focus();
  }));
}, nextKey);
api.onSession(handleSession);
const sidebarToggle = find<HTMLButtonElement>('#sidebar-toggle');
const sidebar = find('#session-sidebar');
sidebarToggle.onclick = () => {
  sidebar.hidden = !sidebar.hidden;
  sidebarToggle.setAttribute('aria-expanded', String(!sidebar.hidden));
  sidebarToggle.title = sidebarToggle.ariaLabel = sidebar.hidden ? '展开会话栏' : '收起会话栏';
  active?.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  restoreTerminalFocus();
};
find('#quick-serial').onclick = find('#empty-serial').onclick = () => openConnect('serial');
find('#quick-ssh').onclick = find('#empty-ssh').onclick = () => openConnect('ssh');
find('#quick-local').onclick = find('#empty-local').onclick = () => safe(openTab(localDefaults));
find('#split-side').onclick = () => toggleSplit('side');
find('#split-stack').onclick = () => toggleSplit('stack');
async function refreshForwards(tab: Tab) {
  const entries = await api.listForwards(tab.id);
  if (tab !== forwardTab || !forwardDialog.open) return;
  find('#active-forwards').replaceChildren(...entries.map(entry => {
    const row = document.createElement('div');
    row.className = 'sftp-entry';
    const label = document.createElement('span');
    label.textContent = '127.0.0.1:' + entry.localPort + ' → ' + entry.host + ':' + entry.port;
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = '停止转发';
    stop.onclick = () => safe(api.stopForward(tab.id, entry.id).then(() => refreshForwards(tab)));
    row.append(label, stop);
    return row;
  }));
}
find<HTMLFormElement>('#forward-form').onsubmit = event => {
  event.preventDefault();
  const tab = forwardTab;
  if (!tab) return;
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const submit = event.submitter as HTMLButtonElement;
  submit.disabled = true;
  const status = find('#forward-status');
  status.textContent = '';
  void api.startForward(tab.id, { localPort: Number(form.get('localPort')),
    host: String(form.get('host')), port: Number(form.get('port')) })
    .then(() => refreshForwards(tab))
    .catch(error => { if (tab === forwardTab) status.textContent = message(error); })
    .finally(() => { submit.disabled = false; });
};
const importFile = find<HTMLInputElement>('#import-profile-file');
find('#import-profiles').onclick = () => importFile.click();
importFile.onchange = () => {
  const file = importFile.files?.[0];
  importFile.value = '';
  if (!file) return;
  safe((async () => {
    if (file.size > 1024 * 1024) throw new Error('会话文件超过 1 MiB');
    const result = await api.importProfiles(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
    profiles = result.profiles;
    renderProfiles();
    showNotice('已导入 ' + result.added + ' 个会话');
  })());
};
const localDialog = find<HTMLDialogElement>('#local-dialog');
find('#local-options').onclick = () => localDialog.showModal();
find<HTMLFormElement>('#local-form').onsubmit = event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  try {
    const shell = String(form.get('shell'));
    const name = { powershell: 'PowerShell', cmd: 'CMD', pwsh: 'PowerShell 7', wsl: 'WSL' }[shell];
    const env = Object.fromEntries(String(form.get('environment')).split(/\r?\n/).filter(line => line.trim()).map(line => {
      const separator = line.indexOf('=');
      if (separator < 1) throw new Error('环境变量格式为 NAME=value');
      return [line.slice(0, separator).trim(), line.slice(separator + 1)];
    }));
    const config = localProfile.parse({ kind: 'local', name, shell, cwd: String(form.get('cwd')).trim() || undefined, env });
    localDialog.close();
    safe(openTab(config));
  } catch (error) { showNotice(message(error)); }
};
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => { nextKey(); restoreTerminalFocus(); });
}
renderPanes();
find('#new-profile').onclick = () => openConnect('serial', 'save');
find('#all-logs').onclick = () => safe(api.showLogs());
find('#settings').onclick = () => {
  assign(find<HTMLFormElement>('#settings-form'), preferences);
  settingsDialog.showModal();
};
settingsDialog.addEventListener('close', nextKey);
find<HTMLFormElement>('#settings-form').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  try {
    const value = preferencesSchema.parse({
      font: control(form, 'font').value, fontSize: Number(control(form, 'fontSize').value),
      scrollback: Number(control(form, 'scrollback').value), gpu: control(form, 'gpu').checked,
    });
    safe(api.savePreferences(value).then(async saved => {
      await loadTerminalFont(saved.font);
      preferences = saved;
      for (const tab of tabs.values()) {
        tab.term.options = { ...terminalTypography(saved), scrollback: saved.scrollback };
        tab.gpuFailed = false;
        if (!saved.gpu) disableGpu(tab);
      }
      settingsDialog.close();
      if (active) { fitTab(active); enableGpu(active); updateFooter(); active.term.focus(); }
    }));
  } catch (error) { showNotice(message(error)); }
};
safe(api.load().then(value => {
  profiles = value.profiles;
  preferences = value.preferences;
  find('#all-logs').title = value.logRoot;
  field('logDirectory').placeholder = value.logRoot;
  commandBar.load(value.commandGroups);
  renderProfiles();
  renderRecentConnections(value.recentConnections);
}));
