import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import type {
  FinancePendingItemView,
  FinanceRecordView,
  FundsView,
} from '../src/core/funds';
import type { LocalApplication } from '../src/main/local-application';
import { LocalApplication as LocalApplicationClass } from '../src/main/local-application';
import type { Workspace } from '../src/main/workspace';
import { Workspace as WorkspaceClass } from '../src/main/workspace';

const openedApplications: LocalApplication[] = [];
const openedWorkspaces: Workspace[] = [];

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

function fundsOrderRecognition(orderNumber: string): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '资金事实测试账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '资金测试买家',
    recipient: '资金收件人',
    phone: '13900000002',
    phoneNormalized: '13900000002',
    addressOriginal: '广东省深圳市南山区资金路2号',
    addressNormalized: '广东省深圳市南山区资金路2号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-20 08:00:00',
    orderedAtNormalized: '2026-08-20T08:00:00+08:00',
    paidAtOriginal: '2026-08-20 08:00:08',
    paidAtNormalized: '2026-08-20T08:00:08+08:00',
    productTotalCents: 10000,
    shippingFeeCents: 0,
    amountCents: 10000,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '资金测试商品',
      sourceSpec: '标准款',
      unitPriceCents: 10000,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}

async function openFundsApplication(orderCount = 1): Promise<{
  application: LocalApplication;
  orderIds: string[];
  dataDirectory: string;
}> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-20T02:00:00.000Z'));
  const root = await mkdtemp(join(tmpdir(), 'xianyu-funds-facts-'));
  const sourceDirectory = join(root, '上传');
  await mkdir(sourceDirectory, { recursive: true });
  const recognitions = Array.from({ length: orderCount }, (_unused, index) => (
    fundsOrderRecognition(`XY-FUNDS-${String(index + 1).padStart(4, '0')}`)
  ));
  const application = new LocalApplicationClass(new SequenceRecognizer(recognitions));
  openedApplications.push(application);
  const dataDirectory = join(root, '数据');
  application.openDataDirectory(dataDirectory);
  const orderIds: string[] = [];
  for (let index = 0; index < orderCount; index += 1) {
    const sourcePath = join(sourceDirectory, `订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`funds-source-${index}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    const order = application.confirmDraft(batch.drafts[0]!);
    orderIds.push(order.id);
  }
  return { application, orderIds, dataDirectory };
}

function pendingRefundInput(orderId: string, amountCents = 1000) {
  return {
    type: 'refund',
    amountCents,
    sourceType: 'order',
    sourceId: orderId,
    note: '买家申请退款，等平台转账',
    occurredAt: '2026-08-20T09:00:00+08:00',
  };
}

function recordOf(view: FundsView, index: number): FinanceRecordView {
  const record = view.records[index];
  if (!record) throw new Error(`测试未找到第 ${index + 1} 笔资金记录`);
  return record;
}

function pendingOf(view: FundsView, index = 0): FinancePendingItemView {
  const item = view.pendingItems[index];
  if (!item) throw new Error(`测试未找到第 ${index + 1} 条待确认事项`);
  return item;
}

afterEach(() => {
  while (openedApplications.length > 0) {
    const application = openedApplications.pop();
    try {
      application!.close();
    } catch {
      // 已经关闭的应用直接跳过
    }
  }
  while (openedWorkspaces.length > 0) {
    const workspace = openedWorkspaces.pop();
    try {
      workspace!.close();
    } catch {
      // 已经关闭的工作区直接跳过
    }
  }
  vi.useRealTimers();
});

