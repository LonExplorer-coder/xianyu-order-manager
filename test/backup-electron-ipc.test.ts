import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type { DesktopSession } from '../src/main/desktop-session';

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  window: { isDestroyed: () => false },
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn((name: string) => {
      if (name === 'documents') return '/Users/test/Documents';
      if (name === 'exe') return '/Applications/XianyuOrderManager.app/Contents/MacOS/XianyuOrderManager';
      return '/Users/test/Library/Application Support/闲鱼订单管理';
    }),
    getVersion: vi.fn(() => '0.2.43'),
  },
  BrowserWindow: class MockBrowserWindow {
    public static getAllWindows(): unknown[] { return []; }
    public static fromWebContents(): unknown { return electronBoundary.window; }
  },
  dialog: {
    showOpenDialog: electronBoundary.showOpenDialog,
    showSaveDialog: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
}));

import { registerIpcHandlers } from '../src/main/electron-main';

function invoke(channel: string, arg?: unknown): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`未注册通道：${channel}`);
  return handler({ sender: 'web-contents' }, arg) as Promise<unknown>;
}

function fakeSession(members: Record<string, unknown>): DesktopSession {
  return {
    onRecognitionBatchesChanged: () => () => undefined,
    onOrdersChanged: () => () => undefined,
    ...members,
  } as unknown as DesktopSession;
}

function directorySelection(path: string | null) {
  if (path === null) return { canceled: true, filePaths: [] };
  return { canceled: false, filePaths: [path] };
}

afterEach(() => {
  electronBoundary.handlers.clear();
  electronBoundary.showOpenDialog.mockReset();
});

