import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  OriginalOrder,
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';

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

const openedApplications: LocalApplication[] = [];

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

type RecognitionOverrides = Partial<Pick<
  RecognitionResult,
  'recipient' | 'phone' | 'amountCents' | 'productTotalCents'
  | 'paidAtOriginal' | 'paidAtNormalized'
  | 'orderedAtOriginal' | 'orderedAtNormalized'
  | 'platformTransactionStatus' | 'addressOriginal' | 'addressNormalized'
>> & {
  /** 单条商品明细的单价覆盖，仅测试夹具使用。 */
  unitPriceCents?: number;
};

describe('收件人累计消费与回购投影', () => {
  it('回购按平台交易时间回退链排序，动态总额含当前单', async () => {
    const application = await createApplication([
      recognition('XY-SPEND-0001', '张三', '13900000001', {
        paidAtOriginal: '2026-08-01 08:00:08',
        paidAtNormalized: '2026-08-01T08:00:08+08:00',
        amountCents: 1_000,
      }),
      recognition('XY-SPEND-0002', '张三', '13900000001', {
        amountCents: 2_500,
      }),
      recognition('XY-SPEND-0003', '张三', '13900000001', {
        amountCents: 400,
      }),
      recognition('XY-SPEND-0004', '李四', '13900000002', {
        paidAtOriginal: '2026-07-31 08:00:08',
        paidAtNormalized: '2026-07-31T08:00:08+08:00',
        amountCents: 700,
      }),
    ]);
    const first = findOrder(application, 'XY-SPEND-0001');
    const second = findOrder(application, 'XY-SPEND-0002');
    const third = findOrder(application, 'XY-SPEND-0003');
    const other = findOrder(application, 'XY-SPEND-0004');
    // 第二笔缺付款时间：回退下单时间；第三笔两者都缺：回退入库时间。
    const app = backdateAndReopen(application, [
      [second.id, '2026-08-02T01:00:00.000Z'],
      [third.id, '2026-08-03T01:00:00.000Z'],
    ], (database) => {
      database.prepare(`
        UPDATE original_orders
        SET paid_at_original = '', paid_at_normalized = ''
        WHERE id IN (?, ?)
      `).run(second.id, third.id);
      database.prepare(`
        UPDATE original_orders SET ordered_at_original = '', ordered_at_normalized = ''
        WHERE id = ?
      `).run(third.id);
    });

    const spendingById = workbenchSpending(app);
    expect(spendingById.get(first.id)?.repurchaseRank).toBe(1);
    expect(spendingById.get(second.id)?.repurchaseRank).toBe(2);
    expect(spendingById.get(third.id)?.repurchaseRank).toBe(3);
    expect(spendingById.get(other.id)?.repurchaseRank).toBe(1);
    for (const orderId of [first.id, second.id, third.id]) {
      expect(spendingById.get(orderId)).toMatchObject({
        totalSpendCents: 3_900,
        totalRefundCents: 0,
      });
    }
    expect(spendingById.get(other.id)).toMatchObject({
      totalSpendCents: 700,
      totalRefundCents: 0,
    });

    const zhangsan = app.queryRecipientSummaries().find(({ name }) => name === '张三');
    expect(zhangsan).toMatchObject({ totalSpendCents: 3_900, totalRefundCents: 0 });
    const details = app.getOrder(third.id);
    expect(details.spending).toMatchObject({
      repurchaseRank: 3,
      totalSpendCents: 3_900,
      totalRefundCents: 0,
    });

    const repurchaseOnly = app.queryOrders({ repurchase: true }, undefined).orders
      .map((order) => order.id);
    expect(repurchaseOnly).toHaveLength(2);
    expect(repurchaseOnly).toEqual(expect.arrayContaining([second.id, third.id]));
    const firstOnly = app.queryOrders({ repurchase: false }, undefined).orders
      .map((order) => order.id);
    expect(firstOnly).toEqual(expect.arrayContaining([first.id, other.id]));
    expect(firstOnly).not.toContain(second.id);
  });

  it('已取消与整单退款订单不计入消费，整单退款计入退款', async () => {
    const application = await createApplication([
      recognition('XY-SPEND-C01', '张三', '13900000011', {
        paidAtOriginal: '2026-08-01 08:00:08',
        paidAtNormalized: '2026-08-01T08:00:08+08:00',
        amountCents: 1_000,
        platformTransactionStatus: 'cancelled',
      }),
      recognition('XY-SPEND-C02', '张三', '13900000011', {
        paidAtOriginal: '2026-08-02 08:00:08',
        paidAtNormalized: '2026-08-02T08:00:08+08:00',
        amountCents: 2_000,
      }),
      recognition('XY-SPEND-C03', '张三', '13900000011', {
        paidAtOriginal: '2026-08-03 08:00:08',
        paidAtNormalized: '2026-08-03T08:00:08+08:00',
        amountCents: 4_000,
        platformTransactionStatus: 'refunded',
      }),
    ]);
    const cancelled = findOrder(application, 'XY-SPEND-C01');
    const paid = findOrder(application, 'XY-SPEND-C02');
    const refunded = findOrder(application, 'XY-SPEND-C03');

    const spendingById = workbenchSpending(application);
    expect(spendingById.get(cancelled.id)?.repurchaseRank).toBeNull();
    expect(spendingById.get(refunded.id)?.repurchaseRank).toBeNull();
    expect(spendingById.get(paid.id)?.repurchaseRank).toBe(1);
    for (const orderId of [cancelled.id, paid.id, refunded.id]) {
      expect(spendingById.get(orderId)).toMatchObject({
        totalSpendCents: 2_000,
        totalRefundCents: 4_000,
      });
    }
    expect(application.queryRecipientSummaries()[0]).toMatchObject({
      totalSpendCents: 2_000,
      totalRefundCents: 4_000,
    });

    // 无售后登记的整单退款推断同样只统计正常订单。
    const trashed = withLifecycle(application, refunded.id, 'trashed');
    expect(workbenchSpending(trashed).get(paid.id)).toMatchObject({
      totalRefundCents: 0,
    });
    const restored = withLifecycle(trashed, refunded.id, 'active');
    expect(workbenchSpending(restored).get(paid.id)).toMatchObject({
      totalRefundCents: 4_000,
    });
  });

  it('回收站订单不计入消费，恢复后自动回来', async () => {
    const application = await createApplication([
      recognition('XY-SPEND-T01', '张三', '13900000021', {
        paidAtOriginal: '2026-08-01 08:00:08',
        paidAtNormalized: '2026-08-01T08:00:08+08:00',
        amountCents: 1_000,
      }),
      recognition('XY-SPEND-T02', '张三', '13900000021', {
        paidAtOriginal: '2026-08-02 08:00:08',
        paidAtNormalized: '2026-08-02T08:00:08+08:00',
        amountCents: 2_000,
      }),
    ]);
    const first = findOrder(application, 'XY-SPEND-T01');
    const second = findOrder(application, 'XY-SPEND-T02');
    const trashed = withLifecycle(application, first.id, 'trashed');
    expect(workbenchSpending(trashed).get(second.id)).toMatchObject({
      repurchaseRank: 1,
      totalSpendCents: 2_000,
    });
    const restored = withLifecycle(trashed, first.id, 'active');
    expect(workbenchSpending(restored).get(second.id)).toMatchObject({
      repurchaseRank: 2,
      totalSpendCents: 3_000,
    });
  });

  it('售后实际退款计入退款且不与整单退款重复', async () => {
    const { application, shipmentRecordId, shipmentPackageItemIds } =
      await openShippedApplication({
        orderNumber: 'XY-SPEND-R01',
        recipient: '张三',
        phone: '13900000031',
        amountCents: 5_000,
        paidAtNormalized: '2026-08-10T08:00:08+08:00',
      });
    const order = findOrder(application, 'XY-SPEND-R01');
    const refundCase = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemIds, 5_000,
    );
    const partialBefore = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: refundCase.id,
      expectedRevision: refundCase.revision,
      actualRefundCents: 1_200,
      occurredAt: afterMinutes(3),
      note: '部分退款',
    });

    expect(workbenchSpending(application).get(order.id)).toMatchObject({
      totalSpendCents: 5_000,
      totalRefundCents: 1_200,
    });

    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: refundCase.id,
      expectedRevision: partialBefore.revision,
      actualRefundCents: 800,
      occurredAt: afterMinutes(4),
      note: '补退剩余协商金额',
    });
    expect(partial.revision).toBeGreaterThan(0);
    expect(workbenchSpending(application).get(order.id)).toMatchObject({
      totalSpendCents: 5_000,
      totalRefundCents: 2_000,
    });

    const summary = findOrderSummary(application, order.id);
    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: order.id, expectedRevision: summary.revision }],
      patch: { platformTransactionStatus: 'refunded' },
    });
    // 已有售后实退登记的整单退款不再按订单金额重复推断。
    expect(workbenchSpending(application).get(order.id)).toMatchObject({
      totalSpendCents: 0,
      totalRefundCents: 2_000,
    });
  });

  it('合并发货跨收件人的退款按商品小计分摊', async () => {
    const { application, shipmentRecordId, shipmentPackageItemIds } =
      await openShippedMergedApplication();
    const zhangsanOrder = findOrder(application, 'XY-SPEND-M01');
    const lisiOrder = findOrder(application, 'XY-SPEND-M02');
    const refundCase = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemIds, 999,
    );
    application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: refundCase.id,
      expectedRevision: refundCase.revision,
      actualRefundCents: 999,
      occurredAt: afterMinutes(3),
      note: '两件一起退',
    });

    // 800:1200 的商品小计按比例分摊 999 分：floor 得 399/599，余 1 分补给份额较大方。
    expect(workbenchSpending(application).get(zhangsanOrder.id)).toMatchObject({
      totalRefundCents: 399,
    });
    expect(workbenchSpending(application).get(lisiOrder.id)).toMatchObject({
      totalRefundCents: 600,
    });
  });

  it('合并收件人后回购与总额按存续方重算', async () => {
    const application = await createApplication([
      recognition('XY-SPEND-G01', '张三', '13900000041', {
        paidAtOriginal: '2026-08-01 08:00:08',
        paidAtNormalized: '2026-08-01T08:00:08+08:00',
        amountCents: 1_000,
      }),
      recognition('XY-SPEND-G02', '李四', '13900000042', {
        paidAtOriginal: '2026-08-02 08:00:08',
        paidAtNormalized: '2026-08-02T08:00:08+08:00',
        amountCents: 3_000,
      }),
    ]);
    const zhangsanOrder = findOrder(application, 'XY-SPEND-G01');
    const lisiOrder = findOrder(application, 'XY-SPEND-G02');
    const [zhangsan, lisi] = application.queryRecipientSummaries();

    application.mergeRecipients({
      sourceRecipientId: lisi.id,
      targetRecipientId: zhangsan.id,
      keepNameFrom: 'target',
      reason: '同一买家两个手机号',
    });
    const spendingById = workbenchSpending(application);
    expect(spendingById.get(zhangsanOrder.id)).toMatchObject({
      repurchaseRank: 1,
      totalSpendCents: 4_000,
    });
    expect(spendingById.get(lisiOrder.id)).toMatchObject({
      repurchaseRank: 2,
      totalSpendCents: 4_000,
    });
    const merged = application.queryRecipientSummaries();
    expect(merged.find(({ id }) => id === zhangsan.id)).toMatchObject({
      totalSpendCents: 4_000,
    });
    expect(merged.find(({ id }) => id === lisi.id)).toMatchObject({
      orderCount: 0,
      totalSpendCents: 0,
      totalRefundCents: 0,
    });
  });

  it('同刻并列按系统内部序定序，零金额有效订单计入回购序列', async () => {
    const application = await createApplication([
      recognition('XY-SPEND-D01', '张三', '13900000071', { amountCents: 0 }),
      recognition('XY-SPEND-D02', '张三', '13900000071', { amountCents: 1_500 }),
    ]);
    const zeroAmount = findOrder(application, 'XY-SPEND-D01');
    const other = findOrder(application, 'XY-SPEND-D02');
    // 两笔付款时间相同（夹具默认值），先后由订单 id 决定。
    const [earlierId, laterId] = [zeroAmount.id, other.id]
      .sort((left, right) => left.localeCompare(right));

    const spendingById = workbenchSpending(application);
    expect(spendingById.get(earlierId)?.repurchaseRank).toBe(1);
    expect(spendingById.get(laterId)?.repurchaseRank).toBe(2);
    for (const order of [zeroAmount, other]) {
      expect(spendingById.get(order.id)).toMatchObject({ totalSpendCents: 1_500 });
    }
  });

  it('回收站订单的退款不计入，恢复后自动回来', async () => {
    const { application, shipmentRecordId, shipmentPackageItemIds } =
      await openShippedApplication({
        orderNumber: 'XY-SPEND-Y01',
        recipient: '张三',
        phone: '13900000081',
        amountCents: 5_000,
        paidAtNormalized: '2026-08-10T08:00:08+08:00',
      });
    const order = findOrder(application, 'XY-SPEND-Y01');
    const refundCase = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemIds, 5_000,
    );
    application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: refundCase.id,
      expectedRevision: refundCase.revision,
      actualRefundCents: 1_200,
      occurredAt: afterMinutes(3),
      note: '部分退款',
    });
    expect(workbenchSpending(application).get(order.id)).toMatchObject({
      totalRefundCents: 1_200,
    });

    const trashed = withLifecycle(application, order.id, 'trashed');
    expect(workbenchSpending(trashed).get(order.id)).toMatchObject({
      totalRefundCents: 0,
    });
    const restored = withLifecycle(trashed, order.id, 'active');
    expect(workbenchSpending(restored).get(order.id)).toMatchObject({
      totalRefundCents: 1_200,
    });

    const summary = findOrderSummary(restored, order.id);
    restored.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: order.id, expectedRevision: summary.revision }],
      patch: { platformTransactionStatus: 'refunded' },
    });
    // 已有售后实退登记，整单退款标记不重复推断；回收站后售后份额同样不计。
    const trashedRefunded = withSql(restored, (database) => {
      database.prepare("UPDATE original_orders SET lifecycle_status = 'trashed' WHERE id = ?")
        .run(order.id);
    });
    expect(workbenchSpending(trashedRefunded).get(order.id)).toMatchObject({
      totalRefundCents: 0,
    });
  });

  it('收件信息不完整的订单不参与统计', async () => {
    const application = await createApplication([
      recognition('XY-SPEND-N01', '张三', '13900000051', {
        paidAtOriginal: '2026-08-01 08:00:08',
        paidAtNormalized: '2026-08-01T08:00:08+08:00',
        amountCents: 1_000,
      }),
      recognition('XY-SPEND-N02', '李四', '13900000052', {
        paidAtOriginal: '2026-08-02 08:00:08',
        paidAtNormalized: '2026-08-02T08:00:08+08:00',
        amountCents: 2_000,
      }),
    ]);
    const other = findOrder(application, 'XY-SPEND-N02');
    const app = withSql(application, (database) => {
      database.prepare(`
        UPDATE original_orders SET phone = '', phone_normalized = '' WHERE id = ?
      `).run(other.id);
    });

    const spendingById = workbenchSpending(app);
    expect(spendingById.has(other.id)).toBe(false);
    const recipients = app.queryRecipientSummaries();
    expect(recipients.find(({ name }) => name === '张三')).toMatchObject({
      totalSpendCents: 1_000,
      totalRefundCents: 0,
    });
    expect(recipients.find(({ name }) => name === '李四')).toMatchObject({
      orderCount: 0,
      totalSpendCents: 0,
      totalRefundCents: 0,
    });
  });
});

