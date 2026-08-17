import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  OriginalOrder,
} from '../src/core/contracts';
import type {
  OrderItemStandardizationBatchOptions,
} from '../src/core/product-standardization';
import { LocalApplication } from '../src/main/local-application';
import { removeVersion45ExtensionArtifacts } from './version31-fixture';

const openedApplications: LocalApplication[] = [];

type SeededItemSpec = {
  sourceTitle: string;
  sourceSpec: string;
  unitPriceCents: number;
  quantity: number;
};

type SeededOrderSpec = {
  fileName: string;
  orderNumber: string;
  phone: string;
  items: SeededItemSpec[];
};

function recognition(spec: SeededOrderSpec): RecognitionResult {
  const productTotalCents = spec.items.reduce(
    (total, item) => total + item.unitPriceCents * item.quantity,
    0,
  );
  return {
    platform: 'xianyu',
    sellerAccount: '批量关联测试账号',
    orderNumber: spec.orderNumber,
    alipayTransactionNumber: `ALI-${spec.orderNumber}`,
    buyerNickname: '测***户',
    recipient: '测试收件人',
    phone: spec.phone,
    phoneNormalized: spec.phone,
    addressOriginal: `广东省深圳市南山区安全路${spec.phone.slice(-2)}号`,
    addressNormalized: `广东省深圳市南山区安全路${spec.phone.slice(-2)}号`,
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-16 09:00:00',
    orderedAtNormalized: '2026-08-16T09:00:00+08:00',
    paidAtOriginal: '2026-08-16 09:00:08',
    paidAtNormalized: '2026-08-16T09:00:08+08:00',
    productTotalCents,
    shippingFeeCents: 0,
    amountCents: productTotalCents,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: spec.items.map((item) => ({
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      quantityInferred: false,
    })),
  };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

async function openSeededApplication(specs: SeededOrderSpec[]) {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-item-standardization-batch-'));
  const dataDirectory = join(root, '数据');
  const recognitions = new Map(specs.map((spec) => [spec.fileName, recognition(spec)]));
  const application = new LocalApplication({
    recognize: async (source): Promise<RecognitionAttempt> => {
      const result = recognitions.get(source.originalName);
      if (!result) throw new Error(`未预置的识别来源：${source.originalName}`);
      return {
        result,
        evidences: [{
          provider: 'controlled',
          model: 'controlled',
          requestId: '',
          schemaVersion: 1,
          rawResponse: JSON.stringify(result),
        }],
      };
    },
  });
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);
  const orders: OriginalOrder[] = [];
  for (const spec of specs) {
    const sourcePath = join(root, spec.fileName);
    await writeFile(sourcePath, Buffer.from(`item-standardization-batch-${spec.orderNumber}`));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    orders.push(application.confirmDraft(draft));
  }
  return { application, root, dataDirectory, orders };
}

function orderSpec(orderNumber: string, items: SeededItemSpec[], phone = '13900000001'): SeededOrderSpec {
  return {
    fileName: `${orderNumber}.png`,
    orderNumber,
    phone,
    items,
  };
}

const preferStandard: OrderItemStandardizationBatchOptions = {
  standardDisplayPreference: 'prefer_standard',
  useDefaultOrderPrice: false,
  updateProductTotal: false,
};

function linkItem(
  application: LocalApplication,
  order: OriginalOrder,
  itemId: string,
  standardProductId: string,
  standardDisplayPreference?: 'prefer_standard' | 'prefer_source',
): OriginalOrder {
  return application.updateOrderItemStandardization(order.id, itemId, {
    standardProductId,
    ...(standardDisplayPreference ? { standardDisplayPreference } : {}),
    expectedRevision: order.revision,
  }).order;
}

function confirmOrderShipment(application: LocalApplication, orderId: string) {
  const group = application.queryShipmentGroups().groups
    .find((candidate) => candidate.orders.some((order) => order.id === orderId));
  if (!group) throw new Error('找不到订单所属发货组');
  const items = group.orders.flatMap((order) => order.items.map((item) => ({
    orderId: order.id,
    orderItemId: item.id,
    quantity: item.quantity,
  })));
  return application.confirmShipment({
    groupId: group.id,
    expectedRemainingItems: items,
    packages: [{
      shippingCarrier: '顺丰速运',
      trackingNumber: 'SF-BATCH-LINK-0001',
      items,
    }],
  });
}

