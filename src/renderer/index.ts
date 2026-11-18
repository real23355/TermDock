import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { createCommandBar } from './command-bar';
import { connectWebView } from './webview';
import { highlightKeywords } from './keyword-highlight';
import { createSftpBrowser } from './sftp-browser';
import { quoteDroppedPaths } from './shell-paths';
import { bindWorkflow } from './workflow-editor';
import { icon, type IconName } from './icons';
import { createAiPanel, type ReadablePane } from './ai-panel';
import type { Bridge } from '../desktop-bridge';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import {
  authSchema, defaults, lineEndings, localDefaults, localProfile, preferencesSchema, profile as profileSchema, serialDefaults, timerSchema,
  type Auth, type ConnectionState, type HostKey, type OpenRequest, type Preferences, type Profile, type RecentConnection,
  type SavedProfile, type SessionEvent, type SessionProfile, type SshProfile, type TimerState,
} from '../shared';

declare global {
  interface Window {
    termDock: Bridge;
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
tabList.addEventListener('wheel', event => {
  if (tabList.scrollWidth > tabList.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault(); tabList.scrollLeft += event.deltaY;
  }
}, { passive: false });
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
  detail: string; timer?: TimerState; warning?: string; logDir?: string; reconnectProfile?: Profile;
  actions: Partial<Record<TopAction, () => void>>; recording: boolean; recordPending?: boolean;
};
type TopAction = 'search' | 'logs' | 'record' | 'disconnect' | 'sftp' | 'forward' | 'reconnect' | 'timer' | 'break';

const tabs = new Map<string, Tab>();
const keys: HostKey[] = [];
let pendingKey: HostKey | undefined;
let active: Tab | undefined;
let previouslyFocused: Tab | undefined;
let split: [Tab, Tab] | undefined;
let profiles: SavedProfile[] = [];
let preferences: Preferences = defaults;
let editing: SavedProfile | undefined;
let editingRecent: RecentConnection | undefined;
let reconnecting: Tab | undefined;
let forwardTab: Tab | undefined;
let connectMode: 'quick' | 'save' | 'edit' | 'auth' | 'recent' | 'tab' = 'quick';
let editingTab: Tab | undefined;
let credentialQuery = 0;
let authEndpoint = '';
let authTargetChanged = false;
function formEndpoint() { return JSON.stringify([field('host').value.trim().toLowerCase(), Number(field('port').value), field('username').value.trim()]); }

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
    else input.value = value == null ? '' : String(value);
  }
}
function cleanAuth() {
  credentialQuery++;
  assign(connectForm, { method: 'password', password: '', passphrase: '', privateKey: '', rememberPassword: false, forgetPassword: false });
}

function endpoint(config: SessionProfile) {
  if (config.kind === 'local') return '本机 ' + config.name;
  return config.kind === 'ssh' ? `${config.username}@${config.host}:${config.port}` : `${config.path}  /  ${config.baudRate}`;
}

