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

describe('商品映射管理 Electron IPC', () => {
  it('映射列表、统计与四种管理操作只通过受控字段传递', async () => {
    const mappingView = {
      id: 'mapping-ipc-1',
      sourceTitle: 'IPC 映射原文',
      sourceSpec: '规格一',
      sourceTitleKey: 'ipc 映射原文',
      sourceSpecKey: '规格一',
      standardProductId: 'product-ipc-1',
      targetProductSku: 'SKU-IPC-001',
      targetProductName: 'IPC 标准商品',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
      status: 'active',
      origin: 'manual',
      lastUsedAt: null,
      createdAt: '2026-08-16T10:00:00.000Z',
      updatedAt: '2026-08-16T10:00:00.000Z',
      hitOrderCount: 2,
    };
    const stats = {
      activeMappingCount: 1,
      linkedOrderCount: 2,
      linkedItemCount: 3,
      linkedTotalQuantity: 5,
    };
    const listProductMappings = vi.fn().mockReturnValue([mappingView]);
    const listProductMappingEvents = vi.fn().mockReturnValue([{
      id: 'mapping-event-ipc-1',
      mappingId: 'mapping-ipc-1',
      standardProductId: 'product-ipc-1',
      eventType: 'created',
      before: null,
      after: null,
      origin: 'manual',
      reason: '',
      occurredAt: '2026-08-16T10:00:00.000Z',
      createdAt: '2026-08-16T10:00:00.000Z',
    }]);
    const getProductMappingStats = vi.fn().mockReturnValue(stats);
    const createProductMapping = vi.fn().mockReturnValue(mappingView);
    const correctProductMapping = vi.fn().mockReturnValue({
      ...mappingView,
      standardProductId: 'product-ipc-2',
    });
    const disableProductMapping = vi.fn().mockReturnValue({
      ...mappingView,
      status: 'disabled',
    });
    const deleteProductMapping = vi.fn();
    const findProductMappingConflict = vi.fn().mockReturnValue(mappingView);
    registerIpcHandlers({
      listProductMappings,
      listProductMappingEvents,
      getProductMappingStats,
      createProductMapping,
      findProductMappingConflict,
      correctProductMapping,
      disableProductMapping,
      deleteProductMapping,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    await expect(invoke('products:list-mappings', 'product-ipc-1', ' 映射原文 '))
      .resolves.toEqual([mappingView]);
    expect(listProductMappings).toHaveBeenCalledWith('product-ipc-1', '映射原文');
    await expect(invoke('products:list-mappings', 'product-ipc-1'))
      .resolves.toEqual([mappingView]);
    expect(listProductMappings).toHaveBeenLastCalledWith('product-ipc-1', undefined);
    await expect(invoke('products:list-mappings', '')).rejects.toThrow('标准商品 ID 格式无效');

    await expect(invoke('products:mapping-stats', 'product-ipc-1')).resolves.toEqual(stats);
    expect(getProductMappingStats).toHaveBeenCalledWith('product-ipc-1');

    const events = await invoke('products:list-mapping-events', 'product-ipc-1');
    expect(events).toHaveLength(1);
    expect(listProductMappingEvents).toHaveBeenCalledWith('product-ipc-1');
    await expect(invoke('products:list-mapping-events', '')).rejects.toThrow('标准商品 ID 格式无效');

    await expect(invoke('products:create-mapping', 'product-ipc-1', {
      sourceTitle: '  IPC 映射原文 ',
      sourceSpec: ' 规格一 ',
      scope: 'current_account',
      platform: ' xianyu ',
      sellerAccount: ' 映射账号甲 ',
    })).resolves.toEqual(mappingView);
    expect(createProductMapping).toHaveBeenCalledWith('product-ipc-1', {
      sourceTitle: 'IPC 映射原文',
      sourceSpec: '规格一',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
    });
    await expect(invoke('products:create-mapping', 'product-ipc-1', {
      sourceTitle: 'IPC 映射原文',
      sourceSpec: '规格一',
      scope: 'workspace',
      platform: 'xianyu',
    })).rejects.toThrow('工作区级映射不能包含平台或卖家账号');

    await expect(invoke('products:find-mapping-conflict', {
      sourceTitle: ' IPC 映射原文 ',
      sourceSpec: ' 规格一 ',
      platform: ' xianyu ',
      sellerAccount: ' 映射账号甲 ',
    })).resolves.toEqual(mappingView);
    expect(findProductMappingConflict).toHaveBeenCalledWith({
      sourceTitle: 'IPC 映射原文',
      sourceSpec: '规格一',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
    });
    await expect(invoke('products:find-mapping-conflict', {
      sourceTitle: 'IPC 映射原文',
      sourceSpec: '规格一',
      platform: 'xianyu',
    })).rejects.toThrow('商品映射冲突查询必须提供平台与卖家账号');
    await expect(invoke('products:find-mapping-conflict', {
      sourceTitle: 'IPC 映射原文',
      sourceSpec: '规格一',
      platform: 'xianyu',
      sellerAccount: '映射账号甲',
      scope: 'workspace',
    })).rejects.toThrow('商品映射冲突查询包含未知字段');

    await expect(invoke('products:correct-mapping', 'mapping-ipc-1', {
      standardProductId: ' product-ipc-2 ',
      reason: ' 目标选错了 ',
    })).resolves.toMatchObject({ standardProductId: 'product-ipc-2' });
    expect(correctProductMapping).toHaveBeenCalledWith('mapping-ipc-1', {
      standardProductId: 'product-ipc-2',
      reason: '目标选错了',
    });
    await expect(invoke('products:correct-mapping', 'mapping-ipc-1', {
      reason: '没有内容',
    })).rejects.toThrow('商品映射更正内容为空');

    await expect(invoke('products:disable-mapping', 'mapping-ipc-1', {
      reason: ' 不再销售 ',
    })).resolves.toMatchObject({ status: 'disabled' });
    expect(disableProductMapping).toHaveBeenCalledWith('mapping-ipc-1', { reason: '不再销售' });
    await expect(invoke('products:disable-mapping', 'mapping-ipc-1', { reason: ' ' }))
      .rejects.toThrow('映射变更原因无效');

    await expect(invoke('products:delete-mapping', 'mapping-ipc-1', {
      reason: ' 录入错误 ',
    })).resolves.toBeUndefined();
    expect(deleteProductMapping).toHaveBeenCalledWith('mapping-ipc-1', { reason: '录入错误' });
    await expect(invoke('products:delete-mapping', 'mapping-ipc-1', {
      reason: '录入错误',
      unexpected: true,
    })).rejects.toThrow('商品映射操作包含未知字段');
  });

  it('历史候选预览与批量更正只通过受控字段传递', async () => {
    const preview = {
      mapping: { id: 'mapping-ipc-history-1' },
      targetProduct: { id: 'product-ipc-2', sku: 'SKU-IPC-002' },
      items: [],
      orderCount: 0,
      itemCount: 0,
      totalQuantity: 0,
      shippedOrderCount: 0,
      aftersalesOrderCount: 0,
    };
    const correctionResult = {
      correctionId: 'correction-ipc-1',
      appliedItemCount: 2,
      orderCount: 1,
      results: [],
    };
    const previewProductMappingHistoryCandidates = vi.fn().mockReturnValue(preview);
    const relinkProductMappingHistoryCandidates = vi.fn().mockReturnValue(correctionResult);
    registerIpcHandlers({
      previewProductMappingHistoryCandidates,
      relinkProductMappingHistoryCandidates,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    await expect(invoke('products:preview-mapping-history', ' mapping-ipc-history-1 '))
      .resolves.toEqual(preview);
    expect(previewProductMappingHistoryCandidates).toHaveBeenCalledWith('mapping-ipc-history-1');
    await expect(invoke('products:preview-mapping-history', ''))
      .rejects.toThrow(/格式无效/u);

    await expect(invoke('products:relink-mapping-history', 'mapping-ipc-history-1', {
      itemIds: [' item-1 ', 'item-2'],
      reason: ' 统一更正为新 SKU ',
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 2 }],
    })).resolves.toEqual(correctionResult);
    expect(relinkProductMappingHistoryCandidates).toHaveBeenCalledWith(
      'mapping-ipc-history-1',
      {
        itemIds: ['item-1', 'item-2'],
        reason: '统一更正为新 SKU',
        expectedOrderRevisions: [{ orderId: 'order-1', revision: 2 }],
      },
    );
    await expect(invoke('products:relink-mapping-history', 'mapping-ipc-history-1', {
      itemIds: ['item-1'],
      reason: '更正',
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 2 }],
      unexpected: true,
    })).rejects.toThrow('商品身份更正包含未知字段');
    await expect(invoke('products:relink-mapping-history', 'mapping-ipc-history-1', {
      itemIds: ['item-1'],
      reason: ' ',
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 2 }],
    })).rejects.toThrow('映射变更原因无效');
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}
