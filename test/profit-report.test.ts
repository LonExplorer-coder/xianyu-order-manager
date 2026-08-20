import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import type { ProfitReportView } from '../src/core/profit';
import type { LocalApplication } from '../src/main/local-application';
import { LocalApplication as LocalApplicationClass } from '../src/main/local-application';

const applications: LocalApplication[] = [];

const PRODUCT_A = { name: '利润测试保鲜盒', specification: '1000ml', sku: 'SKU-PROFIT-A' };
const PRODUCT_B = { name: '利润测试封口夹', specification: '大号', sku: 'SKU-PROFIT-B' };
const PRODUCT_C = { name: '利润测试数据线', specification: '1米', sku: 'SKU-PROFIT-C' };

type SeedItem = {
  sourceTitle: string;
  sourceSpec: string;
  unitPriceCents: number;
  quantity: number;
};

function profitRecognition(
  orderNumber: string,
  items: SeedItem[],
  recipient: { name: string; phone: string } = { name: '利润测试收件人', phone: '13700000001' },
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '利润测试账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '利润测试买家',
    recipient: recipient.name,
    phone: recipient.phone,
    phoneNormalized: recipient.phone,
    addressOriginal: '浙江省杭州市西湖区利润路1号',
    addressNormalized: '浙江省杭州市西湖区利润路1号',
    province: '浙江省',
    city: '杭州市',
    district: '西湖区',
    orderedAtOriginal: '2026-08-20 10:00:00',
    orderedAtNormalized: '2026-08-20T10:00:00+08:00',
    paidAtOriginal: '2026-08-20 10:00:08',
    paidAtNormalized: '2026-08-20T10:00:08+08:00',
    productTotalCents: items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0),
    shippingFeeCents: 0,
    amountCents: items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0),
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: items.map((item) => ({
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      quantityInferred: false,
    })),
  };
}

class SequenceRecognizer implements Recognizer {
  private index = 0;

  public constructor(private readonly recognitions: RecognitionResult[]) {}

  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result = this.recognitions[this.index] ?? this.recognitions.at(-1)!;
    this.index += 1;
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
  }
}

async function openProfitApplication(
  recognitions: RecognitionResult[],
  options: { withProducts?: boolean } = { withProducts: true },
): Promise<LocalApplication> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-profit-report-'));
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const application = new LocalApplicationClass(new SequenceRecognizer(recognitions));
  applications.push(application);
  application.openDataDirectory(join(root, '数据'));
  if (options.withProducts) {
    for (const product of [PRODUCT_A, PRODUCT_B, PRODUCT_C]) {
      application.createStandardProduct({
        name: product.name,
        specification: product.specification,
        sku: product.sku,
        defaultOrderPriceCents: 1_000,
        priceChangeReason: '首次定价',
      });
    }
  }
  for (let index = 0; index < recognitions.length; index += 1) {
    const sourcePath = join(sourceDirectory, `订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`profit-report-source-${index}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    application.confirmDraft(batch.drafts[0]);
  }
  return application;
}

function confirmShipmentOfGroup(application: LocalApplication, trackingNumber: string) {
  const group = application.queryShipmentGroups().groups[0];
  if (!group) throw new Error('测试前置缺少发货组');
  const items = group.orders.flatMap((groupOrder) => groupOrder.items.map((item) => ({
    orderId: groupOrder.id,
    orderItemId: item.id,
    quantity: item.quantity,
  })));
  return application.confirmShipment({
    groupId: group.id,
    expectedRemainingItems: items,
    packages: [{ shippingCarrier: '顺丰速运', trackingNumber, items }],
  });
}