describe('订单商品批量关联预览', () => {
  it('预览字段齐全：数量统计、已发货与售后订单、价格与总价提示、逐条冲突', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-BATCH-PREVIEW-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 2 },
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '大号', unitPriceCents: 900, quantity: 1 },
      ], '13900000011'),
      orderSpec('XY-BATCH-PREVIEW-2', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ], '13900000012'),
      orderSpec('XY-BATCH-PREVIEW-3', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '中号', unitPriceCents: 800, quantity: 1 },
      ], '13900000013'),
      orderSpec('XY-BATCH-PREVIEW-4', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '特大号', unitPriceCents: 800, quantity: 1 },
      ], '13900000014'),
    ]);
    const target = application.createStandardProduct({
      sku: 'SKU-BATCH-TARGET',
      name: '十二分娃鞋',
      specification: '白色',
      defaultOrderPriceCents: 1299,
      priceChangeReason: '首次定价',
    });
    const other = application.createStandardProduct({
      sku: 'SKU-BATCH-OTHER',
      name: '十二分娃鞋',
      specification: '黑色',
    });
    const [order1, order2, order3, order4] = orders;
    const refreshed2 = linkItem(application, order2, order2.items[0].id, target.id);
    linkItem(application, order3, order3.items[0].id, other.id);
    const shipment = confirmOrderShipment(application, order4.id);
    application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-16T10:00:00+08:00',
      reason: '测试前置：买家要求换货',
      items: [{
        shipmentPackageItemId: shipment.record.packages[0].items[0].id,
        quantity: 1,
      }],
    });

    const preview = application.previewOrderItemStandardizationBatch({
      itemIds: [
        order1.items[0].id,
        order1.items[1].id,
        order2.items[0].id,
        order3.items[0].id,
        order4.items[0].id,
      ],
      standardProductId: target.id,
      options: preferStandard,
    });

    expect(preview).toMatchObject({
      standardProduct: expect.objectContaining({ id: target.id, sku: 'SKU-BATCH-TARGET' }),
      options: preferStandard,
      priceSyncRequested: false,
      priceSyncAvailable: true,
      defaultOrderPriceCents: 1299,
      orderCount: 4,
      itemCount: 5,
      totalQuantity: 6,
      unlinkedCount: 3,
      sameProductCount: 1,
      otherProductCount: 1,
      shippedOrderCount: 1,
      aftersalesOrderCount: 1,
      priceAffectedItemCount: 0,
      suggestedProductTotalOrderCount: 0,
    });
    expect(preview.items.map((item) => [
      item.itemId,
      item.linkState,
      item.blockReasons,
      item.beforeStandardProductSku,
    ])).toEqual([
      [order1.items[0].id, 'unlinked', [], null],
      [order1.items[1].id, 'unlinked', [], null],
      [order2.items[0].id, 'same_product', [], 'SKU-BATCH-TARGET'],
      [order3.items[0].id, 'other_product', ['linked_other_product'], 'SKU-BATCH-OTHER'],
      [order4.items[0].id, 'unlinked', [], null],
    ]);
    expect(preview.items[0]).toMatchObject({
      orderId: order1.id,
      orderNumber: 'XY-BATCH-PREVIEW-1',
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      quantity: 2,
      currentUnitPriceCents: 800,
      plannedUnitPriceCents: 800,
      currentSubtotalCents: 1600,
      plannedSubtotalCents: 1600,
    });
    const previewOrder4 = preview.orders.find((order) => order.orderId === order4.id);
    expect(previewOrder4).toMatchObject({
      shippedOrDelivered: true,
      hasAftersales: true,
      productTotalCents: 800,
      suggestedProductTotalCents: 800,
      productTotalChanges: false,
      amountMismatch: false,
    });
    expect(preview.orders.find((order) => order.orderId === order2.id)?.revision)
      .toBe(refreshed2.revision);
    expect(preview.orders.map((order) => order.orderId).sort()).toEqual(
      [order1.id, order2.id, order3.id, order4.id].sort(),
    );
  });

  it('勾选使用默认单价时提示金额变化并标记需要人工核对的差异', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-BATCH-PRICE-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 2 },
      ]),
    ]);
    const target = application.createStandardProduct({
      sku: 'SKU-BATCH-PRICE',
      name: '十二分娃鞋',
      specification: '白色',
      defaultOrderPriceCents: 1299,
      priceChangeReason: '首次定价',
    });
    const order = orders[0];

    const preview = application.previewOrderItemStandardizationBatch({
      itemIds: [order.items[0].id],
      standardProductId: target.id,
      options: {
        standardDisplayPreference: 'prefer_standard',
        useDefaultOrderPrice: true,
        updateProductTotal: true,
      },
    });

    expect(preview).toMatchObject({
      priceSyncRequested: true,
      priceSyncAvailable: true,
      priceAffectedItemCount: 1,
      suggestedProductTotalOrderCount: 1,
    });
    expect(preview.items[0]).toMatchObject({
      currentUnitPriceCents: 800,
      plannedUnitPriceCents: 1299,
      currentSubtotalCents: 1600,
      plannedSubtotalCents: 2598,
      blockReasons: ['amount_mismatch'],
    });
    expect(preview.orders[0]).toMatchObject({
      productTotalCents: 1600,
      amountCents: 1600,
      suggestedProductTotalCents: 2598,
      productTotalChanges: true,
      amountMismatch: true,
    });
  });
});

