export function bindSavedSecret(container: HTMLElement, reveal: () => Promise<string>, reportError: (error: unknown) => void) {
  const value = container.querySelector<HTMLElement>('output')!;
  const button = container.querySelector<HTMLButtonElement>('button')!;
  let revision = 0;
  let visible = false;

  function reset(saved = !container.hidden) {
    revision++;
    visible = false;
    container.hidden = !saved;
    value.textContent = saved ? '••••••••' : '';
    button.textContent = '显示';
    button.ariaPressed = 'false';
    button.disabled = false;
  }
  button.onclick = async () => {
    if (visible) { reset(); return; }
    const attempt = ++revision;
    button.disabled = true;
    try {
      const secret = await reveal();
      if (attempt !== revision || container.hidden) return;
      value.textContent = secret;
      visible = true;
      button.textContent = '隐藏';
      button.ariaPressed = 'true';
    } catch (error) {
      if (attempt === revision) reportError(error);
    } finally {
      if (attempt === revision) button.disabled = false;
    }
  };
  return reset;
}
