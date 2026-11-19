import type { AiModelEvent } from '../shared';

type Progress = (phase: AiModelEvent['phase'], chunk?: string) => void;
const responseLimit = 2 * 1024 * 1024;

async function* readResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > responseLimit) throw new Error('AI 响应过长，请缩小分析范围');
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function responseText(response: Response) {
  let text = '';
  for await (const part of readResponse(response)) text += part;
  return text;
}

export async function completionContent(response: Response, progress?: Progress, showChunks = false) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    const text = await responseText(response);
    if (!text.trim()) return '';
    let content: unknown;
    try { content = JSON.parse(text)?.choices?.[0]?.message?.content; }
    catch { throw new Error('AI 响应格式无效，未收到 Chat Completions JSON'); }
    if (typeof content !== 'string') return '';
    if (content.trim()) progress?.('reply');
    return content.trim();
  }

  let buffer = '';
  let data: string[] = [];
  let reply = '';
  let chunk = '';
  let phase: AiModelEvent['phase'] = 'waiting';
  let lastUpdate = 0;
  let done = false;
  function flush() {
    if (chunk) progress?.('reply', showChunks ? chunk : undefined);
    chunk = '';
    lastUpdate = Date.now();
  }
  function readEvent() {
    const text = data.join('\n').trim();
    data = [];
    if (!text) return;
    if (text === '[DONE]') { done = true; return; }
    let value;
    try { value = JSON.parse(text); }
    catch { throw new Error('AI 流式响应格式无效'); }
    if (value?.error) throw new Error('AI 服务在流式回复中返回错误，请重试');
    const delta = value?.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      const first = phase !== 'reply';
      phase = 'reply';
      reply += delta.content;
      chunk += delta.content;
      if (first || Date.now() - lastUpdate >= 40 || chunk.length >= 4096) flush();
    } else if (phase === 'waiting' && (delta.reasoning_content || delta.reasoning || delta.reasoning_details?.length)) {
      phase = 'thinking';
      progress?.('thinking');
    }
  }
  function readLine(line: string) {
    if (!line) readEvent();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  for await (const part of readResponse(response)) {
    buffer += part;
    let newline;
    while (!done && (newline = buffer.indexOf('\n')) !== -1) {
      readLine(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
    }
    if (done) break;
    flush();
  }
  if (!done) {
    if (buffer) readLine(buffer.replace(/\r$/, ''));
    readEvent();
  }
  flush();
  return reply.trim();
}
