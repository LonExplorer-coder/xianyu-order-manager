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
import { aftersalesCaseOperationsCoordination } from '../src/renderer/aftersales-presentation';
import {
  clearVersion58FundsData,
  removeVersion31ExtensionArtifacts,
  removeVersion32ExtensionArtifacts,
} from './version31-fixture';

const openedApplications: LocalApplication[] = [];

function confirmBuyerControl(
  application: LocalApplication,
  shipment: ReturnType<LocalApplication['confirmShipment']>,
): void {
  let current = shipment.record;
  for (const shipmentPackage of shipment.record.packages) {
    current = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'delivered',
      reason: '测试前置：买家已签收原正向包裹',
    }).record;
  }
  shipment.record = current;
}

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

  it('发货快照冻结来源原文且不被标准商品显示偏好改写', async () => {
    const application = await createApplication();
    const product = application.createStandardProduct({
      sku: 'SKU-SNAPSHOT-001',
      name: '亚麻收纳袋标准款',
      specification: '米白大号',
    });
    const summary = application.listOrders()
      .find(({ orderNumber }) => orderNumber === 'XY-SHIPMENT-RECORD-0001')!;
    const linked = application.updateOrderItemStandardization(
      summary.id,
      application.getOrder(summary.id).order.items[0].id,
      { standardProductId: product.id, expectedRevision: summary.revision! },
    );

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
        trackingNumber: 'SF1000000099',
        items: remainingItems,
      }],
    });

    expect(result.record.packages[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderNumber: 'XY-SHIPMENT-RECORD-0001',
        sourceTitle: '亚麻收纳袋',
        sourceSpec: '米白 大号',
      }),
    ]));

    application.updateOrderItemStandardization(
      summary.id,
      linked.order.items[0].id,
      {
        standardProductId: product.id,
        standardDisplayPreference: 'prefer_source',
        expectedRevision: application.getOrder(summary.id).order.revision,
      },
    );
    expect(application.queryShipmentRecords()).toEqual([result.record]);
    expect(application.queryShipmentRecords()[0].packages[0].items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          orderNumber: 'XY-SHIPMENT-RECORD-0001',
          sourceTitle: '亚麻收纳袋',
          sourceSpec: '米白 大号',
        }),
      ]));
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
    expect(() => application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: shippedOrder.id, expectedRevision: shippedOrder.revision }],
      patch: { fulfillmentStatus: 'pending_shipment' },
    })).toThrow('订单交易状态修改内容包含未知字段：fulfillmentStatus');
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
      application.updateOrderPlatformTransactionStatus({
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
    application.updateOrderPlatformTransactionStatus({
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

    expect(laterGroup.id).not.toBe(firstGroup.id);
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
      removeVersion31ExtensionArtifacts(database);
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_require_archive_on_insert;
        ALTER TABLE shipment_records DROP COLUMN shipment_group_archive_id;
        DROP TABLE shipment_group_archives;
        DELETE FROM schema_migrations WHERE version IN (19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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
      removeVersion31ExtensionArtifacts(database);
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_require_archive_on_insert;
        ALTER TABLE shipment_records DROP COLUMN shipment_group_archive_id;
        DROP TABLE shipment_group_archives;
        DELETE FROM schema_migrations WHERE version IN (19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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
      removeVersion31ExtensionArtifacts(database);
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_require_archive_on_insert;
        ALTER TABLE shipment_records DROP COLUMN shipment_group_archive_id;
        DROP TABLE shipment_group_archives;
        DELETE FROM schema_migrations WHERE version IN (19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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
      removeVersion31ExtensionArtifacts(database);
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
        DELETE FROM schema_migrations WHERE version IN (21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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
      removeVersion31ExtensionArtifacts(database);
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
        DELETE FROM schema_migrations WHERE version IN (22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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
      removeVersion31ExtensionArtifacts(database);
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
        DELETE FROM schema_migrations WHERE version IN (22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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
      removeVersion31ExtensionArtifacts(version20Database);
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
        DELETE FROM schema_migrations WHERE version IN (21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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

  it('旧版重叠档案证据损坏时整体回滚归并、记录和不可变触发器', { timeout: 120_000 }, async () => {
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
      removeVersion31ExtensionArtifacts(database);
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
        DELETE FROM schema_migrations WHERE version IN (21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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
      application.updateOrderPlatformTransactionStatus({
        targets: [{ orderId: member.id, expectedRevision: current.revision }],
        patch: { platformTransactionStatus: 'cancelled' },
      });
    }
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      removeVersion31ExtensionArtifacts(database);
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
        DELETE FROM schema_migrations WHERE version IN (20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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
    expect(first.record.sourceGroupId).not.toBe(later.record.sourceGroupId);
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      removeVersion31ExtensionArtifacts(database);
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER shipment_records_require_archive_on_insert;
        ALTER TABLE shipment_records DROP COLUMN shipment_group_archive_id;
        DROP TABLE shipment_group_archives;
        DELETE FROM schema_migrations WHERE version IN (19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
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
    expect(() => application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: partialOrder.id, expectedRevision: partialOrder.revision }],
      patch: { trackingNumber: 'ORDER-LEVEL-TRACKING' },
    })).toThrow('订单交易状态修改内容包含未知字段：trackingNumber');
    expect(application.getOrder(firstOrder.id).order).toMatchObject({
      trackingNumber: '',
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
      removeVersion31ExtensionArtifacts(database);
      database.prepare(`
        UPDATE original_orders
        SET fulfillment_status = 'pending_shipment'
        WHERE id = ?
      `).run(firstOrder.id);
      database.prepare('DELETE FROM schema_migrations WHERE version IN (25, 26, 27, 28, 29, 30, 31)').run();
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
    application.updateOrderPlatformTransactionStatus({
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
    expect(application.getOrder(group.orders[0].id).operations.history).toEqual(
      expect.arrayContaining([expect.objectContaining({
        kind: 'logistics',
        title: '更正物流信息',
        detail: expect.stringContaining(
          '顺丰速运 SF-错误运单号 → 中通快递 ZT1000000002',
        ),
      })]),
    );
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

  it('正向包裹保留最后可信正常运输事实并独立推进不可变物流异常时间线', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-SEPARATE-EXCEPTION-001',
        items: remainingItems,
      }],
    });
    const shipmentPackage = shipment.record.packages[0];
    const baseOccurredAt = Date.parse(shipment.record.createdAt) + 60_000;
    const occurredAt = (offsetMinutes: number) => (
      new Date(baseOccurredAt + offsetMinutes * 60_000).toISOString()
    );

    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: occurredAt(0),
      reason: '承运方已确认揽收',
    });
    const opened = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'pending_verification',
      impact: { scope: 'package' },
      occurredAt: occurredAt(60),
      reason: '运单长时间无新扫描，先待核实',
    });
    const exception = opened.record.packages[0].logisticsExceptions[0];

    expect(opened.record.packages[0]).toMatchObject({
      logisticsStatus: 'in_transit',
      currentException: {
        id: exception.id,
        direction: 'outbound',
        exceptionType: 'lost',
        stage: 'pending_verification',
        revision: 1,
        impact: { scope: 'package' },
      },
      logisticsExceptions: [{
        id: exception.id,
        stage: 'pending_verification',
        timeline: [{
          kind: 'opened',
          resultRevision: 1,
          stage: 'pending_verification',
          reason: '运单长时间无新扫描,先待核实',
          occurredAt: occurredAt(60),
        }],
      }],
    });

    const investigating = application.progressShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      expectedExceptionRevision: 1,
      stage: 'investigating',
      occurredAt: occurredAt(90),
      reason: '已向承运方发起查询',
    });
    const confirmed = application.progressShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      expectedExceptionRevision: 2,
      stage: 'confirmed',
      carrierConfirmedLoss: true,
      occurredAt: occurredAt(120),
      reason: '承运方确认遗失',
    });
    const recovered = application.progressShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      expectedExceptionRevision: 3,
      stage: 'recovered',
      occurredAt: occurredAt(180),
      reason: '承运方在转运中心找回包裹',
    });
    const resolved = application.progressShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      exceptionId: exception.id,
      expectedExceptionRevision: 4,
      stage: 'resolved',
      occurredAt: occurredAt(240),
      reason: '包裹已恢复正常派送',
    });

    expect(investigating.record.packages[0].logisticsStatus).toBe('in_transit');
    expect(confirmed.record.packages[0].logisticsStatus).toBe('in_transit');
    expect(recovered.record.packages[0].logisticsStatus).toBe('in_transit');
    expect(resolved.record.packages[0]).toMatchObject({
      logisticsStatus: 'in_transit',
      currentException: null,
      logisticsExceptions: [{
        id: exception.id,
        stage: 'resolved',
        revision: 5,
        timeline: [
          expect.objectContaining({ kind: 'opened', resultRevision: 1 }),
          expect.objectContaining({
            kind: 'stage_changed', baseRevision: 1, resultRevision: 2,
            beforeStage: 'pending_verification', afterStage: 'investigating',
          }),
          expect.objectContaining({
            kind: 'stage_changed', baseRevision: 2, resultRevision: 3,
            beforeStage: 'investigating', afterStage: 'confirmed',
          }),
          expect.objectContaining({
            kind: 'stage_changed', baseRevision: 3, resultRevision: 4,
            beforeStage: 'confirmed', afterStage: 'recovered',
          }),
          expect.objectContaining({
            kind: 'stage_changed', baseRevision: 4, resultRevision: 5,
            beforeStage: 'recovered', afterStage: 'resolved',
          }),
        ],
      }],
    });
    const resolvedItem = resolved.record.packages[0].items[0];
    application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-other',
      occurredAt: occurredAt(300),
      reason: '物流异常已结束后新建普通售后问题',
      items: [{ shipmentPackageItemId: resolvedItem.id, quantity: 1 }],
    });
    expect(application.getOrder(resolvedItem.orderId).operations.coordination.todos)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ title: '处理售后问题' }),
      ]));
  });

  it('正向丢件异常只能在承运揽收且没有可信收到证据时确认', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-LOSS-EVIDENCE-001',
        items: remainingItems,
      }],
    });
    const shipmentPackage = shipment.record.packages[0];
    const occurredAt = (offsetMinutes: number) => new Date(
      Date.parse(shipment.record.createdAt) + offsetMinutes * 60_000,
    ).toISOString();

    expect(() => application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      carrierConfirmedLoss: true,
      impact: { scope: 'package' },
      occurredAt: occurredAt(1),
      reason: '没有揽收证据就尝试确认丢件',
    })).toThrow('没有承运方揽收证据，不能确认丢件');

    const delivered = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'delivered',
      carrierAcceptanceConfirmed: true,
      occurredAt: occurredAt(2),
      reason: '承运方扫描签收',
    });
    expect(() => application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: delivered.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      carrierConfirmedLoss: true,
      impact: { scope: 'package' },
      occurredAt: occurredAt(3),
      reason: '已有签收证据后尝试确认丢件',
    })).toThrow('已有可信收到证据，不能确认丢件');
    expect(application.queryShipmentRecords()[0].packages[0]).toMatchObject({
      logisticsStatus: 'delivered',
      logisticsExceptions: [],
    });
  });

  it('从 v30 混合物流状态保守升级正常运输与异常事项并保持重启幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-v30-logistics-facts-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-V30-MIXED-EXCEPTION',
        items: remainingItems,
      }],
    });
    application.close();

    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      removeVersion32ExtensionArtifacts(legacy);
      legacy.exec('PRAGMA ignore_check_constraints = ON;');
      legacy.prepare(`
        UPDATE shipment_packages
        SET logistics_status = 'damaged', revision = 2
        WHERE id = ?
      `).run(shipment.record.packages[0].id);
      legacy.prepare(`
        INSERT INTO shipment_package_logistics_status_events (
          id, package_id, base_revision, result_revision,
          before_status, after_status, reason, occurred_at, payload_json, created_at
        ) VALUES (?, ?, 1, 2, 'in_transit', 'damaged', ?, ?, ?, ?)
      `).run(
        'legacy-v30-damaged-event',
        shipment.record.packages[0].id,
        '旧版混合状态记录了运输破损',
        '2026-08-14T15:00:00+08:00',
        JSON.stringify({ impact: { scope: 'items', items: [] } }),
        '2026-08-14T15:00:00.000Z',
      );
      legacy.exec(`
        PRAGMA ignore_check_constraints = OFF;
        DROP TRIGGER logistics_exception_identity_is_immutable_on_update;
        DROP TRIGGER logistics_exception_matters_are_immutable_on_delete;
        DROP TRIGGER logistics_exception_events_are_immutable_on_update;
        DROP TRIGGER logistics_exception_events_are_immutable_on_delete;
        DROP TABLE logistics_exception_events;
        DROP TABLE logistics_exception_matters;
        DROP TRIGGER legacy_shipment_mixed_events_are_immutable_on_update;
        DROP TRIGGER legacy_shipment_mixed_events_are_immutable_on_delete;
        DROP TRIGGER legacy_return_mixed_events_are_immutable_on_update;
        DROP TRIGGER legacy_return_mixed_events_are_immutable_on_delete;
        DROP TABLE legacy_shipment_package_mixed_logistics_events;
        DROP TABLE legacy_return_mixed_logistics_events;
        DELETE FROM schema_migrations WHERE version = 31;
      `);
    } finally {
      legacy.close();
    }

    await expect(createApplication(root, false))
      .rejects.toThrow('旧版正向物流异常影响范围无效');
    const rolledBack = new DatabaseSync(databasePath);
    try {
      expect(rolledBack.prepare(`
        SELECT logistics_status AS logisticsStatus
        FROM shipment_packages WHERE id = ?
      `).get(shipment.record.packages[0].id)).toEqual({ logisticsStatus: 'damaged' });
      expect(() => rolledBack.prepare(`
        SELECT COUNT(*) AS count FROM logistics_exception_matters
      `)).toThrow(/no such table/u);
      rolledBack.exec('DROP TRIGGER shipment_package_logistics_status_events_are_immutable_on_update;');
      rolledBack.prepare(`
        UPDATE shipment_package_logistics_status_events
        SET payload_json = ? WHERE id = 'legacy-v30-damaged-event'
      `).run(JSON.stringify({ impact: { scope: 'items', items: [{
        sourceItemId: shipment.record.packages[0].items[0].id,
        quantity: 1,
      }] } }));
      rolledBack.exec(`
        CREATE TRIGGER shipment_package_logistics_status_events_are_immutable_on_update
        BEFORE UPDATE ON shipment_package_logistics_status_events
        BEGIN
          SELECT RAISE(ABORT, 'shipment package logistics status events are immutable');
        END;
      `);
    } finally {
      rolledBack.close();
    }

    const migrated = await createApplication(root, false);
    const migratedPackage = migrated.queryShipmentRecords()[0].packages[0];
    expect(migratedPackage).toMatchObject({
      logisticsStatus: 'in_transit',
      currentException: {
        direction: 'outbound',
        exceptionType: 'damaged',
        stage: 'pending_verification',
        impact: { scope: 'items', items: [{
          sourceItemId: shipment.record.packages[0].items[0].id,
          quantity: 1,
        }] },
        reason: '旧版混合状态记录了运输破损',
      },
      logisticsExceptions: [expect.objectContaining({
        exceptionType: 'damaged',
        stage: 'pending_verification',
        timeline: [expect.objectContaining({ kind: 'opened', resultRevision: 1 })],
      })],
    });
    expect(migratedPackage.timeline).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ afterStatus: 'damaged' }),
    ]));
    const migratedOperations = migrated.getOrder(group.orders[0].id).operations;
    expect(migratedOperations.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'outbound_logistics', value: 'in_transit' }),
      expect.objectContaining({
        kind: 'logistics_exception',
        value: 'pending_verification',
        affectedQuantity: 1,
      }),
    ]));
    expect(migratedOperations.coordination.primaryTodo).toMatchObject({
      priority: 'physical_risk',
      title: '处理正向物流异常',
    });
    expect(migratedOperations.risks).toEqual([
      expect.objectContaining({ packageRole: 'original_outbound', affectedQuantity: 1 }),
    ]);
    const migratedSnapshot = structuredClone(migratedPackage);
    migrated.close();

    const reopened = await createApplication(root, false);
    expect(reopened.queryShipmentRecords()[0].packages[0]).toEqual(migratedSnapshot);
    expect(reopened.getOrder(group.orders[0].id).operations).toEqual(migratedOperations);
    const verified = new DatabaseSync(databasePath);
    try {
      expect(verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 58 });
      expect(verified.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => verified.prepare(`
        UPDATE logistics_exception_events SET reason = '尝试改写旧异常'
      `).run()).toThrow(/logistics exception events are immutable/u);
    } finally {
      verified.close();
    }
  });

  it('正向发货通过共同模块登记商品级异常、索赔和实际赔付', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-outbound-claim-impact-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder, secondOrder] = group.orders;
    const firstItem = firstOrder.items[0];
    const secondItem = secondOrder.items[0];
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: [
        { orderId: firstOrder.id, orderItemId: firstItem.id, quantity: firstItem.quantity },
        { orderId: secondOrder.id, orderItemId: secondItem.id, quantity: secondItem.quantity },
      ],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-OUTBOUND-EXCEPTION-001',
        items: [
          { orderId: firstOrder.id, orderItemId: firstItem.id, quantity: firstItem.quantity },
          { orderId: secondOrder.id, orderItemId: secondItem.id, quantity: secondItem.quantity },
        ],
      }],
    });
    const shipmentPackage = confirmation.record.packages[0];

    const exceptional = application.recordShipmentPackageLogisticsException({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      exceptionType: 'damaged',
      stage: 'confirmed',
      occurredAt: '2026-08-14T09:00:00+08:00',
      reason: '承运方反馈外包装损坏，仅影响第一笔订单的一件商品',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: shipmentPackage.items[0].id, quantity: 1 }],
      },
    });

    expect(exceptional.record.packages[0]).toMatchObject({
      logisticsStatus: 'in_transit',
      currentException: {
        direction: 'outbound',
        exceptionType: 'damaged',
        stage: 'confirmed',
        impact: {
          scope: 'items',
          items: [{ sourceItemId: shipmentPackage.items[0].id, quantity: 1 }],
        },
      },
      carrierClaim: null,
    });
    expect(application.getOrder(firstOrder.id).operations.shipmentRecords[0].packages[0])
      .toMatchObject({
        currentException: {
          direction: 'outbound',
          exceptionType: 'damaged',
          stage: 'confirmed',
          affectedQuantity: 1,
        },
      });
    expect(application.getOrder(secondOrder.id).operations.shipmentRecords[0].packages[0])
      .toMatchObject({ currentException: null });

    const opened = application.progressShipmentPackageCarrierClaim({
      kind: 'open',
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: exceptional.record.packages[0].revision,
      requestedAmountCents: 1_000,
      occurredAt: '2026-08-14T09:10:00+08:00',
      reason: '就受损商品向承运方索赔',
    });
    expect(opened.record.packages[0].carrierClaim).toMatchObject({
      status: 'pending',
      requestedAmountCents: 1_000,
    });
    expect(application.getOrder(firstOrder.id).operations.shipmentRecords[0].packages[0])
      .toMatchObject({
        carrierClaimStatus: 'pending',
        carrierClaimAffectedQuantity: 1,
        carrierClaimAffectedItems: [{
          sourceTitle: firstItem.sourceTitle,
          sourceSpec: firstItem.sourceSpec,
          quantity: 1,
        }],
      });
    expect(application.getOrder(firstOrder.id).operations.facts).toEqual(
      expect.arrayContaining([expect.objectContaining({
        kind: 'carrier_claim',
        affectedQuantity: 1,
      })]),
    );
    expect(application.getOrder(firstOrder.id).operations.coordination.primaryTodo)
      .toMatchObject({ title: '跟进承运索赔', detail: expect.stringContaining('影响 1 件商品') });
    expect(application.getOrder(firstOrder.id).operations.currentTodo)
      .toBe('跟进承运索赔');
    expect(application.getOrder(secondOrder.id).operations.shipmentRecords[0].packages[0])
      .toMatchObject({ currentException: null, carrierClaimStatus: null });
    expect(application.getOrder(secondOrder.id).operations.currentTodo)
      .not.toBe('跟进承运索赔');
    const approved = application.progressShipmentPackageCarrierClaim({
      kind: 'resolve',
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedClaimRevision: 1,
      outcome: 'approved',
      approvedAmountCents: 800,
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '承运方同意赔付八元',
    });
    const compensated = application.progressShipmentPackageCarrierClaim({
      kind: 'confirm_compensation',
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedClaimRevision: approved.record.packages[0].carrierClaim?.revision ?? 0,
      amountCents: 700,
      occurredAt: '2026-08-14T11:00:00+08:00',
      note: '实际到账七元',
    });

    expect(compensated.record.packages[0].carrierClaim).toMatchObject({
      status: 'paid',
      requestedAmountCents: 1_000,
      approvedAmountCents: 800,
      impact: {
        scope: 'items',
        items: [{ sourceItemId: shipmentPackage.items[0].id, quantity: 1 }],
      },
      actualCompensation: { amountCents: 700 },
      timeline: [
        expect.objectContaining({
          kind: 'opened',
          impact: {
            scope: 'items',
            items: [{ sourceItemId: shipmentPackage.items[0].id, quantity: 1 }],
          },
        }),
        expect.objectContaining({ kind: 'approved' }),
        expect.objectContaining({ kind: 'compensation_confirmed' }),
      ],
    });
    expect(application.getOrder(firstOrder.id).order.fulfillmentStatus).toBe('shipped');
    expect(application.queryAftersalesCases()).toEqual([]);
    const paidClaim = compensated.record.packages[0].carrierClaim;
    if (!paidClaim) throw new Error('测试前置条件：正向承运索赔未建立');
    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      expect(() => database.prepare(`
        UPDATE carrier_claims
        SET impact_json = '{"scope":"package"}'
        WHERE id = ?
      `).run(paidClaim.id)).toThrow(
        /carrier claim identity is immutable/u,
      );
    } finally {
      database.close();
    }
  });

  it('订单投影会在同包裹的多个未解决异常中选择实际影响当前订单的事项', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder, secondOrder] = group.orders;
    const firstItem = firstOrder.items[0];
    const secondItem = secondOrder.items[0];
    const confirmation = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: [
        { orderId: firstOrder.id, orderItemId: firstItem.id, quantity: firstItem.quantity },
        { orderId: secondOrder.id, orderItemId: secondItem.id, quantity: secondItem.quantity },
      ],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-MULTI-ORDER-EXCEPTIONS',
        items: [
          { orderId: firstOrder.id, orderItemId: firstItem.id, quantity: firstItem.quantity },
          { orderId: secondOrder.id, orderItemId: secondItem.id, quantity: secondItem.quantity },
        ],
      }],
    });
    const shipmentPackage = confirmation.record.packages[0];
    const firstException = application.recordShipmentPackageLogisticsException({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      exceptionType: 'damaged',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: shipmentPackage.items[0].id, quantity: 1 }],
      },
      occurredAt: '2026-08-14T09:00:00+08:00',
      reason: '第一笔订单的商品运输破损',
    });
    const firstExceptionId = firstException.record.packages[0].currentException?.id;
    if (!firstExceptionId) throw new Error('测试前置：第一个异常未登记');
    const secondException = application.recordShipmentPackageLogisticsException({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: firstException.record.packages[0].revision,
      exceptionType: 'misdelivered',
      stage: 'investigating',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: shipmentPackage.items[1].id, quantity: 1 }],
      },
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '第二笔订单的商品疑似错投',
    });
    const secondExceptionId = secondException.record.packages[0].currentException?.id;
    if (!secondExceptionId) throw new Error('测试前置：第二个异常未登记');

    expect(application.getOrder(firstOrder.id).operations.shipmentRecords[0].packages[0])
      .toMatchObject({
        logisticsStatus: 'in_transit',
        currentException: {
          exceptionType: 'damaged',
          stage: 'confirmed',
          affectedQuantity: 1,
        },
      });
    expect(application.getOrder(secondOrder.id).operations.shipmentRecords[0].packages[0])
      .toMatchObject({
        logisticsStatus: 'in_transit',
        currentException: {
          exceptionType: 'misdelivered',
          stage: 'investigating',
          affectedQuantity: 1,
        },
      });
    expect(firstExceptionId).not.toBe(secondExceptionId);
  });

  it('正向包裹已签收后不能回退到收件前状态或登记丢件', async () => {
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
    const occurredAt = (offsetMinutes: number) => new Date(
      Date.parse(confirmation.record.createdAt) + offsetMinutes * 60_000,
    ).toISOString();
    const delivered = application.updateShipmentPackageLogisticsStatus({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'delivered',
      occurredAt: occurredAt(1),
      reason: '承运商首次回传签收',
    });
    expect(() => application.updateShipmentPackageLogisticsStatus({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: delivered.record.packages[0].revision,
      logisticsStatus: 'in_transit',
      occurredAt: occurredAt(2),
      reason: '承运商更正误报签收',
    })).toThrow('已经收到的包裹不能回退到收件前状态');
    expect(() => application.recordShipmentPackageLogisticsException({
      recordId: confirmation.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: delivered.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: occurredAt(3),
      reason: '签收后不能改判丢件',
    })).toThrow('已有可信收到证据，不能确认丢件');
    expect(group.orders.map((order) => application.getOrder(order.id).order.fulfillmentStatus))
      .toEqual(['delivered', 'delivered']);
  });

  it('正向包裹签收扫描与买家未收到争议并列保留', async () => {
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
        trackingNumber: 'SF-DELIVERED-DISPUTE-001',
        items: shipmentItems,
      }],
    });
    const occurredAt = (offsetMinutes: number) => new Date(
      Date.parse(shipment.record.createdAt) + offsetMinutes * 60_000,
    ).toISOString();
    const delivered = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipment.record.packages[0].id,
      expectedRevision: shipment.record.packages[0].revision,
      logisticsStatus: 'delivered',
      carrierAcceptanceConfirmed: true,
      occurredAt: occurredAt(1),
      reason: '承运方回传签收扫描',
    });
    application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: delivered.record.packages[0].id,
      expectedRevision: delivered.record.packages[0].revision,
      exceptionType: 'delivery_dispute',
      stage: 'investigating',
      impact: { scope: 'package' },
      occurredAt: occurredAt(2),
      reason: '买家反馈未收到，核对签收凭证',
    });

    const currentPackage = application.queryShipmentRecords()[0].packages[0];
    expect(currentPackage).toMatchObject({
      logisticsStatus: 'delivered',
      currentException: {
        exceptionType: 'delivery_dispute',
        stage: 'investigating',
      },
    });
    const operations = application.getOrder(group.orders[0].id).operations;
    expect(operations.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'outbound_logistics', value: 'delivered' }),
      expect.objectContaining({
        kind: 'logistics_exception',
        value: 'investigating',
        affectedQuantity: group.orders[0].items.reduce(
          (total, item) => total + item.quantity,
          0,
        ),
      }),
    ]));
    expect(operations.coordination.primaryTodo).toMatchObject({
      priority: 'physical_risk',
      title: '处理正向物流异常',
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
    const updatedDetails = application.getOrder(order.id);
    expect(updatedDetails.sources[0].sourceSnapshot.confirmed?.fulfillmentStatus)
      .toBe('pending_shipment');
    expect(updatedDetails.changeEvents.slice(0, 2)).toEqual([
      expect.objectContaining({
        source: 'shipment_sync',
        changes: [{
          path: 'fulfillmentStatus',
          before: 'shipped',
          after: 'partially_shipped',
        }],
      }),
      expect.objectContaining({
        source: 'source_update',
        changes: expect.not.arrayContaining([
          expect.objectContaining({ path: 'fulfillmentStatus' }),
        ]),
      }),
    ]);
  });
});