describe('订单商品明细表相同或相似筛选', () => {
  it('按相同或相似的标题规格过滤明细，其余筛选保持不变', async () => {
    const { application } = await openSeededApplication([
      orderSpec('XY-BATCH-FILTER-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
        { sourceTitle: '十二分娃鞋白胚闲鱼专拍', sourceSpec: '小号', unitPriceCents: 850, quantity: 1 },
        { sourceTitle: '亚麻收纳袋', sourceSpec: '米白', unitPriceCents: 1000, quantity: 1 },
      ]),
    ]);

    expect(application.queryOrderItems({}).items).toHaveLength(3);
    expect(
      application.queryOrderItems({ similarText: '十二分娃鞋白胚' }).items
        .map((item) => item.sourceTitle).sort(),
    ).toEqual(['十二分娃鞋白胚', '十二分娃鞋白胚闲鱼专拍'].sort());
    expect(
      application.queryOrderItems({ similarText: '亚麻收纳袋' }).items
        .map((item) => item.sourceTitle),
    ).toEqual(['亚麻收纳袋']);
    expect(
      application.queryOrderItems({
        similarText: '十二分娃鞋白胚',
        sourceSpec: '小号',
      }).items,
    ).toHaveLength(2);
    expect(() => application.queryOrderItems({ similarText: '长'.repeat(301) }))
      .toThrow('相似标题规格筛选值无效');
  });
});

