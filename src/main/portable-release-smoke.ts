import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ControlledRecognizer } from '../adapters/recognition/controlled-recognizer';
import type {
  RecognitionBatchItem,
  RecognitionResult,
} from '../core/contracts';
import { DesktopSession } from './desktop-session';
import { OcrSettingsService } from './ocr-settings';
import { Preferences } from './preferences';

export const PORTABLE_SMOKE_ORDER_NUMBER = 'PORTABLE-SMOKE-ORDER-001';

const PORTABLE_SMOKE_SHIPPING_CARRIER = '便携验收快递';
const PORTABLE_SMOKE_TRACKING_NUMBER = 'PORTABLE-SMOKE-TRACKING-001';
const PORTABLE_SMOKE_LOGISTICS_REASON = '便携版验收确认买家已签收';
const PORTABLE_SMOKE_AFTERSALES_REASON = '便携版验收登记部分退款';
const PORTABLE_SMOKE_REFUND_NOTE = '便携版验收确认实际退款';
const PORTABLE_SMOKE_REQUESTED_REFUND_CENTS = 400;
const PORTABLE_SMOKE_ACTUAL_REFUND_CENTS = 400;
const PORTABLE_SMOKE_PLAN_NAME = '便携验收预售';
const PORTABLE_SMOKE_PLAN_CREATE_REASON = '便携版验收建立预售';
const PORTABLE_SMOKE_PLAN_JOIN_REASON = '便携版验收加入预售';
const PORTABLE_SMOKE_PLAN_RELEASE_REASON = '便携版验收备货释放';
const PORTABLE_SMOKE_SUPPLIER_NAME = '便携验收供应方';
const PORTABLE_SMOKE_PRODUCT_NAME = '便携验收采购商品';
const PORTABLE_SMOKE_PRODUCT_SKU = 'PORTABLE-SMOKE-SKU-001';
const PORTABLE_SMOKE_PURCHASE_REASON = '便携版验收采购到货';
const PORTABLE_SMOKE_PURCHASE_ARRIVAL_REASON = '便携版验收到货入库';
const PORTABLE_SMOKE_CONFIRM_REFUND_NOTE = '便携版验收确认退款到账';
const PORTABLE_SMOKE_SETTLEMENT_CENTS = 360;
const PORTABLE_SMOKE_SETTLEMENT_NOTE = '便携版验收平台结算到账';

export type PortableReleaseSmokeInput = {
  phase: 'write' | 'read';
  configDirectory: string;
  dataDirectory: string;
};

export type PortableReleaseSmokeResult = {
  phase: PortableReleaseSmokeInput['phase'];
  dataDirectory: string;
  orderNumber: typeof PORTABLE_SMOKE_ORDER_NUMBER;
  orderCount: number;
  shipmentRecordCount: number;
  shipmentTimelineEventCount: number;
  aftersalesCaseCount: number;
  aftersalesTimelineEventCount: number;
  fulfillmentPlanCount: number;
  fulfillmentPlanEventCount: number;
  fulfillmentPlanReleasedOrderCount: number;
  purchaseOrderCount: number;
  purchaseArrivalItemCount: number;
  inventorySellableQuantity: number;
  inventoryMovementCount: number;
  financePendingItemCount: number;
  financeRecordCount: number;
  profitOrderCount: number;
  profitTotalProfitCents: number;
};

