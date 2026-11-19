import type { AiAction, AiChoice, AiInteraction } from '../shared';

type Answer = string | string[] | boolean | null;

function stepText(step: AiAction) {
  switch (step.type) {
    case 'send': return `发送 ${step.text || '（空文本）'} <${step.lineEnding}> · 读取回显 ${step.waitMs} ms`;
    case 'waitPrompt': return `等待提示符 ${step.prompt} · 至多 ${step.waitMs} ms`;
    case 'wait': return `读取新输出 · 至多 ${step.waitMs} ms`;
    case 'delay': return `延时 ${step.waitMs} ms`;
  }
}

export function showAiInteraction(container: HTMLElement, interaction: AiInteraction,
  answer: (value: Answer) => Promise<void>, reportError: (error: unknown) => void) {
  const title = document.createElement('strong');
  title.textContent = interaction.kind === 'authorize' ? '请求串口写入授权' : '等待你的回答';
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = '×'; close.ariaLabel = '关闭确认窗口';
  const head = document.createElement('header'); head.append(title, close);
  const prompt = document.createElement('p'); prompt.textContent = interaction.prompt;
  const form = document.createElement('form');
  const actions = document.createElement('div'); actions.className = 'ai-interaction-actions';
  let busy = false;
  async function reply(value: Answer) {
    if (busy) return;
    busy = true;
    const controls = [...container.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')];
    for (const control of controls) control.disabled = true;
    try { await answer(value); }
    catch (error) {
      reportError(error);
      busy = false;
      for (const control of controls) control.disabled = false;
    }
  }
  function choiceButton(label: string, value: Answer) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label;
    button.onclick = () => { void reply(value); };
    return button;
  }
  close.onclick = () => { void reply(null); };
  if (interaction.kind === 'authorize') {
    const target = document.createElement('p'); target.textContent = `目标 ${interaction.target} · 仅限下面列出的本轮步骤`;
    const steps = document.createElement('ol');
    for (const step of interaction.steps) {
      const li = document.createElement('li'); li.textContent = stepText(step); steps.append(li);
    }
    form.append(target, steps);
    const allow = choiceButton('允许本次', true); allow.classList.add('primary');
    actions.append(choiceButton('不允许', false), allow);
  } else if (interaction.answerType === 'confirm') {
    actions.append(choiceButton('否', false), choiceButton('是', true));
  } else {
    const type = interaction.answerType;
    if (type === 'text') {
      const field = document.createElement('input');
      field.name = 'answer'; field.required = true; field.maxLength = 4000; field.ariaLabel = interaction.prompt;
      form.append(field);
    } else {
      const makeChoice = (choice: AiChoice) => {
        const label = document.createElement('label'); label.className = 'check';
        const input = document.createElement('input');
        input.name = 'answer'; input.type = type === 'multiple' ? 'checkbox' : 'radio'; input.value = choice.value;
        input.required = type !== 'multiple'; label.append(input, document.createTextNode(choice.label));
        return label;
      };
      form.append(...interaction.options.map(makeChoice));
    }
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '提交回答';
    actions.append(submit);
    form.onsubmit = event => {
      event.preventDefault();
      const values = new FormData(form).getAll('answer').map(String);
      if (values.length && values.some(value => value.trim())) void reply(type === 'multiple' ? values : values[0]);
      else reportError(new Error(type === 'text' ? '请输入回答' : '请选择至少一项'));
    };
  }
  form.append(actions);
  container.replaceChildren(head, prompt, form);
  container.hidden = false;
}
