import { describe, expect, it } from 'vitest';

import {
  normalizeProgressAftersalesCaseInput,
  projectAftersalesRefundFulfillment,
} from '../src/core/aftersales-cases';

describe('售后退款满足度投影', () => {
  it('只有退款申请时判定为未完成', () => {
    expect(projectAftersalesRefundFulfillment(1_000, [])).toEqual({
      kind: 'unfulfilled',
      refundedAmountCents: 0,
    });
  });

  it('实退累计低于目标时判定为部分完成并给出剩余金额', () => {
    expect(projectAftersalesRefundFulfillment(1_000, [
      { amountCents: 300 },
      { amountCents: 200 },
    ])).toEqual({
      kind: 'partial',
      refundedAmountCents: 500,
      remainingAmountCents: 500,
    });
  });

  it('实退累计等于目标时判定为已完成', () => {
    expect(projectAftersalesRefundFulfillment(1_000, [
      { amountCents: 300 },
      { amountCents: 700 },
    ])).toEqual({
      kind: 'complete',
      refundedAmountCents: 1_000,
    });
  });

  it('实退累计超过目标时判定为金额冲突并给出超出金额', () => {
    expect(projectAftersalesRefundFulfillment(300, [
      { amountCents: 500 },
    ])).toEqual({
      kind: 'conflict',
      refundedAmountCents: 500,
      excessAmountCents: 200,
    });
  });
});

describe('调整退款目标与结束退款输入校验', () => {
  it('调整退款目标接受正整数金额并规范化原因与时间', () => {
    expect(normalizeProgressAftersalesCaseInput({
      kind: 'adjust_refund_target',
      caseId: 'case-1',
      expectedRevision: 2,
      requestedRefundCents: 1_500,
      occurredAt: ' 2026-08-14T10:00:00+08:00 ',
      reason: ' 买家补差价 ',
    })).toEqual({
      kind: 'adjust_refund_target',
      caseId: 'case-1',
      expectedRevision: 2,
      requestedRefundCents: 1_500,
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '买家补差价',
    });
  });

  it('调整退款目标拒绝未知字段、非正金额与空原因', () => {
    expect(() => normalizeProgressAftersalesCaseInput({
      kind: 'adjust_refund_target',
      caseId: 'case-1',
      expectedRevision: 2,
      requestedRefundCents: 0,
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '调价',
    })).toThrow('退款目标金额无效');
    expect(() => normalizeProgressAftersalesCaseInput({
      kind: 'adjust_refund_target',
      caseId: 'case-1',
      expectedRevision: 2,
      requestedRefundCents: 100,
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '  ',
    })).toThrow('请填写 1 至 500 字的退款目标调整原因');
    expect(() => normalizeProgressAftersalesCaseInput({
      kind: 'adjust_refund_target',
      caseId: 'case-1',
      expectedRevision: 2,
      requestedRefundCents: 100,
      occurredAt: '2026-08-14T10:00:00+08:00',
      reason: '调价',
      extra: 1,
    })).toThrow('调整退款目标参数包含未知字段：extra');
  });

  it('结束退款接受原因与时间并拒绝未知字段', () => {
    expect(normalizeProgressAftersalesCaseInput({
      kind: 'end_refund',
      caseId: 'case-1',
      expectedRevision: 3,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: ' 协商后不再补退剩余金额 ',
    })).toEqual({
      kind: 'end_refund',
      caseId: 'case-1',
      expectedRevision: 3,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '协商后不再补退剩余金额',
    });
    expect(() => normalizeProgressAftersalesCaseInput({
      kind: 'end_refund',
      caseId: 'case-1',
      expectedRevision: 3,
      occurredAt: '2026-08-14T11:00:00+08:00',
      reason: '协商结束',
      amount: 100,
    })).toThrow('结束退款参数包含未知字段：amount');
    expect(() => normalizeProgressAftersalesCaseInput({
      kind: 'end_refund',
      caseId: 'case-1',
      expectedRevision: 3,
      occurredAt: '不是时间',
      reason: '协商结束',
    })).toThrow('结束退款时间无效');
  });
});
