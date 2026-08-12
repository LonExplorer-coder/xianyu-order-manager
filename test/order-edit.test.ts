import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type {
  OrderEditInput,
  OriginalOrder,
  RecognitionResult,
  Recognizer,
} from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
import { reviewOrderEdit } from '../src/core/order-edit';

const openedApplications: LocalApplication[] = [];

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('已入库原始订单人工修改', () => {
  it('修改当前值和多商品时先预览差异，再原子保存并保留不可变来源', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-manual-order-edit-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '已发货订单.png');
    await writeFile(sourcePath, Buffer.from('manual-order-edit-source'));
    const recognition = completeRecognition('XY-MANUAL-EDIT-0001');
    const recognizer = new ControlledRecognizer(recognition);
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);

    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const original = application.confirmDraft(draft);
    const before = application.getOrder(original.id);
    const firstItemId = before.order.items[0].id;

    const input: OrderEditInput = {
      orderId: original.id,
      expectedRevision: original.revision,
      identityCorrection: null,
      alipayTransactionNumber: 'ALI-MANUAL-EDIT-CHANGED',
      buyerNickname: '人工修正买家',
      recipient: '人工修正收件人',
      phone: '13900000002',
      addressOriginal: '浙江省杭州市西湖区安全路2号',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      orderedAtOriginal: '2026-07-30 09:10:11',
      paidAtOriginal: '2026-07-30 09:10:20',
      productTotalCents: 2_400,
      shippingFeeCents: 100,
      amountCents: 2_500,
      note: '人工备注：优先联系',
      items: [
        {
          id: firstItemId,
          sourceTitle: '人工修正商品 A',
          sourceSpec: '蓝色',
          unitPriceCents: 800,
          quantity: 2,
        },
        {
          id: null,
          sourceTitle: '人工新增商品 C',
          sourceSpec: '大号',
          unitPriceCents: 800,
          quantity: 1,
        },
      ],
    };

    const review = application.reviewOrderEdit(input);
    expect(review).toMatchObject({
      orderId: original.id,
      expectedRevision: 1,
      shippedSnapshotWarning: true,
    });
    for (const fulfillmentStatus of ['partially_shipped', 'delivered'] as const) {
      expect(reviewOrderEdit(
        { ...before.order, fulfillmentStatus },
        input,
      ).shippedSnapshotWarning).toBe(true);
    }
    expect(review.changes).toEqual(expect.arrayContaining([
      { path: 'buyerNickname', before: '原买家', after: '人工修正买家' },
      { path: 'note', before: '', after: '人工备注：优先联系' },
      { path: 'items[0].sourceTitle', before: '原商品 A', after: '人工修正商品 A' },
      { path: 'items[1]', before: null, after: expect.objectContaining({
        sourceTitle: '人工新增商品 C',
      }) },
      { path: 'items.removed[1]', before: expect.objectContaining({
        sourceTitle: '原商品 B',
      }), after: null },
    ]));

    const saved = application.confirmOrderEdit(review.input);
    expect(saved.order).toMatchObject({
      revision: 2,
      buyerNickname: '人工修正买家',
      recipient: '人工修正收件人',
      phone: '13900000002',
      phoneNormalized: '13900000002',
      addressOriginal: '浙江省杭州市西湖区安全路2号',
      addressNormalized: '浙江省杭州市西湖区安全路2号',
      orderedAtNormalized: '2026-07-30T09:10:11+08:00',
      paidAtNormalized: '2026-07-30T09:10:20+08:00',
      note: '人工备注：优先联系',
    });
    expect(saved.order.items).toHaveLength(2);
    expect(saved.order.items[0]).toMatchObject({
      id: firstItemId,
      sourceTitle: '人工修正商品 A',
      quantity: 2,
      quantitySource: 'ocr_explicit',
    });
    expect(saved.order.items[1]).toMatchObject({
      sourceTitle: '人工新增商品 C',
      quantitySource: 'manual',
    });
    expect(saved.changeEvents[0]).toMatchObject({
      source: 'manual_edit',
      sourceSnapshotId: null,
      baseRevision: 1,
      resultRevision: 2,
      changes: expect.arrayContaining(review.changes),
    });
    expect(saved.changeEvents[0].changes).toHaveLength(review.changes.length);
    expect(saved.lastManualEditAt).toBe(saved.changeEvents[0].createdAt);
    expect(saved.sourceSnapshot).toEqual(before.sourceSnapshot);
    expect(saved.sources).toEqual(before.sources);
    expect(application.getRecognitionEvidence(before.sourceScreenshot.id)).toMatchObject({
      rawResponse: expect.stringContaining('XY-MANUAL-EDIT-0001'),
    });
    expect(application.queryOrders({ text: '优先联系' }).orders).toHaveLength(1);
    expect(application.queryOrders({ buyerText: '人工修正买家' }).orders[0])
      .toMatchObject({ buyerNickname: '人工修正买家', note: '人工备注：优先联系' });

    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);
    const reopened = new LocalApplication(recognizer);
    openedApplications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    expect(reopened.getOrder(original.id)).toMatchObject({
      order: { revision: 2, recipient: '人工修正收件人', note: '人工备注：优先联系' },
      lastManualEditAt: saved.lastManualEditAt,
      changeEvents: [{
        source: 'manual_edit',
        changes: expect.arrayContaining(review.changes),
      }],
      sourceSnapshot: before.sourceSnapshot,
    });
  });

  it('只通过显式身份更正修改订单身份，且冲突时不覆盖另一笔订单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-identity-edit-'));
    const firstPath = join(root, '订单一.png');
    const secondPath = join(root, '订单二.png');
    await writeFile(firstPath, Buffer.from('identity-edit-first'));
    await writeFile(secondPath, Buffer.from('identity-edit-second'));
    const recognitions = [
      completeRecognition('XY-IDENTITY-EDIT-0001'),
      {
        ...completeRecognition('XY-IDENTITY-EDIT-0002'),
        sellerAccount: '第二卖家账号',
        recipient: '第二收件人',
      },
    ];
    const recognizer: Recognizer = {
      recognize: async () => {
        const result = recognitions.shift();
        if (!result) throw new Error('测试识别结果已用尽');
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
      },
    };
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const [firstDraft] = (await application.submitRecognitionBatch([firstPath])).drafts;
    const first = application.confirmDraft(firstDraft);
    const [secondDraft] = (await application.submitRecognitionBatch([secondPath])).drafts;
    const second = application.confirmDraft(secondDraft);
    const beforeFirst = application.getOrder(first.id);
    const beforeSecond = application.getOrder(second.id);

    expect(() => application.reviewOrderEdit({
      ...orderEditInput(first),
      identityCorrection: {
        platform: 'xianyu',
        sellerAccount: ` ${second.sellerAccount} `,
        orderNumber: second.orderNumber,
      },
    })).toThrowError('订单身份与另一笔已有订单冲突，请更正后重试');
    expect(application.getOrder(first.id)).toEqual(beforeFirst);
    expect(application.getOrder(second.id)).toEqual(beforeSecond);

    expect(() => application.reviewOrderEdit({
      ...orderEditInput(first),
      sellerAccount: '伪装的顶层账号',
    } as OrderEditInput)).toThrowError(/包含未知字段：sellerAccount/);

    const correctedInput: OrderEditInput = {
      ...orderEditInput(first),
      identityCorrection: {
        platform: 'xianyu',
        sellerAccount: '更正后卖家账号',
        orderNumber: 'XY-IDENTITY-CORRECTED-0001',
      },
    };
    const review = application.reviewOrderEdit(correctedInput);
    expect(review.changes).toEqual(expect.arrayContaining([
      {
        path: 'sellerAccount',
        before: first.sellerAccount,
        after: '更正后卖家账号',
      },
      {
        path: 'orderNumber',
        before: first.orderNumber,
        after: 'XY-IDENTITY-CORRECTED-0001',
      },
    ]));
    const corrected = application.confirmOrderEdit(review.input);
    expect(corrected.order).toMatchObject({
      sellerAccount: '更正后卖家账号',
      orderNumber: 'XY-IDENTITY-CORRECTED-0001',
      revision: 2,
    });
    expect(corrected.sourceSnapshot).toEqual(beforeFirst.sourceSnapshot);
    expect(application.getOrder(second.id)).toEqual(beforeSecond);
  });

  it('保留未删商品的自定义字段，并在同一事务内校验和写入新商品字段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-edit-custom-fields-'));
    const sourcePath = join(root, '自定义字段订单.png');
    await writeFile(sourcePath, Buffer.from('order-edit-custom-fields'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-EDIT-CUSTOM-FIELDS-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);
    const [firstItem, secondItem] = order.items;
    const tag = application.createCustomFieldDefinition({
      name: '商品标记',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    const warehouse = application.createCustomFieldDefinition({
      name: '仓位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: '默认仓',
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [],
      itemValues: [
        { definitionId: tag.id, orderItemId: firstItem.id, value: 'A-保留' },
        { definitionId: tag.id, orderItemId: secondItem.id, value: 'B-将删除' },
      ],
    });
    const before = application.getOrder(order.id);
    const firstTagBefore = before.customFieldValues.find((value) => (
      value.definitionId === tag.id && value.orderItemId === firstItem.id
    ));

    const baseInput = orderEditInput(before.order);
    const input: OrderEditInput = {
      ...baseInput,
      items: [
        baseInput.items[0],
        {
          id: null,
          sourceTitle: '新增带字段商品',
          sourceSpec: '标准款',
          unitPriceCents: 800,
          quantity: 1,
          customFieldValues: [{ definitionId: tag.id, value: 'C-新值' }],
        },
      ],
    };
    expect(() => application.reviewOrderEdit({
      ...input,
      items: input.items.map((item) => (
        item.id === null ? { ...item, customFieldValues: [] } : item
      )),
    })).toThrowError('新增商品缺少必填自定义字段“商品标记”');
    expect(application.getOrder(order.id)).toEqual(before);

    const review = application.reviewOrderEdit(input);
    expect(review.changes).toEqual(expect.arrayContaining([
      {
        path: 'items[1]',
        before: null,
        after: expect.objectContaining({
          sourceTitle: '新增带字段商品',
          customFieldValues: expect.arrayContaining([
            { definitionId: tag.id, value: 'C-新值' },
            { definitionId: warehouse.id, value: '默认仓' },
          ]),
        }),
      },
      {
        path: 'items.removed[1]',
        before: expect.objectContaining({
          sourceTitle: '原商品 B',
          customFieldValues: expect.arrayContaining([
            { definitionId: tag.id, value: 'B-将删除' },
            { definitionId: warehouse.id, value: '默认仓' },
          ]),
        }),
        after: null,
      },
    ]));
    const saved = application.confirmOrderEdit(review.input);
    const addedItem = saved.order.items.find((item) => (
      item.sourceTitle === '新增带字段商品'
    ));
    expect(addedItem).toBeDefined();
    expect(saved.customFieldValues).toEqual(expect.arrayContaining([
      firstTagBefore,
      expect.objectContaining({
        definitionId: tag.id,
        orderItemId: addedItem?.id,
        value: 'C-新值',
      }),
      expect.objectContaining({
        definitionId: warehouse.id,
        orderItemId: addedItem?.id,
        value: '默认仓',
      }),
    ]));
    expect(saved.customFieldValues.some((value) => value.orderItemId === secondItem.id)).toBe(false);
    expect(saved.changeEvents[0].changes).toEqual(expect.arrayContaining(review.changes));
  });

  it('无变化、取消和非法输入零写入，过期版本不会覆盖先保存的修改', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-edit-guards-'));
    const sourcePath = join(root, '竞争修改订单.png');
    await writeFile(sourcePath, Buffer.from('order-edit-guards'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-EDIT-GUARDS-0001')),
    );
    openedApplications.push(application);
    const dataDirectory = join(root, '数据');
    application.openDataDirectory(dataDirectory);
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);
    const before = application.getOrder(order.id);
    const unchanged = orderEditInput(order);

    expect(application.reviewOrderEdit(unchanged).changes).toEqual([]);
    expect(application.confirmOrderEdit(unchanged)).toEqual(before);

    const cancelledReview = application.reviewOrderEdit({
      ...unchanged,
      recipient: '未确认的收件人',
    });
    expect(cancelledReview.changes).toEqual(expect.arrayContaining([
      { path: 'recipient', before: '原收件人', after: '未确认的收件人' },
    ]));
    expect(application.getOrder(order.id)).toEqual(before);

    const invalidInputs: Array<{ input: OrderEditInput; message: RegExp }> = [
      {
        input: { ...unchanged, expectedRevision: '1' } as unknown as OrderEditInput,
        message: /订单版本必须为正整数/,
      },
      {
        input: { ...unchanged, phone: '13900000002复制' },
        message: /手机号格式无效/,
      },
      {
        input: { ...unchanged, province: '浙江省' },
        message: /省市区与完整收货地址不一致/,
      },
      {
        input: { ...unchanged, paidAtOriginal: '2026-07-30 07:59:59' },
        message: /付款时间不能早于下单时间/,
      },
      {
        input: { ...unchanged, amountCents: 1.5 },
        message: /成交金额必须使用非负整数分/,
      },
      {
        input: { ...unchanged, items: [] },
        message: /至少需要一项商品/,
      },
      {
        input: {
          ...unchanged,
          items: [{ ...unchanged.items[0], id: 'another-order-item-id' }],
        },
        message: /不属于当前订单/,
      },
      {
        input: { ...unchanged, items: [...unchanged.items].reverse() },
        message: /不支持调整已有商品顺序/,
      },
    ];
    for (const invalid of invalidInputs) {
      expect(() => application.confirmOrderEdit(invalid.input)).toThrowError(invalid.message);
      expect(application.getOrder(order.id)).toEqual(before);
    }

    const failureDatabase = new DatabaseSync(join(
      dataDirectory,
      'xianyu-order-manager.sqlite3',
    ));
    try {
      failureDatabase.exec(`
        CREATE TRIGGER force_manual_item_update_failure
        BEFORE UPDATE OF source_title ON order_items
        BEGIN
          SELECT RAISE(ABORT, 'forced manual item update failure');
        END;
      `);
      expect(() => application.confirmOrderEdit({
        ...unchanged,
        recipient: '事务中不应留下的收件人',
        items: unchanged.items.map((item, index) => (
          index === 0 ? { ...item, sourceTitle: '事务中不应留下的商品' } : item
        )),
      })).toThrowError('forced manual item update failure');
    } finally {
      failureDatabase.exec('DROP TRIGGER IF EXISTS force_manual_item_update_failure;');
      failureDatabase.close();
    }
    expect(application.getOrder(order.id)).toEqual(before);

    const firstSaveInput: OrderEditInput = {
      ...unchanged,
      recipient: '第一个保存的收件人',
    };
    const staleInput: OrderEditInput = {
      ...unchanged,
      buyerNickname: '过期页面的买家',
    };
    const firstSaved = application.confirmOrderEdit(firstSaveInput);
    expect(firstSaved.order).toMatchObject({
      revision: 2,
      recipient: '第一个保存的收件人',
      buyerNickname: '原买家',
    });
    expect(() => application.confirmOrderEdit(staleInput)).toThrowError(
      '订单已在其他操作中更新，请刷新后重试',
    );
    const afterStaleAttempt = application.getOrder(order.id);
    expect(afterStaleAttempt.order).toMatchObject({
      revision: 2,
      recipient: '第一个保存的收件人',
      buyerNickname: '原买家',
    });
    expect(afterStaleAttempt.changeEvents).toHaveLength(1);
    expect(afterStaleAttempt.sourceSnapshot).toEqual(before.sourceSnapshot);
  });

  it('历史空金额在编辑草稿中保持为空，未由用户补齐时拒绝保存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-edit-null-money-'));
    const sourcePath = join(root, '历史空金额订单.png');
    await writeFile(sourcePath, Buffer.from('order-edit-null-money'));
    const application = new LocalApplication(new ControlledRecognizer(
      completeRecognition('XY-EDIT-NULL-MONEY-0001'),
    ));
    openedApplications.push(application);
    const dataDirectory = join(root, '数据');
    application.openDataDirectory(dataDirectory);
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      database.prepare(`
        UPDATE original_orders
        SET product_total_cents = NULL, shipping_fee_cents = NULL
        WHERE id = ?
      `).run(order.id);
    } finally {
      database.close();
    }
    const before = application.getOrder(order.id);
    const input: OrderEditInput = {
      ...orderEditInput(order),
      recipient: '只想修改收件人',
      productTotalCents: null,
      shippingFeeCents: null,
    };

    expect(() => application.reviewOrderEdit(input))
      .toThrowError('商品总价必须使用非负整数分');
    expect(application.getOrder(order.id)).toEqual(before);
    expect(() => application.confirmOrderEdit({
      ...input,
      productTotalCents: 0,
    })).toThrowError('运费必须使用非负整数分');
    expect(application.getOrder(order.id)).toEqual(before);

    const saved = application.confirmOrderEdit({
      ...input,
      productTotalCents: 0,
      shippingFeeCents: 0,
    });
    expect(saved.order).toMatchObject({
      revision: 2,
      recipient: '只想修改收件人',
      productTotalCents: 0,
      shippingFeeCents: 0,
    });
    expect(saved.changeEvents[0].changes).toEqual(expect.arrayContaining([
      { path: 'productTotalCents', before: null, after: 0 },
      { path: 'shippingFeeCents', before: null, after: 0 },
    ]));
  });
});

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

function completeRecognition(orderNumber: string): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '原卖家账号',
    orderNumber,
    alipayTransactionNumber: 'ALI-MANUAL-EDIT-ORIGINAL',
    buyerNickname: '原买家',
    recipient: '原收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-07-30 08:00:00',
    orderedAtNormalized: '2026-07-30T08:00:00+08:00',
    paidAtOriginal: '2026-07-30 08:00:08',
    paidAtNormalized: '2026-07-30T08:00:08+08:00',
    productTotalCents: 2_400,
    shippingFeeCents: 100,
    amountCents: 2_500,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'shipped',
    items: [
      {
        sourceTitle: '原商品 A',
        sourceSpec: '白色',
        unitPriceCents: 800,
        quantity: 2,
        quantityInferred: false,
      },
      {
        sourceTitle: '原商品 B',
        sourceSpec: '标准款',
        unitPriceCents: 800,
        quantity: 1,
        quantityInferred: true,
      },
    ],
  };
}
