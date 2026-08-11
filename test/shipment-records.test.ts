import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  ];
  const application = new LocalApplication(new SequenceRecognizer([...recognitions]));
  openedApplications.push(application);
  application.openDataDirectory(join(applicationRoot, '数据'));
  if (!seedOrders) return application;
  for (const [index] of recognitions.entries()) {
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
    expect(result.projection.groups).toHaveLength(1);
    expect(result.projection.groups[0]).toMatchObject({
      id: group.id,
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
    expect(result.projection.groups).toHaveLength(1);
    expect(result.projection.groups[0]).toMatchObject({
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
    expect(result.projection.groups[0].totalQuantity).toBe(4);
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
