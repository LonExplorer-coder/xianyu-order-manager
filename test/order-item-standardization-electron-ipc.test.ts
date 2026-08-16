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
}));

import { registerIpcHandlers } from '../src/main/electron-main';

afterEach(() => electronBoundary.handlers.clear());

describe('订单商品单笔关联 Electron IPC', () => {
  it('按受控字段透传单笔关联修改并拒绝未知字段、冲突偏好与无效标识', async () => {
    const details = { order: { id: 'order-ipc-1', revision: 4 } };
    const updateOrderItemStandardization = vi.fn().mockReturnValue(details);
    registerIpcHandlers({
      updateOrderItemStandardization,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    await expect(invoke(
      'orders:update-item-standardization',
      ' order-ipc-1 ',
      'item-ipc-1',
      { standardProductId: 'product-ipc-1', expectedRevision: 3 },
    )).resolves.toEqual(details);
    expect(updateOrderItemStandardization).toHaveBeenCalledWith(
      'order-ipc-1',
      'item-ipc-1',
      { standardProductId: 'product-ipc-1', expectedRevision: 3 },
    );

    await invoke(
      'orders:update-item-standardization',
      'order-ipc-1',
      'item-ipc-1',
      {
        standardProductId: 'product-ipc-1',
        standardDisplayPreference: 'prefer_source',
        expectedRevision: 4,
      },
    );
    expect(updateOrderItemStandardization).toHaveBeenLastCalledWith(
      'order-ipc-1',
      'item-ipc-1',
      {
        standardProductId: 'product-ipc-1',
        standardDisplayPreference: 'prefer_source',
        expectedRevision: 4,
      },
    );

    await expect(invoke(
      'orders:update-item-standardization',
      'order-ipc-1',
      'item-ipc-1',
      { standardProductId: 'product-ipc-1', expectedRevision: 4, unexpected: true },
    )).rejects.toThrow('商品标准化修改包含未知字段');
    await expect(invoke(
      'orders:update-item-standardization',
      'order-ipc-1',
      'item-ipc-1',
      {
        standardProductId: null,
        standardDisplayPreference: 'prefer_standard',
        expectedRevision: 4,
      },
    )).rejects.toThrow('解除商品标准化关联时不能设置标准商品显示偏好');
    await expect(invoke(
      'orders:update-item-standardization',
      'order-ipc-1',
      'item-ipc-1',
      {
        standardProductId: 'product-ipc-1',
        standardDisplayPreference: 'sometimes',
        expectedRevision: 4,
      },
    )).rejects.toThrow('标准商品显示偏好无效');
    await expect(invoke(
      'orders:update-item-standardization',
      '',
      'item-ipc-1',
      { standardProductId: 'product-ipc-1', expectedRevision: 4 },
    )).rejects.toThrow('订单 ID 格式无效');
    await expect(invoke(
      'orders:update-item-standardization',
      'order-ipc-1',
      42,
      { standardProductId: 'product-ipc-1', expectedRevision: 4 },
    )).rejects.toThrow('订单商品 ID 格式无效');
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}
