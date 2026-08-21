import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  deriveAftersalesWorkflowOperations,
  projectAftersalesWorkflowSteps,
} from '../src/core/aftersales-workflow-templates';
import { LocalApplication } from '../src/main/local-application';
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/main/workspace';
import { clearVersion58FundsData, removeVersion50ExtensionArtifacts } from './version31-fixture';

const applications: LocalApplication[] = [];

class OneOrderRecognizer implements Recognizer {
  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result: RecognitionResult = {
      platform: 'xianyu',
      sellerAccount: '售后验收测试账号',
      orderNumber: 'XY-WORKFLOW-ACCEPTANCE-0001',
      alipayTransactionNumber: 'ALI-WORKFLOW-ACCEPTANCE-0001',
      buyerNickname: '验收测试买家',
      recipient: '郑签',
      phone: '13800000004',
      phoneNormalized: '13800000004',
      addressOriginal: '浙江省宁波市海曙区验收路1号',
      addressNormalized: '浙江省宁波市海曙区验收路1号',
      province: '浙江省',
      city: '宁波市',
      district: '海曙区',
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
        sourceTitle: '验收测试商品',
        sourceSpec: '蓝色',
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
  dataDirectory: string;
  shipmentRecordId: string;
  shipmentPackageItemId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-aftersales-acceptance-'));
  const dataDirectory = join(root, '数据');
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const sourcePath = join(sourceDirectory, '订单.png');
  await writeFile(sourcePath, Buffer.from('aftersales-workflow-acceptance-order'));
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
      trackingNumber: 'SF-WORKFLOW-ACCEPTANCE-0001',
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
    reason: '验收前置：买家已签收',
  }).record;
  return {
    application,
    dataDirectory,
    shipmentRecordId: sourceRecord.id,
    shipmentPackageItemId: sourceRecord.packages[0].items[0].id,
  };
}