const contextMenu = document.createElement('div');
contextMenu.className = 'context-menu';
contextMenu.hidden = true;
document.body.append(contextMenu);
function popup(event: MouseEvent, items: [string, () => void][]) {
  event.preventDefault();
  event.stopPropagation();
  const target = event.target as HTMLElement;
  (target.closest('dialog') ?? document.body).append(contextMenu);
  contextMenu.replaceChildren(...items.map(([label, action]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = () => { contextMenu.hidden = true; action(); };
    return button;
  }));
  contextMenu.hidden = false;
  contextMenu.style.left = Math.max(0, Math.min(event.clientX, innerWidth - contextMenu.offsetWidth - 4)) + 'px';
  contextMenu.style.top = Math.max(0, Math.min(event.clientY, innerHeight - contextMenu.offsetHeight - 4)) + 'px';
}
document.addEventListener('pointerdown', event => {
  if (!(event.target instanceof Node) || !contextMenu.contains(event.target)) contextMenu.hidden = true;
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') contextMenu.hidden = true; });

type TextControl = HTMLInputElement | HTMLTextAreaElement;
function textControl(target: EventTarget | null): TextControl | undefined {
  if (target instanceof HTMLTextAreaElement && !target.closest('.xterm')) return target;
  if (target instanceof HTMLInputElement && ['text', 'search', 'tel', 'url', 'password'].includes(target.type)) return target;
}
document.addEventListener('contextmenu', event => {
  const input = textControl(event.target);
  if (!input) return;
  const selection = () => input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
  const items: [string, () => void][] = [];
  if (input.type !== 'password' && selection()) items.push(['复制', () => safe(api.copy(selection()))]);
  if (!input.readOnly && !input.disabled) items.push(['粘贴', () => safe(api.paste().then(value => {
    if (!value || !input.isConnected) return;
    input.setRangeText(value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    input.focus();
  }))]);
  items.push(['全选', () => { input.focus(); input.select(); }]);
  popup(event, items);
});
let textSelectionStart: { target: EventTarget | null; x: number; y: number } | undefined;
document.addEventListener('mousedown', event => {
  if (event.button !== 0) return;
  textSelectionStart = { target: event.target, x: event.clientX, y: event.clientY };
}, true);
document.addEventListener('mouseup', event => {
  if (event.button !== 0) return;
  const start = textSelectionStart;
  textSelectionStart = undefined;
  if (!start || !(start.target instanceof HTMLElement) || start.target.closest('.terminal-mount,.context-menu,.session-drag-source')) return;
  if (start.x === event.clientX && start.y === event.clientY && event.detail < 2) return;
  const input = textControl(start.target);
  if (input?.type === 'password') return;
  queueMicrotask(() => {
    const selection = document.getSelection();
    const value = input ? input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0) :
      (selection?.anchorNode?.parentElement?.closest('.xterm,input[type=password]') ? '' : selection?.toString());
    if (value) safe(api.copy(value));
  });
}, true);

function connectProfile(config: Profile) {
  if (config.kind === 'ssh') openConnect('ssh', 'auth', config);
  else safe(openTab(config));
}
function saveAs(config: Profile, group = config.group) {
  openConnect(config.kind, 'save', { ...config, id: undefined, group });
}
function bindProfileMenu(element: HTMLElement, config: Profile, recent?: RecentConnection, tab?: Tab) {
  element.oncontextmenu = event => {
    const items: [string, () => void][] = [
      [tab ? '切换到会话' : '连接', () => tab ? focusTab(tab) : connectProfile(config)],
      [config.id ? '另存为新会话…' : '保存为会话…', () => saveAs(config)],
      ['设置 / 重命名…', () => {
        const settings = tab?.reconnectProfile ?? profiles.find(saved => saved.id === config.id) ?? config;
        openConnect(settings.kind, settings.id ? 'edit' : recent ? 'recent' : tab ? 'tab' : 'save', settings);
        editingRecent = recent;
        editingTab = tab;
        field('name').select();
      }],
    ];
    if (config.id) items.push(['删除会话…', () => {
      if (confirm(`删除已保存的会话「${config.name}」？`)) safe(deleteProfile(config.id!));
    }]);
    popup(event, items);
  };
}
function bindProfileDrag(element: HTMLElement, config: Profile) {
  beginSessionDrag(element, { config });
}
const profileDropZones = new WeakMap<HTMLElement, string | undefined>();
function bindProfileDrop(element: HTMLElement, group?: string) {
  profileDropZones.set(element, group);
  element.dataset.sessionDrop = '';
}
bindProfileDrop(find('[aria-labelledby=saved-heading]'));

// Internal drags stay in the page; only file drops use the host's native drag data.
let sessionDrag: { x: number; y: number; pointer: number; config?: Profile; tab?: Tab; dragging?: boolean; target?: HTMLElement } | undefined;
function beginSessionDrag(element: HTMLElement, source: { config?: Profile; tab?: Tab }) {
  element.classList.add('session-drag-source');
  element.onpointerdown = event => {
    if (event.button === 0) sessionDrag = { ...source, x: event.clientX, y: event.clientY, pointer: event.pointerId };
  };
}
function dragTarget(event: PointerEvent) {
  const node = document.elementFromPoint(event.clientX, event.clientY);
  const area = sessionDrag?.config && node?.closest<HTMLElement>('[data-session-drop]');
  if (area) return area;
  const tab = sessionDrag?.tab && node?.closest<HTMLElement>('.tab-wrapper');
  if (tab && tab !== sessionDrag?.tab?.wrapper) return tab;
}
function clearSessionDrag() {
  sessionDrag?.target?.classList.remove('drop-target');
  document.body.classList.remove('session-dragging');
  sessionDrag = undefined;
}
document.addEventListener('pointermove', event => {
  const drag = sessionDrag;
  if (!drag || drag.pointer !== event.pointerId) return;
  if (!(event.buttons & 1)) { clearSessionDrag(); return; }
  if (!drag.dragging && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 7) return;
  drag.dragging = true;
  document.body.classList.add('session-dragging');
  const target = dragTarget(event);
  if (drag.target === target) return;
  drag.target?.classList.remove('drop-target');
  drag.target = target;
  target?.classList.add('drop-target');
});
document.addEventListener('pointerup', event => {
  const drag = sessionDrag;
  if (!drag || drag.pointer !== event.pointerId) return;
  const target = drag.dragging ? dragTarget(event) : undefined;
  clearSessionDrag();
  if (!target) return;
  if (drag.config && profileDropZones.has(target)) {
    saveAs(drag.config, profileDropZones.get(target) ?? drag.config.group);
  } else if (drag.tab && tabs.has(drag.tab.id) && target.dataset.sessionId) {
    const position = document.createComment('');
    drag.tab.wrapper.replaceWith(position);
    target.replaceWith(drag.tab.wrapper);
    position.replaceWith(target);
    updateTabShortcuts();
    restoreTerminalFocus();
  }
});
document.addEventListener('pointercancel', clearSessionDrag);
window.addEventListener('blur', clearSessionDrag);

function profileButton(config: Profile, recent?: RecentConnection) {
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
  open.onclick = () => connectProfile(config);
  bindProfileMenu(open, config, recent);
  if (recent) bindProfileDrag(open, config);
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
        bindProfileDrop(section, group);
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
    bindProfileMenu(row, saved);
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
    const open = profileButton(profile, { profile, connectedAt });
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
  const serialFields = find<HTMLFieldSetElement>('#serial-fields');
  const sshFields = find<HTMLFieldSetElement>('#ssh-fields');
  serialFields.hidden = serialFields.disabled = !serial;
  sshFields.hidden = sshFields.disabled = serial;
  field('path').required = field('baudRate').required = serial;
  field('host').required = field('port').required = field('username').required = !serial;
  const key = field('method').value === 'key';
  find('#key-fields').hidden = !key;
  find('#password-fields').hidden = field('method').value !== 'password';
}

async function updateCredential() {
  const tick = ++credentialQuery;
  field('password').placeholder = '';
  find('#forget-password').hidden = true;
  find('#credential-status').textContent = authTargetChanged ? '连接目标或账号已更改，请确认并重新填写密码；记住密码选项仍保留。' : '';
  if (field('kind').value !== 'ssh' || field('method').value !== 'password') return;
  const config = profileSchema.safeParse({ kind: 'ssh', name: 'SSH', host: field('host').value,
    port: Number(field('port').value), username: field('username').value });
  if (!config.success || config.data.kind !== 'ssh') return;
  let saved: boolean;
  try { saved = await api.credential(config.data); }
  catch (error) {
    if (tick === credentialQuery && connectDialog.open) find('#credential-status').textContent = message(error);
    return;
  }
  if (tick !== credentialQuery || !connectDialog.open) return;
  find('#forget-password').hidden = !saved;
  field('password').placeholder = saved ? '留空使用已保存的密码' : '';
  find('#credential-status').textContent = saved ? '密码已保存（当前 Windows 用户）。留空使用，输入新密码并勾选记住密码可替换。'
    : authTargetChanged ? '连接目标或账号已更改，请确认并重新填写密码；记住密码选项仍保留。' : '此目标尚未保存密码';
}

function openConnect(kind: Profile['kind'], mode: typeof connectMode = 'quick', config?: Profile, previous?: Tab) {
  connectMode = mode;
  editingRecent = undefined;
  editingTab = undefined;
  editing = config?.id ? config as SavedProfile : undefined;
  reconnecting = previous;
  connectForm.reset();
  assign(connectForm, { ...serialDefaults, ...sshDefaults, ...(config ?? (kind === 'ssh' ? sshDefaults : serialDefaults)), kind });
  setLogDirectory(config?.kind === 'serial' ? config.logDirectory ?? '' : '');
  cleanAuth();
  authEndpoint = formEndpoint();
  authTargetChanged = false;
  if (config?.kind === 'ssh') assign(connectForm, { method: config.method ?? 'password', privateKey: config.privateKey ?? '' });
  field('kind').disabled = mode === 'auth';
  for (const name of ['name', 'group', 'keywords', 'host', 'port', 'username']) field(name).readOnly = mode === 'auth';
  field('favorite').disabled = mode === 'auth';
  find('#connect-title').textContent = ({ quick: '快速连接', save: config ? '另存为新会话' : '新建会话',
    edit: '编辑已保存会话', auth: '连接 SSH', recent: '编辑最近连接', tab: '编辑重连设置' })[mode];
  find<HTMLButtonElement>('#save-profile').hidden = mode === 'auth';
  find<HTMLButtonElement>('#connect-now').hidden = ['save', 'edit', 'recent', 'tab'].includes(mode);
  find<HTMLButtonElement>('#delete-profile').hidden = mode !== 'edit';
  find('#connect-error').hidden = true;
  updateForm();
  connectDialog.showModal();
  safe(updateCredential());
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
  } : { ...base, host: text('host'), port: number('port'), username: text('username'),
    method: text('method') !== 'password' ? text('method') : undefined,
    privateKey: text('method') === 'key' ? text('privateKey') || undefined : undefined });
}

