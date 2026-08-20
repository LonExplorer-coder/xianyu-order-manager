import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { createBackup, restoreBackup } from '../src/main/backup-service';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';

const applications: LocalApplication[] = [];
const testRoots: string[] = [];

const PRODUCTS = [
  { name: '财务验收保鲜盒', specification: '标准款', sku: 'SKU-FINANCE-ACCEPT-A' },
  { name: '财务验收封口夹', specification: '标准款', sku: 'SKU-FINANCE-ACCEPT-B' },
  { name: '财务验收收纳袋', specification: '标准款', sku: 'SKU-FINANCE-ACCEPT-C' },
] as const;

class FinanceAcceptanceRecognizer implements Recognizer {
  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result: RecognitionResult = {
      platform: 'xianyu',
      sellerAccount: '财务闭环验收账号',
      orderNumber: 'XY-FINANCE-ACCEPT-0001',
      alipayTransactionNumber: 'ALI-FINANCE-ACCEPT-0001',
      buyerNickname: '财务验收买家',
      recipient: '财务验收收件人',
      phone: '13900000801',
      phoneNormalized: '13900000801',
      addressOriginal: '浙江省杭州市西湖区财务验收路1号',
      addressNormalized: '浙江省杭州市西湖区财务验收路1号',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      orderedAtOriginal: '2026-08-20 10:00:00',
      orderedAtNormalized: '2026-08-20T10:00:00+08:00',
      paidAtOriginal: '2026-08-20 10:00:08',
      paidAtNormalized: '2026-08-20T10:00:08+08:00',
      productTotalCents: 10_000,
      shippingFeeCents: 0,
      amountCents: 10_000,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [
        {
          sourceTitle: PRODUCTS[0].name,
          sourceSpec: PRODUCTS[0].specification,
          unitPriceCents: 2_500,
          quantity: 2,
          quantityInferred: false,
        },
        {
          sourceTitle: PRODUCTS[1].name,
          sourceSpec: PRODUCTS[1].specification,
          unitPriceCents: 2_500,
          quantity: 1,
          quantityInferred: false,
        },
        {
          sourceTitle: PRODUCTS[2].name,
          sourceSpec: PRODUCTS[2].specification,
          unitPriceCents: 2_500,
          quantity: 1,
          quantityInferred: false,
        },
      ],
    };
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-20T06:00:00.000Z'));
});