function workbenchSpending(
  application: LocalApplication,
): Map<string, NonNullable<import('../src/core/contracts').OrderSummary['spending']>> {
  return new Map(
    application.queryOrders({ lifecycleStatus: 'all' }, undefined).orders
      .filter((order) => order.spending !== undefined && order.spending !== null)
      .map((order) => [order.id, order.spending!]),
  );
}

function findOrderSummary(application: LocalApplication, orderId: string) {
  const summary = application.queryOrders({ lifecycleStatus: 'all' }, undefined).orders
    .find((order) => order.id === orderId);
  if (!summary) throw new Error(`测试订单不存在：${orderId}`);
  return summary;
}

function findOrder(application: LocalApplication, orderNumber: string): OriginalOrder {
  const summary = application.listOrders().find((order) => order.orderNumber === orderNumber);
  if (!summary) throw new Error(`测试订单不存在：${orderNumber}`);
  return application.getOrder(summary.id).order;
}

async function createApplication(results: RecognitionResult[]) {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-recipient-spending-'));
  const dataDirectory = join(root, '数据');
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);
  const sourcePaths: string[] = [];
  for (const [index] of results.entries()) {
    const sourcePath = join(root, `订单-${index + 1}.png`);
    await writeFile(sourcePath, Buffer.from(`recipient-spending-${index + 1}`));
    sourcePaths.push(sourcePath);
  }
  const drafts = (await application.submitRecognitionBatch(sourcePaths)).drafts;
  for (const draft of drafts) application.confirmDraft(draft);
  return application;
}

