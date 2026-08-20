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
import type { LocalApplication } from '../src/main/local-application';
import { LocalApplication as LocalApplicationClass } from '../src/main/local-application';

const applications: LocalApplication[] = [];

class OneOrderRecognizer implements Recognizer {
  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result: RecognitionResult = {
      platform: 'xianyu',
      sellerAccount: '资金接入测试账号',
      orderNumber: 'XY-FUNDS-INTEGRATION-0001',
      alipayTransactionNumber: 'ALI-FUNDS-INTEGRATION-0001',
      buyerNickname: '资金接入买家',
      recipient: '荆接入',
      phone: '13800000005',
      phoneNormalized: '13800000005',
      addressOriginal: '浙江省杭州市西湖区接入路5号',
      addressNormalized: '浙江省杭州市西湖区接入路5号',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      orderedAtOriginal: '2026-08-20 10:00:00',
      orderedAtNormalized: '2026-08-20T10:00:00+08:00',
      paidAtOriginal: '2026-08-20 10:00:08',
      paidAtNormalized: '2026-08-20T10:00:08+08:00',
      productTotalCents: 2_000,
      shippingFeeCents: 0,
      amountCents: 2_000,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: '资金接入商品',
        sourceSpec: '白色',
        unitPriceCents: 1_000,
        quantity: 2,
        quantityInferred: false,
      }],
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

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
  vi.useRealTimers();
});

async function openShippedApplication(deliver = true): Promise<{
  application: LocalApplication;
  dataDirectory: string;
  orderId: string;
  shipmentRecordId: string;
  shipmentPackageId: string;
  shipmentPackageItemId: string;
  shipmentPackageRevision: number;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-funds-integration-'));
  const dataDirectory = join(root, '数据');
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const sourcePath = join(sourceDirectory, '订单.png');
  await writeFile(sourcePath, Buffer.from('funds-integration-order'));
  const application = new LocalApplicationClass(new OneOrderRecognizer());
  applications.push(application);
  application.openDataDirectory(dataDirectory);
  const batch = await application.submitRecognitionBatch([sourcePath]);
  const order = application.confirmDraft(batch.drafts[0]);
  const group = application.queryShipmentGroups().groups[0]!;
  const items = group.orders.flatMap((groupOrder) => groupOrder.items.map((item) => ({
    orderId: groupOrder.id,
    orderItemId: item.id,
    quantity: item.quantity,
  })));
  const shipment = application.confirmShipment({
    groupId: group.id,
    expectedRemainingItems: items,
    packages: [{
      shippingCarrier: '顺丰速运',
      trackingNumber: 'SF-FUNDS-INTEGRATION-0001',
      items,
    }],
  });
  let record = shipment.record;
  if (deliver) {
    record = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipment.record.packages[0]!.id,
      expectedRevision: shipment.record.packages[0]!.revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-20T14:10:00+08:00',
      reason: '资金接入前置：买家已签收',
    }).record;
  }
  const shipmentPackage = record.packages[0]!;
  return {
    application,
    dataDirectory,
    orderId: order.id,
    shipmentRecordId: record.id,
    shipmentPackageId: shipmentPackage.id,
    shipmentPackageItemId: shipmentPackage.items[0]!.id,
    shipmentPackageRevision: shipmentPackage.revision,
  };
}

