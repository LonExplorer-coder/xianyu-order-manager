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
  OrderEditInput,
  OriginalOrder,
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
  overrides: Partial<RecognitionResult> & Pick<RecognitionResult, 'orderNumber'>,
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '合并发货测试账号',
    alipayTransactionNumber: `ALI-${overrides.orderNumber}`,
    buyerNickname: '测试买家',
    recipient: '林青',
    phone: '13800000001',
    phoneNormalized: '13800000001',
    addressOriginal: '广东省深圳市南山区海风路1号',
    addressNormalized: '广东省深圳市南山区海风路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-03 09:00:00',
    orderedAtNormalized: '2026-08-03T09:00:00+08:00',
    paidAtOriginal: '2026-08-03 09:00:08',
    paidAtNormalized: '2026-08-03T09:00:08+08:00',
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
    ...overrides,
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

async function createApplicationWithOrders(results: RecognitionResult[]) {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-groups-'));
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  openedApplications.push(application);
  application.openDataDirectory(join(root, '数据'));

  for (const [index] of results.entries()) {
    const sourcePath = join(sourceDirectory, `订单-${index + 1}.png`);
    await writeFile(sourcePath, Buffer.from(`shipment-group-order-${index + 1}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    application.confirmDraft(batch.drafts[0]);
  }
  return { application, dataDirectory: join(root, '数据') };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('保守的合并发货组', () => {
  it('相同规范化手机号和完整地址归为一组，不同地址保持独立', async () => {
    const { application } = await createApplicationWithOrders([
      recognition({ orderNumber: 'XY-SHIPMENT-0001' }),
      recognition({
        orderNumber: 'XY-SHIPMENT-0002',
        recipient: '林青（公司）',
        items: [
          {
            sourceTitle: '亚麻收纳袋',
            sourceSpec: '米白 大号',
            unitPriceCents: 1_000,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '标签贴',
            sourceSpec: '透明',
            unitPriceCents: 500,
            quantity: 2,
            quantityInferred: false,
          },
        ],
      }),
      recognition({
        orderNumber: 'XY-SHIPMENT-0003',
        addressOriginal: '广东省深圳市福田区海风路1号',
        addressNormalized: '广东省深圳市福田区海风路1号',
        district: '福田区',
      }),
    ]);

    const projection = application.queryShipmentGroups();

    expect(projection.groups).toHaveLength(2);
    expect(projection.attentionOrders).toEqual([]);
    const nanShanGroup = projection.groups.find(
      ({ addressNormalized }) => addressNormalized.includes('南山区'),
    );
    expect(nanShanGroup).toMatchObject({
      phone: '13800000001',
      phoneNormalized: '13800000001',
      addressOriginal: '广东省深圳市南山区海风路1号',
      addressNormalized: '广东省深圳市南山区海风路1号',
      recipients: ['林青', '林青（公司）'],
      recipientConflict: true,
      orderCount: 2,
      totalQuantity: 5,
      totalAmountCents: 4_000,
      orders: [
        expect.objectContaining({
          orderNumber: 'XY-SHIPMENT-0001',
          amountCents: 2_000,
        }),
        expect.objectContaining({
          orderNumber: 'XY-SHIPMENT-0002',
          amountCents: 2_000,
        }),
      ],
      items: expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: '亚麻收纳袋',
          sourceSpec: '米白 大号',
          quantity: 3,
          subtotalCents: 3_000,
        }),
        expect.objectContaining({
          sourceTitle: '标签贴',
          sourceSpec: '透明',
          quantity: 2,
          subtotalCents: 1_000,
        }),
      ]),
    });
    expect(nanShanGroup?.id).toMatch(/^shipment-group-[a-f0-9]{24}$/u);
    expect(nanShanGroup?.id).not.toContain('13800000001');
    expect(nanShanGroup?.id).not.toContain('南山区');
    expect(new Set(projection.groups.flatMap((group) => (
      group.orders.map((order) => order.id)
    ))).size).toBe(3);
  });

  it('只投影正常待发货订单，缺少匹配信息时给出提示', async () => {
    const recognitions = [
      recognition({ orderNumber: 'XY-ELIGIBLE-PAID' }),
      recognition({
        orderNumber: 'XY-ELIGIBLE-UNKNOWN',
        platformTransactionStatus: 'unknown',
      }),
      recognition({
        orderNumber: 'XY-ELIGIBLE-SINGLE',
        phone: '13800000002',
        phoneNormalized: '13800000002',
      }),
      recognition({
        orderNumber: 'XY-INELIGIBLE-CANCELLED',
        platformTransactionStatus: 'cancelled',
      }),
      recognition({
        orderNumber: 'XY-INELIGIBLE-REFUNDED',
        platformTransactionStatus: 'refunded',
      }),
      recognition({
        orderNumber: 'XY-INELIGIBLE-SHIPPED',
        fulfillmentStatus: 'shipped',
      }),
      recognition({ orderNumber: 'XY-INELIGIBLE-TRASHED' }),
      recognition({ orderNumber: 'XY-ATTENTION-PHONE' }),
      recognition({ orderNumber: 'XY-ATTENTION-ADDRESS' }),
      recognition({ orderNumber: 'XY-ATTENTION-BOTH' }),
    ];
    const { application, dataDirectory } = await createApplicationWithOrders(recognitions);
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      database.prepare(`
        UPDATE original_orders SET lifecycle_status = 'trashed'
        WHERE platform_order_number = 'XY-INELIGIBLE-TRASHED'
      `).run();
      database.prepare(`
        UPDATE original_orders SET phone = '', phone_normalized = ''
        WHERE platform_order_number = 'XY-ATTENTION-PHONE'
      `).run();
      database.prepare(`
        UPDATE original_orders SET address_original = '', address_normalized = ''
        WHERE platform_order_number = 'XY-ATTENTION-ADDRESS'
      `).run();
      database.prepare(`
        UPDATE original_orders
        SET phone = '', phone_normalized = '', address_original = '', address_normalized = ''
        WHERE platform_order_number = 'XY-ATTENTION-BOTH'
      `).run();
    } finally {
      database.close();
    }

    const projection = application.queryShipmentGroups();

    expect(projection.groups).toHaveLength(2);
    expect(projection.groups.map(({ orderCount }) => orderCount).sort()).toEqual([1, 2]);
    expect(projection.groups.flatMap(({ orders }) => (
      orders.map(({ orderNumber }) => orderNumber)
    )).sort()).toEqual([
      'XY-ELIGIBLE-PAID',
      'XY-ELIGIBLE-SINGLE',
      'XY-ELIGIBLE-UNKNOWN',
    ]);
    expect(projection.attentionOrders).toEqual([
      expect.objectContaining({
        orderNumber: 'XY-ATTENTION-ADDRESS',
        reasons: ['missing_address'],
      }),
      expect.objectContaining({
        orderNumber: 'XY-ATTENTION-BOTH',
        reasons: ['missing_phone', 'missing_address'],
      }),
      expect.objectContaining({
        orderNumber: 'XY-ATTENTION-PHONE',
        reasons: ['missing_phone'],
      }),
    ]);
    expect(JSON.stringify(projection)).not.toContain('XY-INELIGIBLE-CANCELLED');
    expect(JSON.stringify(projection)).not.toContain('XY-INELIGIBLE-REFUNDED');
    expect(JSON.stringify(projection)).not.toContain('XY-INELIGIBLE-SHIPPED');
    expect(JSON.stringify(projection)).not.toContain('XY-INELIGIBLE-TRASHED');
  });

  it('随订单修改、取消或退款重新计算开放组和汇总', async () => {
    const { application } = await createApplicationWithOrders([
      recognition({ orderNumber: 'XY-DYNAMIC-0001' }),
      recognition({ orderNumber: 'XY-DYNAMIC-0002' }),
    ]);
    const orders = application.listOrders();
    const first = application.getOrder(
      orders.find(({ orderNumber }) => orderNumber === 'XY-DYNAMIC-0001')!.id,
    ).order;
    const second = application.getOrder(
      orders.find(({ orderNumber }) => orderNumber === 'XY-DYNAMIC-0002')!.id,
    ).order;
    const initial = application.queryShipmentGroups();
    expect(initial.groups).toMatchObject([{
      orderCount: 2,
      totalQuantity: 4,
      totalAmountCents: 4_000,
    }]);
    const stableGroupId = initial.groups[0].id;

    const changedSummary = application.confirmOrderEdit({
      ...orderEditInput(second),
      productTotalCents: 3_000,
      amountCents: 3_000,
      items: second.items.map((item) => ({
        id: item.id,
        sourceTitle: item.sourceTitle,
        sourceSpec: item.sourceSpec,
        unitPriceCents: item.unitPriceCents,
        quantity: 3,
      })),
    }).order;
    expect(application.queryShipmentGroups().groups).toMatchObject([{
      id: stableGroupId,
      orderCount: 2,
      totalQuantity: 5,
      totalAmountCents: 5_000,
    }]);

    const moved = application.confirmOrderEdit({
      ...orderEditInput(changedSummary),
      addressOriginal: '广东省深圳市福田区新风路2号',
      province: '广东省',
      city: '深圳市',
      district: '福田区',
    }).order;
    const afterMove = application.queryShipmentGroups();
    expect(afterMove.groups).toHaveLength(2);
    expect(afterMove.groups.map(({ orderCount }) => orderCount)).toEqual([1, 1]);
    expect(afterMove.groups.find((group) => group.orders.some(({ id }) => id === moved.id))?.id)
      .not.toBe(stableGroupId);

    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: moved.id, expectedRevision: moved.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });
    expect(application.queryShipmentGroups().groups).toMatchObject([{
      orderCount: 1,
      orders: [{ id: first.id }],
    }]);

    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: first.id, expectedRevision: first.revision }],
      patch: { platformTransactionStatus: 'refunded' },
    });
    expect(application.queryShipmentGroups()).toEqual({
      groups: [],
      attentionOrders: [],
    });
  });
});