function purchaseAndArrive(
  application: LocalApplication,
  items: Array<{ sku: string; quantity: number; unitPriceCents: number }>,
  arrivalRouting: Array<{ sku: string; resellable?: number; defective?: number; scrapped?: number }>,
) {
  const purchases = application.createSupplier({ name: '利润测试供应方', contact: null, note: null });
  const supplier = purchases.suppliers.find(({ name }) => name === '利润测试供应方')!;
  const created = application.createPurchaseOrder({
    supplierId: supplier.supplierId,
    expectedAt: '2026-12-31T00:00:00.000Z',
    reason: '利润测试采购',
    items: items.map((item) => ({
      standardProductId: productIdOf(application, item.sku),
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    })),
  });
  const purchaseOrder = created.orders.at(-1)!;
  const confirmed = application.confirmPurchaseOrder({
    orderId: purchaseOrder.id,
    reason: '确认采购',
  }).orders.find(({ id }) => id === purchaseOrder.id)!;
  const routingBySku = new Map<
    string,
    { resellable?: number; defective?: number; scrapped?: number }
  >(arrivalRouting.map((row) => [row.sku, row]));
  application.recordPurchaseArrival({
    orderId: purchaseOrder.id,
    occurredAt: '2026-08-20T14:05:00+08:00',
    reason: '利润测试到货',
    items: confirmed.items.map((item) => {
      const routing = routingBySku.get(item.sku) ?? {};
      return {
        orderItemId: item.id,
        receivedQuantity: item.quantity,
        ...(routing.resellable === undefined ? {} : { resellableQuantity: routing.resellable }),
        ...(routing.defective === undefined ? {} : { defectiveQuantity: routing.defective }),
        ...(routing.scrapped === undefined ? {} : { scrappedQuantity: routing.scrapped }),
      };
    }),
  });
  return { purchaseOrderId: purchaseOrder.id };
}

function productIdOf(application: LocalApplication, sku: string): string {
  const product = application.queryInventory().products.find((candidate) => candidate.sku === sku);
  if (!product) throw new Error(`测试未找到商品 ${sku}`);
  return product.standardProductId;
}

function orderRowOf(report: ProfitReportView, orderNumber: string) {
  const row = report.orders.find((candidate) => candidate.orderNumber === orderNumber);
  if (!row) throw new Error(`测试未找到订单行 ${orderNumber}`);
  return row;
}

function productRowOf(report: ProfitReportView, sku: string) {
  const row = report.products.find((candidate) => candidate.sku === sku);
  if (!row) throw new Error(`测试未找到商品行 ${sku}`);
  return row;
}

function openReturnRefundCase(
  application: LocalApplication,
  shipmentRecordId: string,
  shipmentPackageItemId: string,
  quantity: number,
  requestedRefundCents: number,
) {
  const template = application.listAftersalesWorkflowTemplates()
    .find(({ scenario }) => scenario === 'return_refund');
  if (!template) throw new Error('测试前置缺少退货退款流程');
  return application.createAftersalesCase({
    shipmentRecordId,
    workflowTemplateId: template.id,
    handlingDirection: 'buyer_return',
    occurredAt: '2026-08-20T14:20:00+08:00',
    reason: '利润测试：退货退款',
    requestedRefundCents,
    items: [{ shipmentPackageItemId, quantity }],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-20T06:00:00.000Z'));
});

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
  vi.useRealTimers();
});