describe('业务资金接入', () => {
  it('售后实际退款与承运索赔同意自动立待确认事项，确认赔付到账不生成资金记录', async () => {
    const { application, orderId, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const returnRefund = templates.find(({ scenario }) => scenario === 'return_refund');
    if (!returnRefund) throw new Error('缺少退货退款预置流程');

    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: returnRefund.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-20T14:20:00+08:00',
      reason: '资金接入：退货退款',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-FUNDS-INTEGRATION-0001',
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
    const withLoss = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-20T14:40:00+08:00',
      reason: '承运方确认退货包裹丢失',
    });
    const withClaim = application.progressAftersalesCase({
      kind: 'open_carrier_claim',
      caseId: withLoss.id,
      expectedRevision: withLoss.revision,
      returnRecordId,
      requestedAmountCents: 200,
      occurredAt: '2026-08-20T14:45:00+08:00',
      reason: '申请承运赔付',
    });
    const approved = application.progressAftersalesCase({
      kind: 'resolve_carrier_claim',
      caseId: withClaim.id,
      expectedRevision: withClaim.revision,
      returnRecordId,
      expectedClaimRevision: 1,
      outcome: 'approved',
      approvedAmountCents: 200,
      occurredAt: '2026-08-20T14:50:00+08:00',
      reason: '承运方同意赔付',
    });

    let view = application.queryFunds();
    const claimPending = view.pendingItems.find(({ type }) => type === 'carrier_claim');
    expect(claimPending).toMatchObject({
      direction: 'income',
      amountCents: 200,
      sourceType: 'logistics_exception',
      status: 'pending',
    });
    expect(view.records).toEqual([]);

    application.progressAftersalesCase({
      kind: 'confirm_carrier_compensation',
      caseId: approved.id,
      expectedRevision: approved.revision,
      returnRecordId,
      expectedClaimRevision: 2,
      amountCents: 200,
      occurredAt: '2026-08-20T14:55:00+08:00',
      note: '承运方赔付到账',
    });
    view = application.queryFunds();
    expect(view.records).toEqual([]);
    expect(view.pendingItems.find(({ type }) => type === 'carrier_claim'))
      .toMatchObject({ remainingCents: 200, status: 'pending' });

    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: approved.id,
      expectedRevision: approved.revision,
      actualRefundCents: 400,
      occurredAt: '2026-08-20T15:00:00+08:00',
      note: '平台先退 4 元',
    });
    application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: partial.id,
      expectedRevision: partial.revision,
      actualRefundCents: 600,
      occurredAt: '2026-08-20T15:05:00+08:00',
      note: '补退剩余 6 元',
    });

    view = application.queryFunds();
    expect(view.records).toEqual([]);
    const refundPendings = view.pendingItems.filter(({ type }) => type === 'refund');
    expect(refundPendings).toHaveLength(2);
    expect(refundPendings.map(({ amountCents }) => amountCents).sort((a, b) => a - b))
      .toEqual([400, 600]);
    for (const item of refundPendings) {
      expect(item.sourceType).toBe('aftersales_case');
      expect(item.sourceId).not.toBe(created.id);
      expect(item.direction).toBe('expense');
      expect(item.status).toBe('pending');
    }
    expect(view.totals.pendingRemainingCents).toBe(1_200);

    // 带来源的手工资金记录：拦截费用挂售后处理单、平台结算挂订单。
    view = application.recordFinanceRecord({
      type: 'interception_fee',
      direction: 'expense',
      amountCents: 100,
      occurredAt: '2026-08-20T15:10:00+08:00',
      note: '拦截退回运费',
      sourceType: 'aftersales_case',
      sourceId: created.id,
    });
    expect(view.records).toHaveLength(1);
    expect(view.records[0]).toMatchObject({
      type: 'interception_fee',
      sourceType: 'aftersales_case',
      sourceId: created.id,
    });
    view = application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 2_000,
      occurredAt: '2026-08-20T15:15:00+08:00',
      note: '平台结算到账',
      sourceType: 'order',
      sourceId: orderId,
    });
    expect(view.totals).toMatchObject({
      incomeCents: 2_000,
      expenseCents: 100,
      netCents: 1_900,
      pendingRemainingCents: 1_200,
    });

    const caseFacts = application.queryFinanceFactsForAftersalesCase(created.id);
    expect(caseFacts.pendingItems).toHaveLength(3);
    expect(caseFacts.pendingItems.map(({ type }) => type).sort())
      .toEqual(['carrier_claim', 'refund', 'refund']);
    expect(caseFacts.records.map(({ type }) => type)).toEqual(['interception_fee']);

    const orderFacts = application.queryFinanceFactsForSource('order', orderId);
    expect(orderFacts.pendingItems).toEqual([]);
    expect(orderFacts.records.map(({ type }) => type)).toEqual(['platform_settlement']);
  });

  it('拒赔不立账，第二张售后单的拒赔路径不产生丢件赔付事项', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const returnRefund = templates.find(({ scenario }) => scenario === 'return_refund');
    if (!returnRefund) throw new Error('缺少退货退款预置流程');

    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: returnRefund.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-20T14:20:00+08:00',
      reason: '资金接入：拒赔路径',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-FUNDS-INTEGRATION-0002',
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
    const withLoss = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-20T14:40:00+08:00',
      reason: '承运方确认退货包裹丢失',
    });
    const withClaim = application.progressAftersalesCase({
      kind: 'open_carrier_claim',
      caseId: withLoss.id,
      expectedRevision: withLoss.revision,
      returnRecordId,
      requestedAmountCents: 300,
      occurredAt: '2026-08-20T14:45:00+08:00',
      reason: '申请承运赔付',
    });
    application.progressAftersalesCase({
      kind: 'resolve_carrier_claim',
      caseId: withClaim.id,
      expectedRevision: withClaim.revision,
      returnRecordId,
      expectedClaimRevision: 1,
      outcome: 'rejected',
      occurredAt: '2026-08-20T14:50:00+08:00',
      reason: '承运方拒赔',
    });
    const view = application.queryFunds();
    expect(view.pendingItems.filter(({ type }) => type === 'carrier_claim')).toEqual([]);
    expect(view.pendingItems).toEqual([]);
  });

  it('正向丢件索赔同意后的待确认事项与首发运费在发货记录资金聚合并可见', async () => {
    const {
      application,
      shipmentRecordId,
      shipmentPackageId,
      shipmentPackageItemId,
      shipmentPackageRevision,
    } = await openShippedApplication(false);
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipmentRecordId,
      packageId: shipmentPackageId,
      expectedRevision: shipmentPackageRevision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-20T14:15:00+08:00',
      reason: '承运方已确认揽收',
    });
    const lost = application.recordShipmentPackageLogisticsException({
      recordId: shipmentRecordId,
      packageId: shipmentPackageId,
      expectedRevision: accepted.record.packages[0]!.revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: shipmentPackageItemId, quantity: 1 }],
      },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-20T14:20:00+08:00',
      reason: '承运方确认正向包裹丢件',
    });
    const opened = application.progressShipmentPackageCarrierClaim({
      kind: 'open',
      recordId: shipmentRecordId,
      packageId: shipmentPackageId,
      expectedRevision: lost.record.packages[0]!.revision,
      requestedAmountCents: 1_200,
      occurredAt: '2026-08-20T14:25:00+08:00',
      reason: '申请正向丢件赔付',
    });
    application.progressShipmentPackageCarrierClaim({
      kind: 'resolve',
      recordId: shipmentRecordId,
      packageId: shipmentPackageId,
      expectedClaimRevision: 1,
      outcome: 'approved',
      approvedAmountCents: 1_200,
      occurredAt: '2026-08-20T14:30:00+08:00',
      reason: '承运方同意赔付',
    });
    void opened;

    application.recordFinanceRecord({
      type: 'initial_freight',
      direction: 'expense',
      amountCents: 800,
      occurredAt: '2026-08-20T14:35:00+08:00',
      note: '首发顺丰运费',
      sourceType: 'shipment_record',
      sourceId: shipmentRecordId,
    });

    const facts = application.queryFinanceFactsForShipmentRecord(shipmentRecordId);
    expect(facts.pendingItems).toHaveLength(1);
    expect(facts.pendingItems[0]).toMatchObject({
      type: 'carrier_claim',
      direction: 'income',
      amountCents: 1_200,
      status: 'pending',
    });
    expect(facts.records.map(({ type }) => type)).toEqual(['initial_freight']);
    expect(facts.records[0]).toMatchObject({
      sourceType: 'shipment_record',
      sourceId: shipmentRecordId,
    });
  });

  it('采购付款与供应方退款分别关联采购订单与退货，供应方退款走采购成本收入方向', async () => {
    const { application } = await openShippedApplication();
    const product = application.createStandardProduct({
      name: '资金接入采购商品',
      specification: '标准款',
      sku: 'SKU-FUNDS-PO-1',
      defaultOrderPriceCents: 1_000,
      priceChangeReason: '首次定价',
    });
    const purchases = application.createSupplier({
      name: '资金接入供应方',
      contact: null,
      note: null,
    });
    const supplier = purchases.suppliers.find(({ name }) => name === '资金接入供应方')!;
    const created = application.createPurchaseOrder({
      supplierId: supplier.supplierId,
      expectedAt: '2026-12-31T00:00:00.000Z',
      reason: '资金接入采购',
      items: [{ standardProductId: product.id, quantity: 2, unitPriceCents: 2_500 }],
    });
    const purchaseOrder = created.orders.at(-1)!;
    const confirmed = application.confirmPurchaseOrder({
      orderId: purchaseOrder.id,
      reason: '确认采购',
    });
    const confirmedOrder = confirmed.orders.find(({ id }) => id === purchaseOrder.id)!;
    const orderItem = confirmedOrder.items[0]!;
    application.recordPurchaseArrival({
      orderId: purchaseOrder.id,
      occurredAt: '2026-08-20T14:30:00+08:00',
      reason: '到货入库',
      items: [{
        orderItemId: orderItem.id,
        receivedQuantity: 1,
        defectiveQuantity: 1,
      }],
    });
    const returned = application.recordSupplierReturn({
      supplierId: supplier.supplierId,
      purchaseOrderId: purchaseOrder.id,
      reason: '瑕疵品退回供应方',
      occurredAt: '2026-08-20T14:40:00+08:00',
      items: [{ standardProductId: product.id, quantity: 1, state: 'defective' }],
    });
    const supplierReturn = returned.supplierReturns.at(-1)!;

    let view = application.recordFinanceRecord({
      type: 'purchase_cost',
      direction: 'expense',
      amountCents: 5_000,
      occurredAt: '2026-08-20T14:50:00+08:00',
      note: '支付采购全款',
      sourceType: 'purchase_order',
      sourceId: purchaseOrder.id,
    });
    view = application.recordFinanceRecord({
      type: 'purchase_cost',
      direction: 'income',
      amountCents: 2_500,
      occurredAt: '2026-08-20T15:00:00+08:00',
      note: '供应方退回瑕疵品货款',
      sourceType: 'supplier_return',
      sourceId: supplierReturn.id,
    });
    expect(view.records).toHaveLength(2);
    expect(view.typeTotals.find(({ type }) => type === 'purchase_cost'))
      .toMatchObject({ incomeCents: 2_500, expenseCents: 5_000, netCents: -2_500 });

    expect(() => application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'expense',
      amountCents: 100,
      occurredAt: '2026-08-20T15:05:00+08:00',
      note: '方向错误的结算',
    })).toThrow('平台实际结算收入的收支方向只能是收入');
    expect(() => application.recordFinanceRecord({
      type: 'replacement_freight',
      direction: 'expense',
      amountCents: 100,
      occurredAt: '2026-08-20T15:06:00+08:00',
      note: '来源不存在',
      sourceType: 'shipment_record',
      sourceId: '不存在的发货记录',
    })).toThrow('来源记录不存在');

    const orderFacts = application.queryFinanceFactsForSource('purchase_order', purchaseOrder.id);
    expect(orderFacts.records.map(({ note }) => note)).toEqual(['支付采购全款']);
    const returnFacts = application.queryFinanceFactsForSource('supplier_return', supplierReturn.id);
    expect(returnFacts.records.map(({ note }) => note)).toEqual(['供应方退回瑕疵品货款']);
  });

  it('钩子立账与手工记录重启后完整保留', async () => {
    const { application, dataDirectory, orderId } = await openShippedApplication();
    application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 1_800,
      occurredAt: '2026-08-20T15:10:00+08:00',
      note: '重启前结算',
      sourceType: 'order',
      sourceId: orderId,
    });
    const before = application.queryFunds();
    expect(before.records).toHaveLength(1);
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const reopened = new LocalApplicationClass(new OneOrderRecognizer());
    applications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    expect(reopened.queryFunds()).toEqual(before);
  });
});
