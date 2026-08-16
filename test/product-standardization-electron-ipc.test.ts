import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrderDraft } from '../src/core/contracts';
import { DesktopSession } from '../src/main/desktop-session';

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

describe('标准商品 Electron IPC', () => {
  it('只通过受控字段维护商品并传递订单校对选择', async () => {
    const product = {
      id: 'product-ipc-1',
      sku: 'SKU-IPC-001',
      name: 'IPC 标准商品',
      specification: '标准规格',
      defaultOrderPriceCents: 800,
      revision: 1,
      createdAt: '2026-08-14T10:00:00.000Z',
      updatedAt: '2026-08-14T10:00:00.000Z',
    };
    const priceEvent = {
      id: 'price-event-ipc-1',
      standardProductId: product.id,
      previousDefaultOrderPriceCents: null,
      defaultOrderPriceCents: 800,
      reason: '首次定价',
      occurredAt: '2026-08-14T10:00:00.000Z',
      createdAt: '2026-08-14T10:00:00.000Z',
    };
    const createStandardProduct = vi.fn().mockReturnValue(product);
    const updateStandardProduct = vi.fn().mockReturnValue({ ...product, revision: 2 });
    const listStandardProductPriceEvents = vi.fn().mockReturnValue([priceEvent]);
    const previewDraftProductStandardizations = vi.fn().mockReturnValue([]);
    const confirmDraft = vi.fn().mockReturnValue({ order: {}, resolution: 'new_order' });
    registerIpcHandlers({
      listStandardProducts: vi.fn().mockReturnValue([product]),
      createStandardProduct,
      updateStandardProduct,
      listStandardProductPriceEvents,
      previewDraftProductStandardizations,
      confirmDraft,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    await expect(invoke('products:list')).resolves.toEqual([product]);
    await expect(invoke('products:create', {
      sku: '  SKU-IPC-001  ',
      name: ' IPC 标准商品 ',
      specification: ' 标准规格 ',
    })).resolves.toEqual(product);
    expect(createStandardProduct).toHaveBeenCalledWith({
      sku: 'SKU-IPC-001',
      name: 'IPC 标准商品',
      specification: '标准规格',
    });
    await expect(invoke('products:create', {
      sku: 'SKU-IPC-003',
      name: '定价商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: ' 首次定价 ',
    })).resolves.toEqual(product);
    expect(createStandardProduct).toHaveBeenCalledWith({
      sku: 'SKU-IPC-003',
      name: '定价商品',
      specification: '规格',
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
    await expect(invoke('products:create', {
      sku: 'SKU-IPC-002',
      name: '非法商品',
      specification: '规格',
      script: 'unexpected',
    })).rejects.toThrow('标准商品包含未知字段');

    await expect(invoke('products:update', product.id, {
      sku: product.sku,
      name: product.name,
      specification: product.specification,
      expectedRevision: 1,
    })).rejects.toThrow('默认订单单价无效');
    await expect(invoke('products:update', product.id, {
      sku: product.sku,
      name: product.name,
      specification: product.specification,
      defaultOrderPriceCents: 900,
      priceChangeReason: ' 调价 ',
      expectedRevision: 1,
    })).resolves.toMatchObject({ revision: 2 });
    expect(updateStandardProduct).toHaveBeenCalledWith(product.id, {
      sku: product.sku,
      name: product.name,
      specification: product.specification,
      defaultOrderPriceCents: 900,
      priceChangeReason: '调价',
      expectedRevision: 1,
    });

    await expect(invoke('products:price-events', product.id)).resolves.toEqual([priceEvent]);
    expect(listStandardProductPriceEvents).toHaveBeenCalledWith(product.id);

    const draft = { id: 'draft-ipc-1' } as OrderDraft;
    await expect(invoke('products:preview-draft-standardizations', draft)).resolves.toEqual([]);
    expect(previewDraftProductStandardizations).toHaveBeenCalledWith(draft);
    await expect(invoke(
      'workflow:confirm-draft',
      draft,
      undefined,
      [{
        draftItemId: 'item-ipc-1',
        standardProductId: product.id,
        createMapping: true,
      }],
    )).resolves.toMatchObject({ resolution: 'new_order' });
    expect(confirmDraft).toHaveBeenCalledWith(draft, undefined, [{
      draftItemId: 'item-ipc-1',
      standardProductId: product.id,
      createMapping: true,
    }]);
    await expect(invoke(
      'workflow:confirm-draft',
      draft,
      undefined,
      [{
        draftItemId: 'item-ipc-1',
        standardProductId: product.id,
        createMapping: true,
        unexpected: true,
      }],
    )).rejects.toThrow('商品标准化确认包含未知字段');
  });

  it('预览结果携带映射命中级别通过 IPC 边界', async () => {
    const product = {
      id: 'product-ipc-mapping',
      sku: 'SKU-IPC-MAPPING',
      name: 'IPC 映射商品',
      specification: '标准规格',
      defaultOrderPriceCents: null,
      revision: 1,
      createdAt: '2026-08-14T10:00:00.000Z',
      updatedAt: '2026-08-14T10:00:00.000Z',
    };
    const preview = [{
      draftItemId: 'item-ipc-mapping',
      sourceTitle: 'IPC 映射原文',
      sourceSpec: '标准规格',
      automaticProduct: product,
      automaticSource: 'mapping',
      automaticMappingScope: 'current_account',
      candidates: [],
    }];
    const previewDraftProductStandardizations = vi.fn().mockReturnValue(preview);
    registerIpcHandlers({
      previewDraftProductStandardizations,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    const draft = { id: 'draft-ipc-mapping' } as OrderDraft;
    await expect(invoke('products:preview-draft-standardizations', draft)).resolves.toEqual(preview);
    expect(previewDraftProductStandardizations).toHaveBeenCalledWith(draft);
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}
