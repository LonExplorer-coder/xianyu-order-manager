import { mkdtemp, writeFile } from 'node:fs/promises';
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
import { Workspace } from '../src/main/workspace';

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

const openedApplications: LocalApplication[] = [];

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('收件人注册表', () => {
  it('入库与编辑自动建档发号，编号只增不复用', async () => {
    const application = await createApplication([
      recognition('XY-RECIPIENT-0001', '张三', '13900000001'),
      recognition('XY-RECIPIENT-0002', '李四', '13900000002'),
    ]);
    expect(application.instance.queryRecipients()).toEqual([
      expect.objectContaining({
        recipientNumber: 1,
        name: '张三',
        phoneNormalized: '13900000001',
        displayName: null,
      }),
      expect.objectContaining({
        recipientNumber: 2,
        name: '李四',
        phoneNormalized: '13900000002',
        displayName: null,
      }),
    ]);

    const order = findOrder(application.instance, 'XY-RECIPIENT-0002');
    application.instance.confirmOrderEdit({
      ...orderEditInput(order),
      recipient: '王五',
      phone: '13900000003',
    });
    expect(application.instance.queryRecipients()).toHaveLength(3);
    expect(application.instance.queryRecipients()[2]).toMatchObject({
      recipientNumber: 3,
      name: '王五',
      phoneNormalized: '13900000003',
    });

    const edited = application.instance.getOrder(order.id).order;
    application.instance.confirmOrderEdit({
      ...orderEditInput(edited),
      recipient: '李四',
      phone: '13900000002',
    });
    expect(application.instance.queryRecipients()).toHaveLength(3);
  });

  it('合并收件人：编号与显示名分开存续，订单归入存续方，已合并行不可再并', async () => {
    const application = await createApplication([
      recognition('XY-RECIPIENT-M01', '张三', '13900000011'),
      recognition('XY-RECIPIENT-M02', '李四', '13900000012'),
      recognition('XY-RECIPIENT-M03', '王五', '13900000013'),
    ]);
    const zhangsanOrder = findOrder(application.instance, 'XY-RECIPIENT-M01');
    const lisiOrder = findOrder(application.instance, 'XY-RECIPIENT-M02');
    const wangwuOrder = findOrder(application.instance, 'XY-RECIPIENT-M03');
    const [zhangsan, lisi, wangwu] = application.instance.queryRecipients();
    expect([zhangsan.recipientNumber, lisi.recipientNumber, wangwu.recipientNumber])
      .toEqual([1, 2, 3]);
    const app = backdateAndReopen(application, [
      [zhangsanOrder.id, '2026-08-05T01:00:00.000Z'],
      [lisiOrder.id, '2026-08-05T02:00:00.000Z'],
      [wangwuOrder.id, '2026-08-05T03:00:00.000Z'],
    ]);

    expect(() => app.mergeRecipients({
      sourceRecipientId: lisi.id,
      targetRecipientId: zhangsan.id,
      keepNameFrom: 'source',
      reason: ' ',
    })).toThrow('请填写非空原因');
    expect(() => app.mergeRecipients({
      sourceRecipientId: zhangsan.id,
      targetRecipientId: zhangsan.id,
      keepNameFrom: 'source',
      reason: '同一收件人',
    })).toThrow('不能将收件人合并到其自身');

    app.mergeRecipients({
      sourceRecipientId: lisi.id,
      targetRecipientId: zhangsan.id,
      keepNameFrom: 'source',
      reason: '同一买家两个手机号',
    });
    const afterMerge = app.queryRecipients();
    const target = afterMerge.find(({ id }) => id === zhangsan.id);
    const source = afterMerge.find(({ id }) => id === lisi.id);
    expect(target).toMatchObject({
      recipientNumber: 1,
      name: '张三',
      displayName: '李四',
      mergedIntoRecipientId: null,
    });
    expect(source).toMatchObject({
      recipientNumber: 2,
      mergedIntoRecipientId: zhangsan.id,
      mergedReason: '同一买家两个手机号',
    });
    expect(source?.mergedAt).toBeTruthy();

    // 实时投影：李四订单改用存续方编号 001，当月次序按存续方全部订单重排为 02
    const lisiOrderNumber = app.readableOrderNumbers([lisiOrder.id])[lisiOrder.id];
    expect(lisiOrderNumber).toBe('260802-001-PT');

    expect(() => app.mergeRecipients({
      sourceRecipientId: lisi.id,
      targetRecipientId: wangwu.id,
      keepNameFrom: 'source',
      reason: '重复合并来源',
    })).toThrow('收件人已合并，不能再次合并');
    expect(() => app.mergeRecipients({
      sourceRecipientId: wangwu.id,
      targetRecipientId: lisi.id,
      keepNameFrom: 'source',
      reason: '并入已合并行',
    })).toThrow('收件人已合并，不能再次合并');

    app.mergeRecipients({
      sourceRecipientId: wangwu.id,
      targetRecipientId: zhangsan.id,
      keepNameFrom: 'target',
      reason: '又一个手机号',
    });
    const afterSecond = app.queryRecipients();
    expect(afterSecond.find(({ id }) => id === zhangsan.id)).toMatchObject({
      displayName: '李四',
      mergedIntoRecipientId: null,
    });
    expect(afterSecond.find(({ id }) => id === wangwu.id)).toMatchObject({
      mergedIntoRecipientId: zhangsan.id,
      mergedReason: '又一个手机号',
    });

    const reopened = reopen(app, application.dataDirectory);
    expect(reopened.queryRecipients()).toEqual(afterSecond);
    expect(reopened.readableOrderNumbers([lisiOrder.id])[lisiOrder.id])
      .toBe(lisiOrderNumber);
  });

  it('现货编号按收件人当月次序派生，取消订单占号，收件信息不全为空', async () => {
    const application = await createApplication([
      recognition('XY-RECIPIENT-S01', '张三', '13900000021'),
      recognition('XY-RECIPIENT-S02', '张三', '13900000021'),
      recognition('XY-RECIPIENT-S03', '张三', '13900000021'),
      recognition('XY-RECIPIENT-S04', '李四', '13900000022'),
    ]);
    const first = findOrder(application.instance, 'XY-RECIPIENT-S01');
    const second = findOrder(application.instance, 'XY-RECIPIENT-S02');
    const third = findOrder(application.instance, 'XY-RECIPIENT-S03');
    const other = findOrder(application.instance, 'XY-RECIPIENT-S04');
    const app = backdateAndReopen(application, [
      [first.id, '2026-08-05T01:00:00.000Z'],
      [second.id, '2026-08-05T02:00:00.000Z'],
      [third.id, '2026-08-05T03:00:00.000Z'],
      [other.id, '2026-08-05T04:00:00.000Z'],
    ]);
    app.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: second.id, expectedRevision: second.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });

    const numbers = app.readableOrderNumbers(
      [first.id, second.id, third.id, other.id],
    );
    expect(numbers[first.id]).toBe('260801-001-PT');
    expect(numbers[second.id]).toBe('260802-001-PT');
    expect(numbers[third.id]).toBe('260803-001-PT');
    expect(numbers[other.id]).toBe('260801-002-PT');

    app.close();
    openedApplications.splice(openedApplications.indexOf(app), 1);
    const workspace = Workspace.open(application.dataDirectory);
    try {
      workspace.database.prepare(`
        UPDATE original_orders SET phone = '', phone_normalized = '' WHERE id = ?
      `).run(other.id);
    } finally {
      workspace.close();
    }
    const reopened = new LocalApplication(new SequenceRecognizer([]));
    openedApplications.push(reopened);
    reopened.openDataDirectory(application.dataDirectory);
    expect(reopened.readableOrderNumbers([other.id])[other.id]).toBeNull();
    expect(reopened.readableOrderNumbers([first.id])[first.id]).toBe(numbers[first.id]);
  });
});

