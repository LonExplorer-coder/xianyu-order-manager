import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import type { InventoryMovementView, InventoryProductView, InventoryView } from '../src/core/inventory-ledger';
import type { LocalApplication } from '../src/main/local-application';
import { LocalApplication as LocalApplicationClass } from '../src/main/local-application';

const openedApplications: LocalApplication[] = [];

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

type HookItem = {
  sourceTitle: string;
  sourceSpec?: string;
  quantity: number;
  unitPriceCents?: number;
};

function hookRecognition(
  orderNumber: string,
  items: HookItem[],
  recipient?: { name: string; phone: string },
): RecognitionResult {
  const normalizedItems = items.map((item) => ({
    sourceTitle: item.sourceTitle,
    sourceSpec: item.sourceSpec ?? '标准款',
    unitPriceCents: item.unitPriceCents ?? 800,
    quantity: item.quantity,
    quantityInferred: false,
  }));
  const quantity = normalizedItems.reduce((total, item) => total + item.quantity, 0);
  return {
    platform: 'xianyu',
    sellerAccount: '库存挂点测试账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient: recipient?.name ?? '库存挂点收件人',
    phone: recipient?.phone ?? '13900000001',
    phoneNormalized: recipient?.phone ?? '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-19 08:00:00',
    orderedAtNormalized: '2026-08-19T08:00:00+08:00',
    paidAtOriginal: '2026-08-19 08:00:08',
    paidAtNormalized: '2026-08-19T08:00:08+08:00',
    productTotalCents: normalizedItems.reduce(
      (total, item) => total + item.unitPriceCents * item.quantity,
      0,
    ),
    shippingFeeCents: 0,
    amountCents: 800 * quantity,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: normalizedItems,
  };
}

const BOX_PRODUCT = { name: '玻璃保鲜盒', specification: '1000ml', sku: 'SKU-INV-A' };
const CLIP_PRODUCT = { name: '硅胶封口夹', specification: '大号', sku: 'SKU-INV-B' };

type SeededApplication = {
  application: LocalApplication;
  orders: Array<ReturnType<LocalApplication['getOrder']>['order']>;
};

async function openHookApplication(
  recognitions: RecognitionResult[],
  options: { withProducts?: boolean } = { withProducts: true },
): Promise<SeededApplication> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-19T01:30:00.000Z'));
  const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-hooks-'));
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const application = new LocalApplicationClass(new SequenceRecognizer([...recognitions]));
  openedApplications.push(application);
  application.openDataDirectory(join(root, '数据'));
  if (options.withProducts) {
    for (const product of [BOX_PRODUCT, CLIP_PRODUCT]) {
      application.createStandardProduct({
        ...product,
        defaultOrderPriceCents: 800,
        priceChangeReason: '首次定价',
      });
    }
  }
  const orders: SeededApplication['orders'] = [];
  for (let index = 0; index < recognitions.length; index += 1) {
    const sourcePath = join(sourceDirectory, `订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`inventory-hook-source-${index}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    orders.push(application.confirmDraft(batch.drafts[0]));
  }
  return { application, orders };
}

function productOf(view: InventoryView, sku: string): InventoryProductView {
  const target = view.products.find((candidate) => candidate.sku === sku);
  if (!target) throw new Error(`测试未找到商品 ${sku}`);
  return target;
}

function adjustStock(
  application: LocalApplication,
  product: { sku: string },
  quantity: number,
): void {
  const target = productOf(application.queryInventory(), product.sku);
  application.recordInventoryAdjustment({
    standardProductId: target.standardProductId,
    quantity,
    direction: 'in',
    state: 'sellable',
    reason: `期初入库 ${quantity} 件`,
  });
}

function movementKeys(movements: readonly InventoryMovementView[]): string[] {
  return movements.map((movement) => (
    `${movement.sku}|${movement.direction}|${movement.state}|${movement.quantity}`
  )).sort();
}

