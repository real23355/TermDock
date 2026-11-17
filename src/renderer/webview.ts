import { desktopBridge } from '../desktop-bridge';
import type { SessionEvent } from '../shared';

type WireEvent = Exclude<SessionEvent, { type: 'output' }> |
  (Omit<Extract<SessionEvent, { type: 'output' }>, 'data'> & { data: string });
type HostReply = { kind: 'reply'; id: number; ok: boolean; value?: unknown; error?: string };
type HostPacket = HostReply | { kind: 'event'; event: WireEvent } | { kind: 'closed'; error: string };
type WebView = {
  postMessage(packet: object): void;
  postMessageWithAdditionalObjects(packet: object, files: File[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent<HostPacket>) => void): void;
};

export function connectWebView() {
  const webview = (window as unknown as { chrome?: { webview?: WebView } }).chrome?.webview;
  if (!webview) throw new Error('TermDock 需要 WebView2');
  document.documentElement.classList.add('native-window');
  let sequence = 0;
  let closed: string | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(event: SessionEvent) => void>();
  const sessions = new Set<string>();

  webview.addEventListener('message', ({ data }) => {
    if (data.kind === 'reply') {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.ok) request.resolve(data.value);
      else request.reject(new Error(data.error ?? '后台请求失败'));
    } else if (data.kind === 'event') {
      const event = data.event;
      if (event.type === 'connection') {
        if (event.state === 'disconnected') sessions.delete(event.id);
        else sessions.add(event.id);
      }
      const payload: SessionEvent = event.type === 'output' ?
        { ...event, data: Uint8Array.from(atob(event.data), character => character.charCodeAt(0)) } : event;
      for (const listener of listeners) listener(payload);
    } else if (data.kind === 'closed') {
      closed = data.error;
      for (const request of pending.values()) request.reject(new Error(closed));
      pending.clear();
      for (const id of sessions) for (const listener of listeners) {
        listener({ id, type: 'connection', state: 'disconnected', detail: closed });
      }
      sessions.clear();
    }
  });

  function request<T>(name: string, args: unknown[], files?: File[]) {
    return new Promise<T>((resolve, reject) => {
      if (closed) { reject(new Error(closed)); return; }
      const id = ++sequence;
      pending.set(id, { resolve: value => resolve(value as T), reject });
      const packet = { kind: 'request', id, name, args };
      try {
        if (files) webview!.postMessageWithAdditionalObjects(packet, files);
        else webview!.postMessage(packet);
      }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  return desktopBridge(
    (name, ...args) => request(name, args),
    (name, ...args) => { if (!closed) webview.postMessage({ kind: 'notify', name, args }); },
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    files => request<string[]>('dropped-paths', [], files),
  );
}