afterEach(async () => {
  for (const application of applications.splice(0)) application.close();
  vi.useRealTimers();
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('财务与经营结果闭环验收', () => {
  it('资金事实、利润、关闭重开与备份恢复使用同一条可追溯业务链', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-finance-acceptance-'));
    testRoots.push(root);
    const dataDirectory = join(root, '数据');
    const sourceDirectory = join(root, '上传');
    await mkdir(sourceDirectory, { recursive: true });

    const application = new LocalApplication(new FinanceAcceptanceRecognizer());
    applications.push(application);
    application.openDataDirectory(dataDirectory);
    for (const product of PRODUCTS) {
      application.createStandardProduct({
        ...product,
        defaultOrderPriceCents: 2_500,
        priceChangeReason: '财务闭环验收首次定价',
      });
    }
    const sourcePath = join(sourceDirectory, '财务闭环验收订单.png');
    await writeFile(sourcePath, Buffer.from('finance-profit-acceptance-order'));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    const order = application.confirmDraft(batch.drafts[0]);

    const purchase = createAndReceivePurchase(application);
    const originalShipment = confirmOriginalShipment(application);
    const lostPackage = originalShipment.record.packages
      .find(({ trackingNumber }) => trackingNumber === 'SF-FINANCE-LOST');
    const deliveredPackage = originalShipment.record.packages
      .find(({ trackingNumber }) => trackingNumber === 'SF-FINANCE-DELIVERED');
    if (!lostPackage || !deliveredPackage) {
      throw new Error('财务闭环验收缺少原发包裹');
    }
    const lostItem = lostPackage.items.find(({ sourceTitle }) => sourceTitle === PRODUCTS[0].name);
    if (!lostItem) throw new Error('财务闭环验收缺少丢件商品');

    const acceptedShipment = application.updateShipmentPackageLogisticsStatus({
      recordId: originalShipment.record.id,
      packageId: lostPackage.id,
      expectedRevision: lostPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-20T14:10:00+08:00',
      reason: '承运方确认首包已揽收',
    });
    const acceptedLostPackage = acceptedShipment.record.packages
      .find(({ id }) => id === lostPackage.id);
    if (!acceptedLostPackage) throw new Error('财务闭环验收缺少已揽收包裹');
    const lost = application.recordShipmentPackageLogisticsException({
      recordId: originalShipment.record.id,
      packageId: lostPackage.id,
      expectedRevision: acceptedLostPackage.revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'items', items: [{ sourceItemId: lostItem.id, quantity: 1 }] },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-20T14:15:00+08:00',
      reason: '承运方确认首包商品丢失',
    });
    const confirmedLostPackage = lost.record.packages.find(({ id }) => id === lostPackage.id);
    if (!confirmedLostPackage) throw new Error('财务闭环验收缺少已确认丢件包裹');
    application.progressShipmentPackageCarrierClaim({
      kind: 'open',
      recordId: originalShipment.record.id,
      packageId: lostPackage.id,
      expectedRevision: confirmedLostPackage.revision,
      requestedAmountCents: 1_200,
      occurredAt: '2026-08-20T14:20:00+08:00',
      reason: '申请丢件赔付',
    });
    const approvedClaim = application.progressShipmentPackageCarrierClaim({
      kind: 'resolve',
      recordId: originalShipment.record.id,
      packageId: lostPackage.id,
      expectedClaimRevision: 1,
      outcome: 'approved',
      approvedAmountCents: 1_200,
      occurredAt: '2026-08-20T14:25:00+08:00',
      reason: '承运方同意赔付',
    });
    const approvedPackage = approvedClaim.record.packages.find(({ id }) => id === lostPackage.id);
    const approvedCarrierClaim = approvedPackage?.carrierClaim;
    if (!approvedCarrierClaim) throw new Error('财务闭环验收缺少已批准的承运索赔');
    const carrierClaimId = approvedCarrierClaim.id;
    const compensatedClaim = application.progressShipmentPackageCarrierClaim({
      kind: 'confirm_compensation',
      recordId: originalShipment.record.id,
      packageId: lostPackage.id,
      expectedClaimRevision: approvedCarrierClaim.revision,
      amountCents: 1_000,
      occurredAt: '2026-08-20T14:30:00+08:00',
      note: '承运赔付实际到账',
    });
    const compensatedCarrierClaim = compensatedClaim.record.packages
      .find(({ id }) => id === lostPackage.id)?.carrierClaim;
    assertPaidCarrierClaim(compensatedCarrierClaim, carrierClaimId);

    const replacementCase = application.createAftersalesCase({
      shipmentRecordId: originalShipment.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-20T14:35:00+08:00',
      reason: '丢件后直接补发',
      items: [{ shipmentPackageItemId: lostItem.id, quantity: 1 }],
    });
    const replacementRound = replacementCase.rounds.find((round) => (
      round.items.some(({ sourceShipmentPackageItemId }) => sourceShipmentPackageItemId === lostItem.id)
    ));
    const replacementRoundItem = replacementRound?.items
      .find(({ sourceShipmentPackageItemId }) => sourceShipmentPackageItemId === lostItem.id);
    if (!replacementRound || !replacementRoundItem) {
      throw new Error('财务闭环验收缺少补发轮次或商品');
    }
    const replacementCaseAfterShipment = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: replacementCase.id,
      roundId: replacementRound.id,
      expectedRevision: replacementCase.revision,
      occurredAt: '2026-08-20T14:40:00+08:00',
      reason: '建立丢件补发记录',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-FINANCE-REPLACEMENT',
        items: [{ roundItemId: replacementRoundItem.id, quantity: 1 }],
      }],
    });
    const completedReplacementRound = replacementCaseAfterShipment.rounds
      .find(({ id }) => id === replacementRound.id);
    const replacementShipment = completedReplacementRound?.replacementShipment;
    if (!replacementShipment) throw new Error('财务闭环验收缺少补发记录');

    application.updateShipmentPackageLogisticsStatus({
      recordId: originalShipment.record.id,
      packageId: deliveredPackage.id,
      expectedRevision: deliveredPackage.revision,
      logisticsStatus: 'delivered',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-20T14:45:00+08:00',
      reason: '第二包买家已签收',
    });
    const deliveredItems = new Map(deliveredPackage.items.map((item) => [item.sourceTitle, item]));
    const resellableReturn = inspectOneItemReturn(application, {
      shipmentRecordId: originalShipment.record.id,
      shipmentPackageItemId: deliveredItems.get(PRODUCTS[0].name)!.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      requestedRefundCents: 2_000,
      result: 'resellable',
      sequence: 1,
    });
    inspectOneItemReturn(application, {
      shipmentRecordId: originalShipment.record.id,
      shipmentPackageItemId: deliveredItems.get(PRODUCTS[1].name)!.id,
      workflowTemplateId: 'system-aftersales-exchange',
      result: 'defective',
      sequence: 2,
    });
    inspectOneItemReturn(application, {
      shipmentRecordId: originalShipment.record.id,
      shipmentPackageItemId: deliveredItems.get(PRODUCTS[2].name)!.id,
      workflowTemplateId: 'system-aftersales-exchange',
      result: 'scrapped',
      sequence: 3,
    });
    application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: resellableReturn.id,
      expectedRevision: resellableReturn.revision,
      actualRefundCents: 1_200,
      occurredAt: '2026-08-20T15:20:00+08:00',
      note: '先实际退款十二元',
    });

    // 业务进度只能产生待确认资金事项，不能伪造任何资金记录。
    const factsBeforeManualConfirmation = application.queryFunds();
    expect(factsBeforeManualConfirmation.records).toEqual([]);
    expect(factsBeforeManualConfirmation.pendingItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'carrier_claim',
        direction: 'income',
        amountCents: 1_200,
        remainingCents: 1_200,
        sourceType: 'logistics_exception',
        sourceId: carrierClaimId,
      }),
      expect.objectContaining({
        type: 'refund',
        direction: 'expense',
        amountCents: 1_200,
        remainingCents: 1_200,
        sourceType: 'aftersales_case',
      }),
    ]));

    application.recordFinanceRecord({
      type: 'order_transaction',
      direction: 'income',
      amountCents: 10_000,
      occurredAt: '2026-08-20T15:25:00+08:00',
      note: '成交一百元参照记录',
      sourceType: 'order',
      sourceId: order.id,
    });
    application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 9_800,
      occurredAt: '2026-08-20T15:30:00+08:00',
      note: '平台结算九十八元',
      sourceType: 'order',
      sourceId: order.id,
    });
    application.recordFinanceRecord({
      type: 'initial_freight',
      direction: 'expense',
      amountCents: 800,
      occurredAt: '2026-08-20T15:35:00+08:00',
      note: '首发运费八元',
      sourceType: 'shipment_record',
      sourceId: originalShipment.record.id,
    });
    application.recordFinanceRecord({
      type: 'replacement_freight',
      direction: 'expense',
      amountCents: 800,
      occurredAt: '2026-08-20T15:40:00+08:00',
      note: '补发运费八元',
      sourceType: 'shipment_record',
      sourceId: replacementShipment.id,
    });
    application.recordFinanceRecord({
      type: 'purchase_cost',
      direction: 'expense',
      amountCents: 9_000,
      occurredAt: '2026-08-20T15:45:00+08:00',
      note: '支付采购货款九十元',
      sourceType: 'purchase_order',
      sourceId: purchase.purchaseOrderId,
    });
    application.recordFinanceRecord({
      type: 'purchase_cost',
      direction: 'income',
      amountCents: 1_000,
      occurredAt: '2026-08-20T15:50:00+08:00',
      note: '供应方退回瑕疵品货款十元',
      sourceType: 'supplier_return',
      sourceId: purchase.supplierReturnId,
    });
    const refundPending = application.queryFunds().pendingItems
      .find(({ type }) => type === 'refund')!;
    application.confirmPendingFinanceItem({
      pendingItemId: refundPending.id,
      amountCents: 700,
      occurredAt: '2026-08-20T16:00:00+08:00',
      note: '先确认七元退款支出',
    });

    const funds = application.queryFunds();
    expect(funds.records).toHaveLength(7);
    expect(funds.totals).toEqual({
      incomeCents: 20_800,
      expenseCents: 11_300,
      netCents: 9_500,
      pendingRemainingCents: 1_700,
    });
    expect(funds.typeTotals.find(({ type }) => type === 'purchase_cost'))
      .toMatchObject({ incomeCents: 1_000, expenseCents: 9_000, netCents: -8_000 });
    expect(funds.pendingItems.find(({ type }) => type === 'refund'))
      .toMatchObject({ confirmedCents: 700, remainingCents: 500 });
    expect(funds.pendingItems.find(({ type }) => type === 'carrier_claim'))
      .toMatchObject({ confirmedCents: 0, remainingCents: 1_200 });

    assertSourceTraceability(application, {
      orderId: order.id,
      originalShipmentId: originalShipment.record.id,
      replacementShipmentId: replacementShipment.id,
      purchaseOrderId: purchase.purchaseOrderId,
      supplierReturnId: purchase.supplierReturnId,
      refundCaseId: resellableReturn.id,
      carrierClaimId,
    });
    const report = application.queryProfitReport();
    assertProfitReport(report);
    assertCarrierCompensation(application, originalShipment.record.id, carrierClaimId);

    const beforeRestart = { funds, report };
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const reopened = new LocalApplication(new FinanceAcceptanceRecognizer());
    applications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    expect(reopened.queryFunds()).toEqual(beforeRestart.funds);
    expect(reopened.queryProfitReport()).toEqual(beforeRestart.report);
    assertCarrierCompensation(reopened, originalShipment.record.id, carrierClaimId);
    reopened.close();
    applications.splice(applications.indexOf(reopened), 1);

    // 使用正式备份服务生成清单并恢复到新目录，而不是直接复制内存或测试快照。
    const workspace = Workspace.open(dataDirectory);
    const backup = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, '备份库'),
      appVersion: '0.2.62',
      now: () => new Date('2026-08-20T16:10:00+08:00'),
    });
    workspace.close();
    const restoredDirectory = join(root, '恢复后的数据');
    const restoredBackup = await restoreBackup({
      backupDirectory: backup.backupDirectory,
      targetDirectory: restoredDirectory,
      currentDataDirectory: dataDirectory,
    });
    expect(restoredBackup.verification.ok).toBe(true);

    const restored = new LocalApplication(new FinanceAcceptanceRecognizer());
    applications.push(restored);
    restored.openDataDirectory(restoredDirectory);
    expect(restored.queryFunds()).toEqual(beforeRestart.funds);
    expect(restored.queryProfitReport()).toEqual(beforeRestart.report);
    assertProfitReport(restored.queryProfitReport());
    assertCarrierCompensation(restored, originalShipment.record.id, carrierClaimId);
  });
});