async function createApplication(results: RecognitionResult[]) {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-recipient-registry-'));
  const dataDirectory = join(root, '数据');
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);
  const sourcePaths: string[] = [];
  for (const [index] of results.entries()) {
    const sourcePath = join(root, `订单-${index + 1}.png`);
    await writeFile(sourcePath, Buffer.from(`recipient-registry-${index + 1}`));
    sourcePaths.push(sourcePath);
  }
  const drafts = (await application.submitRecognitionBatch(sourcePaths)).drafts;
  for (const draft of drafts) application.confirmDraft(draft);
  return { instance: application, dataDirectory };
}

function backdateAndReopen(
  application: { instance: LocalApplication; dataDirectory: string },
  backdates: ReadonlyArray<readonly [string, string]>,
): LocalApplication {
  application.instance.close();
  openedApplications.splice(openedApplications.indexOf(application.instance), 1);
  const workspace = Workspace.open(application.dataDirectory);
  try {
    const update = workspace.database.prepare(
      'UPDATE original_orders SET created_at = ? WHERE id = ?',
    );
    for (const [orderId, createdAt] of backdates) update.run(createdAt, orderId);
  } finally {
    workspace.close();
  }
  const reopened = new LocalApplication(new SequenceRecognizer([]));
  openedApplications.push(reopened);
  reopened.openDataDirectory(application.dataDirectory);
  return reopened;
}

function reopen(application: LocalApplication, dataDirectory: string): LocalApplication {
  application.close();
  openedApplications.splice(openedApplications.indexOf(application), 1);
  const reopened = new LocalApplication(new SequenceRecognizer([]));
  openedApplications.push(reopened);
  reopened.openDataDirectory(dataDirectory);
  return reopened;
}

function findOrder(application: LocalApplication, orderNumber: string): OriginalOrder {
  const summary = application.listOrders().find((order) => order.orderNumber === orderNumber);
  if (!summary) throw new Error(`测试订单不存在：${orderNumber}`);
  return application.getOrder(summary.id).order;
}

function recognition(
  orderNumber: string,
  recipient: string,
  phone: string,
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient,
    phone,
    phoneNormalized: phone,
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-03 08:00:00',
    orderedAtNormalized: '2026-08-03T08:00:00+08:00',
    paidAtOriginal: '2026-08-03 08:00:08',
    paidAtNormalized: '2026-08-03T08:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '测试商品',
      sourceSpec: '标准款',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: false,
    }],
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
