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
import { removeVersion35ExtensionArtifacts } from './version31-fixture';

const openedApplications: LocalApplication[] = [];

class OneOrderRecognizer implements Recognizer {
  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result: RecognitionResult = {
      platform: 'xianyu',
      sellerAccount: '售后补发测试账号',
      orderNumber: 'XY-AFTERSALES-REPLACEMENT-0001',
      alipayTransactionNumber: 'ALI-AFTERSALES-REPLACEMENT-0001',
      buyerNickname: '测试买家',
      recipient: '林青',
      phone: '13800000001',
      phoneNormalized: '13800000001',
      addressOriginal: '广东省深圳市南山区海风路1号',
      addressNormalized: '广东省深圳市南山区海风路1号',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
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
        sourceTitle: '亚麻收纳袋',
        sourceSpec: '米白 大号',
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

async function createApplication(root?: string, seedOrder = true) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-14T01:30:00.000Z'));
  const applicationRoot = root ?? await mkdtemp(join(tmpdir(), 'xianyu-aftersales-replacement-'));
  const sourceDirectory = join(applicationRoot, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const application = new LocalApplication(new OneOrderRecognizer());
  openedApplications.push(application);
  application.openDataDirectory(join(applicationRoot, '数据'));
  if (seedOrder) {
    const sourcePath = join(sourceDirectory, '订单.png');
    await writeFile(sourcePath, Buffer.from('aftersales-replacement-order'));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    application.confirmDraft(batch.drafts[0]);
  }
  return { application, root: applicationRoot };
}

function confirmOriginalShipment(application: LocalApplication) {
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
      trackingNumber: 'SF-ORIGINAL-0001',
      items,
    }],
  });
  shipment.record = application.updateShipmentPackageLogisticsStatus({
    recordId: shipment.record.id,
    packageId: shipment.record.packages[0].id,
    expectedRevision: shipment.record.packages[0].revision,
    logisticsStatus: 'delivered',
    occurredAt: '2026-08-14T10:00:00+08:00',
    reason: '测试前置：买家已签收原始发货',
  }).record;
  return shipment;
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
  vi.useRealTimers();
});

