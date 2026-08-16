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

const options = {
  standardDisplayPreference: 'prefer_standard',
  useDefaultOrderPrice: false,
  updateProductTotal: false,
};

describe('订单商品批量关联 Electron IPC', () => {
  it('按受控字段透传预览请求并拒绝未知字段', async () => {
    const preview = { itemCount: 2 };
    const previewOrderItemStandardizationBatch = vi.fn().mockReturnValue(preview);
    registerIpcHandlers({
      previewOrderItemStandardizationBatch,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    await expect(invoke('order-items:preview-standardization-batch', {
      itemIds: [' item-1 ', 'item-2'],
      standardProductId: ' product-1 ',
      options,
    })).resolves.toEqual(preview);
    expect(previewOrderItemStandardizationBatch).toHaveBeenCalledWith({
      itemIds: ['item-1', 'item-2'],
      standardProductId: 'product-1',
      options,
    });

    await expect(invoke('order-items:preview-standardization-batch', {
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options,
      createMapping: true,
    })).rejects.toThrow('批量关联包含未知字段');
    await expect(invoke('order-items:preview-standardization-batch', {
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options: { ...options, standardDisplayPreference: 'sometimes' },
    })).rejects.toThrow('标准商品显示偏好无效');
    await expect(invoke('order-items:preview-standardization-batch', {
      itemIds: ['item-1', 'item-1'],
      standardProductId: 'product-1',
      options,
    })).rejects.toThrow('批量关联商品明细不能重复');
    await expect(invoke('order-items:preview-standardization-batch', {
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options: { ...options, updateProductTotal: true },
    })).rejects.toThrow('未使用标准商品默认单价时不能同步商品总价');
  });

  it('按受控字段透传执行请求并拒绝无效的逐条确认与版本快照', async () => {
    const applied = { appliedItemCount: 1 };
    const applyOrderItemStandardizationBatch = vi.fn().mockReturnValue(applied);
    registerIpcHandlers({
      applyOrderItemStandardizationBatch,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    await expect(invoke('order-items:apply-standardization-batch', {
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options,
      confirmedOverrideItemIds: ['item-1'],
      confirmedAmountMismatchOrderIds: ['order-1'],
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 2 }],
    })).resolves.toEqual(applied);
    expect(applyOrderItemStandardizationBatch).toHaveBeenCalledWith({
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options,
      confirmedOverrideItemIds: ['item-1'],
      confirmedAmountMismatchOrderIds: ['order-1'],
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 2 }],
    });

    await expect(invoke('order-items:apply-standardization-batch', {
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options,
      confirmedOverrideItemIds: ['item-2'],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 2 }],
    })).rejects.toThrow('批量关联覆盖确认超出了所选商品明细');
    await expect(invoke('order-items:apply-standardization-batch', {
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 0 }],
    })).rejects.toThrow('订单版本无效，请刷新后重试');
    await expect(invoke('order-items:apply-standardization-batch', {
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options,
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 2 }],
    })).rejects.toThrow('批量关联缺少字段');
  });

  it('订单商品明细查询接受相似标题规格筛选并拒绝未知字段', async () => {
    const queryOrderItems = vi.fn().mockReturnValue({ items: [], customFieldValues: [] });
    registerIpcHandlers({
      queryOrderItems,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    await expect(invoke('order-items:query', { similarText: ' 十二分娃鞋白胚 ' }, []))
      .resolves.toEqual({ items: [], customFieldValues: [] });
    expect(queryOrderItems).toHaveBeenCalledWith({ similarText: '十二分娃鞋白胚' }, []);

    await expect(invoke('order-items:query', { similarText: 42 }, []))
      .rejects.toThrow('商品工作台原始文本格式无效');
    await expect(invoke('order-items:query', { unknownFilter: 'x' }, []))
      .rejects.toThrow('订单商品明细工作台查询包含未知字段');
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}
