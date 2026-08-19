import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import type {
  InventoryProductView,
  InventoryView,
} from '../src/core/inventory-ledger';
import type { PurchaseOrderView, PurchaseView } from '../src/core/purchase-orders';
import type { OriginalOrder } from '../src/core/contracts';
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

const BOX_PRODUCT = { name: '玻璃保鲜盒', specification: '1000ml', sku: 'SKU-PO-A' };
const CLIP_PRODUCT = { name: '硅胶封口夹', specification: '大号', sku: 'SKU-PO-B' };

async function openApplication(
  root: string,
  recognitions: RecognitionResult[] = [],
  products: Array<{ sku: string; name: string; specification: string }> = [
    BOX_PRODUCT,
    CLIP_PRODUCT,
  ],
): Promise<LocalApplication> {
  const application = new LocalApplication(new SequenceRecognizer([...recognitions]));
  applications.push(application);
  application.openDataDirectory(join(root, '数据'));
  for (const product of products) {
    application.createStandardProduct({
      ...product,
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
  }
  return application;
}

async function writeSources(
  root: string,
  recognitions: RecognitionResult[],
): Promise<string[]> {
  const sources: string[] = [];
  for (let index = 0; index < recognitions.length; index += 1) {
    const sourcePath = join(root, `采购订单源-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`purchase-source-${index}`));
    sources.push(sourcePath);
  }
  return sources;
}

function purchaseRecognition(orderNumber: string, items: Array<{
  sourceTitle: string;
  sourceSpec?: string;
  quantity: number;
}>): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient: '采购测试收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-19 08:00:00',
    orderedAtNormalized: '2026-08-19T08:00:00+08:00',
    paidAtOriginal: '2026-08-19 08:00:08',
    paidAtNormalized: '2026-08-19T08:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: items.map((item) => ({
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec ?? '标准款',
      unitPriceCents: 800,
      quantity: item.quantity,
      quantityInferred: false,
    })),
  };
}

function createSupplier(application: LocalApplication, name: string): string {
  const view = application.createSupplier({
    name,
    contact: '13800000001',
    note: '长期合作',
  });
  const supplier = view.suppliers.find((candidate) => candidate.name === name);
  if (!supplier) throw new Error('测试前置：供应方创建失败');
  return supplier.supplierId;
}

function productOf(view: InventoryView, sku: string): InventoryProductView {
  const target = view.products.find((candidate) => candidate.sku === sku);
  if (!target) throw new Error(`测试未找到商品 ${sku}`);
  return target;
}

function orderOf(view: PurchaseView, sequence: number): PurchaseOrderView {
  const target = view.orders.find((candidate) => candidate.sequence === sequence);
  if (!target) throw new Error(`测试未找到第 ${sequence} 号采购订单`);
  return target;
}

function createOrder(
  application: LocalApplication,
  supplierId: string,
  items: Array<{ product: { sku: string }; quantity: number; unitPriceCents: number }>,
  expectedAt = '2026-09-01T00:00:00+08:00',
): PurchaseView {
  const inventory = application.queryInventory();
  return application.createPurchaseOrder({
    supplierId,
    expectedAt,
    reason: '按缺口下单',
    items: items.map((item) => ({
      standardProductId: productOf(inventory, item.product.sku).standardProductId,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    })),
  });
}

function confirmOrder(application: LocalApplication, orderId: string): PurchaseView {
  return application.confirmPurchaseOrder({
    orderId,
    reason: '供应方已接单',
  });
}

describe('采购订单、分次到货与供应方退货', () => {
  it('采购订单独立保存供应方、商品、数量、价格、交期与确认历史', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-order-'));
    const application = await openApplication(root);
    const supplierId = createSupplier(application, '深圳塑料制品厂');

    const created = createOrder(application, supplierId, [
      { product: BOX_PRODUCT, quantity: 10, unitPriceCents: 500 },
      { product: CLIP_PRODUCT, quantity: 5, unitPriceCents: 200 },
    ]);
    const order = orderOf(created, 1);
    expect(order).toMatchObject({
      supplierName: '深圳塑料制品厂',
      status: 'draft',
      expectedAt: '2026-09-01T00:00:00+08:00',
      payable: null,
    });
    expect(order.items).toEqual([
      expect.objectContaining({
        sku: BOX_PRODUCT.sku,
        quantity: 10,
        unitPriceCents: 500,
        receivedQuantity: 0,
        supplierReturnedQuantity: 0,
      }),
      expect.objectContaining({
        sku: CLIP_PRODUCT.sku,
        quantity: 5,
        unitPriceCents: 200,
      }),
    ]);
    expect(order.events.map((event) => event.eventType)).toEqual(['created']);

    const confirmed = confirmOrder(application, order.id);
    expect(orderOf(confirmed, 1)).toMatchObject({ status: 'confirmed' });
    expect(orderOf(confirmed, 1).events.map((event) => event.eventType))
      .toEqual(['created', 'confirmed']);
  });

  it('确认数量形成采购在途且不写库存，已确认建议不再计入在途', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-transit-'));
    const application = await openApplication(root);
    const supplierId = createSupplier(application, '宁波仓储供货商');
    const created = createOrder(application, supplierId, [
      { product: BOX_PRODUCT, quantity: 8, unitPriceCents: 500 },
    ]);
    const order = orderOf(created, 1);

    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku))
      .toMatchObject({ purchaseInTransitQuantity: 0, sellableQuantity: 0 });
    confirmOrder(application, order.id);
    const afterConfirm = application.queryInventory();
    expect(productOf(afterConfirm, BOX_PRODUCT.sku))
      .toMatchObject({ purchaseInTransitQuantity: 8, sellableQuantity: 0 });
    expect(afterConfirm.movements).toHaveLength(0);
  });

  it('同一订单可分多次到货，超量到货与草稿到货被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-arrivals-'));
    const application = await openApplication(root);
    const supplierId = createSupplier(application, '分批发货供应商');
    const created = createOrder(application, supplierId, [
      { product: BOX_PRODUCT, quantity: 10, unitPriceCents: 500 },
    ]);
    const order = orderOf(created, 1);

    expect(() => application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-20T10:00:00+08:00',
      reason: '草稿期到货应被拒绝',
      items: [{ orderItemId: order.items[0].id, receivedQuantity: 3 }],
    })).toThrow('只有已确认采购订单可以登记到货');

    confirmOrder(application, order.id);
    application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-20T10:00:00+08:00',
      reason: '第一批到货',
      items: [{
        orderItemId: order.items[0].id,
        receivedQuantity: 4,
        resellableQuantity: 3,
        defectiveQuantity: 1,
      }],
    });
    expect(() => application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-21T10:00:00+08:00',
      reason: '超出订单数量',
      items: [{ orderItemId: order.items[0].id, receivedQuantity: 7 }],
    })).toThrow('请先显式变更采购数量');

    application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-22T10:00:00+08:00',
      reason: '第二批到货',
      items: [{ orderItemId: order.items[0].id, receivedQuantity: 6 }],
    });
    const finalView = application.queryPurchases();
    const finalOrder = orderOf(finalView, 1);
    expect(finalOrder.items[0].receivedQuantity).toBe(10);
    expect(finalOrder.arrivals).toHaveLength(2);
    expect(finalOrder.arrivals[0].items[0]).toMatchObject({
      receivedQuantity: 4,
      resellableQuantity: 3,
      defectiveQuantity: 1,
      scrappedQuantity: 0,
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku))
      .toMatchObject({ purchaseInTransitQuantity: 0 });
  });

  it('到货检查按库存规则分流，未分类余量进待检查可后续处理', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-states-'));
    const application = await openApplication(root);
    const supplierId = createSupplier(application, '质检分流供应商');
    const created = createOrder(application, supplierId, [
      { product: BOX_PRODUCT, quantity: 6, unitPriceCents: 500 },
    ]);
    const order = orderOf(created, 1);
    confirmOrder(application, order.id);
    application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-20T10:00:00+08:00',
      reason: '到货即检查',
      items: [{
        orderItemId: order.items[0].id,
        receivedQuantity: 6,
        resellableQuantity: 3,
        defectiveQuantity: 1,
        scrappedQuantity: 1,
      }],
    });

    const view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 3,
      defectiveQuantity: 1,
      scrappedQuantity: 1,
      awaitingInspectionQuantity: 1,
    });
    const arrivalMovements = view.movements.filter(
      ({ sourceType }) => sourceType === 'purchase_arrival',
    );
    expect(arrivalMovements.map((movement) => `${movement.direction}|${movement.state}|${movement.quantity}`).sort())
      .toEqual([
        'in|awaiting_inspection|1',
        'in|defective|1',
        'in|scrapped|1',
        'in|sellable|3',
      ].sort());
    expect(arrivalMovements.every((movement) => movement.reason === '到货即检查')).toBe(true);

    application.recordInventoryInspection({
      standardProductId: productOf(view, BOX_PRODUCT.sku).standardProductId,
      sellableQuantity: 1,
      defectiveQuantity: 0,
      scrappedQuantity: 0,
      reason: '待检查余量复检合格',
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku))
      .toMatchObject({ sellableQuantity: 4, awaitingInspectionQuantity: 0 });
  });

  it('供应方退货保留独立记录并从对应库存状态出库，余量不足被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-supplier-return-'));
    const application = await openApplication(root);
    const supplierId = createSupplier(application, '可退货供应商');
    const created = createOrder(application, supplierId, [
      { product: BOX_PRODUCT, quantity: 5, unitPriceCents: 500 },
    ]);
    const order = orderOf(created, 1);
    confirmOrder(application, order.id);
    application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-20T10:00:00+08:00',
      reason: '到货',
      items: [{
        orderItemId: order.items[0].id,
        receivedQuantity: 5,
        resellableQuantity: 3,
        defectiveQuantity: 2,
      }],
    });

    expect(() => application.recordSupplierReturn({
      supplierId,
      purchaseOrderId: order.id,
      reason: '瑕疵超过库存',
      occurredAt: '2026-08-21T10:00:00+08:00',
      items: [{
        standardProductId: productOf(application.queryInventory(), BOX_PRODUCT.sku)
          .standardProductId,
        quantity: 3,
        state: 'defective',
      }],
    })).toThrow('不够退给供应方');

    application.recordSupplierReturn({
      supplierId,
      purchaseOrderId: order.id,
      reason: '瑕疵品退回供应方',
      occurredAt: '2026-08-21T10:00:00+08:00',
      items: [{
        standardProductId: productOf(application.queryInventory(), BOX_PRODUCT.sku)
          .standardProductId,
        quantity: 2,
        state: 'defective',
      }],
    });
    const view = application.queryInventory();
    expect(productOf(view, BOX_PRODUCT.sku)).toMatchObject({ defectiveQuantity: 0 });
    expect(view.movements.filter(({ sourceType }) => sourceType === 'supplier_return'))
      .toEqual([
        expect.objectContaining({
          direction: 'out',
          state: 'defective',
          quantity: 2,
          reason: '瑕疵品退回供应方',
        }),
      ]);
    const purchases = application.queryPurchases();
    expect(purchases.supplierReturns).toEqual([
      expect.objectContaining({
        supplierName: '可退货供应商',
        reason: '瑕疵品退回供应方',
        items: [expect.objectContaining({ quantity: 2, state: 'defective' })],
      }),
    ]);
    expect(orderOf(purchases, 1).items[0].supplierReturnedQuantity).toBe(2);
  });

  it('数量与交期变更显式留痕，需求重算不影响采购订单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-changes-'));
    const recognition = purchaseRecognition('XY-PO-0001', [
      { sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity: 4 },
    ]);
    const application = await openApplication(root, [recognition]);
    const supplierId = createSupplier(application, '变更测试供应商');
    const sources = await writeSources(root, [recognition]);
    const batch = await application.submitRecognitionBatch(sources);
    const confirmedOrder = application.confirmDraft(batch.drafts[0]) as OriginalOrder;

    const plan = application.createFulfillmentPlan({
      type: 'presale',
      name: '九月预售',
      expectedShipAt: '2026-09-30T00:00:00.000Z',
      reason: '预售开始备货',
    });
    application.addFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: plan.revision,
      orderIds: [confirmedOrder.id],
      reason: '加入预售',
    });
    const demand = application.queryFulfillmentDemand(plan.id);
    application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: demand.products.find(
        ({ sku }) => sku === BOX_PRODUCT.sku,
      )!.standardProductId,
      quantity: 2,
      reason: '先补一半',
    });

    const created = createOrder(application, supplierId, [
      { product: BOX_PRODUCT, quantity: 4, unitPriceCents: 500 },
    ]);
    const order = orderOf(created, 1);
    confirmOrder(application, order.id);

    application.registerFulfillmentRefund({
      planId: plan.id,
      orderId: confirmedOrder.id,
      orderItemId: confirmedOrder.items[0].id,
      quantity: 4,
      reason: '整单退款，重算建议',
    });
    const afterRefund = application.queryPurchases();
    expect(orderOf(afterRefund, 1).items[0].quantity).toBe(4);
    expect(orderOf(afterRefund, 1).status).toBe('confirmed');

    application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-20T10:00:00+08:00',
      reason: '首批到货',
      items: [{ orderItemId: order.items[0].id, receivedQuantity: 3 }],
    });
    expect(() => application.changePurchaseOrderItemQuantity({
      orderId: order.id,
      itemId: order.items[0].id,
      quantity: 2,
      reason: '低于已到货应被拒绝',
    })).toThrow('不能低于已到货数量');

    application.changePurchaseOrderItemQuantity({
      orderId: order.id,
      itemId: order.items[0].id,
      quantity: 6,
      reason: '供应方追加两件',
    });
    application.changePurchaseOrderExpectedDate({
      orderId: order.id,
      expectedAt: '2026-09-10T00:00:00+08:00',
      reason: '供应方产能延后',
    });
    const finalOrder = orderOf(application.queryPurchases(), 1);
    expect(finalOrder.items[0].quantity).toBe(6);
    expect(finalOrder.expectedAt).toBe('2026-09-10T00:00:00+08:00');
    expect(finalOrder.events.map((event) => event.eventType)).toEqual([
      'created', 'confirmed', 'quantity_changed', 'expected_date_changed',
    ]);
    const quantityEvent = finalOrder.events.find(
      (event) => event.eventType === 'quantity_changed',
    )!;
    expect(quantityEvent).toMatchObject({ itemId: order.items[0].id, quantity: 6 });
  });

  it('确认订单产生待确认应付，随数量变更重算、取消按已到货清算', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-payable-'));
    const application = await openApplication(root);
    const supplierId = createSupplier(application, '应付测试供应商');
    const created = createOrder(application, supplierId, [
      { product: BOX_PRODUCT, quantity: 10, unitPriceCents: 500 },
      { product: CLIP_PRODUCT, quantity: 5, unitPriceCents: 200 },
    ]);
    const order = orderOf(created, 1);
    expect(order.payable).toBeNull();

    confirmOrder(application, order.id);
    expect(orderOf(application.queryPurchases(), 1).payable)
      .toMatchObject({ amountCents: 6000 });

    application.changePurchaseOrderItemQuantity({
      orderId: order.id,
      itemId: order.items[0].id,
      quantity: 12,
      reason: '追加采购',
    });
    expect(orderOf(application.queryPurchases(), 1).payable)
      .toMatchObject({ amountCents: 7000 });

    application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-20T10:00:00+08:00',
      reason: '部分到货',
      items: [
        { orderItemId: order.items[0].id, receivedQuantity: 4 },
        { orderItemId: order.items[1].id, receivedQuantity: 5 },
      ],
    });
    expect(orderOf(application.queryPurchases(), 1).payable)
      .toMatchObject({ amountCents: 7000 });

    application.cancelPurchaseOrder({
      orderId: order.id,
      reason: '剩余部分不再要货',
    });
    const cancelled = orderOf(application.queryPurchases(), 1);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('剩余部分不再要货');
    expect(cancelled.payable).toMatchObject({ amountCents: 4 * 500 + 5 * 200 });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku))
      .toMatchObject({ purchaseInTransitQuantity: 0 });
  });

  it('无到货取消删除待确认应付，草稿取消不产生应付', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-cancel-'));
    const application = await openApplication(root);
    const supplierId = createSupplier(application, '取消测试供应商');
    const draft = createOrder(application, supplierId, [
      { product: CLIP_PRODUCT, quantity: 3, unitPriceCents: 200 },
    ]);
    application.cancelPurchaseOrder({
      orderId: orderOf(draft, 1).id,
      reason: '草稿废弃',
    });
    expect(orderOf(application.queryPurchases(), 1).payable).toBeNull();

    const second = createOrder(application, supplierId, [
      { product: CLIP_PRODUCT, quantity: 3, unitPriceCents: 200 },
    ]);
    const secondOrder = orderOf(second, 2);
    confirmOrder(application, secondOrder.id);
    expect(orderOf(application.queryPurchases(), 2).payable)
      .toMatchObject({ amountCents: 600 });
    application.cancelPurchaseOrder({
      orderId: secondOrder.id,
      reason: '供应方缺货',
    });
    expect(orderOf(application.queryPurchases(), 2).payable).toBeNull();
    expect(() => application.confirmPurchaseOrder({
      orderId: secondOrder.id,
      reason: '重复确认',
    })).toThrow('只有草稿采购订单可以确认');
  });

  it('草稿订单变更数量不立应付，确认后按最新数量立账', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-draft-change-'));
    const application = await openApplication(root);
    const supplierId = createSupplier(application, '草稿变更供应商');
    const created = createOrder(application, supplierId, [
      { product: CLIP_PRODUCT, quantity: 5, unitPriceCents: 100 },
    ]);
    const order = orderOf(created, 1);
    application.changePurchaseOrderItemQuantity({
      orderId: order.id,
      itemId: order.items[0].id,
      quantity: 6,
      reason: '草稿期调量',
    });
    const afterChange = orderOf(application.queryPurchases(), 1);
    expect(afterChange.items[0].quantity).toBe(6);
    expect(afterChange.payable).toBeNull();

    confirmOrder(application, order.id);
    expect(orderOf(application.queryPurchases(), 1).payable)
      .toMatchObject({ amountCents: 600 });
  });

  it('同名供应方被拒绝，退货可无关联订单且归属校验拦截跨供应方关联', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-supplier-rules-'));
    const application = await openApplication(root);
    const supplierA = createSupplier(application, '供应方甲');
    const supplierB = createSupplier(application, '供应方乙');
    expect(() => application.createSupplier({
      name: '供应方甲',
      contact: null,
      note: null,
    })).toThrow('同名供应方已存在');

    const created = createOrder(application, supplierA, [
      { product: BOX_PRODUCT, quantity: 4, unitPriceCents: 500 },
    ]);
    const order = orderOf(created, 1);
    confirmOrder(application, order.id);
    application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-20T10:00:00+08:00',
      reason: '到货',
      items: [{
        orderItemId: order.items[0].id,
        receivedQuantity: 4,
        resellableQuantity: 4,
      }],
    });
    const productId = productOf(application.queryInventory(), BOX_PRODUCT.sku)
      .standardProductId;

    expect(() => application.recordSupplierReturn({
      supplierId: supplierB,
      purchaseOrderId: order.id,
      reason: '跨供应方关联应被拒绝',
      occurredAt: '2026-08-21T10:00:00+08:00',
      items: [{ standardProductId: productId, quantity: 1, state: 'sellable' }],
    })).toThrow('退货关联的采购订单不属于该供应方');

    const view = application.recordSupplierReturn({
      supplierId: supplierB,
      purchaseOrderId: null,
      reason: '历史进货直接退回',
      occurredAt: '2026-08-21T10:00:00+08:00',
      items: [{ standardProductId: productId, quantity: 1, state: 'sellable' }],
    });
    expect(view.supplierReturns).toHaveLength(1);
    expect(view.supplierReturns[0]).toMatchObject({
      supplierName: '供应方乙',
      purchaseOrderId: null,
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity)
      .toBe(3);
  });

  it('到货检查分类超过实收数量在入参校验即被拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-purchase-normalizer-'));
    const application = await openApplication(root);
    const supplierId = createSupplier(application, '入参校验供应商');
    const created = createOrder(application, supplierId, [
      { product: CLIP_PRODUCT, quantity: 5, unitPriceCents: 100 },
    ]);
    const order = orderOf(created, 1);
    confirmOrder(application, order.id);
    expect(() => application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-20T10:00:00+08:00',
      reason: '分类超量',
      items: [{
        orderItemId: order.items[0].id,
        receivedQuantity: 2,
        resellableQuantity: 2,
        defectiveQuantity: 1,
      }],
    })).toThrow('检查分类数量不能超过到货数量');
    expect(() => application.recordPurchaseArrival({
      orderId: order.id,
      occurredAt: '2026-08-20T10:00:00+08:00',
      reason: '同行重复登记',
      items: [
        { orderItemId: order.items[0].id, receivedQuantity: 1 },
        { orderItemId: order.items[0].id, receivedQuantity: 1 },
      ],
    })).toThrow('同一采购订单商品行在一次到货中只能登记一次');
  });
});