describe('资金事实：待确认事项与资金记录', () => {
  it('待确认事项与资金记录分开保存，确认前不产生任何资金记录', async () => {
    const { application, orderIds } = await openFundsApplication();
    const view = application.recordPendingFinanceItem(pendingRefundInput(orderIds[0]!));

    expect(view.pendingItems).toHaveLength(1);
    expect(view.records).toEqual([]);
    expect(view.totals).toEqual({
      incomeCents: 0,
      expenseCents: 0,
      netCents: 0,
      pendingRemainingCents: 1000,
    });
    const item = pendingOf(view);
    expect(item).toMatchObject({
      type: 'refund',
      direction: 'expense',
      amountCents: 1000,
      currency: 'CNY',
      status: 'pending',
      confirmedCents: 0,
      remainingCents: 1000,
      sourceType: 'order',
      sourceId: orderIds[0],
      note: '买家申请退款，等平台转账',
      occurredAt: '2026-08-20T09:00:00+08:00',
      cancelledAt: null,
      cancelReason: null,
    });
  });

  it('币种固定人民币、确认方式固定人工确认，多余字段与错向类型被拒绝', async () => {
    const { application, orderIds } = await openFundsApplication();
    expect(() => application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 980,
      currency: 'CNY',
      occurredAt: '2026-08-20T10:00:00+08:00',
      note: '平台结算到账',
    })).toThrow('资金记录参数无效');

    expect(() => application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'expense',
      amountCents: 980,
      occurredAt: '2026-08-20T10:00:00+08:00',
      note: '方向错误的结算',
    })).toThrow('平台实际结算收入的收支方向只能是收入');

    const view = application.recordFinanceRecord({
      type: 'misc_expense',
      direction: 'income',
      amountCents: 500,
      occurredAt: '2026-08-20T10:00:00+08:00',
      note: '买家补的差价补偿',
    });
    expect(recordOf(view, 0)).toMatchObject({
      currency: 'CNY',
      confirmedSource: 'manual_confirmation',
      direction: 'income',
    });
    void orderIds;
  });

  it('待确认事项不支持无来源的人工费用类型，来源记录必须真实存在', async () => {
    const { application, orderIds } = await openFundsApplication();
    expect(() => application.recordPendingFinanceItem({
      ...pendingRefundInput(orderIds[0]!),
      type: 'misc_expense',
    })).toThrow('其他人工费用或补偿直接录入资金记录，不建立待确认事项');

    expect(() => application.recordPendingFinanceItem({
      ...pendingRefundInput('不存在的订单'),
    })).toThrow('来源记录不存在');

    const purchases = application.createSupplier({
      name: '资金测试供应方',
      contact: '',
      note: '',
    });
    void purchases;
    expect(() => application.recordPendingFinanceItem({
      type: 'purchase_cost',
      amountCents: 6400,
      sourceType: 'purchase_order',
      sourceId: '不存在的采购订单',
      note: '采购立账',
      occurredAt: '2026-08-20T09:30:00+08:00',
    })).toThrow('来源记录不存在');
  });

  it('确认后资金记录保存类型、方向、金额、币种、时间、确认来源与关联业务', async () => {
    const { application, orderIds } = await openFundsApplication();
    const pending = application.recordPendingFinanceItem(pendingRefundInput(orderIds[0]!, 1000));
    const itemId = pendingOf(pending).id;

    const view = application.confirmPendingFinanceItem({
      pendingItemId: itemId,
      amountCents: 400,
      occurredAt: '2026-08-21T09:00:00+08:00',
      note: '平台先退 4 元',
    });
    const record = recordOf(view, 0);
    expect(record).toMatchObject({
      type: 'refund',
      direction: 'expense',
      amountCents: 400,
      currency: 'CNY',
      confirmedSource: 'manual_confirmation',
      occurredAt: '2026-08-21T09:00:00+08:00',
      pendingItemId: itemId,
      sourceType: 'order',
      sourceId: orderIds[0],
      reversesRecordId: null,
      note: '平台先退 4 元',
    });
    expect(record.confirmedAt).toBe('2026-08-20T02:00:00.000Z');
    expect(pendingOf(view)).toMatchObject({ confirmedCents: 400, remainingCents: 600, status: 'pending' });
  });

  it('支持部分确认，累计确认不能超过事项金额', async () => {
    const { application, orderIds } = await openFundsApplication();
    const pending = application.recordPendingFinanceItem(pendingRefundInput(orderIds[0]!, 1000));
    const itemId = pendingOf(pending).id;

    let view = application.confirmPendingFinanceItem({ pendingItemId: itemId, amountCents: 400 });
    view = application.confirmPendingFinanceItem({ pendingItemId: itemId, amountCents: 600 });
    expect(pendingOf(view)).toMatchObject({ confirmedCents: 1000, remainingCents: 0 });

    expect(() => application.confirmPendingFinanceItem({
      pendingItemId: itemId,
      amountCents: 1,
    })).toThrow('剩余可确认金额 0.00 元，不够确认 0.01 元');
    expect(recordOf(view, 0)).toBeTruthy();
  });

  it('取消只取消剩余待确认金额，已确认部分保留，且状态约束生效', async () => {
    const { application, orderIds } = await openFundsApplication();
    const pending = application.recordPendingFinanceItem(pendingRefundInput(orderIds[0]!, 800));
    const itemId = pendingOf(pending).id;

    let view = application.confirmPendingFinanceItem({ pendingItemId: itemId, amountCents: 300 });
    view = application.cancelPendingFinanceItem({
      pendingItemId: itemId,
      reason: '买家撤回了退款申请',
    });
    const item = pendingOf(view);
    expect(item).toMatchObject({
      status: 'cancelled',
      confirmedCents: 300,
      remainingCents: 0,
    });
    expect(item.cancelledAt).toBe('2026-08-20T02:00:00.000Z');
    expect(item.cancelReason).toBe('买家撤回了退款申请');
    expect(view.records).toHaveLength(1);

    expect(() => application.confirmPendingFinanceItem({
      pendingItemId: itemId,
      amountCents: 100,
    })).toThrow('该待确认事项已经取消');
    expect(() => application.cancelPendingFinanceItem({
      pendingItemId: itemId,
      reason: '重复取消',
    })).toThrow('该待确认事项已经取消');

    expect(() => application.cancelPendingFinanceItem({
      pendingItemId: '不存在的事项',
      reason: '无事此项',
    })).toThrow('待确认资金事项不存在');
  });

  it('冲正生成反向记录且不覆盖原记录，金额受未冲正余额约束', async () => {
    const { application } = await openFundsApplication();
    const created = application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 980,
      occurredAt: '2026-08-20T10:00:00+08:00',
      note: '平台结算到账',
    });
    const recordId = recordOf(created, 0).id;

    let view = application.reverseFinanceRecord({
      recordId,
      amountCents: 300,
      note: '平台多结了，退回 3 元',
    });
    expect(view.records).toHaveLength(2);
    expect(recordOf(view, 1)).toMatchObject({
      type: 'platform_settlement',
      direction: 'expense',
      amountCents: 300,
      reversesRecordId: recordId,
    });
    expect(recordOf(view, 0)).toMatchObject({ amountCents: 980, direction: 'income' });

    expect(() => application.reverseFinanceRecord({
      recordId,
      amountCents: 700,
      note: '冲正超出余额',
    })).toThrow('冲正金额超过原记录未冲正余额（未冲正 6.80 元）');

    view = application.reverseFinanceRecord({
      recordId,
      amountCents: 680,
      note: '剩余全部冲正',
    });
    expect(view.records).toHaveLength(3);
    const settlement = view.typeTotals.find((total) => total.type === 'platform_settlement')!;
    expect(settlement).toMatchObject({ incomeCents: 980, expenseCents: 980, netCents: 0 });
    expect(view.totals).toMatchObject({ incomeCents: 980, expenseCents: 980, netCents: 0 });
  });

  it('冲正经待确认事项确认的记录会把剩余可确认金额回补', async () => {
    const { application, orderIds } = await openFundsApplication();
    const pending = application.recordPendingFinanceItem(pendingRefundInput(orderIds[0]!, 1000));
    const itemId = pendingOf(pending).id;

    const confirmed = application.confirmPendingFinanceItem({ pendingItemId: itemId, amountCents: 400 });
    const recordId = recordOf(confirmed, 0).id;
    expect(pendingOf(confirmed).remainingCents).toBe(600);

    const view = application.reverseFinanceRecord({
      recordId,
      amountCents: 400,
      note: '确认金额录错，冲回重记',
    });
    expect(recordOf(view, 1)).toMatchObject({
      direction: 'income',
      pendingItemId: itemId,
      reversesRecordId: recordId,
    });
    expect(pendingOf(view)).toMatchObject({ confirmedCents: 0, remainingCents: 1000, status: 'pending' });
  });

  it('同一业务事实重复提交不产生重复待确认事项，不同类型与来源分开立账', async () => {
    const { application, orderIds } = await openFundsApplication(2);
    const [first, second] = orderIds;
    let view = application.recordPendingFinanceItem(pendingRefundInput(first!, 1000));
    view = application.recordPendingFinanceItem(pendingRefundInput(first!, 1000));
    expect(view.pendingItems).toHaveLength(1);
    expect(pendingOf(view).amountCents).toBe(1000);
    expect(view.totals.pendingRemainingCents).toBe(1000);

    view = application.recordPendingFinanceItem({
      ...pendingRefundInput(first!, 800),
      type: 'return_freight',
      note: '买家退货承担的运费',
    });
    expect(view.pendingItems).toHaveLength(2);

    view = application.recordPendingFinanceItem(pendingRefundInput(second!, 500));
    expect(view.pendingItems).toHaveLength(3);
    expect(view.totals.pendingRemainingCents).toBe(2300);
  });

  it('汇总金额与每笔记录对得上，待确认余额单独列示不混入已确认汇总', async () => {
    const { application, orderIds } = await openFundsApplication();
    const pending = application.recordPendingFinanceItem(pendingRefundInput(orderIds[0]!, 1000));
    const itemId = pendingOf(pending).id;

    let view = application.confirmPendingFinanceItem({ pendingItemId: itemId, amountCents: 400 });
    view = application.recordFinanceRecord({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 980,
      occurredAt: '2026-08-20T10:00:00+08:00',
      note: '平台结算到账',
    });
    view = application.recordFinanceRecord({
      type: 'replacement_freight',
      direction: 'expense',
      amountCents: 800,
      occurredAt: '2026-08-20T11:00:00+08:00',
      note: '补发顺丰到付',
    });

    expect(view.totals).toEqual({
      incomeCents: 980,
      expenseCents: 1200,
      netCents: -220,
      pendingRemainingCents: 600,
    });

    const incomeByType = view.typeTotals.reduce((total, row) => total + row.incomeCents, 0);
    const expenseByType = view.typeTotals.reduce((total, row) => total + row.expenseCents, 0);
    expect(incomeByType).toBe(view.totals.incomeCents);
    expect(expenseByType).toBe(view.totals.expenseCents);

    const refundTotal = view.typeTotals.find((total) => total.type === 'refund')!;
    expect(refundTotal).toMatchObject({ incomeCents: 0, expenseCents: 400, netCents: -400 });
    const pendingRefund = view.pendingTotals.find((total) => total.type === 'refund')!;
    expect(pendingRefund).toMatchObject({ count: 1, amountCents: 1000, remainingCents: 600 });

    for (const record of view.records) {
      expect(record.currency).toBe('CNY');
      expect(record.confirmedSource).toBe('manual_confirmation');
    }
    const confirmedSources = view.records
      .filter((record) => record.pendingItemId === itemId)
      .map((record) => `${record.sourceType}:${record.sourceId}`);
    expect(confirmedSources).toEqual([`order:${orderIds[0]}`]);
  });

  it('资金记录不可被更新或删除，待确认事项金额不可被改写', async () => {
    const { application, orderIds, dataDirectory } = await openFundsApplication();
    const pending = application.recordPendingFinanceItem(pendingRefundInput(orderIds[0]!, 1000));
    const itemId = pendingOf(pending).id;
    application.confirmPendingFinanceItem({ pendingItemId: itemId, amountCents: 400 });
    const recordId = recordOf(application.queryFunds(), 0).id;
    application.close();

    const workspace = WorkspaceClass.open(dataDirectory);
    openedWorkspaces.push(workspace);
    expect(() => workspace.database.prepare(
      "UPDATE finance_records SET amount_cents = 1 WHERE id = ?",
    ).run(recordId)).toThrow(/finance records are immutable/u);
    expect(() => workspace.database.prepare(
      'DELETE FROM finance_records WHERE id = ?',
    ).run(recordId)).toThrow(/finance records are immutable/u);
    expect(() => workspace.database.prepare(
      'UPDATE finance_pending_items SET amount_cents = 1 WHERE id = ?',
    ).run(itemId)).toThrow(/finance pending item facts are immutable/u);
  });

  it('重启后待确认事项、确认进度与资金记录完整保留', async () => {
    const { application, orderIds, dataDirectory } = await openFundsApplication();
    const pending = application.recordPendingFinanceItem(pendingRefundInput(orderIds[0]!, 1000));
    const itemId = pendingOf(pending).id;
    application.confirmPendingFinanceItem({ pendingItemId: itemId, amountCents: 400 });
    const before = application.queryFunds();
    application.close();

    const reopened = new LocalApplicationClass(new SequenceRecognizer([]));
    openedApplications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    const after = reopened.queryFunds();
    expect(after).toEqual(before);
  });
});