export async function runPortableReleaseDataSmoke(
  input: PortableReleaseSmokeInput,
): Promise<PortableReleaseSmokeResult> {
  const configDirectory = requiredAbsolutePath(input.configDirectory, '启动配置目录');
  const dataDirectory = requiredAbsolutePath(input.dataDirectory, '订单数据目录');
  if (configDirectory === dataDirectory) {
    throw new Error('便携版冒烟要求启动配置目录与订单数据目录相互独立');
  }

  const recognizer = new ControlledRecognizer(PORTABLE_SMOKE_RECOGNITION);
  const session = new DesktopSession(
    new Preferences(configDirectory),
    recognizer,
    createSmokeOcrSettings(),
  );

  try {
    if (input.phase === 'write') {
      await importPortableSmokeOrder(session, configDirectory, dataDirectory);
      await session.waitForCurrentRecognitionWork();
      createPortableSmokeFulfillmentHistory(session);
      createPortableSmokeOperationsHistory(session);
      createPortableSmokeInventoryHistory(session);
      createPortableSmokeFundsHistory(session);
    } else {
      const restored = session.restore();
      if (restored.kind !== 'ready' || resolve(restored.dataDirectory) !== dataDirectory) {
        throw new Error('便携版重启后未能自动打开原订单数据目录');
      }
    }

    const orders = session.listOrders();
    const smokeOrder = orders.find((order) => (
      order.orderNumber === PORTABLE_SMOKE_ORDER_NUMBER
    ));
    if (!smokeOrder) throw new Error('未找到便携版冒烟订单');
    if (smokeOrder.recipient !== '便携验收收件人' || smokeOrder.itemCount !== 1) {
      throw new Error('便携版冒烟订单内容不完整');
    }
    const details = session.getOrder(smokeOrder.id);
    if (
      details.order.items.length !== 1 ||
      details.order.items[0]?.sourceTitle !== '便携版验收商品' ||
      details.order.amountCents !== 800
    ) {
      throw new Error('便携版冒烟订单详情不完整');
    }
    const screenshotDataUrl = await session.getScreenshotDataUrl(
      details.sourceScreenshot.id,
    );
    if (!screenshotDataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('便携版重启后无法读取来源截图');
    }

    const shipmentRecords = session.queryShipmentGroupArchives()
      .flatMap((archive) => archive.records);
    if (shipmentRecords.length !== 1) {
      throw new Error('便携版重启后发货记录不完整');
    }
    const shipmentPackage = shipmentRecords[0]?.packages[0];
    if (
      !shipmentPackage ||
      shipmentRecords[0]?.sourceOrders.length !== 1 ||
      shipmentRecords[0]?.sourceOrders[0]?.orderId !== details.order.id ||
      shipmentRecords[0]?.sourceOrders[0]?.orderNumber !== PORTABLE_SMOKE_ORDER_NUMBER ||
      shipmentPackage.shippingCarrier !== PORTABLE_SMOKE_SHIPPING_CARRIER ||
      shipmentPackage.trackingNumber !== PORTABLE_SMOKE_TRACKING_NUMBER ||
      shipmentPackage.logisticsStatus !== 'delivered' ||
      shipmentPackage.items.length !== 1 ||
      shipmentPackage.items[0]?.orderId !== details.order.id ||
      shipmentPackage.items[0]?.orderItemId !== details.order.items[0]?.id ||
      shipmentPackage.items[0]?.quantity !== 1 ||
      shipmentPackage.timeline.length !== 1 ||
      shipmentPackage.timeline[0]?.kind !== 'status_changed' ||
      shipmentPackage.timeline[0]?.beforeStatus !== 'in_transit' ||
      shipmentPackage.timeline[0]?.afterStatus !== 'delivered' ||
      shipmentPackage.timeline[0]?.reason !== PORTABLE_SMOKE_LOGISTICS_REASON ||
      shipmentPackage.timeline[0]?.carrierAcceptedAt !== shipmentPackage.timeline[0]?.occurredAt
    ) {
      throw new Error('便携版重启后物流时间线不完整');
    }
    assertOccurredNotAfterCreated(
      shipmentPackage.timeline[0].occurredAt,
      shipmentPackage.timeline[0].createdAt,
      '物流状态',
    );

    const aftersalesCases = session.queryAftersalesCases({
      shipmentRecordId: shipmentRecords[0]?.id,
    });
    const aftersalesCase = aftersalesCases[0];
    if (
      aftersalesCases.length !== 1 ||
      !aftersalesCase ||
      aftersalesCase.shipmentRecordId !== shipmentRecords[0]?.id ||
      aftersalesCase.workflow !== 'refund_only' ||
      aftersalesCase.workflowTemplate.templateId !== 'system-aftersales-refund-only' ||
      aftersalesCase.status !== 'ready_to_complete' ||
      aftersalesCase.reason !== PORTABLE_SMOKE_AFTERSALES_REASON ||
      aftersalesCase.items.length !== 1 ||
      aftersalesCase.items[0]?.shipmentPackageItemId !== shipmentPackage.items[0]?.id ||
      aftersalesCase.items[0]?.quantity !== 1 ||
      aftersalesCase.refund?.status !== 'confirmed' ||
      aftersalesCase.refund.requestedAmountCents !== PORTABLE_SMOKE_REQUESTED_REFUND_CENTS ||
      aftersalesCase.refund.refundRecords.length !== 1 ||
      aftersalesCase.refund.refundRecords[0]?.amountCents !== PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      aftersalesCase.refund.refundRecords[0]?.note !== PORTABLE_SMOKE_REFUND_NOTE ||
      aftersalesCase.refund.fulfillment.kind !== 'complete' ||
      aftersalesCase.refund.timeline.length !== 2 ||
      aftersalesCase.refund.timeline[0]?.kind !== 'created' ||
      aftersalesCase.refund.timeline[0]?.requestedAmountCents !==
        PORTABLE_SMOKE_REQUESTED_REFUND_CENTS ||
      aftersalesCase.refund.timeline[1]?.kind !== 'confirmed' ||
      aftersalesCase.refund.timeline[1]?.actualAmountCents !==
        PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      aftersalesCase.timeline.length !== 2 ||
      aftersalesCase.timeline[0]?.kind !== 'created' ||
      aftersalesCase.timeline[0]?.reason !== PORTABLE_SMOKE_AFTERSALES_REASON ||
      aftersalesCase.timeline[1]?.kind !== 'updated' ||
      aftersalesCase.timeline[1]?.changeReason !==
        `确认实际退款：${PORTABLE_SMOKE_REFUND_NOTE}`
    ) {
      throw new Error('便携版重启后售后与退款历史不完整');
    }
    assertOccurredNotAfterCreated(
      aftersalesCase.timeline[0].occurredAt,
      aftersalesCase.timeline[0].createdAt,
      '售后建立',
    );
    for (const event of aftersalesCase.refund.timeline) {
      assertOccurredNotAfterCreated(event.occurredAt, event.createdAt, '退款时间线');
    }
    assertOccurredNotAfterCreated(
      aftersalesCase.refund.refundRecords[0].occurredAt,
      aftersalesCase.refund.refundRecords[0].createdAt,
      '实际退款',
    );

    const plans = session.queryFulfillmentPlans();
    const smokePlan = plans.find(({ name }) => name === PORTABLE_SMOKE_PLAN_NAME);
    if (
      plans.length !== 1 ||
      !smokePlan ||
      smokePlan.events.map(({ eventType }) => eventType).join(',') !== 'created,orders_added,orders_released' ||
      smokePlan.releasedOrderCount !== 1 ||
      smokePlan.members[0]?.releasedReason !== PORTABLE_SMOKE_PLAN_RELEASE_REASON ||
      smokePlan.events.find(({ eventType }) => eventType === 'orders_released')?.reason
        !== PORTABLE_SMOKE_PLAN_RELEASE_REASON
    ) {
      throw new Error('便携版重启后履约计划历史不完整');
    }
    const planDemand = session.queryFulfillmentDemand(smokePlan.id);
    if (
      planDemand.conditional ||
      planDemand.totals.demandQuantity !== 0 ||
      planDemand.unmapped.length !== 0
    ) {
      throw new Error('便携版重启后履约需求视图不完整');
    }

    const purchases = session.queryPurchases();
    const smokeSupplier = purchases.suppliers.find(({ name }) => (
      name === PORTABLE_SMOKE_SUPPLIER_NAME
    ));
    const smokePurchaseOrder = purchases.orders.find(({ supplierName, items }) => (
      supplierName === PORTABLE_SMOKE_SUPPLIER_NAME
        && items.length === 1
        && items[0]?.name === PORTABLE_SMOKE_PRODUCT_NAME
    ));
    if (
      !smokeSupplier ||
      !smokePurchaseOrder ||
      smokePurchaseOrder.status !== 'confirmed' ||
      smokePurchaseOrder.items[0]?.quantity !== 1 ||
      smokePurchaseOrder.items[0]?.receivedQuantity !== 1 ||
      smokePurchaseOrder.arrivals.length !== 1 ||
      smokePurchaseOrder.arrivals[0]?.items[0]?.resellableQuantity !== 1
    ) {
      throw new Error('便携版重启后采购与到货历史不完整');
    }

    const inventory = session.queryInventory();
    const smokeInventoryProduct = inventory.products.find(({ sku }) => (
      sku === PORTABLE_SMOKE_PRODUCT_SKU
    ));
    if (
      !smokeInventoryProduct ||
      smokeInventoryProduct.sellableQuantity !== 1 ||
      smokeInventoryProduct.awaitingInspectionQuantity !== 0 ||
      smokeInventoryProduct.reservedQuantity !== 0
    ) {
      throw new Error('便携版重启后库存数量不完整');
    }
    if (
      inventory.movements.length !== 1 ||
      inventory.movements[0]?.sourceType !== 'purchase_arrival' ||
      inventory.movements[0]?.sourceId !== smokePurchaseOrder.arrivals[0]?.id ||
      inventory.movements[0]?.direction !== 'in' ||
      inventory.movements[0]?.quantity !== 1
    ) {
      throw new Error('便携版重启后库存流水不完整');
    }

    const funds = session.queryFunds();
    const smokePendingItem = funds.pendingItems.find(({ type }) => type === 'refund');
    if (
      !smokePendingItem ||
      smokePendingItem.status !== 'pending' ||
      smokePendingItem.amountCents !== PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      smokePendingItem.confirmedCents !== PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      smokePendingItem.remainingCents !== 0 ||
      smokePendingItem.sourceType !== 'aftersales_case' ||
      !smokePendingItem.sourceId ||
      smokePendingItem.sourceId === aftersalesCase.id
    ) {
      throw new Error('便携版重启后待确认资金事项不完整');
    }
    if (
      funds.records.length !== 3 ||
      funds.records[0]?.type !== 'refund' ||
      funds.records[0]?.direction !== 'expense' ||
      funds.records[0]?.amountCents !== 150 ||
      funds.records[0]?.pendingItemId !== smokePendingItem.id ||
      funds.records[1]?.type !== 'refund' ||
      funds.records[1]?.direction !== 'expense' ||
      funds.records[1]?.amountCents !== PORTABLE_SMOKE_ACTUAL_REFUND_CENTS - 150 ||
      funds.records[1]?.pendingItemId !== smokePendingItem.id ||
      funds.records[2]?.type !== 'platform_settlement' ||
      funds.records[2]?.direction !== 'income' ||
      funds.records[2]?.amountCents !== PORTABLE_SMOKE_SETTLEMENT_CENTS ||
      funds.records[2]?.note !== PORTABLE_SMOKE_SETTLEMENT_NOTE
    ) {
      throw new Error('便携版重启后资金记录不完整');
    }
    if (
      funds.totals.incomeCents !== PORTABLE_SMOKE_SETTLEMENT_CENTS ||
      funds.totals.expenseCents !== PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      funds.totals.netCents !== PORTABLE_SMOKE_SETTLEMENT_CENTS - PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      funds.totals.pendingRemainingCents !== 0
    ) {
      throw new Error('便携版重启后资金汇总不完整');
    }

    const profit = session.queryProfitReport();
    const smokeProfitOrder = profit.orders.find(({ orderNumber }) => (
      orderNumber === PORTABLE_SMOKE_ORDER_NUMBER
    ));
    if (
      profit.orders.length !== 1 ||
      !smokeProfitOrder ||
      smokeProfitOrder.transactionAmountCents !== 800 ||
      smokeProfitOrder.settlementNetCents !== PORTABLE_SMOKE_SETTLEMENT_CENTS ||
      smokeProfitOrder.refundNetCents !== -PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      smokeProfitOrder.purchaseCostCents !== 0 ||
      smokeProfitOrder.profitCents
        !== PORTABLE_SMOKE_SETTLEMENT_CENTS - PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      smokeProfitOrder.pendingRemainingCents !== 0 ||
      profit.unmapped.allocatedNetCents
        !== PORTABLE_SMOKE_SETTLEMENT_CENTS - PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      profit.totals.profitCents
        !== PORTABLE_SMOKE_SETTLEMENT_CENTS - PORTABLE_SMOKE_ACTUAL_REFUND_CENTS ||
      profit.totals.pendingRemainingCents !== 0
    ) {
      throw new Error('便携版重启后利润视图不完整');
    }

    return {
      phase: input.phase,
      dataDirectory,
      orderNumber: PORTABLE_SMOKE_ORDER_NUMBER,
      orderCount: orders.length,
      shipmentRecordCount: shipmentRecords.length,
      shipmentTimelineEventCount: shipmentPackage.timeline.length,
      aftersalesCaseCount: aftersalesCases.length,
      aftersalesTimelineEventCount: aftersalesCase.timeline.length,
      fulfillmentPlanCount: plans.length,
      fulfillmentPlanEventCount: smokePlan.events.length,
      fulfillmentPlanReleasedOrderCount: smokePlan.releasedOrderCount,
      purchaseOrderCount: purchases.orders.length,
      purchaseArrivalItemCount: smokePurchaseOrder.arrivals[0]?.items.length ?? 0,
      inventorySellableQuantity: smokeInventoryProduct?.sellableQuantity ?? 0,
      inventoryMovementCount: inventory.movements.length,
      financePendingItemCount: funds.pendingItems.length,
      financeRecordCount: funds.records.length,
      profitOrderCount: profit.orders.length,
      profitTotalProfitCents: profit.totals.profitCents,
    };
  } finally {
    session.close();
  }
}