describe('成本与利润视图', () => {
  it('订单利润按类型列示，采购成本按发出数量乘加权平均单价计算，退货转可销售冲回', async () => {
    const application = await openProfitApplication([
      profitRecognition('XY-PROFIT-0001', [
        { sourceTitle: PRODUCT_A.name, sourceSpec: PRODUCT_A.specification, unitPriceCents: 2_500, quantity: 2 },
        { sourceTitle: PRODUCT_B.name, sourceSpec: PRODUCT_B.specification, unitPriceCents: 5_000, quantity: 1 },
      ]),
    ]);
    const { purchaseOrderId } = purchaseAndArrive(application, [
      { sku: PRODUCT_A.sku, quantity: 3, unitPriceCents: 500 },
      { sku: PRODUCT_B.sku, quantity: 2, unitPriceCents: 800 },
    ], [
      { sku: PRODUCT_A.sku, resellable: 3 },
      { sku: PRODUCT_B.sku, resellable: 1, scrapped: 1 },
    ]);
    application.recordFinanceRecord({
      type: 'purchase_cost',
      direction: 'expense',
      amountCents: 3_100,
      occurredAt: '2026-08-20T14:06:00+08:00',
      note: '支付采购全款',
      sourceType: 'purchase_order',
      sourceId: purchaseOrderId,
    });

    const shipped = confirmShipmentOfGroup(application, 'SF-PROFIT-0001');    application.updateShipmentPackageLogisticsStatus({
      recordId: shipped.record.id,
      packageId: shipped.record.packages[0]!.id,
      expectedRevision: shipped.record.packages[0]!.revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-20T14:10:00+08:00',
      reason: '买家已签收',
    });
    const orderId = shipped.record.packages[0]!.items[0]!.orderId;
    application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 9_500,
      occurredAt: '2026-08-20T14:12:00+08:00',
      note: '平台结算到账',
      sourceType: 'order',
      sourceId: orderId,
    });
    application.recordFinanceRecord({
      type: 'platform_fee',
      direction: 'expense',
      amountCents: 300,
      occurredAt: '2026-08-20T14:13:00+08:00',
      note: '平台服务费',
      sourceType: 'order',
      sourceId: orderId,
    });
    application.recordFinanceRecord({
      type: 'initial_freight',
      direction: 'expense',
      amountCents: 800,
      occurredAt: '2026-08-20T14:14:00+08:00',
      note: '首发运费',
      sourceType: 'shipment_record',
      sourceId: shipped.record.id,
    });

    const bItem = shipped.record.packages[0]!.items
      .find((item) => item.sourceTitle === PRODUCT_B.name)!;
    const created = openReturnRefundCase(
      application,
      shipped.record.id,
      bItem.id,
      1,
      2_000,
    );
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-PROFIT-0001',
      occurredAt: '2026-08-20T14:30:00+08:00',
      reason: '买家寄回',
    });
    const returnRecordId = registered.returns[0]!.id;
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-20T14:35:00+08:00',
      reason: '已核对承运方揽收证据',
    });
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId,
      occurredAt: '2026-08-20T14:40:00+08:00',
      reason: '实际收到退货',
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId,
      occurredAt: '2026-08-20T14:45:00+08:00',
      result: 'resellable',
      note: '检查通过可再销售',
      items: [{
        returnRecordItemId: received.returns[0]!.items[0]!.id,
        acceptedQuantity: 1,
        result: 'resellable',
        note: '检查通过可再销售',
      }],
    });
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: inspected.id,
      expectedRevision: inspected.revision,
      actualRefundCents: 2_000,
      occurredAt: '2026-08-20T14:50:00+08:00',
      note: '平台实际退款',
    });
    const funds = application.queryFunds();
    const refundPending = funds.pendingItems.find(({ type }) => type === 'refund')!;
    application.confirmPendingFinanceItem({
      pendingItemId: refundPending.id,
      amountCents: 1_200,
      occurredAt: '2026-08-20T14:55:00+08:00',
      note: '先确认 12 元',
    });
    void refunded;

    const report = application.queryProfitReport();
    const row = orderRowOf(report, 'XY-PROFIT-0001');
    expect(row).toMatchObject({
      transactionAmountCents: 10_000,
      settlementNetCents: 9_500,
      refundNetCents: -1_200,
      platformFeeNetCents: -300,
      freightNetCents: -800,
      claimNetCents: 0,
      miscNetCents: 0,
      purchaseCostCents: 1_000,
      profitCents: 6_200,
      pendingRemainingCents: -800,
    });

    // 采购成本明细：A 发出 2 件 × 500，B 发出 1 件 − 退回冲回 1 件。
    expect(row.costComponents).toHaveLength(3);
    const dispatchA = row.costComponents.find((component) => (
      component.kind === 'dispatch' && component.sku === PRODUCT_A.sku
    ))!;
    expect(dispatchA).toMatchObject({ quantity: 2, unitCostCents: 500, amountCents: 1_000 });
    const dispatchB = row.costComponents.find((component) => (
      component.kind === 'dispatch' && component.sku === PRODUCT_B.sku
    ))!;
    expect(dispatchB).toMatchObject({ quantity: 1, unitCostCents: 800, amountCents: 800 });
    const recoveryB = row.costComponents.find((component) => (
      component.kind === 'recovery' && component.sku === PRODUCT_B.sku
    ))!;
    expect(recoveryB).toMatchObject({ quantity: 1, unitCostCents: 800, amountCents: -800 });
    expect(recoveryB.sourceLabel).toContain('退货检查');

    // 待确认与已确认资金都可下钻：已确认部分是记录，剩余部分是待确认事项。
    const refundRecord = row.moneyComponents.find(({ type, kind }) => (
      type === 'refund' && kind === 'record'
    ))!;
    expect(refundRecord).toMatchObject({ direction: 'expense', allocatedCents: -1_200 });
    const refundComponent = row.moneyComponents.find(({ type, kind }) => (
      type === 'refund' && kind === 'pending'
    ))!;
    expect(refundComponent).toMatchObject({
      kind: 'pending',
      direction: 'expense',
      remainingCents: -800,
      allocatedCents: -800,
    });
    expect(refundComponent.sourceLabel).toContain('售后处理单');
    // 部分退款追溯到售后单明细的商品与数量（ADR 0045 追溯口径第 1 条）。
    expect(refundComponent.sourceLabel).toContain(`${PRODUCT_B.name} ×1`);

    const productA = productRowOf(report, PRODUCT_A.sku);
    expect(productA).toMatchObject({
      avgUnitCostCents: 500,
      arrivedQuantity: 3,
      orderCount: 1,
      transactionCents: 5_000,
      dispatchedQuantity: 2,
      dispatchedCostCents: 1_000,
      scrapQuantity: 0,
      scrapCostCents: 0,
      returnReceivedQuantity: 0,
      marginCents: 2_600,
    });
    const productB = productRowOf(report, PRODUCT_B.sku);
    expect(productB).toMatchObject({
      avgUnitCostCents: 800,
      arrivedQuantity: 2,
      transactionCents: 5_000,
      dispatchedQuantity: 0,
      dispatchedCostCents: 0,
      scrapQuantity: 1,
      scrapCostCents: 800,
      returnReceivedQuantity: 1,
      marginCents: 2_800,
    });
    const scrapComponent = productB.costComponents.find(({ kind }) => kind === 'scrap')!;
    expect(scrapComponent).toMatchObject({ quantity: 1, unitCostCents: 800, amountCents: 800 });
    expect(scrapComponent.sourceLabel).toContain('到货检查');

    // 商品毛利之和 = 订单利润 − 报废损失。
    expect(productA.marginCents + productB.marginCents)
      .toBe(report.totals.profitCents - report.totals.scrapCostCents);

    expect(report.totals).toMatchObject({
      transactionCents: 10_000,
      profitCents: 6_200,
      pendingRemainingCents: -800,
      scrapCostCents: 800,
      purchasePaymentNetCents: -3_100,
      othersNetCents: -3_100,
    });
    expect(report.others).toHaveLength(1);
    expect(report.others[0]).toMatchObject({
      type: 'purchase_cost',
      allocatedCents: -3_100,
      sourceLabel: '采购订单 #1',
    });
    expect(report.unmapped).toMatchObject({
      orderCount: 0,
      transactionCents: 0,
      allocatedNetCents: 0,
    });
  });

  it('未确认退款不进利润，成交金额记录只作参照', async () => {
    const application = await openProfitApplication([
      profitRecognition('XY-PROFIT-0002', [
        { sourceTitle: PRODUCT_A.name, sourceSpec: PRODUCT_A.specification, unitPriceCents: 1_000, quantity: 1 },
      ]),
    ]);
    const shipped = confirmShipmentOfGroup(application, 'SF-PROFIT-0002');
    application.updateShipmentPackageLogisticsStatus({
      recordId: shipped.record.id,
      packageId: shipped.record.packages[0]!.id,
      expectedRevision: shipped.record.packages[0]!.revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-20T14:10:00+08:00',
      reason: '买家已签收',
    });
    const orderId = shipped.record.packages[0]!.items[0]!.orderId;
    application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 900,
      occurredAt: '2026-08-20T14:12:00+08:00',
      note: '平台结算到账',
      sourceType: 'order',
      sourceId: orderId,
    });
    application.recordFinanceRecord({
      type: 'order_transaction',
      direction: 'income',
      amountCents: 1_000,
      occurredAt: '2026-08-20T14:13:00+08:00',
      note: '成交金额参照',
      sourceType: 'order',
      sourceId: orderId,
    });

    const aItem = shipped.record.packages[0]!.items[0]!;
    const created = openReturnRefundCase(application, shipped.record.id, aItem.id, 1, 500);
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-20T14:20:00+08:00',
      note: '平台实际退款，尚未人工确认到账',
    });
    void refunded;

    let report = application.queryProfitReport();
    let row = orderRowOf(report, 'XY-PROFIT-0002');
    expect(row).toMatchObject({
      transactionAmountCents: 1_000,
      settlementNetCents: 900,
      refundNetCents: 0,
      profitCents: 900,
      pendingRemainingCents: -500,
    });
    const reference = row.moneyComponents.find(({ type }) => type === 'order_transaction')!;
    expect(reference).toMatchObject({ reference: true, allocatedCents: 1_000 });

    const funds = application.queryFunds();
    const refundPending = funds.pendingItems.find(({ type }) => type === 'refund')!;
    application.confirmPendingFinanceItem({
      pendingItemId: refundPending.id,
      amountCents: 500,
      occurredAt: '2026-08-20T14:25:00+08:00',
      note: '确认退款到账',
    });

    report = application.queryProfitReport();
    row = orderRowOf(report, 'XY-PROFIT-0002');
    expect(row).toMatchObject({
      refundNetCents: -500,
      profitCents: 400,
      pendingRemainingCents: 0,
    });
  });

  it('合并发货的运费按订单明细小计占比分摊，余数分给订单号最前的订单', async () => {
    const application = await openProfitApplication([
      profitRecognition(
        'XY-PROFIT-0003',
        [{ sourceTitle: PRODUCT_C.name, sourceSpec: PRODUCT_C.specification, unitPriceCents: 100, quantity: 1 }],
      ),
      profitRecognition(
        'XY-PROFIT-0004',
        [{ sourceTitle: PRODUCT_C.name, sourceSpec: PRODUCT_C.specification, unitPriceCents: 300, quantity: 1 }],
      ),
    ]);
    const group = application.queryShipmentGroups().groups[0]!;
    expect(group.orders).toHaveLength(2);
    const items = group.orders.flatMap((groupOrder) => groupOrder.items.map((item) => ({
      orderId: groupOrder.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipped = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: items,
      packages: [{ shippingCarrier: '顺丰速运', trackingNumber: 'SF-PROFIT-MERGED', items }],
    });
    application.recordFinanceRecord({
      type: 'initial_freight',
      direction: 'expense',
      amountCents: 101,
      occurredAt: '2026-08-20T14:12:00+08:00',
      note: '合并发货运费',
      sourceType: 'shipment_record',
      sourceId: shipped.record.id,
    });
    const laterOrder = shipped.record.packages[0]!.items
      .find((item) => item.orderNumber === 'XY-PROFIT-0004')!;
    application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 400,
      occurredAt: '2026-08-20T14:13:00+08:00',
      note: '平台结算到账',
      sourceType: 'order',
      sourceId: laterOrder.orderId,
    });

    const report = application.queryProfitReport();
    expect(orderRowOf(report, 'XY-PROFIT-0003')).toMatchObject({
      settlementNetCents: 0,
      freightNetCents: -26,
      purchaseCostCents: 0,
      profitCents: -26,
    });
    expect(orderRowOf(report, 'XY-PROFIT-0004')).toMatchObject({
      settlementNetCents: 400,
      freightNetCents: -75,
      purchaseCostCents: 0,
      profitCents: 325,
    });
    expect(report.totals.profitCents).toBe(299);

    const productC = productRowOf(report, PRODUCT_C.sku);
    expect(productC).toMatchObject({
      orderCount: 2,
      transactionCents: 400,
      dispatchedQuantity: 2,
      dispatchedCostCents: 0,
      marginCents: 299,
    });
  });

  it('补发记录的数量累计到原订单成本，重复补发逐条可追溯', async () => {
    const application = await openProfitApplication([
      profitRecognition('XY-PROFIT-0005', [
        { sourceTitle: PRODUCT_A.name, sourceSpec: PRODUCT_A.specification, unitPriceCents: 2_000, quantity: 2 },
      ]),
    ]);
    purchaseAndArrive(application, [
      { sku: PRODUCT_A.sku, quantity: 5, unitPriceCents: 400 },
    ], [
      { sku: PRODUCT_A.sku, resellable: 5 },
    ]);
    const shipped = confirmShipmentOfGroup(application, 'SF-PROFIT-0005');
    const shipmentPackage = shipped.record.packages[0]!;
    const affectedItem = shipmentPackage.items[0]!;
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipped.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-20T14:10:00+08:00',
      reason: '承运方已确认揽收',
    });
    const lost = application.recordShipmentPackageLogisticsException({
      recordId: shipped.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0]!.revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'items', items: [{ sourceItemId: affectedItem.id, quantity: 1 }] },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-20T14:12:00+08:00',
      reason: '承运方确认丢件一件',
    });
    const template = application.listAftersalesWorkflowTemplates()
      .find(({ scenario }) => scenario === 'return_refund');
    if (!template) throw new Error('测试前置缺少退货退款流程');
    const created = application.createAftersalesCase({
      shipmentRecordId: shipped.record.id,
      workflowTemplateId: template.id,
      handlingDirection: 'waiting',
      occurredAt: '2026-08-20T14:15:00+08:00',
      reason: '丢件补发',
      requestedRefundCents: 100,
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    const decided = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: created.revision,
      packageId: shipmentPackage.id,
      exceptionId: lost.record.packages[0]!.currentException!.id,
      decision: 'refund_and_replacement',
      occurredAt: '2026-08-20T14:18:00+08:00',
      reason: '退款并补发一件',
    });
    const replacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: decided.id,
      roundId: decided.rounds[1]!.id,
      expectedRevision: decided.revision,
      occurredAt: '2026-08-20T14:20:00+08:00',
      reason: '建立补发',
      packages: [{
        shippingCarrier: '中通快递',
        trackingNumber: 'ZT-PROFIT-REPLACE-0005',
        items: [{ roundItemId: decided.rounds[1]!.items[0]!.id, quantity: 1 }],
      }],
    });
    void replacement;

    const report = application.queryProfitReport();
    const row = orderRowOf(report, 'XY-PROFIT-0005');
    expect(row.purchaseCostCents).toBe(1_200);
    const dispatches = row.costComponents.filter(({ kind }) => kind === 'dispatch');
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map(({ quantity }) => quantity).sort((a, b) => a - b)).toEqual([1, 2]);
    const replacementComponent = dispatches.find(({ quantity }) => quantity === 1)!;
    expect(replacementComponent.sourceLabel).toContain('补发');
    expect(replacementComponent.shipmentRecordId).not.toBe(shipped.record.id);
  });

  it('未映射明细的份额进未映射行，视图只读不改写任何事实', async () => {
    const application = await openProfitApplication([
      profitRecognition('XY-PROFIT-0006', [
        { sourceTitle: PRODUCT_A.name, sourceSpec: PRODUCT_A.specification, unitPriceCents: 600, quantity: 1 },
        { sourceTitle: '手作发夹', sourceSpec: '蓝色', unitPriceCents: 400, quantity: 1 },
      ]),
    ]);
    const shipped = confirmShipmentOfGroup(application, 'SF-PROFIT-0006');
    const orderId = shipped.record.packages[0]!.items[0]!.orderId;
    application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 900,
      occurredAt: '2026-08-20T14:12:00+08:00',
      note: '平台结算到账',
      sourceType: 'order',
      sourceId: orderId,
    });

    // 只读：查询前后资金与库存事实的行数不变（利润视图绝不改写事实）。
    const fundsBefore = application.queryFunds();
    const movementsBefore = application.queryInventory().movements.length;
    const first = application.queryProfitReport();
    const fundsAfter = application.queryFunds();
    expect(fundsAfter.records).toHaveLength(fundsBefore.records.length);
    expect(fundsAfter.pendingItems).toHaveLength(fundsBefore.pendingItems.length);
    expect(application.queryInventory().movements).toHaveLength(movementsBefore);
    const row = orderRowOf(first, 'XY-PROFIT-0006');
    expect(row).toMatchObject({
      transactionAmountCents: 1_000,
      settlementNetCents: 900,
      profitCents: 900,
    });
    const productA = productRowOf(first, PRODUCT_A.sku);
    expect(productA).toMatchObject({ transactionCents: 600, allocatedNetCents: 540 });
    expect(first.unmapped).toMatchObject({
      orderCount: 1,
      transactionCents: 400,
      allocatedNetCents: 360,
    });

    const second = application.queryProfitReport();
    expect(second).toEqual(first);
  });
});
