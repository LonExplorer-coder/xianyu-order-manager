import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopSession } from '../src/main/desktop-session';
import type { PortableUpdateService } from '../src/main/portable-update-service';

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  quit: vi.fn(),
  window: { isDestroyed: () => false },
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: electronBoundary.quit,
    getVersion: vi.fn(() => '0.2.68'),
    getPath: vi.fn((name: string) => {
      if (name === 'exe') {
        return process.platform === 'win32'
          ? 'C:\\Portable\\XianyuOrderManager\\XianyuOrderManager.exe'
          : '/Applications/XianyuOrderManager.app/Contents/MacOS/XianyuOrderManager';
      }
      if (name === 'documents') return '/Users/test/Documents';
      return '/Users/test/Library/Application Support/闲鱼订单管理';
    }),
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

afterEach(() => {
  electronBoundary.handlers.clear();
  electronBoundary.showOpenDialog.mockReset();
  electronBoundary.quit.mockReset();
  vi.useRealTimers();
});

describe('便携版更新 Electron IPC', () => {
  it('检查、下载分别调用更新服务，应用前自动创建并验证备份再启动辅助程序', async () => {
    vi.useFakeTimers();
    const backupRoot = await mkdtemp(join(tmpdir(), 'xianyu-update-backup-root-'));
    const archiveRoot = await mkdtemp(join(tmpdir(), 'xianyu-update-archive-'));
    const downloaded = updateView('downloaded');
    const portableUpdate = fakeUpdateService({
      getView: vi.fn(() => updateView('idle')),
      checkForUpdate: vi.fn(async () => updateView('available')),
      downloadUpdate: vi.fn(async () => downloaded),
      verifyDownloadedUpdate: vi.fn(async () => ({
        candidate: downloaded.candidate!,
        archivePath: join(archiveRoot, downloaded.candidate!.archiveFile),
        evidencePath: join(archiveRoot, 'portable-darwin-arm64.json'),
        archiveSha256: 'a'.repeat(64),
      })),
    });
    const createBackup = vi.fn(async () => verifiedBackup(join(backupRoot, 'backup-1')));
    const session = fakeSession({
      getBackupSettings: () => backupSettings(backupRoot),
      createBackup,
    });
    const launchUpdate = vi.fn(async () => ({ scriptPath: '/tmp/apply-update.sh' }));
    registerIpcHandlers(session, undefined, portableUpdate, launchUpdate);

    await expect(invoke('portable-update:get-view')).resolves.toMatchObject({ status: 'idle' });
    await expect(invoke('portable-update:check')).resolves.toMatchObject({ status: 'available' });
    await expect(invoke('portable-update:download', 'candidate-id'))
      .resolves.toMatchObject({ status: 'downloaded' });
    const applied = await invoke('portable-update:apply', 'candidate-id');

    expect(createBackup).toHaveBeenCalledWith(backupRoot, '0.2.68');
    expect(launchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      platform: process.platform,
      version: '0.3.0',
      archivePath: join(archiveRoot, downloaded.candidate!.archiveFile),
      backupDirectory: join(backupRoot, 'backup-1'),
    }));
    expect(applied).toEqual({
      started: true,
      version: '0.3.0',
      backupDirectory: join(backupRoot, 'backup-1'),
    });
    expect(electronBoundary.showOpenDialog).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(electronBoundary.quit).toHaveBeenCalledTimes(1);
  });

  it('没有备份位置时要求用户选择，取消或备份验证失败都不得启动替换', async () => {
    const downloaded = updateView('downloaded');
    const portableUpdate = fakeUpdateService({
      verifyDownloadedUpdate: vi.fn(async () => ({
        candidate: downloaded.candidate!,
        archivePath: '/Users/test/updates/update.zip',
        evidencePath: '/Users/test/updates/evidence.json',
        archiveSha256: 'a'.repeat(64),
      })),
    });
    const launchUpdate = vi.fn();
    const createBackup = vi.fn();
    const session = fakeSession({
      getBackupSettings: () => backupSettings(null),
      updateBackupLocationDefaults: vi.fn(),
      createBackup,
    });
    registerIpcHandlers(session, undefined, portableUpdate, launchUpdate);
    electronBoundary.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(invoke('portable-update:apply', 'candidate-id'))
      .rejects.toThrow('应用前必须创建并验证备份');
    expect(createBackup).not.toHaveBeenCalled();
    expect(launchUpdate).not.toHaveBeenCalled();

    const backupRoot = await mkdtemp(join(tmpdir(), 'xianyu-update-invalid-backup-'));
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [backupRoot],
    });
    createBackup.mockResolvedValue(verifiedBackup(join(backupRoot, 'backup-1'), false));
    await expect(invoke('portable-update:apply', 'candidate-id'))
      .rejects.toThrow('备份验证未通过');
    expect(launchUpdate).not.toHaveBeenCalled();
  });
});

function fakeSession(members: Record<string, unknown>): DesktopSession {
  return {
    onRecognitionBatchesChanged: vi.fn(),
    onOrdersChanged: vi.fn(),
    ...members,
  } as unknown as DesktopSession;
}

function fakeUpdateService(members: Record<string, unknown>): PortableUpdateService {
  return members as unknown as PortableUpdateService;
}

function updateView(status: 'idle' | 'available' | 'downloaded') {
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const architecture = process.platform === 'win32' ? 'x64' : 'arm64';
  const candidate = status === 'idle' ? null : {
    id: 'candidate-id',
    version: '0.3.0',
    name: '稳定版 0.3.0',
    releaseNotes: '更新说明',
    publishedAt: '2026-08-22T02:00:00.000Z',
    releaseUrl: 'https://github.com/LonExplorer-coder/xianyu-order-manager/releases/tag/v0.3.0',
    archiveFile: `XianyuOrderManager-${platform}-${architecture}-0.3.0.zip`,
    archiveBytes: 1024,
  };
  return {
    currentVersion: '0.2.68',
    status,
    candidate,
    downloaded: status === 'downloaded' ? {
      archivePath: '/Users/test/updates/update.zip',
      archiveSha256: 'a'.repeat(64),
      archiveBytes: 1024,
    } : null,
  };
}

function backupSettings(manualBackupRootDirectory: string | null) {
  return {
    autoBackupEnabled: false,
    backupRootDirectory: null,
    manualBackupRootDirectory,
    restoreTargetDirectory: null,
    maxVersions: 30,
    capacityLimitBytes: 5 * 1024 * 1024 * 1024,
  };
}

function verifiedBackup(backupDirectory: string, ok = true) {
  return {
    backupDirectory,
    database: { path: 'xianyu-order-manager.sqlite3', sha256: 'a', bytes: 10 },
    files: [],
    totals: { files: 0, bytes: 0 },
    verification: {
      ok,
      problems: ok ? [] : ['数据库校验失败'],
      checkedFiles: 1,
      totalBytes: 10,
      createdAt: '2026-08-22T02:00:00.000Z',
      appVersion: '0.2.68',
    },
  };
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`未注册 IPC：${channel}`);
  return handler({ sender: 'web-contents' }, ...args);
}