describe('订单商品批量关联执行', () => {
  it('执行后关联、显示偏好、金额与修改记录正确，成交金额与运费不动', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-BATCH-APPLY-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 2 },
      ], '13900000021'),
      orderSpec('XY-BATCH-APPLY-2', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ], '13900000022'),
    ]);
    const target = application.createStandardProduct({
      sku: 'SKU-BATCH-APPLY',
      name: '十二分娃鞋',
      specification: '白色',
      defaultOrderPriceCents: 1299,
      priceChangeReason: '首次定价',
    });
    const [order1, order2] = orders;
    const linked2 = linkItem(
      application,
      order2,
      order2.items[0].id,
      target.id,
      'prefer_source',
    );
    const options: OrderItemStandardizationBatchOptions = {
      standardDisplayPreference: 'prefer_standard',
      useDefaultOrderPrice: true,
      updateProductTotal: true,
    };
    const preview = application.previewOrderItemStandardizationBatch({
      itemIds: [order1.items[0].id, order2.items[0].id],
      standardProductId: target.id,
      options,
    });

    const result = application.applyOrderItemStandardizationBatch({
      itemIds: [order1.items[0].id, order2.items[0].id],
      standardProductId: target.id,
      options,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [order1.id, order2.id],
      expectedOrderRevisions: preview.orders.map((order) => ({
        orderId: order.orderId,
        revision: order.revision,
      })),
    });

    expect(result).toMatchObject({
      standardProduct: expect.objectContaining({ id: target.id }),
      appliedItemCount: 2,
      blockedItemCount: 0,
    });
    expect(result.batchId).toBeTruthy();
    expect(result.results).toEqual([
      expect.objectContaining({
        itemId: order1.items[0].id,
        orderId: order1.id,
        applied: true,
        blockReason: null,
        beforeStandardProductSku: null,
        afterStandardProductSku: 'SKU-BATCH-APPLY',
      }),
      expect.objectContaining({
        itemId: order2.items[0].id,
        orderId: order2.id,
        applied: true,
        blockReason: null,
        beforeStandardProductSku: 'SKU-BATCH-APPLY',
        afterStandardProductSku: 'SKU-BATCH-APPLY',
      }),
    ]);

    const updated1 = application.getOrder(order1.id);
    expect(updated1.order).toMatchObject({
      revision: order1.revision + 1,
      productTotalCents: 2598,
      amountCents: 1600,
      shippingFeeCents: 0,
    });
    expect(updated1.order.items[0]).toMatchObject({
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      unitPriceCents: 1299,
      subtotalCents: 2598,
      standardProduct: expect.objectContaining({ id: target.id }),
      standardizationSource: 'manual',
      standardDisplayPreference: 'prefer_standard',
    });
    expect(updated1.changeEvents.at(0)).toMatchObject({
      source: 'manual_edit',
      baseRevision: order1.revision,
      resultRevision: order1.revision + 1,
    });
    expect(updated1.changeEvents.at(0)?.changes).toEqual(
      expect.arrayContaining([
        { path: 'items[0].standardProductSku', before: null, after: 'SKU-BATCH-APPLY' },
        { path: 'items[0].standardizationSource', before: null, after: 'manual' },
        { path: 'items[0].standardDisplayPreference', before: null, after: 'prefer_standard' },
        { path: 'items[0].unitPriceCents', before: 800, after: 1299 },
        { path: 'productTotalCents', before: 1600, after: 2598 },
      ]),
    );

    const updated2 = application.getOrder(order2.id);
    expect(updated2.order).toMatchObject({
      revision: linked2.revision + 1,
      productTotalCents: 1299,
      amountCents: 800,
    });
    expect(updated2.order.items[0]).toMatchObject({
      unitPriceCents: 1299,
      subtotalCents: 1299,
      standardizationSource: 'manual',
      standardDisplayPreference: 'prefer_standard',
    });
    expect(updated2.changeEvents.at(0)?.changes).toEqual([
      { path: 'items[0].standardDisplayPreference', before: 'prefer_source', after: 'prefer_standard' },
      { path: 'items[0].unitPriceCents', before: 800, after: 1299 },
      { path: 'productTotalCents', before: 800, after: 1299 },
    ]);
  });

  it('已关联其他 SKU 的明细未逐条确认时阻断并留痕，确认覆盖后执行', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-BATCH-OVERRIDE-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '中号', unitPriceCents: 800, quantity: 1 },
      ]),
    ]);
    const target = application.createStandardProduct({
      sku: 'SKU-BATCH-NEW',
      name: '十二分娃鞋',
      specification: '白色',
    });
    const other = application.createStandardProduct({
      sku: 'SKU-BATCH-OLD',
      name: '十二分娃鞋',
      specification: '黑色',
    });
    const order = orders[0];
    linkItem(application, order, order.items[0].id, other.id);
    const linkedOrder = application.getOrder(order.id).order;
    const applyInput = {
      itemIds: [order.items[0].id],
      standardProductId: target.id,
      options: preferStandard,
      expectedOrderRevisions: [{ orderId: order.id, revision: linkedOrder.revision }],
    };

    const blocked = application.applyOrderItemStandardizationBatch({
      ...applyInput,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
    });
    expect(blocked).toMatchObject({ appliedItemCount: 0, blockedItemCount: 1 });
    expect(blocked.results[0]).toMatchObject({
      itemId: order.items[0].id,
      applied: false,
      blockReason: 'linked_other_product',
      beforeStandardProductSku: 'SKU-BATCH-OLD',
      afterStandardProductSku: null,
    });
    expect(application.getOrder(order.id).order.items[0]).toMatchObject({
      standardProduct: expect.objectContaining({ id: other.id }),
    });

    const applied = application.applyOrderItemStandardizationBatch({
      ...applyInput,
      confirmedOverrideItemIds: [order.items[0].id],
      confirmedAmountMismatchOrderIds: [],
    });
    expect(applied).toMatchObject({ appliedItemCount: 1, blockedItemCount: 0 });
    const updated = application.getOrder(order.id);
    expect(updated.order.items[0]).toMatchObject({
      standardProduct: expect.objectContaining({ id: target.id }),
      standardizationSource: 'manual',
      standardDisplayPreference: 'prefer_standard',
    });
    expect(updated.changeEvents.at(0)?.changes).toEqual(
      expect.arrayContaining([
        { path: 'items[0].standardProductSku', before: 'SKU-BATCH-OLD', after: 'SKU-BATCH-NEW' },
      ]),
    );
    expect(blocked.batchId).not.toBe(applied.batchId);
  });

  it('同步单价产生金额差异时未逐条核对则阻断，核对后执行', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-BATCH-MISMATCH-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ]),
    ]);
    const target = application.createStandardProduct({
      sku: 'SKU-BATCH-MISMATCH',
      name: '十二分娃鞋',
      specification: '白色',
      defaultOrderPriceCents: 1299,
      priceChangeReason: '首次定价',
    });
    const order = orders[0];
    const options: OrderItemStandardizationBatchOptions = {
      standardDisplayPreference: 'prefer_standard',
      useDefaultOrderPrice: true,
      updateProductTotal: true,
    };
    const applyInput = {
      itemIds: [order.items[0].id],
      standardProductId: target.id,
      options,
      confirmedOverrideItemIds: [] as string[],
      expectedOrderRevisions: [{ orderId: order.id, revision: order.revision }],
    };

    const blocked = application.applyOrderItemStandardizationBatch({
      ...applyInput,
      confirmedAmountMismatchOrderIds: [],
    });
    expect(blocked.results[0]).toMatchObject({
      applied: false,
      blockReason: 'amount_mismatch',
    });
    expect(application.getOrder(order.id).order.items[0]).toMatchObject({
      unitPriceCents: 800,
      standardProduct: null,
    });

    const applied = application.applyOrderItemStandardizationBatch({
      ...applyInput,
      confirmedAmountMismatchOrderIds: [order.id],
    });
    expect(applied.results[0]).toMatchObject({ applied: true, blockReason: null });
    expect(application.getOrder(order.id).order).toMatchObject({
      productTotalCents: 1299,
      amountCents: 800,
    });
  });

  it('标准商品没有默认单价却勾选同步价格时拒绝整批', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-BATCH-NOPRICE-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ]),
    ]);
    const target = application.createStandardProduct({
      sku: 'SKU-BATCH-NOPRICE',
      name: '十二分娃鞋',
      specification: '白色',
    });
    const order = orders[0];
    const preview = application.previewOrderItemStandardizationBatch({
      itemIds: [order.items[0].id],
      standardProductId: target.id,
      options: {
        standardDisplayPreference: 'prefer_standard',
        useDefaultOrderPrice: true,
        updateProductTotal: false,
      },
    });
    expect(preview).toMatchObject({
      priceSyncRequested: true,
      priceSyncAvailable: false,
      priceAffectedItemCount: 0,
    });

    expect(() => application.applyOrderItemStandardizationBatch({
      itemIds: [order.items[0].id],
      standardProductId: target.id,
      options: {
        standardDisplayPreference: 'prefer_standard',
        useDefaultOrderPrice: true,
        updateProductTotal: false,
      },
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [{ orderId: order.id, revision: order.revision }],
    })).toThrow('标准商品未设置默认订单单价，无法同步商品单价');
    expect(application.getOrder(order.id).order.items[0].standardProduct).toBeNull();
  });

  it('订单正在被其他操作修改时按乐观锁拒绝整批', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-BATCH-LOCK-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ]),
    ]);
    const target = application.createStandardProduct({
      sku: 'SKU-BATCH-LOCK',
      name: '十二分娃鞋',
      specification: '白色',
    });
    const order = orders[0];

    expect(() => application.applyOrderItemStandardizationBatch({
      itemIds: [order.items[0].id],
      standardProductId: target.id,
      options: preferStandard,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [{ orderId: order.id, revision: order.revision + 1 }],
    })).toThrow('订单已在其他操作中更新，请刷新后重试');
    expect(() => application.applyOrderItemStandardizationBatch({
      itemIds: [order.items[0].id],
      standardProductId: target.id,
      options: preferStandard,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [{ orderId: 'order-not-involved', revision: 1 }],
    })).toThrow('订单版本无效，请刷新后重试');
    expect(application.getOrder(order.id).order.items[0].standardProduct).toBeNull();
  });

  it('批量关联逐条结果写入不可变留痕', async () => {
    const { application, dataDirectory, orders } = await openSeededApplication([
      orderSpec('XY-BATCH-AUDIT-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '中号', unitPriceCents: 800, quantity: 1 },
      ]),
    ]);
    const target = application.createStandardProduct({
      sku: 'SKU-BATCH-AUDIT',
      name: '十二分娃鞋',
      specification: '白色',
    });
    const other = application.createStandardProduct({
      sku: 'SKU-BATCH-AUDIT-OLD',
      name: '十二分娃鞋',
      specification: '黑色',
    });
    const order = orders[0];
    linkItem(application, order, order.items[1].id, other.id);
    const linkedOrder = application.getOrder(order.id).order;

    const result = application.applyOrderItemStandardizationBatch({
      itemIds: [order.items[0].id, order.items[1].id],
      standardProductId: target.id,
      options: preferStandard,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [{ orderId: order.id, revision: linkedOrder.revision }],
    });
    expect(result).toMatchObject({ appliedItemCount: 1, blockedItemCount: 1 });
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      const events = database.prepare(`
        SELECT *
        FROM order_item_standardization_batch_events
        WHERE batch_id = ?
        ORDER BY sequence
      `).all(result.batchId) as unknown as Array<Record<string, unknown>>;
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        batch_id: result.batchId,
        order_id: order.id,
        order_item_id: order.items[0].id,
        target_standard_product_id: target.id,
        before_standard_product_id: null,
        after_standard_product_id: target.id,
        standard_display_preference: 'prefer_standard',
        use_default_order_price: 0,
        applied: 1,
        block_reason: null,
      });
      expect(events[1]).toMatchObject({
        order_item_id: order.items[1].id,
        before_standard_product_id: other.id,
        after_standard_product_id: null,
        applied: 0,
        block_reason: 'linked_other_product',
      });
      expect(() => database.prepare(`
        UPDATE order_item_standardization_batch_events
        SET applied = 0
        WHERE batch_id = ?
      `).run(result.batchId)).toThrow(/immutable/u);
      expect(() => database.prepare(`
        DELETE FROM order_item_standardization_batch_events
        WHERE batch_id = ?
      `).run(result.batchId)).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });
});

