import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopSession } from '../src/main/desktop-session';
import type { MobileUploadService } from '../src/main/mobile-upload-service';

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
      if (name === 'exe') return process.execPath;
      return '/Users/test/Library/Application Support/闲鱼订单管理';
    }),
    getVersion: vi.fn(() => '0.2.66'),
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
});

describe('手机上传 Electron IPC', () => {
  it('渲染层只能读取、开启或立即关闭手机上传会话', async () => {
    const active = {
      enabled: true as const,
      url: 'http://192.168.1.2:41234/?session=secret',
      qrDataUrl: 'data:image/png;base64,cXI=',
      accessCode: '482913',
      expiresAt: '2026-08-21T08:10:00.000Z',
    };
    const mobileUpload = {
      getStatus: vi.fn(() => ({ enabled: false as const })),
      start: vi.fn(async () => active),
      stop: vi.fn(async () => undefined),
    } as unknown as MobileUploadService;
    registerIpcHandlers(fakeSession(), mobileUpload);

    await expect(invoke('mobile-upload:get-status')).resolves.toEqual({ enabled: false });
    await expect(invoke('mobile-upload:start')).resolves.toEqual(active);
    await expect(invoke('mobile-upload:stop')).resolves.toEqual({ enabled: false });

    expect(mobileUpload.getStatus).toHaveBeenCalledTimes(2);
    expect(mobileUpload.start).toHaveBeenCalledTimes(1);
    expect(mobileUpload.stop).toHaveBeenCalledTimes(1);
  });

  it('切换数据目录前立即关闭手机上传会话', async () => {
    const mobileUpload = {
      getStatus: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    } as unknown as MobileUploadService;
    const useDataDirectory = vi.fn(() => ({
      kind: 'ready' as const,
      dataDirectory: '/Users/test/Documents/新闲鱼订单数据',
      orders: [],
    }));
    registerIpcHandlers(fakeSession({ useDataDirectory }), mobileUpload);
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/test/Documents/新闲鱼订单数据'],
    });

    await invoke('app:select-data-directory');

    expect(mobileUpload.stop).toHaveBeenCalledTimes(1);
    expect(useDataDirectory).toHaveBeenCalledWith('/Users/test/Documents/新闲鱼订单数据');
  });
});

function fakeSession(members: Record<string, unknown> = {}): DesktopSession {
  return {
    getState: vi.fn(() => ({
      kind: 'ready',
      dataDirectory: '/Users/test/Documents/闲鱼订单数据',
      orders: [],
    })),
    onRecognitionBatchesChanged: vi.fn(),
    onOrdersChanged: vi.fn(),
    ...members,
  } as unknown as DesktopSession;
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`未注册 IPC：${channel}`);
  return handler({ sender: 'web-contents' }, ...args);
}
