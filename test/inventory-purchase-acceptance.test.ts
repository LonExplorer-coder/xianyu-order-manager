import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  InventoryMovementView,
  InventoryProductView,
  InventoryView,
} from '../src/core/inventory-ledger';
import type { PurchaseOrderView, PurchaseView } from '../src/core/purchase-orders';
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

const BOX_PRODUCT = { name: '玻璃保鲜盒', specification: '1000ml', sku: 'SKU-LOOP-A' };
const CLIP_PRODUCT = { name: '硅胶封口夹', specification: '大号', sku: 'SKU-LOOP-B' };

type LoopItem = {
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
};

function loopRecognition(
  orderNumber: string,
  items: LoopItem[],
  recipient: string,
  phone: string,
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '库存采购验收账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient,
    phone,
    phoneNormalized: phone,
    addressOriginal: `广东省深圳市南山区${recipient}路1号`,
    addressNormalized: `广东省深圳市南山区${recipient}路1号`,
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-20 08:00:00',
    orderedAtNormalized: '2026-08-20T08:00:00+08:00',
    paidAtOriginal: '2026-08-20 08:00:08',
    paidAtNormalized: '2026-08-20T08:00:08+08:00',
    productTotalCents: items.reduce((total, item) => total + 800 * item.quantity, 0),
    shippingFeeCents: 0,
    amountCents: items.reduce((total, item) => total + 800 * item.quantity, 0),
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: items.map((item) => ({
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: 800,
      quantity: item.quantity,
      quantityInferred: false,
    })),
  };
}

function boxItems(quantity: number): LoopItem[] {
  return [{ sourceTitle: BOX_PRODUCT.name, sourceSpec: BOX_PRODUCT.specification, quantity }];
}

