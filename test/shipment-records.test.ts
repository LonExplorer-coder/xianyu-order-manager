import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  OrderEditInput,
  OriginalOrder,
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
  items: RecognitionResult['items'],
): RecognitionResult {
  const productTotalCents = items.reduce(
    (total, item) => total + (item.unitPriceCents ?? 0) * item.quantity,
    0,
  );
  return {
    platform: 'xianyu',
    sellerAccount: '发货记录测试账号',
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
    orderedAtOriginal: '2026-08-12 09:00:00',
    orderedAtNormalized: '2026-08-12T09:00:00+08:00',
    paidAtOriginal: '2026-08-12 09:00:08',
    paidAtNormalized: '2026-08-12T09:00:08+08:00',
    productTotalCents,
    shippingFeeCents: 0,
    amountCents: productTotalCents,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items,
  };
}

function orderEditInput(order: OriginalOrder): OrderEditInput {
  return {
    orderId: order.id,
    expectedRevision: order.revision,
    identityCorrection: null,
    alipayTransactionNumber: order.alipayTransactionNumber,
    buyerNickname: order.buyerNickname,
    recipient: order.recipient,
    phone: order.phone,
    addressOriginal: order.addressOriginal,
    province: order.province,
    city: order.city,
    district: order.district,
    orderedAtOriginal: order.orderedAtOriginal,
    paidAtOriginal: order.paidAtOriginal,
    productTotalCents: order.productTotalCents ?? 0,
    shippingFeeCents: order.shippingFeeCents ?? 0,
    amountCents: order.amountCents,
    note: order.note ?? '',
    items: order.items.map((item) => ({
      id: item.id,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
    })),
  };
}

