import { aiDefaults, aiEffortSchema, aiPresets, type AiEffort, type AiMessage, type AiSettings, type AiSource } from '../shared';
import type { Bridge } from '../desktop-bridge';
import { bindSavedSecret } from './saved-secret';
import { showAiInteraction } from './ai-interaction';

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
  const effort = find<HTMLSelectElement>('#ai-effort');
  const divider = find('#ai-dock-divider');
  const interactionPanel = find('#ai-interaction');
  const phase = find('#ai-phase');
  const elapsed = find('#ai-elapsed');
  const retry = find<HTMLButtonElement>('#ai-retry');
  const readSelection = find<HTMLButtonElement>('#ai-read-selection');
  const selected = new Set<string>();
  const known = new Map<string, Pick<ReadablePane, 'id' | 'name' | 'endpoint' | 'position'>>();
  let initialized = false;
  let scopeChosen = false;
  let presentation: 'dock' | 'dialog' = 'dialog';
  let capturedSelection: { pane: ReadablePane; text: string } | undefined;
  let contextMode: 'viewport' | 'selection' = 'viewport';
  let contextKey = '';
  let operating = false;
  let sources: AiSource[] = [];
  let conversation: AiMessage[] = [];
  let requestId: string | undefined;
  let interactionId: string | undefined;
  let shownSources = '';
  let shownTargets = '';
  let startedAt = 0;
  let stopwatch: ReturnType<typeof setInterval> | undefined;
  const streaming: { message?: ReturnType<typeof bubble> } = {};
  let writingStarted = false;
  let retryQuestion: string | undefined;
  let settingsRequest: string | undefined;
  let settingsBusy = false;
  let settingsValue: AiSettings = { ...aiDefaults, models: aiPresets, keySaved: false, unsupportedEfforts: [] };
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': Error: /, '');

  function refreshSources() {
    const current = panes();
    for (const { id, name, endpoint, position } of current) known.set(id, { id, name, endpoint, position });
    if (panel.hidden) return;
    const ids = new Set(current.map(pane => pane.id));
    for (const id of known.keys()) if (!ids.has(id) && !selected.has(id)) known.delete(id);
    const show = [...known.values()];
    const sourceKey = JSON.stringify(show.map(pane => [pane.id, pane.name, pane.position, pane.endpoint, ids.has(pane.id), selected.has(pane.id)]));
    if (sourceKey !== shownSources) {
      shownSources = sourceKey;
      sourceList.replaceChildren(...show.map(pane => {
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
      if (!show.length) sourceList.textContent = '打开 SSH 或串口会话后，可在此选择日志来源。';
    }
    const oldTarget = target.value;
    const serials = current.filter(pane => pane.kind === 'serial' && pane.connected);
    const options = [new Option('选择已连接串口', ''), ...serials.map(pane => new Option(`${pane.name} · ${pane.endpoint}`, pane.id))];
    if (oldTarget && !serials.some(pane => pane.id === oldTarget)) {
      const missing = new Option(`${known.get(oldTarget)?.name ?? '原目标'}（已断开或关闭）`, oldTarget);
      missing.disabled = true;
      options.push(missing);
    }
    const targetKey = JSON.stringify(options.map(option => [option.value, option.text, option.disabled]));
    if (targetKey !== shownTargets) {
      shownTargets = targetKey;
      target.replaceChildren(...options);
      target.value = oldTarget;
    }
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
    divider.hidden = view !== 'dock';
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
    if (view === 'dock') resizeDock();
    void refreshConfig();
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
      copy.onclick = () => { void api.copy(content.textContent).then(() => { copy.textContent = '已复制'; }).catch(() => { status.textContent = '无法复制回复'; }); };
      row.append(copy);
    }
    messages.append(row);
    messages.scrollTop = messages.scrollHeight;
    return { row, content };
  }
  function setBusy(busy: boolean) {
    find<HTMLButtonElement>('#ai-send').disabled = find<HTMLButtonElement>('#ai-read').disabled = readSelection.disabled = busy;
    find('#ai-cancel').hidden = !busy;
    mode.disabled = target.disabled = find<HTMLButtonElement>('#ai-new-chat').disabled = busy;
  }
  function updateElapsed() {
    const seconds = Math.floor((performance.now() - startedAt) / 1000);
    elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function closeInteraction() {
    interactionPanel.hidden = true;
    interactionPanel.replaceChildren();
    interactionId = undefined;
  }
  function showPhase(value: string) { phase.textContent = value; }
  function resetStreamingMessage() { delete streaming.message; }
  async function ask(text: string, options: { refresh?: boolean; analyzeOnly?: boolean; fromForm?: boolean } = {}) {
    if (requestId) return;
    if (!text.trim()) { status.textContent = '请输入问题，或点击读取并分析。'; return; }
    const useSerial = !options.analyzeOnly && mode.value === 'serial';
    const targetId = useSerial ? target.value || undefined : undefined;
    const targetPane = panes().find(pane => pane.id === targetId && pane.kind === 'serial' && pane.connected);
    if (useSerial && ((targetId && !targetPane) || !panes().some(pane => pane.kind === 'serial' && pane.connected))) {
      status.textContent = '请先选择已连接的串口发送目标。';
      return;
    }
    const reasoning = aiEffortSchema.safeParse(effort.value);
    if (targetId) {
      selected.add(targetId);
      contextMode = 'viewport';
      refreshSources();
    }
    const id = crypto.randomUUID();
    requestId = id;
    operating = useSerial;
    writingStarted = false;
    resetStreamingMessage();
    retryQuestion = undefined;
    retry.hidden = true;
    if (options.fromForm) question.value = '';
    const input: AiMessage = { role: 'user', content: text.trim() };
    status.textContent = '';
    setBusy(true);
    startedAt = performance.now(); updateElapsed();
    stopwatch = setInterval(updateElapsed, 250);
    find('#ai-progress').hidden = false;
    showPhase('读取终端内容');
    const runTarget = find('#ai-run-target');
    runTarget.hidden = !useSerial;
    runTarget.textContent = targetPane ? `本轮目标 ${targetPane.name} · ${targetPane.endpoint}` : '本轮尚未选定串口';
    try {
      if (options.refresh !== false && contextMode === 'viewport') capture(false);
      bubble('user', input.content);
      const request = { id, sources, messages: [...conversation.slice(-38), input], effort: reasoning.data };
      showPhase('准备模型请求');
      const result = useSerial ? await api.aiAssist({ ...request, serialTargetId: targetId }) : undefined;
      const reply = result ? result.reply : await api.aiChat(request);
      conversation.push(input, { role: 'assistant', content: reply });
      if (streaming.message) streaming.message.content.textContent = reply;
      else bubble('assistant', reply);
      status.textContent = result ? `本轮结束：${result.writes} 次实际写入，${result.steps} 个动作${result.limited ? '，已到上限' : ''}。` : '';
    } catch (error) {
      const detail = errorText(error);
      status.textContent = detail;
      streaming.message?.row.classList.add('ai-incomplete');
      if (detail.includes('不支持所选思考挡位')) void refreshConfig();
      if (options.fromForm) {
        if (!question.value) question.value = input.content;
        // Never repeat a turn that may already have written bytes.
        if (!writingStarted) { retryQuestion = input.content; retry.hidden = false; }
      }
    } finally {
      closeInteraction();
      clearInterval(stopwatch);
      find('#ai-progress').hidden = true;
      requestId = undefined; operating = false; setBusy(false);
    }
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
  function captureSelection() {
    const pane = panes().find(item => item.id === activeId());
    const text = pane?.selection() ?? '';
    capturedSelection = pane && text.trim() ? { pane, text } : undefined;
    readSelection.hidden = !capturedSelection;
  }
  async function analyzeSelection() {
    if (requestId || !capturedSelection) return;
    const { pane, text } = capturedSelection;
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
    divider.hidden = true;
    panelSecret();
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
  let dockWidth = 345;
  const resizeDock = (width = dockWidth) => {
    const max = Math.max(240, Math.floor(dock.clientWidth * .55));
    panel.style.setProperty('--ai-dock-width', `${Math.min(max, Math.max(240, width))}px`);
    divider.setAttribute('aria-valuemin', '240');
    divider.setAttribute('aria-valuemax', String(max));
    divider.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
  };
  divider.onpointerdown = event => {
    if (event.button !== 0) return;
    divider.setPointerCapture(event.pointerId); event.preventDefault();
  };
  divider.onpointermove = event => {
    if (divider.hasPointerCapture(event.pointerId)) {
      dockWidth = Math.round(dock.getBoundingClientRect().right - event.clientX);
      resizeDock();
    }
  };
  divider.onkeydown = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    dockWidth = panel.offsetWidth + (event.key === 'ArrowLeft' ? 24 : -24);
    resizeDock();
  };
  new ResizeObserver(() => { if (!divider.hidden) resizeDock(); }).observe(dock);
  find('#ai-use-screen').onclick = () => { contextMode = 'viewport'; capture(true); };
  find('#ai-new-chat').onclick = () => {
    if (requestId) return;
    sources = []; conversation = []; contextKey = ''; contextMode = 'viewport';
    mode.value = 'chat'; mode.dispatchEvent(new Event('change')); question.value = '';
    effort.value = ''; retry.hidden = true; retryQuestion = undefined;
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
    if (event.type === 'ai-model' && requestId && event.id === requestId) {
      showPhase(({ waiting: '等待模型响应', thinking: '模型思考中', reply: '生成回复中' })[event.phase]);
      if (event.chunk) {
        streaming.message ??= bubble('assistant', '');
        streaming.message.content.append(document.createTextNode(event.chunk));
        messages.scrollTop = messages.scrollHeight;
      }
      return;
    }
    if (event.type !== 'ai-progress' || event.runId !== requestId) return;
    const pane = panes().find(item => item.id === event.id);
    if (pane?.kind === 'serial') find('#ai-run-target').textContent = `本轮目标 ${pane.name} · ${pane.endpoint}`;
    status.textContent = event.detail;
    if (event.phase === 'waiting-user' && event.interaction) {
      const prompt = event.interaction;
      if (prompt.kind === 'authorize') find('#ai-run-target').textContent = `本轮目标 ${prompt.target}`;
      interactionId = prompt.id;
      showPhase('等待你的回答');
      showAiInteraction(interactionPanel, prompt, async answer => {
        await api.answerAi(event.runId, prompt.id, answer);
        if (interactionId === prompt.id) closeInteraction();
      }, error => { status.textContent = errorText(error); });
      return;
    }
    if (event.phase === 'planning') showPhase('规划串口操作');
    if (event.phase === 'sending' && event.action) {
      showPhase(`串口执行 · 第 ${event.step} 步`);
      if (event.action.type === 'send') writingStarted = true;
      bubble('action', `第 ${event.step} 步 · ${event.detail}`);
    }
    if (event.phase === 'written') bubble('action', `第 ${event.step} 步 · 串口已确认写入，仍需回显确认执行结果`);
    if (event.phase === 'observed' && event.observation) bubble('action', `第 ${event.step} 步 · ${event.detail}${event.observation.truncated ? '，显示前 64 KiB' : ''}\n${event.observation.text || '（无新输出）'}`);
  });
  find('#ai-configure').onclick = openSettings;
  find('#ai-read').onclick = () => { void read(); };
  readSelection.onclick = () => { void analyzeSelection(); };
  find('#ai-cancel').onclick = () => { if (requestId) void api.cancelAi(requestId).catch(error => { status.textContent = errorText(error); }); };
  retry.onclick = () => { if (retryQuestion) void ask(question.value.trim() || retryQuestion, { fromForm: true }); };
  find<HTMLFormElement>('#ai-chat-form').onsubmit = event => {
    event.preventDefault();
    if (!question.value.trim() || requestId) return;
    void ask(question.value, { fromForm: true });
  };
  let composing = false;
  question.addEventListener('compositionstart', () => { composing = true; });
  question.addEventListener('compositionend', () => { composing = false; });
  question.onkeydown = event => {
    if (event.key !== 'Enter' || event.isComposing || composing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.altKey) question.setRangeText('\n', question.selectionStart, question.selectionEnd, 'end');
    else find<HTMLFormElement>('#ai-chat-form').requestSubmit();
  };

  const keyInput = find<HTMLInputElement>('#ai-key');
  const modelInput = find<HTMLSelectElement>('#ai-model');
  const settingsStatus = find('#ai-settings-status');
  const keyStatus = find('#ai-key-status');
  const settingsForm = find<HTMLFormElement>('#ai-settings-form');
  const settingsSecret = bindSavedSecret(find('#ai-settings-key-secret'), api.revealAiKey, error => { settingsStatus.textContent = errorText(error); });
  const panelSecret = bindSavedSecret(find('#ai-panel-key-secret'), api.revealAiKey, error => { status.textContent = errorText(error); });
  let configRevision = 0;
  function settingsWorking(busy: boolean) {
    settingsBusy = busy;
    for (const input of settingsForm.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) input.disabled = busy;
  }
  function displayConfig(value: AiSettings) {
    settingsValue = value;
    const label = find('#ai-current-model');
    label.textContent = value.model;
    label.title = value.model;
    find('#ai-current-key-status').textContent = value.keyError ? 'Key 读取失败' : value.keySaved ? 'Key 已保存' : '尚未保存 API Key';
    panelSecret(value.keySaved && !panel.hidden);
    for (const option of effort.options) {
      option.disabled = value.unsupportedEfforts.includes(option.value as AiEffort);
      option.title = option.disabled ? '当前模型不支持此挡位' : '';
    }
    effort.title = value.unsupportedEfforts.length ? '不可选挡位由当前模型的接口明确拒绝' : '';
    if (effort.selectedOptions[0]?.disabled) effort.value = '';
  }
  async function refreshConfig() {
    const revision = ++configRevision;
    try {
      const value = await api.aiSettings();
      if (revision === configRevision) displayConfig(value);
    } catch (error) {
      if (revision === configRevision && !panel.hidden) find('#ai-current-key-status').textContent = errorText(error);
    }
  }
  function displayModels(value: AiSettings) {
    modelInput.replaceChildren(...value.models.map(model => new Option(model, model)));
    modelInput.value = value.model;
  }
  function displaySettings(value: AiSettings, clearInput = true) {
    configRevision++;
    displayConfig(value);
    displayModels(value);
    if (clearInput) keyInput.value = '';
    settingsSecret(value.keySaved);
    keyStatus.textContent = value.keyError ? '凭据读取失败，可重新保存或清除' : value.keySaved ? '已保存（由当前 Windows 用户保护）' : '尚未保存 API Key';
  }
  async function loadSettings() {
    keyInput.value = '';
    settingsStatus.textContent = '读取配置…';
    settingsWorking(true);
    try { const value = await api.aiSettings(); displaySettings(value); settingsStatus.textContent = value.keyError ?? ''; }
    catch (error) {
      // Preserve the model display even when the key is corrupt, so it can be replaced or cleared.
      displayModels(settingsValue);
      keyStatus.textContent = '凭据读取失败，可重新保存或清除';
      settingsStatus.textContent = errorText(error);
    } finally { settingsWorking(false); }
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
  const newModel = find<HTMLInputElement>('#ai-model-new');
  const newModelRow = find('#ai-model-new-row');
  find('#ai-model-add').onclick = () => { newModelRow.hidden = false; newModel.focus(); };
  find('#ai-model-confirm').onclick = async () => {
    if (settingsBusy) return;
    settingsWorking(true);
    try {
      displaySettings(await api.addAiModel(newModel.value), false);
      newModel.value = ''; newModelRow.hidden = true;
      settingsStatus.textContent = '模型已保存并选中';
    } catch (error) { settingsStatus.textContent = errorText(error); }
    finally { settingsWorking(false); }
  };
  newModel.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); find('#ai-model-confirm').click();
    }
  };
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
  function clearSettings() {
    keyInput.value = '';
    settingsSecret(); panelSecret();
    newModel.value = ''; newModelRow.hidden = true;
    if (settingsRequest) void api.cancelAi(settingsRequest).catch(() => {});
  }
  find<HTMLDialogElement>('#settings-dialog').addEventListener('close', clearSettings);
  return { open, refreshSources, captureSelection, loadSettings, clearSettings };
}
