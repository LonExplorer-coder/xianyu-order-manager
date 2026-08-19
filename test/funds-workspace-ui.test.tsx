// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import {
  FINANCE_RECORD_TYPES,
  type FinanceRecordTypeName,
  type FundsView,
} from '../src/core/funds';
import { FundsWorkspace } from '../src/renderer/FundsWorkspace';

afterEach(() => cleanup());

function fundsFixture(): FundsView {
  const income: Partial<Record<FinanceRecordTypeName, number>> = {
    platform_settlement: 980,
    refund: 300,
  };
  const expense: Partial<Record<FinanceRecordTypeName, number>> = {
    refund: 400,
  };
  const pendingAmounts: Partial<Record<FinanceRecordTypeName, {
    count: number;
    amountCents: number;
    remainingCents: number;
  }>> = {
    refund: { count: 1, amountCents: 1000, remainingCents: 600 },
    carrier_claim: { count: 1, amountCents: 2000, remainingCents: 2000 },
  };
  return {
    pendingItems: [
      {
        id: 'pending-funds-1',
        type: 'refund',
        direction: 'expense',
        amountCents: 1000,
        currency: 'CNY',
        status: 'pending',
        confirmedCents: 400,
        remainingCents: 600,
        sourceType: 'order',
        sourceId: 'order-funds-1',
        note: '买家申请部分退款',
        occurredAt: '2026-08-20T09:00:00.000Z',
        cancelledAt: null,
        cancelReason: null,
        createdAt: '2026-08-20T09:05:00.000Z',
      },
      {
        id: 'pending-funds-2',
        type: 'carrier_claim',
        direction: 'income',
        amountCents: 2000,
        currency: 'CNY',
        status: 'pending',
        confirmedCents: 0,
        remainingCents: 2000,
        sourceType: 'logistics_exception',
        sourceId: 'exception-funds-1',
        note: '丢件理赔待到账',
        occurredAt: '2026-08-19T15:00:00.000Z',
        cancelledAt: null,
        cancelReason: null,
        createdAt: '2026-08-19T15:10:00.000Z',
      },
      {
        id: 'pending-funds-3',
        type: 'refund',
        direction: 'expense',
        amountCents: 500,
        currency: 'CNY',
        status: 'cancelled',
        confirmedCents: 0,
        remainingCents: 0,
        sourceType: 'aftersales_case',
        sourceId: 'case-funds-1',
        note: '买家撤销了退款申请',
        occurredAt: '2026-08-18T11:00:00.000Z',
        cancelledAt: '2026-08-18T12:00:00.000Z',
        cancelReason: '买家主动撤销',
        createdAt: '2026-08-18T11:05:00.000Z',
      },
    ],
    records: [
      {
        id: 'record-funds-1',
        sequence: 1,
        type: 'platform_settlement',
        direction: 'income',
        amountCents: 980,
        currency: 'CNY',
        confirmedSource: 'manual_confirmation',
        confirmedAt: '2026-08-20T10:00:00.000Z',
        occurredAt: '2026-08-20T10:00:00.000Z',
        pendingItemId: null,
        sourceType: null,
        sourceId: null,
        reversesRecordId: null,
        note: '平台结算到账',
        createdAt: '2026-08-20T10:00:00.000Z',
      },
      {
        id: 'record-funds-2',
        sequence: 2,
        type: 'refund',
        direction: 'expense',
        amountCents: 400,
        currency: 'CNY',
        confirmedSource: 'manual_confirmation',
        confirmedAt: '2026-08-20T11:00:00.000Z',
        occurredAt: '2026-08-20T11:00:00.000Z',
        pendingItemId: 'pending-funds-1',
        sourceType: 'order',
        sourceId: 'order-funds-1',
        reversesRecordId: null,
        note: '平台先退 4 元',
        createdAt: '2026-08-20T11:00:00.000Z',
      },
      {
        id: 'record-funds-3',
        sequence: 3,
        type: 'refund',
        direction: 'income',
        amountCents: 300,
        currency: 'CNY',
        confirmedSource: 'manual_confirmation',
        confirmedAt: '2026-08-20T12:00:00.000Z',
        occurredAt: '2026-08-20T12:00:00.000Z',
        pendingItemId: 'pending-funds-1',
        sourceType: 'order',
        sourceId: 'order-funds-1',
        reversesRecordId: 'record-funds-2',
        note: '确认金额录错，冲回重记',
        createdAt: '2026-08-20T12:00:00.000Z',
      },
    ],
    typeTotals: FINANCE_RECORD_TYPES.map((type) => ({
      type,
      incomeCents: income[type] ?? 0,
      expenseCents: expense[type] ?? 0,
      netCents: (income[type] ?? 0) - (expense[type] ?? 0),
    })),
    pendingTotals: FINANCE_RECORD_TYPES.map((type) => ({
      type,
      count: pendingAmounts[type]?.count ?? 0,
      amountCents: pendingAmounts[type]?.amountCents ?? 0,
      remainingCents: pendingAmounts[type]?.remainingCents ?? 0,
    })),
    totals: {
      incomeCents: 1280,
      expenseCents: 400,
      netCents: 880,
      pendingRemainingCents: 2600,
    },
  };
}

