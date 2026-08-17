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
import {
  deriveAftersalesWorkflowOperations,
  projectAftersalesWorkflowSteps,
} from '../src/core/aftersales-workflow-templates';
import { LocalApplication } from '../src/main/local-application';

const applications: LocalApplication[] = [];

class OneOrderRecognizer implements Recognizer {
  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result: RecognitionResult = {
      platform: 'xianyu',
      sellerAccount: '售后操作测试账号',
      orderNumber: 'XY-WORKFLOW-OPERATION-0001',
      alipayTransactionNumber: 'ALI-WORKFLOW-OPERATION-0001',
      buyerNickname: '操作测试买家',
      recipient: '吴忧',
      phone: '13800000003',
      phoneNormalized: '13800000003',
      addressOriginal: '江苏省南京市玄武区中山路2号',
      addressNormalized: '江苏省南京市玄武区中山路2号',
      province: '江苏省',
      city: '南京市',
      district: '玄武区',
      orderedAtOriginal: '2026-08-14 10:00:00',
      orderedAtNormalized: '2026-08-14T10:00:00+08:00',
      paidAtOriginal: '2026-08-14 10:00:08',
      paidAtNormalized: '2026-08-14T10:00:08+08:00',
      productTotalCents: 2_000,
      shippingFeeCents: 0,
      amountCents: 2_000,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: '操作测试商品',
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
  shipmentRecordId: string;
  shipmentPackageItemId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-aftersales-operations-'));
  const dataDirectory = join(root, '数据');
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const sourcePath = join(sourceDirectory, '订单.png');
  await writeFile(sourcePath, Buffer.from('aftersales-workflow-operation-order'));
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
      trackingNumber: 'SF-WORKFLOW-OPERATION-0001',
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
    reason: '售后操作入口测试前置：买家已签收',
  }).record;
  return {
    application,
    shipmentRecordId: sourceRecord.id,
    shipmentPackageItemId: sourceRecord.packages[0].items[0].id,
  };
}

