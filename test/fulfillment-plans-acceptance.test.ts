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
import {
  fulfillmentPlanTodo,
  isUnformedAwaitingRefund,
} from '../src/core/fulfillment-plans';
import type { ShipmentGroupProjection } from '../src/core/shipment-groups';
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

const PRESALE_PRODUCT = { name: '玻璃保鲜盒', specification: '1000ml', sku: 'SKU-ACCEPT-A' };
const ACCESSORY_PRODUCT = { name: '硅胶封口夹', specification: '大号', sku: 'SKU-ACCEPT-B' };

function acceptanceRecognition(
  orderNumber: string,
  quantity: number,
  sourceTitle: string,
  sourceSpec: string,
  sequence: number,
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient: `验收收件人${sequence}号`,
    phone: `1390000010${sequence}`,
    phoneNormalized: `1390000010${sequence}`,
    addressOriginal: `广东省深圳市南山区验收路${sequence}号`,
    addressNormalized: `广东省深圳市南山区验收路${sequence}号`,
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-18 08:00:00',
    orderedAtNormalized: '2026-08-18T08:00:00+08:00',
    paidAtOriginal: '2026-08-18 08:00:08',
    paidAtNormalized: '2026-08-18T08:00:08+08:00',
    productTotalCents: 800 * quantity,
    shippingFeeCents: 0,
    amountCents: 800 * quantity,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle,
      sourceSpec,
      unitPriceCents: 800,
      quantity,
      quantityInferred: false,
    }],
  };
}

const ACCEPTANCE_RECOGNITIONS = (): RecognitionResult[] => [
  acceptanceRecognition('XY-ACCEPT-SPOT-0001', 2, '现货直发商品', '标准款', 1),
  acceptanceRecognition('XY-ACCEPT-PRESALE-0002', 10, PRESALE_PRODUCT.name, PRESALE_PRODUCT.specification, 2),
  acceptanceRecognition('XY-ACCEPT-GROUP-0003', 4, PRESALE_PRODUCT.name, PRESALE_PRODUCT.specification, 3),
  acceptanceRecognition('XY-ACCEPT-GROUP-0004', 2, PRESALE_PRODUCT.name, PRESALE_PRODUCT.specification, 4),
  acceptanceRecognition('XY-ACCEPT-UNFORMED-0005', 3, ACCESSORY_PRODUCT.name, ACCESSORY_PRODUCT.specification, 5),
];

