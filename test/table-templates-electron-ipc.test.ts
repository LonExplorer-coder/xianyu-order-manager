import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import { DesktopSession } from '../src/main/desktop-session';
import { OcrSettingsService } from '../src/main/ocr-settings';
import { Preferences } from '../src/main/preferences';

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showSaveDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class MockBrowserWindow {
    public static getAllWindows(): unknown[] {
      return [];
    }

    public static fromWebContents(): unknown {
      return { isDestroyed: () => false };
    }
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: electronBoundary.showSaveDialog,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
}));

import { registerIpcHandlers } from '../src/main/electron-main';

const sessions: DesktopSession[] = [];
const unusedRecognition: RecognitionResult = {
  platform: 'xianyu', sellerAccount: '默认闲鱼账号', orderNumber: 'unused',
  alipayTransactionNumber: '', buyerNickname: '', recipient: 'unused', phone: 'unused',
  phoneNormalized: '', addressOriginal: 'unused', addressNormalized: '', province: '',
  city: '', district: '', orderedAtOriginal: '', orderedAtNormalized: '',
  paidAtOriginal: '', paidAtNormalized: '', productTotalCents: 0, shippingFeeCents: 0,
  amountCents: 0, platformTransactionStatus: 'paid', fulfillmentStatus: 'pending_shipment',
  items: [],
};
const unusedOcrSettings = new OcrSettingsService(
  { read: () => null, write: () => undefined },
  {
    getApiKey: async () => null,
    setApiKey: async () => undefined,
    deleteApiKey: async () => undefined,
    getDisplayName: () => '测试系统凭据库',
  },
  { testConnection: async () => ({ model: 'qwen3.5-ocr' }) },
);

afterEach(() => {
  electronBoundary.handlers.clear();
  electronBoundary.showSaveDialog.mockReset();
  for (const session of sessions.splice(0)) session.close();
});