async function submitConnect(event: SubmitEvent) {
  event.preventDefault();
  const button = event.submitter as HTMLButtonElement | null;
  if (button) button.disabled = true;
  const errorBox = find('#connect-error');
  errorBox.hidden = true;
  try {
    const config = parseProfile();
    const save = button?.value === 'save' || ['save', 'edit', 'recent', 'tab'].includes(connectMode);
    const password = field('password').value;
    const isPassword = config.kind === 'ssh' && field('method').value === 'password';
    const rememberRequested = isPassword && field('rememberPassword').checked;
    if (rememberRequested && !password && config.kind === 'ssh' && !await api.credential(config)) {
      throw new Error('已勾选记住密码，请填写此目标的密码后再保存');
    }
    const remember = rememberRequested && !!password;
    const forget = isPassword && !find('#forget-password').hidden && field('forgetPassword').checked;
    if (remember && forget) throw new Error('请选择替换密码或清除密码');
    if (config.kind === 'ssh' && forget) await api.credential(config, { action: 'clear' });
    if (config.kind === 'ssh' && remember && save) await api.credential(config, { action: 'save', password });
    if (config.kind === 'ssh' && remember && save) showNotice('SSH 密码已保存（Windows 用户保护，已验证可读取）');
    if (connectMode === 'recent' && editingRecent) {
      renderRecentConnections(await api.editRecent(editingRecent, config));
      connectDialog.close();
    } else if (connectMode === 'tab' && editingTab) {
      editingTab.reconnectProfile = config;
      connectDialog.close();
      showNotice('设置将在此会话下次重连时生效');
    } else if (save) {
      const saved = await api.saveProfile(config);
      const index = profiles.findIndex(p => p.id === saved.id);
      if (index < 0) profiles.push(saved);
      else profiles[index] = saved;
      if (editingTab) editingTab.reconnectProfile = saved;
      renderProfiles();
      connectDialog.close();
    } else {
      const useSavedPassword = config.kind === 'ssh' && isPassword && !password && !forget && await api.credential(config);
      const auth = config.kind === 'ssh' && !useSavedPassword ? authSchema.parse({
        method: field('method').value, password,
        privateKey: field('privateKey').value, passphrase: field('passphrase').value,
      }) : undefined;
      const previous = reconnecting;
      connectDialog.close();
      cleanAuth();
      if (previous) await closeTab(previous);
      await openTab(config, auth, { useSavedPassword, rememberPassword: remember });
    }
  } catch (error) {
    if (connectDialog.open) {
      errorBox.textContent = message(error);
      errorBox.hidden = false;
    } else showNotice(message(error));
  } finally { if (button) button.disabled = false; }
}
connectForm.onsubmit = event => { void submitConnect(event); };
connectDialog.addEventListener('close', () => { cleanAuth(); nextKey(); restoreTerminalFocus(); });
field('kind').onchange = () => {
  field('name').value = field('kind').value === 'ssh' ? sshDefaults.name : serialDefaults.name;
  updateForm();
  safe(updateCredential());
  if (field('kind').value === 'serial') safe(refreshPorts());
};
field('method').onchange = () => { updateForm(); safe(updateCredential()); };
for (const name of ['host', 'port', 'username']) field(name).oninput = () => {
  const next = formEndpoint();
  if (next !== authEndpoint) {
    authTargetChanged = !!field('password').value || !!field('passphrase').value || authTargetChanged;
    assign(connectForm, { password: '', passphrase: '', forgetPassword: false });
    authEndpoint = next;
  }
  safe(updateCredential());
};
find('#refresh-ports').onclick = () => safe(refreshPorts());
find('#pick-log-directory').onclick = () => safe(api.pickLogDirectory().then(path => {
  if (path) setLogDirectory(path);
}));
find('#reset-log-directory').onclick = () => setLogDirectory('');
find('#pick-key').onclick = () => safe(api.pickKey().then(path => { if (path) field('privateKey').value = path; }));
async function deleteProfile(id: string) {
  await api.deleteProfile(id);
  profiles = profiles.filter(p => p.id !== id);
  renderProfiles();
}
find('#delete-profile').onclick = () => {
  const id = editing?.id;
  if (!id) return;
  safe(deleteProfile(id).then(() => connectDialog.close()));
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
  if (!document.querySelector('dialog:modal')) active?.term.focus();
}

