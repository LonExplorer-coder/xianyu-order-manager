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
import { LocalApplication } from '../src/main/local-application';

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
  sellerAccount?: string;
  items: SeededItemSpec[];
};

function recognition(spec: SeededOrderSpec): RecognitionResult {
  const productTotalCents = spec.items.reduce(
    (total, item) => total + item.unitPriceCents * item.quantity,
    0,
  );
  return {
    platform: 'xianyu',
    sellerAccount: spec.sellerAccount ?? '历史候选测试账号',
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
    orderedAtOriginal: '2026-08-17 09:00:00',
    orderedAtNormalized: '2026-08-17T09:00:00+08:00',
    paidAtOriginal: '2026-08-17 09:00:08',
    paidAtNormalized: '2026-08-17T09:00:08+08:00',
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
  const root = await mkdtemp(join(tmpdir(), 'xianyu-mapping-history-'));
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
    await writeFile(sourcePath, Buffer.from(`mapping-history-${spec.orderNumber}`));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    orders.push(application.confirmDraft(draft));
  }
  return { application, root, dataDirectory, orders };
}

function orderSpec(
  orderNumber: string,
  items: SeededItemSpec[],
  options: { phone?: string; sellerAccount?: string } = {},
): SeededOrderSpec {
  return {
    fileName: `${orderNumber}.png`,
    orderNumber,
    phone: options.phone ?? '13900000001',
    sellerAccount: options.sellerAccount,
    items,
  };
}

function linkItem(
  application: LocalApplication,
  order: OriginalOrder,
  itemId: string,
  standardProductId: string,
): void {
  application.updateOrderItemStandardization(order.id, itemId, {
    standardProductId,
    standardDisplayPreference: 'prefer_standard',
    expectedRevision: order.revision,
  });
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
      trackingNumber: 'SF-HISTORY-0001',
      items,
    }],
  });
}

function openWorkspaceDatabase(dataDirectory: string): DatabaseSync {
  return new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
}