describe('表格模板 Electron IPC', () => {
  it('只暴露受校验的 CRUD 通道', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-template-ipc-'));
    const session = new DesktopSession(
      new Preferences(join(testRoot, '启动配置')),
      new ControlledRecognizer(unusedRecognition),
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(join(testRoot, '订单数据'));
    registerIpcHandlers(session);

    expect(await invoke('orders:query', {}, [])).toEqual(expect.objectContaining({
      customFieldValues: [],
    }));
    expect(await invoke('order-items:query', {}, [])).toEqual(expect.objectContaining({
      customFieldValues: [],
    }));
    expect(await invoke('order-items:query', {
      sourceTitle: '海棠杯',
      sourceSpec: '蓝色 300ml',
      unitPriceCents: 1_200,
      quantity: 1,
      quantitySource: 'system_default_1',
      sortField: 'unit_price',
      sortDirection: 'desc',
    }, [])).toEqual(expect.objectContaining({ items: [] }));
    await expect(invoke('orders:query', { fulfillmentStatus: 'delivered' }, []))
      .resolves.toEqual(expect.objectContaining({ orders: [] }));
    await expect(invoke('orders:query', { fulfillmentStatus: 'returned' }, []))
      .rejects.toThrow('订单工作台履约状态格式无效');
    await expect(invoke('orders:query', {}, 'field-1'))
      .rejects.toThrow(/自定义字段/);
    await expect(invoke('orders:query', {}, ['']))
      .rejects.toThrow(/自定义字段/);
    await expect(invoke('order-items:query', {}, ['field-1', 'field-1']))
      .rejects.toThrow(/重复/);
    await expect(invoke('order-items:query', {}, ['x'.repeat(129)]))
      .rejects.toThrow(/自定义字段/);

    const valid = {
      name: '待发货订单',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
      ],
      query: { fulfillmentStatus: 'pending_shipment' },
    };
    const created = await invoke('table-templates:create', valid) as { id: string };
    expect(await invoke('table-templates:list', 'order')).toEqual([
      expect.objectContaining({ id: created.id, name: '待发货订单' }),
    ]);

    await expect(invoke('table-templates:create', {
      ...valid,
      formula: 'amount * quantity',
    })).rejects.toThrow(/未知属性/);
    await expect(invoke('table-templates:create', {
      ...valid,
      columns: [{
        field: { kind: 'builtin', key: 'order_number', expression: '1 + 1' },
        displayName: '订单号',
      }],
    })).rejects.toThrow(/未知属性/);
    await expect(invoke('table-templates:create', {
      ...valid,
      columns: [{ field: { kind: 'builtin', key: 'unknown' }, displayName: '未知' }],
    })).rejects.toThrow(/字段无效/);
    await expect(invoke('table-templates:update', '', {
      name: '新名称', columns: valid.columns, query: {},
    })).rejects.toThrow(/ID/);

    const updated = await invoke('table-templates:update', created.id, {
      name: '待发货清单',
      columns: valid.columns,
      query: {},
    });
    expect(updated).toEqual(expect.objectContaining({
      id: created.id,
      name: '待发货清单',
      granularity: 'order',
    }));

    await expect(invoke('table-templates:delete', 'x'.repeat(201)))
      .rejects.toThrow(/ID/);
    await invoke('table-templates:delete', created.id);
    expect(await invoke('table-templates:list')).toEqual([]);
  });

  it('导出通道严格校验范围和模板，并把保存窗口取消视为正常结果', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-export-ipc-'));
    const session = new DesktopSession(
      new Preferences(join(testRoot, '启动配置')),
      new ControlledRecognizer(unusedRecognition),
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(join(testRoot, '订单数据'));
    registerIpcHandlers(session);

    const valid = {
      scope: { kind: 'current_result', orderIds: ['order-1'] },
      orderTemplateId: null,
      includeOrderItems: false,
      orderItemTemplateId: null,
      masking: 'default',
    };
    await expect(invoke('orders:export', { ...valid, destinationPath: '/tmp/leak.xlsx' }))
      .rejects.toThrow(/未知属性/);
    await expect(invoke('orders:export', {
      ...valid,
      scope: { kind: 'current_result', orderIds: [] },
    })).rejects.toThrow(/至少选择/);
    await expect(invoke('orders:export', {
      ...valid,
      scope: { kind: 'selected_orders', orderIds: ['order-1', 'order-1'] },
    })).rejects.toThrow(/重复/);
    await expect(invoke('orders:export', { ...valid, orderTemplateId: 42 }))
      .rejects.toThrow(/模板/);
    await expect(invoke('orders:export', { ...valid, masking: 'none' }))
      .rejects.toThrow(/脱敏/);
    await expect(invoke('orders:export', { ...valid, includeOrderItems: '是' }))
      .rejects.toThrow(/订单商品明细表导出选项/);

    const preview = {
      orderCount: 1,
      orderItemCount: null,
      sheets: [{
        name: '订单总表' as const,
        columns: [{ header: '系统订单编号', valueType: 'text' as const }],
        rows: [['20260813-000001']],
        totalRowCount: 1,
      }],
    };
    const previewOrderExport = vi.spyOn(session, 'previewOrderExport')
      .mockReturnValue(preview);
    electronBoundary.showSaveDialog.mockClear();
    await expect(invoke('orders:preview-export', valid)).resolves.toEqual(preview);
    expect(previewOrderExport).toHaveBeenCalledWith(valid);
    expect(electronBoundary.showSaveDialog).not.toHaveBeenCalled();
    await expect(invoke('orders:preview-export', { ...valid, unknown: true }))
      .rejects.toThrow(/未知属性/);

    electronBoundary.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
    await expect(invoke('orders:export', valid)).resolves.toEqual({ kind: 'cancelled' });
    expect(electronBoundary.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: '导出订单 Excel',
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
      }),
    );
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}