function renderPanes() {
  const shown: readonly Tab[] = split ?? (active ? [active] : []);
  for (const tab of tabs.values()) {
    const index = shown.indexOf(tab);
    const mount = find('.terminal-mount', tab.surface);
    tab.tab.setAttribute('aria-selected', String(tab === active));
    tab.surface.dataset.active = String(tab === active);
    tab.surface.hidden = index < 0;
    if (index < 0) {
      observer.unobserve(mount);
      disableGpu(tab);
    } else {
      tab.surface.style.order = String(index * 2);
      observer.observe(mount);
    }
  }
  for (const tab of shown) { fitTab(tab); enableGpu(tab); }
  find('#empty').hidden = !!active;
  find('#tabs-empty').hidden = !!active;
  for (const [id, direction] of [['#split-side', 'side'], ['#split-stack', 'stack']]) {
    const button = find<HTMLButtonElement>(id);
    button.disabled = false;
    button.setAttribute('aria-pressed', String(surfaces.dataset.split === direction));
  }
  divider.hidden = !split;
  divider.setAttribute('aria-orientation', surfaces.dataset.split === 'stack' ? 'horizontal' : 'vertical');
  for (const [index, pane] of shown.entries()) {
    const select = find<HTMLSelectElement>('.pane-select', pane.surface);
    select.hidden = !split;
    if (split) {
      setPaneOptions(select, pane, split[1 - index]);
      select.ariaLabel = (surfaces.dataset.split === 'stack' ? ['上方', '下方'] : ['左侧', '右侧'])[index] + '连接';
      select.onchange = () => {
        const next = tabs.get(select.value);
        if (!next || !split || split.includes(next)) return;
        split[index] = next;
        focusTab(next);
      };
    }
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

const splitDialog = find<HTMLDialogElement>('#split-dialog');
const firstPane = find<HTMLSelectElement>('#split-first');
const secondPane = find<HTMLSelectElement>('#split-second');
const divider = document.createElement('div');
divider.className = 'pane-divider';
divider.tabIndex = 0;
divider.setAttribute('role', 'separator');
divider.ariaLabel = '调整窗格大小';
surfaces.append(divider);
let splitRatio = 50;
function setSplitRatio(ratio: number) {
  splitRatio = Math.max(20, Math.min(80, ratio));
  surfaces.style.setProperty('--split-ratio', splitRatio + '%');
  divider.setAttribute('aria-valuenow', String(Math.round(splitRatio)));
}
divider.setAttribute('aria-valuemin', '20');
divider.setAttribute('aria-valuemax', '80');
setSplitRatio(50);
divider.onpointerdown = event => {
  if (event.button !== 0) return;
  event.preventDefault();
  divider.setPointerCapture(event.pointerId);
};
divider.onpointermove = event => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const rect = surfaces.getBoundingClientRect();
  setSplitRatio(surfaces.dataset.split === 'stack'
    ? (event.clientY - rect.top) * 100 / rect.height : (event.clientX - rect.left) * 100 / rect.width);
};
divider.onpointerup = restoreTerminalFocus;
divider.onkeydown = event => {
  if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    setSplitRatio(splitRatio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -5 : 5));
  }
};
let splitDirection = 'side';
function setPaneOptions(select: HTMLSelectElement, selected?: Tab, excluded?: Tab) {
  select.replaceChildren(...orderedTabs().filter(tab => tab !== excluded).map((tab, index) => {
    const option = document.createElement('option');
    option.value = tab.id;
    option.textContent = `${index + 1}. ${tab.profile.name} · ${endpoint(tab.profile)}`;
    return option;
  }));
  if (selected) select.value = selected.id;
}
function chooseSplit(direction: string) {
  if (tabs.size < 2 || !active) { showNotice('请先打开第二个终端会话'); return; }
  splitDirection = direction;
  const other = previouslyFocused && previouslyFocused !== active ? previouslyFocused : orderedTabs().find(tab => tab !== active);
  setPaneOptions(firstPane, split?.[0] ?? active);
  setPaneOptions(secondPane, split?.[1] ?? other);
  find('#split-first-label').textContent = direction === 'stack' ? '上方连接' : '左侧连接';
  find('#split-second-label').textContent = direction === 'stack' ? '下方连接' : '右侧连接';
  find('#split-error').hidden = true;
  splitDialog.showModal();
}
find<HTMLFormElement>('#split-form').onsubmit = event => {
  event.preventDefault();
  const first = tabs.get(firstPane.value);
  const second = tabs.get(secondPane.value);
  if (!first || !second || first === second) { find('#split-error').hidden = false; return; }
  split = [first, second];
  surfaces.dataset.split = splitDirection;
  splitDialog.close();
  focusTab(active && split.includes(active) ? active : first);
};

