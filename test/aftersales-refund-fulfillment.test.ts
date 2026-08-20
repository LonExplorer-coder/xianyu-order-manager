import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { projectAftersalesWorkflowSteps } from '../src/core/aftersales-workflow-templates';
import { LocalApplication } from '../src/main/local-application';
import { clearVersion58FundsData, removeVersion49ExtensionArtifacts } from './version31-fixture';

const applications: LocalApplication[] = [];
const unusedRecognizer: Recognizer = {
  recognize: async () => {
    throw new Error('售后退款测试不应调用 OCR');
  },
};

class OneOrderRecognizer implements Recognizer {
  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result: RecognitionResult = {
      platform: 'xianyu',
      sellerAccount: '售后退款测试账号',
      orderNumber: 'XY-REFUND-FULFILLMENT-0001',
      alipayTransactionNumber: 'ALI-REFUND-FULFILLMENT-0001',
      buyerNickname: '退款测试买家',
      recipient: '吴岚',
      phone: '13800000003',
      phoneNormalized: '13800000003',
      addressOriginal: '浙江省杭州市滨江区江南大道2号',
      addressNormalized: '浙江省杭州市滨江区江南大道2号',
      province: '浙江省',
      city: '杭州市',
      district: '滨江区',
      orderedAtOriginal: '2026-08-14 09:00:00',
      orderedAtNormalized: '2026-08-14T09:00:00+08:00',
      paidAtOriginal: '2026-08-14 09:00:08',
      paidAtNormalized: '2026-08-14T09:00:08+08:00',
      productTotalCents: 2_000,
      shippingFeeCents: 0,
      amountCents: 2_000,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: '退款测试商品',
        sourceSpec: '黑色',
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
  vi.setSystemTime(new Date('2026-08-14T02:10:00.000Z'));
});

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
  vi.useRealTimers();
});

async function openShippedApplication(): Promise<{
  application: LocalApplication;
  root: string;
  shipmentRecordId: string;
  shipmentPackageItemId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-refund-fulfillment-'));
  const dataDirectory = join(root, '数据');
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const sourcePath = join(sourceDirectory, '订单.png');
  await writeFile(sourcePath, Buffer.from('refund-fulfillment-order'));
  const application = new LocalApplication(new OneOrderRecognizer());
  applications.push(application);
  application.openDataDirectory(dataDirectory);
  const batch = await application.submitRecognitionBatch([sourcePath]);
  application.confirmDraft(batch.drafts[0]);
  const group = application.queryShipmentGroups().groups[0];
  const shipment = application.confirmShipment({
    groupId: group.id,
    expectedRemainingItems: group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    }))),
    packages: [{
      shippingCarrier: '顺丰速运',
      trackingNumber: 'SF-REFUND-FULFILLMENT-0001',
      items: group.orders.flatMap((order) => order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))),
    }],
  });
  const sourceRecord = application.updateShipmentPackageLogisticsStatus({
    recordId: shipment.record.id,
    packageId: shipment.record.packages[0].id,
    expectedRevision: shipment.record.packages[0].revision,
    logisticsStatus: 'delivered',
    occurredAt: '2026-08-14T10:20:00+08:00',
    reason: '售后退款测试前置：买家已签收',
  }).record;
  return {
    application,
    root,
    shipmentRecordId: sourceRecord.id,
    shipmentPackageItemId: sourceRecord.packages[0].items[0].id,
  };
}

function createRefundOnlyCase(
  application: LocalApplication,
  shipmentRecordId: string,
  shipmentPackageItemId: string,
  requestedRefundCents: number,
) {
  const refundOnly = application.listAftersalesWorkflowTemplates()
    .find(({ scenario }) => scenario === 'refund_only');
  if (!refundOnly) throw new Error('缺少仅退款预置流程');
  return application.createAftersalesCase({
    shipmentRecordId,
    workflowTemplateId: refundOnly.id,
    occurredAt: '2026-08-14T10:30:00+08:00',
    reason: '买家申请退款',
    requestedRefundCents,
    items: [{ shipmentPackageItemId, quantity: 1 }],
  });
}