function backdateAndReopen(
  application: LocalApplication,
  backdates: ReadonlyArray<readonly [string, string]>,
  mutate?: (database: import('node:sqlite').DatabaseSync) => void,
): LocalApplication {
  return withSql(application, (database) => {
    const update = database.prepare(
      'UPDATE original_orders SET created_at = ? WHERE id = ?',
    );
    for (const [orderId, createdAt] of backdates) update.run(createdAt, orderId);
    mutate?.(database);
  });
}

function withLifecycle(
  application: LocalApplication,
  orderId: string,
  lifecycleStatus: 'active' | 'trashed',
): LocalApplication {
  return withSql(application, (database) => {
    database.prepare('UPDATE original_orders SET lifecycle_status = ? WHERE id = ?')
      .run(lifecycleStatus, orderId);
  });
}

function withSql(
  application: LocalApplication,
  mutate: (database: import('node:sqlite').DatabaseSync) => void,
): LocalApplication {
  const dataDirectory = closeAndGetDirectory(application);
  const workspace = Workspace.open(dataDirectory);
  try {
    mutate(workspace.database);
  } finally {
    workspace.close();
  }
  const reopened = new LocalApplication(new SequenceRecognizer([]));
  openedApplications.push(reopened);
  reopened.openDataDirectory(dataDirectory);
  return reopened;
}

