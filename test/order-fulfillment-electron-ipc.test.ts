import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
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

describe('订单状态与手工物流 Electron IPC', () => {
  it('通过受校验通道批量保存并广播最新订单摘要', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '待发货订单.png');
    await writeFile(sourcePath, Buffer.from('fulfillment-ipc-source'));
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

    await expect(invoke('orders:update-status-and-logistics', {
      targets: [{ orderId: order.id, expectedRevision: order.revision }],
      patch: { fulfillmentStatus: 'shipped', hidden: true },
    })).rejects.toThrow('订单状态与物流修改内容包含未知字段：hidden');

    const result = await invoke('orders:update-status-and-logistics', {
      targets: [{ orderId: order.id, expectedRevision: order.revision }],
      patch: {
        fulfillmentStatus: 'shipped',
        shippingCarrier: '圆通速递',
        trackingNumber: 'YT001',
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        order: expect.objectContaining({
          id: order.id,
          revision: 2,
          fulfillmentStatus: 'shipped',
          shippingCarrier: '圆通速递',
          trackingNumber: 'YT001',
        }),
      }),
    ]);
    expect(ordersChanged).toHaveBeenCalledWith([
      expect.objectContaining({
        id: order.id,
        revision: 2,
        fulfillmentStatus: 'shipped',
        shippingCarrier: '圆通速递',
        trackingNumber: 'YT001',
      }),
    ]);
  });
});

describe('发货组 Electron IPC', () => {
  it('通过只读通道返回本机动态发货组投影', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-groups-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '待发货订单.png');
    await writeFile(sourcePath, Buffer.from('shipment-groups-ipc-source'));
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
    registerIpcHandlers(session);

    await expect(invoke('shipment-groups:query')).resolves.toMatchObject({
      groups: [{
        orderCount: 1,
        totalQuantity: 1,
        totalAmountCents: 800,
        orders: [{ id: order.id, orderNumber: order.orderNumber }],
      }],
      attentionOrders: [],
    });
  });

  it('通过受控通道传递拆分与重组命令', async () => {
    const splitShipmentGroup = vi.fn().mockReturnValue({ event: { operation: 'split' } });
    const mergeShipmentGroups = vi.fn().mockReturnValue({ event: { operation: 'merge' } });
    registerIpcHandlers({
      splitShipmentGroup,
      mergeShipmentGroups,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);
    const splitInput = {
      groupId: 'group-1',
      expectedMemberOrderIds: ['order-1', 'order-2'],
      splitOrderIds: ['order-2'],
      reason: '单独包装',
    };
    const mergeInput = {
      groupIds: ['group-1', 'group-2'],
      expectedMemberOrderIds: ['order-1', 'order-2'],
      selectedRecipientOrderId: 'order-1',
      reason: '一起发货',
    };

    await expect(invoke('shipment-groups:split', splitInput)).resolves.toMatchObject({
      event: { operation: 'split' },
    });
    await expect(invoke('shipment-groups:merge', mergeInput)).resolves.toMatchObject({
      event: { operation: 'merge' },
    });
    expect(splitShipmentGroup).toHaveBeenCalledWith(splitInput);
    expect(mergeShipmentGroups).toHaveBeenCalledWith(mergeInput);
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
    orderNumber: 'XY-FULFILLMENT-IPC-0001',
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
    orderedAtOriginal: '2026-08-03 08:00:00',
    orderedAtNormalized: '2026-08-03T08:00:00+08:00',
    paidAtOriginal: '2026-08-03 08:00:08',
    paidAtNormalized: '2026-08-03T08:00:08+08:00',
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
