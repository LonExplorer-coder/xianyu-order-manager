// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type { ProfitReportView } from '../src/core/profit';
import { ProfitWorkspace } from '../src/renderer/ProfitWorkspace';

afterEach(() => cleanup());

function profitFixture(): ProfitReportView {
  return {
    generatedAt: '2026-08-20T06:00:00.000Z',
    orders: [
      {
        orderId: 'order-profit-1',
        orderNumber: 'XY-PROFIT-UI-0001',
        sellerAccount: '利润测试账号',
        buyerNickname: '利润测试买家',
        orderedAt: '2026-08-20T10:00:00+08:00',
        transactionAmountCents: 10_000,
        settlementNetCents: 9_500,
        refundNetCents: -1_200,
        platformFeeNetCents: -300,
        freightNetCents: -800,
        claimNetCents: 150,
        miscNetCents: 0,
        purchaseCostCents: 1_000,
        profitCents: 6_350,
        pendingRemainingCents: -800,
        moneyComponents: [
          {
            kind: 'record',
            id: 'record-profit-1',
            type: 'platform_settlement',
            direction: 'income',
            amountCents: 9_500,
            allocatedCents: 9_500,
            remainingCents: null,
            sourceLabel: '订单 XY-PROFIT-UI-0001',
            occurredAt: '2026-08-20T14:12:00+08:00',
            note: '平台结算到账',
            reference: false,
          },
          {
            kind: 'record',
            id: 'record-profit-2',
            type: 'order_transaction',
            direction: 'income',
            amountCents: 10_000,
            allocatedCents: 10_000,
            remainingCents: null,
            sourceLabel: '订单 XY-PROFIT-UI-0001',
            occurredAt: '2026-08-20T14:11:00+08:00',
            note: '成交金额参照',
            reference: true,
          },
          {
            kind: 'pending',
            id: 'pending-profit-1',
            type: 'refund',
            direction: 'expense',
            amountCents: 2_000,
            allocatedCents: -800,
            remainingCents: -800,
            sourceLabel: '售后处理单 abcd1234 实际退款',
            occurredAt: '2026-08-20T14:50:00+08:00',
            note: '平台实际退款',
            reference: false,
          },
        ],
        costComponents: [
          {
            kind: 'dispatch',
            sourceLabel: '发货记录 SF-PROFIT-UI-0001',
            shipmentRecordId: 'record-shipment-1',
            returnRecordId: null,
            standardProductId: 'product-profit-1',
            sku: 'SKU-PROFIT-A',
            name: '利润测试保鲜盒',
            quantity: 2,
            unitCostCents: 500,
            amountCents: 1_000,
            occurredAt: '2026-08-20T14:10:00+08:00',
            reason: '',
          },
          {
            kind: 'recovery',
            sourceLabel: '售后处理单 abcd1234 退货检查转可销售',
            shipmentRecordId: null,
            returnRecordId: 'return-profit-1',
            standardProductId: 'product-profit-2',
            sku: 'SKU-PROFIT-B',
            name: '利润测试封口夹',
            quantity: 1,
            unitCostCents: 800,
            amountCents: -800,
            occurredAt: '2026-08-20T14:45:00+08:00',
            reason: '检查通过可再销售',
          },
        ],
      },
    ],
    products: [
      {
        standardProductId: 'product-profit-1',
        sku: 'SKU-PROFIT-A',
        name: '利润测试保鲜盒',
        specification: '1000ml',
        avgUnitCostCents: 500,
        arrivedQuantity: 3,
        supplierReturnedQuantity: 0,
        orderCount: 1,
        transactionCents: 5_000,
        allocatedNetCents: 3_675,
        dispatchedQuantity: 2,
        dispatchedCostCents: 1_000,
        scrapQuantity: 0,
        scrapCostCents: 0,
        returnReceivedQuantity: 0,
        marginCents: 2_675,
        allocations: [
          {
            orderId: 'order-profit-1',
            orderNumber: 'XY-PROFIT-UI-0001',
            transactionCents: 5_000,
            allocatedNetCents: 3_675,
          },
        ],
        costComponents: [],
      },
      {
        standardProductId: 'product-profit-2',
        sku: 'SKU-PROFIT-B',
        name: '利润测试封口夹',
        specification: '大号',
        avgUnitCostCents: 800,
        arrivedQuantity: 2,
        supplierReturnedQuantity: 0,
        orderCount: 1,
        transactionCents: 5_000,
        allocatedNetCents: 3_675,
        dispatchedQuantity: 0,
        dispatchedCostCents: 0,
        scrapQuantity: 1,
        scrapCostCents: 800,
        returnReceivedQuantity: 1,
        marginCents: 2_875,
        allocations: [
          {
            orderId: 'order-profit-1',
            orderNumber: 'XY-PROFIT-UI-0001',
            transactionCents: 5_000,
            allocatedNetCents: 3_675,
          },
        ],
        costComponents: [
          {
            kind: 'scrap',
            sourceLabel: '到货检查报废（采购订单 #1）',
            shipmentRecordId: null,
            returnRecordId: null,
            standardProductId: 'product-profit-2',
            sku: 'SKU-PROFIT-B',
            name: '利润测试封口夹',
            quantity: 1,
            unitCostCents: 800,
            amountCents: 800,
            occurredAt: '2026-08-20T14:05:00+08:00',
            reason: '',
          },
        ],
      },
    ],
    unmapped: { orderCount: 0, transactionCents: 0, allocatedNetCents: 0 },
    others: [
      {
        kind: 'record',
        id: 'record-profit-3',
        type: 'purchase_cost',
        direction: 'expense',
        amountCents: 3_100,
        allocatedCents: -3_100,
        remainingCents: null,
        sourceLabel: '采购订单 #1',
        occurredAt: '2026-08-20T14:06:00+08:00',
        note: '支付采购全款',
        reference: false,
      },
    ],
    totals: {
      transactionCents: 10_000,
      profitCents: 6_350,
      pendingRemainingCents: -800,
      scrapCostCents: 800,
      purchasePaymentNetCents: -3_100,
      othersNetCents: -3_100,
    },
  };
}

