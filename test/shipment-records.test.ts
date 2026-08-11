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
        DELETE FROM schema_migrations WHERE version IN (19, 20);
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

  it('升级旧版部分发货记录时按该记录数量建立已全部发货档案', async () => {
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
        DELETE FROM schema_migrations WHERE version IN (19, 20);
        COMMIT;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentGroupArchives()).toEqual([
      expect.objectContaining({
        id: `legacy-shipment-group-archive-${confirmation.record.id}`,
        status: 'fully_shipped',
        shippedQuantity: 1,
        remainingQuantity: 0,
        totalQuantity: 1,
      }),
    ]);
    expect(reopened.queryShipmentGroups().groups).toEqual([
      expect.objectContaining({ totalQuantity: 3 }),
    ]);
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
        DELETE FROM schema_migrations WHERE version = 20;
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
        DELETE FROM schema_migrations WHERE version IN (19, 20);
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
      .toBe('pending_shipment');

    const partialOrder = application.getOrder(firstOrder.id).order;
    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: partialOrder.id, expectedRevision: partialOrder.revision }],
      patch: { trackingNumber: 'ORDER-LEVEL-TRACKING' },
    });
    expect(application.getOrder(firstOrder.id).order).toMatchObject({
      trackingNumber: 'ORDER-LEVEL-TRACKING',
      fulfillmentStatus: 'pending_shipment',
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
      fulfillmentStatus: 'shipped',
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
      logisticsChanges: [{
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
});
