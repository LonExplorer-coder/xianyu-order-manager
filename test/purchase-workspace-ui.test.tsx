// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type { InventoryView } from '../src/core/inventory-ledger';
import type { PurchaseView } from '../src/core/purchase-orders';
import { PurchaseWorkspace } from '../src/renderer/PurchaseWorkspace';

afterEach(() => cleanup());

function purchaseFixture(): PurchaseView {
  return {
    suppliers: [{
      supplierId: 'supplier-po-1',
      name: '深圳塑料制品厂',
      contact: '13800000000',
      note: '长期合作',
      createdAt: '2026-08-18T09:00:00.000Z',
    }],
    orders: [{
      id: 'order-po-1',
      sequence: 1,
      supplierId: 'supplier-po-1',
      supplierName: '深圳塑料制品厂',
      status: 'confirmed',
      expectedAt: '2026-09-01T00:00:00+08:00',
      createdAt: '2026-08-18T09:30:00.000Z',
      confirmedAt: '2026-08-18T10:00:00.000Z',
      cancelledAt: null,
      cancelReason: null,
      items: [{
        id: 'item-po-1',
        standardProductId: 'product-po-a',
        sku: 'SKU-PO-A',
        name: '玻璃保鲜盒',
        specification: '1000ml',
        quantity: 10,
        unitPriceCents: 500,
        receivedQuantity: 4,
        supplierReturnedQuantity: 1,
      }],
      events: [
        {
          sequence: 1,
          eventType: 'created',
          itemId: null,
          quantity: null,
          reason: '按缺口下单',
          occurredAt: '2026-08-18T09:30:00.000Z',
        },
        {
          sequence: 2,
          eventType: 'confirmed',
          itemId: null,
          quantity: null,
          reason: '供应方已接单',
          occurredAt: '2026-08-18T10:00:00.000Z',
        },
      ],
      arrivals: [{
        id: 'arrival-po-1',
        occurredAt: '2026-08-19T09:00:00.000Z',
        reason: '第一批到货',
        items: [{
          id: 'arrival-item-po-1',
          orderItemId: 'item-po-1',
          standardProductId: 'product-po-a',
          sku: 'SKU-PO-A',
          name: '玻璃保鲜盒',
          specification: '1000ml',
          receivedQuantity: 4,
          resellableQuantity: 2,
          defectiveQuantity: 1,
          scrappedQuantity: 0,
        }],
      }],
      payable: {
        amountCents: 5000,
        createdAt: '2026-08-18T10:00:00.000Z',
        updatedAt: '2026-08-18T10:00:00.000Z',
      },
    }],
    supplierReturns: [{
      id: 'return-po-1',
      supplierId: 'supplier-po-1',
      supplierName: '深圳塑料制品厂',
      purchaseOrderId: 'order-po-1',
      reason: '瑕疵品退回供应方',
      occurredAt: '2026-08-19T12:00:00.000Z',
      createdAt: '2026-08-19T12:00:00.000Z',
      items: [{
        id: 'return-item-po-1',
        standardProductId: 'product-po-a',
        sku: 'SKU-PO-A',
        name: '玻璃保鲜盒',
        specification: '1000ml',
        quantity: 1,
        state: 'defective',
      }],
    }],
  };
}

function inventoryFixture(): InventoryView {
  return {
    products: [{
      standardProductId: 'product-po-a',
      sku: 'SKU-PO-A',
      name: '玻璃保鲜盒',
      specification: '1000ml',
      sellableQuantity: 2,
      awaitingInspectionQuantity: 1,
      defectiveQuantity: 0,
      scrappedQuantity: 0,
      reservedQuantity: 0,
      purchaseInTransitQuantity: 6,
    }],
    unmappedPendingShipment: [],
    movements: [],
  };
}