describe('映射历史候选与批量商品身份更正', () => {
  it('映射新增、更正、停用与删除都不自动改写历史订单', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-HISTORY-KEEP-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ]),
    ]);
    const oldProduct = application.createStandardProduct({
      sku: 'SKU-HISTORY-OLD',
      name: '旧商品',
      specification: '白色',
    });
    const newProduct = application.createStandardProduct({
      sku: 'SKU-HISTORY-NEW',
      name: '新商品',
      specification: '白色',
    });
    linkItem(application, orders[0], orders[0].items[0].id, oldProduct.id);
    const mapping = application.createProductMapping(newProduct.id, {
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '历史候选测试账号',
    });

    const linkedAfterCreate = application.getOrder(orders[0].id).order.items[0];
    expect(linkedAfterCreate.standardProduct?.id).toBe(oldProduct.id);

    application.correctProductMapping(mapping.id, {
      standardProductId: oldProduct.id,
      reason: '目标 SKU 维护错误',
    });
    expect(application.getOrder(orders[0].id).order.items[0].standardProduct?.id).toBe(oldProduct.id);

    application.disableProductMapping(mapping.id, { reason: '暂停使用' });
    expect(application.getOrder(orders[0].id).order.items[0].standardProduct?.id).toBe(oldProduct.id);

    application.deleteProductMapping(mapping.id, { reason: '原文写错了' });
    expect(application.getOrder(orders[0].id).order.items[0].standardProduct?.id).toBe(oldProduct.id);
  });

  it('历史候选预览：范围与原文匹配、排除已指向目标的明细并统计已发货与售后订单', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-HISTORY-PREVIEW-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 2 },
      ], { phone: '13900000011' }),
      orderSpec('XY-HISTORY-PREVIEW-2', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ], { phone: '13900000012' }),
      orderSpec('XY-HISTORY-PREVIEW-3', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ], { phone: '13900000013' }),
      orderSpec('XY-HISTORY-PREVIEW-4', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '中号', unitPriceCents: 900, quantity: 1 },
      ], { phone: '13900000014' }),
      orderSpec('XY-HISTORY-PREVIEW-5', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ], { phone: '13900000015', sellerAccount: '其他卖家账号' }),
    ]);
    const oldProduct = application.createStandardProduct({
      sku: 'SKU-PREVIEW-OLD',
      name: '旧商品',
      specification: '白色',
    });
    const newProduct = application.createStandardProduct({
      sku: 'SKU-PREVIEW-NEW',
      name: '新商品',
      specification: '白色',
    });
    const [order1, order2, order3, order4, order5] = orders;
    linkItem(application, order1, order1.items[0].id, oldProduct.id);
    linkItem(application, order2, order2.items[0].id, oldProduct.id);
    linkItem(application, order3, order3.items[0].id, oldProduct.id);
    linkItem(application, order4, order4.items[0].id, newProduct.id);
    linkItem(application, order5, order5.items[0].id, oldProduct.id);
    confirmOrderShipment(application, order1.id);
    const shipment = confirmOrderShipment(application, order3.id);
    application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-17T10:00:00+08:00',
      reason: '测试前置：买家要求换货',
      items: [{
        shipmentPackageItemId: shipment.record.packages[0].items[0].id,
        quantity: 1,
      }],
    });

    const mapping = application.createProductMapping(newProduct.id, {
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '历史候选测试账号',
    });

    const preview = application.previewProductMappingHistoryCandidates(mapping.id);
    expect(preview).toMatchObject({
      orderCount: 3,
      itemCount: 3,
      totalQuantity: 4,
      shippedOrderCount: 2,
      aftersalesOrderCount: 1,
    });
    expect(preview.targetProduct.sku).toBe('SKU-PREVIEW-NEW');
    expect(preview.items.map((item) => item.beforeStandardProductSku)).toEqual([
      'SKU-PREVIEW-OLD',
      'SKU-PREVIEW-OLD',
      'SKU-PREVIEW-OLD',
    ]);
    // 其他卖家的同原文明细不在当前账号适用范围内。
    expect(preview.items.some((item) => item.orderId === order5.id)).toBe(false);
  });

  it('批量更正：只改商品身份，原文数量金额与发货事实不变，逐条留不可变事件', async () => {
    const { application, dataDirectory, orders } = await openSeededApplication([
      orderSpec('XY-HISTORY-APPLY-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 2 },
      ], { phone: '13900000021' }),
      orderSpec('XY-HISTORY-APPLY-2', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ], { phone: '13900000022' }),
    ]);
    const oldProduct = application.createStandardProduct({
      sku: 'SKU-APPLY-OLD',
      name: '旧商品',
      specification: '白色',
    });
    const newProduct = application.createStandardProduct({
      sku: 'SKU-APPLY-NEW',
      name: '新商品',
      specification: '白色',
    });
    const [order1, order2] = orders;
    linkItem(application, order1, order1.items[0].id, oldProduct.id);
    linkItem(application, order2, order2.items[0].id, oldProduct.id);
    const shipment = confirmOrderShipment(application, order1.id);
    application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-17T10:00:00+08:00',
      reason: '测试前置：买家要求换货',
      items: [{
        shipmentPackageItemId: shipment.record.packages[0].items[0].id,
        quantity: 2,
      }],
    });
    const mapping = application.createProductMapping(newProduct.id, {
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '历史候选测试账号',
    });

    const preview = application.previewProductMappingHistoryCandidates(mapping.id);
    const result = application.relinkProductMappingHistoryCandidates(mapping.id, {
      itemIds: preview.items.map((item) => item.itemId),
      reason: '历史关联维护错误，统一更正为新 SKU',
      expectedOrderRevisions: [...new Map(preview.items.map((item) => (
        [item.orderId, item.orderRevision] as const
      ))).entries()].map(([orderId, revision]) => ({ orderId, revision })),
    });

    expect(result).toMatchObject({ appliedItemCount: 2, orderCount: 2 });
    for (const order of [order1, order2]) {
      const item = application.getOrder(order.id).order.items[0];
      expect(item.standardProduct?.sku).toBe('SKU-APPLY-NEW');
      expect(item.sourceTitle).toBe('十二分娃鞋白胚');
      expect(item.sourceSpec).toBe('小号');
      expect(item.quantity).toBe(order.items[0].quantity);
      expect(item.unitPriceCents).toBe(800);
    }

    const database = openWorkspaceDatabase(dataDirectory);
    try {
      const eventRows = database.prepare(`
        SELECT * FROM product_identity_correction_events ORDER BY sequence
      `).all() as Array<Record<string, unknown>>;
      expect(eventRows).toHaveLength(2);
      expect(new Set(eventRows.map((row) => row.correction_id as string)).size).toBe(1);
      expect(eventRows.every((row) => row.reason === '历史关联维护错误，统一更正为新 SKU'))
        .toBe(true);
      expect(eventRows.every((row) => row.before_standard_product_sku === 'SKU-APPLY-OLD'))
        .toBe(true);
      expect(eventRows.every((row) => row.after_standard_product_sku === 'SKU-APPLY-NEW'))
        .toBe(true);
      // 发货与售后业务事实不变：包裹明细数量与商品总数量保持原值。
      const packageQuantities = database.prepare(`
        SELECT quantity FROM shipment_package_items ORDER BY quantity
      `).all() as Array<{ quantity: number }>;
      expect(packageQuantities).toEqual([{ quantity: 2 }]);
      expect(() => database.prepare(
        "UPDATE product_identity_correction_events SET reason = '篡改' WHERE sequence = 1",
      ).run()).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });

  it('工作区映射的历史候选排除被更高优先级账号映射接管的明细', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-HISTORY-SHADOW-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ], { phone: '13900000041' }),
      orderSpec('XY-HISTORY-SHADOW-2', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ], { phone: '13900000042', sellerAccount: '其他卖家账号' }),
    ]);
    const oldProduct = application.createStandardProduct({
      sku: 'SKU-SHADOW-OLD',
      name: '旧商品',
      specification: '白色',
    });
    const newProduct = application.createStandardProduct({
      sku: 'SKU-SHADOW-NEW',
      name: '新商品',
      specification: '白色',
    });
    const [order1, order2] = orders;
    linkItem(application, order1, order1.items[0].id, oldProduct.id);
    linkItem(application, order2, order2.items[0].id, oldProduct.id);
    // 另一卖家账号存在同原文的账号级映射：其订单明细由账号映射接管，
    // 不算命中工作区映射，不进入历史候选。
    const accountTarget = application.createStandardProduct({
      sku: 'SKU-SHADOW-ACCOUNT',
      name: '账号映射商品',
      specification: '白色',
    });
    application.createProductMapping(accountTarget.id, {
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '其他卖家账号',
    });
    const workspaceMapping = application.createProductMapping(newProduct.id, {
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      scope: 'workspace',
    });

    const preview = application.previewProductMappingHistoryCandidates(workspaceMapping.id);
    expect(preview.items.map((item) => item.orderId)).toEqual([order1.id]);
    expect(preview).toMatchObject({ orderCount: 1, itemCount: 1 });
  });

  it('重放守卫：候选变化或订单版本过期时整批拒绝', async () => {
    const { application, orders } = await openSeededApplication([
      orderSpec('XY-HISTORY-GUARD-1', [
        { sourceTitle: '十二分娃鞋白胚', sourceSpec: '小号', unitPriceCents: 800, quantity: 1 },
      ], { phone: '13900000031' }),
    ]);
    const oldProduct = application.createStandardProduct({
      sku: 'SKU-GUARD-OLD',
      name: '旧商品',
      specification: '白色',
    });
    const newProduct = application.createStandardProduct({
      sku: 'SKU-GUARD-NEW',
      name: '新商品',
      specification: '白色',
    });
    linkItem(application, orders[0], orders[0].items[0].id, oldProduct.id);
    const mapping = application.createProductMapping(newProduct.id, {
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '历史候选测试账号',
    });

    const preview = application.previewProductMappingHistoryCandidates(mapping.id);
    const revisions = [...new Map(preview.items.map((item) => (
      [item.orderId, item.orderRevision] as const
    ))).entries()].map(([orderId, revision]) => ({ orderId, revision }));
    expect(() => application.relinkProductMappingHistoryCandidates(mapping.id, {
      itemIds: preview.items.map((item) => item.itemId),
      reason: '',
      expectedOrderRevisions: revisions,
    })).toThrow('映射变更原因无效');

    // 旧版本号必须被拒绝。
    expect(() => application.relinkProductMappingHistoryCandidates(mapping.id, {
      itemIds: preview.items.map((item) => item.itemId),
      reason: '带原因更正',
      expectedOrderRevisions: revisions.map((entry) => ({
        orderId: entry.orderId,
        revision: entry.revision - 1,
      })),
    })).toThrow('订单已在其他操作中更新，请刷新后重试');

    const result = application.relinkProductMappingHistoryCandidates(mapping.id, {
      itemIds: preview.items.map((item) => item.itemId),
      reason: '带原因更正',
      expectedOrderRevisions: revisions,
    });
    expect(result.appliedItemCount).toBe(1);

    // 更正后的明细不再是候选，重放同一批明细必须整批拒绝。
    expect(() => application.relinkProductMappingHistoryCandidates(mapping.id, {
      itemIds: preview.items.map((item) => item.itemId),
      reason: '重复提交',
      expectedOrderRevisions: revisions,
    })).toThrow('商品映射或订单已变化，请刷新预览后重试');
  });
});