function closeAndGetDirectory(application: LocalApplication): string {
  const directory = application.dataDirectory;
  application.close();
  openedApplications.splice(openedApplications.indexOf(application), 1);
  return directory;
}

function recognition(
  orderNumber: string,
  recipient: string,
  phone: string,
  overrides: RecognitionOverrides = {},
): RecognitionResult {
  const amountCents = overrides.amountCents ?? 800;
  const unitPriceCents = overrides.unitPriceCents ?? amountCents;
  const paidAtOriginal = overrides.paidAtOriginal ?? '2026-08-03 08:00:08';
  const paidAtNormalized = overrides.paidAtNormalized ?? '2026-08-03T08:00:08+08:00';
  const orderedAtOriginal = overrides.orderedAtOriginal ?? '2026-08-03 08:00:00';
  const orderedAtNormalized = overrides.orderedAtNormalized ?? '2026-08-03T08:00:00+08:00';
  const address = overrides.addressOriginal ?? '广东省深圳市南山区安全路1号';
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
    addressNormalized: overrides.addressNormalized ?? address,
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal,
    orderedAtNormalized,
    paidAtOriginal,
    paidAtNormalized,
    productTotalCents: overrides.productTotalCents ?? amountCents,
    shippingFeeCents: 0,
    amountCents,
    platformTransactionStatus: overrides.platformTransactionStatus ?? 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '测试商品',
      sourceSpec: '标准款',
      unitPriceCents,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}

