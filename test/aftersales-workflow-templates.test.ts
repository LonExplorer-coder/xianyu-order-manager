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
import {
  AFTERSALES_WORKFLOW_STEP_BINDINGS,
  AFTERSALES_WORKFLOW_STEP_KINDS,
  aftersalesWorkflowStepCategoryLabel,
  projectAftersalesWorkflowSteps,
} from '../src/core/aftersales-workflow-templates';
import { LocalApplication } from '../src/main/local-application';
import { removeVersion38ExtensionArtifacts, removeVersion50ExtensionArtifacts } from './version31-fixture';

const applications: LocalApplication[] = [];
const unusedRecognizer: Recognizer = {
  recognize: async () => {
    throw new Error('售后流程模板测试不应调用 OCR');
  },
};

class OneOrderRecognizer implements Recognizer {
  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result: RecognitionResult = {
      platform: 'xianyu',
      sellerAccount: '售后流程测试账号',
      orderNumber: 'XY-WORKFLOW-TEMPLATE-0001',
      alipayTransactionNumber: 'ALI-WORKFLOW-TEMPLATE-0001',
      buyerNickname: '流程测试买家',
      recipient: '周雨',
      phone: '13800000002',
      phoneNormalized: '13800000002',
      addressOriginal: '浙江省杭州市西湖区文一路1号',
      addressNormalized: '浙江省杭州市西湖区文一路1号',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
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
        sourceTitle: '流程测试商品',
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
  vi.setSystemTime(new Date('2026-08-14T02:10:00.000Z'));
});

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
  vi.useRealTimers();
});

async function openApplication(): Promise<{
  application: LocalApplication;
  dataDirectory: string;
}> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-aftersales-workflows-'));
  const application = new LocalApplication(unusedRecognizer);
  applications.push(application);
  application.openDataDirectory(dataDirectory);
  return { application, dataDirectory };
}

async function openShippedApplication(deliver = true): Promise<{
  application: LocalApplication;
  dataDirectory: string;
  shipmentRecordId: string;
  shipmentPackageItemId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-aftersales-workflow-case-'));
  const dataDirectory = join(root, '数据');
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const sourcePath = join(sourceDirectory, '订单.png');
  await writeFile(sourcePath, Buffer.from('aftersales-workflow-template-order'));
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
      trackingNumber: 'SF-WORKFLOW-TEMPLATE-0001',
      items: group.orders.flatMap((order) => order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))),
    }],
  });
  const sourceRecord = deliver
    ? application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipment.record.packages[0].id,
      expectedRevision: shipment.record.packages[0].revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-14T10:20:00+08:00',
      reason: '售后流程测试前置：买家已签收',
    }).record
    : shipment.record;
  return {
    application,
    dataDirectory,
    shipmentRecordId: sourceRecord.id,
    shipmentPackageItemId: sourceRecord.packages[0].items[0].id,
  };
}