// 便携版验收的库存与采购腿：标准商品 → 供应方 → 采购订单 → 确认 → 到货入库，
// 重启后数量与流水必须原样读回。
function createPortableSmokeInventoryHistory(session: DesktopSession): void {
  const product = session.createStandardProduct({
    name: PORTABLE_SMOKE_PRODUCT_NAME,
    specification: '标准款',
    sku: PORTABLE_SMOKE_PRODUCT_SKU,
    defaultOrderPriceCents: 800,
    priceChangeReason: '首次定价',
  });
  const purchases = session.createSupplier({
    name: PORTABLE_SMOKE_SUPPLIER_NAME,
    contact: null,
    note: null,
  });
  const supplier = purchases.suppliers.find(({ name }) => name === PORTABLE_SMOKE_SUPPLIER_NAME);
  if (!supplier) throw new Error('便携版冒烟缺少供应方');
  const created = session.createPurchaseOrder({
    supplierId: supplier.supplierId,
    expectedAt: '2026-12-31T00:00:00.000Z',
    reason: PORTABLE_SMOKE_PURCHASE_REASON,
    items: [{
      standardProductId: product.id,
      quantity: 1,
      unitPriceCents: 500,
    }],
  });
  const order = created.orders.at(-1);
  if (!order) throw new Error('便携版冒烟没有生成采购订单');
  const confirmed = session.confirmPurchaseOrder({
    orderId: order.id,
    reason: PORTABLE_SMOKE_PURCHASE_REASON,
  });
  const confirmedOrder = confirmed.orders.find(({ id }) => id === order.id);
  if (!confirmedOrder || confirmedOrder.status !== 'confirmed') {
    throw new Error('便携版冒烟采购订单确认失败');
  }
  const orderItem = confirmedOrder.items[0];
  if (!orderItem) throw new Error('便携版冒烟采购订单商品行不完整');
  session.recordPurchaseArrival({
    orderId: order.id,
    occurredAt: new Date().toISOString(),
    reason: PORTABLE_SMOKE_PURCHASE_ARRIVAL_REASON,
    items: [{
      orderItemId: orderItem.id,
      receivedQuantity: 1,
      resellableQuantity: 1,
    }],
  });
}