function orderedTabs() {
  return Array.from(tabList.children, wrapper => tabs.get((wrapper as HTMLElement).dataset.sessionId!)!);
}

function updateTabShortcuts() {
  orderedTabs().forEach((tab, index) => {
    const shortcut = index < 9 ? `Alt+${index + 1}` : '';
    if (shortcut) tab.tab.setAttribute('aria-keyshortcuts', shortcut);
    else tab.tab.removeAttribute('aria-keyshortcuts');
    tab.tab.title = [tab.profile.name, endpoint(tab.profile), shortcut, '拖拽交换位置'].filter(Boolean).join(' · ');
  });
}

window.addEventListener('keydown', event => {
  if (event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || document.querySelector('dialog:modal')) return;
  const digit = /^Digit([1-9])$/.exec(event.code);
  const tab = digit && orderedTabs()[Number(digit[1]) - 1];
  if (!tab) return;
  event.preventDefault();
  event.stopPropagation();
  focusTab(tab);
}, { capture: true });

function bindTabDrag(tab: Tab) {
  beginSessionDrag(tab.tab, { tab, config: tab.profile.kind === 'local' ? undefined : tab.profile });
}

function updateFooter() {
  commandBar.setConnected(active?.state === 'connected');
  find('#global-dot').dataset.state = active?.state ?? '';
  find('#global-state').textContent = active ? connectionLabels[active.state] : '无活动连接';
  find('#global-endpoint').textContent = active?.warning ?? active?.detail ?? '';
  find('#global-size').textContent = active ? `${active.term.cols} × ${active.term.rows}` : '';
  find('#global-renderer').textContent = active ? (active.gl ? 'WebGL' : 'DOM') : '';
  updateToolbar();
  aiUI.refreshSources();
}