function createAndReceivePurchase(application: LocalApplication): {
  purchaseOrderId: string;
  supplierReturnId: string;
} {
  const supplierView = application.createSupplier({
    name: '财务闭环验收供应方',
    contact: null,
    note: null,
  });
  const supplier = supplierView.suppliers.find(({ name }) => name === '财务闭环验收供应方')!;
  const products = new Map(application.queryInventory().products.map((product) => [
    product.sku,
    product,
  ]));
  const created = application.createPurchaseOrder({
    supplierId: supplier.supplierId,
    expectedAt: '2026-08-31T00:00:00.000Z',
    reason: '财务闭环验收采购',
    items: [
      { standardProductId: products.get(PRODUCTS[0].sku)!.standardProductId, quantity: 4, unitPriceCents: 1_000 },
      { standardProductId: products.get(PRODUCTS[1].sku)!.standardProductId, quantity: 2, unitPriceCents: 1_000 },
      { standardProductId: products.get(PRODUCTS[2].sku)!.standardProductId, quantity: 3, unitPriceCents: 1_000 },
    ],
  });
  const purchaseOrder = created.orders.at(-1)!;
  const confirmed = application.confirmPurchaseOrder({
    orderId: purchaseOrder.id,
    reason: '确认财务闭环验收采购',
  }).orders.find(({ id }) => id === purchaseOrder.id)!;
  const items = new Map(confirmed.items.map((item) => [item.sku, item]));
  application.recordPurchaseArrival({
    orderId: purchaseOrder.id,
    occurredAt: '2026-08-20T13:00:00+08:00',
    reason: '财务闭环验收采购到货',
    items: [
      {
        orderItemId: items.get(PRODUCTS[0].sku)!.id,
        receivedQuantity: 4,
        resellableQuantity: 3,
        defectiveQuantity: 1,
      },
      {
        orderItemId: items.get(PRODUCTS[1].sku)!.id,
        receivedQuantity: 2,
        resellableQuantity: 2,
      },
      {
        orderItemId: items.get(PRODUCTS[2].sku)!.id,
        receivedQuantity: 3,
        resellableQuantity: 2,
        scrappedQuantity: 1,
      },
    ],
  });
  const returned = application.recordSupplierReturn({
    supplierId: supplier.supplierId,
    purchaseOrderId: purchaseOrder.id,
    occurredAt: '2026-08-20T13:10:00+08:00',
    reason: '退回采购到货瑕疵品',
    items: [{
      standardProductId: products.get(PRODUCTS[0].sku)!.standardProductId,
      quantity: 1,
      state: 'defective',
    }],
  });
  return {
    purchaseOrderId: purchaseOrder.id,
    supplierReturnId: returned.supplierReturns.at(-1)!.id,
  };
}