function confirmFullShipment(application: LocalApplication, orderIndex: number, trackingNumber: string) {
  const group = application.queryShipmentGroups().groups.find(({ orders }) => (
    orders.length > orderIndex
  ));
  if (!group) throw new Error('测试前置缺少发货组');
  const order = group.orders[orderIndex];
  const items = order.items.map((item) => ({
    orderId: order.id,
    orderItemId: item.id,
    quantity: item.quantity,
  }));
  return application.confirmShipment({
    groupId: group.id,
    expectedRemainingItems: items,
    packages: [{
      shippingCarrier: '顺丰速运',
      trackingNumber,
      items,
    }],
  });
}

function markDelivered(application: LocalApplication, recordId: string, packageId: string, revision: number) {
  return application.updateShipmentPackageLogisticsStatus({
    recordId,
    packageId,
    expectedRevision: revision,
    logisticsStatus: 'delivered',
    occurredAt: '2026-08-19T10:00:00+08:00',
    reason: '测试前置：买家已签收',
  });
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
  vi.useRealTimers();
});

describe('发货、补发、退货与拦截接入库存流水', () => {
  it('原订单实际发出按发出数量扣减可销售库存，未映射商品不静默扣减', async () => {
    const { application } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0001', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 3 },
      ]),
      hookRecognition('XY-INV-HOOK-0002', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 2 },
        { sourceTitle: '手作发夹', sourceSpec: '蓝色', quantity: 1 },
      ], { name: '库存挂点收件人乙', phone: '13900000002' }),
    ]);
    adjustStock(application, BOX_PRODUCT, 5);

    const first = confirmFullShipment(application, 0, 'SF-HOOK-0001');
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku))
      .toMatchObject({ sellableQuantity: 2, awaitingInspectionQuantity: 0 });
    const firstMovement = application.queryInventory().movements.find(
      ({ sourceType }) => sourceType === 'shipment_dispatch',
    );
    expect(firstMovement).toMatchObject({
      sku: BOX_PRODUCT.sku,
      quantity: 3,
      direction: 'out',
      state: 'sellable',
      sourceId: first.record.id,
      reason: '订单实际发出',
    });

    const group = application.queryShipmentGroups().groups.find(({ orders }) => (
      orders.some(({ items }) => items.some(({ sourceTitle }) => sourceTitle === '手作发夹'))
    ));
    if (!group) throw new Error('测试前置缺少第二订单发货组');
    const order = group.orders.find(({ items }) => (
      items.some(({ sourceTitle }) => sourceTitle === '手作发夹')
    ))!;
    const boxItem = order.items.find(({ sourceTitle }) => sourceTitle === BOX_PRODUCT.name)!;
    const unmappedItem = order.items.find(({ sourceTitle }) => sourceTitle === '手作发夹')!;
    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      })),
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-HOOK-0002',
        items: [
          { orderId: order.id, orderItemId: boxItem.id, quantity: 1 },
          { orderId: order.id, orderItemId: unmappedItem.id, quantity: 1 },
        ],
      }],
    });
    const view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku).sellableQuantity).toBe(1);
    expect(view.movements.filter(({ sourceType }) => sourceType === 'shipment_dispatch'))
      .toHaveLength(2);
    expect(view.movements.some(({ sku }) => sku === '手作发夹')).toBe(false);
  });

  it('申请退货与退货运输中不产生任何库存变化', async () => {
    const { application } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0003', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 1 },
      ]),
    ]);
    adjustStock(application, BOX_PRODUCT, 4);
    const shipment = confirmFullShipment(application, 0, 'SF-HOOK-0003');
    markDelivered(
      application,
      shipment.record.id,
      shipment.record.packages[0].id,
      shipment.record.packages[0].revision,
    );
    const before = application.queryInventory();

    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-exchange',
      occurredAt: '2026-08-19T10:10:00+08:00',
      reason: '买家反馈破损，准备换货',
      items: [{
        shipmentPackageItemId: shipment.record.packages[0].items[0].id,
        quantity: 1,
      }],
    });
    application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-HOOK-RETURN-0001',
      occurredAt: '2026-08-19T10:20:00+08:00',
      reason: '买家已经寄回',
    });
    const after = application.queryInventory();
    expect(after.movements).toHaveLength(before.movements.length);
    expect(productOf(after, BOX_PRODUCT.sku)).toMatchObject(
      (({ reservedQuantity, ...rest }) => rest)(productOf(before, BOX_PRODUCT.sku)),
    );
  });

  it('拦截请求成功但包裹尚未退回不增加库存', async () => {
    const { application } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0004', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 1 },
      ]),
    ]);
    adjustStock(application, BOX_PRODUCT, 2);
    const shipment = confirmFullShipment(application, 0, 'SF-HOOK-0004');
    const shipmentPackage = shipment.record.packages[0];
    const before = application.queryInventory().movements.length;

    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'intercept',
      requestedRefundCents: 800,
      occurredAt: '2026-08-19T11:00:00+08:00',
      reason: '地址错误，申请拦截',
      items: [{ shipmentPackageItemId: shipmentPackage.items[0].id, quantity: 1 }],
    });
    application.progressAftersalesCase({
      kind: 'record_interception_result',
      caseId: created.id,
      expectedRevision: created.revision,
      result: 'succeeded',
      occurredAt: '2026-08-19T11:10:00+08:00',
      reason: '承运方确认拦截成功',
    });
    const after = application.queryInventory();
    expect(after.movements).toHaveLength(before);
    expect(productOf(after, BOX_PRODUCT.sku).awaitingInspectionQuantity).toBe(0);
  });

  it('退货实际收到先进入待检查，检查结果按商品分流进入对应库存分类', async () => {
    const { application } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0005', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 1 },
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 1 },
        { sourceTitle: CLIP_PRODUCT.name, sourceSpec: CLIP_PRODUCT.specification, quantity: 1 },
      ]),
    ]);
    adjustStock(application, BOX_PRODUCT, 10);
    adjustStock(application, CLIP_PRODUCT, 10);
    const shipment = confirmFullShipment(application, 0, 'SF-HOOK-0005');
    markDelivered(
      application,
      shipment.record.id,
      shipment.record.packages[0].id,
      shipment.record.packages[0].revision,
    );

    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-exchange',
      occurredAt: '2026-08-19T10:10:00+08:00',
      reason: '换货处理',
      items: shipment.record.packages[0].items.map((item) => ({
        shipmentPackageItemId: item.id,
        quantity: item.quantity,
      })),
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-HOOK-RETURN-0002',
      occurredAt: '2026-08-19T10:20:00+08:00',
      reason: '买家寄回全部商品',
    });
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-19T10:30:00+08:00',
      reason: '卖家实际收到退货',
      items: registered.returns[0].items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.quantity,
      })),
    });
    let view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 8,
      awaitingInspectionQuantity: 2,
    });
    expect(productOf(view, CLIP_PRODUCT.sku).awaitingInspectionQuantity).toBe(1);
    const receiptMovements = view.movements.filter(
      ({ sourceType }) => sourceType === 'return_receipt',
    );
    expect(movementKeys(receiptMovements)).toEqual([
      `${BOX_PRODUCT.sku}|in|awaiting_inspection|2`,
      `${CLIP_PRODUCT.sku}|in|awaiting_inspection|1`,
    ]);
    expect(receiptMovements.every(({ sourceId }) => (
      sourceId === registered.returns[0].id
    ))).toBe(true);

    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: received.returns[0].id,
      result: 'resellable',
      occurredAt: '2026-08-19T10:40:00+08:00',
      note: '逐件检查分流',
      items: [
        { returnRecordItemId: received.returns[0].items[0].id, acceptedQuantity: 1, result: 'resellable', note: '完好' },
        { returnRecordItemId: received.returns[0].items[1].id, acceptedQuantity: 1, result: 'scrapped', note: '破损报废' },
        { returnRecordItemId: received.returns[0].items[2].id, acceptedQuantity: 1, result: 'other', note: '另行处置' },
      ],
    });
    view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 9,
      awaitingInspectionQuantity: 0,
      scrappedQuantity: 1,
    });
    // 「其他」结论不离开待检查，与人工检查入口口径一致，等待后续库存处理。
    expect(productOf(view, CLIP_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 9,
      awaitingInspectionQuantity: 1,
    });
    const inspectionMovements = view.movements.filter(
      ({ sourceType }) => sourceType === 'inspection_result',
    );
    expect(movementKeys(inspectionMovements)).toEqual([
      `${BOX_PRODUCT.sku}|in|scrapped|1`,
      `${BOX_PRODUCT.sku}|in|sellable|1`,
      `${BOX_PRODUCT.sku}|out|awaiting_inspection|2`,
    ]);

    const replacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: inspected.id,
      roundId: inspected.rounds[0].id,
      expectedRevision: inspected.revision,
      occurredAt: '2026-08-19T10:50:00+08:00',
      reason: '检查完成后发出换货商品',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-HOOK-REPLACEMENT-0001',
        items: inspected.rounds[0].items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });
    view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku).sellableQuantity).toBe(7);
    expect(productOf(view, CLIP_PRODUCT.sku).sellableQuantity).toBe(8);
    const replacementMovements = view.movements.filter(
      ({ sourceType }) => sourceType === 'replacement_dispatch',
    );
    expect(movementKeys(replacementMovements)).toEqual([
      `${BOX_PRODUCT.sku}|out|sellable|2`,
      `${CLIP_PRODUCT.sku}|out|sellable|1`,
    ]);
    expect(replacementMovements.every(({ sourceId }) => (
      sourceId === replacement.rounds[0].replacementShipment?.id
    ))).toBe(true);
  });

  it('部分收到只按实际收到数量进入待检查', async () => {
    const { application } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0006', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 2 },
      ]),
    ]);
    adjustStock(application, BOX_PRODUCT, 5);
    const shipment = confirmFullShipment(application, 0, 'SF-HOOK-0006');
    markDelivered(
      application,
      shipment.record.id,
      shipment.record.packages[0].id,
      shipment.record.packages[0].revision,
    );
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      requestedRefundCents: 1_600,
      occurredAt: '2026-08-19T10:10:00+08:00',
      reason: '退货退款',
      items: [{
        shipmentPackageItemId: shipment.record.packages[0].items[0].id,
        quantity: 2,
      }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-HOOK-RETURN-0003',
      occurredAt: '2026-08-19T10:20:00+08:00',
      reason: '买家寄回两件',
    });
    application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-19T10:30:00+08:00',
      reason: '只收到一件，另一件缺件',
      items: [{
        returnRecordItemId: registered.returns[0].items[0].id,
        receivedQuantity: 1,
      }],
    });
    const view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku).awaitingInspectionQuantity).toBe(1);
    expect(view.movements).toContainEqual(expect.objectContaining({
      sku: BOX_PRODUCT.sku,
      quantity: 1,
      direction: 'in',
      state: 'awaiting_inspection',
      sourceType: 'return_receipt',
    }));
  });

  it('退货确认丢件不能登记收到，不产生退货入库；补发仍单独出库', async () => {
    const { application, orders } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0007', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 2 },
      ]),
      hookRecognition('XY-INV-HOOK-0008', [
        { sourceTitle: CLIP_PRODUCT.name, sourceSpec: CLIP_PRODUCT.specification, quantity: 1 },
      ], { name: '库存挂点收件人丙', phone: '13900000003' }),
    ]);
    adjustStock(application, BOX_PRODUCT, 5);
    adjustStock(application, CLIP_PRODUCT, 5);
    const lostShipment = confirmFullShipment(application, 0, 'SF-HOOK-0007');
    markDelivered(
      application,
      lostShipment.record.id,
      lostShipment.record.packages[0].id,
      lostShipment.record.packages[0].revision,
    );
    const created = application.createAftersalesCase({
      shipmentRecordId: lostShipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      requestedRefundCents: 1_600,
      occurredAt: '2026-08-19T10:10:00+08:00',
      reason: '退货退款后丢件',
      items: [{
        shipmentPackageItemId: lostShipment.record.packages[0].items[0].id,
        quantity: 2,
      }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-HOOK-RETURN-0004',
      occurredAt: '2026-08-19T10:20:00+08:00',
      reason: '买家已寄回',
    });
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-19T10:40:00+08:00',
      reason: '已核对承运方揽收证据',
    });
    const withLoss = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: registered.returns[0].id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-19T10:59:00+08:00',
      reason: '承运方确认退货包裹丢失',
    });
    expect(() => application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: withLoss.id,
      expectedRevision: withLoss.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-19T11:00:00+08:00',
      reason: '丢件后不能确认收到',
      items: [{
        returnRecordItemId: registered.returns[0].items[0].id,
        receivedQuantity: 0,
      }],
    })).toThrow('退货已确认丢失');
    let view = application.queryInventory();
    expect(view.movements.some(({ sourceType }) => sourceType === 'return_receipt')).toBe(false);
    expect(productOf(view, BOX_PRODUCT.sku).awaitingInspectionQuantity).toBe(0);

    const replacementShipment = confirmFullShipment(application, 0, 'SF-HOOK-0008');
    expect(replacementShipment.record.packages[0].items[0].orderId).toBe(orders[1].id);
    view = application.queryInventory();
    expect(view.movements).toContainEqual(expect.objectContaining({
      sku: CLIP_PRODUCT.sku,
      quantity: 1,
      direction: 'out',
      state: 'sellable',
      sourceType: 'shipment_dispatch',
    }));
  });

  it('拦截退回包裹检查先入待检查再按结果进入分类', async () => {
    const { application } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0009', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 1 },
      ]),
    ]);
    adjustStock(application, BOX_PRODUCT, 2);
    const shipment = confirmFullShipment(application, 0, 'SF-HOOK-0009');
    const shipmentPackage = shipment.record.packages[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'intercept',
      requestedRefundCents: 800,
      occurredAt: '2026-08-19T11:00:00+08:00',
      reason: '地址错误，申请拦截',
      items: [{ shipmentPackageItemId: shipmentPackage.items[0].id, quantity: 1 }],
    });
    const succeeded = application.progressAftersalesCase({
      kind: 'record_interception_result',
      caseId: created.id,
      expectedRevision: created.revision,
      result: 'succeeded',
      occurredAt: '2026-08-19T11:10:00+08:00',
      reason: '承运方确认拦截成功',
    });
    application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'returned',
      occurredAt: '2026-08-19T11:30:00+08:00',
      reason: '卖家实际收到拦截退回包裹',
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_intercepted_return',
      caseId: succeeded.id,
      expectedRevision: succeeded.revision,
      packageId: shipmentPackage.id,
      result: 'resellable',
      occurredAt: '2026-08-19T11:40:00+08:00',
      reason: '检查完好可重新销售',
      items: [{ shipmentPackageItemId: shipmentPackage.items[0].id, quantity: 1 }],
    });
    const view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 2,
      awaitingInspectionQuantity: 0,
    });
    if (!inspected.coordination.interceptedReturnInspection) {
      throw new Error('测试前置缺少拦截退回检查');
    }
    const receiptLeg = view.movements.find(
      ({ sourceType, state, direction }) => (
        sourceType === 'return_receipt' && state === 'awaiting_inspection' && direction === 'in'
      ),
    );
    expect(receiptLeg).toMatchObject({
      sku: BOX_PRODUCT.sku,
      quantity: 1,
      reason: '拦截退回实际收到',
    });
    const inspectionLegs = view.movements.filter(({ sourceType }) => (
      sourceType === 'inspection_result'
    ));
    expect(movementKeys(inspectionLegs)).toEqual([
      `${BOX_PRODUCT.sku}|in|sellable|1`,
      `${BOX_PRODUCT.sku}|out|awaiting_inspection|1`,
    ]);
    expect(receiptLeg?.sourceId).toBe(inspectionLegs[0]?.sourceId);
  });

  it('未交寄撤销按包裹冲正可销售库存并保留原发货流水', async () => {
    const { application, orders } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0010', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 2 },
      ]),
    ]);
    adjustStock(application, BOX_PRODUCT, 5);
    const group = application.queryShipmentGroups().groups[0];
    const order = group.orders[0];
    const items = order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    }));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: items,
      packages: [
        {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-HOOK-0010-A',
          items: [{ orderId: order.id, orderItemId: items[0].orderItemId, quantity: 1 }],
        },
        {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-HOOK-0010-B',
          items: [{ orderId: order.id, orderItemId: items[0].orderItemId, quantity: 1 }],
        },
      ],
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity).toBe(3);
    application.cancelShipmentPackages({
      recordId: shipment.record.id,
      packageIds: [shipment.record.packages[0].id],
      reason: '第一个包裹未交寄，撤销重发',
    });
    const view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku).sellableQuantity).toBe(4);
    const dispatchRow = view.movements.find(
      ({ sourceType }) => sourceType === 'shipment_dispatch',
    );
    expect(dispatchRow).toMatchObject({ quantity: 2, direction: 'out' });
    const voidRow = view.movements.find(({ sourceType }) => sourceType === 'shipment_void');
    expect(voidRow).toMatchObject({
      sku: BOX_PRODUCT.sku,
      quantity: 1,
      direction: 'in',
      state: 'sellable',
      reason: '未交寄撤销冲正',
    });

    const replacementCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-19T10:10:00+08:00',
      reason: '直接补发',
      items: [{ shipmentPackageItemId: shipment.record.packages[1].items[0].id, quantity: 1 }],
    });
    const replacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: replacementCase.id,
      roundId: replacementCase.rounds[0].id,
      expectedRevision: replacementCase.revision,
      occurredAt: '2026-08-19T10:20:00+08:00',
      reason: '建立补发记录',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-HOOK-REPLACEMENT-VOID',
        items: [{
          roundItemId: replacementCase.rounds[0].items[0].id,
          quantity: 1,
        }],
      }],
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity).toBe(3);
    const replacementRecord = replacement.rounds[0].replacementShipment;
    if (!replacementRecord) throw new Error('测试前置补发记录不存在');
    application.cancelShipmentPackages({
      recordId: replacementRecord.id,
      packageIds: [replacementRecord.packages[0].id],
      reason: '补发运单填错且未交寄，作废',
    });
    const finalView = application.queryInventory();
    expect(productOf(finalView, BOX_PRODUCT.sku).sellableQuantity).toBe(4);
    expect(finalView.movements.filter(({ sourceType }) => sourceType === 'shipment_void'))
      .toHaveLength(2);
    expect(orders).toHaveLength(1);
  });

  it('售后详情库存影响按处理单聚合全部相关流水', async () => {
    const { application } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0011', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 1 },
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 1 },
        { sourceTitle: CLIP_PRODUCT.name, sourceSpec: CLIP_PRODUCT.specification, quantity: 1 },
      ]),
    ]);
    adjustStock(application, BOX_PRODUCT, 10);
    const shipment = confirmFullShipment(application, 0, 'SF-HOOK-0011');
    markDelivered(
      application,
      shipment.record.id,
      shipment.record.packages[0].id,
      shipment.record.packages[0].revision,
    );
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-exchange',
      occurredAt: '2026-08-19T10:10:00+08:00',
      reason: '换货处理',
      items: shipment.record.packages[0].items
        .filter(({ sourceTitle }) => sourceTitle === BOX_PRODUCT.name)
        .map((item) => ({
          shipmentPackageItemId: item.id,
          quantity: item.quantity,
        })),
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-HOOK-RETURN-0005',
      occurredAt: '2026-08-19T10:20:00+08:00',
      reason: '买家寄回',
    });
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-19T10:30:00+08:00',
      reason: '卖家收到',
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: received.returns[0].id,
      result: 'resellable',
      occurredAt: '2026-08-19T10:40:00+08:00',
      note: '完好',
    });
    const replaced = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: inspected.id,
      roundId: inspected.rounds[0].id,
      expectedRevision: inspected.revision,
      occurredAt: '2026-08-19T10:50:00+08:00',
      reason: '发出换货商品',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-HOOK-REPLACEMENT-0011',
        items: inspected.rounds[0].items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });
    const impact = application.queryAftersalesInventoryImpact(created.id);
    expect(movementKeys(impact)).toEqual([
      `${BOX_PRODUCT.sku}|in|awaiting_inspection|2`,
      `${BOX_PRODUCT.sku}|in|sellable|2`,
      `${BOX_PRODUCT.sku}|out|awaiting_inspection|2`,
      `${BOX_PRODUCT.sku}|out|sellable|2`,
    ]);
    expect(impact.every(({ sourceId }) => (
      sourceId === registered.returns[0].id
      || sourceId === replaced.rounds[0].replacementShipment?.id
    ))).toBe(true);

    const replacementRecord = replaced.rounds[0].replacementShipment;
    if (!replacementRecord) throw new Error('测试前置补发记录不存在');
    application.cancelShipmentPackages({
      recordId: replacementRecord.id,
      packageIds: [replacementRecord.packages[0].id],
      reason: '补发未交寄作废',
    });
    const impactWithVoid = application.queryAftersalesInventoryImpact(created.id);
    expect(movementKeys(impactWithVoid)).toEqual([
      `${BOX_PRODUCT.sku}|in|awaiting_inspection|2`,
      `${BOX_PRODUCT.sku}|in|sellable|2`,
      `${BOX_PRODUCT.sku}|in|sellable|2`,
      `${BOX_PRODUCT.sku}|out|awaiting_inspection|2`,
      `${BOX_PRODUCT.sku}|out|sellable|2`,
    ]);

    const clipItem = shipment.record.packages[0].items.find(
      ({ sourceTitle }) => sourceTitle === CLIP_PRODUCT.name,
    );
    if (!clipItem) throw new Error('测试前置缺少夹子条目');
    const refundOnly = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-refund-only',
      requestedRefundCents: 800,
      occurredAt: '2026-08-19T12:00:00+08:00',
      reason: '仅退款处理',
      items: [{ shipmentPackageItemId: clipItem.id, quantity: 1 }],
    });
    expect(application.queryAftersalesInventoryImpact(refundOnly.id)).toEqual([]);
  });

  it('事实之间补齐商品映射不回补库存账，两腿保持对称', async () => {
    const { application, orders } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0014', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 1 },
        { sourceTitle: '手作发夹', sourceSpec: '蓝色', quantity: 1 },
      ]),
      hookRecognition('XY-INV-HOOK-0015', [
        { sourceTitle: '手作发夹', sourceSpec: '蓝色', quantity: 2 },
      ], { name: '库存挂点收件人戊', phone: '13900000005' }),
    ]);
    adjustStock(application, BOX_PRODUCT, 3);
    adjustStock(application, CLIP_PRODUCT, 3);

    const group = application.queryShipmentGroups().groups[0];
    const order = group.orders[0];
    const items = order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    }));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: items,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-HOOK-0014',
        items,
      }],
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity).toBe(2);
    application.cancelShipmentPackages({
      recordId: shipment.record.id,
      packageIds: [shipment.record.packages[0].id],
      reason: '未交寄整包撤销',
    });
    // 发夹在发货时未映射没有扣减腿，撤销时也不产生冲正腿。
    let view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku).sellableQuantity).toBe(3);
    expect(view.movements.some(({ sourceType, sku }) => (
      sourceType === 'shipment_void' && sku !== BOX_PRODUCT.sku
    ))).toBe(false);

    const returnGroup = application.queryShipmentGroups().groups.find(({ orders: groupOrders }) => (
      groupOrders.some(({ id }) => id === orders[1].id)
    ));
    if (!returnGroup) throw new Error('测试前置缺少退货用发货组');
    const returnOrder = returnGroup.orders[0];
    const returnItems = returnOrder.items.map((item) => ({
      orderId: returnOrder.id,
      orderItemId: item.id,
      quantity: item.quantity,
    }));
    const returnShipment = application.confirmShipment({
      groupId: returnGroup.id,
      expectedRemainingItems: returnItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-HOOK-0015',
        items: returnItems,
      }],
    });
    markDelivered(
      application,
      returnShipment.record.id,
      returnShipment.record.packages[0].id,
      returnShipment.record.packages[0].revision,
    );
    const created = application.createAftersalesCase({
      shipmentRecordId: returnShipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      requestedRefundCents: 1_600,
      occurredAt: '2026-08-19T10:10:00+08:00',
      reason: '退货退款',
      items: [{
        shipmentPackageItemId: returnShipment.record.packages[0].items[0].id,
        quantity: 2,
      }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-HOOK-RETURN-0006',
      occurredAt: '2026-08-19T10:20:00+08:00',
      reason: '买家已寄回',
    });
    application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-19T10:30:00+08:00',
      reason: '卖家收到未映射商品',
      items: [{
        returnRecordItemId: registered.returns[0].items[0].id,
        receivedQuantity: 2,
      }],
    });
    // 签收后才把订单条目映射到标准商品，检查腿没有对应入库腿，跳过不回补。
    const clipProduct = application.queryInventory().products.find(
      ({ sku }) => sku === CLIP_PRODUCT.sku,
    )!;
    const refreshed = application.getOrder(orders[1].id).order;
    application.updateOrderItemStandardization(orders[1].id, refreshed.items[0].id, {
      standardProductId: clipProduct.standardProductId,
      expectedRevision: refreshed.revision,
    });
    const received = application.queryAftersalesCases({
      shipmentRecordId: returnShipment.record.id,
    })[0];
    const latestReturn = received.returns[0];
    application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: latestReturn.id,
      result: 'resellable',
      occurredAt: '2026-08-19T10:40:00+08:00',
      note: '签收后补映射',
      items: [{
        returnRecordItemId: latestReturn.items[0].id,
        acceptedQuantity: 2,
        result: 'resellable',
        note: '完好',
      }],
    });
    view = application.queryInventory();
    expect(view.movements.some(({ sourceType }) => (
      sourceType === 'return_receipt' || sourceType === 'inspection_result'
    ))).toBe(false);
    expect(productOf(view, CLIP_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 3,
      awaitingInspectionQuantity: 0,
    });
  });

  it('账面为负时需求覆盖钳制为零，不出现负覆盖', async () => {
    const { application } = await openHookApplication([
      hookRecognition('XY-INV-HOOK-0012', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 3 },
      ]),
      hookRecognition('XY-INV-HOOK-0013', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 2 },
      ], { name: '库存挂点收件人丁', phone: '13900000004' }),
    ]);
    confirmFullShipment(application, 0, 'SF-HOOK-0012');
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity).toBe(-3);
    const plan = application.createFulfillmentPlan({
      type: 'presale',
      name: '负账面覆盖测试',
      expectedShipAt: '2026-09-30T00:00:00.000Z',
      reason: '预售备货',
    });
    const pendingGroup = application.queryShipmentGroups().groups.find(({ orders }) => (
      orders.some(({ recipient }) => recipient === '库存挂点收件人丁')
    ));
    if (!pendingGroup) throw new Error('测试前置缺少待发货订单');
    application.addFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: plan.revision,
      orderIds: [pendingGroup.orders[0].id],
      reason: '加入预售计划',
    });
    const demand = application.queryFulfillmentDemand(plan.id);
    expect(demand.totals.demandQuantity).toBe(2);
    expect(demand.totals.sellableCoveredQuantity).toBe(0);
  });
});
