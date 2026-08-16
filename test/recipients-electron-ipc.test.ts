import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import type { OrderSummary } from '../src/core/contracts';
import type { RecipientSummaryView } from '../src/core/recipients';
import type { ShipmentConfirmationResult, ShipmentGroupArchive } from '../src/core/shipment-records';
import type { ShipmentGroupProjection } from '../src/core/shipment-groups';
import { DesktopSession } from '../src/main/desktop-session';
import { LocalApplication } from '../src/main/local-application';
import { OcrSettingsService } from '../src/main/ocr-settings';
import { Preferences } from '../src/main/preferences';
import { Workspace } from '../src/main/workspace';

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

class SequenceRecognizer implements Recognizer {
  public constructor(private readonly results: RecognitionResult[]) {}

  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result = this.results.shift();
    if (!result) throw new Error('测试识别结果已用尽');
    return {
      result: structuredClone(result),
      evidences: [{
        provider: 'controlled',
        model: 'controlled',
        requestId: '',
        schemaVersion: 1,
        rawResponse: JSON.stringify(result),
      }],
    };
  }
}

const sessions: DesktopSession[] = [];

afterEach(() => {
  electronBoundary.handlers.clear();
  for (const session of sessions.splice(0)) session.close();
});

describe('收件人空间 Electron IPC', () => {
  it('收件人列表派生订单数与地址，合并后归入存续方，重启一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-recipients-ipc-'));
    const dataDirectory = join(root, '数据');
    const sourceA1 = join(root, '订单A1.png');
    const sourceA2 = join(root, '订单A2.png');
    const sourceB1 = join(root, '订单B1.png');
    await writeFile(sourceA1, Buffer.from('recipients-ipc-a1'));
    await writeFile(sourceA2, Buffer.from('recipients-ipc-a2'));
    await writeFile(sourceB1, Buffer.from('recipients-ipc-b1'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-RECIPIENT-IPC-A1', '张三', '13900000001', '广东省深圳市南山区甲路1号'),
      recognition('XY-RECIPIENT-IPC-A2', '张三', '13900000001', '广东省深圳市南山区乙路2号'),
      recognition('XY-RECIPIENT-IPC-B1', '李四', '13900000002', '广东省深圳市南山区丙路3号'),
    ]));
    seeder.openDataDirectory(dataDirectory);
    const drafts = (await seeder.submitRecognitionBatch([sourceA1, sourceA2, sourceB1])).drafts;
    const orderA1 = seeder.confirmDraft(drafts[0]);
    const orderA2 = seeder.confirmDraft(drafts[1]);
    const orderB1 = seeder.confirmDraft(drafts[2]);
    seeder.close();

    const backdated = Workspace.open(dataDirectory);
    try {
      const update = backdated.database.prepare(
        'UPDATE original_orders SET created_at = ? WHERE id = ?',
      );
      update.run('2026-08-05T01:00:00.000Z', orderA1.id);
      update.run('2026-08-05T02:00:00.000Z', orderA2.id);
      update.run('2026-08-05T03:00:00.000Z', orderB1.id);
    } finally {
      backdated.close();
    }

    const session = openSession(root, dataDirectory);
    const recipients = await invoke('recipients:query') as RecipientSummaryView[];
    expect(recipients).toHaveLength(2);
    const [zhangsan, lisi] = recipients;
    expect(zhangsan).toMatchObject({
      recipientNumber: 1,
      name: '张三',
      displayName: null,
      effectiveName: '张三',
      phoneNormalized: '13900000001',
      orderCount: 2,
      addresses: ['广东省深圳市南山区甲路1号', '广东省深圳市南山区乙路2号'],
      mergedIntoRecipientId: null,
    });
    expect(lisi).toMatchObject({
      recipientNumber: 2,
      effectiveName: '李四',
      orderCount: 1,
      addresses: ['广东省深圳市南山区丙路3号'],
    });

    const zhangsanOrders = await invoke('recipients:orders', zhangsan.id) as OrderSummary[];
    expect(zhangsanOrders.map(({ readableOrderNumber }) => readableOrderNumber))
      .toEqual(['260801-001-PT', '260802-001-PT']);

    await expect(invoke('recipients:merge', {
      sourceRecipientId: lisi.id,
      targetRecipientId: zhangsan.id,
      keepNameFrom: 'source',
      reason: ' ',
    })).rejects.toThrow('请填写非空原因');

    const merged = await invoke('recipients:merge', {
      sourceRecipientId: lisi.id,
      targetRecipientId: zhangsan.id,
      keepNameFrom: 'source',
      reason: '同一买家两个地址',
    }) as RecipientSummaryView[];
    const survivor = merged.find(({ id }) => id === zhangsan.id);
    expect(survivor).toMatchObject({
      recipientNumber: 1,
      name: '张三',
      displayName: '李四',
      effectiveName: '李四',
      orderCount: 3,
      addresses: [
        '广东省深圳市南山区甲路1号',
        '广东省深圳市南山区乙路2号',
        '广东省深圳市南山区丙路3号',
      ],
      mergedIntoRecipientId: null,
    });
    const mergedRow = merged.find(({ id }) => id === lisi.id);
    expect(mergedRow).toMatchObject({
      mergedIntoRecipientId: zhangsan.id,
      mergedReason: '同一买家两个地址',
    });

    const survivorOrders = await invoke('recipients:orders', zhangsan.id) as OrderSummary[];
    expect(survivorOrders.map(({ id }) => id)).toContain(orderB1.id);
    expect(survivorOrders.find(({ id }) => id === orderB1.id)?.readableOrderNumber)
      .toBe('260803-001-PT');

    session.close();
    sessions.splice(sessions.indexOf(session), 1);
    openSession(root, dataDirectory);
    expect(await invoke('recipients:query')).toEqual(merged);
  });

  it('发货快照冻结可读编号，合并或入计划后快照不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-recipients-freeze-'));
    const dataDirectory = join(root, '数据');
    const sourceD1 = join(root, '订单D1.png');
    const sourceD2 = join(root, '订单D2.png');
    await writeFile(sourceD1, Buffer.from('recipients-freeze-d1'));
    await writeFile(sourceD2, Buffer.from('recipients-freeze-d2'));
    const seeder = new LocalApplication(new SequenceRecognizer([
      recognition('XY-RECIPIENT-IPC-D1', '张三', '13900000011', '广东省深圳市南山区甲路1号'),
      recognition('XY-RECIPIENT-IPC-D2', '李四', '13900000012', '广东省深圳市南山区乙路2号'),
    ]));
    seeder.openDataDirectory(dataDirectory);
    const drafts = (await seeder.submitRecognitionBatch([sourceD1, sourceD2])).drafts;
    const orderD1 = seeder.confirmDraft(drafts[0]);
    seeder.confirmDraft(drafts[1]);
    seeder.close();

    const backdated = Workspace.open(dataDirectory);
    try {
      backdated.database.prepare(
        'UPDATE original_orders SET created_at = ? WHERE id = ?',
      ).run('2026-08-05T01:00:00.000Z', orderD1.id);
    } finally {
      backdated.close();
    }

    const session = openSession(root, dataDirectory);
    const groups = await invoke('shipment-groups:query') as ShipmentGroupProjection;
    const group = groups.groups.find(({ orders }) => (
      orders.some(({ id }) => id === orderD1.id)
    ));
    if (!group) throw new Error('未找到发货组');
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = await invoke('shipment-records:confirm', {
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-RECIPIENT-FREEZE-001',
        items: remainingItems,
      }],
    }) as ShipmentConfirmationResult;

    const archives = await invoke('shipment-group-archives:query') as ShipmentGroupArchive[];
    const snapshot = archives[0].records[0].sourceOrders
      .find(({ orderId }) => orderId === orderD1.id);
    expect(snapshot).toMatchObject({
      systemOrderNumber: orderD1.systemOrderNumber,
      readableOrderNumber: '260801-001-PT',
    });

    const recipients = await invoke('recipients:query') as RecipientSummaryView[];
    const [zhangsan, lisi] = recipients;
    await invoke('recipients:merge', {
      sourceRecipientId: zhangsan.id,
      targetRecipientId: lisi.id,
      keepNameFrom: 'target',
      reason: '归类修正',
    });
    const liveNumbers = await invoke('orders:readable-numbers', [orderD1.id]) as Record<
      string,
      string | null
    >;
    expect(liveNumbers[orderD1.id]).toBe('260801-002-PT');
    const archivesAfterMerge = await invoke('shipment-group-archives:query') as
      ShipmentGroupArchive[];
    expect(
      archivesAfterMerge[0].records[0].sourceOrders
        .find(({ orderId }) => orderId === orderD1.id)?.readableOrderNumber,
    ).toBe('260801-001-PT');

    // 旧快照行缺少冻结值时回退实时编号（模拟 v42 升级前的历史快照行）
    session.close();
    sessions.splice(sessions.indexOf(session), 1);
    const workspace = Workspace.open(dataDirectory);
    try {
      workspace.database.exec(`
        DROP TRIGGER IF EXISTS shipment_order_snapshots_are_immutable_on_update
      `);
      workspace.database.prepare(`
        UPDATE shipment_record_order_snapshots SET readable_order_number = NULL
        WHERE shipment_record_id = ? AND order_id = ?
      `).run(shipment.record.id, orderD1.id);
    } finally {
      workspace.close();
    }
    openSession(root, dataDirectory);
    const archivesLegacy = await invoke('shipment-group-archives:query') as
      ShipmentGroupArchive[];
    expect(
      archivesLegacy[0].records[0].sourceOrders
        .find(({ orderId }) => orderId === orderD1.id)?.readableOrderNumber,
    ).toBe('260801-002-PT');
  });
});

function openSession(root: string, dataDirectory: string): DesktopSession {
  const session = new DesktopSession(
    new Preferences(join(root, '启动配置')),
    new SequenceRecognizer([]),
    unusedOcrSettings,
  );
  sessions.push(session);
  session.useDataDirectory(dataDirectory);
  registerIpcHandlers(session);
  return session;
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}

function recognition(
  orderNumber: string,
  recipient: string,
  phone: string,
  address: string,
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient,
    phone,
    phoneNormalized: phone,
    addressOriginal: address,
    addressNormalized: address,
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