// 便携版验收的资金腿：售后实际退款由业务钩子自动立待确认事项（#74），
// 人工两段确认后直接录入平台结算；验证重启后待确认进度、资金记录与汇总跨平台一致。
function createPortableSmokeFundsHistory(session: DesktopSession): void {
  const shipmentRecordId = session.queryShipmentGroupArchives()[0]?.records[0]?.id;
  if (!shipmentRecordId) throw new Error('便携版冒烟缺少发货记录');
  const aftersalesCase = session.queryAftersalesCases({ shipmentRecordId })[0];
  if (!aftersalesCase) throw new Error('便携版冒烟缺少售后处理单');

  const pendingView = session.queryFunds();
  const pendingItem = pendingView.pendingItems.find(({ type }) => type === 'refund');
  if (!pendingItem) throw new Error('便携版冒烟没有自动立账的退款待确认事项');
  if (pendingItem.amountCents !== PORTABLE_SMOKE_ACTUAL_REFUND_CENTS) {
    throw new Error('便携版冒烟退款待确认金额与实际退款不一致');
  }
  const partial = session.confirmPendingFinanceItem({
    pendingItemId: pendingItem.id,
    amountCents: 150,
    note: PORTABLE_SMOKE_CONFIRM_REFUND_NOTE,
  });
  if (partial.pendingItems[0]?.remainingCents !== PORTABLE_SMOKE_ACTUAL_REFUND_CENTS - 150) {
    throw new Error('便携版冒烟部分确认后剩余金额不正确');
  }
  const confirmed = session.confirmPendingFinanceItem({
    pendingItemId: pendingItem.id,
    amountCents: PORTABLE_SMOKE_ACTUAL_REFUND_CENTS - 150,
    note: PORTABLE_SMOKE_CONFIRM_REFUND_NOTE,
  });
  if (confirmed.pendingItems[0]?.remainingCents !== 0) {
    throw new Error('便携版冒烟退款确认后仍有剩余待确认金额');
  }
  const settlementOrder = session.listOrders()
    .find(({ orderNumber }) => orderNumber === PORTABLE_SMOKE_ORDER_NUMBER);
  if (!settlementOrder) throw new Error('便携版冒烟缺少结算来源订单');
  session.recordFinanceRecord({
    type: 'platform_settlement',
    direction: 'income',
    amountCents: PORTABLE_SMOKE_SETTLEMENT_CENTS,
    occurredAt: new Date().toISOString(),
    note: PORTABLE_SMOKE_SETTLEMENT_NOTE,
    sourceType: 'order',
    sourceId: settlementOrder.id,
  });
}