describe('备份 Electron IPC', () => {
  it('立即备份弹出备份位置选择器并把会话结果返回渲染层', async () => {
    const createBackup = vi.fn().mockResolvedValue({
      backupDirectory: '/Volumes/Backup/xianyu-backup-20260818-103000',
      database: { path: 'xianyu-order-manager.sqlite3', sha256: 'a', bytes: 10 },
      files: [{ path: 'screenshots/shot-1.png', sha256: 'b', bytes: 4 }],
      totals: { files: 1, bytes: 4 },
      verification: {
        ok: true, problems: [], checkedFiles: 2, totalBytes: 14,
        createdAt: '2026-08-18T02:30:00.000Z', appVersion: '0.2.43',
      },
    });
    registerIpcHandlers(fakeSession({ createBackup }));
    electronBoundary.showOpenDialog.mockResolvedValue(directorySelection('/Volumes/Backup'));

    const outcome = await invoke('backup:create') as Awaited<ReturnType<DesktopApi['createBackup']>>;

    expect(electronBoundary.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(createBackup).toHaveBeenCalledWith('/Volumes/Backup', '0.2.43');
    expect(outcome).toMatchObject({
      kind: 'created',
      backupDirectory: '/Volumes/Backup/xianyu-backup-20260818-103000',
      totals: { files: 1, bytes: 4 },
    });
  });

  it('取消备份位置选择时返回 canceled 且不触发备份', async () => {
    const createBackup = vi.fn();
    registerIpcHandlers(fakeSession({ createBackup }));
    electronBoundary.showOpenDialog.mockResolvedValue(directorySelection(null));

    const outcome = await invoke('backup:create');

    expect(outcome).toEqual({ kind: 'canceled' });
    expect(createBackup).not.toHaveBeenCalled();
  });

  it('验证备份选择备份目录并返回验证报告', async () => {
    const verifyBackup = vi.fn().mockResolvedValue({
      ok: false,
      problems: ['screenshots/shot-1.png 校验和不一致，内容已损坏或被篡改'],
      checkedFiles: 2,
      totalBytes: 14,
      createdAt: '2026-08-18T02:30:00.000Z',
      appVersion: '0.2.43',
    });
    registerIpcHandlers(fakeSession({ verifyBackup }));
    electronBoundary.showOpenDialog.mockResolvedValue(
      directorySelection('/Volumes/Backup/xianyu-backup-20260818-103000'),
    );

    const outcome = await invoke('backup:verify') as Awaited<ReturnType<DesktopApi['verifyBackup']>>;

    expect(verifyBackup).toHaveBeenCalledWith('/Volumes/Backup/xianyu-backup-20260818-103000');
    expect(outcome).toEqual({
      kind: 'verified',
      result: {
        ok: false,
        problems: ['screenshots/shot-1.png 校验和不一致，内容已损坏或被篡改'],
        checkedFiles: 2,
        totalBytes: 14,
        createdAt: '2026-08-18T02:30:00.000Z',
        appVersion: '0.2.43',
      },
    });
  });

  it('恢复依次选择备份与恢复位置并返回结果，取消任一步都不写入', async () => {
    const restoreBackup = vi.fn().mockResolvedValue({
      targetDirectory: '/Users/test/Documents/闲鱼订单数据-恢复',
      restoredFiles: 2,
      restoredBytes: 14,
      verification: {
        ok: true, problems: [], checkedFiles: 2, totalBytes: 14,
        createdAt: '2026-08-18T02:30:00.000Z', appVersion: '0.2.43',
      },
    });
    registerIpcHandlers(fakeSession({ restoreBackup }));
    electronBoundary.showOpenDialog
      .mockResolvedValueOnce(directorySelection('/Volumes/Backup/xianyu-backup-1'))
      .mockResolvedValueOnce(directorySelection('/Users/test/Documents/闲鱼订单数据-恢复'));

    const outcome = await invoke('backup:restore') as Awaited<ReturnType<DesktopApi['restoreBackup']>>;

    expect(electronBoundary.showOpenDialog).toHaveBeenCalledTimes(2);
    expect(restoreBackup).toHaveBeenCalledWith({
      backupDirectory: '/Volumes/Backup/xianyu-backup-1',
      targetDirectory: '/Users/test/Documents/闲鱼订单数据-恢复',
    });
    expect(outcome).toMatchObject({
      kind: 'restored',
      targetDirectory: '/Users/test/Documents/闲鱼订单数据-恢复',
      restoredFiles: 2,
    });

    electronBoundary.showOpenDialog.mockResolvedValueOnce(directorySelection(null));
    const canceledBackup = await invoke('backup:restore');
    expect(canceledBackup).toEqual({ kind: 'canceled' });

    electronBoundary.showOpenDialog
      .mockResolvedValueOnce(directorySelection('/Volumes/Backup/xianyu-backup-1'))
      .mockResolvedValueOnce(directorySelection(null));
    const canceledTarget = await invoke('backup:restore');
    expect(canceledTarget).toEqual({ kind: 'canceled' });
    expect(restoreBackup).toHaveBeenCalledTimes(1);
  });
});

describe('自动备份设置 Electron IPC', () => {
  const settingsInput = {
    autoBackupEnabled: true,
    backupRootDirectory: '/Volumes/Backup/闲鱼订单备份',
    maxVersions: 15,
    capacityLimitBytes: 2 * 1024 * 1024 * 1024,
  };

  it('保存设置回传视图，开启时立即触发一次自动备份检查', async () => {
    const saveBackupSettings = vi.fn().mockReturnValue(settingsInput);
    const runAutomaticBackup = vi.fn().mockResolvedValue({ ran: false, reason: 'no-workspace' });
    registerIpcHandlers(fakeSession({ saveBackupSettings, runAutomaticBackup }));

    const saved = await invoke('backup:save-settings', settingsInput);

    expect(saveBackupSettings).toHaveBeenCalledWith(settingsInput);
    expect(saved).toEqual(settingsInput);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runAutomaticBackup).toHaveBeenCalledWith('0.2.43');
  });

  it('关闭自动备份保存时不触发备份检查', async () => {
    const runAutomaticBackup = vi.fn();
    registerIpcHandlers(fakeSession({
      saveBackupSettings: vi.fn().mockReturnValue({ ...settingsInput, autoBackupEnabled: false }),
      runAutomaticBackup,
    }));

    await invoke('backup:save-settings', { ...settingsInput, autoBackupEnabled: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runAutomaticBackup).not.toHaveBeenCalled();
  });

  it('选择自动备份位置走目录选择器，取消返回 canceled', async () => {
    registerIpcHandlers(fakeSession({}));
    electronBoundary.showOpenDialog.mockResolvedValue(
      directorySelection('/Volumes/Backup/闲鱼订单备份'),
    );

    const selected = await invoke('backup:select-root');
    expect(selected).toEqual({ kind: 'selected', directory: '/Volumes/Backup/闲鱼订单备份' });

    electronBoundary.showOpenDialog.mockResolvedValue(directorySelection(null));
    const canceled = await invoke('backup:select-root');
    expect(canceled).toEqual({ kind: 'canceled' });
  });

  it('读取设置与状态直接透传会话结果', async () => {
    const getBackupSettings = vi.fn().mockReturnValue(settingsInput);
    const getBackupStatus = vi.fn().mockResolvedValue({ backups: [], totalBytes: 0 });
    registerIpcHandlers(fakeSession({ getBackupSettings, getBackupStatus }));

    expect(await invoke('backup:get-settings')).toEqual(settingsInput);
    expect(await invoke('backup:get-status')).toEqual({ backups: [], totalBytes: 0 });
  });
});
