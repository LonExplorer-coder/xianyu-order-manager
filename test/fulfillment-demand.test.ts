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
import {
  presaleDemandAlerts,
  purchaseSuggestionStatusLabel,
  type PresaleDemandView,
} from '../src/core/fulfillment-demand';
import type { FulfillmentPlanView } from '../src/core/fulfillment-plans';
import type { OriginalOrder } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';
import { removeVersion52ExtensionArtifacts } from './version31-fixture';

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

type DemandItem = {
  sourceTitle: string;
  sourceSpec?: string;
  quantity: number;
  unitPriceCents?: number;
};

function demandRecognition(orderNumber: string, items: DemandItem[]): RecognitionResult {
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
    recipient: '测试收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-03 08:00:00',
    orderedAtNormalized: '2026-08-03T08:00:00+08:00',
    paidAtOriginal: '2026-08-03 08:00:08',
    paidAtNormalized: '2026-08-03T08:00:08+08:00',
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

const PRESALE_PRODUCT = { name: '玻璃保鲜盒', specification: '1000ml', sku: 'SKU-DEMAND-A' };
const ACCESSORY_PRODUCT = { name: '硅胶封口夹', specification: '大号', sku: 'SKU-DEMAND-B' };

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
    const sourcePath = join(root, `需求订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`demand-source-${index}`));
    sources.push(sourcePath);
  }
  return { application, sources };
}

function createPresalePlan(
  application: LocalApplication,
  overrides: Record<string, unknown> = {},
): FulfillmentPlanView {
  return application.createFulfillmentPlan({
    type: 'presale',
    name: '八月预售',
    expectedShipAt: '2026-09-30T00:00:00.000Z',
    reason: '预售开始备货',
    ...overrides,
  });
}

function addOrders(
  application: LocalApplication,
  plan: FulfillmentPlanView,
  orderIds: string[],
  reason = '加入预售',
): FulfillmentPlanView {
  return application.addFulfillmentPlanOrders({
    planId: plan.id,
    expectedRevision: plan.revision,
    orderIds,
    reason,
  });
}

function registerRefund(
  application: LocalApplication,
  plan: FulfillmentPlanView,
  order: OriginalOrder,
  itemIndex: number,
  quantity: number,
  reason: string,
): PresaleDemandView {
  return application.registerFulfillmentRefund({
    planId: plan.id,
    orderId: order.id,
    orderItemId: order.items[itemIndex].id,
    quantity,
    reason,
  });
}

describe('预售有效需求投影', () => {
  it('有效需求随订单加入实时累计并按标准商品归并', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-basic-'));
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-DEMAND-0001', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 3 },
        { sourceTitle: ACCESSORY_PRODUCT.name, sourceSpec: ACCESSORY_PRODUCT.specification, quantity: 2 },
      ]),
      demandRecognition('XY-DEMAND-0002', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 1 },
      ]),
    ], [PRESALE_PRODUCT, ACCESSORY_PRODUCT]);
    const batch = await application.submitRecognitionBatch(sources);
    const [orderA, orderB] = batch.drafts.map((draft) => application.confirmDraft(draft));

    const plan = createPresalePlan(application);
    const view = application.queryFulfillmentDemand(plan.id);
    expect(view.totals.demandQuantity).toBe(0);

    addOrders(application, plan, [orderA.id, orderB.id]);
    const demand = application.queryFulfillmentDemand(plan.id);
    expect(demand.products).toEqual([
      expect.objectContaining({
        sku: PRESALE_PRODUCT.sku,
        demandQuantity: 4,
        uncoveredQuantity: 4,
      }),
      expect.objectContaining({
        sku: ACCESSORY_PRODUCT.sku,
        demandQuantity: 2,
        uncoveredQuantity: 2,
      }),
    ]);
    expect(demand.totals).toMatchObject({
      demandQuantity: 6,
      refundedOrCancelledQuantity: 0,
      confirmedInTransitQuantity: 0,
      draftSuggestionQuantity: 0,
      uncoveredQuantity: 6,
      releasedOrderCount: 0,
    });
    expect(demand.unmapped).toEqual([]);
  });

  it('未映射标准商品的明细单列展示且不进入需求与缺口', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-unmapped-'));
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-DEMAND-0003', [
        { sourceTitle: '未建档手作发夹', sourceSpec: '蓝色', quantity: 2 },
      ]),
    ]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);

    const plan = createPresalePlan(application);
    addOrders(application, plan, [order.id]);
    const demand = application.queryFulfillmentDemand(plan.id);
    expect(demand.products).toEqual([]);
    expect(demand.totals.demandQuantity).toBe(0);
    expect(demand.unmapped).toEqual([
      {
        sourceTitle: '未建档手作发夹',
        sourceSpec: '蓝色',
        quantity: 2,
        orderCount: 1,
      },
    ]);

    const afterRefund = registerRefund(application, plan, order, 0, 1, '未映射商品退1件');
    expect(afterRefund.unmapped).toEqual([
      {
        sourceTitle: '未建档手作发夹',
        sourceSpec: '蓝色',
        quantity: 1,
        orderCount: 1,
      },
    ]);
  });

  it('部分退款精确到商品与数量并限制超出数量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-refund-'));
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-DEMAND-0004', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 3 },
      ]),
    ], [PRESALE_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);

    const plan = createPresalePlan(application);
    addOrders(application, plan, [order.id]);
    const view = registerRefund(application, plan, order, 0, 1, '买家退回1件');
    expect(view.products[0]).toMatchObject({
      demandQuantity: 2,
      refundedOrCancelledQuantity: 1,
      uncoveredQuantity: 2,
    });
    expect(() => registerRefund(application, plan, order, 0, 3, '超量退款'))
      .toThrow('退款数量超过该商品剩余可退数量（还可退 2 件）');
    expect(() => application.registerFulfillmentRefund({
      planId: plan.id,
      orderId: order.id,
      orderItemId: order.items[0].id,
      quantity: 0,
      reason: '数量为零',
    })).toThrow('退款数量无效');
  });

  it('整单平台退款剔除全部需求并吞并商品级退款', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-whole-refund-'));
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-DEMAND-0005', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 3 },
      ]),
    ], [PRESALE_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);

    const plan = createPresalePlan(application);
    addOrders(application, plan, [order.id]);
    registerRefund(application, plan, order, 0, 1, '先退1件');

    const updated = application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: order.id, expectedRevision: order.revision }],
      patch: { platformTransactionStatus: 'refunded' },
    });
    expect(updated[0].order.platformTransactionStatus).toBe('refunded');
    const demand = application.queryFulfillmentDemand(plan.id);
    expect(demand.products[0]).toMatchObject({
      demandQuantity: 0,
      refundedOrCancelledQuantity: 3,
      uncoveredQuantity: 0,
    });
    expect(() => registerRefund(application, plan, order, 0, 1, '再登记'))
      .toThrow('订单已是整单退款状态，无需再登记商品级退款');
  });

  it('取消订单剔除需求、计入退款取消数量并收缩未确认建议', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-cancelled-'));
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-DEMAND-0006', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 2 },
      ]),
    ], [PRESALE_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);

    const created = createPresalePlan(application);
    const plan = addOrders(application, created, [order.id]);
    const withDraft = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: productId(application, PRESALE_PRODUCT.sku),
      quantity: 2,
      reason: '待确认建议',
    });
    const draftSuggestionId = withDraft.suggestions.find(
      (suggestion) => suggestion.status === 'draft',
    )!.id;
    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: order.id, expectedRevision: order.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });
    const demand = application.queryFulfillmentDemand(plan.id);
    expect(demand.products[0]).toMatchObject({
      demandQuantity: 0,
      refundedOrCancelledQuantity: 2,
      draftSuggestionQuantity: 0,
    });
    expect(demand.suggestions.find(({ id }) => id === draftSuggestionId)).toMatchObject({
      status: 'cancelled',
      cancelReason: '订单取消后重算未确认建议',
    });
  });

  it('已释放订单退出需求池，发货后退款不再影响发货前需求', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-released-'));
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-DEMAND-0007', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 5 },
      ]),
    ], [PRESALE_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);

    const plan = createPresalePlan(application);
    const withMember = addOrders(application, plan, [order.id]);
    application.releaseFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: withMember.revision,
      orderIds: [order.id],
      reason: '到货可发',
    });
    expect(application.queryFulfillmentDemand(plan.id).totals).toMatchObject({
      demandQuantity: 0,
      releasedOrderCount: 1,
    });

    const refreshed = application.getOrder(order.id).order;
    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: order.id, expectedRevision: refreshed.revision }],
      patch: { platformTransactionStatus: 'refunded' },
    });
    const afterRefund = application.queryFulfillmentDemand(plan.id);
    expect(afterRefund.totals.demandQuantity).toBe(0);
    expect(afterRefund.totals.refundedOrCancelledQuantity).toBe(0);
  });

  it('预售需求视图与建议仅适用于预售计划', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-type-guard-'));
    const { application, sources } = await openSeededApplication(root, []);
    const groupBuy = application.createFulfillmentPlan({
      type: 'group_buy',
      name: '团购批次',
      targetQuantity: 10,
      reason: '开团',
    });
    expect(() => application.queryFulfillmentDemand(groupBuy.id))
      .toThrow('预售需求与采购建议只适用于预售计划');
  });
});

describe('分批采购建议', () => {
  async function seededPlanWithDemand(
    root: string,
    quantity: number,
  ): Promise<{
    application: LocalApplication;
    plan: FulfillmentPlanView;
    order: OriginalOrder;
  }> {
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-SUGGEST-0001', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity },
      ]),
    ], [PRESALE_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);
    const created = createPresalePlan(application);
    const plan = addOrders(application, created, [order.id]);
    return { application, plan, order };
  }

  it('建议受未覆盖需求约束，确认后计入采购在途并支持多批次', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-suggestion-batches-'));
    const { application, plan } = await seededPlanWithDemand(root, 10);

    const first = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: productId(application, PRESALE_PRODUCT.sku),
      quantity: 4,
      reason: '第1批采购',
    });
    expect(first.products[0]).toMatchObject({
      demandQuantity: 10,
      draftSuggestionQuantity: 4,
      confirmedInTransitQuantity: 0,
      uncoveredQuantity: 10,
    });
    expect(first.suggestions).toHaveLength(1);
    expect(purchaseSuggestionStatusLabel(first.suggestions[0].status)).toBe('待确认');

    expect(() => application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: productId(application, PRESALE_PRODUCT.sku),
      quantity: 20,
      reason: '超出缺口',
    })).toThrow('采购建议数量超过未覆盖需求（当前可建议 6 件）');

    const withSecondDraft = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: productId(application, PRESALE_PRODUCT.sku),
      quantity: 6,
      reason: '第2批采购',
    });
    expect(withSecondDraft.products[0].draftSuggestionQuantity).toBe(10);

    const confirmed = application.confirmPurchaseSuggestion({
      planId: plan.id,
      suggestionId: withSecondDraft.suggestions[0].id,
      reason: '确认第1批',
    });
    expect(confirmed.products[0]).toMatchObject({
      confirmedInTransitQuantity: 4,
      draftSuggestionQuantity: 6,
      uncoveredQuantity: 6,
    });
    expect(confirmed.suggestions[0]).toMatchObject({ status: 'confirmed' });
    expect(confirmed.totals.confirmedInTransitQuantity).toBe(4);
  });

  it('发货前退款收缩未确认建议、不改写已确认并给出多采购风险', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-suggestion-shrink-'));
    const { application, plan, order } = await seededPlanWithDemand(root, 100);

    const product = productId(application, PRESALE_PRODUCT.sku);
    const first = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: product,
      quantity: 40,
      reason: '第1批采购',
    });
    application.confirmPurchaseSuggestion({
      planId: plan.id,
      suggestionId: first.suggestions[0].id,
      reason: '确认第1批',
    });
    const second = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: product,
      quantity: 30,
      reason: '第2批采购',
    });
    const secondDraftId = second.suggestions.find(
      (suggestion) => suggestion.quantity === 30,
    )!.id;

    const afterFirstRefund = registerRefund(application, plan, order, 0, 25, '退款25件');
    expect(afterFirstRefund.products[0]).toMatchObject({
      demandQuantity: 75,
      confirmedInTransitQuantity: 40,
      draftSuggestionQuantity: 30,
    });

    const afterSecondRefund = registerRefund(application, plan, order, 0, 20, '退款20件');
    expect(afterSecondRefund.products[0]).toMatchObject({
      demandQuantity: 55,
      confirmedInTransitQuantity: 40,
      draftSuggestionQuantity: 15,
      uncoveredQuantity: 15,
    });
    expect(afterSecondRefund.suggestions.find(
      ({ id }) => id === secondDraftId,
    )).toMatchObject({ quantity: 15, status: 'draft' });

    const afterThirdRefund = registerRefund(application, plan, order, 0, 30, '退款30件');
    expect(afterThirdRefund.products[0]).toMatchObject({
      demandQuantity: 25,
      confirmedInTransitQuantity: 40,
      draftSuggestionQuantity: 0,
      uncoveredQuantity: 0,
      overPurchaseRisk: true,
    });
    expect(afterThirdRefund.suggestions.find(
      ({ id }) => id === secondDraftId,
    )).toMatchObject({
      status: 'cancelled',
      cancelReason: expect.stringContaining('发货前退款后重算未确认建议'),
    });
  });

  it('整单退款同样收缩未确认建议且不动已确认数量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-suggestion-whole-refund-'));
    const { application, plan, order } = await seededPlanWithDemand(root, 10);

    const product = productId(application, PRESALE_PRODUCT.sku);
    const confirmedSuggestion = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: product,
      quantity: 4,
      reason: '先确认一批',
    });
    application.confirmPurchaseSuggestion({
      planId: plan.id,
      suggestionId: confirmedSuggestion.suggestions[0].id,
      reason: '确认',
    });
    const draftSuggestion = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: product,
      quantity: 6,
      reason: '待确认一批',
    });
    const pendingDraftId = draftSuggestion.suggestions.find(
      (suggestion) => suggestion.quantity === 6,
    )!.id;

    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: order.id, expectedRevision: order.revision }],
      patch: { platformTransactionStatus: 'refunded' },
    });
    const demand = application.queryFulfillmentDemand(plan.id);
    expect(demand.products[0]).toMatchObject({
      demandQuantity: 0,
      confirmedInTransitQuantity: 4,
      draftSuggestionQuantity: 0,
      overPurchaseRisk: true,
    });
    expect(demand.suggestions.find(
      ({ id }) => id === pendingDraftId,
    )).toMatchObject({
      status: 'cancelled',
      cancelReason: '订单整单退款后重算未确认建议',
    });
    expect(demand.suggestions.find(
      ({ id }) => id === confirmedSuggestion.suggestions[0].id,
    )).toMatchObject({ status: 'confirmed', quantity: 4 });
  });

  it('人工取消已确认建议需原因并释放采购在途数量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-suggestion-cancel-'));
    const { application, plan } = await seededPlanWithDemand(root, 10);

    const product = productId(application, PRESALE_PRODUCT.sku);
    const created = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: product,
      quantity: 4,
      reason: '第1批',
    });
    application.confirmPurchaseSuggestion({
      planId: plan.id,
      suggestionId: created.suggestions[0].id,
      reason: '确认',
    });
    const cancelled = application.cancelPurchaseSuggestion({
      planId: plan.id,
      suggestionId: created.suggestions[0].id,
      reason: '供应方取消',
    });
    expect(cancelled.products[0]).toMatchObject({
      confirmedInTransitQuantity: 0,
      demandQuantity: 10,
      uncoveredQuantity: 10,
    });
    expect(cancelled.suggestions[0]).toMatchObject({
      status: 'cancelled',
      cancelReason: '供应方取消',
    });
    expect(() => application.cancelPurchaseSuggestion({
      planId: plan.id,
      suggestionId: created.suggestions[0].id,
      reason: '重复取消',
    })).toThrow('采购建议已取消');
    expect(() => application.confirmPurchaseSuggestion({
      planId: plan.id,
      suggestionId: created.suggestions[0].id,
      reason: '重复确认',
    })).toThrow('只有待确认建议可以确认');
  });

  it('已关闭计划不能创建或确认建议且需求视图仍可读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-suggestion-closed-'));
    const { application, plan } = await seededPlanWithDemand(root, 10);
    const withDraft = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: productId(application, PRESALE_PRODUCT.sku),
      quantity: 4,
      reason: '关闭前建议',
    });
    const draftSuggestionId = withDraft.suggestions.find(
      (suggestion) => suggestion.status === 'draft',
    )!.id;
    application.closeFulfillmentPlan({
      planId: plan.id,
      expectedRevision: plan.revision,
      reason: '预售结束',
    });
    expect(application.queryFulfillmentDemand(plan.id).totals.demandQuantity).toBe(0);
    expect(() => application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: productId(application, PRESALE_PRODUCT.sku),
      quantity: 1,
      reason: '关闭后创建',
    })).toThrow('履约计划已关闭，不能创建采购建议');
    expect(() => application.confirmPurchaseSuggestion({
      planId: plan.id,
      suggestionId: draftSuggestionId,
      reason: '关闭后确认',
    })).toThrow('履约计划已关闭，不能确认采购建议');
  });

  it('等价导入更新为整单退款同样收缩未确认建议', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-suggestion-import-shrink-'));
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-SUGGEST-IMPORT-0001', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 8 },
      ]),
      {
        ...demandRecognition('XY-SUGGEST-IMPORT-0001', [
          { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 8 },
        ]),
        platformTransactionStatus: 'refunded',
      },
    ], [PRESALE_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch([sources[0]])).drafts;
    const order = application.confirmDraft(draft);

    const created = createPresalePlan(application);
    const plan = addOrders(application, created, [order.id]);
    const withDraft = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: productId(application, PRESALE_PRODUCT.sku),
      quantity: 5,
      reason: '待确认建议',
    });
    const draftSuggestionId = withDraft.suggestions.find(
      (suggestion) => suggestion.status === 'draft',
    )!.id;

    const secondBatch = await application.submitRecognitionBatch([sources[1]]);
    const secondDraftId = secondBatch.drafts[0].id;
    expect(() => application.confirmDraft(secondBatch.drafts[0]))
      .toThrow('该订单身份已存在，已转为订单更新');
    const review = application.getDraftReview(secondDraftId);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');
    application.confirmOrderUpdate(review.draft, review.expectedRevision);

    const demand = application.queryFulfillmentDemand(plan.id);
    expect(demand.products[0]).toMatchObject({
      demandQuantity: 0,
      refundedOrCancelledQuantity: 8,
      draftSuggestionQuantity: 0,
    });
    expect(demand.suggestions.find(({ id }) => id === draftSuggestionId)).toMatchObject({
      status: 'cancelled',
      cancelReason: '订单整单退款后重算未确认建议',
    });
  });
});

describe('需求提醒阈值', () => {
  it('未覆盖需求达到计划阈值时给出提醒', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-threshold-'));
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-THRESHOLD-0001', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 10 },
      ]),
    ], [PRESALE_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);

    const created = createPresalePlan(application, { demandAlertThreshold: 5 });
    expect(created.demandAlertThreshold).toBe(5);
    expect(presaleDemandAlerts(application.queryFulfillmentDemand(created.id))).toEqual([]);

    const plan = addOrders(application, created, [order.id]);
    const updated = application.updateFulfillmentPlan({
      planId: plan.id,
      expectedRevision: plan.revision,
      name: null,
      expectedShipAt: null,
      targetQuantity: null,
      deadlineAt: null,
      demandAlertThreshold: 8,
      markDelayed: false,
      reason: '调整阈值',
    });
    expect(updated.demandAlertThreshold).toBe(8);
    const demand = application.queryFulfillmentDemand(plan.id);
    expect(demand.demandAlertThreshold).toBe(8);
    expect(presaleDemandAlerts(demand))
      .toEqual([`${PRESALE_PRODUCT.name}（${PRESALE_PRODUCT.specification}）未覆盖 10 件，达到提醒阈值`]);
    expect(presaleDemandAlerts({ ...demand, demandAlertThreshold: 15 })).toEqual([]);
  });
});

function productId(application: LocalApplication, sku: string): string {
  const product = application.listStandardProducts().find((entry) => entry.sku === sku);
  if (!product) throw new Error(`未找到标准商品 ${sku}`);
  return product.id;
}

describe('需求域表约束', () => {
  it('发货前退款与采购建议事件不可变，建议状态与字段组合受约束', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-demand-constraints-'));
    const { application, sources } = await openSeededApplication(root, [
      demandRecognition('XY-DEMAND-CONSTRAINT-0001', [
        { sourceTitle: PRESALE_PRODUCT.name, sourceSpec: PRESALE_PRODUCT.specification, quantity: 3 },
      ]),
    ], [PRESALE_PRODUCT]);
    const [draft] = (await application.submitRecognitionBatch(sources)).drafts;
    const order = application.confirmDraft(draft);
    const created = createPresalePlan(application);
    const plan = addOrders(application, created, [order.id]);
    application.registerFulfillmentRefund({
      planId: plan.id,
      orderId: order.id,
      orderItemId: order.items[0].id,
      quantity: 1,
      reason: '留一条退款事件',
    });
    const withSuggestion = application.createPurchaseSuggestion({
      planId: plan.id,
      standardProductId: productId(application, PRESALE_PRODUCT.sku),
      quantity: 1,
      reason: '留一条建议',
    });
    const suggestionId = withSuggestion.suggestions[0].id;
    application.close();

    const workspace = Workspace.open(join(root, '数据'));
    try {
      expect(() => workspace.database.prepare(
        'UPDATE fulfillment_refund_events SET quantity = 99',
      ).run()).toThrow(/fulfillment refund events are immutable/);
      expect(() => workspace.database.prepare(
        'DELETE FROM fulfillment_refund_events',
      ).run()).toThrow(/fulfillment refund events are immutable/);
      expect(() => workspace.database.prepare(
        'UPDATE purchase_suggestion_events SET reason = ?',
      ).run('改写原因')).toThrow(/purchase suggestion events are immutable/);
      expect(() => workspace.database.prepare(
        'DELETE FROM purchase_suggestion_events',
      ).run()).toThrow(/purchase suggestion events are immutable/);
      expect(() => workspace.database.prepare(`
        INSERT INTO purchase_suggestions (
          id, plan_id, standard_product_id, quantity, status,
          created_at, confirmed_at, cancelled_at, cancel_reason
        ) VALUES ('bad-1', ?, ?, 1, 'draft', ?, NULL, NULL, '不该有的原因')
      `).run(plan.id, productId(application, PRESALE_PRODUCT.sku), '2026-08-18T00:00:00.000Z'))
        .toThrow();
      expect(() => workspace.database.prepare(`
        INSERT INTO purchase_suggestions (
          id, plan_id, standard_product_id, quantity, status,
          created_at, confirmed_at, cancelled_at, cancel_reason
        ) VALUES ('bad-2', ?, ?, 1, 'cancelled', ?, NULL, NULL, NULL)
      `).run(plan.id, productId(application, PRESALE_PRODUCT.sku), '2026-08-18T00:00:00.000Z'))
        .toThrow();
      expect(() => workspace.database.prepare(`
        INSERT INTO purchase_suggestion_events (
          id, suggestion_id, plan_id, event_type, quantity, reason,
          occurred_at, created_at
        ) VALUES ('bad-event-1', ?, ?, 'reduced', NULL, '缺数量', ?, ?)
      `).run(suggestionId, plan.id, '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z'))
        .toThrow();
      expect(() => removeVersion52ExtensionArtifacts(workspace.database))
        .toThrow('v52 测试降级前必须移除发货前退款与采购建议数据');
    } finally {
      workspace.close();
    }
  });
});
