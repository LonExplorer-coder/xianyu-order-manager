import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import type { OriginalOrder } from '../src/core/contracts';
import type {
  InventoryMovementView,
  InventoryProductView,
  InventoryView,
} from '../src/core/inventory-ledger';
import { inventoryStateLabel } from '../src/core/inventory-ledger';
import type { FulfillmentPlanView } from '../src/core/fulfillment-plans';
import { LocalApplication } from '../src/main/local-application';

const applications: LocalApplication[] = [];

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
});

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

type LedgerItem = {
  sourceTitle: string;
  sourceSpec?: string;
  quantity: number;
  unitPriceCents?: number;
};

function ledgerRecognition(orderNumber: string, items: LedgerItem[]): RecognitionResult {
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
    sellerAccount: '默认闲鱼账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient: '库存测试收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-18 08:00:00',
    orderedAtNormalized: '2026-08-18T08:00:00+08:00',
    paidAtOriginal: '2026-08-18 08:00:08',
    paidAtNormalized: '2026-08-18T08:00:08+08:00',
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

async function openSeededApplication(
  root: string,
  recognitions: RecognitionResult[],
  standardProducts: Array<{ sku: string; name: string; specification: string }> = [],
): Promise<{ application: LocalApplication; sources: string[] }> {
  const dataDirectory = join(root, '数据');
  const application = new LocalApplication(new SequenceRecognizer(recognitions));
  applications.push(application);
  application.openDataDirectory(dataDirectory);
  for (const product of standardProducts) {
    application.createStandardProduct({
      ...product,
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
  }
  const sources: string[] = [];
  for (let index = 0; index < recognitions.length; index += 1) {
    const sourcePath = join(root, `库存订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`inventory-source-${index}`));
    sources.push(sourcePath);
  }
  return { application, sources };
}

function adjust(
  application: LocalApplication,
  product: { sku: string },
  input: Record<string, unknown>,
): InventoryView {
  const products = application.queryInventory().products;
  const target = products.find((candidate) => candidate.sku === product.sku);
  if (!target) throw new Error(`测试未找到商品 ${product.sku}`);
  return application.recordInventoryAdjustment({
    standardProductId: target.standardProductId,
    ...input,
  });
}

function productOf(view: InventoryView, sku: string): InventoryProductView {
  const product = view.products.find((candidate) => candidate.sku === sku);
  if (!product) throw new Error(`测试未找到商品 ${sku}`);
  return product;
}

function refreshRevision(application: LocalApplication, orderId: string): number {
  return application.getOrder(orderId).order.revision;
}

describe('库存流水与四态统计', () => {
  it('空库时所有标准商品六数为零，无流水与未映射提醒', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-empty-'));
    const { application } = await openSeededApplication(root, [], [
      BOX_PRODUCT,
      CLIP_PRODUCT,
    ]);
    const view = application.queryInventory();
    expect(view.products.map(({ sku }) => sku)).toEqual([BOX_PRODUCT.sku, CLIP_PRODUCT.sku]);
    for (const product of view.products) {
      expect(product).toMatchObject({
        name: product.sku === BOX_PRODUCT.sku ? BOX_PRODUCT.name : CLIP_PRODUCT.name,
        sellableQuantity: 0,
        awaitingInspectionQuantity: 0,
        defectiveQuantity: 0,
        scrappedQuantity: 0,
        reservedQuantity: 0,
        purchaseInTransitQuantity: 0,
      });
    }
    expect(view.movements).toEqual([]);
    expect(view.unmappedPendingShipment).toEqual([]);
  });

  it('期初入库增加可销售并生成可追溯到来源的流水', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-open-'));
    const { application } = await openSeededApplication(root, [], [BOX_PRODUCT]);
    const view = adjust(application, BOX_PRODUCT, {
      quantity: 4,
      direction: 'in',
      state: 'sellable',
      reason: '期初入库',
    });
    expect(productOf(view, BOX_PRODUCT.sku).sellableQuantity).toBe(4);
    expect(view.movements).toHaveLength(1);
    const movement: InventoryMovementView = view.movements[0];
    expect(movement).toMatchObject({
      sku: BOX_PRODUCT.sku,
      name: BOX_PRODUCT.name,
      specification: BOX_PRODUCT.specification,
      quantity: 4,
      direction: 'in',
      state: 'sellable',
      sourceType: 'manual_adjustment',
      reason: '期初入库',
    });
    expect(movement.id).toBeTruthy();
    expect(movement.sourceId).toBeTruthy();
    expect(movement.occurredAt).toBeTruthy();
    expect(movement.createdAt).toBeTruthy();
  });

  it('人工调整可以扣减任一状态但超过当前存量会被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-guard-'));
    const { application } = await openSeededApplication(root, [], [BOX_PRODUCT]);
    adjust(application, BOX_PRODUCT, {
      quantity: 2,
      direction: 'in',
      state: 'sellable',
      reason: '期初入库',
    });
    adjust(application, BOX_PRODUCT, {
      quantity: 1,
      direction: 'out',
      state: 'sellable',
      reason: '样品寄出',
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity).toBe(1);
    expect(() => adjust(application, BOX_PRODUCT, {
      quantity: 5,
      direction: 'out',
      state: 'sellable',
      reason: '超量扣减',
    })).toThrow('玻璃保鲜盒（1000ml）可销售 1 件，不够扣减 5 件');
    expect(() => adjust(application, BOX_PRODUCT, {
      quantity: 1,
      direction: 'out',
      state: 'awaiting_inspection',
      reason: '无存量扣减',
    })).toThrow('玻璃保鲜盒（1000ml）待检查 0 件，不够扣减 1 件');
    expect(() => adjust(application, BOX_PRODUCT, {
      quantity: 1,
      direction: 'out',
      state: 'defective',
      reason: '无存量瑕疵扣减',
    })).toThrow('玻璃保鲜盒（1000ml）瑕疵品 0 件，不够扣减 1 件');
    expect(() => adjust(application, BOX_PRODUCT, {
      quantity: 1,
      direction: 'out',
      state: 'scrapped',
      reason: '无存量报废扣减',
    })).toThrow('玻璃保鲜盒（1000ml）报废 0 件，不够扣减 1 件');
    expect(() => adjust(application, BOX_PRODUCT, {
      quantity: 0,
      direction: 'in',
      state: 'sellable',
      reason: '数量无效',
    })).toThrow();
    expect(() => adjust(application, BOX_PRODUCT, {
      quantity: 1,
      direction: 'out',
      state: 'sellable',
      reason: '   ',
    })).toThrow('请填写非空原因');
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity).toBe(1);
  });

  it('检查结果把待检查三路分流且流水共享同一来源编号', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-inspect-'));
    const { application } = await openSeededApplication(root, [], [BOX_PRODUCT]);
    adjust(application, BOX_PRODUCT, {
      quantity: 5,
      direction: 'in',
      state: 'awaiting_inspection',
      reason: '退货集中待检查入库',
    });
    const productId = productOf(application.queryInventory(), BOX_PRODUCT.sku).standardProductId;
    const view = application.recordInventoryInspection({
      standardProductId: productId,
      sellableQuantity: 3,
      defectiveQuantity: 1,
      scrappedQuantity: 1,
      reason: '逐件检查',
    });
    const product = productOf(view, BOX_PRODUCT.sku);
    expect(product.sellableQuantity).toBe(3);
    expect(product.awaitingInspectionQuantity).toBe(0);
    expect(product.defectiveQuantity).toBe(1);
    expect(product.scrappedQuantity).toBe(1);
    expect(view.movements).toHaveLength(5);
    const inspectionMovements = view.movements.filter(
      ({ sourceType }) => sourceType === 'inspection_result',
    );
    expect(inspectionMovements).toHaveLength(4);
    const sourceIds = new Set(inspectionMovements.map(({ sourceId }) => sourceId));
    expect(sourceIds.size).toBe(1);
    const outMovement = inspectionMovements.find(
      ({ direction, state }) => direction === 'out' && state === 'awaiting_inspection',
    );
    expect(outMovement).toMatchObject({ quantity: 5, reason: '逐件检查' });
    const inByState = new Map(
      inspectionMovements
        .filter(({ direction }) => direction === 'in')
        .map((movement) => [movement.state, movement.quantity]),
    );
    expect(inByState).toEqual(new Map([
      ['sellable', 3],
      ['defective', 1],
      ['scrapped', 1],
    ]));
  });

  it('检查结果超过待检查存量或全部为零时报错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-inspect-guard-'));
    const { application } = await openSeededApplication(root, [], [BOX_PRODUCT]);
    adjust(application, BOX_PRODUCT, {
      quantity: 3,
      direction: 'in',
      state: 'awaiting_inspection',
      reason: '待检查入库',
    });
    const productId = productOf(application.queryInventory(), BOX_PRODUCT.sku).standardProductId;
    expect(() => application.recordInventoryInspection({
      standardProductId: productId,
      sellableQuantity: 4,
      defectiveQuantity: 0,
      scrappedQuantity: 0,
      reason: '超量检查',
    })).toThrow('玻璃保鲜盒（1000ml）待检查 3 件，不够检查 4 件');
    expect(() => application.recordInventoryInspection({
      standardProductId: productId,
      sellableQuantity: 0,
      defectiveQuantity: 0,
      scrappedQuantity: 0,
      reason: '全零检查',
    })).toThrow('请至少填写一个大于零的检查结果数量');
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku))
      .toMatchObject({ awaitingInspectionQuantity: 3, sellableQuantity: 0 });
  });

  it('同一来源事实重复写入被唯一约束拒绝，不产生重复库存变化', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-idempotent-'));
    const { application } = await openSeededApplication(root, [], [BOX_PRODUCT]);
    const productId = application.queryInventory().products[0].standardProductId;
    // 直连数据库写入一条带确定来源的事实流水，模拟 #69 将来的发货事实钩子。
    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'), {
      enableForeignKeyConstraints: true,
    });
    const insert = database.prepare(`
      INSERT INTO inventory_movements (
        id, standard_product_id, quantity, direction, state,
        source_type, source_id, reason, occurred_at, created_at
      ) VALUES (?, ?, ?, 'out', 'sellable', 'shipment_dispatch', ?, ?, ?, ?)
    `);
    insert.run(
      'movement-fact-1',
      productId,
      2,
      'fact-shipment-1',
      '发货事实第一遍',
      '2026-08-18T10:00:00.000Z',
      '2026-08-18T10:00:00.000Z',
    );
    expect(() => insert.run(
      'movement-fact-2',
      productId,
      2,
      'fact-shipment-1',
      '同一发货事实重放',
      '2026-08-18T10:00:01.000Z',
      '2026-08-18T10:00:01.000Z',
    )).toThrow();
    database.close();
    const view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku).sellableQuantity).toBe(-2);
    expect(view.movements).toHaveLength(1);
    expect(view.movements[0]).toMatchObject({
      sourceType: 'shipment_dispatch',
      sourceId: 'fact-shipment-1',
    });
  });

  it('状态中文名标签覆盖四态与方向', () => {
    expect(inventoryStateLabel('sellable')).toBe('可销售');
    expect(inventoryStateLabel('awaiting_inspection')).toBe('待检查');
    expect(inventoryStateLabel('defective')).toBe('瑕疵品');
    expect(inventoryStateLabel('scrapped')).toBe('报废');
  });
});

describe('已预留与采购在途派生', () => {
  it('已预留等于待发货订单的未发出数量，部分发货后只统计剩余', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-reserved-'));
    const { application, sources } = await openSeededApplication(root, [
      ledgerRecognition('XY-INV-0001', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 3 },
      ]),
    ], [BOX_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).reservedQuantity).toBe(3);

    const groups = application.queryShipmentGroups();
    const group = groups.groups.find(({ orders }) => (
      orders.some(({ id }) => id === order.id)
    ));
    if (!group) throw new Error('未找到待发货订单的发货组');
    const orderInGroup = group.orders.find(({ id }) => id === order.id)!;
    const item = orderInGroup.items[0];
    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: [{ orderId: order.id, orderItemId: item.id, quantity: 3 }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-INV-RESERVED-0001',
        items: [{ orderId: order.id, orderItemId: item.id, quantity: 2 }],
      }],
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).reservedQuantity).toBe(1);
  });

  it('未释放计划成员不计入已预留，释放后计入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-gate-'));
    const { application, sources } = await openSeededApplication(root, [
      ledgerRecognition('XY-INV-0002', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 2 },
      ]),
    ], [BOX_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);
    const plan: FulfillmentPlanView = application.createFulfillmentPlan({
      type: 'presale',
      name: '处暑预售',
      expectedShipAt: '2026-09-30T00:00:00.000Z',
      reason: '预售开始备货',
    });
    const withMember = application.addFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: plan.revision,
      orderIds: [order.id],
      reason: '加入预售',
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).reservedQuantity).toBe(0);
    application.releaseFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: withMember.revision,
      orderIds: [order.id],
      reason: '备货完成释放',
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).reservedQuantity).toBe(2);
  });

  it('发货前退款的数量不再预留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-refund-'));
    const { application, sources } = await openSeededApplication(root, [
      ledgerRecognition('XY-INV-0003', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 4 },
      ]),
    ], [BOX_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order: OriginalOrder = application.confirmDraft(draft);
    const plan = application.createFulfillmentPlan({
      type: 'presale',
      name: '退款预售',
      expectedShipAt: '2026-09-30T00:00:00.000Z',
      reason: '预售开始备货',
    });
    const withMember = application.addFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: plan.revision,
      orderIds: [order.id],
      reason: '加入预售',
    });
    application.registerFulfillmentRefund({
      planId: plan.id,
      orderId: order.id,
      orderItemId: order.items[0].id,
      quantity: 1,
      reason: '买家退定 1 件',
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).reservedQuantity).toBe(0);
    application.releaseFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: withMember.revision,
      orderIds: [order.id],
      reason: '备货完成释放',
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).reservedQuantity).toBe(3);
  });

  it('已取消或整单退款的订单不计入已预留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-cancelled-'));
    const { application, sources } = await openSeededApplication(root, [
      ledgerRecognition('XY-INV-0004', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 2 },
      ]),
      ledgerRecognition('XY-INV-0005', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 3 },
      ]),
    ], [BOX_PRODUCT]);
    const drafts = (await application.submitRecognitionBatch(sources)).drafts;
    const [orderA, orderB] = drafts.map((draft) => application.confirmDraft(draft));
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).reservedQuantity).toBe(5);
    application.updateOrderPlatformTransactionStatus({
      targets: [
        { orderId: orderA.id, expectedRevision: orderA.revision },
      ],
      patch: { platformTransactionStatus: 'refunded' },
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).reservedQuantity).toBe(3);
    application.updateOrderPlatformTransactionStatus({
      targets: [
        { orderId: orderB.id, expectedRevision: orderB.revision },
      ],
      patch: { platformTransactionStatus: 'cancelled' },
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).reservedQuantity).toBe(0);
  });

  it('已确认采购建议形成采购在途，草稿与取消不算', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-transit-'));
    const { application, sources } = await openSeededApplication(root, [
      ledgerRecognition('XY-INV-0006', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 10 },
        { sourceTitle: CLIP_PRODUCT.name, sourceSpec: CLIP_PRODUCT.specification, quantity: 4 },
      ]),
    ], [BOX_PRODUCT, CLIP_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);
    const plan = application.createFulfillmentPlan({
      type: 'presale',
      name: '在途预售',
      expectedShipAt: '2026-09-30T00:00:00.000Z',
      reason: '预售开始备货',
    });
    application.addFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: plan.revision,
      orderIds: [order.id],
      reason: '加入预售',
    });
    const boxId = productOf(application.queryInventory(), BOX_PRODUCT.sku).standardProductId;
    const clipId = productOf(application.queryInventory(), CLIP_PRODUCT.sku).standardProductId;
    const withBoxDraft = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: boxId,
      quantity: 6,
      reason: '覆盖缺口',
      acknowledgeUnformedRisk: false,
    });
    const withClipDraft = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: clipId,
      quantity: 2,
      reason: '夹子草稿建议',
      acknowledgeUnformedRisk: false,
    });
    const boxSuggestion = withBoxDraft.suggestions.find(
      ({ standardProductId }) => standardProductId === boxId,
    )!;
    const clipSuggestion = withClipDraft.suggestions.find(
      ({ standardProductId }) => standardProductId === clipId,
    )!;
    expect(clipSuggestion.status).toBe('draft');
    application.confirmPurchaseSuggestion({
      planId: plan.id,
      suggestionId: boxSuggestion.id,
      reason: '已向供应方下单',
    });
    application.cancelPurchaseSuggestion({
      planId: plan.id,
      suggestionId: clipSuggestion.id,
      reason: '改用现货',
    });
    const view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku).purchaseInTransitQuantity).toBe(6);
    expect(productOf(view, CLIP_PRODUCT.sku).purchaseInTransitQuantity).toBe(0);
  });

  it('未映射待发货明细进入提醒清单，已发完该商品的订单不计入涉及订单数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-unmapped-'));
    const { application, sources } = await openSeededApplication(root, [
      ledgerRecognition('XY-INV-0007', [
        { sourceTitle: '手作发夹', sourceSpec: '蓝色', quantity: 2 },
        { sourceTitle: '保温杯', sourceSpec: '500ml', quantity: 1 },
      ]),
      ledgerRecognition('XY-INV-0008', [
        { sourceTitle: '手作发夹', sourceSpec: '蓝色', quantity: 1 },
      ]),
    ], [BOX_PRODUCT]);
    const drafts = (await application.submitRecognitionBatch(sources)).drafts;
    const [orderA, orderB] = drafts.map((draft) => application.confirmDraft(draft));
    const unmappedOf = (view: InventoryView, title: string) => (
      view.unmappedPendingShipment.find((item) => item.sourceTitle === title)
    );
    let view = application.queryInventory();
    expect(unmappedOf(view, '手作发夹')).toEqual({
      sourceTitle: '手作发夹',
      sourceSpec: '蓝色',
      quantity: 3,
      orderCount: 2,
    });
    expect(unmappedOf(view, '保温杯')).toEqual({
      sourceTitle: '保温杯',
      sourceSpec: '500ml',
      quantity: 1,
      orderCount: 1,
    });

    // 订单 A 只发出手作发夹、保温杯仍未发：A 对发夹的净数量为零，不再计入涉及订单。
    const groups = application.queryShipmentGroups();
    const group = groups.groups.find(({ orders }) => (
      orders.some(({ id }) => id === orderA.id)
    ));
    if (!group) throw new Error('未找到未映射订单的发货组');
    const remainingItems = group.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));
    const hairpinA = remainingItems.find(({ orderId, orderItemId }) => (
      orderId === orderA.id && orderItemId === orderA.items[0].id
    ))!;
    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-INV-UNMAPPED-0001',
        items: [hairpinA],
      }],
    });
    view = application.queryInventory();
    expect(unmappedOf(view, '手作发夹')).toEqual({
      sourceTitle: '手作发夹',
      sourceSpec: '蓝色',
      quantity: 1,
      orderCount: 1,
    });
    expect(unmappedOf(view, '保温杯')).toEqual({
      sourceTitle: '保温杯',
      sourceSpec: '500ml',
      quantity: 1,
      orderCount: 1,
    });

    // 映射已全部发出的明细不回补历史：既不形成预留，也不产生库存流水。
    const products = application.listStandardProducts();
    application.updateOrderItemStandardization(orderA.id, orderA.items[0].id, {
      standardProductId: products[0].id,
      expectedRevision: refreshRevision(application, orderA.id),
    });
    view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku).reservedQuantity).toBe(0);
    expect(view.movements).toEqual([]);

    // 订单 B 的发夹发出并补映射后，提醒清单只剩保温杯，历史仍不回补。
    const archive = application.queryShipmentGroupArchives()[0];
    const remainingGroup = archive.remainingGroup;
    if (!remainingGroup) throw new Error('发货组档案缺少剩余待发商品');
    const refreshedRemaining = remainingGroup.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));
    const hairpinB = refreshedRemaining.find(({ orderId }) => orderId === orderB.id)!;
    application.confirmShipment({
      groupId: remainingGroup.id,
      archiveId: archive.id,
      expectedRemainingItems: refreshedRemaining,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-INV-UNMAPPED-0002',
        items: [hairpinB],
      }],
    });
    view = application.queryInventory();
    expect(unmappedOf(view, '手作发夹')).toBeUndefined();
    expect(unmappedOf(view, '保温杯')).toEqual({
      sourceTitle: '保温杯',
      sourceSpec: '500ml',
      quantity: 1,
      orderCount: 1,
    });
    application.updateOrderItemStandardization(orderB.id, orderB.items[0].id, {
      standardProductId: products[0].id,
      expectedRevision: refreshRevision(application, orderB.id),
    });
    expect(application.queryInventory().movements).toEqual([]);
  });
});

describe('履约需求视图接入库存真值', () => {
  it('需求汇总的现货可覆盖与待检查来自库存流水而非占位零', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-demand-'));
    const { application, sources } = await openSeededApplication(root, [
      ledgerRecognition('XY-INV-0009', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 4 },
      ]),
    ], [BOX_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);
    const plan = application.createFulfillmentPlan({
      type: 'presale',
      name: '现货覆盖预售',
      expectedShipAt: '2026-09-30T00:00:00.000Z',
      reason: '预售开始备货',
    });
    application.addFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: plan.revision,
      orderIds: [order.id],
      reason: '加入预售',
    });
    expect(application.queryFulfillmentDemand(plan.id).totals).toMatchObject({
      sellableCoveredQuantity: 0,
      pendingInspectionQuantity: 0,
    });
    adjust(application, BOX_PRODUCT, {
      quantity: 3,
      direction: 'in',
      state: 'sellable',
      reason: '现货入库',
    });
    adjust(application, BOX_PRODUCT, {
      quantity: 5,
      direction: 'in',
      state: 'awaiting_inspection',
      reason: '退货运回待检查',
    });
    expect(application.queryFulfillmentDemand(plan.id).totals).toMatchObject({
      sellableCoveredQuantity: 3,
      pendingInspectionQuantity: 5,
    });
  });
});

describe('库存持久化', () => {
  it('关闭重开后库存视图与流水保持一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-restart-'));
    const recognitions = [
      ledgerRecognition('XY-INV-0010', [
        { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 2 },
      ]),
    ];
    const dataDirectory = join(root, '数据');
    const first = new LocalApplication(new SequenceRecognizer(recognitions));
    applications.push(first);
    first.openDataDirectory(dataDirectory);
    first.createStandardProduct({
      ...BOX_PRODUCT,
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
    const [draft] = (await first.submitRecognitionBatch(
      await Promise.all(recognitions.map(async (_value, index) => {
        const sourcePath = join(root, `重启订单-${index}.png`);
        await writeFile(sourcePath, Buffer.from(`restart-source-${index}`));
        return sourcePath;
      })),
    )).drafts;
    first.confirmDraft(draft);
    adjust(first, BOX_PRODUCT, {
      quantity: 8,
      direction: 'in',
      state: 'sellable',
      reason: '期初入库',
    });
    const before = first.queryInventory();

    first.close();
    const second = new LocalApplication(new SequenceRecognizer([]));
    applications.push(second);
    second.openDataDirectory(dataDirectory);
    expect(second.queryInventory()).toEqual(before);
  });
});
