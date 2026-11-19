import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  authSchema, commandGroupsSchema, lineEndings, preferencesSchema, profile, recentConnectionSchema, sessionProfile, sizeSchema, sshProfile, timerSchema,
  type SessionEvent,
} from '../shared';
import { errorText, Session, systemSerial, type SerialProvider } from './session';
import { Store } from './store';
import { Credentials } from './credentials';
import { createAi, type AiTransport } from './ai';
import { AdbTools } from './adb';

const uuid = z.string().uuid();
const openSchema = z.object({ id: uuid, profile: sessionProfile, auth: authSchema.optional(), size: sizeSchema,
  useSavedPassword: z.boolean().optional(), rememberPassword: z.boolean().optional() });
const credentialChange = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), password: z.string().min(1).max(8192) }),
  z.object({ action: z.literal('clear') }),
]);
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

export function createController(directory: string, emit: (event: SessionEvent) => void, serial: SerialProvider = systemSerial, aiTransport?: AiTransport) {
  const store = new Store(directory);
  const credentials = new Credentials(directory);
  const adb = new AdbTools(store, directory);
  const logRoot = join(directory, 'logs');
  const sessions = new Map<string, Session>();
  let quitting = false;

  function requireSession(rawId: unknown) {
    const session = sessions.get(uuid.parse(rawId));
    if (!session) throw new Error('会话已关闭');
    return session;
  }
  const ai = createAi(store, credentials, aiTransport, {
    list: () => Array.from(sessions.values()).flatMap(session => session.aiSerialTarget ?? []),
    acquire: (id, runId, cancel) => requireSession(id).acquireAiSerial(runId, cancel),
  }, emit);

  const requests: Record<string, Handler> = {
    load: () => ({
      profiles: store.profiles, recentConnections: store.recentConnections, preferences: store.preferences,
      logRoot, commandGroups: store.commandGroups,
    }),
    'save-profile': value => store.save(profile.parse(value)),
    'delete-profile': id => store.delete(uuid.parse(id)),
    'edit-recent': (old, value) => store.editRecent(recentConnectionSchema.parse(old), profile.parse(value)),
    credential: async (value, rawChange) => {
      const config = sshProfile.parse(value);
      if (rawChange != null) {
        const change = credentialChange.parse(rawChange);
        if (change.action === 'save') await credentials.save(config, change.password);
        else await credentials.clear(config);
      }
      return credentials.status(config);
    },
    'credential-reveal': value => credentials.get(sshProfile.parse(value)),
    'ai-settings': ai.settings,
    'ai-save': ai.save,
    'ai-add-model': ai.addModel,
    'ai-reveal-key': ai.revealKey,
    'ai-test': ai.test,
    'ai-chat': ai.chat,
    'ai-assist': ai.assist,
    'ai-answer': ai.answer,
    'ai-cancel': ai.cancel,
    'adb-settings': () => adb.settings(),
    'adb-save': value => adb.save(value),
    'adb-open-directory': () => adb.ready(),
    'adb-detect': () => adb.detect(),
    'adb-devices': () => adb.devices(),
    'adb-pull': value => adb.pull(value),
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
    open: async value => {
      const request = openSchema.parse(value);
      const config = request.profile;
      if (sessions.has(request.id) || quitting) throw new Error('无法打开新会话');
      if (config.kind === 'ssh' && request.useSavedPassword) {
        request.auth = { method: 'password', password: await credentials.get(config) };
      }
      if (config.kind === 'ssh' && request.rememberPassword && request.auth?.method === 'password') {
        if (!request.auth.password) throw new Error('请填写需要保存的 SSH 密码');
        await credentials.save(config, request.auth.password);
      }
      let adbDirectory: string | undefined;
      let adbError: string | undefined;
      if (config.kind === 'local' && (config.shell === 'powershell' || config.shell === 'pwsh') && process.platform === 'win32') {
        try { adbDirectory = await adb.ready(); }
        catch (error) { adbError = errorText(error); }
      }
      if (sessions.has(request.id) || quitting) throw new Error('无法打开新会话');
      sessions.set(request.id, new Session(request, store, logRoot, event => {
        emit(event);
        if (event.type !== 'connection' || config.kind === 'local') return;
        if (event.state !== 'connected') return;
        try {
          const recentConnections = store.recordConnection(config);
          emit({ id: event.id, type: 'history', recentConnections });
        } catch (error) {
          emit({ id: event.id, type: 'error', detail: `保存最近连接失败：${errorText(error)}` });
        }
      }, serial, adbDirectory));
      if (adbError) emit({ id: request.id, type: 'error', detail: adbError });
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
      ai.close();
      await Promise.allSettled([...sessions.values()].map(session => session.end()));
      await credentials.settled();
      await adb.settled();
    },
  };
}