function confirmOriginalShipment(application: LocalApplication) {
  const group = application.queryShipmentGroups().groups[0]!;
  const order = group.orders[0]!;
  const firstProduct = order.items.find(({ sourceTitle }) => sourceTitle === PRODUCTS[0].name)!;
  const secondProduct = order.items.find(({ sourceTitle }) => sourceTitle === PRODUCTS[1].name)!;
  const thirdProduct = order.items.find(({ sourceTitle }) => sourceTitle === PRODUCTS[2].name)!;
  return application.confirmShipment({
    groupId: group.id,
    expectedRemainingItems: order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })),
    packages: [
      {
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-FINANCE-LOST',
        items: [{ orderId: order.id, orderItemId: firstProduct.id, quantity: 1 }],
      },
      {
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-FINANCE-DELIVERED',
        items: [
          { orderId: order.id, orderItemId: firstProduct.id, quantity: 1 },
          { orderId: order.id, orderItemId: secondProduct.id, quantity: 1 },
          { orderId: order.id, orderItemId: thirdProduct.id, quantity: 1 },
        ],
      },
    ],
  });
}

function inspectOneItemReturn(
  application: LocalApplication,
  input: {
    shipmentRecordId: string;
    shipmentPackageItemId: string;
    workflowTemplateId: string;
    requestedRefundCents?: number;
    result: 'resellable' | 'defective' | 'scrapped';
    sequence: number;
  },
) {
  const created = application.createAftersalesCase({
    shipmentRecordId: input.shipmentRecordId,
    workflowTemplateId: input.workflowTemplateId,
    handlingDirection: 'buyer_return',
    occurredAt: `2026-08-20T14:${50 + input.sequence}:00+08:00`,
    reason: `财务闭环验收退货检查 ${input.sequence}`,
    ...(input.requestedRefundCents === undefined
      ? {}
      : { requestedRefundCents: input.requestedRefundCents }),
    items: [{ shipmentPackageItemId: input.shipmentPackageItemId, quantity: 1 }],
  });
  const registered = application.progressAftersalesCase({
    kind: 'register_return',
    caseId: created.id,
    expectedRevision: created.revision,
    shippingCarrier: '中通快递',
    trackingNumber: `ZT-FINANCE-RETURN-${input.sequence}`,
    occurredAt: `2026-08-20T15:0${input.sequence}:00+08:00`,
    reason: `买家寄回 ${input.sequence}`,
  });
  const returnRecord = registered.returns[0]!;
  const accepted = application.progressAftersalesCase({
    kind: 'update_return_logistics_status',
    caseId: registered.id,
    expectedRevision: registered.revision,
    returnRecordId: returnRecord.id,
    logisticsStatus: 'in_transit',
    carrierAcceptanceConfirmed: true,
    occurredAt: `2026-08-20T15:0${input.sequence}:10+08:00`,
    reason: `承运方确认揽收退货 ${input.sequence}`,
  });
  const received = application.progressAftersalesCase({
    kind: 'receive_return',
    caseId: accepted.id,
    expectedRevision: accepted.revision,
    returnRecordId: returnRecord.id,
    occurredAt: `2026-08-20T15:0${input.sequence}:20+08:00`,
    reason: `卖家收到退货 ${input.sequence}`,
  });
  const receivedReturn = received.returns.find(({ id }) => id === returnRecord.id);
  const receivedReturnItem = receivedReturn?.items[0];
  if (!receivedReturnItem) throw new Error('财务闭环验收缺少已收到的退货商品');
  return application.progressAftersalesCase({
    kind: 'inspect_return',
    caseId: received.id,
    expectedRevision: received.revision,
    returnRecordId: returnRecord.id,
    occurredAt: `2026-08-20T15:0${input.sequence}:30+08:00`,
    result: input.result,
    note: `退货检查结果 ${input.result}`,
    items: [{
      returnRecordItemId: receivedReturnItem.id,
      acceptedQuantity: 1,
      result: input.result,
      note: `退货检查结果 ${input.result}`,
    }],
  });
}

