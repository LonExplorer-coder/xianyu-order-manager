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
import { LocalApplication } from '../src/main/local-application';
import { removeVersion38ExtensionArtifacts } from './version31-fixture';

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

async function openShippedApplication(): Promise<{
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
  const delivered = application.updateShipmentPackageLogisticsStatus({
    recordId: shipment.record.id,
    packageId: shipment.record.packages[0].id,
    expectedRevision: shipment.record.packages[0].revision,
    logisticsStatus: 'delivered',
    occurredAt: '2026-08-14T10:20:00+08:00',
    reason: '售后流程测试前置：买家已签收',
  });
  return {
    application,
    dataDirectory,
    shipmentRecordId: delivered.record.id,
    shipmentPackageItemId: delivered.record.packages[0].items[0].id,
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
    const replacementRound = changed.rounds.find((round) => (
      round.workflow === 'direct_replacement' && round.replacementRequired
    ));

    expect(changed).toMatchObject({
      workflow: 'direct_replacement',
      status: 'waiting_replacement',
      refund: {
        pendingItemId: created.refund?.pendingItemId,
        status: 'pending',
      },
    });
    expect(replacementRound).toMatchObject({
      roundNumber: 2,
      sourceShipmentRecordId: shipmentRecordId,
      items: [{ sourceShipmentPackageItemId: shipmentPackageItemId, quantity: 1 }],
      replacementShipment: null,
    });
    if (!replacementRound) throw new Error('切换后未建立待补发轮次');

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
  });

  it('将 v37 既有售后升级为冻结流程版本并保持不可变', async () => {
    const { application, dataDirectory, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const refundOnly = application.listAftersalesWorkflowTemplates().find(
      ({ scenario }) => scenario === 'refund_only',
    );
    if (!refundOnly) throw new Error('缺少仅退款预置流程');
    const existing = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: refundOnly.id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: 'v37 既有售后处理',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
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
    const verified = new DatabaseSync(databasePath);
    try {
      expect(verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 38 });
      expect(() => verified.prepare(`
        UPDATE aftersales_workflow_template_versions
        SET definition_json = '{"name":"覆盖"}'
      `).run()).toThrow(/immutable/u);
      expect(() => verified.prepare(`
        DELETE FROM aftersales_case_workflow_template_events
      `).run()).toThrow(/immutable/u);
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
});