function setTimer(tab: Tab) {
  const state = tab.timer;
  const inProgress = state && ['countdown', 'waiting', 'sending'].includes(state.send);
  find('.countdown', tab.surface).textContent = inProgress ? `${state.seconds}s` : '—';
  find('.rounds', tab.surface).textContent = String(state?.rounds ?? 0);
  find('.round-recording', tab.surface).textContent = state?.roundRecording && tab.state === 'connected' ? '记录中' : '未记录';
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
  const mount = get('.terminal-mount');
  let selecting = false;
  mount.addEventListener('mousedown', event => {
    if (event.button === 0) selecting = true;
    if (event.button === 2) { event.stopImmediatePropagation(); event.preventDefault(); }
  }, true);
  const endSelection = (event: MouseEvent) => {
    if (event.button === 0 && selecting) {
      setTimeout(() => {
        selecting = false;
        if (tab.term.hasSelection()) safe(api.copy(tab.term.getSelection()));
      }, 0);
    }
  };
  document.addEventListener('mouseup', endSelection, true);
  tab.surface.addEventListener('termdock-dispose', () => document.removeEventListener('mouseup', endSelection, true), { once: true });
  mount.addEventListener('contextmenu', event => {
    event.stopImmediatePropagation();
    event.preventDefault();
    if (tab.state !== 'connected') return;
    focusTab(tab);
    safe(api.paste().then(value => {
      if (value && tab.state === 'connected' && tabs.has(tab.id)) tab.term.paste(value);
    }));
  }, true);
  mount.ondragover = event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = tab.profile.kind === 'local' ? 'copy' : 'none';
  };
  mount.ondrop = event => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (tab.profile.kind !== 'local' || tab.state !== 'connected') return;
    const shell = tab.profile.shell;
    focusTab(tab);
    safe(api.droppedPaths(window.termDock ? [] : files).then(paths => {
      const value = quoteDroppedPaths(shell, paths);
      if (tab.state === 'connected' && tabs.has(tab.id)) tab.term.paste(value);
    }));
  };
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
  tab.actions.search = showSearch;
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
        if (value && active === tab && !document.querySelector('dialog:modal')) tab.term.paste(value);
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
  tab.actions.logs = () => safe(api.showLogs(tab.id));
  tab.actions.sftp = () => openSftp(tab.id);
  tab.actions.forward = () => {
    forwardTab = tab;
    find('#active-forwards').replaceChildren();
    find('#forward-status').textContent = '';
    forwardDialog.showModal();
    safe(refreshForwards(tab));
  };
  tab.actions.disconnect = () => safe(api.disconnect(tab.id).then(restoreTerminalFocus));
  tab.actions.break = () => safe(api.serialBreak(tab.id).then(restoreTerminalFocus));
  tab.actions.record = () => {
    tab.recordPending = true;
    updateToolbar();
    const enabled = !tab.recording;
    safe(api.record(tab.id, enabled).then(() => {
      tab.recording = enabled;
      restoreTerminalFocus();
    }).finally(() => { tab.recordPending = false; updateToolbar(); }));
  };
  tab.actions.reconnect = () => {
    const config = tab.reconnectProfile ?? (tab.profile.kind !== 'local' && tab.profile.id
      ? profiles.find(saved => saved.id === (tab.profile as SavedProfile).id) : undefined) ?? tab.profile;
    if (config.kind === 'local') {
      if (!tab.closing) safe(closeTab(tab).then(() => openTab(config)));
      return;
    }
    openConnect(config.kind, config.kind === 'ssh' ? 'auth' : 'quick', config, tab);
  };
  const timerPanel = get('.timer-panel');
  timerPanel.hidden = tab.profile.kind !== 'serial';
  const timerExpand = get('.timer-expand');
  function collapseTimer(collapsed: boolean) {
    timerPanel.hidden = collapsed;
    timerExpand.hidden = !collapsed;
    fitTab(tab);
    tab.term.focus();
  }
  tab.actions.timer = () => collapseTimer(!timerPanel.hidden);
  timerExpand.onclick = () => collapseTimer(false);
  get('.timer-collapse').onclick = () => collapseTimer(true);
  const timerForm = get<HTMLFormElement>('.timer-form');
  const workflow = bindWorkflow(timerForm);
  timerForm.onsubmit = event => {
    event.preventDefault();
    try {
      const input = (name: string) => control(timerForm, name);
      const max = input('maxRounds').value;
      const options = timerSchema.parse({
        command: input('command').value || 'reboot', intervalSeconds: Number(input('intervalSeconds').value),
        maxRounds: max ? Number(max) : undefined, lineEnding: input('lineEnding').value,
        waitForShell: input('waitForShell').checked, prompt: input('prompt').value,
        once: input('once').checked, ...workflow.options(),
      });
      safe(api.startTimer(tab.id, options).then(() => { workflow.clearSecret(); tab.term.focus(); }));
    } catch (error) { showNotice(message(error)); }
  };
  get('.timer-stop').onclick = () => safe(api.stopTimer(tab.id));
}

