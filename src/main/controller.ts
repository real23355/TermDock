import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  authSchema, commandGroupsSchema, lineEndings, preferencesSchema, profile, sessionProfile, sizeSchema, timerSchema,
  type SessionEvent,
} from '../shared';
import { errorText, Session, systemSerial, type SerialProvider } from './session';
import { Store } from './store';

const uuid = z.string().uuid();
const openSchema = z.object({ id: uuid, profile: sessionProfile, auth: authSchema.optional(), size: sizeSchema });
const input = z.string().max(512 * 1024 + 64);
const remotePath = z.string().min(1).max(4096).refine(value => !value.includes('\0'));
const localPath = z.string().min(1).max(32767).refine(value => !value.includes('\0'));
const transferMode = z.literal(['upload', 'download']);
const forwardOptions = z.object({
  localPort: z.number().int().min(0).max(65535),
  host: z.string().trim().regex(/^[\w.:%-]{1,253}$/, '请输入有效的目标主机'),
  port: z.number().int().min(1).max(65535),
});
type Handler = (...args: unknown[]) => unknown;

export function createController(directory: string, emit: (event: SessionEvent) => void, serial: SerialProvider = systemSerial) {
  const store = new Store(directory);
  const logRoot = join(directory, 'logs');
  const sessions = new Map<string, Session>();
  let quitting = false;

  function requireSession(rawId: unknown) {
    const session = sessions.get(uuid.parse(rawId));
    if (!session) throw new Error('会话已关闭');
    return session;
  }

  const requests: Record<string, Handler> = {
    load: () => ({
      profiles: store.profiles, recentConnections: store.recentConnections, preferences: store.preferences,
      logRoot, commandGroups: store.commandGroups,
    }),
    'save-profile': value => store.save(profile.parse(value)),
    'delete-profile': id => store.delete(uuid.parse(id)),
    'import-profiles': value => store.importProfiles(z.object({ profiles: profile.array().max(1000) }).parse(value).profiles),
    preferences: value => store.setPreferences(preferencesSchema.parse(value)),
    'save-command-groups': value => store.setCommandGroups(commandGroupsSchema.parse(value)),
    'run-command': (id, groupId, buttonId) => {
      const session = requireSession(id);
      const groupKey = uuid.parse(groupId);
      const buttonKey = uuid.parse(buttonId);
      const button = store.commandGroups.find(group => group.id === groupKey)?.buttons.find(button => button.id === buttonKey);
      if (!button) throw new Error('命令按钮已删除');
      if (!session.write(button.command + lineEndings[button.lineEnding], false)) throw new Error('当前会话无法发送命令');
    },
    ports: () => serial.list(),
    open: value => {
      const request = openSchema.parse(value);
      if (sessions.has(request.id) || quitting) throw new Error('无法打开新会话');
      const config = request.profile;
      sessions.set(request.id, new Session(request, store, logRoot, event => {
        emit(event);
        if (event.type !== 'connection' || event.state !== 'connected' || config.kind === 'local') return;
        try {
          const recentConnections = store.recordConnection(config);
          emit({ id: event.id, type: 'history', recentConnections });
        } catch (error) {
          emit({ id: event.id, type: 'error', detail: `保存最近连接失败：${errorText(error)}` });
        }
      }, serial));
    },
    close: async id => {
      const session = requireSession(id);
      await session.end();
      sessions.delete(session.id);
    },
    disconnect: id => requireSession(id).end(),
    'serial-break': id => requireSession(id).serialBreak(),
    'sftp-list': (id, path) => requireSession(id).sftpList(remotePath.parse(path)),
    'sftp-transfer': (id, mode, remote, local) =>
      requireSession(id).sftpTransfer(transferMode.parse(mode), remotePath.parse(remote), localPath.parse(local)),
    'forward-list': id => requireSession(id).listForwards(),
    'forward-start': (id, options) => requireSession(id).startForward(forwardOptions.parse(options)),
    'forward-stop': (id, forward) => requireSession(id).stopForward(uuid.parse(forward)),
    record: (id, enabled) => requireSession(id).record(z.boolean().parse(enabled)),
    'accept-key': (id, token, accepted) => requireSession(id).acceptKey(uuid.parse(token), z.boolean().parse(accepted)),
    'timer-start': (id, options) => requireSession(id).startTimer(timerSchema.parse(options)),
    'timer-stop': id => requireSession(id).stopTimer(),
    'show-logs': async id => {
      const path = id === undefined || id === null ? logRoot : requireSession(id).logDir;
      if (!path) throw new Error('日志目录尚未创建');
      await mkdir(path, { recursive: true });
      return path;
    },
  };

  const notifications: Record<string, Handler> = {
    write: (id, value, binary) => {
      const data = input.safeParse(value);
      if (typeof id === 'string' && data.success && typeof binary === 'boolean') sessions.get(id)?.write(data.data, binary);
    },
    resize: (id, value) => {
      const size = sizeSchema.safeParse(value);
      if (typeof id === 'string' && size.success) sessions.get(id)?.resize(size.data);
    },
    ack: (id, sequence) => {
      if (typeof id === 'string' && typeof sequence === 'number') sessions.get(id)?.ack(sequence);
    },
  };

  return {
    requests,
    notifications,
    async closeAll() {
      quitting = true;
      await Promise.allSettled([...sessions.values()].map(session => session.end()));
    },
  };
}