function renderPurchase(overrides: {
  queryPurchases?: ReturnType<typeof vi.fn>;
  recordPurchaseArrival?: ReturnType<typeof vi.fn>;
} = {}): {
  queryPurchases: ReturnType<typeof vi.fn>;
  recordPurchaseArrival: ReturnType<typeof vi.fn>;
} {
  const queryPurchases = overrides.queryPurchases
    ?? vi.fn().mockResolvedValue(purchaseFixture());
  const recordPurchaseArrival = overrides.recordPurchaseArrival ?? vi.fn();
  const api = {
    queryPurchases,
    queryInventory: vi.fn().mockResolvedValue(inventoryFixture()),
    createSupplier: vi.fn(),
    createPurchaseOrder: vi.fn(),
    confirmPurchaseOrder: vi.fn(),
    cancelPurchaseOrder: vi.fn(),
    changePurchaseOrderItemQuantity: vi.fn(),
    changePurchaseOrderExpectedDate: vi.fn(),
    recordPurchaseArrival,
    recordSupplierReturn: vi.fn(),
  } as unknown as DesktopApi;
  render(<PurchaseWorkspace api={api} />);
  return { queryPurchases, recordPurchaseArrival };
}

describe('采购工作区', () => {
  it('呈现供应方、订单进度、待确认应付与供应方退货记录', async () => {
    renderPurchase();
    expect(await screen.findByRole('heading', { name: '采购' })).toBeVisible();

    const supplierTable = screen.getByRole('table', { name: '供应方清单' });
    expect(within(supplierTable).getByText('深圳塑料制品厂')).toBeVisible();

    const orderTable = screen.getByRole('table', { name: '第 1 号采购订单商品' });
    const row = within(orderTable).getByRole('row', { name: /玻璃保鲜盒/ });
    expect(within(row).getByText('10')).toBeVisible();
    expect(within(row).getAllByRole('cell')[3]).toHaveTextContent('4');
    expect(within(row).getAllByRole('cell')[4]).toHaveTextContent('1');

    expect(screen.getByText(/待确认应付 ¥50\.00/)).toBeVisible();
    expect(screen.getByText('已确认')).toBeVisible();

    const returnTable = screen.getByRole('table', { name: '供应方退货记录' });
    const returnRow = within(returnTable).getByRole('row', { name: /玻璃保鲜盒/ });
    expect(within(returnRow).getByText('瑕疵品')).toBeVisible();
    expect(within(returnRow).getByText('瑕疵品退回供应方')).toBeVisible();
  });

  it('登记到货提交实收与检查分流，未填余量留给待检查', async () => {
    const user = userEvent.setup();
    const recordPurchaseArrival = vi.fn().mockResolvedValue(purchaseFixture());
    renderPurchase({ recordPurchaseArrival });

    await user.click(await screen.findByRole('button', { name: '登记到货' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/到货数量/), '5');
    await user.type(within(dialog).getByLabelText(/合格数量/), '3');
    await user.type(within(dialog).getByLabelText(/瑕疵数量/), '1');
    await user.type(
      within(dialog).getByLabelText('到货说明'),
      '第二批抽检合格大半',
    );
    await user.click(within(dialog).getByRole('button', { name: '登记到货' }));

    await waitFor(() => expect(recordPurchaseArrival).toHaveBeenCalledTimes(1));
    const call = recordPurchaseArrival.mock.calls[0][0];
    expect(call.orderId).toBe('order-po-1');
    expect(call.items).toEqual([{
      orderItemId: 'item-po-1',
      receivedQuantity: 5,
      resellableQuantity: 3,
      defectiveQuantity: 1,
      scrappedQuantity: 0,
    }]);
    expect(call.reason).toBe('第二批抽检合格大半');
  });

  it('检查分类超过到货数量时阻止提交', async () => {
    const user = userEvent.setup();
    const { recordPurchaseArrival } = renderPurchase();

    await user.click(await screen.findByRole('button', { name: '登记到货' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/到货数量/), '2');
    await user.type(within(dialog).getByLabelText(/合格数量/), '3');
    await user.click(within(dialog).getByRole('button', { name: '登记到货' }));

    expect(await within(dialog).findByText(/检查分类数量不能超过到货数量/))
      .toBeVisible();
    expect(recordPurchaseArrival).not.toHaveBeenCalled();
  });
});