async function openTab(profile: SessionProfile, auth?: Auth, passwordOptions?: Pick<OpenRequest, 'useSavedPassword' | 'rememberPassword'>) {
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
  const tab: Tab = { id, profile, term, fit, search, surface, tab: button, wrapper, state: 'connecting', detail: endpoint(profile), actions: {}, recording: true };
  tabs.set(id, tab);
  bindTabDrag(tab);
  if (profile.kind !== 'local') bindProfileMenu(wrapper, profile, undefined, tab);
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
    await api.open({ id, profile, auth, ...passwordOptions, size: { cols: term.cols, rows: term.rows } });
    if (passwordOptions?.rememberPassword) showNotice('SSH 密码已保存（Windows 用户保护，已验证可读取）');
  } catch (error) {
    removeTab(tab);
    throw error;
  }
}

function removeTab(tab: Tab) {
  tab.surface.dispatchEvent(new Event('termdock-dispose'));
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
  if (pendingKey || document.querySelector('dialog:modal')) return;
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
  if (event.type === 'ai-progress') return;
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

function readablePanes(): ReadablePane[] {
  return orderedTabs().filter(tab => tab.profile.kind !== 'local').map(tab => ({
    id: tab.id, name: tab.profile.name, endpoint: endpoint(tab.profile),
    kind: tab.profile.kind === 'serial' ? 'serial' : 'ssh', connected: tab.state === 'connected',
    position: split?.includes(tab) ? (surfaces.dataset.split === 'stack' ? ['上方窗格', '下方窗格'] : ['左侧窗格', '右侧窗格'])[split.indexOf(tab)]
      : tab === active ? '当前标签' : '后台标签',
    read: () => {
      const buffer = tab.term.buffer.active;
      return Array.from({ length: tab.term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n').trimEnd();
    },
    selection: () => tab.term.getSelection(),
  }));
}
function showSettings(ai = false) {
  assign(find<HTMLFormElement>('#settings-form'), preferences);
  settingsDialog.showModal();
  selectSettings(ai);
}
function selectSettings(ai: boolean) {
  find('#settings-form').hidden = ai;
  find('#ai-settings-form').hidden = !ai;
  find('#settings-terminal-tab').setAttribute('aria-selected', String(!ai));
  find('#settings-ai-tab').setAttribute('aria-selected', String(ai));
  if (ai) void aiUI.loadSettings();
}
const aiUI = createAiPanel(api, readablePanes, () => active?.id, () => showSettings(true), restoreTerminalFocus);
find('#open-ai-chat').onclick = () => aiUI.open('dialog');

const topMenu = find('#top-menu');
const topMore = find<HTMLButtonElement>('#top-more');
let capturedSelection: { pane?: ReadablePane; text: string } = { text: '' };
const actionLabels: Record<TopAction, string> = {
  search: '搜索', logs: '日志', record: '停止记录', disconnect: '断开', sftp: 'SFTP', forward: '端口转发', reconnect: '重连', timer: '定时发送 / 重启测试', break: 'Serial Break',
};
function canAct(action: TopAction) {
  const tab = active;
  if (!tab) return false;
  if (action === 'search') return true;
  if (action === 'logs') return !!tab.logDir;
  if (action === 'timer') return tab.profile.kind === 'serial';
  if (action === 'reconnect') return tab.state === 'disconnected';
  if (action === 'sftp' || action === 'forward') return tab.state === 'connected' && tab.profile.kind === 'ssh';
  if (action === 'break') return tab.state === 'connected' && tab.profile.kind === 'serial';
  return tab.state === 'connected' && !(action === 'record' && tab.recordPending);
}
function actionLabel(action: TopAction) { return action === 'record' && !active?.recording ? '开始记录' : actionLabels[action]; }
function updateToolbar() {
  const address = find('#active-endpoint');
  address.textContent = active ? endpoint(active.profile) : '';
  address.title = active ? `${active.profile.name} · ${endpoint(active.profile)}` : '';
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    const action = button.dataset.action as TopAction;
    button.disabled = !canAct(action);
    button.title = action === 'logs' && active?.logDir ? active.logDir : actionLabel(action);
    button.ariaLabel = actionLabel(action);
    if (button.closest('#top-menu')) find('span', button).textContent = actionLabel(action);
    if (action === 'record') button.setAttribute('aria-pressed', String(!!active?.recording));
  }
}
function act(action: TopAction) { if (canAct(action)) active?.actions[action]?.(); }
function closeTopMenu() { topMenu.hidden = true; topMore.setAttribute('aria-expanded', 'false'); }
function captureSelection() {
  const pane = readablePanes().find(pane => pane.id === active?.id);
  capturedSelection = { pane, text: pane?.selection() ?? '' };
}
topMore.onpointerdown = captureSelection;
function menuItem(label: string, run: () => void, disabled = false, name?: IconName) {
  const button = document.createElement('button');
  button.type = 'button'; button.role = 'menuitem'; button.disabled = disabled;
  const text = document.createElement('span'); text.textContent = label;
  if (name) button.append(icon(name));
  button.append(text);
  button.onclick = () => { closeTopMenu(); run(); };
  return button;
}
topMore.onclick = event => {
  if (!topMenu.hidden) { closeTopMenu(); restoreTerminalFocus(); return; }
  if (event.detail === 0) captureSelection();
  const actions = (Object.keys(actionLabels) as TopAction[]).map(action => {
    const button = menuItem(actionLabel(action), () => act(action), !canAct(action), action === 'break' ? 'disconnect' : action);
    button.dataset.action = action;
    return button;
  });
  topMenu.replaceChildren(
    menuItem('快速连接 SSH', () => openConnect('ssh')),
    menuItem('快速连接串口', () => openConnect('serial')),
    menuItem('打开 PowerShell', () => safe(openTab(localDefaults))),
    menuItem('左右分屏', () => chooseSplit('side'), tabs.size < 2, 'side'),
    menuItem('上下分屏', () => chooseSplit('stack'), tabs.size < 2, 'stack'),
    menuItem('交换窗格', () => { if (split && active) { split.reverse(); focusTab(active); } }, !split, 'forward'),
    menuItem('关闭分屏', closeSplit, !split),
    ...actions,
    menuItem('AI 对话', () => aiUI.open('dialog'), false, 'ai'),
    menuItem('AI 日志分析', () => aiUI.open('dock'), false, 'ai'),
    menuItem('分析选中日志', () => { void aiUI.analyzeSelection(capturedSelection.pane, capturedSelection.text); }, false, 'ai'),
    menuItem('设置', () => showSettings()),
  );
  topMenu.hidden = false; topMore.setAttribute('aria-expanded', 'true');
  topMenu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
};
topMenu.onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); closeTopMenu(); restoreTerminalFocus(); }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const buttons = Array.from(topMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
};
document.addEventListener('pointerdown', event => { if (event.target instanceof Node && !topMenu.contains(event.target) && !topMore.contains(event.target)) closeTopMenu(); });
for (const button of document.querySelectorAll<HTMLButtonElement>('.top-tools [data-action]')) button.onclick = () => act(button.dataset.action as TopAction);
for (const element of document.querySelectorAll<HTMLElement>('[data-icon]')) element.prepend(icon(element.dataset.icon as IconName));

