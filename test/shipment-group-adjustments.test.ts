import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

const openedApplications: LocalApplication[] = [];

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

function recognition(
  orderNumber: string,
  overrides: Partial<RecognitionResult> = {},
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '手工发货组测试账号',
    orderNumber,
    alipayTransactionNumber: `ALI-${orderNumber}`,
    buyerNickname: '测试买家',
    recipient: '林青',
    phone: '13800000001',
    phoneNormalized: '13800000001',
    addressOriginal: '广东省深圳市南山区海风路1号',
    addressNormalized: '广东省深圳市南山区海风路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-11 09:00:00',
    orderedAtNormalized: '2026-08-11T09:00:00+08:00',
    paidAtOriginal: '2026-08-11 09:00:08',
    paidAtNormalized: '2026-08-11T09:00:08+08:00',
    productTotalCents: 1_000,
    shippingFeeCents: 0,
    amountCents: 1_000,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '亚麻收纳袋',
      sourceSpec: '米白 大号',
      unitPriceCents: 1_000,
      quantity: 1,
      quantityInferred: false,
    }],
    ...overrides,
  };
}

async function createApplication(results: RecognitionResult[]) {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-adjustments-'));
  const dataDirectory = join(root, '数据');
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);
  for (const [index] of results.entries()) {
    const sourcePath = join(sourceDirectory, `订单-${index + 1}.png`);
    await writeFile(sourcePath, Buffer.from(`shipment-adjustment-${index + 1}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    application.confirmDraft(batch.drafts[0]);
  }
  return { application, dataDirectory };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('手工发货组调整', () => {
  it('拆出的成员形成独立开放组并在重启后保留调整原因', async () => {
    const { application, dataDirectory } = await createApplication([
      recognition('XY-SPLIT-0001'),
      recognition('XY-SPLIT-0002'),
      recognition('XY-SPLIT-0003'),
    ]);
    const initialGroup = application.queryShipmentGroups().groups[0];
    const originalOrders = initialGroup.orders.map(({ id }) => application.getOrder(id).order);
    const splitOrderId = initialGroup.orders[0].id;

    const result = application.splitShipmentGroup({
      groupId: initialGroup.id,
      expectedMemberOrderIds: initialGroup.orders.map(({ id }) => id),
      splitOrderIds: [splitOrderId],
      reason: '其中一笔需要单独包装',
    });

    expect(result.projection.groups.map((group) => group.orderCount).sort()).toEqual([1, 2]);
    expect(result.projection.groups.flatMap((group) => group.orders.map(({ id }) => id)).sort())
      .toEqual(initialGroup.orders.map(({ id }) => id).sort());
    expect(result.event).toMatchObject({
      operation: 'split',
      reason: '其中一笔需要单独包装',
      sourceGroupIds: [initialGroup.id],
      sourceOrderIds: initialGroup.orders.map(({ id }) => id),
      targetOrderIds: [splitOrderId],
    });
    expect(initialGroup.orders.map(({ id }) => application.getOrder(id).order)).toEqual(
      originalOrders,
    );
    expect(application.listShipmentGroupAdjustmentEvents()).toEqual([result.event]);

    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);
    const reopened = new LocalApplication({
      recognize: async () => {
        throw new Error('重启持久性测试不应发起识别');
      },
    });
    openedApplications.push(reopened);
    reopened.openDataDirectory(dataDirectory);

    expect(reopened.queryShipmentGroups().groups.map((group) => group.orderCount).sort())
      .toEqual([1, 2]);
    expect(reopened.listShipmentGroupAdjustmentEvents()).toEqual([result.event]);
  });

  it('跨发货匹配键重组未选择最终收货信息时原子拒绝', async () => {
    const { application } = await createApplication([
      recognition('XY-MERGE-BLOCKED-0001'),
      recognition('XY-MERGE-BLOCKED-0002', {
        phone: '13900000002',
        phoneNormalized: '13900000002',
        addressOriginal: '广东省深圳市福田区新风路2号',
        addressNormalized: '广东省深圳市福田区新风路2号',
        district: '福田区',
      }),
    ]);
    const before = application.queryShipmentGroups();

    expect(() => application.mergeShipmentGroups({
      groupIds: before.groups.map(({ id }) => id),
      expectedMemberOrderIds: before.groups.flatMap((group) => (
        group.orders.map(({ id }) => id)
      )),
      selectedRecipientOrderId: null,
      reason: '买家要求一起发货',
    })).toThrow('请选择最终收货信息');

    expect(application.queryShipmentGroups()).toEqual(before);
    expect(application.listShipmentGroupAdjustmentEvents()).toEqual([]);
  });

  it('跨发货匹配键重组使用选定订单的收货信息且不修改原始订单', async () => {
    const { application } = await createApplication([
      recognition('XY-MERGE-0001'),
      recognition('XY-MERGE-0002', {
        recipient: '周宁',
        phone: '13900000002',
        phoneNormalized: '13900000002',
        addressOriginal: '广东省深圳市福田区新风路2号',
        addressNormalized: '广东省深圳市福田区新风路2号',
        district: '福田区',
      }),
    ]);
    const before = application.queryShipmentGroups();
    const selectedOrder = before.groups[1].orders[0];
    const selectedOriginalOrder = application.getOrder(selectedOrder.id).order;
    const originalsBefore = before.groups.flatMap((group) => group.orders).map(({ id }) => (
      application.getOrder(id).order
    ));

    const result = application.mergeShipmentGroups({
      groupIds: before.groups.map(({ id }) => id),
      expectedMemberOrderIds: before.groups.flatMap((group) => (
        group.orders.map(({ id }) => id)
      )),
      selectedRecipientOrderId: selectedOrder.id,
      reason: '买家要求一起发货',
    });

    expect(result.projection.groups).toHaveLength(1);
    expect(result.projection.groups[0]).toMatchObject({
      formation: 'manual',
      selectedRecipientOrderId: selectedOrder.id,
      phone: selectedOriginalOrder.phone,
      addressOriginal: selectedOriginalOrder.addressOriginal,
      orderCount: 2,
    });
    expect(result.event).toMatchObject({
      operation: 'merge',
      sourceGroupIds: before.groups.map(({ id }) => id),
      selectedRecipientOrderId: selectedOrder.id,
      reason: '买家要求一起发货',
    });
    expect(originalsBefore.map(({ id }) => application.getOrder(id).order)).toEqual(
      originalsBefore,
    );
  });

  it('同一发货匹配键拆分后可重新组合且每笔订单仅属于一个开放组', async () => {
    const { application } = await createApplication([
      recognition('XY-REGROUP-0001'),
      recognition('XY-REGROUP-0002'),
      recognition('XY-REGROUP-0003'),
    ]);
    const automaticGroup = application.queryShipmentGroups().groups[0];
    const split = application.splitShipmentGroup({
      groupId: automaticGroup.id,
      expectedMemberOrderIds: automaticGroup.orders.map(({ id }) => id),
      splitOrderIds: [automaticGroup.orders[0].id],
      reason: '先单独包装',
    }).projection;

    const regrouped = application.mergeShipmentGroups({
      groupIds: split.groups.map(({ id }) => id),
      expectedMemberOrderIds: split.groups.flatMap((group) => group.orders.map(({ id }) => id)),
      selectedRecipientOrderId: null,
      reason: '恢复一起发货',
    }).projection;

    expect(regrouped.groups).toHaveLength(1);
    const membership = regrouped.groups.flatMap((group) => group.orders.map(({ id }) => id));
    expect(membership).toHaveLength(3);
    expect(new Set(membership).size).toBe(3);
    expect(application.listShipmentGroupAdjustmentEvents().map(({ operation }) => operation))
      .toEqual(['split', 'merge']);
  });

  it('最终收货信息来源订单离开待发货范围后不保留含糊重组', async () => {
    const { application } = await createApplication([
      recognition('XY-RECIPIENT-LEAVES-0001'),
      recognition('XY-RECIPIENT-LEAVES-0002', {
        phone: '13900000002',
        phoneNormalized: '13900000002',
        addressOriginal: '广东省深圳市福田区新风路2号',
        addressNormalized: '广东省深圳市福田区新风路2号',
        district: '福田区',
      }),
      recognition('XY-RECIPIENT-LEAVES-0003', {
        phone: '13700000003',
        phoneNormalized: '13700000003',
        addressOriginal: '广东省深圳市宝安区长风路3号',
        addressNormalized: '广东省深圳市宝安区长风路3号',
        district: '宝安区',
      }),
    ]);
    const before = application.queryShipmentGroups();
    const selectedOrderId = before.groups[0].orders[0].id;
    const selectedOrder = application.getOrder(selectedOrderId).order;
    application.mergeShipmentGroups({
      groupIds: before.groups.map(({ id }) => id),
      expectedMemberOrderIds: before.groups.flatMap((group) => group.orders.map(({ id }) => id)),
      selectedRecipientOrderId: selectedOrderId,
      reason: '原计划一起发货',
    });

    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: selectedOrderId, expectedRevision: selectedOrder.revision }],
      patch: { fulfillmentStatus: 'shipped', trackingNumber: 'YT-LEAVES-001' },
    });

    const after = application.queryShipmentGroups();
    expect(after.groups).toHaveLength(2);
    expect(after.groups.every(({ formation }) => formation === 'automatic')).toBe(true);
    expect(after.groups.flatMap((group) => group.orders)).toHaveLength(2);
    expect(application.listShipmentGroupAdjustmentEvents()).toHaveLength(1);
  });
});
