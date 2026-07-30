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
  },
  dialog: { showOpenDialog: vi.fn() },
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
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({}, ...args);
}