async function createApplication(
  root?: string,
  seedOrders = true,
) {
  const applicationRoot = root ?? await mkdtemp(join(tmpdir(), 'xianyu-shipment-records-'));
  const sourceDirectory = join(applicationRoot, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const recognitions = [
    recognition('XY-SHIPMENT-RECORD-0001', [{
      sourceTitle: '亚麻收纳袋',
      sourceSpec: '米白 大号',
      unitPriceCents: 1_000,
      quantity: 2,
      quantityInferred: false,
    }]),
    recognition('XY-SHIPMENT-RECORD-0002', [{
      sourceTitle: '透明标签贴',
      sourceSpec: '圆形',
      unitPriceCents: 500,
      quantity: 2,
      quantityInferred: false,
    }]),
    recognition('XY-SHIPMENT-RECORD-0003', [{
      sourceTitle: '后续新订单商品',
      sourceSpec: '独立发货轮次',
      unitPriceCents: 800,
      quantity: 2,
      quantityInferred: false,
    }]),
    recognition('XY-SHIPMENT-RECORD-0004', [{
      sourceTitle: '另一笔后续新订单商品',
      sourceSpec: '可独立调整',
      unitPriceCents: 900,
      quantity: 1,
      quantityInferred: false,
    }]),
  ];
  const application = new LocalApplication(new SequenceRecognizer([...recognitions]));
  openedApplications.push(application);
  application.openDataDirectory(join(applicationRoot, '数据'));
  if (!seedOrders) return application;
  for (const [index] of recognitions.slice(0, 2).entries()) {
    const sourcePath = join(sourceDirectory, `订单-${index + 1}.png`);
    await writeFile(sourcePath, Buffer.from(`shipment-record-order-${index + 1}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    application.confirmDraft(batch.drafts[0]);
  }
  return application;
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('发货记录', () => {
  it('第一次实际发出时建立发货组档案并在全部发出后标记已全部发货', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));

    const result = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ARCHIVE-0001',
        items: remainingItems,
      }],
    });

    const [archive] = application.queryShipmentGroupArchives();
    expect(archive).toMatchObject({
      sourceGroupId: group.id,
      status: 'fully_shipped',
      recipient: '林青',
      phone: '13800000001',
      orderNumbers: [
        'XY-SHIPMENT-RECORD-0001',
        'XY-SHIPMENT-RECORD-0002',
      ],
      shippedQuantity: 4,
      remainingQuantity: 0,
      totalQuantity: 4,
      records: [result.record],
    });
    expect(result.record.archiveId).toBe(archive.id);
  });

  it('把开放组的全部商品分配给一个包裹后生成可追溯记录并关闭开放组', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));

    const result = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000001',
        items: remainingItems,
      }],
    });

    expect(result.record).toMatchObject({
      sourceGroupId: group.id,
      status: 'active',
      recipient: '林青',
      totalQuantity: 4,
      packages: [{
        position: 0,
        status: 'active',
        logisticsStatus: 'in_transit',
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000001',
        totalQuantity: 4,
        items: expect.arrayContaining([
          expect.objectContaining({
            orderNumber: 'XY-SHIPMENT-RECORD-0001',
            sourceTitle: '亚麻收纳袋',
            quantity: 2,
          }),
          expect.objectContaining({
            orderNumber: 'XY-SHIPMENT-RECORD-0002',
            sourceTitle: '透明标签贴',
            quantity: 2,
          }),
        ]),
      }],
    });
    expect(application.queryShipmentRecords()).toEqual([result.record]);
    expect(application.queryShipmentGroups().groups).toEqual([]);
  });

  it('全部商品实际发出后同步订单履约状态', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));

    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000002',
        items: remainingItems,
      }],
    });

    expect(group.orders.map((order) => (
      application.getOrder(order.id).order.fulfillmentStatus
    ))).toEqual(['shipped', 'shipped']);

    const shippedOrder = application.getOrder(group.orders[0].id).order;
    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: shippedOrder.id, expectedRevision: shippedOrder.revision }],
      patch: { fulfillmentStatus: 'pending_shipment' },
    });
    expect(application.getOrder(shippedOrder.id).order.fulfillmentStatus).toBe('shipped');
  });

  it('分批实际发出持续写入同一发货组档案并累计商品进度', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const firstItem = expectedRemainingItems[0];

    const first = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ARCHIVE-PART-1',
        items: [{ ...firstItem, quantity: 1 }],
      }],
    });

    expect(application.queryShipmentGroupArchives()[0]).toMatchObject({
      id: first.record.archiveId,
      status: 'partially_shipped',
      shippedQuantity: 1,
      remainingQuantity: 3,
      totalQuantity: 4,
      records: [{ id: first.record.id }],
    });

    const remainingGroup = application.queryShipmentGroupArchives()[0].remainingGroup;
    expect(remainingGroup).not.toBeNull();
    if (!remainingGroup) throw new Error('测试要求发货组档案仍有待发商品');
    const remainingItems = remainingGroup.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const second = application.confirmShipment({
      groupId: remainingGroup.id,
      archiveId: first.record.archiveId,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ARCHIVE-PART-2',
        items: remainingItems,
      }],
    });

    expect(second.record.archiveId).toBe(first.record.archiveId);
    expect(application.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        id: first.record.archiveId,
        status: 'fully_shipped',
        shippedQuantity: 4,
        remainingQuantity: 0,
        totalQuantity: 4,
        records: [
          expect.objectContaining({ id: second.record.id }),
          expect.objectContaining({ id: first.record.id }),
        ],
      }),
    ]);
  });

  it('成员订单修改收货信息后仍按档案固定成员累计全部剩余数量', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ARCHIVE-RECIPIENT-CHANGE-1',
        items: [{ ...expectedRemainingItems[0], quantity: 1 }],
      }],
    });

    const changedOrder = application.getOrder(group.orders[1].id).order;
    application.confirmOrderEdit({
      ...orderEditInput(changedOrder),
      addressOriginal: '浙江省杭州市西湖区新地址2号',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
    });

    expect(application.queryShipmentGroups().groups).toEqual([]);
    expect(application.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        recipient: '林青',
        addressOriginal: '广东省深圳市南山区海风路1号',
        shippedQuantity: 1,
        remainingQuantity: 3,
        totalQuantity: 4,
        orderNumbers: [
          'XY-SHIPMENT-RECORD-0001',
          'XY-SHIPMENT-RECORD-0002',
        ],
        recipientDifferences: [{
          orderId: changedOrder.id,
          orderNumber: 'XY-SHIPMENT-RECORD-0002',
          fields: ['address'],
        }],
      }),
    ]);
  });

  it('成员订单全部取消后仍按实际发出数量保持部分发货', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-CANCELLED-MEMBERS-PARTIAL',
        items: [{ ...expectedRemainingItems[0], quantity: 1 }],
      }],
    });

    for (const member of group.orders) {
      const current = application.getOrder(member.id).order;
      application.updateOrderStatusAndLogistics({
        targets: [{ orderId: member.id, expectedRevision: current.revision }],
        patch: { platformTransactionStatus: 'cancelled' },
      });
    }

    expect(application.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        status: 'partially_shipped',
        shippedQuantity: 1,
        remainingQuantity: 3,
        totalQuantity: 4,
        remainingGroup: null,
      }),
    ]);
  });

  it('只把成员建档后的收货信息变化标为差异', async () => {
    const application = await createApplication();
    const initialGroup = application.queryShipmentGroups().groups[0];
    const secondOrder = application.getOrder(initialGroup.orders[1].id).order;
    application.confirmOrderEdit({
      ...orderEditInput(secondOrder),
      recipient: '建档时已有差异的收件人',
    });
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ARCHIVE-MEMBER-SNAPSHOT-1',
        items: [{ ...remainingItems[0], quantity: 1 }],
      }],
    });

    expect(application.queryShipmentGroupArchives()[0].recipientDifferences).toEqual([]);

    const archivedSecondOrder = application.getOrder(secondOrder.id).order;
    application.confirmOrderEdit({
      ...orderEditInput(archivedSecondOrder),
      recipient: '林青',
    });
    expect(application.queryShipmentGroupArchives()[0].recipientDifferences).toEqual([{
      orderId: secondOrder.id,
      orderNumber: 'XY-SHIPMENT-RECORD-0002',
      fields: ['recipient'],
    }]);
  });

  it('固定成员后来取消交易时仍保留在档案并标明不可继续发货', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ARCHIVE-MEMBER-CANCELLED-1',
        items: [{ ...expectedRemainingItems[0], quantity: 1 }],
      }],
    });

    const cancelledOrder = application.getOrder(group.orders[1].id).order;
    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: cancelledOrder.id, expectedRevision: cancelledOrder.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });

    expect(application.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        orderNumbers: [
          'XY-SHIPMENT-RECORD-0001',
          'XY-SHIPMENT-RECORD-0002',
        ],
        memberOrders: [
          expect.objectContaining({
            orderNumber: 'XY-SHIPMENT-RECORD-0001',
            hasRemainingShipment: true,
          }),
          expect.objectContaining({
            orderNumber: 'XY-SHIPMENT-RECORD-0002',
            hasRemainingShipment: false,
          }),
        ],
      }),
    ]);
  });

  it('同收货信息的后续新订单独立进入待发货组并可正常拆分', async () => {
    const application = await createApplication();
    const firstGroup = application.queryShipmentGroups().groups[0];
    const firstRemainingItems = firstGroup.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    application.confirmShipment({
      groupId: firstGroup.id,
      expectedRemainingItems: firstRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ARCHIVE-NEW-PENDING-GROUP-1',
        items: [{ ...firstRemainingItems[0], quantity: 1 }],
      }],
    });

    for (const index of [3, 4]) {
      const sourcePath = join(tmpdir(), `shipment-record-new-pending-${index}-${randomUUID()}.png`);
      await writeFile(sourcePath, Buffer.from(`shipment-record-new-pending-${index}`));
      const batch = await application.submitRecognitionBatch([sourcePath]);
      application.confirmDraft(batch.drafts[0]);
    }

    const newGroup = application.queryShipmentGroups().groups[0];
    expect(newGroup.orders.map(({ orderNumber }) => orderNumber)).toEqual([
      'XY-SHIPMENT-RECORD-0003',
      'XY-SHIPMENT-RECORD-0004',
    ]);
    const splitOrderId = newGroup.orders[0].id;
    const split = application.splitShipmentGroup({
      groupId: newGroup.id,
      expectedMemberOrderIds: newGroup.orders.map(({ id }) => id),
      splitOrderIds: [splitOrderId],
      reason: '后续新订单需要分别包装',
    });
    expect(split.projection.groups.map(({ orderCount }) => orderCount)).toEqual([1, 1]);
    expect(split.projection.groups.flatMap(({ orders }) => (
      orders.map(({ orderNumber }) => orderNumber)
    )).sort()).toEqual([
      'XY-SHIPMENT-RECORD-0003',
      'XY-SHIPMENT-RECORD-0004',
    ]);
  });

  it('相同收货信息之后形成的新订单不会混入已经完成的旧档案', async () => {
    const application = await createApplication();
    const firstGroup = application.queryShipmentGroups().groups[0];
    const firstItems = firstGroup.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const first = application.confirmShipment({
      groupId: firstGroup.id,
      expectedRemainingItems: firstItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ARCHIVE-CYCLE-1',
        items: firstItems,
      }],
    });

    const laterSourcePath = join(tmpdir(), `shipment-record-later-${randomUUID()}.png`);
    await writeFile(laterSourcePath, Buffer.from('shipment-record-later-order'));
    const laterBatch = await application.submitRecognitionBatch([laterSourcePath]);
    application.confirmDraft(laterBatch.drafts[0]);
    const laterGroup = application.queryShipmentGroups().groups[0];
    const laterItems = laterGroup.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const later = application.confirmShipment({
      groupId: laterGroup.id,
      expectedRemainingItems: laterItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ARCHIVE-CYCLE-2',
        items: laterItems,
      }],
    });

    expect(laterGroup.id).toBe(firstGroup.id);
    expect(later.record.archiveId).not.toBe(first.record.archiveId);
    expect(application.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        id: later.record.archiveId,
        status: 'fully_shipped',
        orderNumbers: ['XY-SHIPMENT-RECORD-0003'],
      }),
      expect.objectContaining({
        id: first.record.archiveId,
        status: 'fully_shipped',
        orderNumbers: [
          'XY-SHIPMENT-RECORD-0001',
          'XY-SHIPMENT-RECORD-0002',
        ],
      }),
    ]);
  });

  it('新一轮部分发货后撤销旧轮次时分别恢复两个发货组档案', async () => {
    const application = await createApplication();
    const firstGroup = application.queryShipmentGroups().groups[0];
    const firstItems = firstGroup.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const first = application.confirmShipment({
      groupId: firstGroup.id,
      expectedRemainingItems: firstItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-OLD-CYCLE',
        items: firstItems,
      }],
    });

    const laterSourcePath = join(tmpdir(), `shipment-record-overlap-${randomUUID()}.png`);
    await writeFile(laterSourcePath, Buffer.from('shipment-record-overlap-order'));
    const laterBatch = await application.submitRecognitionBatch([laterSourcePath]);
    application.confirmDraft(laterBatch.drafts[0]);
    const laterGroup = application.queryShipmentGroups().groups[0];
    const laterItem = laterGroup.orders[0].items[0];
    const later = application.confirmShipment({
      groupId: laterGroup.id,
      expectedRemainingItems: [{
        orderId: laterGroup.orders[0].id,
        orderItemId: laterItem.id,
        quantity: laterItem.quantity,
      }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-NEW-CYCLE-PART',
        items: [{
          orderId: laterGroup.orders[0].id,
          orderItemId: laterItem.id,
          quantity: 1,
        }],
      }],
    });

    application.cancelShipmentPackages({
      recordId: first.record.id,
      packageIds: [first.record.packages[0].id],
      reason: '旧轮次包裹尚未交寄，恢复待发',
    });

    const openArchives = application.queryShipmentGroupArchives()
      .filter(({ status }) => status === 'partially_shipped');
    expect(openArchives).toHaveLength(2);
    expect(openArchives.find(({ id }) => id === first.record.archiveId)).toMatchObject({
      shippedQuantity: 0,
      remainingQuantity: 4,
      totalQuantity: 4,
      orderNumbers: [
        'XY-SHIPMENT-RECORD-0001',
        'XY-SHIPMENT-RECORD-0002',
      ],
    });
    expect(openArchives.find(({ id }) => id === later.record.archiveId)).toMatchObject({
      shippedQuantity: 1,
      remainingQuantity: 1,
      totalQuantity: 2,
      orderNumbers: ['XY-SHIPMENT-RECORD-0003'],
    });

    const restoredOldGroup = application.queryShipmentGroupArchives().find(
      ({ id }) => id === first.record.archiveId,
    )?.remainingGroup;
    expect(restoredOldGroup).not.toBeNull();
    if (!restoredOldGroup) throw new Error('测试要求旧发货组档案恢复为部分发货');
    const restoredOldItems = restoredOldGroup.orders
      .flatMap((order) => order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      })));
    const resentOld = application.confirmShipment({
      groupId: restoredOldGroup.id,
      archiveId: first.record.archiveId,
      expectedRemainingItems: restoredOldItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-OLD-CYCLE-RESENT',
        items: restoredOldItems,
      }],
    });
    expect(resentOld.record.archiveId).toBe(first.record.archiveId);
    expect(application.queryShipmentGroupArchives().find(
      ({ id }) => id === later.record.archiveId,
    )).toMatchObject({ status: 'partially_shipped', remainingQuantity: 1 });
  });

  it('升级旧版发货记录时补建已全部发货档案并保留原包裹与商品', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-archive-migration-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const items = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: items,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V18-ARCHIVE-BACKFILL',
        items,
      }],
    });
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_require_archive_on_insert;
        ALTER TABLE shipment_records DROP COLUMN shipment_group_archive_id;
        DROP TABLE shipment_group_archives;
        DELETE FROM schema_migrations WHERE version IN (19, 20, 21, 22, 23, 24, 25);
        COMMIT;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        status: 'fully_shipped',
        sourceGroupId: group.id,
        orderNumbers: [
          'XY-SHIPMENT-RECORD-0001',
          'XY-SHIPMENT-RECORD-0002',
        ],
        records: [expect.objectContaining({
          id: confirmation.record.id,
          packages: [expect.objectContaining({
            trackingNumber: 'SF-V18-ARCHIVE-BACKFILL',
            totalQuantity: 4,
          })],
        })],
      }),
    ]);
  });

  it('升级旧版部分发货记录时按订单完整数量恢复为部分发货档案', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-partial-v18-shipment-migration-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V18-PARTIAL-RECORD',
        items: [{ ...expectedRemainingItems[0], quantity: 1 }],
      }],
    });
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_require_archive_on_insert;
        ALTER TABLE shipment_records DROP COLUMN shipment_group_archive_id;
        DROP TABLE shipment_group_archives;
        DELETE FROM schema_migrations WHERE version IN (19, 20, 21, 22, 23, 24, 25);
        COMMIT;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        id: `legacy-shipment-group-archive-${confirmation.record.id}`,
        status: 'partially_shipped',
        shippedQuantity: 1,
        remainingQuantity: 1,
        totalQuantity: 2,
        remainingGroup: expect.objectContaining({
          orderCount: 1,
          totalQuantity: 1,
        }),
      }),
    ]);
    expect(reopened.queryShipmentGroups().groups).toEqual([
      expect.objectContaining({
        orderCount: 1,
        orders: [expect.objectContaining({ id: group.orders[1].id })],
        totalQuantity: 2,
      }),
    ]);
  });

  it('升级旧版同一订单的多条发货记录时归入同一档案并按商品数量去重', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-overlapping-v18-shipment-migration-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const first = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V18-SAME-ORDER-1',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    const remainingGroup = first.archive.remainingGroup;
    if (!remainingGroup) throw new Error('测试要求第一次发货后仍有剩余商品');
    const second = application.confirmShipment({
      groupId: remainingGroup.id,
      archiveId: first.archive.id,
      expectedRemainingItems: remainingGroup.orders.flatMap((order) => (
        order.items.map((item) => ({
          orderId: order.id,
          orderItemId: item.id,
          quantity: item.quantity,
        }))
      )),
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V18-SAME-ORDER-2',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_require_archive_on_insert;
        ALTER TABLE shipment_records DROP COLUMN shipment_group_archive_id;
        DROP TABLE shipment_group_archives;
        DELETE FROM schema_migrations WHERE version IN (19, 20, 21, 22, 23, 24, 25);
        COMMIT;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        status: 'fully_shipped',
        orderIds: [firstOrder.id],
        orderNumbers: [firstOrder.orderNumber],
        shippedQuantity: 2,
        remainingQuantity: 0,
        totalQuantity: 2,
        records: expect.arrayContaining([
          expect.objectContaining({ id: first.record.id }),
          expect.objectContaining({ id: second.record.id }),
        ]),
      }),
    ]);
  });

  it('归并重叠档案时按商品身份去重并保留后来替换的商品', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-overlapping-archive-total-dedup-'));
    const application = await createApplication(root);
    const combinedGroup = application.queryShipmentGroups().groups[0];
    const [firstOrder] = combinedGroup.orders;
    const [firstItem] = firstOrder.items;
    const split = application.splitShipmentGroup({
      groupId: combinedGroup.id,
      expectedMemberOrderIds: combinedGroup.orders.map(({ id }) => id),
      splitOrderIds: [firstOrder.id],
      reason: '隔离单订单重复档案回归场景',
    });
    const singleOrderGroup = split.projection.groups.find(({ orders }) => (
      orders.length === 1 && orders[0]?.id === firstOrder.id
    ));
    if (!singleOrderGroup) throw new Error('测试要求拆出单订单发货组');
    const expectedRemainingItems = [{
      orderId: firstOrder.id,
      orderItemId: firstItem.id,
      quantity: firstItem.quantity,
    }];
    const first = application.confirmShipment({
      groupId: singleOrderGroup.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-DUPLICATE-TOTAL-1',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    const remainingGroup = first.archive.remainingGroup;
    if (!remainingGroup) throw new Error('测试要求第一次发货后剩余一件商品');
    const second = application.confirmShipment({
      groupId: remainingGroup.id,
      archiveId: first.archive.id,
      expectedRemainingItems: [{
        orderId: firstOrder.id,
        orderItemId: firstItem.id,
        quantity: 1,
      }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-DUPLICATE-TOTAL-2',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    application.close();

    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const database = new DatabaseSync(databasePath);
    const legacyArchiveId = `legacy-shipment-group-archive-${first.record.id}`;
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_are_immutable_on_update;
      `);
      database.prepare(`
        INSERT INTO shipment_group_archives (
          id, source_group_id, status,
          recipient, phone, phone_normalized,
          address_original, address_normalized,
          member_order_ids_json, member_recipient_snapshots_json,
          total_quantity, created_at, fully_shipped_at, updated_at
        ) VALUES (?, ?, 'fully_shipped', ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?)
      `).run(
        legacyArchiveId,
        singleOrderGroup.id,
        firstOrder.recipient,
        firstOrder.phone,
        firstOrder.phoneNormalized,
        firstOrder.addressOriginal,
        firstOrder.addressNormalized,
        JSON.stringify([firstOrder.id]),
        JSON.stringify([{
          orderId: firstOrder.id,
          recipient: firstOrder.recipient,
          phone: firstOrder.phone,
          addressOriginal: firstOrder.addressOriginal,
        }]),
        first.record.createdAt,
        first.record.createdAt,
        first.record.createdAt,
      );
      database.prepare(`
        UPDATE shipment_records
        SET shipment_group_archive_id = ?
        WHERE id = ?
      `).run(legacyArchiveId, first.record.id);
      database.prepare('DELETE FROM order_items WHERE id = ?').run(firstItem.id);
      database.prepare(`
        INSERT INTO order_items (
          id, order_id, position, source_title, source_spec,
          unit_price_cents, quantity, quantity_source, subtotal_cents
        ) VALUES (?, ?, 0, ?, ?, ?, 1, 'manual', ?)
      `).run(
        randomUUID(),
        firstOrder.id,
        '替换后的新商品',
        '新规格',
        firstItem.unitPriceCents,
        firstItem.unitPriceCents,
      );
      database.exec(`
        CREATE TRIGGER shipment_records_are_immutable_on_update
        BEFORE UPDATE ON shipment_records
        BEGIN
          SELECT RAISE(ABORT, 'shipment records are immutable');
        END;
        DELETE FROM schema_migrations WHERE version IN (21, 22, 23, 24, 25);
        COMMIT;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(migratedDatabase.prepare(`
        SELECT total_quantity AS totalQuantity
        FROM shipment_group_archives
      `).all()).toEqual([{ totalQuantity: 3 }]);
    } finally {
      migratedDatabase.close();
    }
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        status: 'partially_shipped',
        orderIds: [firstOrder.id],
        shippedQuantity: 2,
        remainingQuantity: 1,
        totalQuantity: 3,
        records: expect.arrayContaining([
          expect.objectContaining({ id: first.record.id }),
          expect.objectContaining({ id: second.record.id }),
        ]),
      }),
    ]);
  });

  it('升级时按修订顺序倒推同一时刻连续增加过的商品数量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-repair-merged-archive-total-'));
    const application = await createApplication(root);
    const combinedGroup = application.queryShipmentGroups().groups[0];
    const [firstOrder] = combinedGroup.orders;
    const [firstItem] = firstOrder.items;
    const split = application.splitShipmentGroup({
      groupId: combinedGroup.id,
      expectedMemberOrderIds: combinedGroup.orders.map(({ id }) => id),
      splitOrderIds: [firstOrder.id],
      reason: '隔离已归并总数修复回归场景',
    });
    const singleOrderGroup = split.projection.groups.find(({ orders }) => (
      orders.length === 1 && orders[0]?.id === firstOrder.id
    ));
    if (!singleOrderGroup) throw new Error('测试要求拆出单订单发货组');
    const first = application.confirmShipment({
      groupId: singleOrderGroup.id,
      expectedRemainingItems: [{
        orderId: firstOrder.id,
        orderItemId: firstItem.id,
        quantity: firstItem.quantity,
      }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-REPAIR-DUPLICATE-TOTAL-1',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    const remainingGroup = first.archive.remainingGroup;
    if (!remainingGroup) throw new Error('测试要求第一次发货后剩余一件商品');
    const second = application.confirmShipment({
      groupId: remainingGroup.id,
      archiveId: first.archive.id,
      expectedRemainingItems: [{
        orderId: firstOrder.id,
        orderItemId: firstItem.id,
        quantity: 1,
      }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-REPAIR-DUPLICATE-TOTAL-2',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    const legacyArchiveId = `legacy-shipment-group-archive-${first.record.id}`;
    const firstRecordTime = new Date('2026-08-12T02:00:00.000Z').toISOString();
    const version19Time = new Date('2026-08-12T02:00:01.000Z').toISOString();
    const secondRecordTime = new Date('2026-08-12T02:00:02.000Z').toISOString();
    const version21Time = new Date('2026-08-12T02:00:03.000Z').toISOString();
    const itemEditTime = new Date('2026-08-12T02:00:04.000Z').toISOString();
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_are_immutable_on_update;
      `);
      database.prepare(`
        INSERT INTO shipment_group_archives (
          id, source_group_id, status,
          recipient, phone, phone_normalized,
          address_original, address_normalized,
          member_order_ids_json, member_recipient_snapshots_json,
          total_quantity, created_at, fully_shipped_at, updated_at
        )
        SELECT
          ?, source_group_id, 'partially_shipped',
          recipient, phone, phone_normalized,
          address_original, address_normalized,
          member_order_ids_json, member_recipient_snapshots_json,
          4, created_at, NULL, updated_at
        FROM shipment_group_archives
        WHERE id = ?
      `).run(legacyArchiveId, first.archive.id);
      database.prepare(`
        UPDATE shipment_records
        SET shipment_group_archive_id = ?, created_at = CASE id WHEN ? THEN ? ELSE ? END
        WHERE shipment_group_archive_id = ?
      `).run(
        legacyArchiveId,
        first.record.id,
        firstRecordTime,
        secondRecordTime,
        first.archive.id,
      );
      database.prepare(`
        DELETE FROM shipment_group_archives
        WHERE id = ?
      `).run(first.archive.id);
      database.prepare(`
        UPDATE schema_migrations
        SET applied_at = ?
        WHERE version = 19
      `).run(version19Time);
      database.prepare(`
        UPDATE schema_migrations
        SET applied_at = ?
        WHERE version = 21
      `).run(version21Time);
      const orderRevision = database.prepare(`
        SELECT revision
        FROM original_orders
        WHERE id = ?
      `).get(firstOrder.id) as { revision: number } | undefined;
      if (!orderRevision) throw new Error('测试要求订单仍然存在');
      const firstEditEventId = 'quantity-edit-z-first';
      const secondEditEventId = 'quantity-edit-a-second';
      database.prepare(`
        UPDATE order_items
        SET quantity = 5, subtotal_cents = unit_price_cents * 5
        WHERE id = ?
      `).run(firstItem.id);
      database.prepare(`
        UPDATE original_orders
        SET revision = revision + 2, updated_at = ?
        WHERE id = ?
      `).run(itemEditTime, firstOrder.id);
      database.prepare(`
        INSERT INTO order_change_events (
          id, order_id, source_snapshot_id, source,
          base_revision, result_revision, created_at
        ) VALUES (?, ?, NULL, 'manual_edit', ?, ?, ?)
      `).run(
        firstEditEventId,
        firstOrder.id,
        orderRevision.revision,
        orderRevision.revision + 1,
        itemEditTime,
      );
      database.prepare(`
        INSERT INTO order_change_events (
          id, order_id, source_snapshot_id, source,
          base_revision, result_revision, created_at
        ) VALUES (?, ?, NULL, 'manual_edit', ?, ?, ?)
      `).run(
        secondEditEventId,
        firstOrder.id,
        orderRevision.revision + 1,
        orderRevision.revision + 2,
        itemEditTime,
      );
      database.prepare(`
        INSERT INTO order_field_changes (
          id, event_id, field_path, before_json, after_json
        ) VALUES (?, ?, 'items[0].quantity', '2', '3')
      `).run(randomUUID(), firstEditEventId);
      database.prepare(`
        INSERT INTO order_field_changes (
          id, event_id, field_path, before_json, after_json
        ) VALUES (?, ?, 'items[0].quantity', '3', '5')
      `).run(randomUUID(), secondEditEventId);
      database.exec(`
        CREATE TRIGGER shipment_records_are_immutable_on_update
        BEFORE UPDATE ON shipment_records
        BEGIN
          SELECT RAISE(ABORT, 'shipment records are immutable');
        END;
        DELETE FROM schema_migrations WHERE version IN (22, 23, 24, 25);
        COMMIT;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        id: legacyArchiveId,
        status: 'fully_shipped',
        shippedQuantity: 2,
        remainingQuantity: 0,
        totalQuantity: 2,
      }),
    ]);
  });

  it('升级时不会因成员商品后来删除而缩小正常档案的冻结总件数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-preserve-normal-archive-total-'));
    const seeded = await createApplication(root);
    const seededGroup = seeded.queryShipmentGroups().groups[0];
    const seededFirstItem = seededGroup.orders[0]?.items[0];
    if (!seededFirstItem) throw new Error('测试要求订单含有商品');
    seeded.close();
    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const preparedDatabase = new DatabaseSync(databasePath);
    const removedItemId = randomUUID();
    try {
      preparedDatabase.prepare(`
        UPDATE order_items
        SET quantity = 2, subtotal_cents = unit_price_cents * 2
        WHERE id = ?
      `).run(seededFirstItem.id);
      preparedDatabase.prepare(`
        INSERT INTO order_items (
          id, order_id, position, source_title, source_spec,
          unit_price_cents, quantity, quantity_source, subtotal_cents
        ) VALUES (?, ?, 1, '尚未发出的商品', '待删除规格', 500, 1, 'manual', 500)
      `).run(removedItemId, seededGroup.orders[0]?.id);
    } finally {
      preparedDatabase.close();
    }

    const application = await createApplication(root, false);
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const split = application.splitShipmentGroup({
      groupId: group.id,
      expectedMemberOrderIds: group.orders.map(({ id }) => id),
      splitOrderIds: [firstOrder.id],
      reason: '隔离正常档案总数保留回归场景',
    });
    const singleOrderGroup = split.projection.groups.find(({ orders }) => (
      orders.length === 1 && orders[0]?.id === firstOrder.id
    ));
    if (!singleOrderGroup) throw new Error('测试要求拆出单订单发货组');
    const first = application.confirmShipment({
      groupId: singleOrderGroup.id,
      expectedRemainingItems: firstOrder.items.map((item) => ({
        orderId: firstOrder.id,
        orderItemId: item.id,
        quantity: item.quantity,
      })),
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-PRESERVE-NORMAL-TOTAL-1',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    const remainingGroup = first.archive.remainingGroup;
    if (!remainingGroup) throw new Error('测试要求第一次发货后剩余商品');
    const second = application.confirmShipment({
      groupId: remainingGroup.id,
      archiveId: first.archive.id,
      expectedRemainingItems: remainingGroup.orders[0]?.items.map((item) => ({
        orderId: firstOrder.id,
        orderItemId: item.id,
        quantity: item.quantity,
      })) ?? [],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-PRESERVE-NORMAL-TOTAL-2',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    application.close();

    const database = new DatabaseSync(databasePath);
    const legacyArchiveId = `legacy-shipment-group-archive-${first.record.id}`;
    const firstRecordTime = new Date('2026-08-12T01:00:00.000Z').toISOString();
    const version19Time = new Date('2026-08-12T01:00:01.000Z').toISOString();
    const secondRecordTime = new Date('2026-08-12T01:00:02.000Z').toISOString();
    const itemRemovalTime = new Date('2026-08-12T01:00:02.500Z').toISOString();
    const version21Time = new Date('2026-08-12T01:00:03.000Z').toISOString();
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_are_immutable_on_update;
      `);
      database.prepare(`
        INSERT INTO shipment_group_archives (
          id, source_group_id, status,
          recipient, phone, phone_normalized,
          address_original, address_normalized,
          member_order_ids_json, member_recipient_snapshots_json,
          total_quantity, created_at, fully_shipped_at, updated_at
        )
        SELECT
          ?, source_group_id, status,
          recipient, phone, phone_normalized,
          address_original, address_normalized,
          member_order_ids_json, member_recipient_snapshots_json,
          total_quantity, ?, fully_shipped_at, updated_at
        FROM shipment_group_archives
        WHERE id = ?
      `).run(legacyArchiveId, firstRecordTime, first.archive.id);
      database.prepare(`
        UPDATE shipment_records
        SET shipment_group_archive_id = ?, created_at = CASE id WHEN ? THEN ? ELSE ? END
        WHERE shipment_group_archive_id = ?
      `).run(
        legacyArchiveId,
        first.record.id,
        firstRecordTime,
        secondRecordTime,
        first.archive.id,
      );
      database.prepare('DELETE FROM shipment_group_archives WHERE id = ?')
        .run(first.archive.id);
      const orderRevision = database.prepare(`
        SELECT revision
        FROM original_orders
        WHERE id = ?
      `).get(firstOrder.id) as { revision: number } | undefined;
      if (!orderRevision) throw new Error('测试要求订单仍然存在');
      const removalEventId = randomUUID();
      database.prepare('DELETE FROM order_items WHERE id = ?').run(removedItemId);
      database.prepare(`
        UPDATE original_orders
        SET revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(itemRemovalTime, firstOrder.id);
      database.prepare(`
        INSERT INTO order_change_events (
          id, order_id, source_snapshot_id, source,
          base_revision, result_revision, created_at
        ) VALUES (?, ?, NULL, 'manual_edit', ?, ?, ?)
      `).run(
        removalEventId,
        firstOrder.id,
        orderRevision.revision,
        orderRevision.revision + 1,
        itemRemovalTime,
      );
      database.prepare(`
        INSERT INTO order_field_changes (
          id, event_id, field_path, before_json, after_json
        ) VALUES (?, ?, 'items.removed[1]', ?, 'null')
      `).run(randomUUID(), removalEventId, JSON.stringify({ quantity: 1 }));
      database.prepare('UPDATE schema_migrations SET applied_at = ? WHERE version = 19')
        .run(version19Time);
      database.prepare('UPDATE schema_migrations SET applied_at = ? WHERE version = 21')
        .run(version21Time);
      database.exec(`
        CREATE TRIGGER shipment_records_are_immutable_on_update
        BEFORE UPDATE ON shipment_records
        BEGIN
          SELECT RAISE(ABORT, 'shipment records are immutable');
        END;
        DELETE FROM schema_migrations WHERE version IN (22, 23, 24, 25);
        COMMIT;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        id: legacyArchiveId,
        status: 'partially_shipped',
        shippedQuantity: 2,
        remainingQuantity: 1,
        totalQuantity: 3,
      }),
    ]);
  });

  it('升级已继续发货的数据时把承接同一订单的新档案归入旧版历史档案', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-overlapping-v20-archive-migration-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const first = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V20-LEGACY-PART',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    const remainingGroup = first.archive.remainingGroup;
    if (!remainingGroup) throw new Error('测试要求第一次发货后仍有剩余商品');
    const remainingItems = remainingGroup.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));
    const second = application.confirmShipment({
      groupId: remainingGroup.id,
      archiveId: first.archive.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V20-CONTINUED',
        items: remainingItems,
      }],
    });
    application.close();

    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const version20Database = new DatabaseSync(databasePath);
    const legacyArchiveId = `legacy-shipment-group-archive-${first.record.id}`;
    const latestRecipient = {
      recipient: '新收件人',
      phone: '13900000002',
      phoneNormalized: '13900000002',
      addressOriginal: '广东省深圳市福田区新址路2号',
      addressNormalized: '广东省深圳市福田区新址路2号',
    };
    try {
      version20Database.exec(`
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_are_immutable_on_update;
      `);
      version20Database.prepare(`
        INSERT INTO shipment_group_archives (
          id, source_group_id, status,
          recipient, phone, phone_normalized,
          address_original, address_normalized,
          member_order_ids_json, member_recipient_snapshots_json,
          total_quantity, created_at, fully_shipped_at, updated_at
        ) VALUES (?, ?, 'fully_shipped', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        legacyArchiveId,
        group.id,
        firstOrder.recipient,
        firstOrder.phone,
        firstOrder.phoneNormalized,
        firstOrder.addressOriginal,
        firstOrder.addressNormalized,
        JSON.stringify([firstOrder.id]),
        JSON.stringify([{
          orderId: firstOrder.id,
          recipient: firstOrder.recipient,
          phone: firstOrder.phone,
          addressOriginal: firstOrder.addressOriginal,
        }]),
        first.record.createdAt,
        first.record.createdAt,
        first.record.createdAt,
      );
      version20Database.prepare(`
        UPDATE shipment_records
        SET shipment_group_archive_id = ?
        WHERE id = ?
      `).run(legacyArchiveId, first.record.id);
      version20Database.prepare(`
        UPDATE shipment_group_archives
        SET
          recipient = ?,
          phone = ?,
          phone_normalized = ?,
          address_original = ?,
          address_normalized = ?,
          total_quantity = 3,
          updated_at = ?
        WHERE id = ?
      `).run(
        latestRecipient.recipient,
        latestRecipient.phone,
        latestRecipient.phoneNormalized,
        latestRecipient.addressOriginal,
        latestRecipient.addressNormalized,
        second.record.createdAt,
        first.archive.id,
      );
      version20Database.exec(`
        CREATE TRIGGER shipment_records_are_immutable_on_update
        BEFORE UPDATE ON shipment_records
        BEGIN
          SELECT RAISE(ABORT, 'shipment records are immutable');
        END;
        DELETE FROM schema_migrations WHERE version IN (21, 22, 23, 24, 25);
        COMMIT;
      `);
    } finally {
      version20Database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        status: 'fully_shipped',
        orderIds: group.orders.map(({ id }) => id).sort(),
        shippedQuantity: 4,
        remainingQuantity: 0,
        totalQuantity: 4,
        recipient: latestRecipient.recipient,
        phone: latestRecipient.phone,
        phoneNormalized: latestRecipient.phoneNormalized,
        addressOriginal: latestRecipient.addressOriginal,
        addressNormalized: latestRecipient.addressNormalized,
        records: expect.arrayContaining([
          expect.objectContaining({ id: first.record.id }),
          expect.objectContaining({ id: second.record.id }),
        ]),
      }),
    ]);
  });

  it('旧版重叠档案证据损坏时整体回滚归并、记录和不可变触发器', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-overlapping-archive-rollback-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const first = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-MERGE-ROLLBACK-1',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    const remainingGroup = first.archive.remainingGroup;
    if (!remainingGroup) throw new Error('测试要求第一次发货后仍有剩余商品');
    const remainingItems = remainingGroup.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));
    application.confirmShipment({
      groupId: remainingGroup.id,
      archiveId: first.archive.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-MERGE-ROLLBACK-2',
        items: remainingItems,
      }],
    });
    application.close();

    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const legacyArchiveId = `legacy-shipment-group-archive-${first.record.id}`;
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_are_immutable_on_update;
      `);
      database.prepare(`
        INSERT INTO shipment_group_archives (
          id, source_group_id, status,
          recipient, phone, phone_normalized,
          address_original, address_normalized,
          member_order_ids_json, member_recipient_snapshots_json,
          total_quantity, created_at, fully_shipped_at, updated_at
        ) VALUES (?, ?, 'fully_shipped', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        legacyArchiveId,
        group.id,
        firstOrder.recipient,
        firstOrder.phone,
        firstOrder.phoneNormalized,
        firstOrder.addressOriginal,
        firstOrder.addressNormalized,
        JSON.stringify([firstOrder.id]),
        JSON.stringify([
          {
            orderId: firstOrder.id,
            recipient: firstOrder.recipient,
            phone: firstOrder.phone,
            addressOriginal: firstOrder.addressOriginal,
          },
          {
            orderId: 'unrelated-order-snapshot',
            recipient: firstOrder.recipient,
            phone: firstOrder.phone,
            addressOriginal: firstOrder.addressOriginal,
          },
        ]),
        first.record.createdAt,
        first.record.createdAt,
        first.record.createdAt,
      );
      database.prepare(`
        UPDATE shipment_records
        SET shipment_group_archive_id = ?
        WHERE id = ?
      `).run(legacyArchiveId, first.record.id);
      database.exec(`
        CREATE TRIGGER shipment_records_are_immutable_on_update
        BEFORE UPDATE ON shipment_records
        BEGIN
          SELECT RAISE(ABORT, 'shipment records are immutable');
        END;
        DELETE FROM schema_migrations WHERE version IN (21, 22, 23, 24, 25);
        COMMIT;
      `);
    } finally {
      database.close();
    }

    expect(() => createApplication(root, false)).rejects.toThrow(
      '旧版发货组档案成员与收货快照不一致',
    );
    const checked = new DatabaseSync(databasePath);
    try {
      expect(checked.prepare(`
        SELECT version FROM schema_migrations WHERE version = 21
      `).get()).toBeUndefined();
      expect(checked.prepare(`
        SELECT shipment_group_archive_id AS archiveId
        FROM shipment_records
        WHERE id = ?
      `).get(first.record.id)).toEqual({ archiveId: legacyArchiveId });
      expect(checked.prepare(`
        SELECT COUNT(*) AS count FROM shipment_group_archives
      `).get()).toEqual({ count: 2 });
      expect(() => checked.prepare(`
        UPDATE shipment_records SET source_group_id = source_group_id WHERE id = ?
      `).run(first.record.id)).toThrow('shipment records are immutable');
    } finally {
      checked.close();
    }
  });

  it('把 v19 错标完成的部分发货档案升级并保留包裹、数量与外键', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-status-v19-migration-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const firstItem = expectedRemainingItems[0];
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V19-PARTIAL-ARCHIVE',
        items: [{ ...firstItem, quantity: 1 }],
      }],
    });
    for (const member of group.orders) {
      const current = application.getOrder(member.id).order;
      application.updateOrderStatusAndLogistics({
        targets: [{ orderId: member.id, expectedRevision: current.revision }],
        patch: { platformTransactionStatus: 'cancelled' },
      });
    }
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        CREATE TABLE shipment_group_archives_v19_fixture (
          id TEXT PRIMARY KEY,
          source_group_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
          recipient TEXT NOT NULL,
          phone TEXT NOT NULL,
          phone_normalized TEXT NOT NULL,
          address_original TEXT NOT NULL,
          address_normalized TEXT NOT NULL,
          member_order_ids_json TEXT NOT NULL,
          member_recipient_snapshots_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          CHECK (
            (status = 'open' AND completed_at IS NULL)
            OR (status = 'completed' AND completed_at IS NOT NULL)
          )
        ) STRICT;
        INSERT INTO shipment_group_archives_v19_fixture (
          id, source_group_id, status,
          recipient, phone, phone_normalized,
          address_original, address_normalized,
          member_order_ids_json, member_recipient_snapshots_json,
          created_at, completed_at, updated_at
        )
        SELECT
          id,
          source_group_id,
          'completed',
          recipient,
          phone,
          phone_normalized,
          address_original,
          address_normalized,
          member_order_ids_json,
          member_recipient_snapshots_json,
          created_at,
          updated_at,
          updated_at
        FROM shipment_group_archives;
        DROP TABLE shipment_group_archives;
        ALTER TABLE shipment_group_archives_v19_fixture RENAME TO shipment_group_archives;
        CREATE INDEX shipment_group_archives_by_source_group
        ON shipment_group_archives (source_group_id, status, created_at, id);
        DELETE FROM schema_migrations WHERE version IN (20, 21, 22, 23, 24, 25);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        id: confirmation.record.archiveId,
        status: 'partially_shipped',
        shippedQuantity: 1,
        remainingQuantity: 3,
        fullyShippedAt: null,
        remainingGroup: null,
        records: [expect.objectContaining({
          id: confirmation.record.id,
          packages: [expect.objectContaining({
            trackingNumber: 'SF-V19-PARTIAL-ARCHIVE',
          })],
        })],
      }),
    ]);
  });

  it('升级旧版同收货信息的多轮发货记录时保守拆成独立档案', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-archive-cycles-migration-'));
    const application = await createApplication(root);
    const firstGroup = application.queryShipmentGroups().groups[0];
    const firstItems = firstGroup.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const first = application.confirmShipment({
      groupId: firstGroup.id,
      expectedRemainingItems: firstItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V18-CYCLE-1',
        items: firstItems,
      }],
    });
    const laterSourcePath = join(tmpdir(), `shipment-record-migration-cycle-${randomUUID()}.png`);
    await writeFile(laterSourcePath, Buffer.from('shipment-record-migration-cycle'));
    const laterBatch = await application.submitRecognitionBatch([laterSourcePath]);
    application.confirmDraft(laterBatch.drafts[0]);
    const laterGroup = application.queryShipmentGroups().groups[0];
    const laterItems = laterGroup.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const later = application.confirmShipment({
      groupId: laterGroup.id,
      expectedRemainingItems: laterItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V18-CYCLE-2',
        items: laterItems,
      }],
    });
    expect(first.record.sourceGroupId).toBe(later.record.sourceGroupId);
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_require_archive_on_insert;
        ALTER TABLE shipment_records DROP COLUMN shipment_group_archive_id;
        DROP TABLE shipment_group_archives;
        DELETE FROM schema_migrations WHERE version IN (19, 20, 21, 22, 23, 24, 25);
        COMMIT;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        orderNumbers: ['XY-SHIPMENT-RECORD-0003'],
        records: [expect.objectContaining({ id: later.record.id })],
      }),
      expect.objectContaining({
        orderNumbers: [
          'XY-SHIPMENT-RECORD-0001',
          'XY-SHIPMENT-RECORD-0002',
        ],
        records: [expect.objectContaining({ id: first.record.id })],
      }),
    ]);
  });

  it('部分实际发出后只扣减对应数量并保留开放发货组', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const expectedRemainingItems = group.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));

    const result = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000005',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });

    expect(result.record.totalQuantity).toBe(1);
    expect(result.projection.groups).toEqual([]);
    expect(result.archive.remainingGroup).toMatchObject({
      totalQuantity: 3,
      orders: expect.arrayContaining([
        expect.objectContaining({
          id: firstOrder.id,
          items: [expect.objectContaining({ quantity: 1 })],
        }),
      ]),
    });
    expect(application.getOrder(firstOrder.id).order.fulfillmentStatus)
      .toBe('partially_shipped');

    const partialOrder = application.getOrder(firstOrder.id).order;
    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: partialOrder.id, expectedRevision: partialOrder.revision }],
      patch: { trackingNumber: 'ORDER-LEVEL-TRACKING' },
    });
    expect(application.getOrder(firstOrder.id).order).toMatchObject({
      trackingNumber: 'ORDER-LEVEL-TRACKING',
      fulfillmentStatus: 'partially_shipped',
    });
  });

  it('升级到履约投影版本时依据既有发货事实回算旧订单状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-fulfillment-projection-migration-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: group.orders.flatMap((order) => order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))),
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-MIGRATE-FULFILLMENT-PROJECTION',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      database.prepare(`
        UPDATE original_orders
        SET fulfillment_status = 'pending_shipment'
        WHERE id = ?
      `).run(firstOrder.id);
      database.prepare('DELETE FROM schema_migrations WHERE version = 25').run();
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.getOrder(firstOrder.id).order.fulfillmentStatus)
      .toBe('partially_shipped');
    expect(reopened.getOrder(firstOrder.id).changeEvents[0]).toMatchObject({
      source: 'shipment_sync',
      changes: [{
        path: 'fulfillmentStatus',
        before: 'pending_shipment',
        after: 'partially_shipped',
      }],
    });
  });

  it('任何包裹超量时整次确认失败且不留下半条发货记录', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));

    expect(() => application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-OVER-ALLOCATED',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: firstItem.quantity + 1,
        }],
      }],
    })).toThrow('实际发出数量不能超过当前剩余待发数量');
    expect(application.queryShipmentRecords()).toEqual([]);
    expect(application.queryShipmentGroups().groups[0].totalQuantity).toBe(4);
  });

  it('严格拒绝确认发货命令中的未知字段', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));

    expect(() => application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-STRICT-INPUT',
        items: expectedRemainingItems,
      }],
      unexpected: true,
    })).toThrow('确认发货参数包含未知字段：unexpected');
    expect(application.queryShipmentRecords()).toEqual([]);
  });

  it('一个包裹可混装多订单且同一商品可拆到多个包裹并跨重启保存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-records-persistence-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder, secondOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const [secondItem] = secondOrder.items;
    const expectedRemainingItems = group.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));

    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [
        {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF1000000006-A',
          items: [
            { orderId: firstOrder.id, orderItemId: firstItem.id, quantity: 1 },
            { orderId: secondOrder.id, orderItemId: secondItem.id, quantity: 2 },
          ],
        },
        {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF1000000006-B',
          items: [
            { orderId: firstOrder.id, orderItemId: firstItem.id, quantity: 1 },
          ],
        },
      ],
    });
    application.close();

    const reopened = await createApplication(root, false);
    const records = reopened.queryShipmentRecords();

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(confirmation.record);
    expect(records[0].packages[0].items.map(({ orderId }) => orderId))
      .toEqual([firstOrder.id, secondOrder.id]);
    expect(records[0].packages.flatMap(({ items }) => items)
      .filter(({ orderItemId }) => orderItemId === firstItem.id)
      .map(({ quantity }) => quantity)).toEqual([1, 1]);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        id: confirmation.record.archiveId,
        status: 'fully_shipped',
        shippedQuantity: 4,
        remainingQuantity: 0,
        records: [records[0]],
      }),
    ]);
    expect(reopened.queryShipmentGroups().groups).toEqual([]);
  });

  it('只撤销未交寄包裹并把对应商品数量退回开放发货组', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder, secondOrder] = group.orders;
    const expectedRemainingItems = group.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [
        {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF1000000003',
          items: expectedRemainingItems.filter(({ orderId }) => orderId === firstOrder.id),
        },
        {
          shippingCarrier: '中通快递',
          trackingNumber: 'ZT1000000001',
          items: expectedRemainingItems.filter(({ orderId }) => orderId === secondOrder.id),
        },
      ],
    });

    const result = application.cancelShipmentPackages({
      recordId: confirmation.record.id,
      packageIds: [confirmation.record.packages[0].id],
      reason: '第一个包裹尚未交寄而误点确认发货',
    });

    expect(result.record).toMatchObject({
      status: 'active',
      packages: [
        {
          status: 'cancelled',
          cancellation: {
            reason: '第一个包裹尚未交寄而误点确认发货',
          },
        },
        { status: 'active', cancellation: null },
      ],
    });
    expect(result.projection.groups).toEqual([]);
    expect(result.archive.remainingGroup).toMatchObject({
      totalQuantity: 2,
      orders: [{ id: firstOrder.id }],
    });
    expect(application.getOrder(firstOrder.id).order.fulfillmentStatus)
      .toBe('pending_shipment');
    expect(application.getOrder(secondOrder.id).order.fulfillmentStatus)
      .toBe('shipped');
  });

  it('撤销记录中的全部未交寄包裹后带原因作废记录但不删除历史', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const expectedRemainingItems = group.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000007',
        items: expectedRemainingItems,
      }],
    });

    const result = application.cancelShipmentPackages({
      recordId: confirmation.record.id,
      packageIds: [confirmation.record.packages[0].id],
      reason: '误操作且包裹尚未实际交寄',
    });

    expect(result.record).toMatchObject({
      id: confirmation.record.id,
      status: 'voided',
      voiding: { reason: '误操作且包裹尚未实际交寄' },
      packages: [{
        status: 'cancelled',
        cancellation: { reason: '误操作且包裹尚未实际交寄' },
      }],
    });
    expect(application.queryShipmentRecords()).toEqual([result.record]);
    expect(result.projection.groups).toEqual([]);
    expect(result.archive.remainingGroup?.totalQuantity).toBe(4);
    expect(application.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        id: confirmation.record.archiveId,
        status: 'partially_shipped',
        shippedQuantity: 0,
        remainingQuantity: 4,
        totalQuantity: 4,
        records: [expect.objectContaining({ status: 'voided' })],
      }),
    ]);
    expect(group.orders.map((order) => (
      application.getOrder(order.id).order.fulfillmentStatus
    ))).toEqual(['pending_shipment', 'pending_shipment']);
    expect(application.getOrder(group.orders[0].id).operations.shipmentRecords).toEqual([
      expect.objectContaining({
        id: confirmation.record.id,
        status: 'voided',
        packages: [expect.objectContaining({ status: 'cancelled' })],
      }),
    ]);
    expect(() => application.cancelShipmentPackages({
      recordId: confirmation.record.id,
      packageIds: [confirmation.record.packages[0].id],
      reason: '重复撤销',
    })).toThrow('发货记录已经作废');
  });

  it('原订单已取消时撤销包裹不把数量重新送回待发流程', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder] = group.orders;
    const expectedRemainingItems = firstOrder.items.map((item) => ({
      orderId: firstOrder.id,
      orderItemId: item.id,
      quantity: item.quantity,
    }));
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: group.orders.flatMap((order) => order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))),
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000008',
        items: expectedRemainingItems,
      }],
    });
    const shippedOrder = application.getOrder(firstOrder.id).order;
    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: firstOrder.id, expectedRevision: shippedOrder.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });

    const result = application.cancelShipmentPackages({
      recordId: confirmation.record.id,
      packageIds: [confirmation.record.packages[0].id],
      reason: '订单取消且包裹尚未实际交寄',
    });

    expect(result.projection.groups.flatMap(({ orders }) => orders)
      .some(({ id }) => id === firstOrder.id)).toBe(false);
    expect(application.getOrder(firstOrder.id).order).toMatchObject({
      platformTransactionStatus: 'cancelled',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it('更正包裹物流信息时保留修改前后值和原因', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-错误运单号',
        items: remainingItems,
      }],
    });
    const shipmentPackage = confirmation.record.packages[0];

    const result = application.correctShipmentPackageLogistics({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT1000000002',
      reason: '发货时录入了错误的运单信息',
    });

    expect(result.record.packages[0]).toMatchObject({
      status: 'active',
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT1000000002',
      revision: 2,
      timeline: [{
        kind: 'logistics_corrected',
        baseRevision: 1,
        resultRevision: 2,
        reason: '发货时录入了错误的运单信息',
        before: {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-错误运单号',
        },
        after: {
          shippingCarrier: '中通快递',
          trackingNumber: 'ZT1000000002',
        },
      }],
    });
    expect(application.queryShipmentRecords()).toEqual([result.record]);
  });

  it('更新包裹物流状态时保留不可变时间线并跨重启读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-logistics-status-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-LOGISTICS-STATUS-001',
        items: remainingItems,
      }],
    });
    const shipmentPackage = confirmation.record.packages[0];
    const sourceOrders = structuredClone(confirmation.record.sourceOrders);

    const corrected = application.correctShipmentPackageLogistics({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-LOGISTICS-STATUS-001',
      reason: '原运单号录入错误',
    });
    const result = application.updateShipmentPackageLogisticsStatus({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: corrected.record.packages[0].revision,
      logisticsStatus: 'delivered',
      reason: '买家确认包裹已经签收',
    });

    expect(result.record.packages[0]).toMatchObject({
      logisticsStatus: 'delivered',
      revision: 3,
      timeline: [
        {
          kind: 'logistics_corrected',
          baseRevision: 1,
          resultRevision: 2,
          reason: '原运单号录入错误',
        },
        {
          kind: 'status_changed',
          baseRevision: 2,
          resultRevision: 3,
          beforeStatus: 'in_transit',
          afterStatus: 'delivered',
          reason: '买家确认包裹已经签收',
        },
      ],
    });
    expect(result.record.sourceOrders).toEqual(sourceOrders);
    expect(group.orders.map((order) => application.getOrder(order.id).order.fulfillmentStatus))
      .toEqual(['delivered', 'delivered']);
    expect(group.orders.map((order) => application.getOrder(order.id).changeEvents[0])).toEqual([
      expect.objectContaining({
        source: 'shipment_sync',
        changes: [expect.objectContaining({
          path: 'fulfillmentStatus',
          before: 'shipped',
          after: 'delivered',
        })],
      }),
      expect.objectContaining({
        source: 'shipment_sync',
        changes: [expect.objectContaining({
          path: 'fulfillmentStatus',
          before: 'shipped',
          after: 'delivered',
        })],
      }),
    ]);
    application.close();

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentRecords()).toEqual([result.record]);
  });

  it('自动签收随物流更正回退但保留人工确认的终态', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-AUTO-DELIVERED-ROLLBACK',
        items: remainingItems,
      }],
    });
    const shipmentPackage = confirmation.record.packages[0];
    const delivered = application.updateShipmentPackageLogisticsStatus({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'delivered',
      reason: '承运商首次回传签收',
    });
    const automaticallyDeliveredOrder = application.getOrder(group.orders[0].id).order;
    application.updateOrderStatusAndLogistics({
      targets: [{
        orderId: automaticallyDeliveredOrder.id,
        expectedRevision: automaticallyDeliveredOrder.revision,
      }],
      patch: { fulfillmentStatus: 'delivered' },
    });
    application.updateShipmentPackageLogisticsStatus({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: delivered.record.packages[0].revision,
      logisticsStatus: 'in_transit',
      reason: '承运商更正误报签收',
    });

    expect(group.orders.map((order) => application.getOrder(order.id).order.fulfillmentStatus))
      .toEqual(['delivered', 'shipped']);

    expect(application.getOrder(automaticallyDeliveredOrder.id).order.fulfillmentStatus)
      .toBe('delivered');
    expect(application.getOrder(automaticallyDeliveredOrder.id).changeEvents[0]).toMatchObject({
      source: 'manual_edit',
      changes: [{
        path: 'fulfillmentStatusConfirmation',
        before: 'delivered',
        after: 'delivered',
      }],
    });
  });

  it('同一订单的全部有效包裹签收后才同步为已签收', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder, secondOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const [secondItem] = secondOrder.items;
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: [
        { orderId: firstOrder.id, orderItemId: firstItem.id, quantity: 2 },
        { orderId: secondOrder.id, orderItemId: secondItem.id, quantity: 2 },
      ],
      packages: [
        {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-MULTI-PACKAGE-1',
          items: [{ orderId: firstOrder.id, orderItemId: firstItem.id, quantity: 1 }],
        },
        {
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-MULTI-PACKAGE-2',
          items: [
            { orderId: firstOrder.id, orderItemId: firstItem.id, quantity: 1 },
            { orderId: secondOrder.id, orderItemId: secondItem.id, quantity: 2 },
          ],
        },
      ],
    });
    const [firstPackage, secondPackage] = confirmation.record.packages;
    application.updateShipmentPackageLogisticsStatus({
      recordId: confirmation.record.id,
      packageId: firstPackage.id,
      expectedRevision: firstPackage.revision,
      logisticsStatus: 'delivered',
      reason: '第一个包裹签收',
    });

    expect(application.getOrder(firstOrder.id).order.fulfillmentStatus).toBe('shipped');
    expect(application.getOrder(secondOrder.id).order.fulfillmentStatus).toBe('shipped');

    application.updateShipmentPackageLogisticsStatus({
      recordId: confirmation.record.id,
      packageId: secondPackage.id,
      expectedRevision: secondPackage.revision,
      logisticsStatus: 'delivered',
      reason: '第二个包裹签收',
    });

    expect(application.getOrder(firstOrder.id).order.fulfillmentStatus).toBe('delivered');
    expect(application.getOrder(secondOrder.id).order.fulfillmentStatus).toBe('delivered');
  });

  it('原订单后来改变时保留发货快照并列出差异', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => (
      order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))
    ));
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1000000004',
        items: remainingItems,
      }],
    });
    const sourceOrder = application.getOrder(group.orders[0].id).order;
    const edit = orderEditInput(sourceOrder);
    edit.recipient = '林青（新收件人）';
    edit.items[0].quantity = 3;
    application.confirmOrderEdit(edit);

    expect(application.getOrder(sourceOrder.id).order.fulfillmentStatus)
      .toBe('partially_shipped');
    expect(application.getOrder(sourceOrder.id).changeEvents[0]).toMatchObject({
      source: 'shipment_sync',
      changes: [{
        path: 'fulfillmentStatus',
        before: 'shipped',
        after: 'partially_shipped',
      }],
    });

    const record = application.queryShipmentRecords()[0];

    expect(record.sourceOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderId: sourceOrder.id,
        orderNumber: sourceOrder.orderNumber,
        recipient: '林青',
        amountCents: 2_000,
      }),
    ]));
    expect(record.packages[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderId: sourceOrder.id,
        sourceTitle: '亚麻收纳袋',
        quantity: 2,
        sourceItemQuantity: 2,
      }),
    ]));
    expect(record.sourceDifferences).toEqual(expect.arrayContaining([
      {
        orderId: sourceOrder.id,
        orderItemId: null,
        field: 'recipient',
        snapshotValue: '林青',
        currentValue: '林青（新收件人）',
      },
      {
        orderId: sourceOrder.id,
        orderItemId: sourceOrder.items[0].id,
        field: 'quantity',
        snapshotValue: 2,
        currentValue: 3,
      },
    ]));
    expect(confirmation.record.sourceDifferences).toEqual([]);
  });

  it('截图确认更新商品数量后按发货事实追加独立履约同步', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-source-update-fulfillment-sync-'));
    const sourceDirectory = join(root, '上传');
    await mkdir(sourceDirectory, { recursive: true });
    const initial = recognition('XY-SOURCE-UPDATE-SHIPMENT', [{
      sourceTitle: '分批商品',
      sourceSpec: '标准款',
      unitPriceCents: 1_000,
      quantity: 2,
      quantityInferred: false,
    }]);
    const changed: RecognitionResult = {
      ...initial,
      productTotalCents: 3_000,
      amountCents: 3_000,
      items: [{ ...initial.items[0], quantity: 3 }],
    };
    const application = new LocalApplication(new SequenceRecognizer([initial, changed]));
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const firstPath = join(sourceDirectory, '首次截图.png');
    await writeFile(firstPath, 'source-update-fulfillment-initial');
    const firstBatch = await application.submitRecognitionBatch([firstPath]);
    const order = application.confirmDraft(firstBatch.drafts[0]);
    const group = application.queryShipmentGroups().groups[0];
    application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: [{
        orderId: order.id,
        orderItemId: order.items[0].id,
        quantity: 2,
      }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-SOURCE-UPDATE-SHIPMENT',
        items: [{
          orderId: order.id,
          orderItemId: order.items[0].id,
          quantity: 2,
        }],
      }],
    });
    const shippedOrder = application.getOrder(order.id).order;
    const changedPath = join(sourceDirectory, '更新截图.png');
    await writeFile(changedPath, 'source-update-fulfillment-changed');
    const changedBatch = await application.submitRecognitionBatch([changedPath]);
    expect(() => application.confirmDraft(changedBatch.drafts[0])).toThrow(
      '该订单身份已存在，已转为订单更新',
    );

    const result = application.confirmOrderUpdate(
      application.getDraft(changedBatch.drafts[0].id),
      shippedOrder.revision,
    );

    expect(result.order.fulfillmentStatus).toBe('partially_shipped');
    expect(application.getOrder(order.id).changeEvents.slice(0, 2)).toEqual([
      expect.objectContaining({
        source: 'shipment_sync',
        changes: [{
          path: 'fulfillmentStatus',
          before: 'pending_shipment',
          after: 'partially_shipped',
        }],
      }),
      expect.objectContaining({ source: 'source_update' }),
    ]);
  });
});

describe('售后处理单', () => {
  it('原始订单按商品与数量聚合跨订单包裹、撤销包裹和售后待办', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder, secondOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const [secondItem] = secondOrder.items;
    const expectedRemainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-ORDER-PROJECTION-A',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }, {
          orderId: secondOrder.id,
          orderItemId: secondItem.id,
          quantity: 2,
        }],
      }, {
        shippingCarrier: '中通快递',
        trackingNumber: 'ZT-ORDER-PROJECTION-B',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstItem.id,
          quantity: 1,
        }],
      }],
    });
    const [activePackage, cancelledPackage] = shipment.record.packages;
    application.cancelShipmentPackages({
      recordId: shipment.record.id,
      packageIds: [cancelledPackage.id],
      reason: '第二个包裹尚未交寄，撤销后重新安排',
    });
    const createdCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      occurredAt: '2026-08-13T18:00:00+08:00',
      reason: '已发出的一件商品存在破损',
      items: [{
        shipmentPackageItemId: activePackage.items[0].id,
        quantity: 1,
      }, {
        shipmentPackageItemId: activePackage.items[1].id,
        quantity: 1,
      }],
    });

    const firstProjection = application.getOrder(firstOrder.id).operations;
    expect(firstProjection).toEqual({
      shipmentRecords: [{
        id: shipment.record.id,
        archiveId: shipment.record.archiveId,
        status: 'active',
        createdAt: shipment.record.createdAt,
        packages: [{
          id: activePackage.id,
          position: 0,
          status: 'active',
          logisticsStatus: 'in_transit',
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-ORDER-PROJECTION-A',
          cancellationReason: null,
          items: [{
            shipmentPackageItemId: activePackage.items[0].id,
            orderItemId: firstItem.id,
            sourceTitle: firstItem.sourceTitle,
            sourceSpec: firstItem.sourceSpec,
            quantity: 1,
          }],
        }, {
          id: cancelledPackage.id,
          position: 1,
          status: 'cancelled',
          logisticsStatus: 'in_transit',
          shippingCarrier: '中通快递',
          trackingNumber: 'ZT-ORDER-PROJECTION-B',
          cancellationReason: '第二个包裹尚未交寄,撤销后重新安排',
          items: [{
            shipmentPackageItemId: cancelledPackage.items[0].id,
            orderItemId: firstItem.id,
            sourceTitle: firstItem.sourceTitle,
            sourceSpec: firstItem.sourceSpec,
            quantity: 1,
          }],
        }],
      }],
      aftersalesCases: [{
        id: createdCase.id,
        shipmentRecordId: shipment.record.id,
        status: 'processing',
        reason: '已发出的一件商品存在破损',
        occurredAt: '2026-08-13T18:00:00+08:00',
        currentTodo: '处理售后问题',
        items: [{
          shipmentPackageItemId: activePackage.items[0].id,
          packageId: activePackage.id,
          orderItemId: firstItem.id,
          sourceTitle: firstItem.sourceTitle,
          sourceSpec: firstItem.sourceSpec,
          quantity: 1,
        }],
      }],
      currentTodo: '处理售后问题',
    });
    expect(application.getOrder(secondOrder.id).operations.shipmentRecords[0].packages).toEqual([
      expect.objectContaining({
        id: activePackage.id,
        items: [expect.objectContaining({ orderItemId: secondItem.id, quantity: 2 })],
      }),
    ]);
    expect(application.getOrder(secondOrder.id).operations.aftersalesCases).toEqual([
      expect.objectContaining({
        id: createdCase.id,
        items: [{
          shipmentPackageItemId: activePackage.items[1].id,
          packageId: activePackage.id,
          orderItemId: secondItem.id,
          sourceTitle: secondItem.sourceTitle,
          sourceSpec: secondItem.sourceSpec,
          quantity: 1,
        }],
      }),
    ]);
  });

  it('从发货记录选择部分商品数量建立可追溯的售后处理单', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const shipmentItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: shipmentItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-AFTERSALES-0001',
        items: shipmentItems,
      }],
    });
    const sourceItem = shipment.record.packages[0].items[0];

    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      occurredAt: '2026-08-13T10:00:00+08:00',
      reason: '其中一件商品存在破损',
      items: [{
        shipmentPackageItemId: sourceItem.id,
        quantity: 1,
      }],
    });

    expect(created).toMatchObject({
      shipmentRecordId: shipment.record.id,
      status: 'processing',
      revision: 1,
      reason: '其中一件商品存在破损',
      occurredAt: '2026-08-13T10:00:00+08:00',
      items: [{
        shipmentPackageItemId: sourceItem.id,
        orderId: sourceItem.orderId,
        orderItemId: sourceItem.orderItemId,
        orderNumber: sourceItem.orderNumber,
        sourceTitle: sourceItem.sourceTitle,
        sourceSpec: sourceItem.sourceSpec,
        quantity: 1,
        sourceShippedQuantity: 2,
      }],
      timeline: [{
        kind: 'created',
        resultRevision: 1,
        status: 'processing',
        reason: '其中一件商品存在破损',
        occurredAt: '2026-08-13T10:00:00+08:00',
      }],
    });
    expect(application.queryAftersalesCases()).toEqual([created]);
  });

  it('修改状态、原因和商品数量时追加不可变处理时间线且不改写物流', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const shipmentItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: shipmentItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-AFTERSALES-0002',
        items: shipmentItems,
      }],
    });
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      occurredAt: '2026-08-13T11:00:00+08:00',
      reason: '先登记一件商品破损',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });

    const updated = application.updateAftersalesCase({
      caseId: created.id,
      expectedRevision: created.revision,
      status: 'waiting_return',
      reason: '核对后两件商品均需退回',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
      changeReason: '与买家确认了实际受影响数量',
    });

    expect(updated).toMatchObject({
      id: created.id,
      status: 'waiting_return',
      revision: 2,
      reason: '核对后两件商品均需退回',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
      timeline: [
        expect.objectContaining({ kind: 'created', resultRevision: 1 }),
        {
          kind: 'updated',
          baseRevision: 1,
          resultRevision: 2,
          changeReason: '与买家确认了实际受影响数量',
          before: {
            status: 'processing',
            reason: '先登记一件商品破损',
            items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
          },
          after: {
            status: 'waiting_return',
            reason: '核对后两件商品均需退回',
            items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
          },
          createdAt: expect.any(String),
        },
      ],
    });
    expect(application.queryAftersalesCases({ status: 'waiting_return' })).toEqual([updated]);
    expect(application.queryShipmentRecords()[0].packages[0].logisticsStatus).toBe('in_transit');
  });

  it('阻止多个未完成售后静默占用超过已发数量并在完成后释放可处理数量', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const shipmentItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: shipmentItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-AFTERSALES-0003',
        items: shipmentItems,
      }],
    });
    const sourceItem = shipment.record.packages[0].items[0];
    const first = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      occurredAt: '2026-08-13T12:00:00+08:00',
      reason: '第一件商品售后处理中',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });

    expect(() => application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      occurredAt: '2026-08-13T12:10:00+08:00',
      reason: '错误登记超过剩余可处理数量',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
    })).toThrow('亚麻收纳袋最多还可登记 1 件售后');

    application.updateAftersalesCase({
      caseId: first.id,
      expectedRevision: first.revision,
      status: 'completed',
      reason: first.reason,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      changeReason: '本次问题已经处理完成',
    });
    expect(application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      occurredAt: '2026-08-13T12:20:00+08:00',
      reason: '完成后发生新的独立问题',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
    })).toMatchObject({ status: 'processing', items: [{ quantity: 2 }] });
  });

  it('重启后重新读取售后当前值与完整处理时间线', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-aftersales-persistence-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const shipmentItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: shipmentItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-AFTERSALES-PERSIST',
        items: shipmentItems,
      }],
    });
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      occurredAt: '2026-08-13T13:00:00+08:00',
      reason: '重启持久化测试',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const updated = application.updateAftersalesCase({
      caseId: created.id,
      expectedRevision: created.revision,
      status: 'waiting_inspection',
      reason: '退回商品已经收到，等待检查',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      changeReason: '确认收到买家退回的商品',
    });
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      expect(() => database.prepare(`
        UPDATE aftersales_case_events
        SET change_reason = '试图篡改历史'
        WHERE case_id = ? AND result_revision = 2
      `).run(created.id)).toThrow(/immutable/u);
      expect(() => database.prepare(`
        DELETE FROM aftersales_case_events
        WHERE case_id = ? AND result_revision = 1
      `).run(created.id)).toThrow(/immutable/u);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryAftersalesCases()).toEqual([updated]);
  });

  it('已有售后处理证据的包裹不能再按未交寄误操作撤销', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const shipmentItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: shipmentItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-AFTERSALES-EVIDENCE',
        items: shipmentItems,
      }],
    });
    application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      occurredAt: '2026-08-13T16:00:00+08:00',
      reason: '买家已提出商品售后',
      items: [{
        shipmentPackageItemId: shipment.record.packages[0].items[0].id,
        quantity: 1,
      }],
    });

    expect(() => application.cancelShipmentPackages({
      recordId: shipment.record.id,
      packageIds: [shipment.record.packages[0].id],
      reason: '误以为包裹尚未交寄',
    })).toThrow('包裹已经产生售后处理证据，不能按未交寄撤销');
  });

  it('已完成售后不能重新打开，后续独立问题必须新建处理单', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const shipmentItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: shipmentItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-AFTERSALES-CLOSED',
        items: shipmentItems,
      }],
    });
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      occurredAt: '2026-08-13T17:00:00+08:00',
      reason: '第一轮独立售后问题',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const completed = application.updateAftersalesCase({
      caseId: created.id,
      expectedRevision: created.revision,
      status: 'completed',
      reason: created.reason,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      changeReason: '问题已经处理完成',
    });

    expect(() => application.updateAftersalesCase({
      caseId: completed.id,
      expectedRevision: completed.revision,
      status: 'processing',
      reason: '试图重新打开历史问题',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      changeReason: '买家后来提出另一个问题',
    })).toThrow('已完成的售后处理单不能重新打开，请为新的独立问题另行建立处理单');
  });
});
