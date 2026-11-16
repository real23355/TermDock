import { commandGroupsSchema, type CommandButton, type CommandGroup, type DesktopApi } from '../shared';

export function createCommandBar(
  api: Pick<DesktopApi, 'saveCommandGroups'>,
  send: (groupId: string, buttonId: string) => void,
  onDialogClose: () => void,
) {
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const groupSelect = find<HTMLSelectElement>('#command-group');
  const buttons = find<HTMLFieldSetElement>('#command-buttons');
  const buttonList = find('#command-button-list');
  const dialog = find<HTMLDialogElement>('#command-dialog');
  const editorSelect = find<HTMLSelectElement>('#edit-command-group');
  const editor = find<HTMLFieldSetElement>('#command-group-editor');
  const editorName = find<HTMLInputElement>('#command-group-name');
  const editorItems = find('#command-edit-items');
  const itemTemplate = find<HTMLTemplateElement>('#command-edit-template');
  const deleteGroup = find<HTMLButtonElement>('#delete-command-group');
  const errorBox = find('#command-form-error');
  const saveButton = find<HTMLButtonElement>('#save-command-groups');

  let groups: CommandGroup[] = [];
  let selectedId = '';
  let draft: CommandGroup[] = [];
  let editingId = '';

  function fillSelect(select: HTMLSelectElement, values: CommandGroup[], selected: string) {
    const group = values.find(group => group.id === selected) ?? values[0];
    const options = values.map(value => new Option(value.name || '未命名分组', value.id));
    select.replaceChildren(...(options.length ? options : [new Option('命令分组', '')]));
    select.disabled = !group;
    select.value = group?.id ?? '';
    return group;
  }

  function renderBar() {
    const group = fillSelect(groupSelect, groups, selectedId);
    selectedId = group?.id ?? '';
    const items = group ? group.buttons.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.name;
      button.title = `${item.name}\n${item.command}`;
      button.onclick = () => send(group.id, item.id);
      return button;
    }) : [];
    buttonList.replaceChildren(...items);
    buttonList.scrollTop = 0;
  }

  function renderEditor() {
    const group = fillSelect(editorSelect, draft, editingId);
    editingId = group?.id ?? '';
    editor.hidden = !group;
    deleteGroup.disabled = !group;
    editorName.value = group?.name ?? '';
    errorBox.hidden = true;
    const scroll = editorItems.scrollTop;
    const rows = group ? group.buttons.map((item, index) => {
      const row = itemTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
      const name = row.querySelector<HTMLInputElement>('[name=name]')!;
      const command = row.querySelector<HTMLInputElement>('[name=command]')!;
      const ending = row.querySelector<HTMLSelectElement>('[name=lineEnding]')!;
      name.value = item.name;
      command.value = item.command;
      ending.value = item.lineEnding;
      name.oninput = () => { item.name = name.value; };
      command.oninput = () => { item.command = command.value; };
      ending.onchange = () => { item.lineEnding = ending.value as CommandButton['lineEnding']; };
      row.querySelector('button')!.onclick = () => {
        group.buttons.splice(index, 1);
        renderEditor();
      };
      return row;
    }) : [];
    editorItems.replaceChildren(...rows);
    editorItems.scrollTop = scroll;
  }

  groupSelect.onchange = () => {
    selectedId = groupSelect.value;
    renderBar();
  };
  find('#manage-commands').onclick = () => {
    draft = structuredClone(groups);
    editingId = selectedId;
    renderEditor();
    dialog.showModal();
    if (!editingId) find('#add-command-group').focus();
  };
  dialog.addEventListener('close', onDialogClose);
  editorSelect.onchange = () => {
    editingId = editorSelect.value;
    editorItems.scrollTop = 0;
    renderEditor();
  };
  editorName.oninput = () => {
    const group = draft.find(group => group.id === editingId);
    if (!group) return;
    group.name = editorName.value;
    editorSelect.selectedOptions[0].textContent = group.name || '未命名分组';
  };
  find('#add-command-group').onclick = () => {
    editingId = crypto.randomUUID();
    draft.push({ id: editingId, name: '新分组', buttons: [] });
    renderEditor();
    editorName.focus();
    editorName.select();
  };
  deleteGroup.onclick = () => {
    draft = draft.filter(group => group.id !== editingId);
    renderEditor();
  };
  find('#add-command-button').onclick = () => {
    const group = draft.find(group => group.id === editingId);
    if (!group) return;
    group.buttons.push({ id: crypto.randomUUID(), name: '', command: '', lineEnding: 'CR' });
    renderEditor();
    editorItems.lastElementChild?.querySelector('input')?.focus();
  };
  find<HTMLFormElement>('#command-form').onsubmit = async event => {
    event.preventDefault();
    if (saveButton.disabled) return;
    const parsed = commandGroupsSchema.safeParse(draft);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const group = draft[Number(issue?.path[0])];
      if (group && group.id !== editingId) {
        editingId = group.id;
        renderEditor();
      }
      errorBox.textContent = issue?.message ?? '请检查命令按钮配置';
      errorBox.hidden = false;
      return;
    }
    saveButton.disabled = true;
    const selected = editingId;
    try {
      groups = await api.saveCommandGroups(parsed.data);
      selectedId = selected;
      renderBar();
      dialog.close();
    } catch (error) {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
      errorBox.hidden = false;
    } finally { saveButton.disabled = false; }
  };

  return {
    load(value: CommandGroup[]) {
      groups = value;
      renderBar();
    },
    setConnected(connected: boolean) { buttons.disabled = !connected; },
  };
}