type ShippedApplicationOptions = {
  orderNumber: string;
  recipient: string;
  phone: string;
  amountCents: number;
  paidAtNormalized: string;
};

async function openShippedApplication(options: ShippedApplicationOptions) {
  const application = await createApplication([
    recognition(options.orderNumber, options.recipient, options.phone, {
      amountCents: options.amountCents,
      paidAtOriginal: '2026-08-10 08:00:08',
      paidAtNormalized: options.paidAtNormalized,
    }),
  ]);
  return { application, ...confirmShipmentForAll(application) };
}

async function openShippedMergedApplication() {
  const application = await createApplication([
    recognition('XY-SPEND-M01', '张三', '13900000061', {
      amountCents: 800,
      unitPriceCents: 800,
      paidAtOriginal: '2026-08-01 08:00:08',
      paidAtNormalized: '2026-08-01T08:00:08+08:00',
    }),
    recognition('XY-SPEND-M02', '李四', '13900000061', {
      amountCents: 1_200,
      unitPriceCents: 1_200,
      paidAtOriginal: '2026-08-02 08:00:08',
      paidAtNormalized: '2026-08-02T08:00:08+08:00',
    }),
  ]);
  return { application, ...confirmShipmentForAll(application) };
}

function confirmShipmentForAll(application: LocalApplication) {
  const group = application.queryShipmentGroups().groups[0];
  const allItems = group.orders.flatMap((order) => order.items.map((item) => ({
    orderId: order.id,
    orderItemId: item.id,
    quantity: item.quantity,
  })));
  const shipment = application.confirmShipment({
    groupId: group.id,
    expectedRemainingItems: allItems,
    packages: [{
      shippingCarrier: '顺丰速运',
      trackingNumber: `SF-SPEND-${group.id.slice(0, 8)}`,
      items: allItems,
    }],
  });
  const record = application.updateShipmentPackageLogisticsStatus({
    recordId: shipment.record.id,
    packageId: shipment.record.packages[0].id,
    expectedRevision: shipment.record.packages[0].revision,
    logisticsStatus: 'delivered',
    occurredAt: afterMinutes(1),
    reason: '累计退款测试前置：买家已签收',
  }).record;
  return {
    shipmentRecordId: record.id,
    shipmentPackageItemIds: record.packages[0].items.map((item) => item.id),
  };
}

function createRefundOnlyCase(
  application: LocalApplication,
  shipmentRecordId: string,
  shipmentPackageItemIds: readonly string[],
  requestedRefundCents: number,
) {
  const refundOnly = application.listAftersalesWorkflowTemplates()
    .find(({ scenario }) => scenario === 'refund_only');
  if (!refundOnly) throw new Error('缺少仅退款预置流程');
  return application.createAftersalesCase({
    shipmentRecordId,
    workflowTemplateId: refundOnly.id,
    occurredAt: afterMinutes(2),
    reason: '买家申请退款',
    requestedRefundCents,
    items: shipmentPackageItemIds.map((shipmentPackageItemId) => ({
      shipmentPackageItemId,
      quantity: 1,
    })),
  });
}

function afterMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