function renderProfit(overrides: {
  queryProfitReport?: ReturnType<typeof vi.fn>;
} = {}): ReturnType<typeof vi.fn> {
  const queryProfitReport = overrides.queryProfitReport
    ?? vi.fn().mockResolvedValue(profitFixture());
  const api = { queryProfitReport } as unknown as DesktopApi;
  render(<ProfitWorkspace api={api} />);
  return queryProfitReport;
}

describe('利润工作区', () => {
  it('呈现总览卡、订单利润表与采购及其他', async () => {
    renderProfit();
    expect(await screen.findByRole('heading', { name: '利润' })).toBeVisible();

    const overview = screen.getByLabelText('利润汇总');
    expect(within(overview).getByText('¥63.50')).toBeVisible();
    expect(within(overview).getByText('-¥8.00')).toBeVisible();
    expect(within(overview).getByText('¥8.00')).toBeVisible();
    expect(within(overview).getByText('-¥31.00')).toBeVisible();

    const orderTable = screen.getByRole('table', { name: '订单利润' });
    const row = within(orderTable).getByRole('row', { name: /XY-PROFIT-UI-0001/ });
    expect(within(row).getByText('¥100.00')).toBeVisible();
    expect(within(row).getByText('¥95.00')).toBeVisible();
    expect(within(row).getByText('-¥12.00')).toBeVisible();
    expect(within(row).getByText('¥63.50')).toBeVisible();

    const othersTable = screen.getByRole('table', { name: '采购与其他资金' });
    const paymentRow = within(othersTable).getByRole('row', { name: /支付采购全款/ });
    expect(within(paymentRow).getByText('采购订单 #1')).toBeVisible();
    expect(within(paymentRow).getByText('-¥31.00')).toBeVisible();
  });

  it('展开订单明细看到资金与成本的可追溯条目，成交参照单独标注', async () => {
    const user = userEvent.setup();
    renderProfit();

    const orderTable = await screen.findByRole('table', { name: '订单利润' });
    const row = within(orderTable).getByRole('row', { name: /XY-PROFIT-UI-0001/ });
    await user.click(within(row).getByRole('button', { name: '展开明细' }));

    const detailRow = orderTable.querySelector('tr.profit-detail-row');
    if (!detailRow) throw new Error('未找到明细行');
    expect(within(detailRow as HTMLElement).getByText(/平台结算到账/)).toBeVisible();
    expect(within(detailRow as HTMLElement)
      .getByText(/成交参照，不参与利润/)).toBeVisible();
    expect(within(detailRow as HTMLElement).getByText(/待确认·退款/)).toBeVisible();
    expect(within(detailRow as HTMLElement).getByText(/发货记录 SF-PROFIT-UI-0001/)).toBeVisible();
    expect(within(detailRow as HTMLElement).getByText(/退货检查转可销售/)).toBeVisible();

    await user.click(within(row).getByRole('button', { name: '收起明细' }));
    expect(orderTable.querySelector('tr.profit-detail-row')).toBeNull();
  });

  it('切换到商品汇总查看商品毛利与报废追溯', async () => {
    const user = userEvent.setup();
    renderProfit();

    await screen.findByRole('table', { name: '订单利润' });
    await user.click(screen.getByRole('tab', { name: '商品汇总' }));

    const productTable = screen.getByRole('table', { name: '商品汇总' });
    const boxRow = within(productTable).getByRole('row', { name: /利润测试保鲜盒/ });
    expect(within(boxRow).getByText('¥5.00')).toBeVisible();
    expect(within(boxRow).getByText('¥26.75')).toBeVisible();
    const clipRow = within(productTable).getByRole('row', { name: /利润测试封口夹/ });
    // 平均采购单价与报废损失都是 ¥8.00，各出现一次。
    expect(within(clipRow).getAllByText('¥8.00')).toHaveLength(2);
    expect(within(clipRow).getByText('¥28.75')).toBeVisible();

    await user.click(within(clipRow).getByRole('button', { name: '展开明细' }));
    const detailRow = productTable.querySelector('tr.profit-detail-row');
    if (!detailRow) throw new Error('未找到明细行');
    expect(within(detailRow as HTMLElement).getByText(/到货检查报废（采购订单 #1）/)).toBeVisible();
    expect(within(detailRow as HTMLElement).getByText(/累计到货 2 件/)).toBeVisible();
  });

  it('读取失败时呈现错误信息', async () => {
    renderProfit({
      queryProfitReport: vi.fn().mockRejectedValue(new Error('数据库正被占用')),
    });
    await waitFor(() => expect(screen.getByText('数据库正被占用')).toBeVisible());
  });
});
