import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopSession } from '../src/main/desktop-session';

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn((name: string) => name === 'exe' ? process.execPath : '/Users/test'),
    getVersion: vi.fn(() => '0.2.68'),
  },
  BrowserWindow: class MockBrowserWindow {
    public static getAllWindows(): unknown[] { return []; }
    public static fromWebContents(): unknown { return { isDestroyed: () => false }; }
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
  nativeImage: { createFromBuffer: vi.fn() },
}));

import { registerIpcHandlers } from '../src/main/electron-main';

afterEach(() => electronBoundary.handlers.clear());

describe('来源截图生命周期 Electron IPC', () => {
  it('只暴露受约束策略、清理预览、二次确认与单张清理入口', async () => {
    const preview = {
      enabled: true,
      cleanupAfterDays: 180 as const,
      candidateCount: 1,
      estimatedBytes: 4096,
      candidates: [{
        screenshotId: 'shot-1', originalName: '来源.png',
        createdAt: '2026-01-01T00:00:00.000Z', currentBytes: 4096,
      }],
      previewToken: 'preview-token',
    };
    const session = fakeSession({
      getSourceScreenshotLifecycleSettings: vi.fn(() => ({ cleanupAfterDays: null })),
      saveSourceScreenshotLifecycleSettings: vi.fn((input) => input),
      previewSourceScreenshotCleanup: vi.fn(async () => preview),
      confirmSourceScreenshotCleanup: vi.fn(async () => ({
        deletedCount: 1, releasedBytes: 4096,
      })),
      previewSingleSourceScreenshotDelete: vi.fn(async () => ({
        screenshotId: 'shot-1', originalName: '来源.png', currentBytes: 4096,
      })),
      deleteSourceScreenshot: vi.fn(async () => ({ deletedCount: 1, releasedBytes: 4096 })),
    });
    registerIpcHandlers(session);

    await expect(invoke('source-screenshots:get-lifecycle-settings'))
      .resolves.toEqual({ cleanupAfterDays: null });
    await expect(invoke('source-screenshots:save-lifecycle-settings', { cleanupAfterDays: 180 }))
      .resolves.toEqual({ cleanupAfterDays: 180 });
    await expect(invoke('source-screenshots:save-lifecycle-settings', { cleanupAfterDays: 90 }))
      .rejects.toThrow('只能选择永不清理、180 天或 365 天');
    await expect(invoke('source-screenshots:preview-cleanup')).resolves.toEqual(preview);
    await expect(invoke('source-screenshots:confirm-cleanup', 'preview-token'))
      .resolves.toEqual({ deletedCount: 1, releasedBytes: 4096 });
    await expect(invoke('source-screenshots:preview-single-delete', 'shot-1'))
      .resolves.toMatchObject({ screenshotId: 'shot-1', currentBytes: 4096 });
    await expect(invoke('source-screenshots:delete', 'shot-1'))
      .resolves.toEqual({ deletedCount: 1, releasedBytes: 4096 });
  });
});

function fakeSession(members: Record<string, unknown>): DesktopSession {
  return {
    onRecognitionBatchesChanged: vi.fn(),
    onOrdersChanged: vi.fn(),
    ...members,
  } as unknown as DesktopSession;
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`未注册 IPC：${channel}`);
  return handler({ sender: {} }, ...args);
}