const commandBar = createCommandBar(api, (groupId, buttonId) => {
  const tab = active;
  if (tab?.state !== 'connected') return;
  safe(api.runCommand(tab.id, groupId, buttonId).then(() => {
    if (active === tab && !document.querySelector('dialog:modal')) tab.term.focus();
  }));
}, () => { nextKey(); restoreTerminalFocus(); });
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
for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-shell]')) {
  button.onclick = () => safe(openTab(localProfile.parse({ kind: 'local', shell: button.dataset.shell,
    name: button.dataset.shell === 'powershell' ? localDefaults.name : button.textContent })));
}
find('#split-side').onclick = () => chooseSplit('side');
find('#split-stack').onclick = () => chooseSplit('stack');
function closeSplit() {
  split = undefined;
  delete surfaces.dataset.split;
  if (active) focusTab(active);
}
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
for (const dialog of document.querySelectorAll('dialog:not(#ai-dialog)')) {
  dialog.addEventListener('close', () => { nextKey(); restoreTerminalFocus(); });
}
renderPanes();
find('#new-profile').onclick = () => openConnect('serial', 'save');
find('#all-logs').onclick = () => safe(api.showLogs());
find('#settings').onclick = () => showSettings();
find('#settings-terminal-tab').onclick = () => selectSettings(false);
find('#settings-ai-tab').onclick = () => selectSettings(true);
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