function renderFunds(overrides: {
  queryFunds?: ReturnType<typeof vi.fn>;
  confirmPendingFinanceItem?: ReturnType<typeof vi.fn>;
  cancelPendingFinanceItem?: ReturnType<typeof vi.fn>;
  recordFinanceRecord?: ReturnType<typeof vi.fn>;
  reverseFinanceRecord?: ReturnType<typeof vi.fn>;
} = {}): {
  confirmPendingFinanceItem: ReturnType<typeof vi.fn>;
  cancelPendingFinanceItem: ReturnType<typeof vi.fn>;
  recordFinanceRecord: ReturnType<typeof vi.fn>;
  reverseFinanceRecord: ReturnType<typeof vi.fn>;
} {
  const confirmPendingFinanceItem = overrides.confirmPendingFinanceItem
    ?? vi.fn().mockResolvedValue(fundsFixture());
  const cancelPendingFinanceItem = overrides.cancelPendingFinanceItem
    ?? vi.fn().mockResolvedValue(fundsFixture());
  const recordFinanceRecord = overrides.recordFinanceRecord
    ?? vi.fn().mockResolvedValue(fundsFixture());
  const reverseFinanceRecord = overrides.reverseFinanceRecord
    ?? vi.fn().mockResolvedValue(fundsFixture());
  const api = {
    queryFunds: overrides.queryFunds ?? vi.fn().mockResolvedValue(fundsFixture()),
    confirmPendingFinanceItem,
    cancelPendingFinanceItem,
    recordFinanceRecord,
    reverseFinanceRecord,
  } as unknown as DesktopApi;
  render(<FundsWorkspace api={api} />);
  return {
    confirmPendingFinanceItem,
    cancelPendingFinanceItem,
    recordFinanceRecord,
    reverseFinanceRecord,
  };
}

