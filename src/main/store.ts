import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  commandGroupsSchema, defaults, preferencesSchema, profile, recentConnectionSchema,
  type CommandGroup, type Preferences, type Profile, type RecentConnection, type SavedProfile,
} from '../shared';

const settingsSchema = z.object({
  preferences: preferencesSchema,
  hosts: z.record(z.string(), z.string()),
});
const legacySettingsSchema = settingsSchema.extend({
  profiles: z.unknown().optional(),
  commandGroups: z.unknown().optional(),
});
const sessionsSchema = z.object({
  profiles: profile.array(),
  recentConnections: recentConnectionSchema.array(),
});
const buttonsSchema = z.object({ commandGroups: commandGroupsSchema });

type Settings = z.infer<typeof settingsSchema>;
type Sessions = { profiles: SavedProfile[]; recentConnections: RecentConnection[] };

function readFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`无法读取 ${path}`, { cause: error });
  }
}

function validate<T>(path: string, schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new Error(`无法读取 ${path}`, { cause: error });
  }
}

function saveFile(path: string, value: object) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', flush: true });
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* Keep the original write failure. */ }
    throw new Error(`无法保存 ${path}`, { cause: error });
  }
}

function sameEndpoint(first: Profile, second: Profile) {
  if (first.kind === 'serial' && second.kind === 'serial') {
    return first.path.toUpperCase() === second.path.toUpperCase();
  }
  return first.kind === 'ssh' && second.kind === 'ssh' &&
    first.host.toLowerCase() === second.host.toLowerCase() &&
    first.port === second.port && first.username === second.username;
}

export class Store {
  private readonly settingsFile: string;
  private readonly sessionsFile: string;
  private readonly buttonsFile: string;
  private settings: Settings;
  private sessions: Sessions;
  private buttons: { commandGroups: CommandGroup[] };

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.settingsFile = join(directory, 'settings.json');
    this.sessionsFile = join(directory, 'sessions.json');
    this.buttonsFile = join(directory, 'command-buttons.json');

    const savedSettings = readFile(this.settingsFile);
    const legacy = savedSettings === undefined ? undefined : validate(this.settingsFile, legacySettingsSchema, savedSettings);
    this.settings = { preferences: legacy?.preferences ?? defaults, hosts: legacy?.hosts ?? {} };

    const savedSessions = readFile(this.sessionsFile);
    const sessions = savedSessions === undefined
      ? validate(this.settingsFile, sessionsSchema, {
        profiles: legacy?.profiles === undefined ? [] : legacy.profiles,
        recentConnections: [],
      })
      : validate(this.sessionsFile, sessionsSchema, savedSessions);
    this.sessions = { ...sessions, profiles: sessions.profiles.filter((entry): entry is SavedProfile => !!entry.id) };

    const savedButtons = readFile(this.buttonsFile);
    this.buttons = savedButtons === undefined
      ? validate(this.settingsFile, buttonsSchema, {
        commandGroups: legacy?.commandGroups === undefined ? [] : legacy.commandGroups,
      })
      : validate(this.buttonsFile, buttonsSchema, savedButtons);

    // Leave the legacy source intact so an interrupted migration can safely be retried.
    if (savedSessions === undefined && legacy?.profiles !== undefined) saveFile(this.sessionsFile, this.sessions);
    if (savedButtons === undefined && legacy?.commandGroups !== undefined) saveFile(this.buttonsFile, this.buttons);
  }

  get profiles() { return this.sessions.profiles; }
  get recentConnections() { return this.sessions.recentConnections; }
  get preferences() { return this.settings.preferences; }
  get commandGroups() { return this.buttons.commandGroups; }

  private updateSessions(changes: Partial<Sessions>) {
    const sessions = { ...this.sessions, ...changes };
    saveFile(this.sessionsFile, sessions);
    this.sessions = sessions;
  }

  private updateSettings(changes: Partial<Settings>) {
    const settings = { ...this.settings, ...changes };
    saveFile(this.settingsFile, settings);
    this.settings = settings;
  }

  save(value: Profile) {
    const parsed = profile.parse(value);
    const saved = { ...parsed, id: parsed.id ?? randomUUID() };
    const profiles = this.profiles.slice();
    const index = profiles.findIndex(p => p.id === saved.id);
    if (index === -1) profiles.push(saved);
    else profiles[index] = saved;
    this.updateSessions({ profiles });
    return saved;
  }

  delete(id: string) { this.updateSessions({ profiles: this.profiles.filter(p => p.id !== id) }); }

  editRecent(old: RecentConnection, value: Profile) {
    const { id: _id, ...config } = value;
    const index = this.recentConnections.findIndex(entry => entry.connectedAt === old.connectedAt && sameEndpoint(entry.profile, old.profile));
    if (index < 0) throw new Error('最近连接已更新，请重新打开设置');
    const recentConnections = this.recentConnections.slice();
    recentConnections[index] = { profile: config, connectedAt: old.connectedAt };
    this.updateSessions({ recentConnections });
    return recentConnections;
  }

  recordConnection(value: Profile) {
    const { id: _id, ...connectedProfile } = profile.parse(value);
    const recentConnections = [
      { profile: connectedProfile, connectedAt: new Date().toISOString() },
      ...this.recentConnections.filter(entry => !sameEndpoint(entry.profile, connectedProfile)),
    ];
    this.updateSessions({ recentConnections });
    return recentConnections;
  }

  setPreferences(preferences: Preferences) {
    this.updateSettings({ preferences });
    return preferences;
  }

  setCommandGroups(commandGroups: CommandGroup[]) {
    const buttons = { commandGroups };
    saveFile(this.buttonsFile, buttons);
    this.buttons = buttons;
    return commandGroups;
  }

  host(key: string) { return this.settings.hosts[key]; }

  trust(key: string, fingerprint: string) {
    const previous = this.host(key);
    if (previous && previous !== fingerprint) throw new Error(`主机密钥已变化。已保存 ${previous}，当前 ${fingerprint}`);
    if (!previous) this.updateSettings({ hosts: { ...this.settings.hosts, [key]: fingerprint } });
  }
}
