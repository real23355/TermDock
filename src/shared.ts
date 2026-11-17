import { z } from 'zod';

const id = z.string().uuid();
const label = z.string().trim().min(1, '请输入会话名称').max(80);
const savedFields = {
  id: id.optional(), name: label,
  group: z.string().trim().max(80).optional(),
  favorite: z.boolean().optional(),
  keywords: z.string().trim().max(1024).optional(),
};
export const serialProfile = z.object({
  ...savedFields, kind: z.literal('serial'),
  path: z.string().regex(/^COM[1-9]\d{0,4}$/i, '请选择 COM 口'),
  baudRate: z.number().int().min(50).max(12000000),
  dataBits: z.literal([5, 6, 7, 8]),
  parity: z.literal(['none', 'even', 'odd', 'mark', 'space']),
  stopBits: z.literal([1, 1.5, 2]),
  flow: z.literal(['none', 'software', 'hardware']),
  inputEnding: z.literal(['CR', 'LF', 'CRLF']).optional(),
  localEcho: z.boolean().optional(),
  logDirectory: z.string().max(32767)
    .regex(/^(?:[a-z]:[\\/]|\\\\(?![?.]\\)[^\\]+\\[^\\]+)/i, '请选择有效的日志目录')
    .refine(value => !/[\x00-\x1f]/.test(value), '日志目录包含无效字符').optional(),
  logFormat: z.literal(['timestamped', 'raw']).default('timestamped'),
});
export const sshProfile = z.object({
  ...savedFields, kind: z.literal('ssh'),
  host: z.string().trim().regex(/^[\w.:%-]{1,253}$/, '请输入主机名或 IP 地址'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1, '请输入用户名').max(128),
  method: z.literal(['password', 'key', 'agent']).optional(),
  privateKey: z.string().max(4096).optional(),
});
export const profile = z.discriminatedUnion('kind', [sshProfile, serialProfile]);
export const localProfile = z.object({
  kind: z.literal('local'), name: label,
  shell: z.literal(['powershell', 'cmd', 'pwsh', 'wsl']).default('powershell'),
  cwd: z.string().max(32767).refine(value => !value.includes('\0')).optional(),
  env: z.record(z.string().regex(/^[^=\x00]+$/), z.string().refine(value => !value.includes('\0'))).optional(),
});
export const sessionProfile = z.discriminatedUnion('kind', [sshProfile, serialProfile, localProfile]);
export const recentConnectionSchema = z.object({ profile, connectedAt: z.iso.datetime() });
export const authSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('password'), password: z.string().max(8192) }),
  z.object({ method: z.literal('key'), privateKey: z.string().min(1, '请选择私钥文件').max(4096), passphrase: z.string().max(8192) }),
  z.object({ method: z.literal('agent') }),
]);
export const sizeSchema = z.object({
  cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500),
});
const singleLine = z.string().min(1).max(1024).refine(s => s.trim() && !/[\x00-\x1f\x7f]/.test(s), '请输入单行命令');
export const timerStep = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send'), command: singleLine, lineEnding: z.literal(['CR', 'LF', 'CRLF', 'none']) }),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(1).max(2_147_483_647) }),
  z.object({ type: z.literal('login') }),
]);
export const timerSchema = z.object({
  command: singleLine,
  intervalSeconds: z.number().int().min(1).max(86400),
  maxRounds: z.number().int().min(1).max(1000000).optional(),
  lineEnding: z.literal(['CR', 'LF', 'CRLF']),
  waitForShell: z.boolean(),
  prompt: z.string().trim().max(128).refine(s => !/[\x00-\x1f\x7f]/.test(s)),
  once: z.boolean().optional(),
  steps: timerStep.array().min(1).max(40).optional(),
  login: z.object({
    username: singleLine,
    password: z.string().min(1, '请输入自动登录密码').max(1024).refine(s => !/[\x00-\x1f\x7f]/.test(s)),
    loginPrompt: singleLine.max(128),
    passwordPrompt: singleLine.max(128),
    timeoutSeconds: z.number().int().min(1).max(3600),
  }).optional(),
}).refine(options => !options.steps || options.steps.some(step => step.type === 'send' || (step.type === 'login' && !!options.login)),
  '流程至少需要一个发送命令或启用的登录步骤');
export const preferencesSchema = z.object({
  font: z.literal(['macOS', 'Cascadia Mono', 'Consolas', 'Lucida Console', 'monospace']),
  fontSize: z.number().int().min(9).max(36),
  scrollback: z.number().int().min(100).max(100000),
  gpu: z.boolean(),
});
export const lineEndings = { CR: '\r', LF: '\n', CRLF: '\r\n', none: '' } as const;
const commandButtonSchema = z.object({
  id,
  name: z.string().trim().min(1, '请输入按钮名称').max(60),
  command: z.string().min(1, '请输入要发送的命令').max(4096)
    .refine(value => value.trim() && !/[\x00-\x1f\x7f]/.test(value), '请输入单行命令'),
  lineEnding: z.literal(['CR', 'LF', 'CRLF', 'none']),
});
export const commandGroupsSchema = z.array(z.object({
  id,
  name: z.string().trim().min(1, '请输入分组名称').max(60),
  buttons: commandButtonSchema.array(),
}));

