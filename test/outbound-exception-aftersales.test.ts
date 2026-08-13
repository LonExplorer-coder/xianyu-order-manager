import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

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
});

describe('正向发货异常上层处理', () => {
  it('按异常影响商品选择退款并补发，生成新发货记录且承运索赔独立推进', async () => {
    const { application, shipment, root } = await createApplication();
    const shipmentPackage = shipment.record.packages[0];
    const affectedItem = shipmentPackage.items[0];
    const unaffectedItem = shipmentPackage.items[1];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflow: 'return_refund',
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
      refund: { status: 'confirmed', actualRecord: { amountCents: 1_000 } },
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
      workflow: 'return_refund',
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
  });
});