describe('可执行售后流程阶段验收', () => {
  it('规格 9.1 验收清单全量走查', async () => {
    const { application, shipmentRecordId, shipmentPackageItemId } =
      await openShippedApplication();
    const templates = application.listAftersalesWorkflowTemplates();
    const returnRefund = templates.find(({ scenario }) => scenario === 'return_refund');
    if (!returnRefund) throw new Error('缺少退货退款预置流程');

    // 第 10 条：模板不能创建任意脚本或系统未定义的业务动作。
    expect(() => application.createAftersalesWorkflowTemplate({
      name: '不安全流程', scenario: 'other', steps: [], script: 'while(true){}',
    })).toThrow(/循环、脚本|未定义/u);
    expect(() => application.createAftersalesWorkflowTemplate({
      name: '未定义动作流程',
      scenario: 'other',
      steps: [{
        id: 'legacy-note', kind: 'legacy_free_note', name: '旧版自由备注',
        required: true, fields: ['reason'], condition: null,
      }],
    })).toThrow('售后流程步骤必须绑定已定义的业务动作');

    // 第 1 条：自定义调整步骤顺序后，正常业务按钮按新顺序开放。
    const reordered = application.createAftersalesWorkflowTemplate({
      name: '先退款后退货的验收流程',
      scenario: 'return_refund',
      steps: [
        {
          id: 'identify', kind: 'identify_issue', name: '确认问题', required: true,
          fields: ['items', 'reason', 'requested_refund_amount'], condition: null,
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
          id: 'inspect-return', kind: 'inspect_return', name: '检查退回商品', required: true,
          fields: ['inspection_result'], condition: null,
        },
        {
          id: 'resolution', kind: 'record_resolution', name: '记录协商结论', required: true,
          fields: ['resolution_reason'], condition: null,
        },
        {
          id: 'complete', kind: 'complete', name: '完成售后', required: true,
          fields: ['resolution_reason'], condition: null,
        },
      ],
    });
    const created = application.createAftersalesCase({
      shipmentRecordId,
      workflowTemplateId: reordered.id,
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '9.1 全量走查',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId, quantity: 2 }],
    });
    const initialOperations = deriveAftersalesWorkflowOperations(
      created.workflowTemplate,
      created,
    );
    expect(initialOperations.primary.map(({ action }) => action)[0]).toBe('confirm_refund');

    // 第 2 条：没有实际收到退货时不能检查（入口阻止 + 领域拒绝）。
    expect(initialOperations.supplemental.find(({ action }) => action === 'inspect_return'))
      .toMatchObject({ blockedReason: '需先确认收到退货' });

    // 第 5 条：提前发生的真实退货可以补录（登记未轮到即可先记）。
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-ACCEPTANCE-0001',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '买家提前寄回',
    });
    expect(registered.returns).toHaveLength(1);
    expect(() => application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      result: 'resellable',
      occurredAt: '2026-08-14T10:45:00+08:00',
      note: '试图跳过收货直接检查',
      items: registered.returns[0].items.map((item) => ({
        returnRecordItemId: item.id,
        acceptedQuantity: item.quantity,
        result: 'resellable' as const,
        note: '完好',
      })),
      discrepancies: [],
    })).toThrow('当前退货记录尚不能登记检查结果');

    // 第 6 条：事实型步骤不能人工伪完成。
    expect(() => application.recordAftersalesWorkflowStepEvent({
      caseId: registered.id,
      expectedRevision: registered.revision,
      stepId: 'receive-return',
      kind: 'completed',
      reason: '试图手工勾选收货',
      occurredAt: '2026-08-14T10:46:00+08:00',
    })).toThrow('事实型流程步骤只能由真实业务事实满足');

    // 第 7 条：管理型步骤带原因跳过并可追溯。
    const skipped = application.recordAftersalesWorkflowStepEvent({
      caseId: registered.id,
      expectedRevision: registered.revision,
      stepId: 'resolution',
      kind: 'skipped',
      reason: '电话确认无需书面结论',
      remainingRisk: '缺少书面凭证',
      occurredAt: '2026-08-14T10:47:00+08:00',
    });
    expect(skipped.workflowTemplate.stepEvents[0]).toMatchObject({
      stepId: 'resolution',
      kind: 'skipped',
      remainingRisk: '缺少书面凭证',
      workflowTemplateVersion: 1,
    });

    // 第 4 条：部分退款显示已退金额与剩余金额。
    const partiallyRefunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: skipped.id,
      expectedRevision: skipped.revision,
      actualRefundCents: 400,
      occurredAt: '2026-08-14T10:50:00+08:00',
      note: '先退 4 元',
    });
    expect(projectAftersalesWorkflowSteps(
      partiallyRefunded.workflowTemplate,
      partiallyRefunded,
    ).find(({ kind }) => kind === 'confirm_refund')).toMatchObject({
      state: 'partial',
      progress: { kind: 'amount', refundedCents: 400, targetCents: 1_000 },
    });

    // 第 3 条：已有足额退款自动满足退款步骤，不重复退款。
    const fullyRefunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: partiallyRefunded.id,
      expectedRevision: partiallyRefunded.revision,
      actualRefundCents: 600,
      occurredAt: '2026-08-14T10:55:00+08:00',
      note: '补退剩余 6 元',
    });
    expect(projectAftersalesWorkflowSteps(
      fullyRefunded.workflowTemplate,
      fullyRefunded,
    ).find(({ kind }) => kind === 'confirm_refund')?.state).toBe('completed');
    expect(() => application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: fullyRefunded.id,
      expectedRevision: fullyRefunded.revision,
      actualRefundCents: 100,
      occurredAt: '2026-08-14T10:56:00+08:00',
      note: '试图重复退款',
    })).toThrow('当前没有待确认的退款申请');

    // 第 5 条（赔付）：提前发生的承运赔付可以补录，不受步骤顺序阻止。
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: fullyRefunded.id,
      expectedRevision: fullyRefunded.revision,
      returnRecordId: registered.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T10:58:00+08:00',
      reason: '已核对承运方揽收证据',
    });
    const withLoss = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: registered.returns[0].id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T10:59:00+08:00',
      reason: '承运方确认退货包裹丢失',
    });
    const withClaim = application.progressAftersalesCase({
      kind: 'open_carrier_claim',
      caseId: withLoss.id,
      expectedRevision: withLoss.revision,
      returnRecordId: registered.returns[0].id,
      requestedAmountCents: 200,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '申请承运赔付',
    });
    const claimApproved = application.progressAftersalesCase({
      kind: 'resolve_carrier_claim',
      caseId: withClaim.id,
      expectedRevision: withClaim.revision,
      returnRecordId: registered.returns[0].id,
      expectedClaimRevision: 1,
      outcome: 'approved',
      approvedAmountCents: 200,
      occurredAt: '2026-08-14T11:01:00+08:00',
      reason: '承运方同意赔付',
    });
    const compensated = application.progressAftersalesCase({
      kind: 'confirm_carrier_compensation',
      caseId: claimApproved.id,
      expectedRevision: claimApproved.revision,
      returnRecordId: registered.returns[0].id,
      expectedClaimRevision: 2,
      amountCents: 200,
      occurredAt: '2026-08-14T11:02:00+08:00',
      note: '承运方提前赔付到账',
    });
    expect(compensated.returns[0].carrierClaim?.actualCompensation)
      .toMatchObject({ amountCents: 200 });

    // 第 8 条：切换流程版本后已有事实不丢失，新步骤状态重新计算。
    const switched = application.changeAftersalesCaseWorkflowTemplate({
      caseId: compensated.id,
      expectedRevision: compensated.revision,
      workflowTemplateId: returnRefund.id,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '切回标准退货退款流程验收',
    });
    expect(switched.returns).toHaveLength(1);
    expect(switched.refund).toMatchObject({
      status: 'confirmed',
      fulfillment: { kind: 'complete', refundedAmountCents: 1_000 },
    });
    const switchedSteps = projectAftersalesWorkflowSteps(switched.workflowTemplate, switched);
    expect(switchedSteps.find(({ kind }) => kind === 'register_return')?.state)
      .toBe('completed');
    // 退货已确认丢失并获承运赔付：收货与检查步骤自动投影不再适用（规格 3.3/3.4）。
    expect(switchedSteps.find(({ kind }) => kind === 'receive_return')).toMatchObject({
      state: 'not_applicable',
      notApplicableReason: expect.stringContaining('退货包裹已确认丢失'),
    });
    expect(switchedSteps.find(({ kind }) => kind === 'inspect_return')?.state)
      .toBe('not_applicable');

    // 第 9 条：已完成或已取消售后不能切换版本。
    const ended = application.progressAftersalesCase({
      kind: 'complete',
      caseId: switched.id,
      expectedRevision: switched.revision,
      reason: '验收完结',
    });
    expect(() => application.changeAftersalesCaseWorkflowTemplate({
      caseId: ended.id,
      expectedRevision: ended.revision,
      workflowTemplateId: reordered.id,
      occurredAt: '2026-08-14T11:20:00+08:00',
      reason: '试图切换已完成的售后',
    })).toThrow('已结束的售后处理单不能调整后续流程');
  });

  it('从旧版本迁移的库完成模板一次性升级（含需要检查路径）并保持业务事实', async () => {
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
      reason: '迁移回归基线',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '迁移前足额退款',
    });
    const custom = application.createAftersalesWorkflowTemplate({
      name: '迁移前自定义流程',
      scenario: 'other',
      steps: [{
        id: 'identify', kind: 'identify_issue', name: '确认问题', required: true,
        fields: ['items', 'reason'], condition: null,
      }],
    });
    application.close();
    applications.splice(applications.indexOf(application), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      clearVersion58FundsData(legacy);
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
            id: 'identify', kind: 'identify_issue', name: '确认问题', required: true,
            fields: ['items', 'reason'], condition: null,
          },
          {
            id: 'legacy-note', kind: 'legacy_free_note', name: '旧版自由备注',
            required: true, fields: ['reason'], condition: null,
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

    const migrated = new LocalApplication(new OneOrderRecognizer());
    applications.push(migrated);
    migrated.openDataDirectory(dataDirectory);
    const verified = new DatabaseSync(databasePath);
    try {
      expect(verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: CURRENT_WORKSPACE_SCHEMA_VERSION });
      expect(verified.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema
        WHERE type = 'table' AND name = 'aftersales_case_step_events'
      `).get()).toEqual({ count: 1 });
    } finally {
      verified.close();
    }
    const restoredCase = migrated.queryAftersalesCases({ shipmentRecordId })
      .find(({ id }) => id === refunded.id);
    expect(restoredCase).toMatchObject({
      status: 'ready_to_complete',
      refund: {
        status: 'confirmed',
        requestedAmountCents: 500,
        fulfillment: { kind: 'complete', refundedAmountCents: 500 },
      },
    });
    expect(restoredCase?.workflowTemplate.stepEvents).toEqual([]);
    expect(migrated.listAftersalesWorkflowTemplates()
      .find(({ id }) => id === custom.id)?.steps
      .map(({ id, kind }) => ({ id, kind }))).toEqual([
        { id: 'identify', kind: 'identify_issue' },
        { id: 'legacy-note', kind: null },
      ]);
  });

  it('备份恢复后流程版本、步骤事件与业务事实保持一致', async () => {
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
      reason: '备份恢复基线',
      requestedRefundCents: 800,
      items: [{ shipmentPackageItemId, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-BACKUP-0001',
      occurredAt: '2026-08-14T10:40:00+08:00',
      reason: '买家寄回',
    });
    const partiallyRefunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: registered.id,
      expectedRevision: registered.revision,
      actualRefundCents: 300,
      occurredAt: '2026-08-14T10:50:00+08:00',
      note: '部分退款',
    });
    const withEvent = application.recordAftersalesWorkflowStepEvent({
      caseId: partiallyRefunded.id,
      expectedRevision: partiallyRefunded.revision,
      stepId: 'complete',
      kind: 'skipped',
      reason: '协商后按部分退款收尾',
      remainingRisk: '剩余 5 元不再补退',
      occurredAt: '2026-08-14T10:55:00+08:00',
    });
    expect(withEvent.workflowTemplate.stepEvents).toHaveLength(1);
    application.close();
    applications.splice(applications.indexOf(application), 1);

    // 备份：整库拷贝到新目录；恢复：从拷贝打开。
    const backupRoot = await mkdtemp(join(tmpdir(), 'xianyu-aftersales-backup-'));
    const backupDataDirectory = join(backupRoot, '数据');
    await mkdir(backupDataDirectory, { recursive: true });
    await cp(
      join(dataDirectory, 'xianyu-order-manager.sqlite3'),
      join(backupDataDirectory, 'xianyu-order-manager.sqlite3'),
    );
    const storageFile = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    expect(await readFile(storageFile)).toEqual(await readFile(
      join(backupDataDirectory, 'xianyu-order-manager.sqlite3'),
    ));

    const restored = new LocalApplication(new OneOrderRecognizer());
    applications.push(restored);
    restored.openDataDirectory(backupDataDirectory);
    const after = restored.queryAftersalesCases({ shipmentRecordId })
      .find(({ id }) => id === withEvent.id);
    expect(after).toBeDefined();
    if (!after) throw new Error('恢复后找不到售后处理单');
    expect(after.workflowTemplate).toEqual(withEvent.workflowTemplate);
    expect(after.refund).toEqual(withEvent.refund);
    expect(after.returns).toEqual(withEvent.returns);
    expect(after.coordination.handlingDirectionTimeline)
      .toEqual(withEvent.coordination.handlingDirectionTimeline);
    expect(after.timeline).toEqual(withEvent.timeline);
  });
});