function createPortableSmokeFulfillmentHistory(session: DesktopSession): void {
  const order = session.listOrders()
    .find(({ orderNumber }) => orderNumber === PORTABLE_SMOKE_ORDER_NUMBER);
  if (!order) throw new Error('便携版冒烟缺少计划成员订单');
  const plan = session.createFulfillmentPlan({
    type: 'presale',
    name: PORTABLE_SMOKE_PLAN_NAME,
    expectedShipAt: '2026-12-31T00:00:00.000Z',
    targetQuantity: null,
    deadlineAt: null,
    demandAlertThreshold: null,
    reason: PORTABLE_SMOKE_PLAN_CREATE_REASON,
  });
  const withMember = session.addFulfillmentPlanOrders({
    planId: plan.id,
    expectedRevision: plan.revision,
    orderIds: [order.id],
    reason: PORTABLE_SMOKE_PLAN_JOIN_REASON,
  });
  if (session.queryShipmentGroups().groups.some(({ orders }) => (
    orders.some(({ id }) => id === order.id)
  ))) {
    throw new Error('便携版冒烟未释放成员订单出现在发货组中');
  }
  session.releaseFulfillmentPlanOrders({
    planId: plan.id,
    expectedRevision: withMember.revision,
    orderIds: [order.id],
    reason: PORTABLE_SMOKE_PLAN_RELEASE_REASON,
  });
}