describe('退货异常跨流程协调', () => {
  it('退货确认丢失后要求用户明确选择退款处理且实际退款仍独立确认', async () => {
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
        trackingNumber: 'SF-RETURN-LOSS-COORDINATION-SOURCE',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const baseOccurredAt = Date.parse(shipment.record.createdAt) + 60_000;
    const occurredAt = (offsetMinutes: number) => (
      new Date(baseOccurredAt + offsetMinutes * 60_000).toISOString()
    );
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: occurredAt(0),
      reason: '买家寄回一件商品后申请退款',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-RETURN-LOSS-COORDINATION',
      occurredAt: occurredAt(10),
      reason: '买家已经实际交寄退货',
    });
    const returnRecord = registered.returns[0];
    expect(() => application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipment.record.packages[0].id,
      expectedRevision: shipment.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: sourceItem.id, quantity: 1 }],
      },
      carrierConfirmedLoss: true,
      occurredAt: occurredAt(15),
      reason: '错误尝试把已由买家交寄退回的同一商品记为正向丢件',
    })).toThrow('买家已交寄同一商品，不能再把原正向包裹普通登记为丢件');
    const correctedSource = application.correctShipmentPackageLogistics({
      recordId: shipment.record.id,
      packageId: shipment.record.packages[0].id,
      expectedRevision: shipment.record.packages[0].revision,
      shippingCarrier: '顺丰速运',
      trackingNumber: 'SF-RETURN-LOSS-COORDINATION-SOURCE-CORRECTED',
      occurredAt: occurredAt(15),
      reason: '原正向运单号录入错误，依凭面单更正',
    });
    expect(correctedSource.record.packages[0]).toMatchObject({
      trackingNumber: 'SF-RETURN-LOSS-COORDINATION-SOURCE-CORRECTED',
    });
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnRecord.id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: occurredAt(20),
      reason: '已核对承运方揽收记录',
    });
    const lost = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: returnRecord.id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: returnRecord.items[0].id, quantity: 1 }],
      },
      carrierConfirmedLoss: true,
      occurredAt: occurredAt(30),
      reason: '承运方书面确认退货商品丢失',
    });

    expect(lost).toMatchObject({
      status: 'waiting_return',
      refund: { status: 'pending', refundRecords: [] },
      coordination: {
        currentTodo: '退货已确认丢失，请选择退款处理并继续承运异常处理',
        risk: '退货商品未回到卖家控制中，不能登记收到或检查',
        returnException: {
          exceptionId: lost.returns[0].currentException?.id,
          returnRecordId: returnRecord.id,
          exceptionType: 'lost',
          stage: 'confirmed',
          affectedQuantity: 1,
          decision: null,
          availableDecisions: [
            'wait_investigation',
            'refund_in_advance',
            'partial_refund',
            'reject_refund',
            'negotiate',
          ],
          timeline: [],
        },
      },
    });
    const lostTodoTitles = application.getOrder(sourceItem.orderId).operations.coordination.todos
      .map(({ title }) => title);
    expect(lostTodoTitles).toContain('选择退货异常退款处理');
    expect(lostTodoTitles).not.toContain('处理售后问题');
    expect(() => application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: lost.id,
      expectedRevision: lost.revision,
      returnRecordId: returnRecord.id,
      occurredAt: occurredAt(40),
      reason: '错误尝试确认收到已丢失退货',
    })).toThrow('退货已确认丢失，不能登记实际收到或检查');
    expect(() => application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: lost.id,
      expectedRevision: lost.revision,
      returnRecordId: returnRecord.id,
      occurredAt: occurredAt(41),
      reason: '不应用全部收到零件绕过整包丢失门禁',
      items: returnRecord.items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: 0,
      })),
      discrepancies: [],
    })).toThrow('退货已确认丢失，不能登记实际收到或检查');

    const waiting = application.progressAftersalesCase({
      kind: 'decide_return_logistics_exception',
      caseId: lost.id,
      expectedRevision: lost.revision,
      returnRecordId: returnRecord.id,
      exceptionId: lost.returns[0].currentException?.id,
      decision: 'wait_investigation',
      occurredAt: occurredAt(40),
      reason: '先等待承运方补充调查结论',
    });
    expect(waiting).toMatchObject({
      refund: { status: 'pending', refundRecords: [] },
      coordination: {
        currentTodo: '继续等待承运调查，实际退款尚未发生',
        returnException: {
          decision: 'wait_investigation',
          timeline: [expect.objectContaining({
            kind: 'selected',
            before: null,
            after: 'wait_investigation',
            reason: '先等待承运方补充调查结论',
          })],
        },
      },
    });

    const partial = application.progressAftersalesCase({
      kind: 'decide_return_logistics_exception',
      caseId: waiting.id,
      expectedRevision: waiting.revision,
      returnRecordId: returnRecord.id,
      exceptionId: lost.returns[0].currentException?.id,
      decision: 'partial_refund',
      occurredAt: occurredAt(50),
      reason: '与买家协商先退部分款项',
    });
    expect(partial).toMatchObject({
      refund: { status: 'pending', refundRecords: [] },
      coordination: {
        currentTodo: '核对并确认部分实际退款，承运异常继续独立处理',
        returnException: {
          decision: 'partial_refund',
          timeline: [
            expect.objectContaining({ after: 'wait_investigation' }),
            expect.objectContaining({
              kind: 'changed',
              before: 'wait_investigation',
              after: 'partial_refund',
            }),
          ],
        },
      },
    });

    const partialRefunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: partial.id,
      expectedRevision: partial.revision,
      actualRefundCents: 600,
      occurredAt: occurredAt(60),
      note: '平台确认实际退回六元',
    });
    expect(partialRefunded).toMatchObject({
      refund: {
        requestedAmountCents: 1_000,
        status: 'pending',
        refundRecords: [{ amountCents: 600 }],
        fulfillment: {
          kind: 'partial',
          refundedAmountCents: 600,
          remainingAmountCents: 400,
        },
      },
      coordination: {
        currentTodo: '核对并确认部分实际退款，承运异常继续独立处理',
        returnException: { decision: 'partial_refund' },
      },
    });
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: partialRefunded.id,
      expectedRevision: partialRefunded.revision,
      actualRefundCents: 400,
      occurredAt: occurredAt(65),
      note: '补退剩余四元',
    });
    expect(refunded).toMatchObject({
      status: 'ready_to_complete',
      refund: {
        requestedAmountCents: 1_000,
        status: 'confirmed',
        refundRecords: [{ amountCents: 600 }, { amountCents: 400 }],
        fulfillment: { kind: 'complete', refundedAmountCents: 1_000 },
      },
      coordination: {
        currentTodo: '部分实际退款已确认，继续处理退货物流异常',
        returnException: { decision: 'partial_refund' },
      },
    });
    const recovered = application.progressAftersalesCase({
      kind: 'progress_return_logistics_exception',
      caseId: refunded.id,
      expectedRevision: refunded.revision,
      returnRecordId: returnRecord.id,
      exceptionId: refunded.returns[0].currentException?.id as string,
      expectedExceptionRevision: refunded.returns[0].currentException?.revision as number,
      stage: 'recovered',
      occurredAt: occurredAt(70),
      reason: '承运方后续找回退货包裹',
    });
    expect(recovered.coordination).toMatchObject({
      returnException: null,
      returnExceptionHistory: [expect.objectContaining({
        exceptionId: lost.coordination.returnException?.exceptionId,
        stage: 'recovered',
        decision: 'partial_refund',
        timeline: [
          expect.objectContaining({ after: 'wait_investigation' }),
          expect.objectContaining({ after: 'partial_refund' }),
        ],
      })],
    });
  });

  it('退货运输中先确认实际退款后仍可独立记录丢件', async () => {
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
        trackingNumber: 'SF-REFUND-BEFORE-RETURN-LOSS',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-15T08:00:00+08:00',
      reason: '退货运输中先行退款',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-REFUND-BEFORE-RETURN-LOSS',
      occurredAt: '2026-08-15T08:10:00+08:00',
      reason: '买家已交寄',
    });
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-15T08:20:00+08:00',
      reason: '承运方确认揽收',
    });
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      actualRefundCents: 1_000,
      occurredAt: '2026-08-15T08:30:00+08:00',
      note: '平台已确认先行实际退款',
    });
    const lost = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: refunded.id,
      expectedRevision: refunded.revision,
      returnRecordId: refunded.returns[0].id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-15T08:40:00+08:00',
      reason: '退款后承运方确认退货丢失',
    });
    expect(lost).toMatchObject({
      status: 'ready_to_complete',
      refund: { status: 'confirmed', refundRecords: [{ amountCents: 1_000 }] },
      returns: [{ currentException: { exceptionType: 'lost', stage: 'confirmed' } }],
      coordination: {
        currentTodo: '退货已确认丢失，请选择退款处理并继续承运异常处理',
      },
    });
    const waiting = application.progressAftersalesCase({
      kind: 'decide_return_logistics_exception',
      caseId: lost.id,
      expectedRevision: lost.revision,
      returnRecordId: lost.returns[0].id,
      exceptionId: lost.coordination.returnException?.exceptionId,
      decision: 'wait_investigation',
      occurredAt: '2026-08-15T08:50:00+08:00',
      reason: '已退款，继续等待承运方调查',
    });
    expect(waiting).toMatchObject({
      refund: { status: 'confirmed', refundRecords: [{ amountCents: 1_000 }] },
      coordination: {
        currentTodo: '实际退款已确认，继续等待承运调查',
        returnException: { decision: 'wait_investigation' },
      },
    });
  });

  it('退货签收争议不代替卖家实际收到', async () => {
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
        trackingNumber: 'SF-RETURN-DISPUTE-SOURCE',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T23:00:00+08:00',
      reason: '买家寄回商品',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-RETURN-DELIVERY-DISPUTE',
      occurredAt: '2026-08-14T23:10:00+08:00',
      reason: '买家已交寄',
    });
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T23:20:00+08:00',
      reason: '承运方已揽收',
    });
    const scanned = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: registered.returns[0].id,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-14T23:30:00+08:00',
      reason: '承运轨迹显示签收',
    });
    expect(() => application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: scanned.id,
      expectedRevision: scanned.revision,
      returnRecordId: registered.returns[0].id,
      exceptionType: 'lost',
      stage: 'pending_verification',
      impact: { scope: 'package' },
      occurredAt: '2026-08-14T23:35:00+08:00',
      reason: '签收扫描后不能直接登记普通丢件',
    })).toThrow('已有可信收到证据，不能确认丢件');
    const disputed = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: scanned.id,
      expectedRevision: scanned.revision,
      returnRecordId: registered.returns[0].id,
      exceptionType: 'delivery_dispute',
      stage: 'confirmed',
      impact: { scope: 'package' },
      occurredAt: '2026-08-14T23:40:00+08:00',
      reason: '承运轨迹显示签收，但仓库未收到',
    });
    expect(disputed).toMatchObject({
      status: 'waiting_return',
      returns: [{ status: 'in_transit', logisticsStatus: 'delivered', receivedAt: null }],
      coordination: {
        currentTodo: '退货签收存在争议，请先核对实际收到并处理承运异常',
        risk: '签收扫描不等于卖家实际收到，不能直接进入检查',
      },
    });
    const waiting = application.progressAftersalesCase({
      kind: 'decide_return_logistics_exception',
      caseId: disputed.id,
      expectedRevision: disputed.revision,
      returnRecordId: registered.returns[0].id,
      exceptionId: disputed.coordination.returnException?.exceptionId,
      decision: 'wait_investigation',
      occurredAt: '2026-08-14T23:45:00+08:00',
      reason: '等待承运方核查签收人和签收地点',
    });
    expect(waiting.coordination).toMatchObject({
      currentTodo: '继续等待承运调查，实际退款尚未发生',
      risk: '签收扫描不等于卖家实际收到，不能直接进入检查',
      returnException: { decision: 'wait_investigation' },
    });
    expect(() => application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: waiting.id,
      expectedRevision: waiting.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-14T23:50:00+08:00',
      reason: '仅依据签收扫描尝试确认收到',
    })).toThrow('退货签收扫描存在争议，不能代替卖家登记实际收到');
  });
});

