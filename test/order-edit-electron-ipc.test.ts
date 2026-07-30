import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { OrderEditInput, OriginalOrder, RecognitionResult } from '../src/core/contracts';
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

describe('订单人工修改 Electron IPC', () => {
  it('只通过受校验通道保存可编辑字段并拒绝状态、未知字段和非法商品标识', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-edit-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '待修改订单.png');
    await writeFile(sourcePath, Buffer.from('order-edit-ipc'));
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
    const input = orderEditInput(order);

    await expect(invoke('orders:update', null)).rejects.toThrow('订单修改格式无效');
    await expect(invoke('orders:update', {
      ...input,
      lifecycleStatus: 'deleted',
    })).rejects.toThrow(/未知字段：lifecycleStatus/);
    await expect(invoke('orders:update', {
      ...input,
      fulfillmentStatus: 'pending_shipment',
    })).rejects.toThrow(/未知字段：fulfillmentStatus/);
    await expect(invoke('orders:update', {
      ...input,
      items: [input.items[0], input.items[0]],
    })).rejects.toThrow(/商品标识不能重复/);
    await expect(invoke('orders:update', {
      ...input,
      items: [{ ...input.items[0], id: 'foreign-item-id' }],
    })).rejects.toThrow(/不属于当前订单/);
    expect(session.getOrder(order.id)).toMatchObject({
      order: { revision: 1, recipient: '原收件人' },
      changeEvents: [],
    });

    const saved = await invoke('orders:update', {
      ...input,
      recipient: 'IPC 修正收件人',
      note: 'IPC 人工备注',
    });
    expect(saved).toEqual(expect.objectContaining({
      order: expect.objectContaining({
        revision: 2,
        recipient: 'IPC 修正收件人',
        note: 'IPC 人工备注',
      }),
      lastManualEditAt: expect.any(String),
    }));
    expect(ordersChanged).toHaveBeenCalledWith([
      expect.objectContaining({
        id: order.id,
        recipient: 'IPC 修正收件人',
        note: 'IPC 人工备注',
        lastManualEditAt: expect.any(String),
      }),
    ]);
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}

function orderEditInput(order: OriginalOrder): OrderEditInput {
  return {
    orderId: order.id,
    expectedRevision: order.revision,
    identityCorrection: null,
    alipayTransactionNumber: order.alipayTransactionNumber,
    buyerNickname: order.buyerNickname,
    recipient: order.recipient,
    phone: order.phone,
    addressOriginal: order.addressOriginal,
    province: order.province,
    city: order.city,
    district: order.district,
    orderedAtOriginal: order.orderedAtOriginal,
    paidAtOriginal: order.paidAtOriginal,
    productTotalCents: order.productTotalCents ?? 0,
    shippingFeeCents: order.shippingFeeCents ?? 0,
    amountCents: order.amountCents,
    note: order.note ?? '',
    items: order.items.map((item) => ({
      id: item.id,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
    })),
  };
}

function completeRecognition(): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '原卖家账号',
    orderNumber: 'XY-ORDER-EDIT-IPC-0001',
    alipayTransactionNumber: '',
    buyerNickname: '原买家',
    recipient: '原收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-07-30 08:00:00',
    orderedAtNormalized: '2026-07-30T08:00:00+08:00',
    paidAtOriginal: '2026-07-30 08:00:08',
    paidAtNormalized: '2026-07-30T08:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '原商品',
      sourceSpec: '标准款',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: true,
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