describe('售后退款事实模型（规格 3.6 判断表）', () => {
  it('只有退款申请时判定未完成，等待确认实际退款', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );

    expect(created.refund).toMatchObject({
      status: 'pending',
      refundRecords: [],
      fulfillment: { kind: 'unfulfilled', refundedAmountCents: 0 },
    });
    expect(created.status).toBe('waiting_refund');
  });

  it('足额实际退款一次完成后判定已完成，既有单笔行为不变', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );

    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 1_000,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '平台账单足额退款',
    });

    expect(refunded).toMatchObject({
      status: 'ready_to_complete',
      refund: {
        status: 'confirmed',
        refundRecords: [{ amountCents: 1_000 }],
        fulfillment: { kind: 'complete', refundedAmountCents: 1_000 },
        timeline: [
          expect.objectContaining({ kind: 'created' }),
          expect.objectContaining({
            kind: 'confirmed', actualAmountCents: 1_000,
          }),
        ],
      },
    });
  });

  it('部分实际退款判定部分完成并显示已退与剩余，补退剩余金额后完成', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );

    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 300,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '先退部分款项',
    });

    expect(partial).toMatchObject({
      status: 'waiting_refund',
      revision: created.revision + 1,
      refund: {
        status: 'pending',
        refundRecords: [{ amountCents: 300 }],
        fulfillment: {
          kind: 'partial',
          refundedAmountCents: 300,
          remainingAmountCents: 700,
        },
      },
    });

    const completed = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: partial.id,
      expectedRevision: partial.revision,
      actualRefundCents: 700,
      occurredAt: '2026-08-14T10:50:00+08:00',
      note: '补退剩余金额',
    });

    expect(completed).toMatchObject({
      status: 'ready_to_complete',
      refund: {
        status: 'confirmed',
        refundRecords: [{ amountCents: 300 }, { amountCents: 700 }],
        fulfillment: { kind: 'complete', refundedAmountCents: 1_000 },
        timeline: [
          expect.objectContaining({ kind: 'created' }),
          expect.objectContaining({ kind: 'confirmed', actualAmountCents: 1_000 }),
        ],
      },
    });
  });

  it('补退时间不能早于上一笔实际退款', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );
    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 300,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '先退部分款项',
    });

    expect(() => application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: partial.id,
      expectedRevision: partial.revision,
      actualRefundCents: 700,
      occurredAt: '2026-08-14T10:35:00+08:00',
      note: '时间早于上一笔',
    })).toThrow('补退时间不能早于上一笔实际退款');
  });

  it('退款申请取消且没有实际退款时判定未完成', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );

    const cancelled = application.progressAftersalesCase({
      kind: 'cancel',
      caseId: created.id,
      expectedRevision: created.revision,
      reason: '买家撤销售后申请',
    });

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      refund: {
        status: 'cancelled',
        refundRecords: [],
        fulfillment: { kind: 'unfulfilled', refundedAmountCents: 0 },
      },
    });
  });

  it('退款发生在采用当前流程之前仍视为已完成并保留原发生时间', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const directReplacement = templates.find(
      ({ scenario }) => scenario === 'direct_replacement',
    );
    if (!directReplacement) throw new Error('缺少直接补发预置流程');
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 500,
    );
    const changed = application.changeAftersalesCaseWorkflowTemplate({
      caseId: created.id,
      expectedRevision: created.revision,
      workflowTemplateId: directReplacement.id,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '协商后改为直接补发',
    });

    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: changed.id,
      expectedRevision: changed.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-14T10:35:00+08:00',
      note: '退款发生在切换流程之前',
    });

    expect(refunded.refund).toMatchObject({
      status: 'confirmed',
      fulfillment: { kind: 'complete', refundedAmountCents: 500 },
      refundRecords: [expect.objectContaining({
        occurredAt: '2026-08-14T10:35:00+08:00',
      })],
    });
  });

  it('实退累计超过当前目标时判定金额冲突要求人工核对', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 500,
    );
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '足额退款',
    });

    const adjusted = application.progressAftersalesCase({
      kind: 'adjust_refund_target',
      caseId: refunded.id,
      expectedRevision: refunded.revision,
      requestedRefundCents: 300,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '双方核对后确认应退金额为 3 元',
    });

    expect(adjusted.refund).toMatchObject({
      requestedAmountCents: 300,
      status: 'confirmed',
      fulfillment: {
        kind: 'conflict',
        refundedAmountCents: 500,
        excessAmountCents: 200,
      },
      timeline: expect.arrayContaining([
        expect.objectContaining({
          kind: 'target_adjusted',
          beforeAmountCents: 500,
          requestedAmountCents: 300,
          reason: '双方核对后确认应退金额为 3 元',
        }),
      ]),
    });
  });

  it('调整退款目标到已退金额视为足额完成', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );
    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 300,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '先退部分款项',
    });

    const adjusted = application.progressAftersalesCase({
      kind: 'adjust_refund_target',
      caseId: partial.id,
      expectedRevision: partial.revision,
      requestedRefundCents: 300,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '协商确认只退 3 元',
    });

    expect(adjusted).toMatchObject({
      status: 'ready_to_complete',
      refund: {
        status: 'confirmed',
        fulfillment: { kind: 'complete', refundedAmountCents: 300 },
        timeline: [
          expect.objectContaining({ kind: 'created' }),
          expect.objectContaining({ kind: 'target_adjusted', beforeAmountCents: 1_000 }),
          expect.objectContaining({ kind: 'confirmed', actualAmountCents: 300 }),
        ],
      },
    });
  });

  it('上调已完成的退款目标回到待退款并支持补退', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 500,
    );
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '足额退款',
    });
    expect(refunded.status).toBe('ready_to_complete');

    const adjusted = application.progressAftersalesCase({
      kind: 'adjust_refund_target',
      caseId: refunded.id,
      expectedRevision: refunded.revision,
      requestedRefundCents: 800,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '买家补充凭证后上调应退金额',
    });

    expect(adjusted).toMatchObject({
      status: 'waiting_refund',
      refund: {
        status: 'pending',
        fulfillment: {
          kind: 'partial',
          refundedAmountCents: 500,
          remainingAmountCents: 300,
        },
      },
    });

    const completed = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: adjusted.id,
      expectedRevision: adjusted.revision,
      actualRefundCents: 300,
      occurredAt: '2026-08-14T11:00:00+08:00',
      note: '补退差额',
    });

    expect(completed.refund).toMatchObject({
      status: 'confirmed',
      fulfillment: { kind: 'complete', refundedAmountCents: 800 },
      refundRecords: [{ amountCents: 500 }, { amountCents: 300 }],
    });
  });

  it('部分退款后可以带原因结束退款，事件留痕且不把退款步骤视为完成', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );
    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 300,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '先退部分款项',
    });

    const ended = application.progressAftersalesCase({
      kind: 'end_refund',
      caseId: partial.id,
      expectedRevision: partial.revision,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '协商后买家接受不再补退剩余金额',
    });

    expect(ended).toMatchObject({
      status: 'ready_to_complete',
      refund: {
        status: 'ended',
        fulfillment: {
          kind: 'partial',
          refundedAmountCents: 300,
          remainingAmountCents: 700,
        },
        timeline: expect.arrayContaining([
          expect.objectContaining({
            kind: 'ended',
            requestedAmountCents: 1_000,
            actualAmountCents: 300,
            reason: '协商后买家接受不再补退剩余金额',
          }),
        ]),
      },
    });
    const refundStep = projectAftersalesWorkflowSteps(
      ended.workflowTemplate,
      ended,
    ).find((step) => step.kind === 'confirm_refund');
    expect(refundStep).toMatchObject({ state: expect.not.stringMatching(/^completed/u) });

    const completed = application.progressAftersalesCase({
      kind: 'complete',
      caseId: ended.id,
      expectedRevision: ended.revision,
      reason: '退款已结束，售后完结',
    });
    expect(completed.status).toBe('completed');
  });

  it('单笔确认金额即超过目标时直接形成金额冲突', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 500,
    );

    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 800,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '平台一次性退了 8 元',
    });

    expect(refunded.refund).toMatchObject({
      status: 'confirmed',
      requestedAmountCents: 500,
      refundRecords: [{ amountCents: 800 }],
      fulfillment: {
        kind: 'conflict',
        refundedAmountCents: 800,
        excessAmountCents: 300,
      },
    });
  });

  it('部分退款后不能取消退款申请，取消售后也不改写已发生的退款', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );
    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 300,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '先退部分款项',
    });

    expect(() => application.progressAftersalesCase({
      kind: 'cancel_refund_request',
      caseId: partial.id,
      expectedRevision: partial.revision,
      occurredAt: '2026-08-14T10:45:00+08:00',
      reason: '试图静默取消已部分退款的申请',
    })).toThrow('已发生实际退款，请改用结束退款或调整退款目标金额');

    const cancelled = application.progressAftersalesCase({
      kind: 'cancel',
      caseId: partial.id,
      expectedRevision: partial.revision,
      reason: '协商后取消本次售后',
    });

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      refund: {
        status: 'pending',
        refundRecords: [{ amountCents: 300 }],
        fulfillment: {
          kind: 'partial',
          refundedAmountCents: 300,
          remainingAmountCents: 700,
        },
      },
    });
  });

  it('结束退款与调整目标的守卫与版本要求', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );

    expect(() => application.progressAftersalesCase({
      kind: 'end_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '没有任何实际退款时不能结束',
    })).toThrow('结束退款前至少要有一笔实际退款');
    expect(() => application.progressAftersalesCase({
      kind: 'adjust_refund_target',
      caseId: created.id,
      expectedRevision: created.revision,
      requestedRefundCents: 1_000,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '目标没有变化',
    })).toThrow('退款目标金额没有变化');
    expect(() => application.progressAftersalesCase({
      kind: 'adjust_refund_target',
      caseId: created.id,
      expectedRevision: created.revision + 5,
      requestedRefundCents: 800,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '旧版本号',
    })).toThrow('售后处理单已在其他操作中更新，请刷新后重试');

    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 1_000,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '足额退款',
    });
    expect(() => application.progressAftersalesCase({
      kind: 'end_refund',
      caseId: refunded.id,
      expectedRevision: refunded.revision,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '足额后无需结束',
    })).toThrow('退款已足额，无需结束退款');
  });

  it('退款目标调整与结束事件不可被修改或删除', async () => {
    const { application, root, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );
    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 300,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '先退部分款项',
    });
    const adjusted = application.progressAftersalesCase({
      kind: 'adjust_refund_target',
      caseId: partial.id,
      expectedRevision: partial.revision,
      requestedRefundCents: 600,
      occurredAt: '2026-08-14T10:45:00+08:00',
      reason: '上调目标',
    });
    const ended = application.progressAftersalesCase({
      kind: 'end_refund',
      caseId: adjusted.id,
      expectedRevision: adjusted.revision,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '协商结束退款',
    });
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      expect(() => database.prepare(`
        UPDATE aftersales_refund_target_adjustment_events SET reason = '被篡改'
      `).run()).toThrow(/immutable/u);
      expect(() => database.prepare(`
        DELETE FROM aftersales_refund_target_adjustment_events
      `).run()).toThrow(/immutable/u);
      expect(() => database.prepare(`
        UPDATE aftersales_refund_ending_events SET reason = '被篡改'
      `).run()).toThrow(/immutable/u);
      expect(() => database.prepare(`
        DELETE FROM aftersales_refund_ending_events
      `).run()).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });

  it('既有单笔退款数据跨 v49 迁移后保留并可继续补退', async () => {
    const { application, root, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const created = createRefundOnlyCase(
      application, shipmentRecordId, shipmentPackageItemId, 1_000,
    );
    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 300,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '迁移前只有一笔实际退款',
    });
    const dataDirectory = join(root, '数据');
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const legacy = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
      enableForeignKeyConstraints: true,
    });
    try {
      clearVersion58FundsData(legacy);
      removeVersion49ExtensionArtifacts(legacy);
    } finally {
      legacy.close();
    }

    const reopened = new LocalApplication(unusedRecognizer);
    applications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    const migrated = reopened.queryAftersalesCases({ shipmentRecordId })[0];
    expect(migrated.refund).toMatchObject({
      status: 'pending',
      requestedAmountCents: 1_000,
      refundRecords: [{ amountCents: 300 }],
      fulfillment: {
        kind: 'partial',
        refundedAmountCents: 300,
        remainingAmountCents: 700,
      },
    });

    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      const secondRecordId = 'legacy-second-refund-record';
      database.prepare(`
        INSERT INTO financial_records (
          id, kind, pending_item_id, aftersales_case_id,
          amount_cents, occurred_at, note, created_at
        ) VALUES (?, 'aftersales_refund', ?, ?, 700, '2026-08-14T11:40:00+08:00', ?, ?)
      `).run(
        secondRecordId,
        migrated.refund?.pendingItemId as string,
        migrated.id,
        '迁移后补录第二笔实际退款',
        '2026-08-14T03:40:00.000Z',
      );
    } finally {
      database.close();
    }

    const afterInsert = reopened.queryAftersalesCases({ shipmentRecordId })[0];
    expect(afterInsert.refund).toMatchObject({
      status: 'pending',
      refundRecords: [{ amountCents: 300 }, { amountCents: 700 }],
      fulfillment: { kind: 'complete', refundedAmountCents: 1_000 },
    });
  });
});