function createPortableSmokeOperationsHistory(session: DesktopSession): void {
  const group = session.queryShipmentGroups().groups[0];
  if (!group) throw new Error('便携版冒烟没有生成待发货组');
  const items = group.orders.flatMap((order) => order.items.map((item) => ({
    orderId: order.id,
    orderItemId: item.id,
    quantity: item.quantity,
  })));
  const shipment = session.confirmShipment({
    groupId: group.id,
    expectedRemainingItems: items,
    packages: [{
      shippingCarrier: PORTABLE_SMOKE_SHIPPING_CARRIER,
      trackingNumber: PORTABLE_SMOKE_TRACKING_NUMBER,
      items,
    }],
  });
  const shipmentPackage = shipment.record.packages[0];
  if (!shipmentPackage) throw new Error('便携版冒烟没有生成发货包裹');
  const logisticsOccurredAt = new Date().toISOString();
  const logistics = session.updateShipmentPackageLogisticsStatus({
    recordId: shipment.record.id,
    packageId: shipmentPackage.id,
    expectedRevision: shipmentPackage.revision,
    logisticsStatus: 'delivered',
    carrierAcceptanceConfirmed: true,
    occurredAt: logisticsOccurredAt,
    reason: PORTABLE_SMOKE_LOGISTICS_REASON,
  });
  const sourceItem = logistics.record.packages[0]?.items[0];
  if (!sourceItem) throw new Error('便携版冒烟发货商品不完整');
  const aftersalesOccurredAt = new Date().toISOString();
  const aftersalesCase = session.createAftersalesCase({
    shipmentRecordId: shipment.record.id,
    workflowTemplateId: 'system-aftersales-refund-only',
    occurredAt: aftersalesOccurredAt,
    reason: PORTABLE_SMOKE_AFTERSALES_REASON,
    requestedRefundCents: PORTABLE_SMOKE_REQUESTED_REFUND_CENTS,
    items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
  });
  session.progressAftersalesCase({
    kind: 'confirm_refund',
    caseId: aftersalesCase.id,
    expectedRevision: aftersalesCase.revision,
    actualRefundCents: PORTABLE_SMOKE_ACTUAL_REFUND_CENTS,
    occurredAt: new Date().toISOString(),
    note: PORTABLE_SMOKE_REFUND_NOTE,
  });
}