describe('退货物流与承运索赔', () => {
  it('更正退货物流后突出当前正确值并保留已经发生的收到事实与更正历史', async () => {
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
        trackingNumber: 'SF-RETURN-CORRECTION-SOURCE',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    expect(() => application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      occurredAt: '2026-08-13T20:59:00+08:00',
      reason: '即使买家已签收也不能默认退回',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    })).toThrow('请根据当前实物控制关系明确选择售后处理方向');
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-13T21:00:00+08:00',
      reason: '买家退回一件商品',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-WRONG-0001',
      occurredAt: '2026-08-13T21:10:00+08:00',
      reason: '首次登记退货物流',
    });
    const returnPackage = registered.returns[0];
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnPackage.id,
      occurredAt: '2026-08-13T21:20:00+08:00',
      reason: '仓库已经实际收到退货',
      items: returnPackage.items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.quantity,
      })),
      discrepancies: [],
    });

    const corrected = application.progressAftersalesCase({
      kind: 'correct_return_logistics',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: returnPackage.id,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-CORRECT-0001',
      occurredAt: '2026-08-13T21:25:00+08:00',
      reason: '首次登记时误填了承运方和运单号',
    });

    expect(() => application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: corrected.id,
      expectedRevision: corrected.revision,
      returnRecordId: returnPackage.id,
      result: 'resellable',
      occurredAt: '2026-08-13T21:23:00+08:00',
      note: '尝试把检查时间登记在物流更正之前',
    })).toThrow('退货检查时间不能早于上一条退货事件');

    expect(corrected).toMatchObject({
      status: 'waiting_inspection',
      returns: [{
        id: returnPackage.id,
        status: 'received',
        shippingCarrier: '中通快递',
        trackingNumber: 'ZT-CORRECT-0001',
        receivedAt: '2026-08-13T21:20:00+08:00',
        items: [{ quantity: 1, receivedQuantity: 1 }],
        timeline: [
          expect.objectContaining({ kind: 'registered' }),
          expect.objectContaining({ kind: 'received' }),
          expect.objectContaining({
            kind: 'logistics_corrected',
            before: {
              shippingCarrier: '圆通速递',
              trackingNumber: 'YT-WRONG-0001',
            },
            after: {
              shippingCarrier: '中通快递',
              trackingNumber: 'ZT-CORRECT-0001',
            },
            reason: '首次登记时误填了承运方和运单号',
          }),
        ],
      }],
    });
    const damaged = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: corrected.id,
      expectedRevision: corrected.revision,
      returnRecordId: returnPackage.id,
      exceptionType: 'damaged',
      stage: 'investigating',
      impact: { scope: 'items', items: [{ sourceItemId: returnPackage.items[0].id, quantity: 1 }] },
      occurredAt: '2026-08-13T21:30:00+08:00',
      reason: '实际收到后发现外包装破损，已提交承运方核查',
    });
    expect(damaged.returns[0].currentException).toMatchObject({
      exceptionType: 'damaged',
      stage: 'investigating',
      impact: { scope: 'items', items: [{
        sourceItemId: returnPackage.items[0].id,
        quantity: 1,
      }] },
    });
  });

  it('升级旧版退货签收争议及后续正常事实时重建可读时间线', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-return-delivery-dispute-migration-'));
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
        trackingNumber: 'SF-RETURN-DISPUTE-MIGRATION',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-13T20:00:00+08:00',
      reason: '买家退回一件商品',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: shipment.record.packages[0].items[0].id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-RETURN-DISPUTE-MIGRATION',
      occurredAt: '2026-08-13T20:10:00+08:00',
      reason: '买家已经寄出退货',
    });
    const returnRecord = registered.returns[0];
    const delivered = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnRecord.id,
      logisticsStatus: 'delivered',
      occurredAt: '2026-08-13T21:00:00+08:00',
      reason: '承运轨迹显示退货已签收',
    });
    const deliveredReturn = delivered.returns[0];
    application.close();

    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec('PRAGMA ignore_check_constraints = ON;');
      legacy.prepare(`
        UPDATE aftersales_return_records
        SET logistics_status = 'delivery_dispute', revision = revision + 1
        WHERE id = ?
      `).run(returnRecord.id);
      legacy.prepare(`
        INSERT INTO aftersales_return_record_events (
          id, return_record_id, kind, base_revision, result_revision,
          occurred_at, reason, inspection_result, payload_json, created_at
        ) VALUES (?, ?, 'logistics_status_updated', ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        'legacy-return-delivery-dispute-event',
        returnRecord.id,
        deliveredReturn.revision,
        deliveredReturn.revision + 1,
        '2026-08-13T21:10:00+08:00',
        '旧版将签收争议与运输状态混在一起',
        JSON.stringify({
          before: 'delivered',
          after: 'delivery_dispute',
          impact: { scope: 'package' },
        }),
        '2026-08-13T13:10:00.000Z',
      );
      legacy.prepare(`
        UPDATE aftersales_return_records
        SET logistics_status = 'misdelivered', revision = revision + 1
        WHERE id = ?
      `).run(returnRecord.id);
      legacy.prepare(`
        INSERT INTO aftersales_return_record_events (
          id, return_record_id, kind, base_revision, result_revision,
          occurred_at, reason, inspection_result, payload_json, created_at
        ) VALUES (?, ?, 'logistics_status_updated', ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        'legacy-return-misdelivered-event',
        returnRecord.id,
        deliveredReturn.revision + 1,
        deliveredReturn.revision + 2,
        '2026-08-13T21:15:00+08:00',
        '签收争议后又记录为疑似错投',
        JSON.stringify({
          before: 'delivery_dispute',
          after: 'misdelivered',
          impact: { scope: 'package' },
        }),
        '2026-08-13T13:15:00.000Z',
      );
      legacy.prepare(`
        UPDATE aftersales_return_records
        SET logistics_status = 'returned_to_buyer', revision = revision + 1
        WHERE id = ?
      `).run(returnRecord.id);
      legacy.prepare(`
        INSERT INTO aftersales_return_record_events (
          id, return_record_id, kind, base_revision, result_revision,
          occurred_at, reason, inspection_result, payload_json, created_at
        ) VALUES (?, ?, 'logistics_status_updated', ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        'legacy-return-returned-event',
        returnRecord.id,
        deliveredReturn.revision + 2,
        deliveredReturn.revision + 3,
        '2026-08-13T21:20:00+08:00',
        '承运方后续将退货包裹退回买家',
        JSON.stringify({
          before: 'delivery_dispute',
          after: 'returned_to_buyer',
        }),
        '2026-08-13T13:20:00.000Z',
      );
      legacy.exec('PRAGMA ignore_check_constraints = OFF;');
      removeVersion31ExtensionArtifacts(legacy);
      legacy.prepare('DELETE FROM schema_migrations WHERE version = 31').run();
    } finally {
      legacy.close();
    }

    const migrated = await createApplication(root, false);
    const migratedReturn = migrated.queryAftersalesCases({})
      .find(({ id }) => id === created.id)?.returns[0];
    expect(migratedReturn).toMatchObject({
      id: returnRecord.id,
      logisticsStatus: 'returned',
      currentException: null,
      logisticsExceptions: expect.arrayContaining([
        expect.objectContaining({
          direction: 'return',
          exceptionType: 'delivery_dispute',
          stage: 'resolved',
          impact: { scope: 'package' },
          reason: '承运方后续将退货包裹退回买家',
          timeline: [
            expect.objectContaining({
              kind: 'opened',
              reason: '旧版将签收争议与运输状态混在一起',
            }),
            expect.objectContaining({
              kind: 'stage_changed',
              afterStage: 'resolved',
              reason: '承运方后续将退货包裹退回买家',
            }),
          ],
        }),
        expect.objectContaining({
          exceptionType: 'misdelivered',
          stage: 'resolved',
          timeline: [
            expect.objectContaining({
              kind: 'opened',
              reason: '签收争议后又记录为疑似错投',
            }),
            expect.objectContaining({ kind: 'stage_changed', afterStage: 'resolved' }),
          ],
        }),
      ]),
      timeline: expect.arrayContaining([expect.objectContaining({
        kind: 'logistics_status_updated',
        before: 'delivered',
        after: 'returned',
        reason: '承运方后续将退货包裹退回买家',
      })]),
    });
  });

  it('相同退货运单默认阻止重复登记并允许用户明确确认合装退货', async () => {
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
        trackingNumber: 'SF-COMBINED-RETURN-SOURCE',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const [firstItem, secondItem] = shipment.record.packages[0].items;
    const firstCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-13T22:00:00+08:00',
      reason: '第一张订单退货',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: firstItem.id, quantity: 1 }],
    });
    const secondCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-13T22:01:00+08:00',
      reason: '第二张订单与第一张订单合装退货',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId: secondItem.id, quantity: 1 }],
    });
    const firstRegistered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: firstCase.id,
      expectedRevision: firstCase.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-COMBINED-0001',
      occurredAt: '2026-08-13T22:10:00+08:00',
      reason: '先登记第一张订单的退货',
    });

    expect(() => application.progressAftersalesCase({
      kind: 'register_return',
      caseId: secondCase.id,
      expectedRevision: secondCase.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-COMBINED-0001',
      occurredAt: '2026-08-13T22:11:00+08:00',
      reason: '未确认合装时尝试重复登记',
    })).toThrow('该退货运单已经登记，请确认是否属于合装退货');

    expect(() => application.progressAftersalesCase({
      kind: 'register_return',
      caseId: secondCase.id,
      expectedRevision: secondCase.revision,
      shippingCarrier: '另一家承运方',
      trackingNumber: 'zt-combined-0001',
      occurredAt: '2026-08-13T22:11:30+08:00',
      reason: '更换承运方名称和大小写后仍是同一运单',
    })).toThrow('该退货运单已经登记，请确认是否属于合装退货');

    const combined = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: secondCase.id,
      expectedRevision: secondCase.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-COMBINED-0001',
      occurredAt: '2026-08-13T22:12:00+08:00',
      reason: '确认两张订单由同一退货包裹寄回',
      combineWithExisting: true,
    });

    expect(combined.returns).toMatchObject([{
      id: firstRegistered.returns[0].id,
      items: [
        { shipmentPackageItemId: firstItem.id, quantity: 1, aftersalesCaseId: firstCase.id },
        { shipmentPackageItemId: secondItem.id, quantity: 1, aftersalesCaseId: secondCase.id },
      ],
      timeline: expect.arrayContaining([
        expect.objectContaining({
          kind: 'items_combined',
          reason: '确认两张订单由同一退货包裹寄回',
        }),
      ]),
    }]);
    const beforeReceipt = application.queryAftersalesCases({ shipmentRecordId: shipment.record.id });
    expect(beforeReceipt)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: firstCase.id,
          returns: [expect.objectContaining({
            id: firstRegistered.returns[0].id,
            items: expect.arrayContaining([
              expect.objectContaining({ shipmentPackageItemId: firstItem.id }),
              expect.objectContaining({ shipmentPackageItemId: secondItem.id }),
            ]),
          })],
        }),
        expect.objectContaining({
          id: secondCase.id,
          returns: [expect.objectContaining({
            id: firstRegistered.returns[0].id,
            items: expect.arrayContaining([
              expect.objectContaining({ shipmentPackageItemId: firstItem.id }),
              expect.objectContaining({ shipmentPackageItemId: secondItem.id }),
            ]),
          })],
        }),
      ]));

    const carrierAccepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: secondCase.id,
      expectedRevision: combined.revision,
      returnRecordId: combined.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-13T22:13:00+08:00',
      reason: '承运方确认接收合装退货包裹',
    });
    const firstReturnItemId = combined.returns[0].items.find((item) => (
      item.shipmentPackageItemId === firstItem.id
    ))?.id as string;
    const damaged = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: secondCase.id,
      expectedRevision: carrierAccepted.revision,
      returnRecordId: combined.returns[0].id,
      exceptionType: 'damaged',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: firstReturnItemId, quantity: 1 }],
      },
      occurredAt: '2026-08-13T22:14:00+08:00',
      reason: '合装运输中只有第一张订单的商品外包装破损',
    });
    expect(application.getOrder(firstItem.orderId).operations.aftersalesCases[0]
      .returnPackages[0].currentException).toMatchObject({
      direction: 'return',
      exceptionType: 'damaged',
      stage: 'confirmed',
      affectedQuantity: 1,
    });
    expect(application.getOrder(secondItem.orderId).operations.aftersalesCases[0]
      .returnPackages[0].currentException).toBeNull();
    const firstCaseAfterDamage = application.queryAftersalesCases({
      shipmentRecordId: shipment.record.id,
    }).find(({ id }) => id === firstCase.id) as NonNullable<ReturnType<
      LocalApplication['queryAftersalesCases']
    >[number]>;
    const lost = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: firstCase.id,
      expectedRevision: firstCaseAfterDamage.revision,
      returnRecordId: combined.returns[0].id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: firstReturnItemId, quantity: 1 }],
      },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-13T22:14:30+08:00',
      reason: '承运方确认只丢失第一张订单的退货商品',
    });
    expect(application.getOrder(firstItem.orderId).operations.aftersalesCases[0]
      .returnPackages[0].currentException).toMatchObject({
      exceptionType: 'lost',
      affectedQuantity: 1,
    });
    expect(application.getOrder(secondItem.orderId).operations.aftersalesCases[0]
      .returnPackages[0].currentException).toBeNull();
    const database = (application as unknown as {
      workspace: { database: DatabaseSync };
    }).workspace.database;
    expect(() => database.prepare(`
      INSERT INTO aftersales_return_exception_decision_events (
        id, case_id, exception_id, return_record_id, kind,
        before_decision, after_decision, occurred_at, reason, created_at
      ) VALUES (
        $id, $caseId, $exceptionId, $returnRecordId,
        'selected', NULL, 'wait_investigation', $occurredAt, $reason, $createdAt
      )
    `).run(
      {
        $id: String(randomUUID()),
        $caseId: secondCase.id,
        $exceptionId: lost.coordination.returnException?.exceptionId as string,
        $returnRecordId: combined.returns[0].id,
        $occurredAt: '2026-08-13T22:14:40+08:00',
        $reason: '不应把第一张订单的商品级异常关联给第二张订单',
        $createdAt: '2026-08-13T14:14:40.000Z',
      },
    )).toThrow(/return exception decision identity mismatch/u);
    const firstCaseBeforeClaim = application.queryAftersalesCases({
      shipmentRecordId: shipment.record.id,
    }).find(({ id }) => id === firstCase.id) as NonNullable<ReturnType<
      LocalApplication['queryAftersalesCases']
    >[number]>;
    const claimedReturn = application.progressAftersalesCase({
      kind: 'open_carrier_claim',
      caseId: firstCase.id,
      expectedRevision: firstCaseBeforeClaim.revision,
      returnRecordId: combined.returns[0].id,
      requestedAmountCents: 600,
      occurredAt: '2026-08-13T22:15:00+08:00',
      reason: '仅就第一张订单受损商品向承运方索赔',
    });
    expect(application.getOrder(firstItem.orderId).operations.aftersalesCases[0]
      .returnPackages[0].carrierClaimStatus).toBe('pending');
    expect(application.getOrder(secondItem.orderId).operations.aftersalesCases[0]
      .returnPackages[0].carrierClaimStatus).toBeNull();
    const casesAfterClaim = application.queryAftersalesCases({
      shipmentRecordId: shipment.record.id,
    });
    const firstCaseAfterClaim = casesAfterClaim.find(({ id }) => id === firstCase.id);
    const secondCaseAfterClaim = casesAfterClaim.find(({ id }) => id === secondCase.id);
    expect(firstCaseAfterClaim).toBeDefined();
    expect(secondCaseAfterClaim).toBeDefined();
    expect(aftersalesCaseOperationsCoordination(firstCaseAfterClaim as typeof claimedReturn).todos)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ title: '跟进承运索赔' }),
      ]));
    expect(aftersalesCaseOperationsCoordination(secondCaseAfterClaim as typeof claimedReturn).todos)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ title: '跟进承运索赔' }),
      ]));

    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: secondCase.id,
      expectedRevision: application.queryAftersalesCases({
        shipmentRecordId: shipment.record.id,
      }).find(({ id }) => id === secondCase.id)?.revision,
      returnRecordId: combined.returns[0].id,
      occurredAt: '2026-08-13T22:20:00+08:00',
      reason: '合装包裹整体到达并逐项清点',
      items: combined.returns[0].items.map((item) => ({
        returnRecordItemId: item.id,
        receivedQuantity: item.id === firstReturnItemId ? 0 : item.quantity,
      })),
      discrepancies: [{
        kind: 'missing',
        quantity: 1,
        note: '第一张订单的退货商品少一件',
        returnRecordItemId: firstReturnItemId,
      }],
    });
    expect(received.returns[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ aftersalesCaseId: firstCase.id, receivedQuantity: 0 }),
      expect.objectContaining({ aftersalesCaseId: secondCase.id, receivedQuantity: 1 }),
    ]));
    expect(application.queryAftersalesCases({ shipmentRecordId: shipment.record.id }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstCase.id, status: 'waiting_inspection' }),
        expect.objectContaining({ id: secondCase.id, status: 'waiting_inspection' }),
      ]));
    expect(application.getOrder(firstItem.orderId).operations.aftersalesCases[0].returnPackages[0]
      .discrepancies).toEqual([
      expect.objectContaining({
        kind: 'missing',
        note: '第一张订单的退货商品少一件',
      }),
    ]);
    expect(application.getOrder(secondItem.orderId).operations.aftersalesCases[0].returnPackages[0]
      .discrepancies).toEqual([]);
    expect(() => application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: firstCase.id,
      expectedRevision: application.queryAftersalesCases({
        shipmentRecordId: shipment.record.id,
      }).find(({ id }) => id === firstCase.id)?.revision,
      returnRecordId: combined.returns[0].id,
      exceptionType: 'lost',
      stage: 'pending_verification',
      impact: { scope: 'package' },
      occurredAt: '2026-08-13T22:25:00+08:00',
      reason: '已实际收到后不应再普通登记丢件',
    })).toThrow('退货已实际收到，少件、空包、错货或破损请通过退货检查差异记录');
  });

  it('退货包裹在正常运输事实之外独立保留物流异常事项', async () => {
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
        trackingNumber: 'SF-RETURN-SEPARATE-EXCEPTION',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T14:00:00+08:00',
      reason: '验证退货正常运输与异常分离',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-RETURN-SEPARATE-EXCEPTION',
      occurredAt: '2026-08-14T14:10:00+08:00',
      reason: '买家已交寄退货包裹',
    });
    const returnPackage = registered.returns[0];
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnPackage.id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T14:20:00+08:00',
      reason: '承运方已确认揽收退货',
    });
    const opened = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: returnPackage.id,
      exceptionType: 'damaged',
      stage: 'pending_verification',
      impact: { scope: 'items', items: [{ sourceItemId: returnPackage.items[0].id, quantity: 1 }] },
      occurredAt: '2026-08-14T14:30:00+08:00',
      reason: '运输中外包装受损，等待承运方核实',
    });

    expect(opened).toMatchObject({
      status: 'waiting_return',
      returns: [{
        logisticsStatus: 'in_transit',
        currentException: {
          direction: 'return',
          exceptionType: 'damaged',
          stage: 'pending_verification',
          impact: {
            scope: 'items',
            items: [{ sourceItemId: returnPackage.items[0].id, quantity: 1 }],
          },
        },
        logisticsExceptions: [expect.objectContaining({
          exceptionType: 'damaged',
          stage: 'pending_verification',
          timeline: [expect.objectContaining({ kind: 'opened', resultRevision: 1 })],
        })],
      }],
    });
  });

  it('分别保存计划退回、实际收到和检查通过数量并呈现退货检查差异', async () => {
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
        trackingNumber: 'SF-RETURN-QUANTITY-SOURCE',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-13T23:00:00+08:00',
      reason: '两件商品需要退回检查',
      requestedRefundCents: 2_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-RETURN-QUANTITY-0001',
      occurredAt: '2026-08-13T23:10:00+08:00',
      reason: '买家寄出两件商品',
    });
    const returnPackage = registered.returns[0];
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnPackage.id,
      occurredAt: '2026-08-13T23:20:00+08:00',
      reason: '实际只收到一件',
      items: [{
        returnRecordItemId: returnPackage.items[0].id,
        receivedQuantity: 1,
      }],
      discrepancies: [{ kind: 'missing', quantity: 1, note: '包裹内少一件商品' }],
    });
    expect(received.returns[0]).toMatchObject({
      items: [{ quantity: 2, receivedQuantity: 1, acceptedQuantity: 0 }],
      discrepancies: [{ kind: 'missing', quantity: 1, note: '包裹内少一件商品' }],
    });
    expect(() => application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: returnPackage.id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-13T23:25:00+08:00',
      reason: '已收到后不应再改为丢件',
    })).toThrow('退货已实际收到，少件、空包、错货或破损请通过退货检查差异记录');
    expect(() => application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: returnPackage.id,
      logisticsStatus: 'in_transit',
      occurredAt: '2026-08-13T23:25:00+08:00',
      reason: '已收到后不应回退到运输中',
    })).toThrow('已收到或检查的退货包裹不能回退到收件前的物流状态');

    expect(() => application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: returnPackage.id,
      result: 'defective',
      occurredAt: '2026-08-13T23:30:00+08:00',
      note: '试图让检查通过数量超过实际收到数量',
      items: [{
        returnRecordItemId: returnPackage.items[0].id,
        acceptedQuantity: 2,
        result: 'defective',
        note: '收到的一件也有破损',
      }],
      discrepancies: [{ kind: 'damaged', quantity: 1, note: '收到的一件有破损' }],
    })).toThrow('检查通过数量不能超过实际收到数量');

    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: returnPackage.id,
      result: 'defective',
      occurredAt: '2026-08-13T23:30:00+08:00',
      note: '完成数量与质量检查',
      items: [{
        returnRecordItemId: returnPackage.items[0].id,
        acceptedQuantity: 0,
        result: 'defective',
        note: '收到的一件有破损，未通过检查',
      }],
      discrepancies: [
        { kind: 'missing', quantity: 1, note: '包裹内少一件商品' },
        { kind: 'damaged', quantity: 1, note: '收到的一件有破损' },
      ],
    });

    expect(inspected.returns[0]).toMatchObject({
      status: 'inspected',
      items: [{
        quantity: 2,
        receivedQuantity: 1,
        acceptedQuantity: 0,
        inspectionResult: 'defective',
        inspectionNote: '收到的一件有破损,未通过检查',
      }],
      discrepancies: [
        { kind: 'missing', quantity: 1 },
        { kind: 'damaged', quantity: 1 },
      ],
      timeline: expect.arrayContaining([
        expect.objectContaining({
          kind: 'received',
          items: [{
            returnRecordItemId: returnPackage.items[0].id,
            receivedQuantity: 1,
          }],
          discrepancies: [{ kind: 'missing', quantity: 1, note: '包裹内少一件商品' }],
        }),
        expect.objectContaining({
          kind: 'inspected',
          items: [{
            returnRecordItemId: returnPackage.items[0].id,
            acceptedQuantity: 0,
            result: 'defective',
            note: '收到的一件有破损,未通过检查',
          }],
        }),
      ]),
    });
    expect(application.getOrder(sourceItem.orderId).operations.aftersalesCases[0].returnPackages)
      .toMatchObject([{
        shippingCarrier: '圆通速递',
        trackingNumber: 'YT-RETURN-QUANTITY-0001',
        logisticsStatus: 'delivered',
        discrepancies: [
          { kind: 'missing', quantity: 1 },
          { kind: 'damaged', quantity: 1 },
        ],
        items: [{ plannedQuantity: 2, receivedQuantity: 1, acceptedQuantity: 0 }],
      }]);
  });

  it('没有揽收证据时不能确认丢件且异常事项不改写售后状态', async () => {
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
        trackingNumber: 'SF-RETURN-LOST-SOURCE',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T08:00:00+08:00',
      reason: '买家准备寄回商品',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-RETURN-LOST-0001',
      occurredAt: '2026-08-14T08:10:00+08:00',
      reason: '买家提供退货运单',
    });
    const returnPackage = registered.returns[0];
    expect(returnPackage).toMatchObject({
      logisticsStatus: 'awaiting_carrier',
      carrierAcceptedAt: null,
    });

    expect(() => application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnPackage.id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T08:20:00+08:00',
      reason: '没有揽收记录就尝试登记丢件',
    })).toThrow('没有承运方揽收证据，不能确认丢件');
    expect(() => application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnPackage.id,
      logisticsStatus: 'awaiting_carrier',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T08:25:00+08:00',
      reason: '同时登记待接收和已揽收的矛盾事实',
    })).toThrow('已有承运方揽收证据，不能登记为待承运方接收');

    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnPackage.id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T08:30:00+08:00',
      reason: '承运方已有揽收记录',
    });
    expect(() => application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: returnPackage.id,
      logisticsStatus: 'awaiting_carrier',
      occurredAt: '2026-08-14T08:32:00+08:00',
      reason: '已揽收包裹不应回退到待承运方接收',
    })).toThrow('已有承运方揽收证据，不能登记为待承运方接收');
    expect(() => application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: returnPackage.id,
      occurredAt: '2026-08-14T08:25:00+08:00',
      reason: '尝试把收到时间登记在承运方揽收之前',
    })).toThrow('退货收到时间不能早于上一条退货事件');
    expect(() => application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: returnPackage.id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      occurredAt: '2026-08-14T09:00:00+08:00',
      reason: '尚未确认承运方认定遗失',
    })).toThrow('请确认承运方已经认定包裹遗失');

    const lost = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: returnPackage.id,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      carrierConfirmedLoss: true,
      occurredAt: '2026-08-14T09:10:00+08:00',
      reason: '承运方书面确认包裹遗失',
    });
    expect(lost).toMatchObject({
      status: 'waiting_return',
      returns: [{
        logisticsStatus: 'in_transit',
        carrierAcceptedAt: '2026-08-14T08:30:00+08:00',
        timeline: expect.arrayContaining([
          expect.objectContaining({
            kind: 'logistics_status_updated',
            before: 'awaiting_carrier',
            after: 'in_transit',
          }),
        ]),
        currentException: expect.objectContaining({
          exceptionType: 'lost',
          stage: 'confirmed',
        }),
      }],
    });
    const anotherSourceItem = shipment.record.packages[0].items[1];
    const combinedAfterLoss = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T09:11:00+08:00',
      reason: '另一件商品原本与丢失包裹合装',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId: anotherSourceItem.id, quantity: 1 }],
    });
    expect(() => application.progressAftersalesCase({
      kind: 'register_return',
      caseId: combinedAfterLoss.id,
      expectedRevision: combinedAfterLoss.revision,
      shippingCarrier: 'zhongtong',
      trackingNumber: 'ZT-RETURN-LOST-0001',
      occurredAt: '2026-08-14T09:12:00+08:00',
      reason: '丢件后才尝试追加合装商品',
      combineWithExisting: true,
    })).toThrow('已确认丢件的退货包裹不能再追加合装商品');
    const recovered = application.progressAftersalesCase({
      kind: 'progress_return_logistics_exception',
      caseId: lost.id,
      expectedRevision: lost.revision,
      returnRecordId: returnPackage.id,
      exceptionId: lost.returns[0].currentException?.id as string,
      expectedExceptionRevision: lost.returns[0].currentException?.revision as number,
      stage: 'recovered',
      occurredAt: '2026-08-14T09:20:00+08:00',
      reason: '退款前承运方找回包裹并送达',
    });
    expect(recovered.status).toBe('waiting_return');
  });

  it('买家退款结案与承运索赔分别推进并独立保存实际赔付事实', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-return-carrier-claim-'));
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
        trackingNumber: 'SF-CARRIER-CLAIM-SOURCE',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '退货途中发生丢件',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-CARRIER-CLAIM-0001',
      occurredAt: '2026-08-14T10:10:00+08:00',
      reason: '买家登记退货运单',
    });
    const returnPackage = registered.returns[0];
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnPackage.id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T10:20:00+08:00',
      reason: '承运方已经揽收',
    });
    const lost = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: returnPackage.id,
      exceptionType: 'lost',
      stage: 'confirmed',
      carrierConfirmedLoss: true,
      impact: {
        scope: 'items',
        items: [{ sourceItemId: returnPackage.items[0].id, quantity: 1 }],
      },
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '承运方确认包裹遗失',
    });
    const claimOpened = application.progressAftersalesCase({
      kind: 'open_carrier_claim',
      caseId: lost.id,
      expectedRevision: lost.revision,
      returnRecordId: returnPackage.id,
      requestedAmountCents: 1_000,
      occurredAt: '2026-08-14T11:10:00+08:00',
      reason: '依据丢件证明向承运方索赔',
    });
    expect(claimOpened.returns[0].carrierClaim).toMatchObject({
      status: 'pending',
      revision: 1,
      requestedAmountCents: 1_000,
      actualCompensation: null,
    });
    expect(application.getOrder(sourceItem.orderId).operations.aftersalesCases[0])
      .toMatchObject({
        id: created.id,
        returnPackages: [{
          id: returnPackage.id,
          shippingCarrier: '中通快递',
          trackingNumber: 'ZT-CARRIER-CLAIM-0001',
          logisticsStatus: 'in_transit',
          currentException: {
            direction: 'return',
            exceptionType: 'lost',
            stage: 'confirmed',
            affectedQuantity: 1,
            reason: '承运方确认包裹遗失',
          },
          carrierClaimStatus: 'pending',
          items: [{
            shipmentPackageItemId: sourceItem.id,
            plannedQuantity: 1,
            receivedQuantity: 0,
            acceptedQuantity: 0,
          }],
        }],
      });
    expect(application.getOrder(sourceItem.orderId).operations.currentTodo)
      .toBe('跟进承运索赔');
    expect(application.getOrder(sourceItem.orderId).operations.coordination.todos
      .map(({ title }) => title))
      .toContain('选择退货异常退款处理');

    const decided = application.progressAftersalesCase({
      kind: 'decide_return_logistics_exception',
      caseId: claimOpened.id,
      expectedRevision: claimOpened.revision,
      returnRecordId: returnPackage.id,
      exceptionId: claimOpened.coordination.returnException?.exceptionId,
      decision: 'refund_in_advance',
      occurredAt: '2026-08-14T11:15:00+08:00',
      reason: '承运索赔未结束，买家侧先行退款',
    });
    expect(application.getOrder(sourceItem.orderId).operations.currentTodo)
      .toBe('跟进承运索赔');

    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: decided.id,
      expectedRevision: decided.revision,
      actualRefundCents: 1_000,
      occurredAt: '2026-08-14T11:20:00+08:00',
      note: '承运索赔未结束，先按平台判责给买家退款',
    });
    const completed = application.progressAftersalesCase({
      kind: 'cancel',
      caseId: refunded.id,
      expectedRevision: refunded.revision,
      reason: '实际退款已完成，取消尚未发生的剩余步骤',
    });
    expect(completed).toMatchObject({
      status: 'cancelled',
      refund: { status: 'confirmed', refundRecords: [{ amountCents: 1_000 }] },
      returns: [{ carrierClaim: { status: 'pending' } }],
    });
    expect(application.getOrder(sourceItem.orderId).operations.currentTodo).toBe('跟进承运索赔');

    const approved = application.progressAftersalesCase({
      kind: 'resolve_carrier_claim',
      caseId: completed.id,
      expectedRevision: completed.revision,
      returnRecordId: returnPackage.id,
      expectedClaimRevision: 1,
      outcome: 'approved',
      approvedAmountCents: 800,
      occurredAt: '2026-08-15T10:00:00+08:00',
      reason: '承运方同意赔付八元',
    });
    expect(approved).toMatchObject({
      status: 'cancelled',
      revision: completed.revision,
      returns: [{ carrierClaim: { status: 'approved', revision: 2 } }],
    });
    expect(application.getOrder(sourceItem.orderId).operations.currentTodo).toBe('确认承运赔付');
    const compensated = application.progressAftersalesCase({
      kind: 'confirm_carrier_compensation',
      caseId: approved.id,
      expectedRevision: approved.revision,
      returnRecordId: returnPackage.id,
      expectedClaimRevision: 2,
      amountCents: 700,
      occurredAt: '2026-08-16T10:00:00+08:00',
      note: '实际收到承运方赔付七元',
    });
    expect(compensated).toMatchObject({
      status: 'cancelled',
      refund: { refundRecords: [{ amountCents: 1_000 }] },
      returns: [{
        carrierClaim: {
          status: 'paid',
          revision: 3,
          requestedAmountCents: 1_000,
          approvedAmountCents: 800,
          actualCompensation: { amountCents: 700 },
          timeline: [
            expect.objectContaining({ kind: 'opened' }),
            expect.objectContaining({ kind: 'approved' }),
            expect.objectContaining({ kind: 'compensation_confirmed' }),
          ],
        },
      }],
    });

    expect(() => application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: compensated.id,
      expectedRevision: compensated.revision,
      returnRecordId: returnPackage.id,
      occurredAt: '2026-08-17T09:50:00+08:00',
      reason: '未更新丢件结论就尝试登记收到',
    })).toThrow('退货已确认丢失，不能登记实际收到或检查');

    const recovered = application.progressAftersalesCase({
      kind: 'progress_return_logistics_exception',
      caseId: compensated.id,
      expectedRevision: compensated.revision,
      returnRecordId: returnPackage.id,
      exceptionId: compensated.returns[0].currentException?.id as string,
      expectedExceptionRevision: compensated.returns[0].currentException?.revision as number,
      stage: 'recovered',
      occurredAt: '2026-08-17T10:00:00+08:00',
      reason: '售后结案后承运方找回包裹并实际送达',
    });
    expect(recovered.status).toBe('cancelled');
    expect(application.getOrder(sourceItem.orderId).operations.currentTodo)
      .toBe('确认收到退货');
    const receivedAfterCompletion = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: recovered.id,
      expectedRevision: recovered.revision,
      returnRecordId: returnPackage.id,
      occurredAt: '2026-08-17T10:10:00+08:00',
      reason: '结案后仓库确认收到找回的退货包裹',
    });
    expect(receivedAfterCompletion.status).toBe('cancelled');
    expect(application.getOrder(sourceItem.orderId).operations.currentTodo).toBe('检查退回商品');
    const inspectedAfterCompletion = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: receivedAfterCompletion.id,
      expectedRevision: receivedAfterCompletion.revision,
      returnRecordId: returnPackage.id,
      result: 'other',
      occurredAt: '2026-08-17T10:20:00+08:00',
      note: '结案后补充记录找回商品的检查事实',
    });
    expect(inspectedAfterCompletion).toMatchObject({
      status: 'cancelled',
      refund: { refundRecords: [{ amountCents: 1_000 }] },
      returns: [{
        status: 'inspected',
        carrierClaim: { status: 'paid', actualCompensation: { amountCents: 700 } },
      }],
    });

    const rejectedSourceItem = shipment.record.packages[0].items[1];
    const rejectedCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T12:00:00+08:00',
      reason: '另一件退货发生运输异常',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId: rejectedSourceItem.id, quantity: 1 }],
    });
    const rejectedRegistered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: rejectedCase.id,
      expectedRevision: rejectedCase.revision,
      shippingCarrier: '申通快递',
      trackingNumber: 'ST-CARRIER-CLAIM-REJECTED',
      occurredAt: '2026-08-14T12:10:00+08:00',
      reason: '登记第二个异常退货包裹',
    });
    const rejectedAccepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: rejectedRegistered.id,
      expectedRevision: rejectedRegistered.revision,
      returnRecordId: rejectedRegistered.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T12:20:00+08:00',
      reason: '承运方已经揽收第二个包裹',
    });
    const exceptional = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: rejectedAccepted.id,
      expectedRevision: rejectedAccepted.revision,
      returnRecordId: rejectedAccepted.returns[0].id,
      exceptionType: 'other',
      stage: 'confirmed',
      impact: { scope: 'package' },
      occurredAt: '2026-08-14T13:00:00+08:00',
      reason: '物流长期停滞，人工登记异常',
    });
    const rejectedOpened = application.progressAftersalesCase({
      kind: 'open_carrier_claim',
      caseId: exceptional.id,
      expectedRevision: exceptional.revision,
      returnRecordId: exceptional.returns[0].id,
      requestedAmountCents: 500,
      occurredAt: '2026-08-14T13:10:00+08:00',
      reason: '就物流异常申请承运赔付',
    });
    const refundedBeforeClaimResult = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: rejectedOpened.id,
      expectedRevision: rejectedOpened.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-14T13:20:00+08:00',
      note: '承运索赔未出结果，先按平台判责给买家退款',
    });
    expect(refundedBeforeClaimResult).toMatchObject({
      status: 'ready_to_complete',
      refund: { status: 'confirmed', refundRecords: [{ amountCents: 500 }] },
      returns: [{ carrierClaim: { status: 'pending' } }],
    });
    const receivedAfterRefund = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: refundedBeforeClaimResult.id,
      expectedRevision: refundedBeforeClaimResult.revision,
      returnRecordId: refundedBeforeClaimResult.returns[0].id,
      occurredAt: '2026-08-14T13:30:00+08:00',
      reason: '买家退款后包裹实际到达',
    });
    expect(receivedAfterRefund).toMatchObject({
      status: 'ready_to_complete',
      refund: { status: 'confirmed', refundRecords: [{ amountCents: 500 }] },
      returns: [{ status: 'received' }],
    });
    const inspectedAfterRefund = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: receivedAfterRefund.id,
      expectedRevision: receivedAfterRefund.revision,
      returnRecordId: receivedAfterRefund.returns[0].id,
      result: 'resellable',
      occurredAt: '2026-08-14T13:40:00+08:00',
      note: '买家退款后继续完成实物检查',
    });
    expect(inspectedAfterRefund).toMatchObject({
      status: 'ready_to_complete',
      refund: { status: 'confirmed', refundRecords: [{ amountCents: 500 }] },
      returns: [{ status: 'inspected', carrierClaim: { status: 'pending' } }],
    });
    const rejected = application.progressAftersalesCase({
      kind: 'resolve_carrier_claim',
      caseId: inspectedAfterRefund.id,
      expectedRevision: inspectedAfterRefund.revision,
      returnRecordId: rejectedOpened.returns[0].id,
      expectedClaimRevision: 1,
      outcome: 'rejected',
      occurredAt: '2026-08-15T13:00:00+08:00',
      reason: '承运方举证后拒绝赔付，保留人工复核结论',
    });
    expect(rejected.returns[0].carrierClaim).toMatchObject({
      status: 'rejected',
      requestedAmountCents: 500,
      approvedAmountCents: null,
      reason: '承运方举证后拒绝赔付,保留人工复核结论',
      timeline: expect.arrayContaining([
        expect.objectContaining({ kind: 'rejected', approvedAmountCents: null }),
      ]),
    });

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      expect(() => database.prepare(`
        UPDATE carrier_compensation_records SET amount_cents = 1
      `).run()).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });

  it('从 v29 升级共同物流异常模块时保留退货索赔与事件时间线', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-return-claim-v30-migration-'));
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
        trackingNumber: 'SF-V29-RETURN-CLAIM',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T14:00:00+08:00',
      reason: '验证旧版退货索赔迁移',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-V29-RETURN-CLAIM',
      occurredAt: '2026-08-14T14:10:00+08:00',
      reason: '登记退货运单',
    });
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: '2026-08-14T14:20:00+08:00',
      reason: '承运方确认揽收',
    });
    const exceptional = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: accepted.returns[0].id,
      exceptionType: 'damaged',
      stage: 'confirmed',
      impact: { scope: 'package' },
      occurredAt: '2026-08-14T14:30:00+08:00',
      reason: '运输途中破损',
    });
    const claimed = application.progressAftersalesCase({
      kind: 'open_carrier_claim',
      caseId: exceptional.id,
      expectedRevision: exceptional.revision,
      returnRecordId: exceptional.returns[0].id,
      requestedAmountCents: 900,
      occurredAt: '2026-08-14T14:40:00+08:00',
      reason: '向承运方申请赔付',
    });
    const claimBefore = claimed.returns[0].carrierClaim;
    if (!claimBefore) throw new Error('测试前置条件：退货承运索赔未建立');
    const correctedShipment = application.correctShipmentPackageLogistics({
      recordId: shipment.record.id,
      packageId: shipment.record.packages[0].id,
      expectedRevision: shipment.record.packages[0].revision,
      shippingCarrier: '顺丰速运',
      trackingNumber: 'SF-V29-RETURN-CLAIM-CORRECTED',
      occurredAt: new Date(Date.parse(shipment.record.createdAt) + 60_000).toISOString(),
      reason: '模拟 v29 中已经存在的正向物流更正历史',
    });
    application.close();

    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      removeVersion31ExtensionArtifacts(database);
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER IF EXISTS carrier_claim_events_are_immutable_on_update;
        DROP TRIGGER IF EXISTS carrier_claim_events_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS carrier_compensation_records_are_immutable_on_update;
        DROP TRIGGER IF EXISTS carrier_compensation_records_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS shipment_package_logistics_changes_are_immutable_on_update;
        DROP TRIGGER IF EXISTS shipment_package_logistics_changes_are_immutable_on_delete;
        CREATE TABLE shipment_package_logistics_change_events_v29_fixture (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          package_id TEXT NOT NULL REFERENCES shipment_packages(id) ON DELETE RESTRICT,
          base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
          result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
          reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
          before_shipping_carrier TEXT NOT NULL,
          before_tracking_number TEXT NOT NULL,
          after_shipping_carrier TEXT NOT NULL,
          after_tracking_number TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (package_id, result_revision)
        ) STRICT;
        INSERT INTO shipment_package_logistics_change_events_v29_fixture (
          sequence, id, package_id, base_revision, result_revision, reason,
          before_shipping_carrier, before_tracking_number,
          after_shipping_carrier, after_tracking_number, created_at
        )
        SELECT
          sequence, id, package_id, base_revision, result_revision, reason,
          before_shipping_carrier, before_tracking_number,
          after_shipping_carrier, after_tracking_number, created_at
        FROM shipment_package_logistics_change_events;
        DROP TABLE shipment_package_logistics_change_events;
        ALTER TABLE shipment_package_logistics_change_events_v29_fixture
          RENAME TO shipment_package_logistics_change_events;
        CREATE TRIGGER shipment_package_logistics_changes_are_immutable_on_update
        BEFORE UPDATE ON shipment_package_logistics_change_events
        BEGIN
          SELECT RAISE(ABORT, 'shipment package logistics changes are immutable');
        END;
        CREATE TRIGGER shipment_package_logistics_changes_are_immutable_on_delete
        BEFORE DELETE ON shipment_package_logistics_change_events
        BEGIN
          SELECT RAISE(ABORT, 'shipment package logistics changes are immutable');
        END;
        CREATE TABLE carrier_claims_v29_fixture (
          id TEXT PRIMARY KEY,
          return_record_id TEXT NOT NULL UNIQUE
            REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
          approved_amount_cents INTEGER CHECK (approved_amount_cents > 0),
          reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO carrier_claims_v29_fixture (
          id, return_record_id, status, revision, requested_amount_cents,
          approved_amount_cents, reason, created_at, updated_at
        )
        SELECT
          id, return_record_id, status, revision, requested_amount_cents,
          approved_amount_cents, reason, created_at, updated_at
        FROM carrier_claims
        WHERE direction = 'return';
        DROP TABLE carrier_claims;
        ALTER TABLE carrier_claims_v29_fixture RENAME TO carrier_claims;
        DELETE FROM schema_migrations WHERE version IN (30, 31);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      database.close();
    }

    const reopened = await createApplication(root, false);
    const migrated = reopened.queryAftersalesCases({}).find(({ id }) => id === claimed.id);
    expect(migrated?.returns[0].carrierClaim).toEqual(claimBefore);
    expect(reopened.queryShipmentRecords().find(({ id }) => id === shipment.record.id))
      .toMatchObject({
      packages: [{
        trackingNumber: 'SF-V29-RETURN-CLAIM-CORRECTED',
        timeline: expect.arrayContaining([expect.objectContaining({
          kind: 'logistics_corrected',
          occurredAt: correctedShipment.record.packages[0].timeline.find((event) => (
            event.kind === 'logistics_corrected'
          ))?.createdAt,
        })]),
      }],
      });
    const migratedClaimRow = new DatabaseSync(
      join(root, '数据', 'xianyu-order-manager.sqlite3'),
    );
    try {
      expect(migratedClaimRow.prepare(`
        SELECT direction, shipment_package_id, return_record_id
        FROM carrier_claims
        WHERE id = ?
      `).get(claimBefore.id)).toEqual({
        direction: 'return',
        shipment_package_id: null,
        return_record_id: registered.returns[0].id,
      });
    } finally {
      migratedClaimRow.close();
    }
  });

  it('把真实 v28 退货、收到、检查和退款事实升级为退货包裹且保持幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-return-v28-migration-'));
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
        trackingNumber: 'SF-V28-MIGRATION-SOURCE',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-12T10:00:00+08:00',
      reason: '旧版退货退款事实',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-V28-RETURN-0001',
      occurredAt: '2026-08-12T10:10:00+08:00',
      reason: '旧版登记退货',
    });
    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      occurredAt: '2026-08-12T10:20:00+08:00',
      reason: '旧版实际收到退货',
    });
    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: received.returns[0].id,
      result: 'defective',
      occurredAt: '2026-08-12T10:30:00+08:00',
      note: '旧版检查确认瑕疵',
    });
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: inspected.id,
      expectedRevision: inspected.revision,
      actualRefundCents: 1_000,
      occurredAt: '2026-08-12T10:40:00+08:00',
      note: '旧版人工确认实际退款',
    });
    application.progressAftersalesCase({
      kind: 'complete',
      caseId: refunded.id,
      expectedRevision: refunded.revision,
      reason: '旧版售后结案',
    });
    application.close();

    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const database = new DatabaseSync(databasePath);
    try {
      clearVersion58FundsData(database);
      removeVersion31ExtensionArtifacts(database);
      database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TRIGGER IF EXISTS aftersales_return_record_item_identity_is_immutable;
        DROP TRIGGER IF EXISTS aftersales_return_record_items_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS aftersales_return_record_events_are_immutable_on_update;
        DROP TRIGGER IF EXISTS aftersales_return_record_events_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS carrier_claim_events_are_immutable_on_update;
        DROP TRIGGER IF EXISTS carrier_claim_events_are_immutable_on_delete;
        DROP TRIGGER IF EXISTS carrier_compensation_records_are_immutable_on_update;
        DROP TRIGGER IF EXISTS carrier_compensation_records_are_immutable_on_delete;
        DROP TABLE carrier_compensation_records;
        DROP TABLE carrier_claim_events;
        DROP TABLE carrier_claims;

        CREATE TABLE aftersales_return_record_items_v28_fixture (
          id TEXT PRIMARY KEY,
          return_record_id TEXT NOT NULL REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
          shipment_package_item_id TEXT NOT NULL REFERENCES shipment_package_items(id) ON DELETE RESTRICT,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          UNIQUE (return_record_id, shipment_package_item_id)
        ) STRICT;
        INSERT INTO aftersales_return_record_items_v28_fixture
          (id, return_record_id, shipment_package_item_id, quantity)
        SELECT id, return_record_id, shipment_package_item_id, quantity
        FROM aftersales_return_record_items;

        CREATE TABLE aftersales_return_record_events_v28_fixture (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          return_record_id TEXT NOT NULL REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
          kind TEXT NOT NULL CHECK (kind IN ('registered', 'received', 'inspected')),
          base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
          result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
          occurred_at TEXT NOT NULL,
          reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
          inspection_result TEXT CHECK (
            inspection_result IS NULL OR inspection_result IN ('resellable', 'defective', 'scrapped', 'other')
          ),
          created_at TEXT NOT NULL,
          UNIQUE (return_record_id, result_revision)
        ) STRICT;
        INSERT INTO aftersales_return_record_events_v28_fixture
          (sequence, id, return_record_id, kind, base_revision, result_revision,
           occurred_at, reason, inspection_result, created_at)
        SELECT sequence, id, return_record_id, kind, base_revision, result_revision,
               occurred_at, reason, inspection_result, created_at
        FROM aftersales_return_record_events;

        CREATE TABLE aftersales_return_records_v28_fixture (
          id TEXT PRIMARY KEY,
          aftersales_case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
          status TEXT NOT NULL CHECK (status IN ('in_transit', 'received', 'inspected')),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          shipping_carrier TEXT NOT NULL CHECK (length(trim(shipping_carrier)) BETWEEN 1 AND 100),
          tracking_number TEXT NOT NULL CHECK (length(trim(tracking_number)) BETWEEN 1 AND 200),
          occurred_at TEXT NOT NULL,
          received_at TEXT,
          inspection_result TEXT CHECK (
            inspection_result IS NULL OR inspection_result IN ('resellable', 'defective', 'scrapped', 'other')
          ),
          inspection_note TEXT,
          inspected_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO aftersales_return_records_v28_fixture
          (id, aftersales_case_id, status, revision, shipping_carrier, tracking_number,
           occurred_at, received_at, inspection_result, inspection_note, inspected_at,
           created_at, updated_at)
        SELECT id, aftersales_case_id, status, revision, shipping_carrier, tracking_number,
               occurred_at, received_at, inspection_result, inspection_note, inspected_at,
               created_at, updated_at
        FROM aftersales_return_records;

        DROP TABLE aftersales_return_record_items;
        DROP TABLE aftersales_return_record_events;
        DROP TABLE aftersales_return_records;
        ALTER TABLE aftersales_return_records_v28_fixture RENAME TO aftersales_return_records;
        ALTER TABLE aftersales_return_record_items_v28_fixture RENAME TO aftersales_return_record_items;
        ALTER TABLE aftersales_return_record_events_v28_fixture RENAME TO aftersales_return_record_events;
        DELETE FROM schema_migrations WHERE version >= 29;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      database.close();
    }

    const migrated = await createApplication(root, false);
    const restored = migrated.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    expect(restored).toMatchObject({
      status: 'completed',
      coordination: {
        handlingDirection: 'buyer_return',
        physicalControl: 'buyer',
        handlingDirectionTimeline: [expect.objectContaining({
          kind: 'selected',
          after: 'buyer_return',
        })],
      },
      refund: {
        status: 'confirmed',
        refundRecords: [{ amountCents: 1_000, note: '旧版人工确认实际退款' }],
        fulfillment: { kind: 'complete', refundedAmountCents: 1_000 },
      },
      returns: [{
        status: 'inspected',
        logisticsStatus: 'delivered',
        carrierAcceptedAt: '2026-08-12T10:20:00+08:00',
        discrepancies: [],
        carrierClaim: null,
        items: [{
          quantity: 1,
          receivedQuantity: 1,
          acceptedQuantity: 1,
          inspectionResult: 'defective',
          inspectionNote: '旧版检查确认瑕疵',
        }],
      }],
    });
    migrated.close();
    const reopened = await createApplication(root, false);
    expect(reopened.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0])
      .toEqual(restored);
  });
});

describe('售后处理单', () => {
  it('将真实 v31 旧售后保守升级为处理方向且阻止非法半结构', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-v31-aftersales-direction-'));
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
        trackingNumber: 'SF-V31-AFTERSALES-DIRECTION',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const [firstItem, secondItem] = shipment.record.packages[0].items;
    const general = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-other',
      occurredAt: '2026-08-14T08:00:00+08:00',
      reason: '旧版一般售后',
      items: [{ shipmentPackageItemId: firstItem.id, quantity: 1 }],
    });
    application.updateAftersalesCase({
      caseId: general.id,
      expectedRevision: general.revision,
      status: 'completed',
      reason: general.reason,
      items: [{ shipmentPackageItemId: firstItem.id, quantity: 1 }],
      changeReason: '测试前置：一般售后已完成并释放数量',
    });
    const refundOnly = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-refund-only',
      occurredAt: '2026-08-14T08:10:00+08:00',
      reason: '旧版仅退款',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId: secondItem.id, quantity: 1 }],
    });
    const ambiguousReturn = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T08:20:00+08:00',
      reason: '旧版只有等待退回状态，没有退货实物',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId: firstItem.id, quantity: 1 }],
    });
    const concreteReturn = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-14T08:30:00+08:00',
      reason: '旧版已有买家退货实物',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId: secondItem.id, quantity: 1 }],
    });
    const registeredReturn = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: concreteReturn.id,
      expectedRevision: concreteReturn.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-V31-RETURN-EVIDENCE',
      occurredAt: '2026-08-14T08:40:00+08:00',
      reason: '旧版已登记买家退货运单',
    });
    application.close();

    const databasePath = join(root, '数据', 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      removeVersion32ExtensionArtifacts(legacy);
      legacy.exec(`
        CREATE TABLE aftersales_interception_events (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL
        ) STRICT;
      `);
    } finally {
      legacy.close();
    }
    await expect(createApplication(root, false))
      .rejects.toThrow('检测到不完整的 v32 在途售后协调结构');
    const repair = new DatabaseSync(databasePath);
    try {
      expect(repair.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 31 });
      expect((repair.prepare('PRAGMA table_info(aftersales_cases)').all() as Array<{
        name: string;
      }>).map(({ name }) => name)).not.toContain('handling_direction');
      repair.exec('DROP TABLE aftersales_interception_events;');
    } finally {
      repair.close();
    }

    const migrated = await createApplication(root, false);
    const cases = new Map(migrated.queryAftersalesCases({ shipmentRecordId: shipment.record.id })
      .map((aftersalesCase) => [aftersalesCase.id, aftersalesCase]));
    expect(cases.get(general.id)?.coordination).toMatchObject({
      handlingDirection: null,
      handlingDirectionTimeline: [],
    });
    expect(cases.get(refundOnly.id)).toMatchObject({
      status: 'waiting_refund',
      coordination: { handlingDirection: null, handlingDirectionTimeline: [] },
    });
    expect(cases.get(ambiguousReturn.id)).toMatchObject({
      status: 'processing',
      coordination: {
        handlingDirection: 'waiting',
        handlingDirectionTimeline: [expect.objectContaining({
          kind: 'selected',
          after: 'waiting',
        })],
      },
    });
    expect(cases.get(registeredReturn.id)).toMatchObject({
      status: 'waiting_return',
      coordination: {
        handlingDirection: 'buyer_return',
        handlingDirectionTimeline: [expect.objectContaining({
          kind: 'selected',
          after: 'buyer_return',
        })],
      },
    });
    migrated.close();
    const reopened = await createApplication(root, false);
    expect(reopened.queryAftersalesCases({ shipmentRecordId: shipment.record.id }))
      .toEqual([...cases.values()]);
  });

  it('运输中退货退款明确选择申请拦截且不伪造退货实物', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-in-transit-aftersales-'));
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
        trackingNumber: 'SF-IN-TRANSIT-AFTERSALES-0001',
        items: shipmentItems,
      }],
    });
    const sourcePackage = shipment.record.packages[0];
    const sourceItem = sourcePackage.items[0];
    const input = {
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '买家收货地址有误，希望截回商品',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    };

    expect(() => application.createAftersalesCase(input))
      .toThrow('请根据当前实物控制关系明确选择售后处理方向');

    const created = application.createAftersalesCase({
      ...input,
      handlingDirection: 'intercept',
    });

    expect(created).toMatchObject({
      workflow: 'return_refund',
      status: 'processing',
      returns: [],
      coordination: {
        handlingDirection: 'intercept',
        physicalControl: 'carrier',
        currentTodo: '拦截请求待确认，继续跟踪原正向包裹',
        risk: '拦截结果未确认，不应假定原正向包裹已收回',
        availableDirections: ['waiting', 'intercept', 'refuse', 'only_refund', 'replacement'],
        sourcePackages: [{
          packageId: sourcePackage.id,
          shippingCarrier: '顺丰速运',
          trackingNumber: 'SF-IN-TRANSIT-AFTERSALES-0001',
          logisticsStatus: 'in_transit',
          confirmedLost: false,
          items: [{
            shipmentPackageItemId: sourceItem.id,
            sourceTitle: sourceItem.sourceTitle,
            sourceSpec: sourceItem.sourceSpec,
            quantity: 1,
          }],
        }],
        interception: {
          status: 'requested',
          timeline: [{
            kind: 'requested',
            occurredAt: '2026-08-14T10:00:00+08:00',
            reason: '买家收货地址有误,希望截回商品',
          }],
        },
      },
    });
    expect(application.queryShipmentRecords()[0].packages[0]).toMatchObject({
      id: sourcePackage.id,
      logisticsStatus: 'in_transit',
      trackingNumber: 'SF-IN-TRANSIT-AFTERSALES-0001',
    });

    const succeeded = application.progressAftersalesCase({
      kind: 'record_interception_result',
      caseId: created.id,
      expectedRevision: created.revision,
      result: 'succeeded',
      occurredAt: '2026-08-14T10:10:00+08:00',
      reason: '承运方已确认拦截成功',
    });
    expect(succeeded).toMatchObject({
      status: 'processing',
      returns: [],
      coordination: {
        handlingDirection: 'intercept',
        currentTodo: '拦截成功，继续核对原正向包裹的退回实物',
        interception: {
          status: 'succeeded',
          timeline: [
            expect.objectContaining({ kind: 'requested' }),
            expect.objectContaining({ kind: 'succeeded' }),
          ],
        },
      },
    });
    expect(application.queryShipmentRecords()[0].packages[0].logisticsStatus).toBe('in_transit');

    application.close();
    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      expect(() => database.prepare(`
        UPDATE aftersales_handling_direction_events SET reason = '被篡改' WHERE case_id = ?
      `).run(created.id)).toThrow(/immutable/u);
      expect(() => database.prepare(`
        DELETE FROM aftersales_interception_events WHERE case_id = ?
      `).run(created.id)).toThrow(/immutable/u);
    } finally {
      database.close();
    }
    const reopened = await createApplication(root, false);
    expect(reopened.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0])
      .toEqual(succeeded);
  });

  it('拦截失败与后续签收分别留痕并显式转为买家寄回', async () => {
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
        trackingNumber: 'SF-INTERCEPTION-FAILED-0001',
        items: shipmentItems,
      }],
    });
    const sourcePackage = shipment.record.packages[0];
    const sourceItem = sourcePackage.items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'intercept',
      occurredAt: '2026-08-14T19:00:00+08:00',
      reason: '买家要求改变收货安排',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });

    const waiting = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: created.id,
      expectedRevision: created.revision,
      handlingDirection: 'waiting',
      occurredAt: '2026-08-14T19:05:00+08:00',
      reason: '先继续等待，但仍保留已申请的拦截事项',
    });
    const failed = application.progressAftersalesCase({
      kind: 'record_interception_result',
      caseId: waiting.id,
      expectedRevision: waiting.revision,
      result: 'failed',
      occurredAt: '2026-08-14T19:10:00+08:00',
      reason: '承运方回复已进入末端配送，无法拦截',
    });
    expect(failed).toMatchObject({
      status: 'processing',
      revision: 3,
      returns: [],
      coordination: {
        handlingDirection: 'waiting',
        currentTodo: '继续跟踪原正向包裹并等待处理决定',
        interception: {
          status: 'failed',
          timeline: [
            expect.objectContaining({ kind: 'requested' }),
            expect.objectContaining({
              kind: 'failed',
              occurredAt: '2026-08-14T19:10:00+08:00',
              reason: '承运方回复已进入末端配送,无法拦截',
            }),
          ],
        },
      },
    });

    const another = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'intercept',
      occurredAt: '2026-08-14T19:11:00+08:00',
      reason: '另一件商品申请拦截',
      requestedRefundCents: 500,
      items: [{ shipmentPackageItemId: sourcePackage.items[1].id, quantity: 1 }],
    });
    const anotherWaiting = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: another.id,
      expectedRevision: another.revision,
      handlingDirection: 'waiting',
      occurredAt: '2026-08-14T19:12:00+08:00',
      reason: '暂时继续等待，但不撤销拦截请求',
    });
    expect(() => application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: anotherWaiting.id,
      expectedRevision: anotherWaiting.revision,
      handlingDirection: 'intercept',
      occurredAt: '2026-08-14T19:13:00+08:00',
      reason: '尝试重复建立拦截请求',
    })).toThrow('已有待确认的拦截请求，请先登记结果');
    const cancelled = application.progressAftersalesCase({
      kind: 'cancel',
      caseId: anotherWaiting.id,
      expectedRevision: anotherWaiting.revision,
      reason: '买家撤销退款请求，但拦截回执仍需保留',
    });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      coordination: {
        currentTodo: '拦截请求待确认，继续跟踪原正向包裹',
        risk: '拦截结果未确认，不应假定原正向包裹已收回',
        interception: { status: 'requested' },
      },
    });
    const resultAfterCancellation = application.progressAftersalesCase({
      kind: 'record_interception_result',
      caseId: cancelled.id,
      expectedRevision: cancelled.revision,
      result: 'succeeded',
      occurredAt: '2026-08-14T19:14:00+08:00',
      reason: '售后取消后承运方才回复拦截成功',
    });
    expect(resultAfterCancellation).toMatchObject({
      status: 'cancelled',
      coordination: { interception: { status: 'succeeded' } },
    });

    const completionPending = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'intercept',
      occurredAt: '2026-08-14T19:15:00+08:00',
      reason: '先申请拦截，后与买家协调仅退款',
      requestedRefundCents: 400,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    const completionRefundDirection = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: completionPending.id,
      expectedRevision: completionPending.revision,
      handlingDirection: 'only_refund',
      occurredAt: '2026-08-14T19:16:00+08:00',
      reason: '改为仅退款，但仍等待已发出的拦截回执',
    });
    expect(completionRefundDirection.coordination).toMatchObject({
      currentTodo: '拦截请求待确认，继续跟踪原正向包裹',
      interception: { status: 'requested' },
    });
    const completionRefunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: completionRefundDirection.id,
      expectedRevision: completionRefundDirection.revision,
      actualRefundCents: 400,
      occurredAt: '2026-08-14T19:17:00+08:00',
      note: '已核对平台实际退款',
    });
    const completed = application.progressAftersalesCase({
      kind: 'complete',
      caseId: completionRefunded.id,
      expectedRevision: completionRefunded.revision,
      reason: '退款售后已结案，拦截回执继续独立跟踪',
    });
    expect(completed).toMatchObject({
      status: 'completed',
      coordination: {
        currentTodo: '实际退款已确认，拦截请求仍待确认',
        risk: '拦截结果未确认，不应假定原正向包裹已收回',
        interception: { status: 'requested' },
      },
    });
    const resultAfterCompletion = application.progressAftersalesCase({
      kind: 'record_interception_result',
      caseId: completed.id,
      expectedRevision: completed.revision,
      result: 'failed',
      occurredAt: '2026-08-14T19:18:00+08:00',
      reason: '售后完成后承运方回复拦截失败',
    });
    expect(resultAfterCompletion).toMatchObject({
      status: 'completed',
      coordination: { interception: { status: 'failed' } },
    });

    const deliveredAt = new Date(
      Date.parse(sourcePackage.timeline.at(-1)?.occurredAt ?? shipment.record.createdAt) + 1_000,
    ).toISOString();
    application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: sourcePackage.id,
      expectedRevision: sourcePackage.revision,
      logisticsStatus: 'delivered',
      occurredAt: deliveredAt,
      reason: '买家确认原包裹已签收',
    });
    expect(application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })
      .find(({ id }) => id === failed.id))
      .toMatchObject({
        status: 'processing',
        coordination: {
          physicalControl: 'buyer',
          currentTodo: '原正向包裹已签收，请显式转换售后处理方向',
        },
      });

    const convertedAt = new Date(Math.max(
      Date.parse(deliveredAt) + 1_000,
      Date.parse('2026-08-14T19:30:00+08:00'),
    )).toISOString();
    const converted = application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: failed.id,
      expectedRevision: failed.revision,
      handlingDirection: 'buyer_return',
      occurredAt: convertedAt,
      reason: '拦截失败且买家已签收，改为买家寄回',
    });
    expect(converted).toMatchObject({
      status: 'waiting_return',
      revision: 4,
      returns: [],
      coordination: {
        handlingDirection: 'buyer_return',
        physicalControl: 'buyer',
        currentTodo: '等待买家退回',
        handlingDirectionTimeline: [
          expect.objectContaining({
            kind: 'selected',
            before: null,
            after: 'intercept',
            occurredAt: '2026-08-14T19:00:00+08:00',
          }),
          expect.objectContaining({
            kind: 'changed',
            before: 'intercept',
            after: 'waiting',
            occurredAt: '2026-08-14T19:05:00+08:00',
          }),
          expect.objectContaining({
            kind: 'changed',
            before: 'waiting',
            after: 'buyer_return',
            occurredAt: convertedAt,
            reason: '拦截失败且买家已签收,改为买家寄回',
          }),
        ],
      },
    });
    expect(application.queryShipmentRecords()[0].packages[0].logisticsStatus).toBe('delivered');
  });

  it('在途选择仅退款可先确认实际退款并在后续签收时提示收回风险', async () => {
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
        shippingCarrier: '中通快递',
        trackingNumber: 'ZT-REFUND-BEFORE-DELIVERY-0001',
        items: shipmentItems,
      }],
    });
    const sourcePackage = shipment.record.packages[0];
    const sourceItem = sourcePackage.items[0];
    const baseOccurredAt = Date.parse(shipment.record.createdAt) + 60_000;
    const occurredAt = (offsetMinutes: number) => (
      new Date(baseOccurredAt + offsetMinutes * 60_000).toISOString()
    );
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'only_refund',
      occurredAt: occurredAt(0),
      reason: '买家急需退款，商家同意先行处理',
      requestedRefundCents: 900,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    expect(created).toMatchObject({
      status: 'waiting_refund',
      returns: [],
      refund: { status: 'pending', requestedAmountCents: 900, refundRecords: [] },
      coordination: {
        handlingDirection: 'only_refund',
        physicalControl: 'carrier',
        risk: '商品仍在运输中，退款与收回实物需分别跟踪',
      },
    });

    const partialRefunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 850,
      occurredAt: occurredAt(10),
      note: '已核对平台退款记录',
    });
    expect(partialRefunded.refund).toMatchObject({
      status: 'pending',
      fulfillment: {
        kind: 'partial',
        refundedAmountCents: 850,
        remainingAmountCents: 50,
      },
    });

    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: partialRefunded.id,
      expectedRevision: partialRefunded.revision,
      actualRefundCents: 50,
      occurredAt: occurredAt(15),
      note: '补退剩余款项',
    });
    expect(refunded).toMatchObject({
      status: 'ready_to_complete',
      returns: [],
      refund: {
        status: 'confirmed',
        requestedAmountCents: 900,
        refundRecords: [{ amountCents: 850 }, { amountCents: 50 }],
      },
      coordination: {
        currentTodo: '实际退款已确认，继续跟踪并收回原正向包裹',
        risk: '买家已退款，原商品仍在运输中',
      },
    });

    application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: sourcePackage.id,
      expectedRevision: sourcePackage.revision,
      logisticsStatus: 'delivered',
      occurredAt: occurredAt(20),
      reason: '先行退款后买家确认原包裹已签收',
    });
    const delivered = application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    expect(delivered).toMatchObject({
      status: 'ready_to_complete',
      returns: [],
      refund: { status: 'confirmed', refundRecords: [{ amountCents: 850 }, { amountCents: 50 }] },
      coordination: {
        physicalControl: 'buyer',
        currentTodo: '买家已退款且原商品已签收，请跟进收回商品',
        risk: '资金已退出，原商品仍在买家控制中',
      },
    });
    expect(application.getOrder(sourceItem.orderId).operations).toMatchObject({
      risks: [expect.objectContaining({
        kind: 'refund_without_goods',
        affectedQuantity: 1,
        items: [{
          sourceTitle: sourceItem.sourceTitle,
          sourceSpec: sourceItem.sourceSpec,
          quantity: 1,
        }],
      })],
    });
    expect(application.queryShipmentRecords()[0].packages[0].logisticsStatus).toBe('delivered');
  });

  it('原商品仍在运输中时选择补发会投影精确商品数量的重复交付风险', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [order] = group.orders;
    const [orderItem] = order.items;
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: group.orders.flatMap((candidate) => candidate.items.map((item) => ({
        orderId: candidate.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))),
      packages: [{
        shippingCarrier: '中通快递',
        trackingNumber: 'ZT-REPLACEMENT-BEFORE-RETURN',
        items: [{ orderId: order.id, orderItemId: orderItem.id, quantity: 1 }],
      }],
    });
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'replacement',
      requestedRefundCents: 1_000,
      occurredAt: new Date(Date.parse(shipment.record.createdAt) + 60_000).toISOString(),
      reason: '原包裹仍在运输，买家要求先补发',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });

    const replacementRound = created.rounds.find(({ replacementRequired }) => (
      replacementRequired
    ));
    expect(replacementRound).toBeDefined();
    const replacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: created.id,
      expectedRevision: created.revision,
      roundId: replacementRound?.id,
      occurredAt: new Date(Date.parse(created.occurredAt) + 60_000).toISOString(),
      reason: '退货尚未收到，按协商结果先行补发',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-EARLY-REPLACEMENT-0001',
        items: [{ roundItemId: replacementRound?.items[0].id, quantity: 1 }],
      }],
    });
    expect(replacement.rounds.find(({ id }) => id === replacementRound?.id))
      .toMatchObject({
        replacementShipment: expect.objectContaining({
          packages: [expect.objectContaining({
            trackingNumber: 'SF-EARLY-REPLACEMENT-0001',
          })],
        }),
      });

    const operations = application.getOrder(order.id).operations;
    expect(operations.risks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'replacement_before_return',
        packageRole: 'replacement',
        affectedQuantity: 1,
        items: [{
          sourceTitle: sourceItem.sourceTitle,
          sourceSpec: sourceItem.sourceSpec,
          quantity: 1,
        }],
        title: '原商品未退回已先补发',
      }),
    ]));
    expect(operations.coordination.todos).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '跟进原商品退回' }),
      expect.objectContaining({ title: '跟进运输进度' }),
    ]));
    expect(operations.coordination.todos.map(({ title }) => title)).not.toContain('安排补发');
    expect(operations.shipmentRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceRole: 'replacement',
        replacementAftersalesCaseId: created.id,
        packages: [expect.objectContaining({
          items: [expect.objectContaining({ quantity: 1 })],
        })],
      }),
    ]));
  });

  it('原正向包裹确认丢失后要求明确买家侧处理并为补发建立轮次', async () => {
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
        shippingCarrier: '圆通速递',
        trackingNumber: 'YT-CONFIRMED-LOST-AFTERSALES-0001',
        items: shipmentItems,
      }],
    });
    const sourcePackage = shipment.record.packages[0];
    const sourceItem = sourcePackage.items[0];
    const baseOccurredAt = Date.parse(shipment.record.createdAt) + 60_000;
    const occurredAt = (offsetMinutes: number) => (
      new Date(baseOccurredAt + offsetMinutes * 60_000).toISOString()
    );
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      occurredAt: occurredAt(0),
      reason: '包裹长时间未更新，先继续等待调查',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });

    const accepted = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: sourcePackage.id,
      expectedRevision: sourcePackage.revision,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: occurredAt(5),
      reason: '已核对承运方揽收证据',
    });
    application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: sourcePackage.id,
      expectedRevision: accepted.record.packages[0].revision,
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'items', items: [{ sourceItemId: sourceItem.id, quantity: 1 }] },
      carrierConfirmedLoss: true,
      occurredAt: occurredAt(10),
      reason: '承运方已书面确认该商品丢失',
    });
    const lost = application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })[0];
    expect(lost).toMatchObject({
      status: 'processing',
      returns: [],
      coordination: {
        handlingDirection: 'waiting',
        physicalControl: 'confirmed_lost',
        currentTodo: '正向物流异常已确认，请明确买家侧处理选择',
        risk: '正向丢件影响 1 件商品',
        outboundException: {
          packageId: sourcePackage.id,
          exceptionType: 'lost',
          stage: 'confirmed',
          affectedQuantity: 1,
          decision: null,
        },
        availableDirections: ['waiting', 'only_refund', 'replacement'],
        sourcePackages: [expect.objectContaining({
          packageId: sourcePackage.id,
          logisticsStatus: 'in_transit',
          confirmedLost: true,
          items: [expect.objectContaining({
            shipmentPackageItemId: sourceItem.id,
            quantity: 1,
          })],
        })],
      },
    });
    const positiveLostTodoTitles = application.getOrder(sourceItem.orderId)
      .operations.coordination.todos.map(({ title }) => title);
    expect(positiveLostTodoTitles).toContain('选择正向异常处理');
    expect(positiveLostTodoTitles).not.toContain('处理售后问题');
    expect(() => application.progressAftersalesCase({
      kind: 'change_handling_direction',
      caseId: lost.id,
      expectedRevision: lost.revision,
      handlingDirection: 'buyer_return',
      occurredAt: occurredAt(20),
      reason: '试图要求买家寄回已丢失商品',
    })).toThrow('当前实物流转证据不允许该售后处理方向');

    const unaffectedItem = sourcePackage.items[1];
    const mixed = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      occurredAt: occurredAt(15),
      reason: '同一包裹中一件已丢失，另一件仍在运输',
      requestedRefundCents: 1_500,
      items: [
        { shipmentPackageItemId: sourceItem.id, quantity: 1 },
        { shipmentPackageItemId: unaffectedItem.id, quantity: 1 },
      ],
    });
    expect(mixed.coordination).toMatchObject({
      physicalControl: 'mixed',
      currentTodo: '正向物流异常已确认，请明确买家侧处理选择',
      risk: '正向丢件影响 1 件商品',
      availableDirections: ['waiting', 'only_refund', 'replacement'],
      sourcePackages: [{
        packageId: sourcePackage.id,
        confirmedLost: false,
        items: [
          expect.objectContaining({
            shipmentPackageItemId: sourceItem.id,
            quantity: 1,
            confirmedLostQuantity: 1,
          }),
          expect.objectContaining({
            shipmentPackageItemId: unaffectedItem.id,
            quantity: 1,
            confirmedLostQuantity: 0,
          }),
        ],
      }],
    });

    const replacementPending = application.progressAftersalesCase({
      kind: 'decide_outbound_logistics_exception',
      caseId: lost.id,
      expectedRevision: lost.revision,
      packageId: sourcePackage.id,
      exceptionId: lost.coordination.outboundException?.exceptionId as string,
      decision: 'replacement',
      occurredAt: occurredAt(20),
      reason: '与买家确认选择补发，待后续建立新发货记录',
    });
    expect(replacementPending).toMatchObject({
      status: 'waiting_replacement',
      returns: [],
      refund: { status: 'pending', refundRecords: [] },
      coordination: {
        handlingDirection: 'replacement',
        currentTodo: '安排第 2 轮补发',
        risk: '正向丢件影响 1 件商品',
        outboundException: { decision: 'replacement' },
      },
      rounds: expect.arrayContaining([
        expect.objectContaining({ workflow: 'direct_replacement' }),
      ]),
    });
    const refundCancelled = application.progressAftersalesCase({
      kind: 'cancel_refund_request',
      caseId: replacementPending.id,
      expectedRevision: replacementPending.revision,
      occurredAt: occurredAt(25),
      reason: '买家确认只需补发，显式取消退款申请',
    });
    expect(refundCancelled.refund?.status).toBe('cancelled');
    expect(application.queryShipmentRecords()).toHaveLength(1);
    const replacementRound = refundCancelled.rounds.at(-1);
    if (!replacementRound || replacementRound.workflow !== 'direct_replacement') {
      throw new Error('测试前置缺少正向异常补发轮次');
    }
    const replacement = application.progressAftersalesCase({
      kind: 'create_replacement_shipment',
      caseId: refundCancelled.id,
      roundId: replacementRound.id,
      expectedRevision: refundCancelled.revision,
      occurredAt: occurredAt(30),
      reason: '按已确认丢失数量建立补发记录',
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-CONFIRMED-LOST-REPLACEMENT-0001',
        items: replacementRound.items.map((item) => ({
          roundItemId: item.id,
          quantity: item.quantity,
        })),
      }],
    });
    const replacementPackage = replacement.rounds.at(-1)?.replacementShipment?.packages[0];
    if (!replacementPackage) throw new Error('测试前置缺少补发包裹');
    application.updateShipmentPackageLogisticsStatus({
      recordId: replacement.rounds.at(-1)?.replacementShipment?.id as string,
      packageId: replacementPackage.id,
      expectedRevision: replacementPackage.revision,
      logisticsStatus: 'delivered',
      occurredAt: occurredAt(60),
      reason: '补发包裹已由买家签收',
    });
    const replacementOperations = application.getOrder(sourceItem.orderId).operations;
    expect(replacementOperations.shipmentRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: replacement.rounds.at(-1)?.replacementShipment?.id,
        sourceRole: 'replacement',
        replacementAftersalesCaseId: lost.id,
      }),
    ]));
    expect(replacementOperations.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'replacement',
        label: '补发',
        value: 'delivered',
        affectedQuantity: 1,
      }),
    ]));
    expect(replacementOperations.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'replacement', title: '建立补发记录' }),
    ]));
    expect(application.queryAftersalesCases({ shipmentRecordId: shipment.record.id })
      .find(({ id }) => id === lost.id))
      .toMatchObject({ status: 'ready_to_complete', refund: { status: 'cancelled' } });
  });

  it('不同正向包裹分别签收和运输中时不会伪造部分丢件事实', async () => {
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
      packages: shipmentItems.map((item, index) => ({
        shippingCarrier: '顺丰速运',
        trackingNumber: `SF-MIXED-CONTROL-${index + 1}`,
        items: [item],
      })),
    });
    const deliveredPackage = shipment.record.packages[0];
    const baseOccurredAt = Date.parse(shipment.record.createdAt) + 60_000;
    const occurredAt = (offsetMinutes: number) => (
      new Date(baseOccurredAt + offsetMinutes * 60_000).toISOString()
    );
    application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: deliveredPackage.id,
      expectedRevision: deliveredPackage.revision,
      logisticsStatus: 'delivered',
      occurredAt: occurredAt(0),
      reason: '其中一个包裹已由买家签收',
    });

    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'waiting',
      occurredAt: occurredAt(10),
      reason: '两个包裹实际流转不一致，先分别核实',
      requestedRefundCents: 1_500,
      items: shipment.record.packages.map((shipmentPackage) => ({
        shipmentPackageItemId: shipmentPackage.items[0].id,
        quantity: 1,
      })),
    });

    expect(created.coordination).toMatchObject({
      physicalControl: 'mixed',
      currentTodo: '所选商品的实物控制关系不一致，请逐件核实并选择后续处理方向',
      risk: '同一售后内商品实物控制关系不一致',
      sourcePackages: expect.arrayContaining([
        expect.objectContaining({ logisticsStatus: 'delivered', confirmedLost: false }),
        expect.objectContaining({ logisticsStatus: 'in_transit', confirmedLost: false }),
      ]),
    });
    expect(created.coordination.currentTodo).not.toContain('丢失');
    expect(created.coordination.risk).not.toContain('丢失');
  });

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
    const caseOccurredAt = new Date(Date.parse(shipment.record.createdAt) + 60_000).toISOString();
    const createdCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-other',
      occurredAt: caseOccurredAt,
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
    expect(firstProjection).toMatchObject({
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
          currentException: null,
          carrierClaimStatus: null,
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
          currentException: null,
          carrierClaimStatus: null,
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
        occurredAt: caseOccurredAt,
        currentTodo: '处理售后问题',
        items: [{
          shipmentPackageItemId: activePackage.items[0].id,
          packageId: activePackage.id,
          orderItemId: firstItem.id,
          sourceTitle: firstItem.sourceTitle,
          sourceSpec: firstItem.sourceSpec,
          quantity: 1,
        }],
        returnPackages: [],
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
    const summaries = new Map(application.queryOrders({ lifecycleStatus: 'all' }).orders
      .map((order) => [order.id, order.operations]));
    expect(summaries.get(firstOrder.id)).toEqual({
      shipmentSummary: '部分发货（已发 1 / 共 2 件）',
      logisticsSummary: '运输中',
      aftersalesSummary: '处理中（1 件）',
      currentTodo: '处理售后问题',
    });
    expect(summaries.get(secondOrder.id)).toEqual({
      shipmentSummary: '已全部发货（2 件）',
      logisticsSummary: '运输中',
      aftersalesSummary: '处理中（1 件）',
      currentTodo: '处理售后问题',
    });
  });

  it('同一售后单跨订单时只投影本订单所属退货包裹、状态和决策历史', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-cross-order-return-projection-'));
    const application = await createApplication(root);
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder, secondOrder] = group.orders;
    const [firstOrderItem] = firstOrder.items;
    const [secondOrderItem] = secondOrder.items;
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: group.orders.flatMap((order) => order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))),
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-CROSS-ORDER-RETURN-SOURCE',
        items: [{
          orderId: firstOrder.id,
          orderItemId: firstOrderItem.id,
          quantity: 1,
        }, {
          orderId: secondOrder.id,
          orderItemId: secondOrderItem.id,
          quantity: 1,
        }],
      }],
    });
    confirmBuyerControl(application, shipment);
    const [firstShipmentItem, secondShipmentItem] = shipment.record.packages[0].items;
    const eventAt = (seconds: number) => new Date(
      Date.parse(shipment.record.createdAt) + seconds * 1_000,
    ).toISOString();
    const aftersalesCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      requestedRefundCents: 1_500,
      occurredAt: eventAt(60),
      reason: '两张订单的商品分两个退货包裹',
      items: [{ shipmentPackageItemId: firstShipmentItem.id, quantity: 1 }, {
        shipmentPackageItemId: secondShipmentItem.id,
        quantity: 1,
      }],
    });
    const roundId = aftersalesCase.rounds[0]?.id;
    if (!roundId) throw new Error('测试前置：售后处理轮次未建立');
    const firstReturnId = randomUUID();
    const secondReturnId = randomUUID();
    const firstReturnItemId = randomUUID();
    const secondReturnItemId = randomUUID();
    const secondExceptionId = randomUUID();
    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      database.exec('BEGIN IMMEDIATE;');
      const insertReturn = database.prepare(`
        INSERT INTO aftersales_return_records (
          id, aftersales_case_id, status, revision,
          shipping_carrier, tracking_number, occurred_at,
          received_at, inspection_result, inspection_note, inspected_at,
          created_at, updated_at, logistics_status, carrier_accepted_at,
          discrepancies_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, '[]')
      `);
      insertReturn.run(
        firstReturnId,
        aftersalesCase.id,
        'received',
        2,
        '中通快递',
        'ZT-FIRST-ORDER-RETURN',
        eventAt(120),
        eventAt(240),
        eventAt(120),
        eventAt(240),
        'delivered',
        eventAt(150),
      );
      insertReturn.run(
        secondReturnId,
        aftersalesCase.id,
        'in_transit',
        1,
        '圆通速递',
        'YT-SECOND-ORDER-RETURN',
        eventAt(180),
        null,
        eventAt(180),
        eventAt(180),
        'in_transit',
        eventAt(180),
      );
      const insertReturnItem = database.prepare(`
        INSERT INTO aftersales_return_record_items (
          id, return_record_id, aftersales_case_id, shipment_package_item_id,
          quantity, received_quantity, accepted_quantity,
          inspection_result, inspection_note
        ) VALUES (?, ?, ?, ?, 1, ?, 0, NULL, NULL)
      `);
      insertReturnItem.run(
        firstReturnItemId,
        firstReturnId,
        aftersalesCase.id,
        firstShipmentItem.id,
        1,
      );
      insertReturnItem.run(
        secondReturnItemId,
        secondReturnId,
        aftersalesCase.id,
        secondShipmentItem.id,
        0,
      );
      database.prepare(`
        INSERT INTO aftersales_round_returns (round_id, return_record_id) VALUES (?, ?), (?, ?)
      `).run(roundId, firstReturnId, roundId, secondReturnId);
      const insertReturnEvent = database.prepare(`
        INSERT INTO aftersales_return_record_events (
          id, return_record_id, kind, base_revision, result_revision,
          occurred_at, reason, inspection_result, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `);
      insertReturnEvent.run(
        randomUUID(),
        firstReturnId,
        'registered',
        0,
        1,
        eventAt(120),
        '第一张订单退货已寄出',
        '{}',
        eventAt(120),
      );
      insertReturnEvent.run(
        randomUUID(),
        firstReturnId,
        'received',
        1,
        2,
        eventAt(240),
        '第一张订单退货已收到',
        JSON.stringify({ items: [{ returnRecordItemId: firstReturnItemId, receivedQuantity: 1 }] }),
        eventAt(240),
      );
      insertReturnEvent.run(
        randomUUID(),
        secondReturnId,
        'registered',
        0,
        1,
        eventAt(180),
        '仅第二张订单退货已寄出',
        '{}',
        eventAt(180),
      );
      const exceptionImpact = JSON.stringify({
        scope: 'items',
        items: [{ sourceItemId: secondReturnItemId, quantity: 1 }],
      });
      database.prepare(`
        INSERT INTO logistics_exception_matters (
          id, direction, shipment_package_id, return_record_id,
          exception_type, stage, revision, impact_json, reason,
          occurred_at, created_at, updated_at
        ) VALUES (?, 'return', NULL, ?, 'damaged', 'investigating', 1, ?, ?, ?, ?, ?)
      `).run(
        secondExceptionId,
        secondReturnId,
        exceptionImpact,
        '仅第二张订单退货运输破损',
        eventAt(210),
        eventAt(210),
        eventAt(210),
      );
      database.prepare(`
        INSERT INTO logistics_exception_events (
          id, exception_id, kind, base_revision, result_revision,
          before_stage, after_stage, reason, occurred_at, impact_json, created_at
        ) VALUES (?, ?, 'opened', 0, 1, NULL, 'investigating', ?, ?, ?, ?)
      `).run(
        randomUUID(),
        secondExceptionId,
        '仅第二张订单退货运输破损',
        eventAt(210),
        exceptionImpact,
        eventAt(210),
      );
      database.prepare(`
        INSERT INTO aftersales_return_exception_decision_events (
          id, case_id, exception_id, return_record_id, kind,
          before_decision, after_decision, occurred_at, reason, created_at
        ) VALUES (?, ?, ?, ?, 'selected', NULL, 'wait_investigation', ?, ?, ?)
      `).run(
        randomUUID(),
        aftersalesCase.id,
        secondExceptionId,
        secondReturnId,
        eventAt(220),
        '仅第二张订单退货等待承运调查',
        eventAt(220),
      );
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    } finally {
      database.close();
    }

    const firstOperations = application.getOrder(firstOrder.id).operations;
    const secondOperations = application.getOrder(secondOrder.id).operations;
    expect(firstOperations.aftersalesCases[0].returnPackages).toEqual([
      expect.objectContaining({ id: firstReturnId, status: 'received' }),
    ]);
    expect(firstOperations.aftersalesCases[0].currentTodo).toBe('检查退回商品');
    expect(firstOperations.currentTodo).toBe('确认实际退款');
    expect(firstOperations.coordination.todos.map(({ title }) => title))
      .toContain('检查退回商品');
    expect(firstOperations.history.map(({ detail }) => detail).join('\n'))
      .not.toContain('仅第二张订单');
    expect(firstOperations.risks).toEqual([]);

    expect(secondOperations.aftersalesCases[0].returnPackages).toEqual([
      expect.objectContaining({
        id: secondReturnId,
        status: 'in_transit',
        currentException: expect.objectContaining({
          exceptionType: 'damaged',
          affectedQuantity: 1,
        }),
      }),
    ]);
    expect(secondOperations.aftersalesCases[0].currentTodo).toBe('处理退货物流异常');
    expect(secondOperations.currentTodo).toBe('确认实际退款');
    expect(secondOperations.coordination.todos.map(({ title }) => title))
      .toContain('处理退货物流异常');
    expect(secondOperations.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '选择退货异常处理',
        detail: expect.stringContaining('仅第二张订单退货等待承运调查'),
      }),
    ]));
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
      workflowTemplateId: 'system-aftersales-other',
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

  it('订单运营投影同时保留多个活动异常并按订单商品隔离待办、风险、事实与历史', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [firstOrder, secondOrder] = group.orders;
    const [firstItem] = firstOrder.items;
    const [secondItem] = secondOrder.items;
    const shipmentItems = [{
      orderId: firstOrder.id,
      orderItemId: firstItem.id,
      quantity: 1,
    }, {
      orderId: secondOrder.id,
      orderItemId: secondItem.id,
      quantity: 1,
    }];
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: group.orders.flatMap((order) => order.items.map((item) => ({
        orderId: order.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))),
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-UNIFIED-OPERATIONS-001',
        items: shipmentItems,
      }],
    });
    const shipmentPackage = shipment.record.packages[0];
    const eventAt = (seconds: number) => new Date(
      Date.parse(shipment.record.createdAt) + seconds * 1_000,
    ).toISOString();
    const firstException = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      exceptionType: 'damaged',
      stage: 'investigating',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: shipmentPackage.items[0].id, quantity: 1 }],
      },
      occurredAt: eventAt(60),
      reason: '第一张订单商品运输破损待调查',
    });
    const secondException = application.recordShipmentPackageLogisticsException({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: firstException.record.packages[0].revision,
      exceptionType: 'misdelivered',
      stage: 'pending_verification',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: shipmentPackage.items[1].id, quantity: 1 }],
      },
      occurredAt: eventAt(120),
      reason: '第二张订单商品疑似错投待核实',
    });

    const firstOperations = application.getOrder(firstOrder.id).operations;
    const secondOperations = application.getOrder(secondOrder.id).operations;

    expect(firstOperations.coordination).toMatchObject({
      primaryTodo: {
        priority: 'physical_risk',
        title: '处理正向物流异常',
      },
      secondaryTodoCount: 1,
    });
    expect(firstOperations.risks).toEqual([
      expect.objectContaining({
        kind: 'logistics_exception',
        packageRole: 'original_outbound',
        exceptionType: 'damaged',
        affectedQuantity: 1,
        items: [{
          sourceTitle: firstItem.sourceTitle,
          sourceSpec: firstItem.sourceSpec,
          quantity: 1,
        }],
        detail: '第一张订单商品运输破损待调查',
      }),
    ]);
    expect(firstOperations.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'outbound_logistics', value: 'in_transit' }),
      expect.objectContaining({
        kind: 'logistics_exception',
        value: 'investigating',
        affectedQuantity: 1,
      }),
    ]));
    expect(firstOperations.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'logistics_exception',
        title: '登记正向物流异常',
        detail: expect.stringContaining('第一张订单商品运输破损待调查'),
      }),
    ]));
    expect(firstOperations.shipmentRecords[0].packages[0].logisticsExceptions)
      .toEqual([expect.objectContaining({ exceptionType: 'damaged' })]);

    expect(secondOperations.risks).toEqual([
      expect.objectContaining({
        exceptionType: 'misdelivered',
        affectedQuantity: 1,
        items: [{
          sourceTitle: secondItem.sourceTitle,
          sourceSpec: secondItem.sourceSpec,
          quantity: 1,
        }],
        detail: '第二张订单商品疑似错投待核实',
      }),
    ]);
    expect(secondOperations.shipmentRecords[0].packages[0].logisticsExceptions)
      .toEqual([expect.objectContaining({ exceptionType: 'misdelivered' })]);
    expect(secondOperations.history).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: '第一张订单商品运输破损待调查' }),
    ]));
    expect(secondException.record.packages[0].logisticsExceptions).toHaveLength(2);
  });

  it('售后结案后仍并列展示退款、退货、已解决异常与未结束索赔且不复活旧流程', async () => {
    const application = await createApplication();
    const group = application.queryShipmentGroups().groups[0];
    const [order] = group.orders;
    const [orderItem] = order.items;
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: group.orders.flatMap((candidate) => candidate.items.map((item) => ({
        orderId: candidate.id,
        orderItemId: item.id,
        quantity: item.quantity,
      }))),
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-UNIFIED-OPERATIONS-RETURN',
        items: [{ orderId: order.id, orderItemId: orderItem.id, quantity: 1 }],
      }],
    });
    const shipmentPackage = shipment.record.packages[0];
    const eventAt = (seconds: number) => new Date(
      Date.parse(shipment.record.createdAt) + seconds * 1_000,
    ).toISOString();
    const delivered = application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipmentPackage.id,
      expectedRevision: shipmentPackage.revision,
      logisticsStatus: 'delivered',
      occurredAt: eventAt(60),
      reason: '买家确认收到原商品',
    });
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      requestedRefundCents: 1_000,
      occurredAt: eventAt(120),
      reason: '买家退回一件商品并申请退款',
      items: [{
        shipmentPackageItemId: delivered.record.packages[0].items[0].id,
        quantity: 1,
      }],
    });
    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '中通快递',
      trackingNumber: 'ZT-UNIFIED-OPERATIONS-RETURN',
      occurredAt: eventAt(180),
      reason: '买家已交寄退货',
    });
    const accepted = application.progressAftersalesCase({
      kind: 'update_return_logistics_status',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: registered.returns[0].id,
      logisticsStatus: 'in_transit',
      carrierAcceptanceConfirmed: true,
      occurredAt: eventAt(240),
      reason: '承运方确认揽收退货',
    });
    const lost = application.progressAftersalesCase({
      kind: 'record_return_logistics_exception',
      caseId: accepted.id,
      expectedRevision: accepted.revision,
      returnRecordId: accepted.returns[0].id,
      exceptionType: 'lost',
      stage: 'confirmed',
      carrierConfirmedLoss: true,
      impact: { scope: 'package' },
      occurredAt: eventAt(300),
      reason: '承运方确认退货包裹遗失',
    });
    const decided = application.progressAftersalesCase({
      kind: 'decide_return_logistics_exception',
      caseId: lost.id,
      expectedRevision: lost.revision,
      returnRecordId: lost.returns[0].id,
      exceptionId: lost.returns[0].currentException?.id as string,
      decision: 'refund_in_advance',
      occurredAt: eventAt(360),
      reason: '买家侧先行退款，承运责任继续处理',
    });
    const claimed = application.progressAftersalesCase({
      kind: 'open_carrier_claim',
      caseId: decided.id,
      expectedRevision: decided.revision,
      returnRecordId: decided.returns[0].id,
      requestedAmountCents: 1_000,
      occurredAt: eventAt(420),
      reason: '向承运方申请退货丢件索赔',
    });
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: claimed.id,
      expectedRevision: claimed.revision,
      actualRefundCents: 1_000,
      occurredAt: eventAt(480),
      note: '实际向买家退款十元',
    });
    const completed = application.progressAftersalesCase({
      kind: 'complete',
      caseId: refunded.id,
      expectedRevision: refunded.revision,
      reason: '买家侧处理已经完成',
    });
    application.progressAftersalesCase({
      kind: 'progress_return_logistics_exception',
      caseId: completed.id,
      expectedRevision: completed.revision,
      returnRecordId: completed.returns[0].id,
      exceptionId: completed.returns[0].currentException?.id as string,
      expectedExceptionRevision: completed.returns[0].currentException?.revision as number,
      stage: 'resolved',
      occurredAt: eventAt(540),
      reason: '承运调查结束，保留丢件处理历史',
    });

    const operations = application.getOrder(order.id).operations;
    expect(operations.coordination.primaryTodo).toMatchObject({
      priority: 'financial_risk',
      title: '跟进承运索赔',
      target: { aftersalesCaseId: created.id },
    });
    expect(operations.risks).toEqual([
      expect.objectContaining({
        kind: 'refund_without_goods',
        title: '退款后原商品未收回',
        affectedQuantity: 1,
        items: [{
          sourceTitle: '亚麻收纳袋',
          sourceSpec: '米白 大号',
          quantity: 1,
        }],
      }),
    ]);
    expect(operations.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'aftersales', value: 'completed' }),
      expect.objectContaining({ kind: 'return_logistics', value: 'in_transit' }),
      expect.objectContaining({ kind: 'refund', value: 'confirmed', affectedQuantity: 1 }),
      expect.objectContaining({ kind: 'carrier_claim', value: 'pending' }),
      expect.objectContaining({ kind: 'logistics_exception', value: 'resolved' }),
    ]));
    expect(operations.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'return',
        detail: expect.stringContaining('买家已交寄退货'),
      }),
      expect.objectContaining({
        kind: 'return',
        detail: expect.stringContaining('承运方确认揽收退货'),
      }),
      expect.objectContaining({
        kind: 'logistics_exception',
        detail: expect.stringContaining('承运方确认退货包裹遗失'),
      }),
      expect.objectContaining({
        kind: 'return',
        detail: expect.stringContaining('买家侧先行退款,承运责任继续处理'),
      }),
      expect.objectContaining({
        kind: 'logistics_exception',
        title: '结束退货物流异常',
        detail: expect.stringContaining('承运调查结束,保留丢件处理历史'),
      }),
      expect.objectContaining({
        kind: 'refund',
        title: '确认实际退款',
        detail: expect.stringContaining('申请 ¥10.00 → 实际 ¥10.00'),
      }),
      expect.objectContaining({
        kind: 'carrier_claim',
        title: '建立承运索赔',
        detail: expect.stringContaining('向承运方申请退货丢件索赔'),
      }),
      expect.objectContaining({
        kind: 'aftersales',
        detail: expect.stringContaining('买家侧处理已经完成'),
      }),
    ]));
    expect(operations.aftersalesCases[0].returnPackages[0].logisticsExceptions)
      .toEqual([expect.objectContaining({ exceptionType: 'lost', stage: 'resolved' })]);
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
      workflowTemplateId: 'system-aftersales-other',
      occurredAt: '2026-08-13T11:00:00+08:00',
      reason: '先登记一件商品破损',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });

    expect(() => application.updateAftersalesCase({
      caseId: created.id,
      expectedRevision: created.revision,
      status: 'ready_to_complete',
      reason: created.reason,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      changeReason: '试图人工跳过资金事实',
    })).toThrow('待完成只能由已确认的退款事实产生');

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
      workflowTemplateId: 'system-aftersales-other',
      occurredAt: '2026-08-13T12:00:00+08:00',
      reason: '第一件商品售后处理中',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });

    expect(() => application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-other',
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
      workflowTemplateId: 'system-aftersales-other',
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
      workflowTemplateId: 'system-aftersales-other',
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
      workflowTemplateId: 'system-aftersales-other',
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
      workflowTemplateId: 'system-aftersales-other',
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
    })).toThrow('已结束的售后处理单不能重新打开，请为新的独立问题另行建立处理单');
  });

  it('建立仅退款处理时保留商品数量和申请金额且不创建退货记录', async () => {
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
        trackingNumber: 'SF-REFUND-ONLY-0001',
        items: shipmentItems,
      }],
    });
    const sourceItem = shipment.record.packages[0].items[0];

    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-refund-only',
      occurredAt: '2026-08-13T20:00:00+08:00',
      reason: '其中一件商品申请部分退款',
      requestedRefundCents: 600,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });

    expect(created).toMatchObject({
      workflow: 'refund_only',
      status: 'waiting_refund',
      coordination: { handlingDirection: null, handlingDirectionTimeline: [] },
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
      refund: {
        requestedAmountCents: 600,
        status: 'pending',
        refundRecords: [],
      },
      returns: [],
      timeline: [{
        kind: 'created',
        resultRevision: 1,
        status: 'waiting_refund',
      }],
    });
    expect(application.queryShipmentRecords()[0].packages[0]).toMatchObject({
      logisticsStatus: 'in_transit',
      trackingNumber: 'SF-REFUND-ONLY-0001',
    });
  });

  it('仅退款在实际确认后形成独立资金记录并由用户完成售后', async () => {
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
        trackingNumber: 'SF-REFUND-CONFIRMED-0001',
        items: shipmentItems,
      }],
    });
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-refund-only',
      occurredAt: '2026-08-13T20:10:00+08:00',
      reason: '买家申请部分退款',
      requestedRefundCents: 600,
      items: [{
        shipmentPackageItemId: shipment.record.packages[0].items[0].id,
        quantity: 1,
      }],
    });

    expect(() => application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-13T20:05:00+08:00',
      note: '试图登记早于售后发生的退款',
    })).toThrow('实际退款时间不能早于售后发生时间');

    const partial = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: created.id,
      expectedRevision: created.revision,
      actualRefundCents: 500,
      occurredAt: '2026-08-13T20:20:00+08:00',
      note: '平台账单确认实际退回 5 元',
    });

    expect(partial).toMatchObject({
      status: 'waiting_refund',
      revision: 2,
      refund: {
        requestedAmountCents: 600,
        status: 'pending',
        refundRecords: [{
          kind: 'aftersales_refund',
          amountCents: 500,
          occurredAt: '2026-08-13T20:20:00+08:00',
          note: '平台账单确认实际退回 5 元',
        }],
        fulfillment: {
          kind: 'partial',
          refundedAmountCents: 500,
          remainingAmountCents: 100,
        },
      },
      timeline: [
        expect.objectContaining({ kind: 'created', resultRevision: 1 }),
        expect.objectContaining({
          kind: 'updated',
          baseRevision: 1,
          resultRevision: 2,
          changeReason: '部分退款：平台账单确认实际退回 5 元',
          before: expect.objectContaining({ status: 'waiting_refund' }),
          after: expect.objectContaining({ status: 'waiting_refund' }),
        }),
      ],
    });

    const confirmed = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: partial.id,
      expectedRevision: partial.revision,
      actualRefundCents: 100,
      occurredAt: '2026-08-13T20:25:00+08:00',
      note: '补退剩余 1 元',
    });

    expect(confirmed).toMatchObject({
      status: 'ready_to_complete',
      revision: 3,
      refund: {
        requestedAmountCents: 600,
        status: 'confirmed',
        refundRecords: [{ amountCents: 500 }, { amountCents: 100 }],
        fulfillment: { kind: 'complete', refundedAmountCents: 600 },
      },
    });

    const completed = application.progressAftersalesCase({
      kind: 'complete',
      caseId: confirmed.id,
      expectedRevision: confirmed.revision,
      reason: '退款已经到账，本次售后结束',
    });
    expect(completed).toMatchObject({
      status: 'completed',
      revision: 4,
      refund: confirmed.refund,
    });
    expect(application.queryShipmentRecords()[0].packages[0].logisticsStatus).toBe('in_transit');
  });

  it('取消待确认退款时保留已发生的退货事实并释放可处理数量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-aftersales-cancel-history-'));
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
        trackingNumber: 'SF-REFUND-CANCELLED-0001',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-refund-only',
      occurredAt: '2026-08-13T20:30:00+08:00',
      reason: '买家提出退款后又撤销',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
    });

    const cancelled = application.progressAftersalesCase({
      kind: 'cancel',
      caseId: created.id,
      expectedRevision: created.revision,
      reason: '买家确认不再申请退款',
    });

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      revision: 2,
      refund: {
        requestedAmountCents: 1_000,
        status: 'cancelled',
        refundRecords: [],
      },
      timeline: [
        expect.objectContaining({ resultRevision: 1 }),
        expect.objectContaining({
          resultRevision: 2,
          changeReason: '买家确认不再申请退款',
          after: expect.objectContaining({ status: 'cancelled' }),
        }),
      ],
    });
    const returnRefund = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-13T20:35:00+08:00',
      reason: '买家寄回商品后取消退款申请',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
    });
    const returnRegistered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: returnRefund.id,
      expectedRevision: returnRefund.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-CANCELLED-RETURN-0001',
      occurredAt: '2026-08-13T20:36:00+08:00',
      reason: '买家已寄出退货',
    });
    const cancelledReturnRefund = application.progressAftersalesCase({
      kind: 'cancel',
      caseId: returnRegistered.id,
      expectedRevision: returnRegistered.revision,
      reason: '买家取消退款申请，但退货已寄出',
    });
    expect(cancelledReturnRefund).toMatchObject({
      workflow: 'return_refund',
      status: 'cancelled',
      refund: { status: 'cancelled' },
      returns: [{
        id: returnRegistered.returns[0].id,
        status: 'in_transit',
        shippingCarrier: '圆通速递',
        trackingNumber: 'YT-CANCELLED-RETURN-0001',
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
        timeline: [{ kind: 'registered', reason: '买家已寄出退货' }],
      }],
    });
    expect(application.getOrder(sourceItem.orderId).operations.currentTodo)
      .toBe('确认收到退货');
    const receivedAfterCancellation = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: cancelledReturnRefund.id,
      expectedRevision: cancelledReturnRefund.revision,
      returnRecordId: returnRegistered.returns[0].id,
      occurredAt: '2026-08-13T20:37:00+08:00',
      reason: '取消退款后退货仍实际到达',
    });
    expect(receivedAfterCancellation).toMatchObject({
      status: 'cancelled',
      refund: { status: 'cancelled' },
      returns: [{ status: 'received', receivedAt: '2026-08-13T20:37:00+08:00' }],
    });
    expect(application.getOrder(sourceItem.orderId).operations.currentTodo)
      .toBe('检查退回商品');
    const inspectedAfterCancellation = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: receivedAfterCancellation.id,
      expectedRevision: receivedAfterCancellation.revision,
      returnRecordId: returnRegistered.returns[0].id,
      result: 'resellable',
      occurredAt: '2026-08-13T20:38:00+08:00',
      note: '取消退款后仍完成退货检查',
    });
    expect(inspectedAfterCancellation).toMatchObject({
      status: 'cancelled',
      refund: { status: 'cancelled', refundRecords: [] },
      returns: [{
        status: 'inspected',
        inspection: { result: 'resellable', note: '取消退款后仍完成退货检查' },
      }],
    });
    expect(application.getOrder(sourceItem.orderId).operations.currentTodo)
      .toBe('无需物流操作');
    const laterCase = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-other',
      occurredAt: '2026-08-13T20:40:00+08:00',
      reason: '取消后发生新的独立问题',
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 2 }],
    });
    expect(laterCase).toMatchObject({ status: 'processing', items: [{ quantity: 2 }] });

    application.close();
    const reopened = await createApplication(root, false);
    expect(reopened.queryAftersalesCases({ shipmentRecordId: shipment.record.id }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: inspectedAfterCancellation.id,
          status: 'cancelled',
          refund: expect.objectContaining({ status: 'cancelled', refundRecords: [] }),
          returns: [expect.objectContaining({
            id: returnRegistered.returns[0].id,
            status: 'inspected',
            trackingNumber: 'YT-CANCELLED-RETURN-0001',
            inspection: expect.objectContaining({ result: 'resellable' }),
          })],
        }),
        expect.objectContaining({ id: laterCase.id, status: 'processing' }),
      ]));
  });

  it('退货退款按退货运输、收到、检查和实际退款的独立事实推进', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-return-refund-history-'));
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
        trackingNumber: 'SF-RETURN-REFUND-ORIGINAL',
        items: shipmentItems,
      }],
    });
    confirmBuyerControl(application, shipment);
    const sourceItem = shipment.record.packages[0].items[0];
    const created = application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-return-refund',
      handlingDirection: 'buyer_return',
      occurredAt: '2026-08-13T21:00:00+08:00',
      reason: '一件商品破损，需要退回后退款',
      requestedRefundCents: 1_000,
      items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
    });
    expect(created).toMatchObject({
      workflow: 'return_refund',
      status: 'waiting_return',
      returns: [],
      refund: { status: 'pending', requestedAmountCents: 1_000 },
    });

    const registered = application.progressAftersalesCase({
      kind: 'register_return',
      caseId: created.id,
      expectedRevision: created.revision,
      shippingCarrier: '圆通速递',
      trackingNumber: 'YT-RETURN-0001',
      occurredAt: '2026-08-13T21:10:00+08:00',
      reason: '买家已寄出退货',
    });
    expect(registered).toMatchObject({
      status: 'waiting_return',
      revision: 2,
      returns: [{
        status: 'in_transit',
        revision: 1,
        shippingCarrier: '圆通速递',
        trackingNumber: 'YT-RETURN-0001',
        items: [{ shipmentPackageItemId: sourceItem.id, quantity: 1 }],
        timeline: [{ kind: 'registered', reason: '买家已寄出退货' }],
      }],
    });
    const returnRecord = registered.returns[0];

    expect(() => application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnRecord.id,
      occurredAt: '2026-08-13T21:05:00+08:00',
      reason: '试图登记早于寄出的收到时间',
    })).toThrow('退货收到时间不能早于寄出时间');

    const received = application.progressAftersalesCase({
      kind: 'receive_return',
      caseId: registered.id,
      expectedRevision: registered.revision,
      returnRecordId: returnRecord.id,
      occurredAt: '2026-08-13T21:20:00+08:00',
      reason: '仓库已实际收到退货',
    });
    expect(received).toMatchObject({
      status: 'waiting_inspection',
      revision: 3,
      returns: [{
        status: 'received',
        revision: 2,
        receivedAt: '2026-08-13T21:20:00+08:00',
      }],
    });
    expect(() => application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: returnRecord.id,
      result: 'defective',
      occurredAt: '2026-08-13T21:15:00+08:00',
      note: '试图登记早于收到的检查时间',
    })).toThrow('退货检查时间不能早于收到时间');
    expect(() => application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: received.id,
      expectedRevision: received.revision,
      actualRefundCents: 1_000,
      occurredAt: '2026-08-13T20:45:00+08:00',
      note: '试图补录早于退货寄出的退款',
    })).toThrow('实际退款时间不能早于退货检查时间');

    const inspected = application.progressAftersalesCase({
      kind: 'inspect_return',
      caseId: received.id,
      expectedRevision: received.revision,
      returnRecordId: returnRecord.id,
      result: 'defective',
      occurredAt: '2026-08-13T21:30:00+08:00',
      note: '检查确认存在破损，进入瑕疵品待处理',
    });
    expect(inspected).toMatchObject({
      status: 'waiting_refund',
      revision: 4,
      returns: [{
        status: 'inspected',
        revision: 3,
        inspection: {
          result: 'defective',
          occurredAt: '2026-08-13T21:30:00+08:00',
          note: '检查确认存在破损,进入瑕疵品待处理',
        },
        timeline: [
          expect.objectContaining({ kind: 'registered' }),
          expect.objectContaining({ kind: 'received' }),
          expect.objectContaining({ kind: 'inspected', result: 'defective' }),
        ],
      }],
    });

    expect(() => application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: inspected.id,
      expectedRevision: inspected.revision,
      actualRefundCents: 900,
      occurredAt: '2026-08-13T21:29:00+08:00',
      note: '试图登记早于检查的退款时间',
    })).toThrow('实际退款时间不能早于退货检查时间');

    const partialRefunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: inspected.id,
      expectedRevision: inspected.revision,
      actualRefundCents: 900,
      occurredAt: '2026-08-13T21:40:00+08:00',
      note: '平台确认实际退款 9 元',
    });
    expect(partialRefunded.refund).toMatchObject({
      status: 'pending',
      fulfillment: {
        kind: 'partial',
        refundedAmountCents: 900,
        remainingAmountCents: 100,
      },
    });
    const refunded = application.progressAftersalesCase({
      kind: 'confirm_refund',
      caseId: partialRefunded.id,
      expectedRevision: partialRefunded.revision,
      actualRefundCents: 100,
      occurredAt: '2026-08-13T21:45:00+08:00',
      note: '补退剩余 1 元',
    });
    const completed = application.progressAftersalesCase({
      kind: 'complete',
      caseId: refunded.id,
      expectedRevision: refunded.revision,
      reason: '退货和退款均已核对完成',
    });
    expect(completed).toMatchObject({
      status: 'completed',
      refund: {
        requestedAmountCents: 1_000,
        status: 'confirmed',
        refundRecords: [{ amountCents: 900 }, { amountCents: 100 }],
        fulfillment: { kind: 'complete', refundedAmountCents: 1_000 },
      },
      returns: [{ status: 'inspected', inspection: { result: 'defective' } }],
    });
    expect(application.queryShipmentRecords()[0].packages[0]).toMatchObject({
      logisticsStatus: 'delivered',
      trackingNumber: 'SF-RETURN-REFUND-ORIGINAL',
    });

    application.close();
    const reopened = await createApplication(root, false);
    expect(reopened.queryAftersalesCases({ shipmentRecordId: shipment.record.id })).toMatchObject([{
      id: completed.id,
      workflow: 'return_refund',
      status: 'completed',
      revision: 7,
      refund: {
        requestedAmountCents: 1_000,
        status: 'confirmed',
        refundRecords: [{ amountCents: 900 }, { amountCents: 100 }],
      },
      returns: [{
        id: returnRecord.id,
        status: 'inspected',
        revision: 3,
        timeline: [
          expect.objectContaining({ kind: 'registered', resultRevision: 1 }),
          expect.objectContaining({ kind: 'received', resultRevision: 2 }),
          expect.objectContaining({ kind: 'inspected', resultRevision: 3 }),
        ],
      }],
      timeline: expect.arrayContaining([
        expect.objectContaining({ resultRevision: 1 }),
        expect.objectContaining({ resultRevision: 7 }),
      ]),
    }]);
    reopened.close();

    const pendingItemId = completed.refund?.pendingItemId;
    if (!pendingItemId) throw new Error('测试要求已保存退款申请');
    const database = new DatabaseSync(join(root, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      expect(() => database.prepare(`
        UPDATE financial_records SET amount_cents = 1 WHERE aftersales_case_id = ?
      `).run(completed.id)).toThrow(/immutable/u);
      expect(() => database.prepare(`
        UPDATE aftersales_return_record_events SET reason = '被篡改' WHERE return_record_id = ?
      `).run(returnRecord.id)).toThrow(/immutable/u);
      expect(() => database.prepare(`
        UPDATE aftersales_return_record_items SET quantity = 2 WHERE return_record_id = ?
      `).run(returnRecord.id)).toThrow(/immutable/u);
      expect(() => database.prepare(`
        DELETE FROM pending_financial_item_events WHERE pending_item_id = ?
      `).run(pendingItemId)).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });
});
