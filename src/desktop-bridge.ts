import type { DesktopApi, SessionEvent } from './shared';

export type Bridge = DesktopApi & { copy(value: string): Promise<void>; paste(): Promise<string>; droppedPaths(files: File[]): Promise<string[]> };
type Invoke = (name: string, ...args: unknown[]) => Promise<any>;
type Send = (name: string, ...args: unknown[]) => void;

export function desktopBridge(invoke: Invoke, send: Send, onSession: (callback: (event: SessionEvent) => void) => () => void, droppedPaths: Bridge['droppedPaths']): Bridge {
  return {
    load: () => invoke('load'),
    saveProfile: value => invoke('save-profile', value),
    deleteProfile: id => invoke('delete-profile', id),
    editRecent: (old, value) => invoke('edit-recent', old, value),
    credential: (config, change) => invoke('credential', config, change),
    aiSettings: () => invoke('ai-settings'),
    saveAiSettings: value => invoke('ai-save', value),
    testAi: value => invoke('ai-test', value),
    aiChat: value => invoke('ai-chat', value),
    aiAssist: value => invoke('ai-assist', value),
    cancelAi: id => invoke('ai-cancel', id),
    droppedPaths,
    savePreferences: value => invoke('preferences', value),
    saveCommandGroups: groups => invoke('save-command-groups', groups),
    runCommand: (id, groupId, buttonId) => invoke('run-command', id, groupId, buttonId),
    ports: () => invoke('ports'),
    pickKey: () => invoke('pick-key'),
    pickLogDirectory: () => invoke('pick-log-directory'),
    pickTransferPath: mode => invoke('pick-transfer-path', mode),
    sftpList: (id, path) => invoke('sftp-list', id, path),
    sftpTransfer: (id, mode, remote, local) => invoke('sftp-transfer', id, mode, remote, local),
    listForwards: id => invoke('forward-list', id),
    startForward: (id, options) => invoke('forward-start', id, options),
    stopForward: (id, forward) => invoke('forward-stop', id, forward),
    open: request => invoke('open', request),
    close: id => invoke('close', id),
    disconnect: id => invoke('disconnect', id),
    serialBreak: id => invoke('serial-break', id),
    record: (id, enabled) => invoke('record', id, enabled),
    write: (id, data, binary = false) => send('write', id, data, binary),
    resize: (id, size) => send('resize', id, size),
    ack: (id, sequence) => send('ack', id, sequence),
    acceptKey: (id, token, accept) => invoke('accept-key', id, token, accept),
    startTimer: (id, options) => invoke('timer-start', id, options),
    stopTimer: id => invoke('timer-stop', id),
    showLogs: id => invoke('show-logs', id),
    onSession,
    copy: value => invoke('copy', value),
    paste: () => invoke('paste'),
  };
}