function assertOccurredNotAfterCreated(
  occurredAt: string,
  createdAt: string,
  label: string,
): void {
  const occurredTimestamp = Date.parse(occurredAt);
  const createdTimestamp = Date.parse(createdAt);
  if (
    !Number.isFinite(occurredTimestamp) ||
    !Number.isFinite(createdTimestamp) ||
    occurredTimestamp > createdTimestamp
  ) {
    throw new Error(`便携版冒烟${label}时间因果无效`);
  }
}

async function importPortableSmokeOrder(
  session: DesktopSession,
  configDirectory: string,
  dataDirectory: string,
): Promise<void> {
  if (session.restore().kind !== 'needs_data_directory') {
    throw new Error('便携版首次启动冒烟必须从未选择数据目录的状态开始');
  }
  const selected = session.useDataDirectory(dataDirectory);
  if (selected.kind !== 'ready' || selected.orders.length !== 0) {
    throw new Error('便携版首次选择订单数据目录失败或目录并非空目录');
  }

  await mkdir(configDirectory, { recursive: true });
  const sourcePath = join(configDirectory, 'portable-release-smoke.png');
  await writeFile(sourcePath, PORTABLE_SMOKE_PNG, { flag: 'wx' });
  try {
    const batch = await session.submitSourceScreenshots([sourcePath]);
    const item = await waitForReviewableItem(session, batch.id);
    if (!item.draftId) throw new Error('便携版冒烟没有生成可入库订单');
    const confirmed = session.confirmDraft(session.getDraft(item.draftId));
    if (confirmed.order.orderNumber !== PORTABLE_SMOKE_ORDER_NUMBER) {
      throw new Error('便携版冒烟导入了错误订单');
    }
  } finally {
    await unlink(sourcePath).catch(() => undefined);
  }
}

async function waitForReviewableItem(
  session: DesktopSession,
  batchId: string,
): Promise<RecognitionBatchItem> {
  // 600 次 × 25ms ≈ 15 秒：CI 冷启动（尤其 Windows runner）下受控识别偶发超过 5 秒。
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const item = session
      .listRecognitionBatches()
      .find((batch) => batch.id === batchId)
      ?.items[0];
    if (item?.status === 'awaiting_confirmation') return item;
    if (item && ['failed', 'waiting_retry', 'cancelled'].includes(item.status)) {
      throw new Error(item.errorMessage || `便携版冒烟识别失败：${item.status}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('便携版冒烟等待订单识别超时');
}

function createSmokeOcrSettings(): OcrSettingsService {
  return new OcrSettingsService(
    { read: () => null, write: () => undefined },
    {
      getApiKey: async () => null,
      setApiKey: async () => undefined,
      deleteApiKey: async () => undefined,
      getDisplayName: () => '便携版冒烟凭据库',
    },
    { testConnection: async () => ({ model: 'qwen3.5-ocr' }) },
  );
}

function requiredAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  const normalized = resolve(value);
  if (normalized !== value) throw new Error(`${label}必须使用绝对路径`);
  return normalized;
}

const PORTABLE_SMOKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const PORTABLE_SMOKE_RECOGNITION: RecognitionResult = {
  platform: 'xianyu',
  sellerAccount: '便携版验收账号',
  orderNumber: PORTABLE_SMOKE_ORDER_NUMBER,
  alipayTransactionNumber: 'PORTABLE-SMOKE-ALI-001',
  buyerNickname: '便***户',
  recipient: '便携验收收件人',
  phone: '13900000001',
  phoneNormalized: '13900000001',
  addressOriginal: '广东省深圳市南山区便携验收路1号',
  addressNormalized: '广东省深圳市南山区便携验收路1号',
  province: '广东省',
  city: '深圳市',
  district: '南山区',
  orderedAtOriginal: '2026-07-31 09:00:00',
  orderedAtNormalized: '2026-07-31T09:00:00+08:00',
  paidAtOriginal: '2026-07-31 09:00:08',
  paidAtNormalized: '2026-07-31T09:00:08+08:00',
  productTotalCents: 800,
  shippingFeeCents: 0,
  amountCents: 800,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  items: [{
    sourceTitle: '便携版验收商品',
    sourceSpec: '标准款',
    unitPriceCents: 800,
    quantity: 1,
    quantityInferred: true,
  }],
};