export type Profile = z.infer<typeof profile>;
export type SerialProfile = z.infer<typeof serialProfile>;
export type SshProfile = z.infer<typeof sshProfile>;
export type LocalProfile = z.infer<typeof localProfile>;
export type SessionProfile = z.infer<typeof sessionProfile>;
export type SavedProfile = Profile & { id: string };
export type RecentConnection = z.infer<typeof recentConnectionSchema>;
export type Auth = z.infer<typeof authSchema>;
export type Size = z.infer<typeof sizeSchema>;
export type TimerOptions = z.infer<typeof timerSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type CommandGroup = z.infer<typeof commandGroupsSchema>[number];
export type CommandButton = z.infer<typeof commandButtonSchema>;

export const defaults: Preferences = { font: 'macOS', fontSize: 15, scrollback: 10000, gpu: true };
export const localDefaults: LocalProfile = { kind: 'local', name: 'PowerShell', shell: 'powershell' };
export const serialDefaults: SerialProfile = {
  kind: 'serial', name: 'PL2303', path: '', baudRate: 921600,
  dataBits: 8, parity: 'none', stopBits: 1, flow: 'software', logFormat: 'timestamped',
};
export const timerDefaults: TimerOptions = {
  command: 'reboot', intervalSeconds: 60, lineEnding: 'CR', waitForShell: true, prompt: '',
};
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
export type SendState = 'idle' | 'countdown' | 'waiting' | 'sending' | 'stopped' | 'finished' | 'error';
export type ShellState = 'unknown' | 'ready' | 'login' | 'bootloader' | 'manual' | 'recovering';
export type TimerState = {
  send: SendState; shell: ShellState; rounds: number; recovered: number; bootSeen: boolean; seconds: number; detail: string;
  roundRecording: boolean;
};
export type PortInfo = { path: string; manufacturer?: string; friendlyName?: string };
export type RemoteEntry = { name: string; kind: 'directory' | 'file' | 'link' | 'other'; size: number };
export type ForwardOptions = { localPort: number; host: string; port: number };
export type Forward = ForwardOptions & { id: string };
export type HostKey = { id: string; token: string; host: string; port: number; fingerprint: string };
export type SessionEvent =
  | { id: string; type: 'connection'; state: ConnectionState; detail: string; logDir?: string }
  | { id: string; type: 'history'; recentConnections: RecentConnection[] }
  | { id: string; type: 'timer'; state: TimerState }
  | { id: string; type: 'host-key'; key: HostKey }
  | { id: string; type: 'error'; detail: string }
  | { id: string; type: 'output'; data: Uint8Array; sequence: number; skipped: number };
export type OpenRequest = { id: string; profile: SessionProfile; auth?: Auth; size: Size; useSavedPassword?: boolean; rememberPassword?: boolean };
export type DesktopApi = {
  load(): Promise<{
    profiles: SavedProfile[]; recentConnections: RecentConnection[]; preferences: Preferences;
    logRoot: string; commandGroups: CommandGroup[];
  }>;
  saveProfile(value: Profile): Promise<SavedProfile>;
  deleteProfile(id: string): Promise<void>;
  editRecent(old: RecentConnection, value: Profile): Promise<RecentConnection[]>;
  credential(config: SshProfile, change?: { action: 'save' | 'clear'; password?: string }): Promise<boolean>;
  savePreferences(value: Preferences): Promise<Preferences>;
  saveCommandGroups(groups: CommandGroup[]): Promise<CommandGroup[]>;
  runCommand(id: string, groupId: string, buttonId: string): Promise<void>;
  ports(): Promise<PortInfo[]>;
  pickKey(): Promise<string | undefined>;
  pickLogDirectory(): Promise<string | undefined>;
  pickTransferPath(mode: 'upload' | 'download'): Promise<string | undefined>;
  sftpList(id: string, path: string): Promise<{ path: string; entries: RemoteEntry[] }>;
  sftpTransfer(id: string, mode: 'upload' | 'download', remote: string, local: string): Promise<void>;
  listForwards(id: string): Promise<Forward[]>;
  startForward(id: string, options: ForwardOptions): Promise<void>;
  stopForward(id: string, forward: string): Promise<void>;
  open(request: OpenRequest): Promise<void>;
  close(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  serialBreak(id: string): Promise<void>;
  record(id: string, enabled: boolean): Promise<void>;
  write(id: string, data: string, binary?: boolean): void;
  resize(id: string, size: Size): void;
  ack(id: string, sequence: number): void;
  acceptKey(id: string, token: string, accept: boolean): Promise<void>;
  startTimer(id: string, options: TimerOptions): Promise<void>;
  stopTimer(id: string): Promise<void>;
  showLogs(id?: string): Promise<void>;
  onSession(callback: (event: SessionEvent) => void): () => void;
};
