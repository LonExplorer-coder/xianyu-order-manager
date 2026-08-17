import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
import { downgradeVersion35ToOriginalSchema } from './version31-fixture';

const openedApplications: LocalApplication[] = [];

class TwoOrderRecognizer implements Recognizer {
  private index = 0;

  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    this.index += 1;
    const result: RecognitionResult = {
      platform: 'xianyu',
      sellerAccount: '正向异常测试账号',
      orderNumber: `XY-OUTBOUND-EXCEPTION-${this.index}`,
      alipayTransactionNumber: `ALI-OUTBOUND-EXCEPTION-${this.index}`,
      buyerNickname: `测试买家${this.index}`,
      recipient: '林青',
      phone: '13800000001',
      phoneNormalized: '13800000001',
      addressOriginal: '广东省深圳市南山区海风路1号',
      addressNormalized: '广东省深圳市南山区海风路1号',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
      orderedAtOriginal: `2026-08-14 09:0${this.index}:00`,
      orderedAtNormalized: `2026-08-14T09:0${this.index}:00+08:00`,
      paidAtOriginal: `2026-08-14 09:0${this.index}:08`,
      paidAtNormalized: `2026-08-14T09:0${this.index}:08+08:00`,
      productTotalCents: 2_000,
      shippingFeeCents: 0,
      amountCents: 2_000,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: `合装商品${this.index}`,
        sourceSpec: '标准款',
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

async function createApplication() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-14T01:30:00.000Z'));
  const root = await mkdtemp(join(tmpdir(), 'xianyu-outbound-exception-'));
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const application = new LocalApplication(new TwoOrderRecognizer());
  openedApplications.push(application);
  application.openDataDirectory(join(root, '数据'));
  for (let index = 1; index <= 2; index += 1) {
    const sourcePath = join(sourceDirectory, `订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`outbound-exception-order-${index}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    application.confirmDraft(batch.drafts[0]);
  }
  const group = application.queryShipmentGroups().groups[0];
  const items = group.orders.flatMap((order) => order.items.map((item) => ({
    orderId: order.id,
    orderItemId: item.id,
    quantity: item.quantity,
  })));
  const shipment = application.confirmShipment({
    groupId: group.id,
    expectedRemainingItems: items,
    packages: [{
      shippingCarrier: '顺丰速运',
      trackingNumber: 'SF-OUTBOUND-EXCEPTION-001',
      items,
    }],
  });
  return { application, shipment, root };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
  vi.useRealTimers();
});

describe('正向发货异常上层处理', () => {
  it('早期 v35 选择事件升级后回填精确受影响商品数量', async () => {
    const { application, shipment, root } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const affectedItem = shipmentPackage.items[0];
    const occurredAt = (offsetMinutes: number) => new Date(
      Date.parse(shipment.record.createdAt) + offsetMinutes * 60_000,
    ).toISOString();
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      requestedRefundCents: 1_000,
      occurredAt: occurredAt(1),
      reason: '早期 v35 选择事件升级',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: occurredAt(2),
      reason: '承运方已揽收',
    });
    const damaged = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'damaged',
      stage: 'confirmed',
      impact: { scope: 'items', items: [{ sourceItemId: affectedItem.id, quantity: 1 }] },
      occurredAt: occurredAt(3),
      reason: '承运方确认一件破损',
    });
    const exceptionId = damaged.record.packages[0].currentException?.id;
    if (!exceptionId) throw new Error('测试前置异常不存在');
    let currentCase = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: created.revision,
      packageId: shipmentPackage.id,
      exceptionId,
      decision: 'replacement',
      occurredAt: occurredAt(4),
      reason: '早期版本选择补发',
    });
    const legacyRound = currentCase.rounds.find(({ replacementRequired }) => replacementRequired);
    if (!legacyRound) throw new Error('早期 v35 补发轮次不存在');
    currentCase = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: currentCase.id,
      expectedRevision: currentCase.revision,
      roundId: legacyRound.id,
      occurredAt: occurredAt(5),
      reason: '早期 v35 建立未交寄补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-LEGACY-V35-REPLACEMENT',
        items: legacyRound.items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });
    const legacyReplacement = currentCase.rounds.find(({ id }) => id === legacyRound.id)
      ?.replacementShipment;
    if (!legacyReplacement) throw new Error('早期 v35 补发记录不存在');
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);
    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      downgradeVersion35ToOriginalSchema(database);
    } finally {
      database.close();
    }
    const reopened = new LocalApplication(new TwoOrderRecognizer());
    openedApplications.push(reopened);
    reopened.openDataDirectory(join(root, '数据'));
    const migrated = reopened.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    expect(migrated.coordination.outboundExceptionHistory[0].timeline[0]).toMatchObject({
      exceptionId,
      after: 'replacement',
      affectedItems: [{
        shipmentPackageItemId: affectedItem.id,
        quantity: 1,
      }],
    });
    reopened.cancelShipmentPackages({
      recordId: legacyReplacement.id,
      packageIds: [legacyReplacement.packages[0].id],
      reason: '升级后作废早期 v35 补发并验证重试关联',
    });
    const afterRetry = reopened.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    expect(afterRetry.rounds.filter(({ replacementRequired }) => replacementRequired))
      .toMatchObject([{ items: [{ quantity: 1 }], replacementShipment: null }]);
    const migratedDatabase = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      expect(migratedDatabase.prepare(`
        SELECT COUNT(*) AS count
        FROM aftersales_outbound_exception_replacement_rounds
        WHERE exception_id = ?
      `).get(exceptionId)).toEqual({ count: 2 });
    } finally {
      migratedDatabase.close();
    }
  });

  it('早期 v35 已确认退款升级后回填当时有效的异常退款选择关联', async () => {
    const { application, shipment, root } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const affectedItem = shipmentPackage.items[0];
    const occurredAt = (offsetMinutes: number) => new Date(
      Date.parse(shipment.record.createdAt) + offsetMinutes * 60_000,
    ).toISOString();
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      requestedRefundCents: 1_000,
      occurredAt: occurredAt(1),
      reason: '早期 v35 退款关联升级',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: occurredAt(2),
      reason: '承运方已揽收',
    });
    const damaged = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'damaged',
      stage: 'confirmed',
      impact: { scope: 'items', items: [{ sourceItemId: affectedItem.id, quantity: 1 }] },
      occurredAt: occurredAt(3),
      reason: '承运方确认商品破损',
    });
    const exceptionId = damaged.record.packages[0].currentException?.id;
    if (!exceptionId) throw new Error('测试前置异常不存在');
    const decided = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: created.revision,
      packageId: shipmentPackage.id,
      exceptionId,
      decision: 'refund_only',
      occurredAt: occurredAt(4),
      reason: '早期 v35 选择仅退款',
    });
    application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: decided.id,
      expectedRevision: decided.revision,
      actualRefundCents: 1_000,
      occurredAt: occurredAt(5),
      note: '早期 v35 已确认退款',
    });
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);
    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      downgradeVersion35ToOriginalSchema(database);
      expect(database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE name = 'aftersales_outbound_exception_refund_links'
      `).get()).toBeUndefined();
    } finally {
      database.close();
    }
    const reopened = new LocalApplication(new TwoOrderRecognizer());
    openedApplications.push(reopened);
    reopened.openDataDirectory(join(root, '数据'));
    const migratedDatabase = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      expect(migratedDatabase.prepare(`
        SELECT links.financial_record_id, links.decision_event_id
        FROM aftersales_outbound_exception_refund_links AS links
        JOIN financial_records AS financial ON financial.id = links.financial_record_id
        JOIN aftersales_outbound_exception_decision_events AS decisions
          ON decisions.id = links.decision_event_id
        WHERE financial.aftersales_case_id = ?
          AND decisions.exception_id = ?
      `).all(created.id, exceptionId)).toHaveLength(1);
    } finally {
      migratedDatabase.close();
    }
  });

  it('按异常影响商品选择退款并补发，生成新发货记录且承运索赔独立推进', async () => {
    const { application, shipment, root } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const affectedItem = shipmentPackage.items[0];
    const unaffectedItem = shipmentPackage.items[1];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      requestedRefundCents: 1_000,
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '其中一笔订单商品长时间没有物流更新',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T10:05:00+08:00',
      reason: '承运方已确认揽收',
    });
    const lost = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: affectedItem.id, quantity: 1 }],
      },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T10:10:00+08:00',
      reason: '承运方书面确认其中一件丢失',
    });
    const exception = lost.record.packages[0].currentException;
    if (!exception) throw new Error('测试前置物流异常不存在');

    const pendingDecision = application.queryAftersalesCases({
      shipmentRecordId: shipment.record.id,
    })[0];
    expect(pendingDecision.coordination).toMatchObject({
      currentTodo: '正向物流异常已确认，请明确买家侧处理选择',
      outboundException: {
        exceptionId: exception.id,
        packageId: shipmentPackage.id,
        exceptionType: 'lost',
        stage: 'confirmed',
        affectedQuantity: 1,
        decision: null,
      },
    });

    const decided = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: pendingDecision.revision,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      decision: 'refund_and_replacement',
      occurredAt: '2026-08-14T10:20:00+08:00',
      reason: '先给买家退款并补发一件，承运索赔另行处理',
    });
    expect(decided).toMatchObject({
      status: 'waiting_replacement',
      refund: { status: 'pending', requestedAmountCents: 1_000 },
      coordination: {
        outboundException: {
          decision: 'refund_and_replacement',
          timeline: [expect.objectContaining({
            kind: 'selected',
            after: 'refund_and_replacement',
            affectedItems: [expect.objectContaining({
              shipmentPackageItemId: affectedItem.id,
              quantity: 1,
            })],
          })],
        },
      },
      rounds: [
        expect.objectContaining({ workflow: 'legacy' }),
        expect.objectContaining({
          roundNumber: 2,
          workflow: 'direct_replacement',
          sourceShipmentRecordId: shipment.record.id,
          items: [expect.objectContaining({
            sourceShipmentPackageItemId: affectedItem.id,
            quantity: 1,
          })],
          replacementShipment: null,
        }),
      ],
    });
    expect(decided.rounds[1].items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceShipmentPackageItemId: unaffectedItem.id }),
    ]));

    const replacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: decided.id,
      roundId: decided.rounds[1].id,
      expectedRevision: decided.revision,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '按丢失商品数量建立独立补发',
      packages: [{
        shippingCarrier: '中通快递',
        trackingNumber: 'ZT-OUTBOUND-REPLACEMENT-001',
        items: [{ roundItemId: decided.rounds[1].items[0].id, quantity: 1 }],
      }],
    });
    expect(replacement.rounds[1].replacementShipment).toMatchObject({
      sourceRecordRole: 'aftersales_replacement',
      packages: [{
        trackingNumber: 'ZT-OUTBOUND-REPLACEMENT-001',
        items: [{ orderId: affectedItem.orderId, quantity: 1 }],
      }],
    });
    expect(application.queryShipmentRecords().find(({ id }) => id === shipment.record.id))
      .toMatchObject({ packages: [{ trackingNumber: 'SF-OUTBOUND-EXCEPTION-001' }] });
    expect(() => application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: replacement.id,
      expectedRevision: replacement.revision,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      decision: 'refund_only',
      occurredAt: '2026-08-14T10:35:00+08:00',
      reason: '不应直接撤回已建立的补发事实',
    })).toThrow('当前异常已建立补发记录');

    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: replacement.id,
      expectedRevision: replacement.revision,
      actualRefundCents: 1_000,
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '平台已确认实际退款',
    });
    expect(refunded).toMatchObject({
      status: 'waiting_replacement',
      refund: {
        status: 'confirmed',
        refundRecords: [{ amountCents: 1_000 }],
        fulfillment: { kind: 'complete', refundedAmountCents: 1_000 },
      },
    });

    const claimed = application.progressShipmentPackageCarrierClaim({
      kind: 'open',
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: lost.record.packages[0].revision,
      requestedAmountCents: 1_000,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '向承运方申请丢件赔付',
    });
    expect(claimed.record.packages[0]).toMatchObject({
      carrierClaim: { status: 'pending' },
      logisticsStatus: 'in_transit',
    });
    expect(application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0])
      .toMatchObject({ refund: { status: 'confirmed' } });

    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);
    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      expect(database.prepare(`
        SELECT
          decisions.exception_id,
          decisions.affected_items_json
        FROM aftersales_outbound_exception_refund_links AS links
        JOIN aftersales_outbound_exception_decision_events AS decisions
          ON decisions.id = links.decision_event_id
      `).get()).toMatchObject({
        exception_id: exception.id,
        affected_items_json: expect.stringContaining(affectedItem.id),
      });
      expect(() => database.prepare(`
        UPDATE aftersales_outbound_exception_decision_events
        SET reason = '尝试覆盖历史'
      `).run()).toThrow(/immutable/u);
      expect(() => database.prepare(`
        DELETE FROM aftersales_outbound_exception_decision_events
      `).run()).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });

  it('拦截成功不等于实物退回，只有原包裹真实退回后才能登记检查', async () => {
    const { application, shipment } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const affectedItem = shipmentPackage.items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'intercept',
      requestedRefundCents: 1_000,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '地址错误，申请拦截原正向包裹',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    const succeeded = application.progressAftersalesCase({
      kind: 'record_interception_result',
      caseId: created.id,
      expectedRevision: created.revision,
      result: 'succeeded',
      occurredAt: '2026-08-14T11:10:00+08:00',
      reason: '承运方确认拦截成功',
    });

    expect(() => application.progressAftersalesCase({
      kind: 'inspect_intercepted_return',
      caseId: succeeded.id,
      expectedRevision: succeeded.revision,
      packageId: shipmentPackage.id,
      result: 'resellable',
      occurredAt: '2026-08-14T11:20:00+08:00',
      reason: '不能把拦截成功当作卖家已收到',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    })).toThrow('原正向包裹尚未真实退回卖家，不能登记检查');

    const returned = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'returned',
      occurredAt: '2026-08-14T11:30:00+08:00',
      reason: '卖家已实际收到拦截退回包裹',
    });
    expect(returned.record.packages[0].logisticsStatus).toBe('returned');

    const inspected = application.progressAftersalesCase({
      kind: 'inspect_intercepted_return',
      caseId: succeeded.id,
      expectedRevision: succeeded.revision,
      packageId: shipmentPackage.id,
      result: 'resellable',
      occurredAt: '2026-08-14T11:40:00+08:00',
      reason: '实际收到后检查完好，可决定退款或重新发出',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    expect(inspected.coordination).toMatchObject({
      physicalControl: 'seller',
      currentTodo: '拦截退回商品已检查，请明确退款、补发或其他后续处理',
      interceptedReturnInspection: {
        packageId: shipmentPackage.id,
        result: 'resellable',
        items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
      },
    });
    expect(inspected.returns).toEqual([]);

    const replacementDirection = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: inspected.id,
      expectedRevision: inspected.revision,
      handlingDirection: 'replacement',
      occurredAt: '2026-08-14T11:50:00+08:00',
      reason: '检查完好，按原商品数量重新发出',
    });
    expect(replacementDirection).toMatchObject({
      status: 'waiting_replacement',
      rounds: [
        expect.objectContaining({ workflow: 'legacy' }),
        expect.objectContaining({
          roundNumber: 2,
          workflow: 'direct_replacement',
          sourceShipmentRecordId: shipment.record.id,
          items: [expect.objectContaining({
            sourceShipmentPackageItemId: affectedItem.id,
            quantity: 1,
          })],
        }),
      ],
    });
    const waitingAgain = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: replacementDirection.id,
      expectedRevision: replacementDirection.revision,
      handlingDirection: 'waiting',
      occurredAt: '2026-08-14T12:00:00+08:00',
      reason: '暂缓重新发出',
    });
    const replacementAgain = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: waitingAgain.id,
      expectedRevision: waitingAgain.revision,
      handlingDirection: 'replacement',
      occurredAt: '2026-08-14T12:10:00+08:00',
      reason: '再次确认需要重新发出',
    });
    expect(replacementAgain.rounds).toHaveLength(2);
    expect(replacementAgain.rounds[1]).toMatchObject({
      roundNumber: 2,
      replacementRequired: true,
      replacementShipment: null,
    });
  });

  it('终态售后晚到的拦截退回检查不重开但会推进版本', async () => {
    const { application, shipment } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const affectedItem = shipmentPackage.items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'intercept',
      requestedRefundCents: 1_000,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '申请拦截后买家取消售后',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    const succeeded = application.progressAftersalesCase({
      kind: 'record_interception_result',
      caseId: created.id,
      expectedRevision: created.revision,
      result: 'succeeded',
      occurredAt: '2026-08-14T11:10:00+08:00',
      reason: '承运方确认拦截成功',
    });
    const cancelled = application.progressAftersalesCase({
      kind: 'cancel',
      caseId: succeeded.id,
      expectedRevision: succeeded.revision,
      reason: '买家取消当前售后',
    });
    application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'returned',
      occurredAt: '2026-08-14T11:30:00+08:00',
      reason: '售后取消后拦截包裹才退回',
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_intercepted_return',
      caseId: cancelled.id,
      expectedRevision: cancelled.revision,
      packageId: shipmentPackage.id,
      result: 'resellable',
      occurredAt: '2026-08-14T11:40:00+08:00',
      reason: '补录晚到退回包裹检查',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    expect(inspected).toMatchObject({
      status: 'cancelled',
      revision: cancelled.revision + 1,
      coordination: { interceptedReturnInspection: { result: 'resellable' } },
    });
    expect(inspected.timeline.at(-1)).toMatchObject({
      kind: 'updated',
      after: { status: 'cancelled' },
      changeReason: '补录晚到退回包裹检查',
    });
  });

  it('补发与退款分开推进，选择可更改且已取消退款可审计重开', async () => {
    const { application, shipment, root } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const affectedItem = shipmentPackage.items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      requestedRefundCents: 1_000,
      occurredAt: '2026-08-14T12:00:00+08:00',
      reason: '其中一件待核对物流异常',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 2 }],
    });
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T12:05:00+08:00',
      reason: '承运方已揽收',
    });
    const lost = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: affectedItem.id, quantity: 1 }],
      },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T12:10:00+08:00',
      reason: '承运方确认丢失一件',
    });
    const exception = lost.record.packages[0].currentException;
    if (!exception) throw new Error('测试前置异常不存在');

    const replacement = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: created.revision,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      decision: 'replacement',
      occurredAt: '2026-08-14T12:20:00+08:00',
      reason: '先选择直接补发，不代替退款链',
    });
    expect(replacement.refund?.status).toBe('pending');
    expect(replacement.rounds.at(-1)?.items).toEqual([
      expect.objectContaining({ quantity: 1 }),
    ]);

    const changed = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: replacement.revision,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      decision: 'refund_and_replacement',
      occurredAt: '2026-08-14T12:30:00+08:00',
      reason: '与买家协商后改为退款并补发',
    });
    expect(changed.refund?.status).toBe('pending');
    expect(changed.coordination.outboundException?.timeline.at(-1)).toMatchObject({
      kind: 'changed',
      before: 'replacement',
      after: 'refund_and_replacement',
    });
    expect(changed.rounds).toHaveLength(2);

    const changedBack = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: changed.revision,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      decision: 'replacement',
      occurredAt: '2026-08-14T12:40:00+08:00',
      reason: '买家最终只要补发',
    });
    const cancelledRefund = application.progressAftersalesCase({
      kind: 'cancel_refund_request',
      caseId: created.id,
      expectedRevision: changedBack.revision,
      occurredAt: '2026-08-14T12:50:00+08:00',
      reason: '买家确认只补发，显式取消本次退款',
    });
    expect(cancelledRefund).toMatchObject({
      status: 'waiting_replacement',
      refund: {
        status: 'cancelled',
        latestEventAt: '2026-08-14T12:50:00+08:00',
        timeline: expect.arrayContaining([expect.objectContaining({
          kind: 'cancelled',
          occurredAt: '2026-08-14T12:50:00+08:00',
          reason: '买家确认只补发,显式取消本次退款',
        })]),
      },
    });
    const reopenedRefund = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: cancelledRefund.revision,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      decision: 'refund_and_replacement',
      requestedRefundCents: 800,
      occurredAt: '2026-08-14T13:00:00+08:00',
      reason: '买家协商后重新申请部分退款',
    });
    expect(reopenedRefund.refund).toMatchObject({
      status: 'pending',
      requestedAmountCents: 800,
    });
    if (!reopenedRefund.refund) throw new Error('重开后退款事项不存在');
    const changedBackAgain = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: reopenedRefund.revision,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      decision: 'replacement',
      occurredAt: '2026-08-14T13:10:00+08:00',
      reason: '再次确认仅补发',
    });
    const cancelledAgain = application.progressAftersalesCase({
      kind: 'cancel_refund_request',
      caseId: created.id,
      expectedRevision: changedBackAgain.revision,
      occurredAt: '2026-08-14T13:20:00+08:00',
      reason: '取消重新申请的退款',
    });
    expect(cancelledAgain.refund?.timeline.map(({ kind }) => kind)).toEqual([
      'created',
      'cancelled',
      'reopened',
      'cancelled',
    ]);
    if (!cancelledAgain.refund) throw new Error('再次取消后退款事项不存在');
    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      const reopeningEvent = database.prepare(`
        SELECT previous_requested_amount_cents, requested_amount_cents, reason, created_at
        FROM aftersales_refund_reopening_events
        WHERE pending_item_id = ?
      `).get(cancelledAgain.refund.pendingItemId) as Record<string, unknown>;
      expect(reopeningEvent).toMatchObject({
        previous_requested_amount_cents: 1_000,
        requested_amount_cents: 800,
        reason: '买家协商后重新申请部分退款',
      });
      expect(cancelledAgain.refund.latestEventAt).toBe('2026-08-14T13:20:00+08:00');
      expect(database.prepare(`
        SELECT occurred_at, created_at
        FROM pending_financial_item_events
        WHERE pending_item_id = ? AND kind = 'cancelled'
        ORDER BY sequence
      `).all(cancelledAgain.refund.pendingItemId)).toEqual([
        expect.objectContaining({
          occurred_at: '2026-08-14T12:50:00+08:00',
          created_at: '2026-08-14T01:30:00.000Z',
        }),
        expect.objectContaining({
          occurred_at: '2026-08-14T13:20:00+08:00',
          created_at: '2026-08-14T01:30:00.000Z',
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it('补发包裹再次异常使用补发记录作为新轮来源', async () => {
    const { application, shipment } = await createApplication();
    const sourcePackage = shipment.record.packages[0];
    const sourceItem = sourcePackage.items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-14T13:00:00+08:00',
      reason: '首轮直接补发',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const replacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: created.id,
      roundId: created.rounds[0].id,
      expectedRevision: created.revision,
      occurredAt: '2026-08-14T13:05:00+08:00',
      reason: '建立首轮补发记录',
      packages: [{
        shippingCarrier: '中通快递',
        trackingNumber: 'ZT-OUTBOUND-SECOND-001',
        items: [{ roundItemId: created.rounds[0].items[0].id, quantity: 1 }],
      }],
    });
    const replacementRecord = replacement.rounds[0].replacementShipment;
    if (!replacementRecord) throw new Error('测试前置补发记录不存在');
    const replacementPackage = replacementRecord.packages[0];
    const replacementItem = replacementPackage.items[0];
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: replacementRecord.id,
      packageId: replacementPackage.id,
      expectedRevision: replacementPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T13:10:00+08:00',
      reason: '补发包裹已揽收',
    });
    const lost = application.recordShipmentPackageLogisticsException({
      recordId: replacementRecord.id,
      packageId: replacementPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: replacementItem.id, quantity: 1 }],
      },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T13:20:00+08:00',
      reason: '承运方确认补发包裹丢失',
    });
    const exception = lost.record.packages[0].currentException;
    if (!exception) throw new Error('测试前置补发异常不存在');

    const pending = application.queryAftersalesCases({
      shipmentRecordId: shipment.record.id,
    })[0];
    expect(pending.coordination.outboundException).toMatchObject({
      exceptionId: exception.id,
      sourceShipmentRecordId: replacementRecord.id,
      packageId: replacementPackage.id,
      affectedItems: [{
        shipmentPackageItemId: replacementItem.id,
        quantity: 1,
      }],
    });
    const nextRound = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: pending.id,
      expectedRevision: pending.revision,
      packageId: replacementPackage.id,
      exceptionId: exception.id,
      decision: 'replacement',
      occurredAt: '2026-08-14T13:30:00+08:00',
      reason: '补发包裹丢失，再次建立补发轮次',
    });
    expect(nextRound.rounds.at(-1)).toMatchObject({
      roundNumber: 2,
      workflow: 'direct_replacement',
      sourceShipmentRecordId: replacementRecord.id,
      items: [{
        sourceShipmentPackageItemId: replacementItem.id,
        quantity: 1,
      }],
    });
  });

  it('已结束售后不会被后续正向异常选择重新打开', async () => {
    const { application, shipment } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const affectedItem = shipmentPackage.items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      requestedRefundCents: 1_000,
      occurredAt: '2026-08-14T14:00:00+08:00',
      reason: '待确认的独立问题',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    const cancelled = application.progressAftersalesCase({
      kind: 'cancel',
      caseId: created.id,
      expectedRevision: created.revision,
      reason: '买家撤回本次售后',
    });
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T14:10:00+08:00',
      reason: '承运方已揽收',
    });
    const lost = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T14:20:00+08:00',
      reason: '售后结束后承运方才确认丢件',
    });
    const exception = lost.record.packages[0].currentException;
    if (!exception) throw new Error('测试前置异常不存在');
    expect(() => application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: cancelled.id,
      expectedRevision: cancelled.revision,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      decision: 'replacement',
      occurredAt: '2026-08-14T14:30:00+08:00',
      reason: '不应在旧售后上继续处理',
    })).toThrow('已经结束的售后处理单不能继续推进');
    expect(application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0].status)
      .toBe('cancelled');
  });

  it('多个正向异常的补发轮次可分别执行且全部签收后才可结案', async () => {
    const { application, shipment } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const [firstItem, secondItem] = shipmentPackage.items;
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      requestedRefundCents: 2_000,
      occurredAt: '2026-08-14T15:00:00+08:00',
      reason: '合装包裹两件商品分别发生异常',
      items: [
        { shipmentPackageItemId: firstItem.id, quantity: 1 },
        { shipmentPackageItemId: secondItem.id, quantity: 1 },
      ],
    });
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T15:05:00+08:00',
      reason: '承运方已确认揽收合装包裹',
    });
    const firstLost = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'items', items: [{ sourceItemId: firstItem.id, quantity: 1 }] },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T15:10:00+08:00',
      reason: '承运方确认第一件丢失',
    });
    const firstExceptionId = firstLost.record.packages[0].currentException?.id;
    if (!firstExceptionId) throw new Error('测试前置第一个异常不存在');
    const secondLost = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: firstLost.record.packages[0].revision,
      exceptionType: 'damaged',
      stage: 'confirmed',
      impact: { scope: 'items', items: [{ sourceItemId: secondItem.id, quantity: 1 }] },
      occurredAt: '2026-08-14T15:20:00+08:00',
      reason: '承运方确认第二件破损',
    });
    const secondExceptionId = secondLost.record.packages[0].currentException?.id;
    if (!secondExceptionId) throw new Error('测试前置第二个异常不存在');
    let current = application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    current = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: current.id,
      expectedRevision: current.revision,
      packageId: shipmentPackage.id,
      exceptionId: secondExceptionId,
      decision: 'replacement',
      occurredAt: '2026-08-14T15:30:00+08:00',
      reason: '第二件先选择补发',
    });
    current = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: current.id,
      expectedRevision: current.revision,
      packageId: shipmentPackage.id,
      exceptionId: firstExceptionId,
      decision: 'replacement',
      occurredAt: '2026-08-14T15:40:00+08:00',
      reason: '第一件后选择补发',
    });
    expect(() => application.progressAftersalesCase({
      kind: 'cancel_refund_request',
      caseId: current.id,
      expectedRevision: current.revision,
      occurredAt: '2026-08-14T15:35:00+08:00',
      reason: '不应早于所有异常的最后一次处理选择',
    })).toThrow('取消退款申请时间不能早于异常处理选择时间');
    current = application.progressAftersalesCase({
      kind: 'cancel_refund_request',
      caseId: current.id,
      expectedRevision: current.revision,
      occurredAt: '2026-08-14T15:50:00+08:00',
      reason: '买家确认两件都只补发',
    });
    const pendingRounds = current.rounds.filter(({ replacementRequired }) => replacementRequired);
    expect(pendingRounds).toHaveLength(2);
    const laterRound = pendingRounds[1];
    current = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: current.id,
      expectedRevision: current.revision,
      roundId: laterRound.id,
      occurredAt: '2026-08-14T16:00:00+08:00',
      reason: '先执行后建立的补发轮次',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-MULTI-EXCEPTION-LATER',
        items: laterRound.items.map((item) => ({ roundItemId: item.id, quantity: item.quantity })),
      }],
    });
    const laterReplacement = current.rounds.find(({ id }) => id === laterRound.id)
      ?.replacementShipment;
    if (!laterReplacement) throw new Error('测试前置后一补发记录不存在');
    const laterPackage = laterReplacement.packages[0];
    application.updateShipmentPackageLogisticsStatus({
      recordId: laterReplacement.id,
      packageId: laterPackage.id,
      expectedRevision: laterPackage.revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-14T16:10:00+08:00',
      reason: '后一轮补发已签收',
    });
    current = application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    expect(current.status).toBe('waiting_replacement');
    expect(current.coordination.currentTodo).toBe(
      `安排第 ${pendingRounds[0].roundNumber} 轮补发`,
    );
    const earlierRound = current.rounds.find(({ id }) => id === pendingRounds[0].id);
    if (!earlierRound) throw new Error('测试前置前一补发轮次不存在');
    current = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: current.id,
      expectedRevision: current.revision,
      roundId: earlierRound.id,
      occurredAt: '2026-08-14T16:20:00+08:00',
      reason: '再执行前一补发轮次',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-MULTI-EXCEPTION-EARLIER',
        items: earlierRound.items.map((item) => ({ roundItemId: item.id, quantity: item.quantity })),
      }],
    });
    const earlierReplacement = current.rounds.find(({ id }) => id === earlierRound.id)
      ?.replacementShipment;
    if (!earlierReplacement) throw new Error('测试前置前一补发记录不存在');
    const earlierPackage = earlierReplacement.packages[0];
    application.updateShipmentPackageLogisticsStatus({
      recordId: earlierReplacement.id,
      packageId: earlierPackage.id,
      expectedRevision: earlierPackage.revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-14T16:30:00+08:00',
      reason: '前一轮补发也已签收',
    });
    expect(application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0].status)
      .toBe('ready_to_complete');
  });

  it('同一来源商品的重叠异常不会重复生成补发数量', async () => {
    const { application, shipment } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const affectedItem = shipmentPackage.items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      requestedRefundCents: 1_000,
      occurredAt: '2026-08-14T17:00:00+08:00',
      reason: '同一件商品出现两条承运异常',
      items: [{ shipmentPackageItemId: affectedItem.id, quantity: 1 }],
    });
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T17:05:00+08:00',
      reason: '承运方已揽收',
    });
    const damaged = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'damaged',
      stage: 'confirmed',
      impact: { scope: 'items', items: [{ sourceItemId: affectedItem.id, quantity: 1 }] },
      occurredAt: '2026-08-14T17:10:00+08:00',
      reason: '承运方先确认外包装破损',
    });
    const damagedExceptionId = damaged.record.packages[0].currentException?.id;
    if (!damagedExceptionId) throw new Error('破损异常不存在');
    const lost = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: damaged.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'items', items: [{ sourceItemId: affectedItem.id, quantity: 1 }] },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T17:20:00+08:00',
      reason: '承运方后又确认同一件丢失',
    });
    const lostExceptionId = lost.record.packages[0].currentException?.id;
    if (!lostExceptionId) throw new Error('丢件异常不存在');
    let current = application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    current = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: current.revision,
      packageId: shipmentPackage.id,
      exceptionId: lostExceptionId,
      decision: 'replacement',
      occurredAt: '2026-08-14T17:30:00+08:00',
      reason: '先对丢件选择补发',
    });
    expect(() => application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: current.revision,
      packageId: shipmentPackage.id,
      exceptionId: damagedExceptionId,
      decision: 'replacement',
      occurredAt: '2026-08-14T17:40:00+08:00',
      reason: '不应对同一件再建补发义务',
    })).toThrow('同一来源商品数量已被其他未完成异常补发占用');
    expect(application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0].rounds
      .filter(({ replacementRequired }) => replacementRequired)).toHaveLength(1);
  });

  it('多异常选择不同时补发作废重试始终沿用所属异常的独立决策', async () => {
    const { application, shipment } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const [replacementItem, refundItem] = shipmentPackage.items;
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      requestedRefundCents: 1_000,
      occurredAt: '2026-08-14T18:00:00+08:00',
      reason: '两件商品分别补发和退款',
      items: [
        { shipmentPackageItemId: replacementItem.id, quantity: 1 },
        { shipmentPackageItemId: refundItem.id, quantity: 1 },
      ],
    });
    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T18:05:00+08:00',
      reason: '承运方已揽收',
    });
    const replacementExceptionResult = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: replacementItem.id, quantity: 1 }],
      },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T18:10:00+08:00',
      reason: '第一件商品确认丢失',
    });
    const replacementExceptionId = replacementExceptionResult.record.packages[0]
      .currentException?.id;
    if (!replacementExceptionId) throw new Error('补发异常不存在');
    const refundExceptionResult = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: replacementExceptionResult.record.packages[0].revision,
      exceptionType: 'damaged',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: refundItem.id, quantity: 1 }],
      },
      occurredAt: '2026-08-14T18:20:00+08:00',
      reason: '第二件商品确认破损',
    });
    const refundExceptionId = refundExceptionResult.record.packages[0].currentException?.id;
    if (!refundExceptionId) throw new Error('退款异常不存在');
    let current = application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    current = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: created.id,
      expectedRevision: current.revision,
      packageId: shipmentPackage.id,
      exceptionId: replacementExceptionId,
      decision: 'replacement',
      occurredAt: '2026-08-14T18:30:00+08:00',
      reason: '第一件选择补发',
    });
    const originalReplacementRound = current.rounds.find(({ replacementRequired }) => (
      replacementRequired
    ));
    if (!originalReplacementRound) throw new Error('初始补发轮次不存在');
    current = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: current.id,
      roundId: originalReplacementRound.id,
      expectedRevision: current.revision,
      occurredAt: '2026-08-14T18:40:00+08:00',
      reason: '建立第一次补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-INDEPENDENT-RETRY-01',
        items: originalReplacementRound.items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });
    current = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: current.id,
      expectedRevision: current.revision,
      packageId: shipmentPackage.id,
      exceptionId: refundExceptionId,
      decision: 'refund_only',
      occurredAt: '2026-08-14T18:50:00+08:00',
      reason: '第二件只退款，不得覆盖第一件的补发义务',
    });
    const firstReplacement = current.rounds.find(({ id }) => (
      id === originalReplacementRound.id
    ))?.replacementShipment;
    if (!firstReplacement) throw new Error('第一次补发记录不存在');
    application.cancelShipmentPackages({
      recordId: firstReplacement.id,
      packageIds: [firstReplacement.packages[0].id],
      reason: '第一次补发未交寄作废',
    });
    current = application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    const firstRetryRound = current.rounds.find((round) => (
      round.id !== originalReplacementRound.id
      && round.replacementRequired
      && round.replacementShipment === null
    ));
    expect(firstRetryRound).toMatchObject({ items: [{ quantity: 1 }] });
    if (!firstRetryRound) throw new Error('第一次重试轮次不存在');
    current = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: current.id,
      roundId: firstRetryRound.id,
      expectedRevision: current.revision,
      occurredAt: '2026-08-14T19:00:00+08:00',
      reason: '建立第二次补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-INDEPENDENT-RETRY-02',
        items: firstRetryRound.items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });
    expect(() => application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: current.id,
      expectedRevision: current.revision,
      packageId: shipmentPackage.id,
      exceptionId: replacementExceptionId,
      decision: 'wait_investigation',
      occurredAt: '2026-08-14T19:10:00+08:00',
      reason: '活跃重试补发存在时不得撤回补发选择',
    })).toThrow('当前异常已建立补发记录');
    const secondReplacement = current.rounds.find(({ id }) => id === firstRetryRound.id)
      ?.replacementShipment;
    if (!secondReplacement) throw new Error('第二次补发记录不存在');
    application.cancelShipmentPackages({
      recordId: secondReplacement.id,
      packageIds: [secondReplacement.packages[0].id],
      reason: '第二次补发仍未交寄，再次作废',
    });
    current = application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    const pendingRetries = current.rounds.filter((round) => (
      round.id !== originalReplacementRound.id
      && round.id !== firstRetryRound.id
      && round.replacementRequired
      && round.replacementShipment === null
    ));
    expect(pendingRetries).toMatchObject([{ items: [{ quantity: 1 }] }]);
  });
});