function assertSourceTraceability(
  application: LocalApplication,
  sources: {
    orderId: string;
    originalShipmentId: string;
    replacementShipmentId: string;
    purchaseOrderId: string;
    supplierReturnId: string;
    refundCaseId: string;
    carrierClaimId: string;
  },
): void {
  expect(application.queryFinanceFactsForSource('order', sources.orderId).records.map(({ type }) => type))
    .toEqual(['order_transaction', 'platform_settlement']);
  expect(application.queryFinanceFactsForSource('shipment_record', sources.originalShipmentId).records)
    .toEqual([expect.objectContaining({ type: 'initial_freight', amountCents: 800 })]);
  expect(application.queryFinanceFactsForSource('shipment_record', sources.replacementShipmentId).records)
    .toEqual([expect.objectContaining({ type: 'replacement_freight', amountCents: 800 })]);
  expect(application.queryFinanceFactsForSource('purchase_order', sources.purchaseOrderId).records)
    .toEqual([expect.objectContaining({ type: 'purchase_cost', direction: 'expense' })]);
  expect(application.queryFinanceFactsForSource('supplier_return', sources.supplierReturnId).records)
    .toEqual([expect.objectContaining({ type: 'purchase_cost', direction: 'income' })]);
  const refundFacts = application.queryFinanceFactsForAftersalesCase(sources.refundCaseId);
  expect(refundFacts.pendingItems).toEqual([
    expect.objectContaining({ type: 'refund', amountCents: 1_200, remainingCents: 500 }),
  ]);
  expect(refundFacts.records).toEqual([
    expect.objectContaining({ type: 'refund', amountCents: 700 }),
  ]);
  expect(application.queryFinanceFactsForSource(
    'logistics_exception',
    sources.carrierClaimId,
  ).pendingItems).toEqual([
    expect.objectContaining({ type: 'carrier_claim', amountCents: 1_200, remainingCents: 1_200 }),
  ]);
}