describe('换货、直接补发与多轮售后', () => {
  it('未交寄补发可作废并保留历史后建立新的待补发轮次', async () => {
    const { application } = await createApplication();
    const original = confirmOriginalShipment(application);
    const created = application.createAftersalesCase({
      shipmentRecordId: original.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-14T10:10:00+08:00',
      reason: '测试未交寄补发作废',
      items: [{
        shipmentPackageItemId: original.record.packages[0].items[0].id,
        quantity: 1,
      }],
    });
    const firstAttempt = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: created.id,
      roundId: created.rounds[0].id,
      expectedRevision: created.revision,
      occurredAt: '2026-08-14T10:20:00+08:00',
      reason: '第一次补发运单填错',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-WRONG-REPLACEMENT',
        items: [{ roundItemId: created.rounds[0].items[0].id, quantity: 1 }],
      }],
    });
    const firstRecord = firstAttempt.rounds[0].replacementShipment;
    if (!firstRecord) throw new Error('测试前置补发记录不存在');
    application.cancelShipmentPackages({
      recordId: firstRecord.id,
      packageIds: [firstRecord.packages[0].id],
      reason: '运单填错且未交寄，显式作废',
    });
    const afterCancellation = application.queryAftersalesCases({
      shipmentRecordId: original.record.id,
    })[0];
    expect(afterCancellation.rounds[0]).toMatchObject({
      replacementRequired: false,
      replacementShipment: { status: 'voided' },
    });
    const retryRound = afterCancellation.rounds.find((round) => (
      round.id !== created.rounds[0].id && round.replacementRequired
    ));
    expect(retryRound).toMatchObject({
      roundNumber: 2,
      workflow: 'direct_replacement',
      replacementShipment: null,
    });
    if (!retryRound) throw new Error('作废后待重试轮次不存在');
    const retried = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: afterCancellation.id,
      roundId: retryRound.id,
      expectedRevision: afterCancellation.revision,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '重新建立正确补发记录',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-CORRECT-REPLACEMENT',
        items: retryRound.items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });
    expect(retried.rounds.find(({ id }) => id === retryRound.id)?.replacementShipment)
      .toMatchObject({ packages: [{ trackingNumber: 'SF-CORRECT-REPLACEMENT' }] });
  });

  it('同轮补发分成两个包裹逐次作废时为每个包裹保留精确重试义务', async () => {
    const { application } = await createApplication();
    const original = confirmOriginalShipment(application);
    const created = application.createAftersalesCase({
      shipmentRecordId: original.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-14T10:10:00+08:00',
      reason: '两件商品需要分包补发',
      items: [{
        shipmentPackageItemId: original.record.packages[0].items[0].id,
        quantity: 2,
      }],
    });
    const attempted = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: created.id,
      roundId: created.rounds[0].id,
      expectedRevision: created.revision,
      occurredAt: '2026-08-14T10:20:00+08:00',
      reason: '两个包裹分别登记',
      packages: [
        {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-SPLIT-REPLACEMENT-01',
          items: [{ roundItemId: created.rounds[0].items[0].id, quantity: 1 }],
        },
        {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-SPLIT-REPLACEMENT-02',
          items: [{ roundItemId: created.rounds[0].items[0].id, quantity: 1 }],
        },
      ],
    });
    const replacement = attempted.rounds[0].replacementShipment;
    if (!replacement) throw new Error('测试前置补发记录不存在');

    application.cancelShipmentPackages({
      recordId: replacement.id,
      packageIds: [replacement.packages[0].id],
      reason: '第一个包裹未交寄作废',
    });
    const afterFirstCancellation = application.queryAftersalesCases({
      shipmentRecordId: original.record.id,
    })[0];
    expect(afterFirstCancellation.rounds.filter((round) => (
      round.id !== created.rounds[0].id && round.replacementRequired
    ))).toMatchObject([{
      items: [{ quantity: 1 }],
      replacementShipment: null,
    }]);

    application.cancelShipmentPackages({
      recordId: replacement.id,
      packageIds: [replacement.packages[1].id],
      reason: '第二个包裹未交寄作废',
    });
    const afterBothCancellations = application.queryAftersalesCases({
      shipmentRecordId: original.record.id,
    })[0];
    expect(afterBothCancellations.rounds[0]).toMatchObject({
      replacementRequired: false,
      replacementShipment: { status: 'voided' },
    });
    const retryRounds = afterBothCancellations.rounds.filter((round) => (
      round.id !== created.rounds[0].id && round.replacementRequired
    ));
    expect(retryRounds).toHaveLength(2);
    expect(retryRounds.map((round) => round.items[0].quantity)).toEqual([1, 1]);
    expect(retryRounds.flatMap((round) => round.items)
      .reduce((quantity, item) => quantity + item.quantity, 0)).toBe(2);
  });

  it('换货收到并检查后建立独立补发记录，签收后可完成且不覆盖原发货', async () => {
    const { application } = await createApplication();
    const original = confirmOriginalShipment(application);
    const sourceItem = original.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: original.record.id,
      workflowTemplateId: 'system-aftersales-exchange',
      occurredAt: '2026-08-14T10:10:00+08:00',
      reason: '买家收到一件破损商品，需要换货',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });

    expect(created).toMatchObject({
      workflow: 'exchange',
      status: 'waiting_return',
      rounds: [{
        roundNumber: 1,
        workflow: 'exchange',
        sourceShipmentRecordId: original.record.id,
        replacementShipment: null,
        items: [{ sourceShipmentPackageItemId: sourceItem.id, quantity: 1 }],
      }],
      fulfillment: {
        cumulativeSentQuantity: 1,
        cumulativeReturnedQuantity: 0,
        buyerHeldQuantity: 1,
        currentRoundNumber: 1,
      },
    });

    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-EXCHANGE-RETURN-0001',
      occurredAt: '2026-08-14T10:20:00+08:00',
      reason: '买家已经寄回破损商品',
    });
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '卖家实际收到退货',
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: received.returns[0].id,
      result: 'defective',
      occurredAt: '2026-08-14T10:40:00+08:00',
      note: '检查确认破损，安排换货补发',
    });
    expect(inspected).toMatchObject({
      status: 'waiting_replacement',
      fulfillment: {
        cumulativeSentQuantity: 1,
        cumulativeReturnedQuantity: 1,
        buyerHeldQuantity: 0,
      },
    });
    expect(() => application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: inspected.id,
      roundId: inspected.rounds[0].id,
      expectedRevision: inspected.revision,
      occurredAt: '2026-08-14T10:30:00+08:00',
      reason: '补发时间不能早于退货检查',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-INVALID-EARLY',
        items: [{ roundItemId: inspected.rounds[0].items[0].id, quantity: 1 }],
      }],
    })).toThrow('补发时间不能早于本轮退货检查时间');
    expect(() => application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: inspected.id,
      roundId: inspected.rounds[0].id,
      expectedRevision: inspected.revision,
      occurredAt: '2026-08-14T02:35:00.000Z',
      reason: '不同时区格式仍需遵守检查时间',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-INVALID-TIMEZONE',
        items: [{ roundItemId: inspected.rounds[0].items[0].id, quantity: 1 }],
      }],
    })).toThrow('补发时间不能早于本轮退货检查时间');

    const roundItem = inspected.rounds[0].items[0];
    const replacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: inspected.id,
      roundId: inspected.rounds[0].id,
      expectedRevision: inspected.revision,
      occurredAt: '2026-08-14T10:50:00+08:00',
      reason: '检查完成后发出换货商品',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-REPLACEMENT-0001',
        items: [{ roundItemId: roundItem.id, quantity: 1 }],
      }],
    });
    const replacementRecord = replacement.rounds[0].replacementShipment;
    expect(replacementRecord).not.toBeNull();
    expect(replacement.rounds[0].replacementOccurredAt)
      .toBe('2026-08-14T10:50:00+08:00');
    expect(replacementRecord).toMatchObject({
      sourceRecordRole: 'aftersales_replacement',
      packages: [{
        trackingNumber: 'SF-REPLACEMENT-0001',
        items: [{ sourceTitle: sourceItem.sourceTitle, quantity: 1 }],
      }],
    });
    expect(replacement.fulfillment).toEqual({
      cumulativeSentQuantity: 2,
      cumulativeReturnedQuantity: 1,
      buyerHeldQuantity: 0,
      currentRoundNumber: 1,
    });
    expect(application.queryShipmentRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original.record.id, sourceRecordRole: 'initial' }),
      expect.objectContaining({
        id: replacementRecord?.id,
        sourceRecordRole: 'aftersales_replacement',
      }),
    ]));
    expect(application.queryShipmentRecords().find(({ id }) => id === original.record.id))
      .toMatchObject({ packages: [{ trackingNumber: 'SF-ORIGINAL-0001', totalQuantity: 2 }] });

    application.updateShipmentPackageLogisticsStatus({
      recordId: replacementRecord?.id,
      packageId: replacementRecord?.packages[0].id,
      expectedRevision: replacementRecord?.packages[0].revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '买家已签收换货补发',
    });
    const ready = application.queryAftersalesCases({})[0];
    expect(ready).toMatchObject({
      status: 'ready_to_complete',
      fulfillment: {
        cumulativeSentQuantity: 2,
        cumulativeReturnedQuantity: 1,
        buyerHeldQuantity: 1,
      },
      coordination: { currentTodo: '确认本轮补发签收并完成售后，或登记新的处理轮次' },
    });
    const completed = application.progressAftersalesCase({
      kind: 'complete',
      caseId: ready.id,
      expectedRevision: ready.revision,
      reason: '换货补发已签收，售后完成',
    });
    expect(completed.status).toBe('completed');

    const replacementItem = completed.rounds[0].replacementShipment?.packages[0].items[0];
    const independent = application.createAftersalesCase({
      shipmentRecordId: replacementRecord?.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-15T10:00:00+08:00',
      reason: '售后完成后补发商品出现新的独立问题',
      items: [{ shipmentPackageItemId: replacementItem?.id, quantity: 1 }],
    });
    expect(independent).toMatchObject({
      id: expect.not.stringMatching(completed.id),
      shipmentRecordId: replacementRecord?.id,
      rounds: [{ roundNumber: 1, sourceShipmentRecordId: replacementRecord?.id }],
    });
  });

  it('直接补发无需退货，并可把有问题的补发记录作为下一轮来源', async () => {
    const { application, root } = await createApplication();
    const original = confirmOriginalShipment(application);
    const sourceItem = original.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: original.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-14T12:00:00+08:00',
      reason: '缺少配件，直接补发一件',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    expect(created).toMatchObject({
      workflow: 'direct_replacement',
      status: 'waiting_replacement',
      returns: [],
      rounds: [{ workflow: 'direct_replacement', roundNumber: 1 }],
    });
    const firstReplacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: created.id,
      roundId: created.rounds[0].id,
      expectedRevision: created.revision,
      occurredAt: '2026-08-14T12:10:00+08:00',
      reason: '第一次直接补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-DIRECT-REPLACEMENT-0001',
        items: [{ roundItemId: created.rounds[0].items[0].id, quantity: 1 }],
      }],
    });
    const firstReplacementRecord = firstReplacement.rounds[0].replacementShipment;
    const firstReplacementItem = firstReplacementRecord?.packages[0].items[0];
    expect(() => application.progressAftersalesCase({
      kind: 'start_next_round',
      caseId: firstReplacement.id,
      expectedRevision: firstReplacement.revision,
      sourceRoundId: firstReplacement.rounds[0].id,
      sourceShipmentRecordId: firstReplacementRecord?.id,
      workflow: 'direct_replacement',
      occurredAt: '2026-08-14T12:05:00+08:00',
      reason: '新问题不能早于上一轮补发',
      items: [{ shipmentPackageItemId: firstReplacementItem?.id, quantity: 1 }],
    })).toThrow('新一轮问题时间不能早于上一轮补发时间');
    expect(() => application.progressAftersalesCase({
      kind: 'start_next_round',
      caseId: firstReplacement.id,
      expectedRevision: firstReplacement.revision,
      sourceRoundId: firstReplacement.rounds[0].id,
      sourceShipmentRecordId: firstReplacementRecord?.id,
      workflow: 'exchange',
      occurredAt: '2026-08-14T12:15:00+08:00',
      reason: '补发仍在运输中，不能登记买家退回',
      items: [{ shipmentPackageItemId: firstReplacementItem?.id, quantity: 1 }],
    })).toThrow('补发商品尚未签收，不能建立买家退回的换货轮次');
    expect(() => application.createAftersalesCase({
      shipmentRecordId: firstReplacementRecord?.id,
      workflowTemplateId: 'system-aftersales-refund-only',
      occurredAt: '2026-08-14T12:16:00+08:00',
      reason: '活动父售后期间不能另建独立售后',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId: firstReplacementItem?.id, quantity: 1 }],
    })).toThrow('补发商品仍属于未完成的售后处理，请在原处理单新增轮次');
    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const failureGate = new DatabaseSync(databasePath);
    try {
      failureGate.exec(`
        CREATE TRIGGER test_block_replacement_aftersales_advance
        BEFORE UPDATE OF status ON aftersales_cases
        WHEN NEW.status = 'ready_to_complete'
        BEGIN SELECT RAISE(ABORT, 'test aftersales synchronization failure'); END;
      `);
    } finally {
      failureGate.close();
    }
    expect(() => application.updateShipmentPackageLogisticsStatus({
      recordId: firstReplacementRecord?.id,
      packageId: firstReplacementRecord?.packages[0].id,
      expectedRevision: firstReplacementRecord?.packages[0].revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-14T12:17:00+08:00',
      reason: '模拟售后同步失败',
    })).toThrow('test aftersales synchronization failure');
    expect(application.queryShipmentRecords().find(({ id }) => id === firstReplacementRecord?.id))
      .toMatchObject({ packages: [{
        logisticsStatus: firstReplacementRecord?.packages[0].logisticsStatus,
        revision: firstReplacementRecord?.packages[0].revision,
      }] });
    const removeFailureGate = new DatabaseSync(databasePath);
    try {
      removeFailureGate.exec('DROP TRIGGER test_block_replacement_aftersales_advance;');
    } finally {
      removeFailureGate.close();
    }

    const deliveredReplacement = application.updateShipmentPackageLogisticsStatus({
      recordId: firstReplacementRecord?.id,
      packageId: firstReplacementRecord?.packages[0].id,
      expectedRevision: firstReplacementRecord?.packages[0].revision,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-14T12:18:00+08:00',
      reason: '买家实际签收第一次补发',
    }).record;
    const afterDelivery = application.queryAftersalesCases({})
      .find(({ id }) => id === firstReplacement.id);
    expect(() => application.progressAftersalesCase({
      kind: 'start_next_round',
      caseId: firstReplacement.id,
      expectedRevision: afterDelivery?.revision,
      sourceRoundId: firstReplacement.rounds[0].id,
      sourceShipmentRecordId: deliveredReplacement.id,
      workflow: 'exchange',
      occurredAt: '2026-08-14T12:17:30+08:00',
      reason: '不能把换货问题回填到买家签收之前',
      items: [{
        shipmentPackageItemId: deliveredReplacement.packages[0].items[0].id,
        quantity: 1,
      }],
    })).toThrow('新一轮换货问题时间不能早于补发商品签收时间');
    const secondRound = application.progressAftersalesCase({
      kind: 'start_next_round',
      caseId: firstReplacement.id,
      expectedRevision: afterDelivery?.revision,
      sourceRoundId: firstReplacement.rounds[0].id,
      sourceShipmentRecordId: deliveredReplacement.id,
      workflow: 'exchange',
      occurredAt: '2026-08-14T12:20:00+08:00',
      reason: '第一次补发商品再次破损，进入第二轮换货',
      items: [{
        shipmentPackageItemId: deliveredReplacement.packages[0].items[0].id,
        quantity: 1,
      }],
    });

    expect(secondRound).toMatchObject({
      id: created.id,
      status: 'waiting_return',
      rounds: [
        {
          roundNumber: 1,
          sourceShipmentRecordId: original.record.id,
          replacementShipment: { id: firstReplacementRecord?.id },
        },
        {
          roundNumber: 2,
          workflow: 'exchange',
          sourceShipmentRecordId: firstReplacementRecord?.id,
          replacementShipment: null,
          items: [{ sourceShipmentPackageItemId: firstReplacementItem?.id, quantity: 1 }],
        },
      ],
      fulfillment: {
        cumulativeSentQuantity: 2,
        cumulativeReturnedQuantity: 0,
        currentRoundNumber: 2,
      },
      coordination: {
        handlingDirection: 'buyer_return',
        handlingDirectionTimeline: [
          expect.objectContaining({ kind: 'selected', after: 'replacement' }),
          expect.objectContaining({
            kind: 'changed',
            before: 'replacement',
            after: 'buyer_return',
          }),
        ],
      },
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: secondRound.id,
      expectedRevision: secondRound.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-ROUND-2-RETURN',
      occurredAt: '2026-08-14T12:30:00+08:00',
      reason: '第二轮退回第一次补发商品',
    });
    expect(registered.returns.at(-1)?.items).toMatchObject([
      { shipmentPackageItemId: firstReplacementItem?.id, quantity: 1 },
    ]);
    expect(registered.rounds[0].replacementShipment?.packages[0].trackingNumber)
      .toBe('SF-DIRECT-REPLACEMENT-0001');
  });

  it('从 v33 升级时为既有售后建立首轮且轮次事实不可覆盖', async () => {
    const { application, root } = await createApplication();
    const original = confirmOriginalShipment(application);
    const existing = application.createAftersalesCase({
      shipmentRecordId: original.record.id,
      workflowTemplateId: 'system-aftersales-other',
      occurredAt: '2026-08-14T13:00:00+08:00',
      reason: 'v33 已存在的一般售后',
      items: [{ shipmentPackageItemId: original.record.packages[0].items[0].id, quantity: 1 }],
    });
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      removeVersion35ExtensionArtifacts(legacy);
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TRIGGER IF EXISTS aftersales_processing_rounds_are_immutable_on_update;
        DROP TRIGGER IF EXISTS aftersales_processing_rounds_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS aftersales_processing_round_items_are_immutable_on_update;
        DROP TRIGGER IF EXISTS aftersales_processing_round_items_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS aftersales_round_returns_are_immutable_on_update;
        DROP TRIGGER IF EXISTS aftersales_round_returns_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS aftersales_replacement_shipments_are_immutable_on_update;
        DROP TRIGGER IF EXISTS aftersales_replacement_shipments_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS aftersales_replacement_items_are_immutable_on_update;
        DROP TRIGGER IF EXISTS aftersales_replacement_items_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS aftersales_processing_round_item_source_is_valid_on_insert;
        DROP TRIGGER IF EXISTS aftersales_replacement_item_identity_is_valid_on_insert;
        DROP TABLE IF EXISTS aftersales_replacement_items;
        DROP TABLE IF EXISTS aftersales_replacement_shipments;
        DROP TABLE IF EXISTS aftersales_round_returns;
        DROP TABLE IF EXISTS aftersales_processing_round_items;
        DROP TABLE IF EXISTS aftersales_processing_rounds;
        DELETE FROM schema_migrations WHERE version = 34;

        CREATE TABLE aftersales_cases_v33 (
          id TEXT PRIMARY KEY,
          shipment_record_id TEXT NOT NULL
            REFERENCES shipment_records(id) ON DELETE RESTRICT,
          workflow TEXT NOT NULL CHECK (workflow IN ('general', 'refund_only', 'return_refund')),
          status TEXT NOT NULL CHECK (status IN (
            'processing', 'waiting_return', 'waiting_inspection', 'waiting_refund',
            'waiting_replacement', 'partially_completed', 'ready_to_complete',
            'completed', 'cancelled'
          )),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          handling_direction TEXT CHECK (
            handling_direction IS NULL OR handling_direction IN (
              'waiting', 'intercept', 'refuse', 'buyer_return', 'only_refund', 'replacement'
            )
          )
        ) STRICT;
        INSERT INTO aftersales_cases_v33
        SELECT id, shipment_record_id, workflow, status, revision, reason,
               occurred_at, created_at, updated_at, handling_direction
        FROM aftersales_cases;
        DROP TABLE aftersales_cases;
        ALTER TABLE aftersales_cases_v33 RENAME TO aftersales_cases;
        CREATE INDEX aftersales_cases_by_record_and_status
        ON aftersales_cases (shipment_record_id, status, occurred_at, id);
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      legacy.close();
    }

    const migratedResult = await createApplication(root, false);
    const migrated = migratedResult.application.queryAftersalesCases({})
      .find(({ id }) => id === existing.id);
    expect(migrated).toMatchObject({
      rounds: [{
        roundNumber: 1,
        sourceShipmentRecordId: original.record.id,
        items: [{
          sourceShipmentPackageItemId: original.record.packages[0].items[0].id,
          quantity: 1,
        }],
      }],
    });
    migratedResult.application.close();
    openedApplications.splice(openedApplications.indexOf(migratedResult.application), 1);

    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 52 });
      expect(() => database.prepare(`
        UPDATE aftersales_processing_rounds SET reason = '覆盖历史'
      `).run()).toThrow(/immutable/u);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.application.queryAftersalesCases({})
      .find(({ id }) => id === existing.id)?.rounds).toEqual(migrated?.rounds);
  });

  it('数据库拒绝跨来源轮次商品和跨轮次补发商品映射', async () => {
    const { application, root } = await createApplication();
    const original = confirmOriginalShipment(application);
    const created = application.createAftersalesCase({
      shipmentRecordId: original.record.id,
      workflowTemplateId: 'system-aftersales-direct-replacement',
      occurredAt: '2026-08-14T14:00:00+08:00',
      reason: '验证数据库身份约束',
      items: [{
        shipmentPackageItemId: original.record.packages[0].items[0].id,
        quantity: 1,
      }],
    });
    const progressed = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: created.id,
      roundId: created.rounds[0].id,
      expectedRevision: created.revision,
      occurredAt: '2026-08-14T14:10:00+08:00',
      reason: '建立约束验证补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-CONSTRAINT-REPLACEMENT',
        items: [{ roundItemId: created.rounds[0].items[0].id, quantity: 1 }],
      }],
    });
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      const replacement = progressed.rounds[0].replacementShipment;
      if (!replacement) throw new Error('约束验证补发记录不存在');
      const replacementMapping = database.prepare(`
        SELECT id FROM aftersales_replacement_shipments WHERE shipment_record_id = ?
      `).get(replacement.id) as { id: string };
      database.exec('BEGIN;');
      database.prepare(`
        INSERT INTO aftersales_processing_rounds (
          id, case_id, round_number, workflow, source_shipment_record_id,
          occurred_at, reason, created_at
        ) VALUES ('invalid-round', ?, 99, 'direct_replacement', ?, ?, '约束验证', ?)
      `).run(
        created.id,
        original.record.id,
        '2026-08-14T14:20:00+08:00',
        '2026-08-14T06:20:00.000Z',
      );
      expect(() => database.prepare(`
        INSERT INTO aftersales_processing_round_items (
          id, round_id, source_shipment_package_item_id, quantity
        ) VALUES ('invalid-round-item', 'invalid-round', ?, 1)
      `).run(replacement.packages[0].items[0].id)).toThrow(/source record mismatch/u);
      database.exec('ROLLBACK;');

      expect(() => database.prepare(`
        INSERT INTO aftersales_replacement_items (
          id, replacement_shipment_id, round_item_id,
          shipment_package_item_id, quantity
        ) VALUES ('invalid-replacement-item', ?, ?, ?, 1)
      `).run(
        replacementMapping.id,
        created.rounds[0].items[0].id,
        original.record.packages[0].items[0].id,
      )).toThrow(/identity mismatch/u);
    } finally {
      if (database.isTransaction) database.exec('ROLLBACK;');
      database.close();
    }
  });
});