describe('售后流程模板', () => {
  it('新数据目录提供七套带版本的只读预置流程', async () => {
    const { application } = await openApplication();

    const templates = application.listAftersalesWorkflowTemplates();

    expect(templates.map((template) => ({
      name: template.name,
      scenario: template.scenario,
      origin: template.origin,
      enabled: template.enabled,
      version: template.version,
    }))).toEqual([
      { name: '仅退款', scenario: 'refund_only', origin: 'system', enabled: true, version: 1 },
      { name: '退货退款', scenario: 'return_refund', origin: 'system', enabled: true, version: 1 },
      { name: '换货', scenario: 'exchange', origin: 'system', enabled: true, version: 1 },
      { name: '直接补发', scenario: 'direct_replacement', origin: 'system', enabled: true, version: 1 },
      { name: '拦截退回', scenario: 'intercept_return', origin: 'system', enabled: true, version: 1 },
      { name: '丢件处理', scenario: 'lost_handling', origin: 'system', enabled: true, version: 1 },
      { name: '其他处理', scenario: 'other', origin: 'system', enabled: true, version: 1 },
    ]);
    expect(templates.every((template) => template.steps.length >= 2)).toBe(true);
  });

  it('预置流程可以停用并在重启后保持，但不能改写其内容', async () => {
    const { application, dataDirectory } = await openApplication();
    const refundOnly = application.listAftersalesWorkflowTemplates()[0];

    const disabled = application.setAftersalesWorkflowTemplateEnabled(refundOnly.id, false);

    expect(disabled).toMatchObject({
      id: refundOnly.id,
      origin: 'system',
      enabled: false,
      version: 1,
    });
    expect(() => application.updateAftersalesWorkflowTemplate(refundOnly.id, {
      expectedVersion: 1,
      name: '改名后的仅退款',
      scenario: refundOnly.scenario,
      steps: refundOnly.steps,
    })).toThrow('系统预置售后流程不能修改，请复制后调整');

    application.close();
    applications.splice(applications.indexOf(application), 1);
    const reopened = new LocalApplication(unusedRecognizer);
    applications.push(reopened);
    reopened.openDataDirectory(dataDirectory);

    expect(reopened.listAftersalesWorkflowTemplates()[0]).toMatchObject({
      id: refundOnly.id,
      enabled: false,
      version: 1,
    });
  });

  it('可以从空白或预置流程建立自定义流程，并以新版本保存步骤调整', async () => {
    const { application } = await openApplication();
    const presets = application.listAftersalesWorkflowTemplates();
    const returnRefund = presets.find(({ scenario }) => scenario === 'return_refund');
    if (!returnRefund) throw new Error('缺少退货退款预置流程');

    const blank = application.createAftersalesWorkflowTemplate({
      name: '客服协商处理',
      scenario: 'other',
      steps: [
        {
          id: 'identify',
          kind: 'identify_issue',
          name: '核对问题商品',
          required: true,
          fields: ['items', 'reason', 'occurred_at'],
          condition: null,
        },
        {
          id: 'resolution',
          kind: 'record_resolution',
          name: '记录协商结果',
          required: false,
          fields: ['resolution_reason'],
          condition: { fact: 'logistics_exception_present', equals: true },
        },
      ],
    });
    const copied = application.copyAftersalesWorkflowTemplate({
      sourceTemplateId: returnRefund.id,
      name: '大额退货退款',
    });

    expect(blank).toMatchObject({ origin: 'custom', enabled: true, version: 1 });
    expect(copied).toMatchObject({
      origin: 'custom',
      enabled: true,
      version: 1,
      scenario: 'return_refund',
      steps: returnRefund.steps,
    });
    const reorderedSteps = [...copied.steps].reverse().map((step, index) => ({
      ...step,
      required: index !== 0,
    }));
    const updated = application.updateAftersalesWorkflowTemplate(copied.id, {
      expectedVersion: 1,
      name: copied.name,
      scenario: copied.scenario,
      steps: reorderedSteps,
    });

    expect(updated).toMatchObject({
      id: copied.id,
      origin: 'custom',
      version: 2,
      steps: reorderedSteps,
    });
    expect(returnRefund).toEqual(presets.find(({ scenario }) => scenario === 'return_refund'));
  });

  it('售后处理单冻结建立时所选模板版本，后续模板修改只影响新处理单', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const directReplacement = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'direct_replacement',
    );
    if (!directReplacement) throw new Error('缺少直接补发预置流程');
    const custom = application.copyAftersalesWorkflowTemplate({
      sourceTemplateId: directReplacement.id,
      name: '客服补发标准流程',
    });

    const first = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: custom.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '第一件商品需要补发',
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const updatedTemplate = application.updateAftersalesWorkflowTemplate(custom.id, {
      expectedVersion: custom.version,
      name: custom.name,
      scenario: custom.scenario,
      steps: [...custom.steps].reverse(),
    });
    const second = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: custom.id,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '第二件商品需要补发',
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    const cases = application.queryAftersalesCases({ shipmentRecordId });
    expect(first).toMatchObject({
      workflow: 'direct_replacement',
      workflowTemplate: {
        templateId: custom.id,
        version: 1,
        name: custom.name,
        steps: custom.steps,
      },
    });
    expect(second).toMatchObject({
      workflow: 'direct_replacement',
      workflowTemplate: {
        templateId: custom.id,
        version: 2,
        steps: updatedTemplate.steps,
      },
    });
    expect(cases.find(({ id }) => id === first.id)?.workflowTemplate.version).toBe(1);
  });

  it('所选模板决定底层处理方式，停用模板不能再用于新建售后', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const refundOnly = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'refund_only',
    );
    if (!refundOnly) throw new Error('缺少仅退款预置流程');
    application.setAftersalesWorkflowTemplateEnabled(refundOnly.id, false);

    expect(() => application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '模板停用时不得建单',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    })).toThrow('所选售后流程已经停用');

    application.setAftersalesWorkflowTemplateEnabled(refundOnly.id, true);
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:31:00+08:00',
      reason: '模板重新启用后建立仅退款',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    expect(created).toMatchObject({
      workflow: 'refund_only',
      status: 'waiting_refund',
      refund: { requestedAmountCents: 500, status: 'pending' },
      workflowTemplate: { templateId: refundOnly.id, version: 1 },
    });
  });

  it('处理中切换场景只调整后续步骤并保留已有退款事实', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const refundOnly = templates.find(({ scenario }) => scenario === 'refund_only');
    const returnRefund = templates.find(({ scenario }) => scenario === 'return_refund');
    if (!refundOnly || !returnRefund) throw new Error('缺少退款类预置流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '先与买家协商仅退款',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    const changed = application.changeAftersalesCaseWorkflowTemplate({
      caseId: created.id,
      expectedRevision: created.revision,
      workflowTemplateId: returnRefund.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '协商后改为买家寄回再退款',
    });

    expect(changed).toMatchObject({
      workflow: 'return_refund',
      status: 'waiting_return',
      revision: 2,
      refund: {
        pendingItemId: created.refund?.pendingItemId,
        requestedAmountCents: 500,
        status: 'pending',
      },
      workflowTemplate: {
        templateId: returnRefund.id,
        version: 1,
        timeline: [{ kind: 'selected' }, {
          kind: 'changed',
          before: { templateId: refundOnly.id, version: 1 },
          after: { templateId: returnRefund.id, version: 1 },
          reason: '协商后改为买家寄回再退款',
        }],
      },
    });
    expect(projectAftersalesWorkflowSteps(changed.workflowTemplate, changed))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'choose_resolution', state: 'completed' }),
        expect.objectContaining({ kind: 'register_return', state: 'current' }),
      ]));

    const changedBack = application.changeAftersalesCaseWorkflowTemplate({
      caseId: changed.id,
      expectedRevision: changed.revision,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '买家放弃寄回，改回仅退款',
    });
    expect(changedBack.coordination).toMatchObject({
      handlingDirection: null,
      handlingDirectionTimeline: [{
        kind: 'selected',
        before: null,
        after: 'buyer_return',
      }, {
        kind: 'cleared',
        before: 'buyer_return',
        after: null,
        reason: '买家放弃寄回,改回仅退款',
      }],
    });
  });

  it('切换到直接补发后建立可执行的新处理轮次并保留原退款事实', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const refundOnly = templates.find(({ scenario }) => scenario === 'refund_only');
    const directReplacement = templates.find(
      ({ scenario }) => scenario === 'direct_replacement',
    );
    if (!refundOnly || !directReplacement) throw new Error('缺少预置售后流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '先与买家协商仅退款',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    const changed = application.changeAftersalesCaseWorkflowTemplate({
      caseId: created.id,
      expectedRevision: created.revision,
      workflowTemplateId: directReplacement.id,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '协商后改为直接补发',
    });
    expect(changed).toMatchObject({
      workflow: 'direct_replacement',
      status: 'waiting_replacement',
      rounds: [expect.objectContaining({ roundNumber: 1, workflow: 'legacy' })],
      refund: {
        pendingItemId: created.refund?.pendingItemId,
        status: 'pending',
      },
    });
    const replacementRound = changed.rounds[0];

    const progressed = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: changed.id,
      roundId: replacementRound.id,
      expectedRevision: changed.revision,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '按调整后的流程建立补发记录',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-WORKFLOW-CHANGED-0001',
        items: replacementRound.items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });

    expect(progressed.rounds.find(({ id }) => id === replacementRound.id))
      .toMatchObject({
        replacementShipment: {
          packages: [{ trackingNumber: 'SF-WORKFLOW-CHANGED-0001' }],
        },
      });
    expect(progressed.refund?.pendingItemId).toBe(created.refund?.pendingItemId);

    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: progressed.id,
      expectedRevision: progressed.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-14T11:00:00+08:00',
      note: '切换流程后仍确认原退款申请',
    });
    expect(refunded).toMatchObject({
      status: 'waiting_replacement',
      refund: {
        status: 'confirmed',
        refundRecords: [{ amountCents: 500 }],
        fulfillment: { kind: 'complete', refundedAmountCents: 500 },
      },
    });
  });

  it('切换到无退款步骤的流程后仍可取消原待处理退款', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const refundOnly = templates.find(({ scenario }) => scenario === 'refund_only');
    const other = templates.find(({ scenario }) => scenario === 'other');
    if (!refundOnly || !other) throw new Error('缺少预置售后流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '先登记退款申请',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const changed = application.changeAftersalesCaseWorkflowTemplate({
      caseId: created.id,
      expectedRevision: created.revision,
      workflowTemplateId: other.id,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '改为其他协商处理',
    });

    const cancelled = application.progressAftersalesCase({
      kind: 'cancel_refund_request',
      caseId: changed.id,
      expectedRevision: changed.revision,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '买家同意取消未发生的退款',
    });

    expect(cancelled).toMatchObject({
      workflow: 'general',
      status: 'processing',
      refund: { status: 'cancelled' },
    });
  });

  it('切换到换货后既有退货事实直接满足对应步骤并可建立补发', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const returnRefund = templates.find(({ scenario }) => scenario === 'return_refund');
    const exchange = templates.find(({ scenario }) => scenario === 'exchange');
    if (!returnRefund || !exchange) throw new Error('缺少退货换货预置流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: returnRefund.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '首先按退货退款处理',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-WORKFLOW-OLD-ROUND',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '买家寄回原商品',
    });
    const returnRecord = registered.returns[0];
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnRecord.id,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '仓库收到原退货',
      items: returnRecord.items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.quantity,
      })),
      discrepancies: [],
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: returnRecord.id,
      result: 'resellable',
      occurredAt: '2026-08-14T11:00:00+08:00',
      note: '原退货检查完成',
      items: returnRecord.items.map((item) => ({
        returnRecordItemId: item.id,
        acceptedQuantity: item.quantity,
        result: 'resellable' as const,
        note: '原商品完好',
      })),
      discrepancies: [],
    });
    const changed = application.changeAftersalesCaseWorkflowTemplate({
      caseId: inspected.id,
      expectedRevision: inspected.revision,
      workflowTemplateId: exchange.id,
      occurredAt: '2026-08-14T11:10:00+08:00',
      reason: '协商后改为换货',
    });

    // 切换不从第一步重新开始：既有退货事实直接满足登记、收货与检查步骤。
    const steps = projectAftersalesWorkflowSteps(changed.workflowTemplate, changed);
    expect(steps.find(({ kind }) => kind === 'register_return')?.state).toBe('completed');
    expect(steps.find(({ kind }) => kind === 'receive_return')?.state).toBe('completed');
    expect(steps.find(({ kind }) => kind === 'inspect_return')?.state).toBe('completed');
    expect(steps.find(({ kind }) => kind === 'prepare_replacement')?.state).toBe('current');
  });

  it('自定义字段要求未满足时指引步骤不会误标为已完成', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const custom = application.createAftersalesWorkflowTemplate({
      name: '须核对检查结果的协商流程',
      scenario: 'other',
      steps: [{
        id: 'identify-with-inspection',
        kind: 'identify_issue',
        name: '核对商品与检查结果',
        required: true,
        fields: ['items', 'reason', 'inspection_result'],
        condition: null,
      }],
    });
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: custom.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '尚未完成退货检查',
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    expect(projectAftersalesWorkflowSteps(created.workflowTemplate, created))
      .toEqual([expect.objectContaining({
        kind: 'identify_issue',
        state: 'current',
        fields: ['items', 'reason', 'inspection_result'],
      })]);
  });

  it('丢件处理预置可真实选择买家侧处理并更新指引', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication(false);
    const lostHandling = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'lost_handling',
    );
    if (!lostHandling) throw new Error('缺少丢件处理预置流程');
    const shipmentPackage = application.queryShipmentGroupArchives()[0]
      .records.find(({ id }) => id === shipmentRecordId)?.packages[0];
    if (!shipmentPackage) throw new Error('测试前置包裹不存在');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: lostHandling.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '包裹长时间无物流轨迹',
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipmentRecordId,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '已核对承运方揽收证据',
    });
    const withLoss = application.recordShipmentPackageLogisticsException({
      recordId: shipmentRecordId,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: shipmentPackageItemId, quantity: 1 }],
      },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '承运方确认一件商品丢失',
    });
    const current = application.queryAftersalesCases({ shipmentRecordId })
      .find(({ id }) => id === created.id);
    const exceptionId = withLoss.record.packages[0].currentException?.id;
    if (!current || !exceptionId) throw new Error('丢件售后投影不存在');

    const decided = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: current.id,
      expectedRevision: current.revision,
      packageId: shipmentPackage.id,
      exceptionId,
      decision: 'refund_only',
      requestedRefundCents: 500,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '与买家协商后选择仅退款',
    });
    const steps = projectAftersalesWorkflowSteps(decided.workflowTemplate, decided);

    expect(decided).toMatchObject({
      workflow: 'general',
      refund: { requestedAmountCents: 500, status: 'pending' },
      coordination: {
        outboundException: { decision: 'refund_only', stage: 'confirmed' },
      },
    });
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resolve_logistics_exception', state: 'completed' }),
      expect.objectContaining({ kind: 'choose_resolution', state: 'completed' }),
      expect.objectContaining({ kind: 'confirm_refund', state: 'current' }),
    ]));
  });

  it('多包裹补发只签收一个时不会误标全部签收完成', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const directReplacement = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'direct_replacement',
    );
    if (!directReplacement) throw new Error('缺少直接补发预置流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: directReplacement.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '两件商品分两个包裹补发',
      items: [{ shipmentPackageItemId, quantity: 2 }],
    });
    const round = created.rounds.find(({ replacementRequired }) => replacementRequired);
    if (!round) throw new Error('待补发轮次不存在');
    const replacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: created.id,
      expectedRevision: created.revision,
      roundId: round.id,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '建立两个补发包裹',
      packages: [1, 2].map((index) => ({
        shippingCarrier: '顺丰速运',
        trackingNumber: `SF-WORKFLOW-MULTI-${index}`,
        items: [{ roundItemId: round.items[0].id, quantity: 1 }],
      })),
    });
    const replacementRecord = replacement.rounds.find(({ id }) => id === round.id)
      ?.replacementShipment;
    if (!replacementRecord) throw new Error('补发记录不存在');
    application.updateShipmentPackageLogisticsStatus({
      recordId: replacementRecord.id,
      packageId: replacementRecord.packages[0].id,
      expectedRevision: replacementRecord.packages[0].revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '仅第一个补发包裹签收',
    });
    const current = application.queryAftersalesCases({ shipmentRecordId })
      .find(({ id }) => id === created.id);
    if (!current) throw new Error('补发售后投影不存在');

    expect(projectAftersalesWorkflowSteps(current.workflowTemplate, current)
      .find(({ kind }) => kind === 'confirm_replacement_delivery'))
      .toMatchObject({
        state: 'partial',
        progress: { kind: 'quantity', doneQuantity: 1, totalQuantity: 2 },
      });
  });

  it('运输中切换到拦截退回后由显式动作申请拦截', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication(false);
    const templates = application.listAftersalesWorkflowTemplates();
    const refundOnly = templates.find(({ scenario }) => scenario === 'refund_only');
    const interceptReturn = templates.find(({ scenario }) => scenario === 'intercept_return');
    if (!refundOnly || !interceptReturn) throw new Error('缺少预置售后流程');
    const shipmentPackage = application.queryShipmentGroupArchives()[0]
      .records.find(({ id }) => id === shipmentRecordId)?.packages[0];
    if (!shipmentPackage) throw new Error('测试前置包裹不存在');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '运输中先登记退款申请',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    const changed = application.changeAftersalesCaseWorkflowTemplate({
      caseId: created.id,
      expectedRevision: created.revision,
      workflowTemplateId: interceptReturn.id,
      handlingDirection: 'intercept',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '协商后改为拦截原包裹并退款',
    });

    expect(changed).toMatchObject({
      workflow: 'return_refund',
      status: 'processing',
      coordination: {
        handlingDirection: 'intercept',
        interception: null,
      },
      workflowTemplate: { templateId: interceptReturn.id, version: 1 },
    });

    const withInterception = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: changed.id,
      expectedRevision: changed.revision,
      handlingDirection: 'intercept',
      interceptionPackageId: shipmentPackage.id,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '明确申请拦截指定包裹',
    });
    expect(withInterception.coordination.interception).toMatchObject({
      packageId: shipmentPackage.id,
      status: 'requested',
      timeline: [expect.objectContaining({ kind: 'requested' })],
    });
  });

  it('将 v37 既有售后升级为冻结流程版本并保持不可变', async () => {
    const { application, dataDirectory, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const refundOnly = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'refund_only',
    );
    const returnRefund = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'return_refund',
    );
    if (!refundOnly || !returnRefund) throw new Error('缺少退款预置流程');
    const existing = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: 'v37 既有售后处理',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const directionCase = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: returnRefund.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:31:00+08:00',
      reason: 'v37 方向事件保真测试',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const changedDirectionCase = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: directionCase.id,
      expectedRevision: directionCase.revision,
      handlingDirection: 'only_refund',
      occurredAt: '2026-08-14T10:32:00+08:00',
      reason: '协商后从买家寄回改为仅退款',
    });
    expect(changedDirectionCase.coordination.handlingDirectionTimeline.map(({ kind }) => kind))
      .toEqual(['selected', 'changed']);
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    let directionRowsBefore: unknown[] = [];
    try {
      directionRowsBefore = legacy.prepare(`
        SELECT sequence, id, case_id, kind, before_direction, after_direction,
          occurred_at, reason, created_at
        FROM aftersales_handling_direction_events
        WHERE case_id = ?
        ORDER BY sequence
      `).all(directionCase.id);
      removeVersion38ExtensionArtifacts(legacy);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 37 });
    } finally {
      legacy.close();
    }

    const migrated = new LocalApplication(unusedRecognizer);
    applications.push(migrated);
    migrated.openDataDirectory(dataDirectory);
    const restored = migrated.queryAftersalesCases({ shipmentRecordId })
      .find(({ id }) => id === existing.id);
    expect(restored).toMatchObject({
      workflow: 'refund_only',
      workflowTemplate: {
        templateId: 'system-aftersales-refund-only',
        version: 1,
        timeline: [{ kind: 'selected' }],
      },
    });
    expect(migrated.queryAftersalesCases({ shipmentRecordId })
      .find(({ id }) => id === directionCase.id)?.coordination.handlingDirectionTimeline)
      .toEqual(changedDirectionCase.coordination.handlingDirectionTimeline);
    const verified = new DatabaseSync(databasePath);
    try {
      expect(verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 58 });
      expect(() => verified.prepare(`
        UPDATE aftersales_workflow_template_versions
        SET definition_json = '{"name":"覆盖"}'
      `).run()).toThrow(/immutable/u);
      expect(() => verified.prepare(`
        DELETE FROM aftersales_case_workflow_template_events
      `).run()).toThrow(/immutable/u);
      expect(verified.prepare(`
        SELECT sequence, id, case_id, kind, before_direction, after_direction,
          occurred_at, reason, created_at
        FROM aftersales_handling_direction_events
        WHERE case_id = ?
        ORDER BY sequence
      `).all(directionCase.id)).toEqual(directionRowsBefore);
    } finally {
      verified.close();
    }

    migrated.close();
    applications.splice(applications.indexOf(migrated), 1);
    const reopened = new LocalApplication(unusedRecognizer);
    applications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    expect(reopened.queryAftersalesCases({ shipmentRecordId })
      .find(({ id }) => id === existing.id)?.workflowTemplate).toEqual(
      restored?.workflowTemplate,
    );
  });

  it('v38 替表后迁移失败会整体回滚 v37 方向数据与不可变约束', async () => {
    const { application, dataDirectory, shipmentRecordId, shipmentPackageItemId } =
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
      reason: '迁移失败回滚测试',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const changed = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: created.id,
      expectedRevision: created.revision,
      handlingDirection: 'only_refund',
      occurredAt: '2026-08-14T10:31:00+08:00',
      reason: '迁移前保留方向转换事实',
    });
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    let expectedDirectionRows: unknown[] = [];
    try {
      expectedDirectionRows = legacy.prepare(`
        SELECT sequence, id, case_id, kind, before_direction, after_direction,
          occurred_at, reason, created_at
        FROM aftersales_handling_direction_events
        WHERE case_id = ?
        ORDER BY sequence
      `).all(created.id);
      removeVersion38ExtensionArtifacts(legacy);
      legacy.exec(`
        CREATE TABLE aftersales_workflow_templates (
          id TEXT PRIMARY KEY
        ) STRICT;
      `);
    } finally {
      legacy.close();
    }

    const failedMigration = new LocalApplication(unusedRecognizer);
    expect(() => failedMigration.openDataDirectory(dataDirectory)).toThrow();
    failedMigration.close();

    const rolledBack = new DatabaseSync(databasePath);
    try {
      expect(rolledBack.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 37 });
      expect(rolledBack.prepare(`
        SELECT sequence, id, case_id, kind, before_direction, after_direction,
          occurred_at, reason, created_at
        FROM aftersales_handling_direction_events
        WHERE case_id = ?
        ORDER BY sequence
      `).all(created.id)).toEqual(expectedDirectionRows);
      expect(rolledBack.prepare(`
        SELECT name, type FROM sqlite_schema
        WHERE name IN (
          'aftersales_direction_events_by_case',
          'aftersales_direction_events_are_immutable_on_update',
          'aftersales_direction_events_are_immutable_on_delete'
        ) ORDER BY name
      `).all()).toEqual([
        { name: 'aftersales_direction_events_are_immutable_on_delete', type: 'trigger' },
        { name: 'aftersales_direction_events_are_immutable_on_update', type: 'trigger' },
        { name: 'aftersales_direction_events_by_case', type: 'index' },
      ]);
      expect((rolledBack.prepare(`
        PRAGMA table_info(aftersales_handling_direction_events)
      `).all() as Array<{ name: string; notnull: number }>)
        .find(({ name }) => name === 'after_direction')?.notnull).toBe(1);
      expect(rolledBack.prepare(`
        SELECT name FROM sqlite_schema
        WHERE name = 'aftersales_handling_direction_events_v38'
      `).get()).toBeUndefined();
      expect(() => rolledBack.prepare(`
        UPDATE aftersales_handling_direction_events
        SET reason = '不允许篡改'
        WHERE case_id = ?
      `).run(created.id)).toThrow(/immutable/u);
      rolledBack.exec('DROP TABLE aftersales_workflow_templates;');
    } finally {
      rolledBack.close();
    }

    const recovered = new LocalApplication(unusedRecognizer);
    applications.push(recovered);
    recovered.openDataDirectory(dataDirectory);
    expect(recovered.queryAftersalesCases({ shipmentRecordId })
      .find(({ id }) => id === created.id)).toMatchObject({
      coordination: {
        handlingDirection: 'only_refund',
        handlingDirectionTimeline: changed.coordination.handlingDirectionTimeline,
      },
    });
  });

  it('十二种步骤 kind 完整绑定已定义领域动作并区分事实型与管理型', () => {
    expect(AFTERSALES_WORKFLOW_STEP_BINDINGS).toEqual({
      identify_issue: { category: 'management', actions: ['start_next_round'] },
      choose_resolution: {
        category: 'management',
        actions: ['change_handling_direction', 'decide_outbound_logistics_exception'],
      },
      request_interception: {
        category: 'fact',
        actions: ['change_handling_direction', 'record_interception_result'],
      },
      register_return: {
        category: 'fact',
        actions: ['register_return', 'correct_return_logistics', 'update_return_logistics_status'],
      },
      receive_return: { category: 'fact', actions: ['receive_return'] },
      inspect_return: { category: 'fact', actions: ['inspect_return', 'inspect_intercepted_return'] },
      confirm_refund: {
        category: 'fact',
        actions: ['confirm_refund', 'adjust_refund_target', 'end_refund', 'cancel_refund_request'],
      },
      prepare_replacement: { category: 'fact', actions: ['create_replacement_shipment'] },
      confirm_replacement_delivery: { category: 'fact', actions: [] },
      resolve_logistics_exception: {
        category: 'fact',
        actions: [
          'decide_outbound_logistics_exception',
          'record_return_logistics_exception',
          'progress_return_logistics_exception',
          'decide_return_logistics_exception',
          'open_carrier_claim',
          'resolve_carrier_claim',
          'confirm_carrier_compensation',
        ],
      },
      record_resolution: { category: 'management', actions: [] },
      complete: { category: 'management', actions: ['complete'] },
    });
    expect(Object.keys(AFTERSALES_WORKFLOW_STEP_BINDINGS).sort())
      .toEqual([...AFTERSALES_WORKFLOW_STEP_KINDS].sort());
    expect(aftersalesWorkflowStepCategoryLabel('fact')).toBe('事实型');
    expect(aftersalesWorkflowStepCategoryLabel('management')).toBe('管理型');
  });

  it('绑定表覆盖除整案取消外的全部进度动作', () => {
    for (const { actions } of Object.values(AFTERSALES_WORKFLOW_STEP_BINDINGS)) {
      expect(new Set(actions).size).toBe(actions.length);
    }
    const boundActions = Object.values(AFTERSALES_WORKFLOW_STEP_BINDINGS)
      .flatMap(({ actions }) => [...actions]);
    expect([...new Set(boundActions)].sort()).toEqual([
      'adjust_refund_target',
      'cancel_refund_request',
      'change_handling_direction',
      'complete',
      'confirm_carrier_compensation',
      'confirm_refund',
      'correct_return_logistics',
      'create_replacement_shipment',
      'decide_outbound_logistics_exception',
      'decide_return_logistics_exception',
      'end_refund',
      'inspect_intercepted_return',
      'inspect_return',
      'open_carrier_claim',
      'progress_return_logistics_exception',
      'receive_return',
      'record_interception_result',
      'record_return_logistics_exception',
      'register_return',
      'resolve_carrier_claim',
      'start_next_round',
      'update_return_logistics_status',
    ]);
  });

  it('模板步骤不能绑定系统未定义的业务动作', async () => {
    const { application } = await openApplication();
    const legacyStep = {
      id: 'legacy-note',
      name: '旧版自由备注',
      required: true,
      fields: ['reason'],
      condition: null,
    };
    expect(() => application.createAftersalesWorkflowTemplate({
      name: '未定义动作流程',
      scenario: 'other',
      steps: [{ ...legacyStep, kind: 'legacy_free_note' }],
    })).toThrow('售后流程步骤必须绑定已定义的业务动作');
    expect(() => application.createAftersalesWorkflowTemplate({
      name: '未定义动作流程',
      scenario: 'other',
      steps: [{ ...legacyStep, kind: null }],
    })).toThrow('售后流程步骤必须绑定已定义的业务动作');
  });

  it('需要检查的步骤不参与执行推进且投影携带绑定与分类', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const refundOnly = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'refund_only',
    );
    if (!refundOnly) throw new Error('缺少仅退款预置流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '绑定投影测试',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    const steps = projectAftersalesWorkflowSteps({
      scenario: 'refund_only',
      stepEvents: [],
      steps: [
        {
          id: 'identify-issue',
          kind: 'identify_issue',
          name: '确认问题与退款申请',
          required: true,
          fields: [],
          condition: null,
        },
        {
          id: 'legacy-note',
          kind: null,
          name: '旧版自由备注',
          required: true,
          fields: ['reason'],
          condition: null,
        },
        {
          id: 'confirm-refund',
          kind: 'confirm_refund',
          name: '确认实际退款',
          required: true,
          fields: [],
          condition: null,
        },
      ],
    }, created);

    expect(steps.find(({ id }) => id === 'identify-issue')).toMatchObject({
      state: 'completed',
      binding: { category: 'management', actions: ['start_next_round'] },
    });
    expect(steps.find(({ id }) => id === 'legacy-note')).toMatchObject({
      kind: null,
      state: 'not_started',
      binding: null,
    });
    expect(steps.find(({ id }) => id === 'confirm-refund')).toMatchObject({
      state: 'current',
      binding: {
        category: 'fact',
        actions: ['confirm_refund', 'adjust_refund_target', 'end_refund', 'cancel_refund_request'],
      },
    });
  });

  it('存量自定义模板跨 v50 迁移后未绑定步骤标记需要检查并可修复', async () => {
    const { application, dataDirectory } = await openApplication();
    const custom = application.createAftersalesWorkflowTemplate({
      name: '迁移前自定义流程',
      scenario: 'other',
      steps: [{
        id: 'identify',
        kind: 'identify_issue',
        name: '确认问题',
        required: true,
        fields: ['items', 'reason'],
        condition: null,
      }],
    });
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      removeVersion50ExtensionArtifacts(legacy);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 49 });
      legacy.prepare(`
        INSERT INTO aftersales_workflow_template_versions (
          template_id, version, definition_json, created_at
        ) VALUES (?, 2, ?, '2026-08-14T03:00:00.000Z')
      `).run(custom.id, JSON.stringify({
        name: '迁移前自定义流程',
        scenario: 'other',
        steps: [
          {
            id: 'identify',
            kind: 'identify_issue',
            name: '确认问题',
            required: true,
            fields: ['items', 'reason'],
            condition: null,
          },
          {
            id: 'legacy-note',
            kind: 'legacy_free_note',
            name: '旧版自由备注',
            required: true,
            fields: ['reason'],
            condition: null,
          },
        ],
      }));
      legacy.prepare(`
        UPDATE aftersales_workflow_templates
        SET current_version = 2, updated_at = '2026-08-14T03:00:00.000Z'
        WHERE id = ?
      `).run(custom.id);
    } finally {
      legacy.close();
    }

    const migrated = new LocalApplication(unusedRecognizer);
    applications.push(migrated);
    migrated.openDataDirectory(dataDirectory);
    const verified = new DatabaseSync(databasePath);
    try {
      expect(verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 58 });
      expect(verified.prepare(`
        SELECT definition_json FROM aftersales_workflow_template_versions
        WHERE template_id = ? AND version = 2
      `).get(custom.id)).toMatchObject({
        definition_json: expect.stringContaining('"kind":null'),
      });
      expect(() => verified.prepare(`
        UPDATE aftersales_workflow_template_versions
        SET definition_json = '{"name":"覆盖"}'
      `).run()).toThrow(/immutable/u);
    } finally {
      verified.close();
    }

    const listed = migrated.listAftersalesWorkflowTemplates()
      .find(({ id }) => id === custom.id);
    expect(listed).toMatchObject({ version: 2 });
    expect(listed?.steps.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 'identify', kind: 'identify_issue' },
      { id: 'legacy-note', kind: null },
    ]);

    const copied = migrated.copyAftersalesWorkflowTemplate({
      sourceTemplateId: custom.id,
      name: '复制需要检查的流程',
    });
    expect(copied.steps.some(({ kind }) => kind === null)).toBe(true);

    const fixed = migrated.updateAftersalesWorkflowTemplate(custom.id, {
      expectedVersion: 2,
      name: '迁移前自定义流程',
      scenario: 'other',
      steps: [{
        id: 'identify',
        kind: 'identify_issue',
        name: '确认问题',
        required: true,
        fields: ['items', 'reason'],
        condition: null,
      }, {
        id: 'resolution',
        kind: 'record_resolution',
        name: '记录处理结果',
        required: true,
        fields: ['resolution_reason'],
        condition: null,
      }],
    });
    expect(fixed).toMatchObject({ version: 3 });
    expect(fixed.steps.every(({ kind }) => kind !== null)).toBe(true);

    const downgrade = new DatabaseSync(databasePath);
    try {
      expect(() => removeVersion50ExtensionArtifacts(downgrade))
        .toThrow('v50 测试降级前必须先移除需要检查的流程步骤');
    } finally {
      downgrade.close();
    }
  });

  it('部分退款与部分收到退货按金额和数量投影为部分完成', async () => {
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
      reason: '两件商品寄回后先退一部分',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId, quantity: 2 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-PARTIAL-RECEIVE',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '买家寄回两件',
    });
    const returnRecord = registered.returns[0];
    const partiallyReceived = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnRecord.id,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '包裹破损只收到一件',
      items: returnRecord.items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.quantity - 1,
      })),
      discrepancies: [],
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: partiallyReceived.id,
      expectedRevision: partiallyReceived.revision,
      returnRecordId: returnRecord.id,
      result: 'defective',
      occurredAt: '2026-08-14T10:55:00+08:00',
      note: '收到的一件存在破损',
      items: returnRecord.items.map((item) => ({
        returnRecordItemId: item.id,
        acceptedQuantity: 0,
        result: 'defective' as const,
        note: '破损不能再次销售',
      })),
      discrepancies: [],
    });
    const partiallyRefunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: inspected.id,
      expectedRevision: inspected.revision,
      actualRefundCents: 400,
      occurredAt: '2026-08-14T11:00:00+08:00',
      note: '先退 4 元',
    });

    const steps = projectAftersalesWorkflowSteps(
      partiallyRefunded.workflowTemplate,
      partiallyRefunded,
    );
    expect(steps.find(({ kind }) => kind === 'receive_return')).toMatchObject({
      state: 'partial',
      progress: { kind: 'quantity', doneQuantity: 1, totalQuantity: 2 },
    });
    expect(steps.find(({ kind }) => kind === 'confirm_refund')).toMatchObject({
      state: 'partial',
      progress: { kind: 'amount', refundedCents: 400, targetCents: 1_000 },
    });
    expect(steps.find(({ kind }) => kind === 'inspect_return')?.state).toBe('completed');
  });

  it('退货包裹确认丢失后收货与检查步骤自动投影不再适用', async () => {
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
      reason: '买家寄回后包裹丢失',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '顺丰速运',
      trackingNumber: 'SF-LOST-RETURN',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '买家寄回原商品',
    });
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T10:45:00+08:00',
      reason: '已核对承运方揽收证据',
    });
    const withLoss = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: accepted.returns[0].id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '承运方确认整个退货包裹丢失',
    });

    const steps = projectAftersalesWorkflowSteps(withLoss.workflowTemplate, withLoss);
    expect(steps.find(({ kind }) => kind === 'receive_return')).toMatchObject({
      state: 'not_applicable',
      notApplicableReason: expect.stringContaining('退货包裹已确认丢失'),
    });
    expect(steps.find(({ kind }) => kind === 'inspect_return')?.state).toBe('not_applicable');
    expect(steps.find(({ kind }) => kind === 'confirm_refund')?.state).toBe('current');
  });

  it('事实型流程步骤不能人工登记完成或跳过', async () => {
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
      reason: '事实步骤不可伪完成',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const receiveStep = created.workflowTemplate.steps.find(
      ({ kind }) => kind === 'receive_return',
    );
    if (!receiveStep) throw new Error('缺少收货步骤');

    expect(() => application.recordAftersalesWorkflowStepEvent({
      caseId: created.id,
      expectedRevision: created.revision,
      stepId: receiveStep.id,
      kind: 'completed',
      reason: '试图手工勾选完成',
      occurredAt: '2026-08-14T10:40:00+08:00',
    })).toThrow('事实型流程步骤只能由真实业务事实满足');
    expect(() => application.recordAftersalesWorkflowStepEvent({
      caseId: created.id,
      expectedRevision: created.revision,
      stepId: receiveStep.id,
      kind: 'skipped',
      reason: '试图跳过收货',
      remainingRisk: '商品去向不明',
      occurredAt: '2026-08-14T10:41:00+08:00',
    })).toThrow('事实型流程步骤只能由真实业务事实满足');
    expect(() => application.recordAftersalesWorkflowStepEvent({
      caseId: created.id,
      expectedRevision: created.revision,
      stepId: 'not-a-step',
      kind: 'completed',
      reason: '步骤不存在',
      occurredAt: '2026-08-14T10:42:00+08:00',
    })).toThrow('售后流程步骤不存在');
  });

  it('管理型步骤可明确完成或带原因跳过并留不可变事件', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const custom = application.createAftersalesWorkflowTemplate({
      name: '带管理确认的其他处理',
      scenario: 'other',
      steps: [
        {
          id: 'identify',
          kind: 'identify_issue',
          name: '确认问题',
          required: true,
          fields: ['items', 'reason'],
          condition: null,
        },
        {
          id: 'buyer-note',
          kind: 'record_resolution',
          name: '保存买家沟通凭证',
          required: true,
          fields: ['resolution_reason'],
          condition: null,
        },
        {
          id: 'complete',
          kind: 'complete',
          name: '完成售后',
          required: true,
          fields: ['resolution_reason'],
          condition: null,
        },
      ],
    });
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: custom.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '管理型步骤留痕测试',
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    expect(() => application.recordAftersalesWorkflowStepEvent({
      caseId: created.id,
      expectedRevision: created.revision + 1,
      stepId: 'buyer-note',
      kind: 'skipped',
      reason: '版本过期',
      remainingRisk: '无',
      occurredAt: '2026-08-14T10:31:00+08:00',
    })).toThrow('售后处理单已在其他操作中更新，请刷新后重试');
    expect(() => application.recordAftersalesWorkflowStepEvent({
      caseId: created.id,
      expectedRevision: created.revision,
      stepId: 'buyer-note',
      kind: 'skipped',
      reason: '电话确认无需书面凭证',
      occurredAt: '2026-08-14T10:31:00+08:00',
    })).toThrow('请填写 1 至 500 字的剩余风险说明');
    expect(() => application.recordAftersalesWorkflowStepEvent({
      caseId: created.id,
      expectedRevision: created.revision,
      stepId: 'identify',
      kind: 'completed',
      reason: '重复完成已满足步骤',
      occurredAt: '2026-08-14T10:32:00+08:00',
    })).toThrow('该流程步骤已由业务事实满足');

    const skipped = application.recordAftersalesWorkflowStepEvent({
      caseId: created.id,
      expectedRevision: created.revision,
      stepId: 'buyer-note',
      kind: 'skipped',
      reason: '电话确认无需书面凭证',
      remainingRisk: '缺少书面沟通凭证',
      occurredAt: '2026-08-14T10:33:00+08:00',
    });
    expect(skipped.revision).toBe(created.revision + 1);
    expect(skipped.workflowTemplate.stepEvents).toEqual([{
      id: expect.any(String) as string,
      stepId: 'buyer-note',
      kind: 'skipped',
      reason: '电话确认无需书面凭证',
      remainingRisk: '缺少书面沟通凭证',
      workflowTemplateId: custom.id,
      workflowTemplateVersion: 1,
      occurredAt: '2026-08-14T10:33:00+08:00',
      createdAt: '2026-08-14T02:10:00.000Z',
    }]);
    const steps = projectAftersalesWorkflowSteps(skipped.workflowTemplate, skipped);
    expect(steps.find(({ id }) => id === 'buyer-note')).toMatchObject({
      state: 'skipped',
      stepEvent: { kind: 'skipped', remainingRisk: '缺少书面沟通凭证' },
    });
    expect(steps.find(({ id }) => id === 'complete')?.state).toBe('current');

    expect(() => application.recordAftersalesWorkflowStepEvent({
      caseId: skipped.id,
      expectedRevision: skipped.revision,
      stepId: 'buyer-note',
      kind: 'completed',
      reason: '重复登记',
      occurredAt: '2026-08-14T10:34:00+08:00',
    })).toThrow('该流程步骤已登记完成或跳过');

    const secondCase = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: custom.id,
      occurredAt: '2026-08-14T10:35:00+08:00',
      reason: '管理型完成测试',
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const completedStep = application.recordAftersalesWorkflowStepEvent({
      caseId: secondCase.id,
      expectedRevision: secondCase.revision,
      stepId: 'buyer-note',
      kind: 'completed',
      reason: '买家聊天记录已存档',
      occurredAt: '2026-08-14T10:36:00+08:00',
    });
    expect(projectAftersalesWorkflowSteps(
      completedStep.workflowTemplate,
      completedStep,
    ).find(({ id }) => id === 'buyer-note')).toMatchObject({
      state: 'completed',
      stepEvent: { kind: 'completed', remainingRisk: null },
    });

    const cancelled = application.updateAftersalesCase({
      caseId: completedStep.id,
      expectedRevision: completedStep.revision,
      status: 'cancelled',
      reason: '后续不再处理',
      items: completedStep.items.map(({ shipmentPackageItemId, quantity }) => ({
        shipmentPackageItemId,
        quantity,
      })),
      changeReason: '后续不再处理',
    });
    expect(() => application.recordAftersalesWorkflowStepEvent({
      caseId: cancelled.id,
      expectedRevision: cancelled.revision,
      stepId: 'complete',
      kind: 'completed',
      reason: '结束后不能再登记',
      occurredAt: '2026-08-14T10:37:00+08:00',
    })).toThrow('已经结束的售后处理单不能登记流程步骤');
  });

  it('v51 流程步骤事件表随迁移建立且事件不可变', async () => {
    const { application, dataDirectory, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const other = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'other',
    );
    if (!other) throw new Error('缺少其他处理预置流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: other.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '步骤事件迁移测试',
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const withEvent = application.recordAftersalesWorkflowStepEvent({
      caseId: created.id,
      expectedRevision: created.revision,
      stepId: 'record-resolution',
      kind: 'completed',
      reason: '处理结论已记录',
      occurredAt: '2026-08-14T10:31:00+08:00',
    });
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 58 });
      expect(legacy.prepare(`
        SELECT step_id, kind, reason, remaining_risk, workflow_template_id,
          workflow_template_version, occurred_at
        FROM aftersales_case_step_events WHERE case_id = ?
      `).all(created.id)).toEqual([{
        step_id: 'record-resolution',
        kind: 'completed',
        reason: '处理结论已记录',
        remaining_risk: null,
        workflow_template_id: other.id,
        workflow_template_version: 1,
        occurred_at: '2026-08-14T10:31:00+08:00',
      }]);
      expect(() => legacy.prepare(`
        UPDATE aftersales_case_step_events SET reason = '覆盖'
      `).run()).toThrow(/immutable/u);
      expect(() => legacy.prepare(`
        DELETE FROM aftersales_case_step_events
      `).run()).toThrow(/immutable/u);
    } finally {
      legacy.close();
    }

    const reopened = new LocalApplication(unusedRecognizer);
    applications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    const restored = reopened.queryAftersalesCases({ shipmentRecordId })
      .find(({ id }) => id === created.id);
    expect(restored?.workflowTemplate.stepEvents).toEqual(
      withEvent.workflowTemplate.stepEvents,
    );
  });

  it('切换流程只保存选择事件，不再自动建立补发轮次或改写退款事实', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const returnRefund = templates.find(({ scenario }) => scenario === 'return_refund');
    const exchange = templates.find(({ scenario }) => scenario === 'exchange');
    if (!returnRefund || !exchange) throw new Error('缺少退货换货预置流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: returnRefund.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '退货检查后改为换货',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-SWITCH-EXCHANGE',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '买家寄回原商品',
    });
    const returnRecord = registered.returns[0];
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnRecord.id,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '仓库收到原退货',
      items: returnRecord.items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.quantity,
      })),
      discrepancies: [],
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: returnRecord.id,
      result: 'defective',
      occurredAt: '2026-08-14T11:00:00+08:00',
      note: '检查完成',
      items: returnRecord.items.map((item) => ({
        returnRecordItemId: item.id,
        acceptedQuantity: item.quantity,
        result: 'resellable' as const,
        note: '可再次销售',
      })),
      discrepancies: [],
    });
    expect(inspected.rounds).toHaveLength(1);

    const changed = application.changeAftersalesCaseWorkflowTemplate({
      caseId: inspected.id,
      expectedRevision: inspected.revision,
      workflowTemplateId: exchange.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T11:10:00+08:00',
      reason: '协商后改为换货',
    });

    // 切换不制造新事实：不新建换货轮次，也不改写已有退款申请。
    expect(changed.rounds).toHaveLength(1);
    expect(changed.refund).toMatchObject({
      status: 'pending',
      requestedAmountCents: 1_000,
      refundRecords: [],
    });
    // 已有事实直接满足新版本的对应步骤：登记、收货、检查都完成。
    const steps = projectAftersalesWorkflowSteps(changed.workflowTemplate, changed);
    expect(steps.find(({ kind }) => kind === 'register_return')?.state).toBe('completed');
    expect(steps.find(({ kind }) => kind === 'receive_return')?.state).toBe('completed');
    expect(steps.find(({ kind }) => kind === 'inspect_return')?.state).toBe('completed');

    // 已完成退货检查的换货直接在原始轮次上建立补发：既有事实就是本轮事实。
    const withReplacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: changed.id,
      expectedRevision: changed.revision,
      roundId: changed.rounds[0].id,
      occurredAt: '2026-08-14T11:20:00+08:00',
      reason: '按换货流程建立补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-SWITCH-EXCHANGE',
        items: changed.rounds[0].items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });
    expect(withReplacement.rounds).toHaveLength(1);
    expect(withReplacement.rounds[0].replacementShipment).toMatchObject({
      packages: [{ trackingNumber: 'SF-SWITCH-EXCHANGE' }],
    });
    expect(projectAftersalesWorkflowSteps(withReplacement.workflowTemplate, withReplacement)
      .find(({ kind }) => kind === 'prepare_replacement')?.state).toBe('completed');
  });

  it('切换到拦截退回只声明方向，拦截申请由显式动作建立', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication(false);
    const templates = application.listAftersalesWorkflowTemplates();
    const refundOnly = templates.find(({ scenario }) => scenario === 'refund_only');
    const interceptReturn = templates.find(({ scenario }) => scenario === 'intercept_return');
    if (!refundOnly || !interceptReturn) throw new Error('缺少预置售后流程');
    const shipmentPackage = application.queryShipmentGroupArchives()[0]
      .records.find(({ id }) => id === shipmentRecordId)?.packages[0];
    if (!shipmentPackage) throw new Error('测试前置包裹不存在');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '运输中先登记退款申请',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    const changed = application.changeAftersalesCaseWorkflowTemplate({
      caseId: created.id,
      expectedRevision: created.revision,
      workflowTemplateId: interceptReturn.id,
      handlingDirection: 'intercept',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '改为拦截退回',
    });

    // 切换只声明处理方向，不自动创建拦截申请。
    expect(changed.coordination.handlingDirection).toBe('intercept');
    expect(changed.coordination.interception).toBeNull();

    const withInterception = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: changed.id,
      expectedRevision: changed.revision,
      handlingDirection: 'intercept',
      interceptionPackageId: shipmentPackage.id,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '明确申请拦截指定包裹',
    });
    expect(withInterception.coordination.interception).toMatchObject({
      packageId: shipmentPackage.id,
      status: 'requested',
    });
  });

  it('已结束的售后处理单不能调整后续流程', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const refundOnly = templates.find(({ scenario }) => scenario === 'refund_only');
    const returnRefund = templates.find(({ scenario }) => scenario === 'return_refund');
    if (!refundOnly || !returnRefund) throw new Error('缺少退款类预置流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '已结束不能切换',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const completed = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '足额退款',
    });
    const ended = application.progressAftersalesCase({
      kind: 'complete',
      caseId: completed.id,
      expectedRevision: completed.revision,
      reason: '售后完结',
    });

    expect(() => application.changeAftersalesCaseWorkflowTemplate({
      caseId: ended.id,
      expectedRevision: ended.revision,
      workflowTemplateId: returnRefund.id,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '试图切换已完成的售后',
    })).toThrow('已结束的售后处理单不能调整后续流程');

    const cancelledCase = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '已取消不能切换',
      requestedRefundCents: 300,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const cancelled = application.progressAftersalesCase({
      kind: 'cancel',
      caseId: cancelledCase.id,
      expectedRevision: cancelledCase.revision,
      reason: '买家撤回售后',
    });
    expect(() => application.changeAftersalesCaseWorkflowTemplate({
      caseId: cancelled.id,
      expectedRevision: cancelled.revision,
      workflowTemplateId: returnRefund.id,
      occurredAt: '2026-08-14T11:10:00+08:00',
      reason: '试图切换已取消的售后',
    })).toThrow('已结束的售后处理单不能调整后续流程');
  });

  it('没有退款申请的售后不能切换到退款类流程', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const other = templates.find(({ scenario }) => scenario === 'other');
    const refundOnly = templates.find(({ scenario }) => scenario === 'refund_only');
    if (!other || !refundOnly) throw new Error('缺少预置售后流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: other.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '无退款申请的协商处理',
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });

    expect(() => application.changeAftersalesCaseWorkflowTemplate({
      caseId: created.id,
      expectedRevision: created.revision,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '试图切换到仅退款',
    })).toThrow('当前售后没有退款申请，不能切换到退款类流程');
  });

  it('切换到换货后未完成退货检查不能建立补发', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const returnRefund = templates.find(({ scenario }) => scenario === 'return_refund');
    const exchange = templates.find(({ scenario }) => scenario === 'exchange');
    if (!returnRefund || !exchange) throw new Error('缺少退货换货预置流程');
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: returnRefund.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '检查未完成即切换换货',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-EXCHANGE-UNINSPECTED',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '买家寄回原商品',
    });
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '仓库收到原退货',
      items: registered.returns[0].items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.quantity,
      })),
      discrepancies: [],
    });
    const changed = application.changeAftersalesCaseWorkflowTemplate({
      caseId: received.id,
      expectedRevision: received.revision,
      workflowTemplateId: exchange.id,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '未检查先切换换货',
    });

    expect(() => application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: changed.id,
      expectedRevision: changed.revision,
      roundId: changed.rounds[0].id,
      occurredAt: '2026-08-14T11:10:00+08:00',
      reason: '试图跳过检查建立补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-EXCHANGE-UNINSPECTED',
        items: changed.rounds[0].items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    })).toThrow('换货必须先完成本轮退货收货与检查');
  });
});