describe('资金工作区', () => {
  it('呈现汇总数字、类型汇总、待确认事项与资金记录', async () => {
    renderFunds();
    expect(await screen.findByRole('heading', { name: '资金' })).toBeVisible();

    const overview = screen.getByLabelText('资金汇总');
    expect(within(overview).getByText('¥12.80')).toBeVisible();
    expect(within(overview).getByText('¥4.00')).toBeVisible();
    expect(within(overview).getByText('¥8.80')).toBeVisible();
    expect(within(overview).getByText('¥26.00')).toBeVisible();

    const summaryTable = screen.getByRole('table', { name: '资金类型汇总' });
    const refundRow = within(summaryTable).getByRole('row', { name: /退款/ });
    expect(within(refundRow).getByText('¥3.00')).toBeVisible();
    expect(within(refundRow).getByText('¥6.00（1 项）')).toBeVisible();

    const pendingTable = screen.getByRole('table', { name: '待确认资金事项' });
    const cancelledRow = within(pendingTable).getByRole('row', { name: /买家撤销了退款申请/ });
    expect(within(cancelledRow).getByText(/已取消/)).toBeVisible();
    expect(within(cancelledRow).getByRole('button', { name: '确认到账' })).toBeDisabled();

    const recordTable = screen.getByRole('table', { name: '资金记录' });
    const reversalRow = within(recordTable).getByRole('row', { name: /确认金额录错/ });
    expect(within(reversalRow).getByText('退款（冲正）')).toBeVisible();
    expect(within(reversalRow).getByText('收入')).toBeVisible();
  });

  it('点击类型汇总只看该类型的资金记录，清除筛选后恢复', async () => {
    const user = userEvent.setup();
    renderFunds();

    const summaryTable = await screen.findByRole('table', { name: '资金类型汇总' });
    const refundSummaryRow = within(summaryTable).getByRole('row', { name: /退款/ });
    await user.click(within(refundSummaryRow).getByRole('button', { name: '筛选记录' }));

    const recordTable = screen.getByRole('table', { name: '资金记录' });
    expect(within(recordTable).getAllByRole('row')).toHaveLength(3);
    expect(within(recordTable).queryByText('平台结算到账')).toBeNull();

    await user.click(screen.getByRole('button', { name: /清除类型筛选/ }));
    expect(within(recordTable).getByText('平台结算到账')).toBeVisible();
  });

  it('确认到账按剩余金额预填并提交本次确认金额', async () => {
    const user = userEvent.setup();
    const { confirmPendingFinanceItem } = renderFunds();

    const pendingTable = await screen.findByRole('table', { name: '待确认资金事项' });
    const confirmRow = within(pendingTable).getByRole('row', { name: /买家申请部分退款/ });
    await user.click(within(confirmRow).getByRole('button', { name: '确认到账' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/本次确认金额/)).toHaveValue(6);
    await user.clear(within(dialog).getByLabelText(/本次确认金额/));
    await user.type(within(dialog).getByLabelText(/本次确认金额/), '2');
    await user.click(within(dialog).getByRole('button', { name: '确认到账' }));

    await waitFor(() => expect(confirmPendingFinanceItem).toHaveBeenCalledTimes(1));
    const call = confirmPendingFinanceItem.mock.calls[0][0];
    expect(call.pendingItemId).toBe('pending-funds-1');
    expect(call.amountCents).toBe(200);
    expect(call.note).toBe('');
  });

  it('取消剩余金额必须填原因', async () => {
    const user = userEvent.setup();
    const { cancelPendingFinanceItem } = renderFunds();

    const pendingTable = await screen.findByRole('table', { name: '待确认资金事项' });
    const cancelRow = within(pendingTable).getByRole('row', { name: /丢件理赔待到账/ });
    await user.click(within(cancelRow).getByRole('button', { name: '取消剩余' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/取消原因/), '承运方改走保险通道');
    await user.click(within(dialog).getByRole('button', { name: '取消剩余金额' }));

    await waitFor(() => expect(cancelPendingFinanceItem).toHaveBeenCalledTimes(1));
    expect(cancelPendingFinanceItem.mock.calls[0][0]).toEqual({
      pendingItemId: 'pending-funds-2',
      reason: '承运方改走保险通道',
    });
  });

  it('直接录入按类型锁定收支方向并把元换算为分', async () => {
    const user = userEvent.setup();
    const { recordFinanceRecord } = renderFunds();

    await user.click(await screen.findByRole('button', { name: '录入资金记录' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('资金类型'), 'platform_settlement');
    expect(within(dialog).getByLabelText('收支方向')).toBeDisabled();
    await user.type(within(dialog).getByLabelText('金额（元）'), '9.8');
    await user.type(within(dialog).getByLabelText('说明（必填）'), '平台结算到账');
    await user.click(within(dialog).getByRole('button', { name: '保存资金记录' }));

    await waitFor(() => expect(recordFinanceRecord).toHaveBeenCalledTimes(1));
    expect(recordFinanceRecord.mock.calls[0][0]).toMatchObject({
      type: 'platform_settlement',
      direction: 'income',
      amountCents: 980,
      note: '平台结算到账',
    });
  });

  it('冲正预填未冲正余额并提交反向记录', async () => {
    const user = userEvent.setup();
    const { reverseFinanceRecord } = renderFunds();

    const recordTable = await screen.findByRole('table', { name: '资金记录' });
    const reverseRow = within(recordTable).getByRole('row', { name: /平台先退 4 元/ });
    await user.click(within(reverseRow).getByRole('button', { name: '冲正' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/冲正金额/)).toHaveValue(1);
    await user.clear(within(dialog).getByLabelText(/冲正金额/));
    await user.type(within(dialog).getByLabelText(/冲正金额/), '1.5');
    await user.type(within(dialog).getByLabelText(/冲正原因/), '多确认了一块五');
    await user.click(within(dialog).getByRole('button', { name: '生成冲正记录' }));

    await waitFor(() => expect(reverseFinanceRecord).toHaveBeenCalledTimes(1));
    expect(reverseFinanceRecord.mock.calls[0][0]).toEqual({
      recordId: 'record-funds-2',
      amountCents: 150,
      note: '多确认了一块五',
    });
  });
});