describe('售后流程操作入口', () => {
  it('主操作按当前模板的步骤顺序开放，自定义调整顺序后随之变化', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const returnRefund = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'return_refund',
    );
    if (!returnRefund) throw new Error('缺少退货退款预置流程');
    const standard = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: returnRefund.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '标准顺序测试',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    expect(deriveAftersalesWorkflowOperations(
      standard.workflowTemplate,
      standard,
    ).primary.map(({ action, blockedReason }) => ({ action, blockedReason })))
      .toEqual([{ action: 'register_return', blockedReason: null }]);

    const reordered = application.createAftersalesWorkflowTemplate({
      name: '先退款再收货的协商流程',
      scenario: 'return_refund',
      steps: [
        {
          id: 'identify', kind: 'identify_issue', name: '确认问题', required: true,
          fields: ['items', 'reason', 'requested_refund_amount'], condition: null,
        },
        {
          id: 'confirm-refund', kind: 'confirm_refund', name: '先行退款', required: true,
          fields: ['requested_refund_amount', 'occurred_at'], condition: null,
        },
        {
          id: 'register-return', kind: 'register_return', name: '登记退货物流', required: true,
          fields: ['shipping_carrier', 'tracking_number'], condition: null,
        },
        {
          id: 'receive-return', kind: 'receive_return', name: '确认收到退货', required: true,
          fields: ['received_quantity'], condition: null,
        },
        {
          id: 'inspect-return', kind: 'inspect_return', name: '检查退回商品', required: true,
          fields: ['inspection_result'], condition: null,
        },
        {
          id: 'complete', kind: 'complete', name: '完成售后', required: true,
          fields: ['resolution_reason'], condition: null,
        },
      ],
    });
    const custom = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: reordered.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '自定义顺序测试',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const operations = deriveAftersalesWorkflowOperations(
      custom.workflowTemplate,
      custom,
    );
    expect(operations.primary.map(({ action }) => action)).toEqual([
      'confirm_refund', 'adjust_refund_target', 'end_refund', 'cancel_refund_request',
    ]);
    expect(operations.supplemental.map(({ action, blockedReason }) => ({
      action,
      blockedReason,
    }))).toEqual(expect.arrayContaining([
      { action: 'receive_return', blockedReason: '买家尚未寄回，需先登记退货物流' },
      { action: 'inspect_return', blockedReason: '需先确认收到退货' },
    ]));
  });

  it('先行退款可以补录：未轮到的退款动作不受步骤顺序阻止', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const template = application.createAftersalesWorkflowTemplate({
      name: '先协商后补登记的退货退款',
      scenario: 'return_refund',
      steps: [
        {
          id: 'identify', kind: 'identify_issue', name: '确认问题', required: true,
          fields: ['items', 'reason', 'requested_refund_amount'], condition: null,
        },
        {
          id: 'resolution', kind: 'record_resolution', name: '记录协商结论', required: true,
          fields: ['resolution_reason'], condition: null,
        },
        {
          id: 'confirm-refund', kind: 'confirm_refund', name: '确认实际退款', required: true,
          fields: ['requested_refund_amount', 'occurred_at'], condition: null,
        },
        {
          id: 'register-return', kind: 'register_return', name: '登记退货物流', required: true,
          fields: ['shipping_carrier', 'tracking_number'], condition: null,
        },
        {
          id: 'receive-return', kind: 'receive_return', name: '确认收到退货', required: true,
          fields: ['received_quantity'], condition: null,
        },
        {
          id: 'complete', kind: 'complete', name: '完成售后', required: true,
          fields: ['resolution_reason'], condition: null,
        },
      ],
    });
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: template.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '商家先行退款测试',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId, quantity: 2 }],
    });
    const before = deriveAftersalesWorkflowOperations(
      created.workflowTemplate,
      created,
    );
    expect(before.primary).toEqual([]);
    expect(before.supplemental.find(({ action }) => action === 'confirm_refund'))
      .toMatchObject({ blockedReason: null });
    expect(before.supplemental.find(({ action }) => action === 'receive_return'))
      .toMatchObject({ blockedReason: '买家尚未寄回，需先登记退货物流' });

    const earlyRefunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 400,
      occurredAt: '2026-08-14T10:45:00+08:00',
      note: '买家信用良好，先行退回 4 元',
    });
    expect(earlyRefunded.refund).toMatchObject({
      status: 'pending',
      fulfillment: { kind: 'partial', refundedAmountCents: 400, remainingAmountCents: 600 },
    });

    const after = deriveAftersalesWorkflowOperations(
      earlyRefunded.workflowTemplate,
      earlyRefunded,
    );
    // 前面尚未完成的管理步骤继续保留：记录协商结论仍是当前待办。
    expect(projectAftersalesWorkflowSteps(earlyRefunded.workflowTemplate, earlyRefunded)
      .find(({ id }) => id === 'resolution')?.state).toBe('current');
    // 部分完成的退款步骤动作进入主入口，剩余金额可继续补退或带原因结束。
    expect(after.primary.map(({ action, blockedReason }) => ({ action, blockedReason })))
      .toEqual([
        { action: 'confirm_refund', blockedReason: null },
        { action: 'adjust_refund_target', blockedReason: null },
        { action: 'end_refund', blockedReason: null },
        {
          action: 'cancel_refund_request',
          blockedReason: '已发生实际退款，请改用结束退款或调整退款目标金额',
        },
      ]);
  });

  it('先行退款时间不能早于退款申请时间且完成后状态随之重算', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const returnRefund = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'return_refund',
    );
    if (!returnRefund) throw new Error('缺少退货退款预置流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: returnRefund.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '先行退款时间锚测试',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    expect(() => application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 400,
      occurredAt: '2026-08-14T10:25:00+08:00',
      note: '试图早于退款申请时间补录',
    })).toThrow('实际退款时间不能早于退款申请时间');

    const earlyFull = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 1_000,
      occurredAt: '2026-08-14T10:50:00+08:00',
      note: '足额先行退款',
    });
    expect(earlyFull.refund).toMatchObject({
      status: 'confirmed',
      fulfillment: { kind: 'complete', refundedAmountCents: 1_000 },
    });
    const operations = deriveAftersalesWorkflowOperations(
      earlyFull.workflowTemplate,
      earlyFull,
    );
    // 足额退款后退款步骤完成不再出现，当前主步骤推进到登记退货物流；
    // 收货与检查步骤受「已登记退货」条件控制，登记前不提供入口。
    expect(operations.primary.find(({ action }) => action === 'confirm_refund'))
      .toBeUndefined();
    expect(operations.primary).toEqual([
      { action: 'register_return', stepId: 'register-return', blockedReason: null },
    ]);
    expect(operations.supplemental.find(({ action }) => action === 'receive_return'))
      .toBeUndefined();

    // 完成动作只有轮到完成步骤时才开放；条件不满足时给出可见原因。
    const simple = application.createAftersalesWorkflowTemplate({
      name: '仅确认与完成的简化流程',
      scenario: 'refund_only',
      steps: [
        {
          id: 'identify', kind: 'identify_issue', name: '确认问题', required: true,
          fields: ['items', 'reason', 'requested_refund_amount'], condition: null,
        },
        {
          id: 'complete', kind: 'complete', name: '完成售后', required: true,
          fields: ['resolution_reason'], condition: null,
        },
      ],
    });
    const simpleCase = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: simple.id,
      occurredAt: '2026-08-14T11:30:00+08:00',
      reason: '完成入口阻止原因测试',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    expect(deriveAftersalesWorkflowOperations(
      simpleCase.workflowTemplate,
      simpleCase,
    ).primary.find(({ action }) => action === 'complete'))
      .toMatchObject({ blockedReason: '需先完成当前流程的必需步骤' });
  });
});
