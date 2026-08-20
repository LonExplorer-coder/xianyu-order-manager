import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import { PERMANENT_DELETE_CONFIRMATION } from '../src/core/order-lifecycle';
import type { RecognitionResult } from '../src/core/contracts';
import { DesktopSession } from '../src/main/desktop-session';
import { LocalApplication } from '../src/main/local-application';
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

const sessions: DesktopSession[] = [];

afterEach(() => {
  electronBoundary.handlers.clear();
  for (const session of sessions.splice(0)) session.close();
});

describe('订单回收站 Electron IPC', () => {
  it('端口边界校验版本与永久删除确认，每次操作通知订单刷新', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-lifecycle-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '回收站订单.png');
    await writeFile(sourcePath, Buffer.from('order-lifecycle-ipc'));
    const recognition = completeRecognition();
    const seeder = new LocalApplication(new ControlledRecognizer(recognition));
    seeder.openDataDirectory(dataDirectory);
    const [draft] = (await seeder.submitRecognitionBatch([sourcePath])).drafts;
    const order = seeder.confirmDraft(draft);
    seeder.close();

    const session = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      new ControlledRecognizer(recognition),
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(dataDirectory);
    const ordersChanged = vi.fn();
    session.onOrdersChanged(ordersChanged);
    registerIpcHandlers(session);

    await expect(invoke('orders:move-to-trash', {
      orderId: order.id,
      expectedRevision: 0,
    })).rejects.toThrow('订单版本格式无效');
    await expect(invoke('orders:move-to-trash', {
      orderId: order.id,
      expectedRevision: order.revision,
      lifecycleStatus: 'deleted',
    })).rejects.toThrow('未知字段：lifecycleStatus');

    const trashed = await invoke('orders:move-to-trash', {
      orderId: order.id,
      expectedRevision: order.revision,
    }) as ReturnType<DesktopSession['getOrder']>;
    expect(trashed.order).toMatchObject({ lifecycleStatus: 'trashed', revision: 2 });
    await expect(invoke('orders:permanently-delete', {
      orderId: order.id,
      expectedRevision: 2,
      confirmation: '删除',
    })).rejects.toThrow('请确认输入“永久删除”');
    expect(session.getOrder(order.id).order.lifecycleStatus).toBe('trashed');

    const restored = await invoke('orders:restore-from-trash', {
      orderId: order.id,
      expectedRevision: 2,
    }) as ReturnType<DesktopSession['getOrder']>;
    expect(restored.order).toMatchObject({ lifecycleStatus: 'active', revision: 3 });
    const trashedAgain = await invoke('orders:move-to-trash', {
      orderId: order.id,
      expectedRevision: 3,
    }) as ReturnType<DesktopSession['getOrder']>;
    const deleted = await invoke('orders:permanently-delete', {
      orderId: order.id,
      expectedRevision: trashedAgain.order.revision,
      confirmation: PERMANENT_DELETE_CONFIRMATION,
    }) as ReturnType<DesktopSession['getOrder']>;
    expect(deleted.order).toMatchObject({ lifecycleStatus: 'deleted', revision: 5 });
    expect(ordersChanged).toHaveBeenCalledTimes(4);
    expect(ordersChanged).toHaveBeenLastCalledWith([]);
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}

function completeRecognition(): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber: 'XY-LIFECYCLE-IPC-001',
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient: '测试收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-20 08:00:00',
    orderedAtNormalized: '2026-08-20T08:00:00+08:00',
    paidAtOriginal: '2026-08-20 08:00:08',
    paidAtNormalized: '2026-08-20T08:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '测试商品',
      sourceSpec: '标准款',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}

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
