export function bindWorkflow(form: HTMLFormElement) {
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const steps = form.querySelector<HTMLFieldSetElement>('.workflow-steps')!;
  const list = form.querySelector<HTMLOListElement>('.workflow-list')!;
  const login = form.querySelector<HTMLFieldSetElement>('.workflow-login')!;
  const add = form.querySelector<HTMLButtonElement>('.add-step')!;
  const command = form.querySelector<HTMLElement>('.legacy-timer-command')!;
  const rows = () => Array.from(list.children) as HTMLLIElement[];
  function renumber() {
    for (const [index, row] of rows().entries()) {
      row.querySelector('strong')!.textContent = String(index + 1).padStart(2, '0');
      row.querySelector<HTMLButtonElement>('[data-step=up]')!.disabled = index === 0;
      row.querySelector<HTMLButtonElement>('[data-step=down]')!.disabled = index === list.children.length - 1;
      row.querySelector<HTMLButtonElement>('[data-step=remove]')!.disabled = list.children.length === 1;
    }
    add.disabled = list.children.length >= 40;
  }
  function append() {
    const row = document.createElement('li');
    row.innerHTML = `
      <div class="step-actions"><strong></strong>
        <button type="button" data-step="up" aria-label="上移步骤">↑</button>
        <button type="button" data-step="down" aria-label="下移步骤">↓</button>
        <button type="button" data-step="remove" aria-label="删除步骤">×</button>
      </div>
      <label>步骤类型<select class="step-type"><option value="send">发送命令</option><option value="wait">等待时间</option><option value="login">等待 login 并自动登录</option></select></label>
      <fieldset class="step-send">
        <label>命令<input class="step-command" maxlength="1024" required spellcheck="false"></label>
        <label>行尾<select class="step-ending"><option>CR</option><option>LF</option><option>CRLF</option><option value="none">无</option></select></label>
      </fieldset>
      <fieldset class="step-wait" hidden disabled>
        <label>时长<input class="step-time" type="number" min="0.001" step="any" value="1" required></label>
        <label>单位<select class="step-unit"><option value="ms">毫秒 (ms)</option><option value="s">秒 (s)</option></select></label>
      </fieldset>`;
    const type = row.querySelector<HTMLSelectElement>('.step-type')!;
    const send = row.querySelector<HTMLFieldSetElement>('.step-send')!;
    const wait = row.querySelector<HTMLFieldSetElement>('.step-wait')!;
    type.onchange = () => {
      send.hidden = send.disabled = type.value !== 'send';
      wait.hidden = wait.disabled = type.value !== 'wait';
    };
    row.querySelector<HTMLButtonElement>('[data-step=up]')!.onclick = () => {
      if (row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
      renumber();
    };
    row.querySelector<HTMLButtonElement>('[data-step=down]')!.onclick = () => {
      if (row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
      renumber();
    };
    row.querySelector<HTMLButtonElement>('[data-step=remove]')!.onclick = () => { row.remove(); renumber(); };
    list.append(row);
    renumber();
    return row;
  }
  field('workflowMode').onchange = () => {
    const useSteps = field('workflowMode').value === 'steps';
    steps.hidden = steps.disabled = !useSteps;
    command.hidden = field('command').disabled = useSteps;
    if (useSteps && !list.children.length) {
      const row = append();
      row.querySelector<HTMLInputElement>('.step-command')!.value = field('command').value || 'reboot';
      row.querySelector<HTMLSelectElement>('.step-ending')!.value = field('lineEnding').value;
    }
  };
  field('loginEnabled').onchange = () => {
    login.hidden = login.disabled = !field('loginEnabled').checked;
    if (login.hidden) field('loginPassword').value = '';
  };
  add.onclick = () => append().querySelector('select')!.focus();
  return {
    options() {
      if (steps.disabled) return {};
      return {
        steps: rows().map(row => {
          const value = (selector: string) => row.querySelector<HTMLInputElement>(selector)!.value;
          const type = value('.step-type');
          if (type === 'send') return { type, command: value('.step-command'), lineEnding: value('.step-ending') };
          if (type === 'wait') {
            const milliseconds = Number(value('.step-time')) * (value('.step-unit') === 's' ? 1000 : 1);
            // Account for floating point multiplication but require whole milliseconds.
            const exact = Math.round(milliseconds);
            if (Math.abs(milliseconds - exact) > 1e-7 || exact < 1) throw new Error('等待时间必须是整数毫秒，最少 1 ms');
            return { type, milliseconds: exact };
          }
          return { type };
        }),
        login: field('loginEnabled').checked ? {
          username: field('loginUsername').value, password: field('loginPassword').value,
          loginPrompt: field('loginPrompt').value, passwordPrompt: field('passwordPrompt').value,
          timeoutSeconds: Number(field('loginTimeout').value),
        } : undefined,
      };
    },
    clearSecret() { field('loginPassword').value = ''; },
  };
}