async function seedAcceptanceOrders(
  root: string,
): Promise<{ application: LocalApplication; sources: string[] }> {
  const recognitions = ACCEPTANCE_RECOGNITIONS();
  const application = new LocalApplication(new SequenceRecognizer(recognitions));
  applications.push(application);
  application.openDataDirectory(join(root, '数据'));
  for (const product of [PRESALE_PRODUCT, ACCESSORY_PRODUCT]) {
    application.createStandardProduct({
      ...product,
      defaultOrderPriceCents: 800,
      priceChangeReason: '首次定价',
    });
  }
  const sources: string[] = [];
  for (let index = 0; index < recognitions.length; index += 1) {
    const sourcePath = join(root, `验收订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`acceptance-source-${index}`));
    sources.push(sourcePath);
  }
  return { application, sources };
}

function occurrenceCount(projection: ShipmentGroupProjection, orderId: string): number {
  return projection.groups.reduce((total, group) => total + (
    group.orders.some(({ id }) => id === orderId) ? 1 : 0
  ), 0);
}

function refreshRevision(application: LocalApplication, orderId: string): number {
  return application.getOrder(orderId).order.revision;
}

describe('预售与团购履约计划闭环验收', () => {
  it('规格例四、例五验收清单全量走查', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-acceptance-'));
    const { application, sources } = await seedAcceptanceOrders(root);
    const drafts = (await application.submitRecognitionBatch(sources)).drafts;
    const [spotOrder, presaleOrder, groupOrderA, groupOrderB, unformedOrder] =
      drafts.map((draft) => application.confirmDraft(draft));

    // 验收条 1：普通现货订单不经过履约计划即可进入发货组。
    const spotOnly = application.queryShipmentGroups();
    expect(occurrenceCount(spotOnly, spotOrder.id)).toBe(1);

    // 例五：预售期间分批采购并发生退款。
    const presale = application.createFulfillmentPlan({
      type: 'presale',
      name: '处暑预售',
      expectedShipAt: '2026-09-30T00:00:00.000Z',
      targetQuantity: null,
      deadlineAt: null,
      demandAlertThreshold: null,
      reason: '预售开始备货',
    });
    const withPresaleMember = application.addFulfillmentPlanOrders({
      planId: presale.id,
      expectedRevision: presale.revision,
      orderIds: [presaleOrder.id],
      reason: '加入预售',
    });

    // 例四：团购达到 18/30 前的待成团状态（本用例缩放为 4/6）。
    const groupBuy = application.createFulfillmentPlan({
      type: 'group_buy',
      name: '中秋团购',
      expectedShipAt: null,
      targetQuantity: 6,
      deadlineAt: null,
      demandAlertThreshold: null,
      reason: '开团',
    });
    const withGroupMemberA = application.addFulfillmentPlanOrders({
      planId: groupBuy.id,
      expectedRevision: groupBuy.revision,
      orderIds: [groupOrderA.id],
      reason: '加入团购',
    });
    expect(fulfillmentPlanTodo(withGroupMemberA, withGroupMemberA.activeItemQuantity, '2026-08-19T00:00:00+08:00'))
      .toBe('待成团（4/6）');

    // 验收条 3（前半）：未成团不产生确定采购缺口，需求只用于预测。
    const conditional = application.queryFulfillmentDemand(groupBuy.id);
    expect(conditional.conditional).toBe(true);
    const groupProductId = conditional.products
      .find(({ sku }) => sku === PRESALE_PRODUCT.sku)!.standardProductId;
    expect(() => application.createPurchaseSuggestion({
      planId: groupBuy.id,
      standardProductId: groupProductId,
      quantity: 1,
      reason: '想提前采购',
    })).toThrow('未成团计划的需求只用于预测，提前采购需勾选确认未成团库存风险');

    // 验收条 2：预售进行中多批采购建议，确认后形成已确认采购。
    const presaleProductId = application.queryFulfillmentDemand(presale.id)
      .products.find(({ sku }) => sku === PRESALE_PRODUCT.sku)!.standardProductId;
    const firstBatch = application.createPurchaseSuggestion({
      planId: presale.id,
      standardProductId: presaleProductId,
      quantity: 4,
      reason: '第1批采购',
    });
    application.confirmPurchaseSuggestion({
      planId: presale.id,
      suggestionId: firstBatch.suggestions[0].id,
      reason: '确认第1批',
    });
    const secondBatch = application.createPurchaseSuggestion({
      planId: presale.id,
      standardProductId: presaleProductId,
      quantity: 2,
      reason: '第2批采购',
    });
    const bothConfirmed = application.confirmPurchaseSuggestion({
      planId: presale.id,
      suggestionId: secondBatch.suggestions
        .find(({ quantity }) => quantity === 2)!.id,
      reason: '确认第2批',
    });
    expect(bothConfirmed.totals).toMatchObject({
      demandQuantity: 10,
      confirmedSuggestionQuantity: 6,
      uncoveredQuantity: 4,
    });

    // 例五第 4-6 条：发货前退款重算缺口，已确认采购不被改写。
    const afterRefund = application.registerFulfillmentRefund({
      planId: presale.id,
      orderId: presaleOrder.id,
      orderItemId: presaleOrder.items[0].id,
      quantity: 1,
      reason: '发货前退款 1 件',
    });
    expect(afterRefund.totals).toMatchObject({
      demandQuantity: 9,
      confirmedSuggestionQuantity: 6,
      uncoveredQuantity: 3,
    });
    expect(afterRefund.suggestions.filter(({ status }) => status === 'confirmed'))
      .toHaveLength(2);
    expect(afterRefund.suggestions.map(({ quantity }) => quantity).sort())
      .toEqual([2, 4]);

    // 例五第 8 条：尚未发货，因此不创建发货后售后处理单。
    expect(application.queryAftersalesCases()).toEqual([]);

    // 验收条 3（后半）：补足成团数量后确认成团，需求转为确定。
    const formationReady = application.addFulfillmentPlanOrders({
      planId: groupBuy.id,
      expectedRevision: withGroupMemberA.revision,
      orderIds: [groupOrderB.id],
      reason: '补足成团数量',
    });
    expect(fulfillmentPlanTodo(formationReady, formationReady.activeItemQuantity, '2026-08-19T00:00:00+08:00'))
      .toBe('具备成团条件，请人工确认成团');
    const formed = application.confirmGroupFormation({
      planId: groupBuy.id,
      expectedRevision: formationReady.revision,
      basis: 'quantity',
      reason: '到量成团',
    });
    expect(formed.formedAt).not.toBeNull();
    const firmDemand = application.queryFulfillmentDemand(groupBuy.id);
    expect(firmDemand.conditional).toBe(false);
    expect(firmDemand.totals).toMatchObject({ demandQuantity: 6, uncoveredQuantity: 6 });

    // 例四第 3-4 条：成团后形成确定采购需求，人工确认后计入已确认采购。
    const groupBatch = application.createPurchaseSuggestion({
      planId: groupBuy.id,
      standardProductId: groupProductId,
      quantity: 6,
      reason: '成团后整批采购',
    });
    const groupConfirmed = application.confirmPurchaseSuggestion({
      planId: groupBuy.id,
      suggestionId: groupBatch.suggestions[0].id,
      reason: '确认成团采购',
    });
    expect(groupConfirmed.totals).toMatchObject({
      demandQuantity: 6,
      confirmedSuggestionQuantity: 6,
      uncoveredQuantity: 0,
    });

    // 未成团关闭：成员保留待退款清单语义，平台退款后移出清单。
    const unformedPlan = application.createFulfillmentPlan({
      type: 'group_buy',
      name: '未成团退款团购',
      expectedShipAt: null,
      targetQuantity: 10,
      deadlineAt: null,
      demandAlertThreshold: null,
      reason: '开团',
    });
    const withUnformedMember = application.addFulfillmentPlanOrders({
      planId: unformedPlan.id,
      expectedRevision: unformedPlan.revision,
      orderIds: [unformedOrder.id],
      reason: '加入团购',
    });
    const unformedClosed = application.closeFulfillmentPlan({
      planId: unformedPlan.id,
      expectedRevision: withUnformedMember.revision,
      reason: '未成团关闭',
    });
    expect(unformedClosed).toMatchObject({ status: 'closed', formedAt: null });
    expect(isUnformedAwaitingRefund(unformedClosed.members[0])).toBe(true);
    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: unformedOrder.id, expectedRevision: refreshRevision(application, unformedOrder.id) }],
      patch: { platformTransactionStatus: 'refunded' },
    });
    const unformedAfterRefund = application.queryFulfillmentPlans()
      .find(({ id }) => id === unformedPlan.id)!;
    expect(unformedAfterRefund.members[0]).toMatchObject({
      orderId: unformedOrder.id,
      removedAt: null,
      platformTransactionStatus: 'refunded',
    });
    expect(isUnformedAwaitingRefund(unformedAfterRefund.members[0])).toBe(false);

    // 计划成员被闸门拦截：待发货计数与发货组只保留现货订单。
    const gated = application.queryShipmentGroups();
    expect(occurrenceCount(gated, spotOrder.id)).toBe(1);
    for (const member of [presaleOrder.id, groupOrderA.id, groupOrderB.id, unformedOrder.id]) {
      expect(occurrenceCount(gated, member)).toBe(0);
    }
    expect(application.queryOrders({}).pendingShipmentCount).toBe(1);

    // 验收条 4：部分备货只释放已到货订单，另一成员保持未释放。
    application.recordInventoryAdjustment({
      standardProductId: presaleProductId,
      quantity: 4,
      direction: 'in',
      state: 'sellable',
      reason: '首批到货入库',
    });
    const partiallyReleased = application.releaseFulfillmentPlanOrders({
      planId: groupBuy.id,
      expectedRevision: formed.revision,
      orderIds: [groupOrderA.id],
      reason: '首批到货只覆盖 4 件',
    });
    expect(partiallyReleased).toMatchObject({ status: 'partially_released', releasedOrderCount: 1 });
    const afterPartialRelease = application.queryShipmentGroups();
    expect(occurrenceCount(afterPartialRelease, groupOrderA.id)).toBe(1);
    expect(occurrenceCount(afterPartialRelease, groupOrderB.id)).toBe(0);
    expect(application.queryOrders({}).pendingShipmentCount).toBe(2);

    // 验收条 4：退款成员不能释放，需先退出计划。
    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: groupOrderB.id, expectedRevision: refreshRevision(application, groupOrderB.id) }],
      patch: { platformTransactionStatus: 'refunded' },
    });
    expect(() => application.releaseFulfillmentPlanOrders({
      planId: groupBuy.id,
      expectedRevision: partiallyReleased.revision,
      orderIds: [groupOrderB.id],
      reason: '试图释放退款订单',
    })).toThrow('已取消或退款的订单不能释放，请先将其退出计划');
    const afterExit = application.removeFulfillmentPlanOrder({
      planId: groupBuy.id,
      expectedRevision: partiallyReleased.revision,
      orderId: groupOrderB.id,
      reason: '买家已退款退出团购',
    });
    expect(afterExit.members.find(({ orderId }) => orderId === groupOrderB.id))
      .toMatchObject({ removedAt: expect.any(String), removedReason: '买家已退款退出团购' });

    // 验收条 5：释放后的订单只出现一次，并可继续完成发货记录与售后流程。
    expect(occurrenceCount(application.queryShipmentGroups(), groupOrderA.id)).toBe(1);
    const eventsBeforeShipment = application.queryFulfillmentPlans()
      .find(({ id }) => id === groupBuy.id)!.events.map(({ eventType }) => eventType);
    const group = application.queryShipmentGroups().groups
      .find(({ orders }) => orders.some(({ id }) => id === groupOrderA.id))!;
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ACCEPT-0001',
        items: remainingItems,
      }],
    });
    const shipmentPackage = shipment.record.packages[0];
    const deliveredAt = new Date(Date.parse(shipment.record.createdAt) + 60_000).toISOString();
    const delivered = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'delivered',
      carrierAcceptanceConfirmed: true,
      occurredAt: deliveredAt,
      reason: '验收确认签收',
    });
    const deliveredPackage = delivered.record.packages[0];
    const aftersalesCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-refund-only',
      occurredAt: new Date(Date.parse(deliveredAt) + 60_000).toISOString(),
      reason: '验收登记仅退款',
      requestedRefundCents: 800,
      items: [{ shipmentPackageItemId: deliveredPackage.items[0].id, quantity: 1 }],
    });
    const refundConfirmed = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: aftersalesCase.id,
      expectedRevision: aftersalesCase.revision,
      actualRefundCents: 800,
      occurredAt: new Date(Date.parse(deliveredAt) + 120_000).toISOString(),
      note: '验收确认实际退款',
    });
    const completed = application.progressAftersalesCase({
      kind: 'complete',
      caseId: refundConfirmed.id,
      expectedRevision: refundConfirmed.revision,
      reason: '验收完结',
    });
    expect(completed).toMatchObject({ status: 'completed' });

    // 发货与售后不回写计划历史；已释放订单在开放发货组与发货档案中各只出现一次。
    const groupPlanAfterShipment = application.queryFulfillmentPlans()
      .find(({ id }) => id === groupBuy.id)!;
    expect(groupPlanAfterShipment.events.map(({ eventType }) => eventType))
      .toEqual(eventsBeforeShipment);
    expect(occurrenceCount(application.queryShipmentGroups(), groupOrderA.id)).toBe(0);
    const sourcingRecords = application.queryShipmentGroupArchives()
      .flatMap((archive) => archive.records)
      .filter((record) => record.sourceOrders.some(({ orderId }) => orderId === groupOrderA.id));
    expect(sourcingRecords).toHaveLength(1);
    // 现货订单全程不受计划影响，预售成员保持闸门内。
    expect(occurrenceCount(application.queryShipmentGroups(), spotOrder.id)).toBe(1);
    expect(occurrenceCount(application.queryShipmentGroups(), presaleOrder.id)).toBe(0);
    expect(application.queryOrders({}).pendingShipmentCount).toBe(1);

    // 验收条 6（重启）：重新打开同一数据目录后履约历史完整。
    const beforeRestart = {
      plans: application.queryFulfillmentPlans(),
      presaleDemand: application.queryFulfillmentDemand(presale.id),
      groupDemand: application.queryFulfillmentDemand(groupBuy.id),
      unformedDemand: application.queryFulfillmentDemand(unformedPlan.id),
      progress: application.queryFulfillmentPlanProgress(groupBuy.id),
      archives: application.queryShipmentGroupArchives(),
      aftersales: application.queryAftersalesCases({ shipmentRecordId: shipment.record.id }),
    };
    application.close();
    applications.splice(applications.indexOf(application), 1);
    const restarted = new LocalApplication(new SequenceRecognizer([]));
    applications.push(restarted);
    restarted.openDataDirectory(join(root, '数据'));
    expect(restarted.queryFulfillmentPlans()).toEqual(beforeRestart.plans);
    expect(restarted.queryFulfillmentDemand(presale.id)).toEqual(beforeRestart.presaleDemand);
    expect(restarted.queryFulfillmentDemand(groupBuy.id)).toEqual(beforeRestart.groupDemand);
    expect(restarted.queryFulfillmentDemand(unformedPlan.id)).toEqual(beforeRestart.unformedDemand);
    expect(restarted.queryFulfillmentPlanProgress(groupBuy.id)).toEqual(beforeRestart.progress);
    expect(restarted.queryShipmentGroupArchives()).toEqual(beforeRestart.archives);
    expect(restarted.queryAftersalesCases({ shipmentRecordId: shipment.record.id }))
      .toEqual(beforeRestart.aftersales);
  });

  it('备份恢复后履约计划、需求与发货售后历史保持一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-backup-'));
    const dataDirectory = join(root, '数据');
    const { application, sources } = await seedAcceptanceOrders(root);
    const drafts = (await application.submitRecognitionBatch(sources)).drafts;
    const [, presaleOrder, groupOrderA, groupOrderB, unformedOrder] =
      drafts.map((draft) => application.confirmDraft(draft));

    const presale = application.createFulfillmentPlan({
      type: 'presale',
      name: '处暑预售',
      expectedShipAt: '2026-09-30T00:00:00.000Z',
      targetQuantity: null,
      deadlineAt: null,
      demandAlertThreshold: null,
      reason: '预售开始备货',
    });
    application.addFulfillmentPlanOrders({
      planId: presale.id,
      expectedRevision: presale.revision,
      orderIds: [presaleOrder.id],
      reason: '加入预售',
    });
    const presaleProductId = application.queryFulfillmentDemand(presale.id)
      .products.find(({ sku }) => sku === PRESALE_PRODUCT.sku)!.standardProductId;
    const batch = application.createPurchaseSuggestion({
      planId: presale.id,
      standardProductId: presaleProductId,
      quantity: 4,
      reason: '备份基线采购',
    });
    application.confirmPurchaseSuggestion({
      planId: presale.id,
      suggestionId: batch.suggestions[0].id,
      reason: '确认备份基线采购',
    });
    application.registerFulfillmentRefund({
      planId: presale.id,
      orderId: presaleOrder.id,
      orderItemId: presaleOrder.items[0].id,
      quantity: 1,
      reason: '备份基线退款',
    });

    const groupBuy = application.createFulfillmentPlan({
      type: 'group_buy',
      name: '中秋团购',
      expectedShipAt: null,
      targetQuantity: 6,
      deadlineAt: null,
      demandAlertThreshold: null,
      reason: '开团',
    });
    const formed = application.confirmGroupFormation({
      planId: groupBuy.id,
      expectedRevision: application.addFulfillmentPlanOrders({
        planId: groupBuy.id,
        expectedRevision: groupBuy.revision,
        orderIds: [groupOrderA.id, groupOrderB.id],
        reason: '加入团购',
      }).revision,
      basis: 'quantity',
      reason: '到量成团',
    });
    application.recordInventoryAdjustment({
      standardProductId: presaleProductId,
      quantity: 4,
      direction: 'in',
      state: 'sellable',
      reason: '备份基线备货入库',
    });
    application.releaseFulfillmentPlanOrders({
      planId: groupBuy.id,
      expectedRevision: formed.revision,
      orderIds: [groupOrderA.id],
      reason: '备份基线释放',
    });
    const group = application.queryShipmentGroups().groups
      .find(({ orders }) => orders.some(({ id }) => id === groupOrderA.id))!;
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ACCEPT-BACKUP-0001',
        items: remainingItems,
      }],
    });
    const aftersalesCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-refund-only',
      occurredAt: new Date(Date.parse(shipment.record.createdAt) + 120_000).toISOString(),
      reason: '备份基线售后',
      requestedRefundCents: 800,
      items: [{ shipmentPackageItemId: shipment.record.packages[0].items[0].id, quantity: 1 }],
    });
    application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: aftersalesCase.id,
      expectedRevision: aftersalesCase.revision,
      actualRefundCents: 800,
      occurredAt: new Date(Date.parse(shipment.record.createdAt) + 180_000).toISOString(),
      note: '备份基线退款确认',
    });

    const unformedPlan = application.createFulfillmentPlan({
      type: 'group_buy',
      name: '未成团退款团购',
      expectedShipAt: null,
      targetQuantity: 10,
      deadlineAt: null,
      demandAlertThreshold: null,
      reason: '开团',
    });
    application.closeFulfillmentPlan({
      planId: unformedPlan.id,
      expectedRevision: application.addFulfillmentPlanOrders({
        planId: unformedPlan.id,
        expectedRevision: unformedPlan.revision,
        orderIds: [unformedOrder.id],
        reason: '加入团购',
      }).revision,
      reason: '未成团关闭',
    });

    const before = {
      plans: application.queryFulfillmentPlans(),
      presaleDemand: application.queryFulfillmentDemand(presale.id),
      groupDemand: application.queryFulfillmentDemand(groupBuy.id),
      unformedDemand: application.queryFulfillmentDemand(unformedPlan.id),
      progress: application.queryFulfillmentPlanProgress(groupBuy.id),
      archives: application.queryShipmentGroupArchives(),
      aftersales: application.queryAftersalesCases({ shipmentRecordId: shipment.record.id }),
    };
    application.close();
    applications.splice(applications.indexOf(application), 1);

    // 备份：整库拷贝到新目录；恢复：从拷贝打开。
    const backupDataDirectory = join(await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-restore-')), '数据');
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
    expect(restored.queryFulfillmentPlans()).toEqual(before.plans);
    expect(restored.queryFulfillmentDemand(presale.id)).toEqual(before.presaleDemand);
    expect(restored.queryFulfillmentDemand(groupBuy.id)).toEqual(before.groupDemand);
    expect(restored.queryFulfillmentDemand(unformedPlan.id)).toEqual(before.unformedDemand);
    expect(restored.queryFulfillmentPlanProgress(groupBuy.id)).toEqual(before.progress);
    expect(restored.queryShipmentGroupArchives()).toEqual(before.archives);
    expect(restored.queryAftersalesCases({ shipmentRecordId: shipment.record.id }))
      .toEqual(before.aftersales);
  });
});