function assertCarrierCompensation(
  application: LocalApplication,
  shipmentRecordId: string,
  carrierClaimId: string,
): void {
  const record = application.queryShipmentGroupArchives()
    .flatMap((archive) => archive.records)
    .find(({ id }) => id === shipmentRecordId);
  const claim = record?.packages.map(({ carrierClaim }) => carrierClaim)
    .find((candidate) => candidate?.id === carrierClaimId);
  assertPaidCarrierClaim(claim, carrierClaimId);
}

function assertPaidCarrierClaim(claim: unknown, carrierClaimId: string): void {
  expect(claim).toMatchObject({
    id: carrierClaimId,
    status: 'paid',
    requestedAmountCents: 1_200,
    approvedAmountCents: 1_200,
    actualCompensation: { amountCents: 1_000, note: '承运赔付实际到账' },
  });
}

function assertProfitReport(report: ProfitReportView): void {
  const order = report.orders.find(({ orderNumber }) => orderNumber === 'XY-FINANCE-ACCEPT-0001')!;
  expect(order).toMatchObject({
    transactionAmountCents: 10_000,
    settlementNetCents: 9_800,
    refundNetCents: -700,
    freightNetCents: -1_600,
    claimNetCents: 0,
    purchaseCostCents: 3_000,
    profitCents: 4_500,
    pendingRemainingCents: 700,
  });
  expect(order.moneyComponents.find(({ type }) => type === 'order_transaction'))
    .toMatchObject({ amountCents: 10_000, reference: true });
  expect(order.moneyComponents.filter(({ type }) => type === 'initial_freight'))
    .toEqual([expect.objectContaining({ allocatedCents: -800 })]);
  expect(order.moneyComponents.filter(({ type }) => type === 'replacement_freight'))
    .toEqual([expect.objectContaining({ allocatedCents: -800 })]);
  expect(order.moneyComponents.find(({ type, kind }) => type === 'refund' && kind === 'pending'))
    .toMatchObject({ allocatedCents: -500, remainingCents: -500 });
  expect(order.moneyComponents.find(({ type, kind }) => type === 'carrier_claim' && kind === 'pending'))
    .toMatchObject({ allocatedCents: 1_200, remainingCents: 1_200 });

  const dispatches = order.costComponents.filter(({ kind }) => kind === 'dispatch');
  expect(dispatches).toHaveLength(4);
  expect(dispatches.filter(({ sku }) => sku === PRODUCTS[0].sku).map(({ quantity }) => quantity).sort())
    .toEqual([1, 2]);
  expect(dispatches.find(({ sku, quantity }) => sku === PRODUCTS[0].sku && quantity === 1)?.sourceLabel)
    .toContain('补发');
  expect(dispatches).toEqual(expect.arrayContaining([
    expect.objectContaining({ sku: PRODUCTS[1].sku, quantity: 1, amountCents: 1_000 }),
    expect.objectContaining({ sku: PRODUCTS[2].sku, quantity: 1, amountCents: 1_000 }),
  ]));
  const recoveries = order.costComponents.filter(({ kind }) => kind === 'recovery');
  expect(recoveries).toEqual([
    expect.objectContaining({ sku: PRODUCTS[0].sku, quantity: 1, amountCents: -1_000 }),
  ]);
  expect(recoveries.every(({ sourceLabel }) => sourceLabel.includes('退货检查'))).toBe(true);
  expect(order.costComponents.find(({ kind, sku }) => (
    kind === 'scrap' && sku === PRODUCTS[2].sku
  ))).toMatchObject({
    quantity: 1,
    amountCents: -1_000,
    sourceLabel: expect.stringContaining('退货检查报废'),
  });

  const products = new Map(report.products.map((product) => [product.sku, product]));
  expect(products.get(PRODUCTS[0].sku)).toMatchObject({
    avgUnitCostCents: 1_000,
    arrivedQuantity: 4,
    supplierReturnedQuantity: 1,
    dispatchedQuantity: 2,
    dispatchedCostCents: 2_000,
    returnReceivedQuantity: 1,
  });
  expect(products.get(PRODUCTS[0].sku)?.traceComponents.map(({ kind }) => kind).sort())
    .toEqual(['arrival', 'return_receipt', 'supplier_return']);
  expect(products.get(PRODUCTS[1].sku)).toMatchObject({
    avgUnitCostCents: 1_000,
    arrivedQuantity: 2,
    dispatchedQuantity: 1,
    dispatchedCostCents: 1_000,
    returnReceivedQuantity: 1,
  });
  expect(products.get(PRODUCTS[1].sku)?.traceComponents.map(({ kind }) => kind).sort())
    .toEqual(['arrival', 'return_receipt']);
  expect(products.get(PRODUCTS[2].sku)).toMatchObject({
    avgUnitCostCents: 1_000,
    arrivedQuantity: 3,
    dispatchedQuantity: 0,
    dispatchedCostCents: 0,
    scrapQuantity: 2,
    scrapCostCents: 2_000,
    returnReceivedQuantity: 1,
  });
  expect(products.get(PRODUCTS[2].sku)?.traceComponents.map(({ kind }) => kind).sort())
    .toEqual(['arrival', 'return_receipt']);
  expect(products.get(PRODUCTS[2].sku)?.costComponents.filter(({ kind, amountCents }) => (
    kind === 'scrap' && amountCents > 0
  )))
    .toEqual([
      expect.objectContaining({ quantity: 1, amountCents: 1_000 }),
      expect.objectContaining({ quantity: 1, amountCents: 1_000 }),
    ]);
  expect(report.products.reduce((total, product) => total + product.marginCents, 0))
    .toBe(report.totals.profitCents - report.totals.scrapCostCents);
  expect(report.totals).toMatchObject({
    transactionCents: 10_000,
    profitCents: 4_500,
    pendingRemainingCents: 700,
    scrapCostCents: 2_000,
    purchasePaymentNetCents: -8_000,
    othersNetCents: -8_000,
  });
}
