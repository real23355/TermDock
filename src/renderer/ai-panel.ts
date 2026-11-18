import { aiDefaults, type AiMessage, type AiSettings, type AiSource } from '../shared';
import type { Bridge } from '../desktop-bridge';

export type ReadablePane = {
  id: string; name: string; endpoint: string; position: string; kind: 'ssh' | 'serial'; connected: boolean;
  read: () => string; selection: () => string;
};
export function createAiPanel(api: Bridge, panes: () => ReadablePane[], activeId: () => string | undefined,
  openSettings: () => void, restoreFocus: () => void) {
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const panel = find('#ai-panel');
  const sourceList = find('#ai-sources');
  const question = find<HTMLTextAreaElement>('#ai-question');
  const status = find('#ai-status');
  const messages = find('#ai-messages');
  const aiDialog = find<HTMLDialogElement>('#ai-dialog');
  const dock = panel.parentElement!;
  const mode = find<HTMLSelectElement>('#ai-mode');
  const target = find<HTMLSelectElement>('#ai-serial-target');
  const selected = new Set<string>();
  const known = new Map<string, Pick<ReadablePane, 'id' | 'name' | 'endpoint' | 'position'>>();
  let initialized = false;
  let scopeChosen = false;
  let presentation: 'dock' | 'dialog' = 'dock';
  let contextMode: 'viewport' | 'selection' = 'viewport';
  let contextKey = '';
  let operating = false;
  let sources: AiSource[] = [];
  let conversation: AiMessage[] = [];
  let requestId: string | undefined;
  let settingsRequest: string | undefined;
  let settingsBusy = false;
  let settingsValue: AiSettings = { ...aiDefaults, keySaved: false };
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': Error: /, '');

  function refreshSources() {
    const current = panes();
    for (const { id, name, endpoint, position } of current) known.set(id, { id, name, endpoint, position });
    if (panel.hidden) return;
    const ids = new Set(current.map(pane => pane.id));
    for (const id of known.keys()) if (!ids.has(id) && !selected.has(id)) known.delete(id);
    sourceList.replaceChildren(...[...known.values()].map(pane => {
      const label = document.createElement('label');
      label.className = 'check ai-source';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.sourceId = pane.id;
      check.checked = selected.has(pane.id);
      check.onchange = () => { check.checked ? selected.add(pane.id) : selected.delete(pane.id); };
      check.addEventListener('change', () => { scopeChosen = true; contextMode = 'viewport'; find('#ai-use-screen').hidden = true; });
      const text = document.createElement('span');
      text.textContent = `${pane.name} · ${pane.position} · ${pane.endpoint}${ids.has(pane.id) ? '' : '（已关闭）'}`;
      label.title = text.textContent;
      label.append(check, text);
      return label;
    }));
    if (!known.size) sourceList.textContent = '打开 SSH 或串口会话后，可在此选择日志来源。';
    const oldTarget = target.value;
    const serials = current.filter(pane => pane.kind === 'serial' && pane.connected);
    const options = [new Option('选择已连接串口', ''), ...serials.map(pane => new Option(`${pane.name} · ${pane.endpoint}`, pane.id))];
    if (oldTarget && !serials.some(pane => pane.id === oldTarget)) {
      const missing = new Option(`${known.get(oldTarget)?.name ?? '原目标'}（已断开或关闭）`, oldTarget);
      missing.disabled = true;
      options.push(missing);
    }
    target.replaceChildren(...options);
    target.value = oldTarget;
  }
  function open(view: 'dock' | 'dialog' = presentation) {
    panel.hidden = false;
    if (!initialized) {
      initialized = true;
      const id = activeId();
      if (panes().some(pane => pane.id === id)) selected.add(id!);
      if (panes().some(pane => pane.id === id && pane.kind === 'serial' && pane.connected)) {
        target.append(new Option('', id)); target.value = id!;
      }
    }
    if (!scopeChosen && !selected.size) {
      const id = activeId();
      if (panes().some(pane => pane.id === id)) selected.add(id!);
    }
    presentation = view;
    if (view === 'dialog') {
      aiDialog.append(panel);
      if (!aiDialog.open) aiDialog.show();
    } else {
      dock.append(panel);
      if (aiDialog.open) aiDialog.close();
    }
    find('#ai-popout').textContent = view === 'dialog' ? '停靠' : '弹出';
    find('#ai-popout').title = view === 'dialog' ? '停靠到右侧' : '弹出对话框';
    refreshSources();
    question.focus();
  }
  function bubble(role: 'user' | 'assistant' | 'context' | 'action', text: string) {
    const row = document.createElement('article');
    row.className = 'ai-message ai-' + role;
    const title = document.createElement('strong');
    title.textContent = role === 'user' ? '你' : role === 'assistant' ? 'AI' : role === 'action' ? '执行记录' : '本次读取';
    const content = document.createElement('div');
    content.textContent = text;
    row.append(title, content);
    if (role === 'assistant') {
      const copy = document.createElement('button');
      copy.textContent = '复制';
      copy.onclick = () => { void api.copy(text).then(() => { copy.textContent = '已复制'; }).catch(() => { status.textContent = '无法复制回复'; }); };
      row.append(copy);
    }
    messages.append(row);
    messages.scrollTop = messages.scrollHeight;
  }
  function setBusy(busy: boolean) {
    find<HTMLButtonElement>('#ai-send').disabled = find<HTMLButtonElement>('#ai-read').disabled = busy;
    find('#ai-cancel').hidden = !busy;
    mode.disabled = target.disabled = find<HTMLButtonElement>('#ai-new-chat').disabled = busy;
  }
  async function ask(text: string, options: { refresh?: boolean; analyzeOnly?: boolean; fromForm?: boolean } = {}) {
    if (requestId) return;
    if (!text.trim()) { status.textContent = '请输入问题，或点击读取并分析。'; return; }
    const targetId = !options.analyzeOnly && mode.value === 'serial' ? target.value : undefined;
    const targetPane = panes().find(pane => pane.id === targetId && pane.kind === 'serial' && pane.connected);
    if (mode.value === 'serial' && !options.analyzeOnly && !targetPane) { status.textContent = '请先选择已连接的串口发送目标。'; return; }
    if (targetId) {
      selected.add(targetId);
      contextMode = 'viewport';
      refreshSources();
    }
    if (options.refresh !== false && contextMode === 'viewport') capture(false);
    const id = crypto.randomUUID();
    requestId = id;
    operating = !!targetId;
    if (options.fromForm) question.value = '';
    const input: AiMessage = { role: 'user', content: text.trim() };
    bubble('user', input.content);
    status.textContent = '正在等待 AI 回复… 终端可继续使用。';
    setBusy(true);
    const runTarget = find('#ai-run-target');
    runTarget.hidden = !targetId;
    runTarget.textContent = targetPane ? `本轮固定目标：${targetPane.name} · ${targetPane.endpoint}` : '';
    try {
      const request = { id, sources, messages: [...conversation.slice(-38), input] };
      const result = targetId ? await api.aiAssist({ ...request, serialTargetId: targetId }) : undefined;
      const reply = result ? result.reply : await api.aiChat(request);
      conversation.push(input, { role: 'assistant', content: reply });
      bubble('assistant', reply);
      status.textContent = result ? `本轮结束：${result.writes} 次实际写入，${result.steps} 个动作${result.limited ? '，已到上限' : ''}。` : '';
    } catch (error) { status.textContent = errorText(error); }
    finally { requestId = undefined; operating = false; setBusy(false); }
  }
  function useSources(next: AiSource[], summary: string, reset = true) {
    sources = next;
    // New reads replace inference context. Old logs remain visible in the UI only.
    if (reset) conversation = [];
    find('#ai-context').textContent = summary;
    bubble('context', summary);
  }
  function capture(reset: boolean) {
    const current = new Map(panes().map(pane => [pane.id, pane]));
    const readAt = new Date().toISOString();
    const next: AiSource[] = [];
    const states: string[] = [];
    // Synchronous reads share a timestamp and never change the active tab or buffer.
    for (const id of selected) {
      const pane = current.get(id);
      const name = known.get(id)?.name ?? id;
      if (!pane) { states.push(`${name}：已关闭，已跳过`); continue; }
      const text = pane.read();
      if (!text.trim()) { states.push(`${name}：当前视口为空，已跳过`); continue; }
      next.push({ id, name: pane.name, endpoint: pane.endpoint, position: pane.position, readAt, text });
      states.push(`${pane.name} · ${pane.position} · ${pane.endpoint}`);
    }
    const key = 'viewport:' + [...selected].sort().join(',');
    useSources(next, new Date(readAt).toLocaleString() + '\n' + (states.join('\n') || '未附加终端内容，可直接对话'), reset || key !== contextKey || (!next.length && !!selected.size));
    contextKey = key;
    find('#ai-use-screen').hidden = true;
    return next.length > 0;
  }
  async function read() {
    if (requestId) return;
    contextMode = 'viewport';
    if (!capture(true)) { status.textContent = '请选择有内容的 SSH 或串口窗格。' + find('#ai-context').textContent; return; }
    await ask('请分析本批日志：最后确认到达什么阶段，有哪些关键报错？引用各来源的证据原文，区分事实和推测，并给出建议检查项。', { refresh: false, analyzeOnly: true });
  }
  async function analyzeSelection(pane: ReadablePane | undefined, text: string) {
    open();
    if (requestId) { status.textContent = '请先等待或取消当前请求。'; return; }
    if (!pane || !text.trim()) { status.textContent = '请先在 SSH 或串口终端划选日志。'; return; }
    const readAt = new Date().toISOString();
    contextMode = 'selection'; contextKey = 'selection:' + pane.id;
    useSources([{ id: pane.id, name: pane.name, endpoint: pane.endpoint, position: '选中日志', readAt, text }],
      `${new Date(readAt).toLocaleString()}\n选中日志 · ${pane.name} · ${pane.endpoint}`);
    find('#ai-use-screen').hidden = false;
    await ask('请分析这段选中日志，引用对应来源的证据原文，说明最后确认阶段、关键报错、事实与推测及建议检查项。', { refresh: false, analyzeOnly: true });
  }
  function hide() {
    if (operating && requestId) void api.cancelAi(requestId).catch(error => { status.textContent = errorText(error); });
    panel.hidden = true;
    if (aiDialog.open) aiDialog.close();
    restoreFocus();
  }
  find('#ai-collapse').onclick = hide;
  aiDialog.addEventListener('close', () => { if (presentation === 'dialog') hide(); });
  aiDialog.addEventListener('cancel', event => { event.preventDefault(); hide(); });
  find('#ai-popout').onclick = () => open(presentation === 'dock' ? 'dialog' : 'dock');
  const heading = find('.ai-heading');
  let drag: { x: number; y: number; left: number; top: number } | undefined;
  function position(left: number, top: number) {
    aiDialog.style.margin = '0'; aiDialog.style.right = aiDialog.style.bottom = 'auto';
    aiDialog.style.left = Math.max(0, Math.min(left, innerWidth - aiDialog.offsetWidth)) + 'px';
    aiDialog.style.top = Math.max(0, Math.min(top, innerHeight - aiDialog.offsetHeight)) + 'px';
  }
  heading.onpointerdown = event => {
    if (presentation !== 'dialog' || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const rect = aiDialog.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    heading.setPointerCapture(event.pointerId); event.preventDefault();
  };
  heading.onpointermove = event => { if (drag) position(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y); };
  heading.onpointerup = heading.onpointercancel = () => { drag = undefined; };
  window.addEventListener('resize', () => {
    if (aiDialog.open && aiDialog.style.left) { const rect = aiDialog.getBoundingClientRect(); position(rect.left, rect.top); }
  });
  find('#ai-use-screen').onclick = () => { contextMode = 'viewport'; capture(true); };
  find('#ai-new-chat').onclick = () => {
    if (requestId) return;
    sources = []; conversation = []; contextKey = ''; contextMode = 'viewport';
    mode.value = 'chat'; mode.dispatchEvent(new Event('change')); question.value = '';
    messages.replaceChildren(); status.textContent = ''; find('#ai-context').textContent = '发送问题时读取所选终端当前内容';
    find('#ai-run-target').hidden = find('#ai-use-screen').hidden = true;
    question.focus();
  };
  mode.onchange = () => {
    const automatic = mode.value === 'serial';
    find('#ai-target-row').hidden = !automatic;
    find('#ai-send').textContent = automatic ? '发送并执行' : '发送';
    find('#ai-operation-hint').textContent = automatic ? '本轮最多 6 个动作；发送后读取新回显再继续。手动输入、断线或停止会结束本轮。' : '可直接提问，会附带所选 SSH / 串口内容。';
  };
  api.onSession(event => {
    if (event.type !== 'ai-progress' || event.runId !== requestId) return;
    status.textContent = event.detail;
    if (event.phase === 'sending' && event.action) bubble('action', `第 ${event.step} 步 · ${event.detail}\n${event.action.type === 'send' ? `准备发送：${event.action.text || '（空文本）'} <${event.action.lineEnding}>` : '仅等待新回显，不发送字符'}`);
    if (event.phase === 'written') bubble('action', `第 ${event.step} 步 · 串口已确认写入，仍需回显确认执行结果`);
    if (event.phase === 'observed' && event.observation) bubble('action', `第 ${event.step} 步 · ${event.detail}${event.observation.truncated ? '，显示前 64 KiB' : ''}\n${event.observation.text || '（无新输出）'}`);
  });
  find('#ai-configure').onclick = openSettings;
  find('#ai-read').onclick = () => { void read(); };
  find('#ai-cancel').onclick = () => { if (requestId) void api.cancelAi(requestId).catch(error => { status.textContent = errorText(error); }); };
  find<HTMLFormElement>('#ai-chat-form').onsubmit = event => {
    event.preventDefault();
    if (!question.value.trim() || requestId) return;
    void ask(question.value, { fromForm: true });
  };
  question.onkeydown = event => {
    if (event.key === 'Enter' && event.ctrlKey && !event.isComposing) { event.preventDefault(); find<HTMLFormElement>('#ai-chat-form').requestSubmit(); }
  };

  const keyInput = find<HTMLInputElement>('#ai-key');
  const modelInput = find<HTMLInputElement>('#ai-model');
  const settingsStatus = find('#ai-settings-status');
  const keyStatus = find('#ai-key-status');
  const settingsForm = find<HTMLFormElement>('#ai-settings-form');
  function settingsWorking(busy: boolean) {
    settingsBusy = busy;
    for (const input of settingsForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) input.disabled = busy;
  }
  function displaySettings(value: AiSettings) {
    settingsValue = value;
    modelInput.value = value.model;
    keyInput.value = '';
    keyStatus.textContent = value.keyError ? '凭据读取失败，可重新保存或清除' : value.keySaved ? '已保存（由当前 Windows 用户保护）' : '尚未保存 API Key';
  }
  async function loadSettings() {
    keyInput.value = '';
    settingsStatus.textContent = '读取配置…';
    try { const value = await api.aiSettings(); displaySettings(value); settingsStatus.textContent = value.keyError ?? ''; }
    catch (error) {
      // Preserve the model display even when the key is corrupt, so it can be replaced or cleared.
      modelInput.value = settingsValue.model;
      keyStatus.textContent = '凭据读取失败，可重新保存或清除';
      settingsStatus.textContent = errorText(error);
    }
  }
  async function save(clear = false) {
    if (settingsBusy) return;
    settingsWorking(true);
    settingsStatus.textContent = '正在保存…';
    try {
      displaySettings(await api.saveAiSettings({ model: modelInput.value, ...(clear ? { clear: true } : keyInput.value.trim() ? { key: keyInput.value.trim() } : {}) }));
      settingsStatus.textContent = clear ? 'API Key 已清除' : '配置已保存';
    } catch (error) { settingsStatus.textContent = errorText(error); }
    finally { settingsWorking(false); }
  }
  settingsForm.onsubmit = event => { event.preventDefault(); void save(); };
  find('#ai-clear-key').onclick = () => { void save(true); };
  find('#ai-test').onclick = async () => {
    if (settingsBusy) return;
    const id = crypto.randomUUID();
    settingsRequest = id;
    settingsWorking(true);
    settingsStatus.textContent = '测试连接中…';
    try {
      const reply = await api.testAi({ id, model: modelInput.value, ...(keyInput.value.trim() ? { key: keyInput.value.trim() } : {}) });
      settingsStatus.textContent = '调用成功：' + reply;
    } catch (error) { settingsStatus.textContent = errorText(error); }
    finally { settingsWorking(false); settingsRequest = undefined; }
  };
  find<HTMLDialogElement>('#settings-dialog').addEventListener('close', () => {
    keyInput.value = '';
    if (settingsRequest) void api.cancelAi(settingsRequest).catch(() => {});
  });
  return { open, refreshSources, analyzeSelection, loadSettings };
}
