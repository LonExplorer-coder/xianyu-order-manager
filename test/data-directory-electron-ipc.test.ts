import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapState } from '../src/core/desktop-api';
import type { DesktopSession } from '../src/main/desktop-session';

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  getPath: vi.fn((name: string) => {
    if (name === 'documents') return '/Users/test/Documents';
    if (name === 'exe') return '/Applications/XianyuOrderManager.app/Contents/MacOS/XianyuOrderManager';
    return '/Users/test/Library/Application Support/闲鱼订单管理';
  }),
  window: { isDestroyed: () => false },
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
    getPath: electronBoundary.getPath,
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
  electronBoundary.getPath.mockClear();
});

describe('数据目录 Electron IPC', () => {
  it('已连接时从当前数据目录打开系统选择器，取消后返回后台更新后的最新状态', async () => {
    const currentState: BootstrapState = {
      kind: 'ready',
      dataDirectory: '/Volumes/Orders/闲鱼订单数据',
      orders: [],
    };
    const latestState: BootstrapState = {
      ...currentState,
      orders: [{ id: 'background-order' } as never],
    };
    const getState = vi
      .fn<() => BootstrapState>()
      .mockReturnValueOnce(currentState)
      .mockReturnValue(latestState);
    const useDataDirectory = vi.fn();
    registerIpcHandlers({
      getState,
      useDataDirectory,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    });

    const result = await invoke('app:select-data-directory');

    expect(electronBoundary.showOpenDialog).toHaveBeenCalledWith(
      electronBoundary.window,
      expect.objectContaining({
        title: '选择闲鱼订单数据目录',
        defaultPath: currentState.dataDirectory,
      }),
    );
    expect(result).toEqual(latestState);
    expect(getState).toHaveBeenCalledTimes(2);
    expect(useDataDirectory).not.toHaveBeenCalled();
  });

  it('首次设置仍从系统文档目录下的建议位置打开选择器', async () => {
    const currentState: BootstrapState = { kind: 'needs_data_directory' };
    registerIpcHandlers({
      getState: vi.fn(() => currentState),
      useDataDirectory: vi.fn(),
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    });

    await invoke('app:select-data-directory');

    expect(electronBoundary.showOpenDialog).toHaveBeenCalledWith(
      electronBoundary.window,
      expect.objectContaining({
        defaultPath: '/Users/test/Documents/闲鱼订单数据',
      }),
    );
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`未注册 IPC：${channel}`);
  return handler({ sender: {} }, ...args);
}