async function openLoopApplication(
  recognitions: RecognitionResult[],
): Promise<{
  application: LocalApplication;
  orders: Array<ReturnType<LocalApplication['getOrder']>['order']>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-inventory-loop-'));
  const application = new LocalApplication(new SequenceRecognizer([...recognitions]));
  applications.push(application);
  application.openDataDirectory(join(root, '数据'));
  for (const product of [BOX_PRODUCT, CLIP_PRODUCT]) {
    application.createStandardProduct({
      ...product,
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
  }
  application.createSupplier({ name: '闭环验收供应方', contact: null, note: null });
  const orders: Array<ReturnType<LocalApplication['getOrder']>['order']> = [];
  for (let index = 0; index < recognitions.length; index += 1) {
    const sourcePath = join(root, `闭环订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`inventory-loop-source-${index}`));
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

function stateSum(
  movements: readonly InventoryMovementView[],
  sku: string,
  state: InventoryMovementView['state'],
): number {
  return movements
    .filter((movement) => movement.sku === sku && movement.state === state)
    .reduce((total, movement) => total + (
      movement.direction === 'in' ? movement.quantity : -movement.quantity
    ), 0);
}

// 守恒：视图里的每个库存分类数量都等于库存流水按方向汇总的结果。
function assertConservation(application: LocalApplication): void {
  const view = application.queryInventory();
  for (const product of view.products) {
    expect(stateSum(view.movements, product.sku, 'sellable'), `${product.sku} 可销售`)
      .toBe(product.sellableQuantity);
    expect(
      stateSum(view.movements, product.sku, 'awaiting_inspection'),
      `${product.sku} 待检查`,
    ).toBe(product.awaitingInspectionQuantity);
    expect(stateSum(view.movements, product.sku, 'defective'), `${product.sku} 瑕疵品`)
      .toBe(product.defectiveQuantity);
    expect(stateSum(view.movements, product.sku, 'scrapped'), `${product.sku} 报废`)
      .toBe(product.scrappedQuantity);
  }
}

type ManualLeg = {
  sku: string;
  state: InventoryMovementView['state'];
  direction: InventoryMovementView['direction'];
  quantity: number;
  reason: string;
};

// 追溯：每条流水都能落到来源记录——采购到货、供应方退货、发货记录、售后事实
// 通过各域公开视图解析；人工调整自指；人工检查的流水本身就是记录，按预期清单对号。
function assertTraceability(
  application: LocalApplication,
  expectedManualLegs: readonly ManualLeg[],
): void {
  const view = application.queryInventory();
  const purchases = application.queryPurchases();
  const arrivalIds = new Set(purchases.orders.flatMap((order) => (
    order.arrivals.map((arrival) => arrival.id)
  )));
  const supplierReturnIds = new Set(purchases.supplierReturns.map(({ id }) => id));
  const archiveRecordIds = new Set(
    application.queryShipmentGroupArchives()
      .flatMap((archive) => archive.records.map((record) => record.id)),
  );
  const cases = application.queryAftersalesCases();
  const returnRecordIds = new Set(cases.flatMap((aftersalesCase) => (
    aftersalesCase.returns.map((returnRecord) => returnRecord.id)
  )));
  const impactIds = new Set(cases.flatMap((aftersalesCase) => (
    application.queryAftersalesInventoryImpact(aftersalesCase.id).map(({ id }) => id)
  )));
  // 原发货包裹的撤销没有售后单，追溯落到发货档案里被撤销包裹的撤销证据。
  const voidEvidence = application.queryShipmentGroupArchives()
    .flatMap((archive) => archive.records)
    .flatMap((record) => record.packages)
    .flatMap((shipmentPackage) => shipmentPackage.cancellation
      ? shipmentPackage.items.map((item) => ({
        titleKey: `${item.sourceTitle}（${item.sourceSpec}）`,
        quantity: item.quantity,
      }))
      : []);

  const tupleKeys = new Set<string>();
  const remainingManualLegs = new Set(expectedManualLegs.map((leg) => JSON.stringify(leg)));
  for (const movement of view.movements) {
    const tupleKey = [
      movement.sourceType,
      movement.sourceId,
      movement.sku,
      movement.state,
      movement.direction,
    ].join('|');
    if (tupleKeys.has(tupleKey)) {
      throw new Error(`库存流水重复记账：${tupleKey}`);
    }
    tupleKeys.add(tupleKey);
    if (!movement.reason) throw new Error(`库存流水缺少原因：${tupleKey}`);

    switch (movement.sourceType) {
      case 'manual_adjustment':
        if (movement.sourceId !== movement.id) {
          throw new Error(`人工调整流水不能追溯：${tupleKey}`);
        }
        break;
      case 'purchase_arrival':
        if (!arrivalIds.has(movement.sourceId)) {
          throw new Error(`到货流水不能追溯到采购到货记录：${tupleKey}`);
        }
        break;
      case 'supplier_return':
        if (!supplierReturnIds.has(movement.sourceId)) {
          throw new Error(`供应方退货流水不能追溯到退货记录：${tupleKey}`);
        }
        break;
      case 'shipment_dispatch':
      case 'replacement_dispatch':
        if (!archiveRecordIds.has(movement.sourceId)) {
          throw new Error(`发货流水不能追溯到发货记录：${tupleKey}`);
        }
        break;
      case 'shipment_void':
        // 冲正流水的说明是固定文案，证据按商品、数量与撤销包裹对号。
        if (!impactIds.has(movement.id) && !voidEvidence.some((evidence) => (
          evidence.titleKey === `${movement.name}（${movement.specification}）`
            && evidence.quantity === movement.quantity
        ))) {
          throw new Error(`撤销冲正流水不能追溯到撤销证据：${tupleKey}`);
        }
        break;
      case 'return_receipt':
        if (!returnRecordIds.has(movement.sourceId) && !impactIds.has(movement.id)) {
          throw new Error(`退货签收流水不能追溯到退货记录：${tupleKey}`);
        }
        break;
      case 'inspection_result': {
        if (impactIds.has(movement.id)) break;
        const manualKey = JSON.stringify({
          sku: movement.sku,
          state: movement.state,
          direction: movement.direction,
          quantity: movement.quantity,
          reason: movement.reason,
        });
        if (!remainingManualLegs.delete(manualKey)) {
          throw new Error(`检查流水不能追溯到退货检查或人工检查：${tupleKey}`);
        }
        break;
      }
      default:
        throw new Error(`未知库存流水来源：${movement.sourceType}`);
    }
  }
  if (remainingManualLegs.size > 0) {
    throw new Error(`人工检查流水对不上预期清单：${[...remainingManualLegs].join('；')}`);
  }
}

function orderById(view: PurchaseView, orderId: string): PurchaseOrderView {
  const order = view.orders.find((candidate) => candidate.id === orderId);
  if (!order) throw new Error(`测试未找到采购订单 ${orderId}`);
  return order;
}

function confirmShipmentForOrder(
  application: LocalApplication,
  orderId: string,
  trackingNumber: string,
): ReturnType<LocalApplication['confirmShipment']> {
  const group = application.queryShipmentGroups().groups
    .find(({ orders }) => orders.some(({ id }) => id === orderId));
  if (!group) throw new Error(`测试前置缺少订单 ${orderId} 的发货组`);
  const items = group.orders
    .filter(({ id }) => id === orderId)
    .flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
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

describe('库存与采购闭环验收', () => {
  it('例五扩展：预售三批采购、分次到货、发货前部分退款与多采购进入普通库存', async () => {
    const { application, orders } = await openLoopApplication([
      loopRecognition('XY-LOOP-PRESALE-A', boxItems(10), '预售买家甲', '13900000101'),
      loopRecognition('XY-LOOP-PRESALE-B', boxItems(5), '预售买家乙', '13900000102'),
      loopRecognition('XY-LOOP-SPOT', [
        { sourceTitle: CLIP_PRODUCT.name, sourceSpec: CLIP_PRODUCT.specification, quantity: 2 },
      ], '现货买家丙', '13900000103'),
    ]);
    const [presaleA, presaleB, spot] = orders;
    const supplierId = application.queryPurchases().suppliers[0]!.supplierId;

    // 验收条 1：预售有效需求进入计划，未释放成员不出现在发货组。
    const presale = application.createFulfillmentPlan({
      type: 'presale',
      name: '处暑三批采购预售',
      expectedShipAt: '2026-10-31T00:00:00.000Z',
      targetQuantity: null,
      deadlineAt: null,
      demandAlertThreshold: null,
      reason: '预售开始备货',
    });
    application.addFulfillmentPlanOrders({
      planId: presale.id,
      expectedRevision: presale.revision,
      orderIds: [presaleA.id, presaleB.id],
      reason: '加入预售',
    });
    const initialDemand = application.queryFulfillmentDemand(presale.id);
    const boxProduct = initialDemand.products
      .find(({ sku }) => sku === BOX_PRODUCT.sku)!;
    expect(initialDemand.totals).toMatchObject({
      demandQuantity: 15,
      uncoveredQuantity: 15,
    });

    // 验收条 1：三批采购——建议确认后逐批转入采购订单并确认，在途逐批累计。
    const batchQuantities = [4, 6, 5];
    const purchaseOrderIds: string[] = [];
    for (const [index, quantity] of batchQuantities.entries()) {
      const created = application.createPurchaseSuggestion({
        planId: presale.id,
        standardProductId: boxProduct.standardProductId,
        quantity,
        reason: `第${index + 1}批采购`,
      });
      const suggestion = created.suggestions.at(-1)!;
      application.confirmPurchaseSuggestion({
        planId: presale.id,
        suggestionId: suggestion.id,
        reason: `确认第${index + 1}批`,
      });
      application.createPurchaseOrderFromSuggestion({
        suggestionId: suggestion.id,
        supplierId,
        quantity,
        unitPriceCents: 500,
        expectedAt: '2026-09-15T00:00:00.000Z',
        reason: `第${index + 1}批转采购订单`,
      });
      const orderId = application.queryFulfillmentDemand(presale.id)
        .suggestions.find(({ id }) => id === suggestion.id)!.purchaseOrderId!;
      application.confirmPurchaseOrder({
        orderId,
        reason: `确认第${index + 1}批采购订单`,
      });
      purchaseOrderIds.push(orderId);
    }
    const fullyCovered = application.queryFulfillmentDemand(presale.id);
    expect(fullyCovered.totals).toMatchObject({
      demandQuantity: 15,
      confirmedInTransitQuantity: 15,
      uncoveredQuantity: 0,
    });
    expect(fullyCovered.suggestions.every(({ status, purchaseOrderId }) => (
      status === 'converted' && purchaseOrderId !== null
    ))).toBe(true);
    expect(fullyCovered.linkedPurchaseOrders.map(({ orderedQuantity }) => orderedQuantity))
      .toEqual(batchQuantities);
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku))
      .toMatchObject({ sellableQuantity: 0, purchaseInTransitQuantity: 15 });

    // 验收条 2：发货前部分退款重算缺口，已确认采购不被退款覆盖。
    const afterRefund = application.registerFulfillmentRefund({
      planId: presale.id,
      orderId: presaleB.id,
      orderItemId: presaleB.items[0].id,
      quantity: 2,
      reason: '发货前退款 2 件',
    });
    expect(afterRefund.totals).toMatchObject({
      demandQuantity: 13,
      confirmedInTransitQuantity: 15,
      uncoveredQuantity: 0,
    });
    const boxDemand = afterRefund.products.find(({ sku }) => sku === BOX_PRODUCT.sku)!;
    expect(boxDemand.overPurchaseRisk).toBe(true);
    const purchasesAfterRefund = application.queryPurchases();
    for (const orderId of purchaseOrderIds) {
      expect(orderById(purchasesAfterRefund, orderId)).toMatchObject({ status: 'confirmed' });
    }
    const convertedSuggestion = fullyCovered.suggestions[0]!;
    expect(() => application.cancelPurchaseSuggestion({
      planId: presale.id,
      suggestionId: convertedSuggestion.id,
      reason: '试图取消已转单建议',
    })).toThrow('已转采购订单的建议由采购订单承接，不能取消');
    expect(() => application.createPurchaseOrderFromSuggestion({
      suggestionId: convertedSuggestion.id,
      supplierId,
      quantity: 1,
      unitPriceCents: 500,
      expectedAt: '2026-09-15T00:00:00.000Z',
      reason: '试图重复转单',
    })).toThrow('只有已确认的采购建议可以转入采购订单');

    // 验收条 1：分次到货——第 1 批一次到货，第 2 批拆两次（含瑕疵与未分类），第 3 批一次到货；
    // 到货检查分流，未分类余量进待检查。
    const [firstOrderId, secondOrderId, thirdOrderId] = purchaseOrderIds;
    application.recordPurchaseArrival({
      orderId: firstOrderId,
      occurredAt: '2026-09-01T10:00:00+08:00',
      reason: '第1批全部合格',
      items: [
        { orderItemId: orderById(application.queryPurchases(), firstOrderId).items[0]!.id, receivedQuantity: 4, resellableQuantity: 4 },
      ],
    });
    application.recordPurchaseArrival({
      orderId: secondOrderId,
      occurredAt: '2026-09-02T10:00:00+08:00',
      reason: '第2批前一半到货，含 1 件瑕疵',
      items: [{
        orderItemId: orderById(application.queryPurchases(), secondOrderId).items[0]!.id,
        receivedQuantity: 4,
        resellableQuantity: 3,
        defectiveQuantity: 1,
      }],
    });
    application.recordPurchaseArrival({
      orderId: secondOrderId,
      occurredAt: '2026-09-03T10:00:00+08:00',
      reason: '第2批后一半到货待检查',
      items: [{
        orderItemId: orderById(application.queryPurchases(), secondOrderId).items[0]!.id,
        receivedQuantity: 2,
      }],
    });
    application.recordPurchaseArrival({
      orderId: thirdOrderId,
      occurredAt: '2026-09-04T10:00:00+08:00',
      reason: '第3批全部合格',
      items: [
        { orderItemId: orderById(application.queryPurchases(), thirdOrderId).items[0]!.id, receivedQuantity: 5, resellableQuantity: 5 },
      ],
    });
    let inventory = application.queryInventory();
    expect(productOf(inventory, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 12,
      awaitingInspectionQuantity: 2,
      defectiveQuantity: 1,
      purchaseInTransitQuantity: 0,
    });
    expect(productOf(inventory, CLIP_PRODUCT.sku).sellableQuantity).toBe(0);
    const partiallyArrived = application.queryFulfillmentDemand(presale.id);
    expect(partiallyArrived.totals).toMatchObject({
      arrivedQuantity: 15,
      sellableCoveredQuantity: 12,
      uncoveredQuantity: 1,
    });

    // 待检查余量人工检查后转可销售；采购瑕疵退回供应方。
    application.recordInventoryInspection({
      standardProductId: boxProduct.standardProductId,
      sellableQuantity: 2,
      defectiveQuantity: 0,
      scrappedQuantity: 0,
      reason: '待检查全部合格入库',
    });
    application.recordSupplierReturn({
      supplierId,
      purchaseOrderId: secondOrderId,
      occurredAt: '2026-09-05T10:00:00+08:00',
      reason: '采购瑕疵退回供应方',
      items: [{
        standardProductId: boxProduct.standardProductId,
        quantity: 1,
        state: 'defective',
      }],
    });
    inventory = application.queryInventory();
    expect(productOf(inventory, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 14,
      awaitingInspectionQuantity: 0,
      defectiveQuantity: 0,
    });
    expect(application.queryFulfillmentDemand(presale.id).totals.uncoveredQuantity).toBe(0);

    // 验收条 2（后半）：多出的 2 件进入普通库存（现货夹子订单占用 2 件预售外的可销售）。
    // 夹子未到货前先补一次夹子采购到货，占满现货订单预留。
    const clipRestock = application.createPurchaseOrder({
      supplierId,
      expectedAt: '2026-09-06T00:00:00.000Z',
      reason: '现货夹子补货',
      items: [{
        standardProductId: productOf(inventory, CLIP_PRODUCT.sku).standardProductId,
        quantity: 4,
        unitPriceCents: 300,
      }],
    });
    const clipOrder = clipRestock.orders.at(-1)!;
    application.confirmPurchaseOrder({ orderId: clipOrder.id, reason: '确认夹子补货' });
    application.recordPurchaseArrival({
      orderId: clipOrder.id,
      occurredAt: '2026-09-06T10:00:00+08:00',
      reason: '夹子全部合格',
      items: [{
        orderItemId: clipOrder.items[0]!.id,
        receivedQuantity: 4,
        resellableQuantity: 4,
      }],
    });
    inventory = application.queryInventory();
    expect(productOf(inventory, CLIP_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 4,
      reservedQuantity: 2,
    });

    // 释放备货：需求 13（10 + 5 − 2 退款）不超过可用现货 14，闸门放行。
    const released = application.releaseFulfillmentPlanOrders({
      planId: presale.id,
      expectedRevision: application.queryFulfillmentPlans()
        .find(({ id }) => id === presale.id)!.revision,
      orderIds: [presaleA.id, presaleB.id],
      reason: '三批到货齐备释放',
    });
    expect(released).toMatchObject({ status: 'released', releasedOrderCount: 2 });
    inventory = application.queryInventory();
    expect(productOf(inventory, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 14,
      reservedQuantity: 13,
    });

    // 两张预售订单发货后，多采购的 1 件留在普通库存，可自由动用。
    // 发货前退款按净额扣减可发数量：乙的可发数量是 3 件而不是原购 5 件。
    const groupForB = application.queryShipmentGroups().groups
      .find(({ orders }) => orders.some(({ id }) => id === presaleB.id))!;
    expect(groupForB.orders[0]!.items[0]!.quantity).toBe(3);
    confirmShipmentForOrder(application, presaleA.id, 'SF-LOOP-PRESALE-A');
    confirmShipmentForOrder(application, presaleB.id, 'SF-LOOP-PRESALE-B');
    inventory = application.queryInventory();
    expect(productOf(inventory, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 1,
      reservedQuantity: 0,
    });
    const boxProductId = boxProduct.standardProductId;
    expect(() => application.recordInventoryAdjustment({
      standardProductId: boxProductId,
      quantity: 2,
      direction: 'out',
      state: 'sellable',
      reason: '试图动用超过余量的多采购商品',
    })).toThrow('玻璃保鲜盒（1000ml）可销售 1 件，不够扣减 2 件');
    application.recordInventoryAdjustment({
      standardProductId: boxProductId,
      quantity: 1,
      direction: 'out',
      state: 'sellable',
      reason: '多采购商品转赠样品',
    });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity).toBe(0);

    // 现货夹子订单仍占用：计划外预留不被预售链路挤占。
    const clipProductId = productOf(application.queryInventory(), CLIP_PRODUCT.sku)
      .standardProductId;
    expect(() => application.recordInventoryAdjustment({
      standardProductId: clipProductId,
      quantity: 3,
      direction: 'out',
      state: 'sellable',
      reason: '试图动用被占用的夹子',
    })).toThrow(
      '硅胶封口夹（大号）可销售 4 件，其中 2 件已被待发货订单占用，可用 2 件，不够扣减 3 件',
    );

    assertConservation(application);
    assertTraceability(application, [
      {
        sku: BOX_PRODUCT.sku,
        state: 'awaiting_inspection',
        direction: 'out',
        quantity: 2,
        reason: '待检查全部合格入库',
      },
      {
        sku: BOX_PRODUCT.sku,
        state: 'sellable',
        direction: 'in',
        quantity: 2,
        reason: '待检查全部合格入库',
      },
    ]);
  });

  it('例一例三与正向丢件、拦截退回：售后链库存影响守恒且原发货快照不变', async () => {
    const { application, orders } = await openLoopApplication([
      loopRecognition('XY-LOOP-AFTER-SALES-X', [
        ...boxItems(3),
        { sourceTitle: CLIP_PRODUCT.name, sourceSpec: CLIP_PRODUCT.specification, quantity: 2 },
      ], '售后买家甲', '13900000201'),
      loopRecognition('XY-LOOP-AFTER-SALES-Y', boxItems(1), '售后买家乙', '13900000202'),
      loopRecognition('XY-LOOP-AFTER-SALES-Z', boxItems(1), '售后买家丙', '13900000203'),
    ]);
    const [orderX, orderY, orderZ] = orders;
    const supplierId = application.queryPurchases().suppliers[0]!.supplierId;
    const boxProduct = productOf(application.queryInventory(), BOX_PRODUCT.sku);
    const clipProduct = productOf(application.queryInventory(), CLIP_PRODUCT.sku);

    // 采购到货为售后链备货：10 件保鲜盒 + 4 件夹子全部合格。
    const created = application.createPurchaseOrder({
      supplierId,
      expectedAt: '2026-08-21T00:00:00.000Z',
      reason: '售后链备货采购',
      items: [
        { standardProductId: boxProduct.standardProductId, quantity: 10, unitPriceCents: 500 },
        { standardProductId: clipProduct.standardProductId, quantity: 4, unitPriceCents: 300 },
      ],
    });
    const purchaseOrder = created.orders.at(-1)!;
    application.confirmPurchaseOrder({ orderId: purchaseOrder.id, reason: '确认备货采购' });
    application.recordPurchaseArrival({
      orderId: purchaseOrder.id,
      occurredAt: '2026-08-21T10:00:00+08:00',
      reason: '备货全部合格',
      items: purchaseOrder.items.map((item) => ({
        orderItemId: item.id,
        receivedQuantity: item.quantity,
        resellableQuantity: item.quantity,
      })),
    });

    // 例一第 1-3 条：原发货包含保鲜盒 3 件、夹子 2 件。
    const shippedX = confirmShipmentForOrder(application, orderX.id, 'SF-LOOP-X');
    const packageX = shippedX.record.packages[0]!;
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity).toBe(7);
    expect(productOf(application.queryInventory(), CLIP_PRODUCT.sku).sellableQuantity).toBe(2);

    // 例一第 4-6 条：换货只关联保鲜盒 1 件，寄回、收到、待检查、检查为瑕疵品。
    application.updateShipmentPackageLogisticsStatus({
      recordId: shippedX.record.id,
      packageId: packageX.id,
      expectedRevision: packageX.revision,
      logisticsStatus: 'delivered',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-21T12:00:00+08:00',
      reason: '买家签收',
    });
    const boxShipmentItem = packageX.items.find(({ sourceTitle }) => (
      sourceTitle === BOX_PRODUCT.name
    ))!;
    const exchange = application.createAftersalesCase({
      shipmentRecordId: shippedX.record.id,
      workflowTemplateId: 'system-aftersales-exchange',
      occurredAt: '2026-08-21T12:10:00+08:00',
      reason: '保鲜盒破损换货',
      items: [{ shipmentPackageItemId: boxShipmentItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: exchange.id,
      expectedRevision: exchange.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-LOOP-RETURN-X',
      occurredAt: '2026-08-21T12:20:00+08:00',
      reason: '买家寄回破损件',
    });
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0]!.id,
      occurredAt: '2026-08-21T12:30:00+08:00',
      reason: '卖家收到退回件',
      items: registered.returns[0]!.items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.quantity,
      })),
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: received.returns[0]!.id,
      result: 'defective',
      occurredAt: '2026-08-21T12:40:00+08:00',
      note: '确认瑕疵品',
      items: registered.returns[0]!.items.map((item) => ({
        returnRecordItemId: item.id,
        acceptedQuantity: item.quantity,
        result: 'defective',
        note: '边角开裂',
      })),
    });
    let inventory = application.queryInventory();
    expect(productOf(inventory, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 7,
      awaitingInspectionQuantity: 0,
      defectiveQuantity: 1,
    });

    // 例一第 7-8 条：补发新记录发出保鲜盒 1 件，补发签收后完成售后。
    const replaced = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: inspected.id,
      roundId: inspected.rounds[0]!.id,
      expectedRevision: inspected.revision,
      occurredAt: '2026-08-21T12:50:00+08:00',
      reason: '发出换货商品',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-LOOP-REPLACEMENT-X',
        items: inspected.rounds[0]!.items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });
    const replacementRecord = replaced.rounds[0]!.replacementShipment!;
    const replacementPackage = replacementRecord.packages[0]!;
    application.updateShipmentPackageLogisticsStatus({
      recordId: replacementRecord.id,
      packageId: replacementPackage.id,
      expectedRevision: replacementPackage.revision,
      logisticsStatus: 'delivered',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-21T13:30:00+08:00',
      reason: '买家签收补发件',
    });
    const exchangeCaseRevision = application.queryAftersalesCases({
      shipmentRecordId: shippedX.record.id,
    }).find(({ id }) => id === replaced.id)!.revision;
    const completed = application.progressAftersalesCase({
      kind: 'complete',
      caseId: replaced.id,
      expectedRevision: exchangeCaseRevision,
      reason: '补发完成售后完结',
    });
    expect(completed).toMatchObject({ status: 'completed' });
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku).sellableQuantity).toBe(6);

    // 例三：仅退款不产生退货入库。
    const movementsBeforeRefundOnly = application.queryInventory().movements.length;
    const clipShipmentItem = packageX.items.find(({ sourceTitle }) => (
      sourceTitle === CLIP_PRODUCT.name
    ))!;
    const refundOnly = application.createAftersalesCase({
      shipmentRecordId: shippedX.record.id,
      workflowTemplateId: 'system-aftersales-refund-only',
      requestedRefundCents: 800,
      occurredAt: '2026-08-21T13:00:00+08:00',
      reason: '夹子仅退款',
      items: [{ shipmentPackageItemId: clipShipmentItem.id, quantity: 1 }],
    });
    const refundConfirmed = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: refundOnly.id,
      expectedRevision: refundOnly.revision,
      actualRefundCents: 800,
      occurredAt: '2026-08-21T13:10:00+08:00',
      note: '平台确认退款',
    });
    expect(application.progressAftersalesCase({
      kind: 'complete',
      caseId: refundConfirmed.id,
      expectedRevision: refundConfirmed.revision,
      reason: '仅退款完成',
    })).toMatchObject({ status: 'completed' });
    expect(application.queryInventory().movements).toHaveLength(movementsBeforeRefundOnly);

    // 正向丢件：实际发出的商品已扣库存，确认丢件不再产生库存变化。
    const shippedY = confirmShipmentForOrder(application, orderY.id, 'SF-LOOP-Y');
    const packageY = shippedY.record.packages[0]!;
    const acceptedY = application.updateShipmentPackageLogisticsStatus({
      recordId: shippedY.record.id,
      packageId: packageY.id,
      expectedRevision: packageY.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-21T14:00:00+08:00',
      reason: '承运方已揽收',
    });
    const movementsBeforeLoss = application.queryInventory().movements.length;
    application.recordShipmentPackageLogisticsException({
      recordId: shippedY.record.id,
      packageId: packageY.id,
      expectedRevision: acceptedY.record.packages[0]!.revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-21T15:00:00+08:00',
      reason: '承运方确认包裹丢失',
    });
    inventory = application.queryInventory();
    expect(productOf(inventory, BOX_PRODUCT.sku).sellableQuantity).toBe(5);
    expect(inventory.movements).toHaveLength(movementsBeforeLoss);

    // 拦截退回：先拦截成功，包裹退回后登记检查，破损件走报废分类不再回到可销售。
    const shippedZ = confirmShipmentForOrder(application, orderZ.id, 'SF-LOOP-Z');
    const packageZ = shippedZ.record.packages[0]!;
    const intercept = application.createAftersalesCase({
      shipmentRecordId: shippedZ.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'intercept',
      requestedRefundCents: 800,
      occurredAt: '2026-08-21T14:10:00+08:00',
      reason: '地址错误申请拦截',
      items: [{ shipmentPackageItemId: packageZ.items[0]!.id, quantity: 1 }],
    });
    const intercepted = application.progressAftersalesCase({
      kind: 'record_interception_result',
      caseId: intercept.id,
      expectedRevision: intercept.revision,
      result: 'succeeded',
      occurredAt: '2026-08-21T14:20:00+08:00',
      reason: '承运方确认拦截成功',
    });
    const returnedPackage = application.updateShipmentPackageLogisticsStatus({
      recordId: shippedZ.record.id,
      packageId: packageZ.id,
      expectedRevision: packageZ.revision,
      logisticsStatus: 'returned',
      occurredAt: '2026-08-21T14:30:00+08:00',
      reason: '卖家收到拦截退回包裹',
    }).record.packages[0]!;
    const interceptInspected = application.progressAftersalesCase({
      kind: 'inspect_intercepted_return',
      caseId: intercepted.id,
      expectedRevision: intercepted.revision,
      packageId: packageZ.id,
      result: 'scrapped',
      occurredAt: '2026-08-21T14:40:00+08:00',
      reason: '退回件破损报废',
      items: [{ shipmentPackageItemId: packageZ.items[0]!.id, quantity: 1 }],
    });
    expect(() => application.progressAftersalesCase({
      kind: 'inspect_intercepted_return',
      caseId: interceptInspected.id,
      expectedRevision: interceptInspected.revision,
      packageId: returnedPackage.id,
      result: 'scrapped',
      occurredAt: '2026-08-21T14:50:00+08:00',
      reason: '试图重复登记拦截检查',
      items: [{ shipmentPackageItemId: packageZ.items[0]!.id, quantity: 1 }],
    })).toThrow('该拦截退回包裹已经登记检查');

    // 例一第 9 条：原发货快照仍是保鲜盒 3 件、夹子 2 件，补发是独立发货记录。
    inventory = application.queryInventory();
    expect(productOf(inventory, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 4,
      awaitingInspectionQuantity: 0,
      defectiveQuantity: 1,
      scrappedQuantity: 1,
    });
    expect(productOf(inventory, CLIP_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 2,
      reservedQuantity: 0,
    });
    const archiveRecords = application.queryShipmentGroupArchives()
      .flatMap((archive) => archive.records);
    const originalX = archiveRecords.find((record) => (
      record.sourceOrders.some(({ orderId }) => orderId === orderX.id)
      && record.packages.some(({ id }) => id === packageX.id)
    ))!;
    expect(originalX.packages[0]!.items.map(({ sourceTitle, quantity }) => ({
      sourceTitle,
      quantity,
    }))).toEqual([
      { sourceTitle: BOX_PRODUCT.name, quantity: 3 },
      { sourceTitle: CLIP_PRODUCT.name, quantity: 2 },
    ]);
    expect(archiveRecords.some((record) => (
      record.id === replaced.rounds[0]!.replacementShipment?.id
    ))).toBe(true);

    assertConservation(application);
    assertTraceability(application, []);
  });

  it('重复操作不重复记账：超量与重复入口被守卫拦下', async () => {
    const { application, orders } = await openLoopApplication([
      loopRecognition('XY-LOOP-IDEMPOTENT', boxItems(2), '幂等买家甲', '13900000301'),
    ]);
    const [order] = orders;
    const supplierId = application.queryPurchases().suppliers[0]!.supplierId;
    const boxProduct = productOf(application.queryInventory(), BOX_PRODUCT.sku);

    // 超量到货被拦：超过订单数量需先显式变更采购数量。
    const created = application.createPurchaseOrder({
      supplierId,
      expectedAt: '2026-08-22T00:00:00.000Z',
      reason: '幂等验收采购',
      items: [{ standardProductId: boxProduct.standardProductId, quantity: 3, unitPriceCents: 500 }],
    });
    const purchaseOrder = created.orders.at(-1)!;
    application.confirmPurchaseOrder({ orderId: purchaseOrder.id, reason: '确认采购' });
    expect(() => application.recordPurchaseArrival({
      orderId: purchaseOrder.id,
      occurredAt: '2026-08-22T10:00:00+08:00',
      reason: '超量到货',
      items: [{
        orderItemId: purchaseOrder.items[0]!.id,
        receivedQuantity: 4,
        resellableQuantity: 4,
      }],
    })).toThrow('到货数量超过订单数量（该商品行还可到货 3 件），请先显式变更采购数量');

    application.recordPurchaseArrival({
      orderId: purchaseOrder.id,
      occurredAt: '2026-08-22T10:00:00+08:00',
      reason: '部分到货待检查',
      items: [{
        orderItemId: purchaseOrder.items[0]!.id,
        receivedQuantity: 3,
        resellableQuantity: 1,
      }],
    });
    // 超量检查与超量供应方退货被拦。
    expect(() => application.recordInventoryInspection({
      standardProductId: boxProduct.standardProductId,
      sellableQuantity: 3,
      defectiveQuantity: 0,
      scrappedQuantity: 0,
      reason: '试图检查超过待检查数量',
    })).toThrow('玻璃保鲜盒（1000ml）待检查 2 件，不够检查 3 件');
    expect(() => application.recordSupplierReturn({
      supplierId,
      purchaseOrderId: purchaseOrder.id,
      occurredAt: '2026-08-22T11:00:00+08:00',
      reason: '试图退回不存在的瑕疵品',
      items: [{
        standardProductId: boxProduct.standardProductId,
        quantity: 1,
        state: 'defective',
      }],
    })).toThrow('玻璃保鲜盒（1000ml）瑕疵品 0 件，不够退给供应方 1 件');

    // 计划外订单占用的预留不能手动动用。
    expect(productOf(application.queryInventory(), BOX_PRODUCT.sku))
      .toMatchObject({ sellableQuantity: 1, reservedQuantity: 2 });
    expect(() => application.recordInventoryAdjustment({
      standardProductId: boxProduct.standardProductId,
      quantity: 2,
      direction: 'out',
      state: 'sellable',
      reason: '试图动用被占用库存',
    })).toThrow(
      '玻璃保鲜盒（1000ml）可销售 1 件，其中 2 件已被待发货订单占用，可用 0 件，不够扣减 2 件',
    );

    // 同一包裹重复撤销被拦，冲正只记一次。
    const shipped = confirmShipmentForOrder(application, order.id, 'SF-LOOP-IDEMPOTENT');
    const packageFirst = shipped.record.packages[0]!;
    application.cancelShipmentPackages({
      recordId: shipped.record.id,
      packageIds: [packageFirst.id],
      reason: '运单填错未交寄',
    });
    expect(() => application.cancelShipmentPackages({
      recordId: shipped.record.id,
      packageIds: [packageFirst.id],
      reason: '试图重复撤销',
    })).toThrow('发货记录已经作废');
    const inventory = application.queryInventory();
    expect(inventory.movements.filter(({ sourceType }) => sourceType === 'shipment_void'))
      .toHaveLength(1);
    expect(productOf(inventory, BOX_PRODUCT.sku)).toMatchObject({
      sellableQuantity: 1,
      awaitingInspectionQuantity: 2,
      reservedQuantity: 2,
    });

    assertConservation(application);
    assertTraceability(application, []);
  });

  it('关闭重开与备份恢复后库存、采购与售后数量历史一致', async () => {
    const { application, orders } = await openLoopApplication([
      loopRecognition('XY-LOOP-RESTART', boxItems(3), '重启买家甲', '13900000401'),
    ]);
    const [order] = orders;
    const supplierId = application.queryPurchases().suppliers[0]!.supplierId;
    const boxProduct = productOf(application.queryInventory(), BOX_PRODUCT.sku);

    const presale = application.createFulfillmentPlan({
      type: 'presale',
      name: '重启验收预售',
      expectedShipAt: '2026-10-31T00:00:00.000Z',
      targetQuantity: null,
      deadlineAt: null,
      demandAlertThreshold: null,
      reason: '重启验收备货',
    });
    application.addFulfillmentPlanOrders({
      planId: presale.id,
      expectedRevision: presale.revision,
      orderIds: [order.id],
      reason: '加入预售',
    });
    const suggestion = application.createPurchaseSuggestion({
      planId: presale.id,
      standardProductId: boxProduct.standardProductId,
      quantity: 3,
      reason: '整批采购',
    }).suggestions[0]!;
    application.confirmPurchaseSuggestion({
      planId: presale.id,
      suggestionId: suggestion.id,
      reason: '确认整批采购',
    });
    application.createPurchaseOrderFromSuggestion({
      suggestionId: suggestion.id,
      supplierId,
      quantity: 3,
      unitPriceCents: 500,
      expectedAt: '2026-09-10T00:00:00.000Z',
      reason: '整批转采购订单',
    });
    const purchaseOrderId = application.queryFulfillmentDemand(presale.id)
      .suggestions.find(({ id }) => id === suggestion.id)!.purchaseOrderId!;
    application.confirmPurchaseOrder({ orderId: purchaseOrderId, reason: '确认采购订单' });
    application.recordPurchaseArrival({
      orderId: purchaseOrderId,
      occurredAt: '2026-09-10T10:00:00+08:00',
      reason: '整批合格',
      items: [{
        orderItemId: orderById(application.queryPurchases(), purchaseOrderId).items[0]!.id,
        receivedQuantity: 3,
        resellableQuantity: 3,
      }],
    });
    application.releaseFulfillmentPlanOrders({
      planId: presale.id,
      expectedRevision: application.queryFulfillmentPlans()
        .find(({ id }) => id === presale.id)!.revision,
      orderIds: [order.id],
      reason: '到货释放',
    });
    const shipped = confirmShipmentForOrder(application, order.id, 'SF-LOOP-RESTART');
    const packageFirst = shipped.record.packages[0]!;
    application.updateShipmentPackageLogisticsStatus({
      recordId: shipped.record.id,
      packageId: packageFirst.id,
      expectedRevision: packageFirst.revision,
      logisticsStatus: 'delivered',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-09-11T10:00:00+08:00',
      reason: '买家签收',
    });
    const exchange = application.createAftersalesCase({
      shipmentRecordId: shipped.record.id,
      workflowTemplateId: 'system-aftersales-exchange',
      occurredAt: '2026-09-11T10:10:00+08:00',
      reason: '重启验收换货',
      items: [{ shipmentPackageItemId: packageFirst.items[0]!.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: exchange.id,
      expectedRevision: exchange.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-LOOP-RETURN-RESTART',
      occurredAt: '2026-09-11T10:20:00+08:00',
      reason: '买家寄回',
    });
    application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0]!.id,
      occurredAt: '2026-09-11T10:30:00+08:00',
      reason: '卖家收到',
      items: registered.returns[0]!.items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.quantity,
      })),
    });

    const before = {
      inventory: application.queryInventory(),
      purchases: application.queryPurchases(),
      demand: application.queryFulfillmentDemand(presale.id),
      aftersales: application.queryAftersalesCases({ shipmentRecordId: shipped.record.id }),
    };
    const dataDirectory = application.dataDirectory;
    application.close();
    applications.splice(applications.indexOf(application), 1);

    // 关闭重开：同一数据目录读回全部数量与历史。
    const reopened = new LocalApplication(new SequenceRecognizer([]));
    applications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    expect(reopened.queryInventory()).toEqual(before.inventory);
    expect(reopened.queryPurchases()).toEqual(before.purchases);
    expect(reopened.queryFulfillmentDemand(presale.id)).toEqual(before.demand);
    expect(reopened.queryAftersalesCases({ shipmentRecordId: shipped.record.id }))
      .toEqual(before.aftersales);
    assertConservation(reopened);
    reopened.close();
    applications.splice(applications.indexOf(reopened), 1);

    // 备份恢复：整库拷贝到新目录后打开，数量与历史一致。
    const backupDataDirectory = join(
      await mkdtemp(join(tmpdir(), 'xianyu-inventory-loop-restore-')),
      '数据',
    );
    await mkdir(backupDataDirectory, { recursive: true });
    await cp(
      join(dataDirectory, 'xianyu-order-manager.sqlite3'),
      join(backupDataDirectory, 'xianyu-order-manager.sqlite3'),
    );
    expect(await readFile(join(backupDataDirectory, 'xianyu-order-manager.sqlite3')))
      .toEqual(await readFile(join(dataDirectory, 'xianyu-order-manager.sqlite3')));

    const restored = new LocalApplication(new SequenceRecognizer([]));
    applications.push(restored);
    restored.openDataDirectory(backupDataDirectory);
    expect(restored.queryInventory()).toEqual(before.inventory);
    expect(restored.queryPurchases()).toEqual(before.purchases);
    expect(restored.queryFulfillmentDemand(presale.id)).toEqual(before.demand);
    expect(restored.queryAftersalesCases({ shipmentRecordId: shipped.record.id }))
      .toEqual(before.aftersales);
    assertConservation(restored);
  });
});