describe('订单商品批量关联留痕迁移', () => {
  it('从 v44 升级后批量关联留痕表存在且不可变', async () => {
    const { application, dataDirectory, orders } = await openSeededApplication([
      orderSpec('XY-BATCH-MIGRATION-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ]),
    ]);
    const product = application.createStandardProduct({
      sku: 'SKU-BATCH-MIGRATION',
      name: '十二分娃鞋',
      specification: '白色',
    });
    const order = orders[0];
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      removeVersion45ExtensionArtifacts(legacy);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 44 });
      expect(legacy.prepare(`
        SELECT name FROM sqlite_schema
        WHERE name = 'order_item_standardization_batch_events'
      `).all()).toEqual([]);
    } finally {
      legacy.close();
    }

    const migrated = new LocalApplication({
      recognize: async () => { throw new Error('不应调用 OCR'); },
    });
    openedApplications.push(migrated);
    migrated.openDataDirectory(dataDirectory);
    migrated.close();
    openedApplications.splice(openedApplications.indexOf(migrated), 1);

    const verified = new DatabaseSync(databasePath);
    try {
      expect(verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 47 });
      verified.prepare(`
        INSERT INTO order_item_standardization_batch_events (
          id, batch_id, order_id, order_item_id,
          target_standard_product_id, before_standard_product_id, after_standard_product_id,
          standard_display_preference, use_default_order_price,
          applied, block_reason, occurred_at, created_at
        ) VALUES (
          'event-check', 'batch-check', ?, ?,
          ?, NULL, ?,
          'prefer_standard', 0,
          1, NULL, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
        )
      `).run(order.id, order.items[0].id, product.id, product.id);
      expect(verified.prepare(`
        SELECT target_standard_product_id, applied
        FROM order_item_standardization_batch_events
        WHERE id = 'event-check'
      `).get()).toEqual({ target_standard_product_id: product.id, applied: 1 });
      expect(() => verified.prepare(`
        UPDATE order_item_standardization_batch_events SET applied = 0 WHERE id = 'event-check'
      `).run()).toThrow(/immutable/u);
      expect(() => verified.prepare(`
        DELETE FROM order_item_standardization_batch_events WHERE id = 'event-check'
      `).run()).toThrow(/immutable/u);
      expect(verified.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      verified.close();
    }
  });
});
