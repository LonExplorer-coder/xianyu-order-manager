// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type { InventoryView } from '../src/core/inventory-ledger';
import { InventoryWorkspace } from '../src/renderer/InventoryWorkspace';

afterEach(() => cleanup());

function inventoryFixture(): InventoryView {
  return {
    products: [
      {
        standardProductId: 'product-inv-a',
        sku: 'SKU-INV-A',
        name: '玻璃保鲜盒',
        specification: '1000ml',
        sellableQuantity: 4,
        awaitingInspectionQuantity: 2,
        defectiveQuantity: 1,
        scrappedQuantity: 0,
        reservedQuantity: 3,
        purchaseInTransitQuantity: 6,
      },
    ],
    unmappedPendingShipment: [
      { sourceTitle: '手作发夹', sourceSpec: '蓝色', quantity: 2, orderCount: 1 },
    ],
    movements: [
      {
        id: 'movement-1',
        sequence: 2,
        standardProductId: 'product-inv-a',
        sku: 'SKU-INV-A',
        name: '玻璃保鲜盒',
        specification: '1000ml',
        quantity: 2,
        direction: 'out',
        state: 'awaiting_inspection',
        sourceType: 'inspection_result',
        sourceId: 'inspection-1',
        reason: '逐件检查',
        occurredAt: '2026-08-19T10:00:00.000Z',
        createdAt: '2026-08-19T10:00:00.000Z',
      },
      {
        id: 'movement-2',
        sequence: 1,
        standardProductId: 'product-inv-a',
        sku: 'SKU-INV-A',
        name: '玻璃保鲜盒',
        specification: '1000ml',
        quantity: 7,
        direction: 'in',
        state: 'awaiting_inspection',
        sourceType: 'manual_adjustment',
        sourceId: 'movement-2',
        reason: '退货集中待检查入库',
        occurredAt: '2026-08-18T09:00:00.000Z',
        createdAt: '2026-08-18T09:00:00.000Z',
      },
    ],
  };
}

function emptyInventoryFixture(): InventoryView {
  return { products: [], unmappedPendingShipment: [], movements: [] };
}

type ApiOverrides = {
  queryInventory?: ReturnType<typeof vi.fn>;
  recordInventoryAdjustment?: ReturnType<typeof vi.fn>;
  recordInventoryInspection?: ReturnType<typeof vi.fn>;
};

function renderInventory(overrides: ApiOverrides = {}): {
  queryInventory: ReturnType<typeof vi.fn>;
  recordInventoryAdjustment: ReturnType<typeof vi.fn>;
} {
  const queryInventory = overrides.queryInventory
    ?? vi.fn().mockResolvedValue(inventoryFixture());
  const recordInventoryAdjustment = overrides.recordInventoryAdjustment ?? vi.fn();
  const recordInventoryInspection = overrides.recordInventoryInspection ?? vi.fn();
  const api = {
    queryInventory,
    recordInventoryAdjustment,
    recordInventoryInspection,
  } as unknown as DesktopApi;
  render(<InventoryWorkspace api={api} />);
  return { queryInventory, recordInventoryAdjustment };
}

describe('库存工作区', () => {
  it('按两组分区呈现四态与参考数，并显示未映射提醒与流水来源', async () => {
    renderInventory();
    expect(await screen.findByRole('heading', { name: '库存' })).toBeVisible();

    const table = screen.getByRole('table', { name: '库存四态与参考数' });
    expect(
      within(table).getByRole('columnheader', { name: '真实库存' }),
    ).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: '参考数' })).toBeVisible();

    const row = within(table).getByRole('row', { name: /玻璃保鲜盒/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells.slice(2, 8).map((cell) => cell.textContent)).toEqual([
      '4', '2', '1', '0', '3', '6',
    ]);

    expect(screen.getByRole('alert').textContent).toContain('未映射商品');
    expect(screen.getByRole('table', { name: '未映射待发货明细' }).textContent)
      .toContain('手作发夹');

    const movementsTable = screen.getByRole('table', { name: '库存流水' });
    const movementRows = within(movementsTable).getAllByRole('row');
    expect(movementRows[1].textContent).toContain('检查结果');
    expect(movementRows[1].textContent).toContain('逐件检查');
    expect(movementRows[2].textContent).toContain('人工调整');
    expect(movementRows[2].textContent).toContain('退货集中待检查入库');

    expect(within(row).getByRole('button', { name: '检查' })).toBeEnabled();
  });

  it('没有标准商品时展示引导空态', async () => {
    renderInventory({
      queryInventory: vi.fn().mockResolvedValue(emptyInventoryFixture()),
    });
    expect(
      await screen.findByText('还没有标准商品'),
    ).toBeVisible();
    expect(screen.queryByRole('table', { name: '库存四态与参考数' })).not.toBeInTheDocument();
  });

  it('提交人工调整会带完整参数调用接口并用返回视图刷新', async () => {
    const user = userEvent.setup();
    const refreshed = { ...inventoryFixture(), unmappedPendingShipment: [] };
    const { recordInventoryAdjustment } = renderInventory({
      recordInventoryAdjustment: vi.fn().mockResolvedValue(refreshed),
    });
    await screen.findByRole('table', { name: '库存四态与参考数' });

    await user.click(screen.getByRole('button', { name: '人工调整 / 期初入库' }));
    const dialog = screen.getByRole('dialog', { name: '入库调整' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '标准商品' }),
      'product-inv-a',
    );
    await user.clear(within(dialog).getByRole('spinbutton', { name: '数量' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: '数量' }), '5');
    await user.type(
      within(dialog).getByRole('textbox', { name: '原因（必填）' }),
      '期初入库',
    );
    await user.click(within(dialog).getByRole('button', { name: '保存调整' }));

    expect(recordInventoryAdjustment).toHaveBeenCalledWith({
      standardProductId: 'product-inv-a',
      quantity: 5,
      direction: 'in',
      state: 'sellable',
      reason: '期初入库',
    });
    await waitFor(() => {
      expect(screen.queryByRole('table', { name: '未映射待发货明细' }))
        .not.toBeInTheDocument();
    });
  });

  it('调整失败时在对话框内回显错误且不关闭', async () => {
    const user = userEvent.setup();
    renderInventory({
      recordInventoryAdjustment: vi.fn().mockRejectedValue(
        new Error('玻璃保鲜盒（1000ml）可销售 4 件，不够扣减 9 件'),
      ),
    });
    await screen.findByRole('table', { name: '库存四态与参考数' });

    await user.click(screen.getByRole('button', { name: '人工调整 / 期初入库' }));
    const dialog = screen.getByRole('dialog', { name: '入库调整' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: '标准商品' }),
      'product-inv-a',
    );
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '方向' }), 'out');
    await user.clear(within(dialog).getByRole('spinbutton', { name: '数量' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: '数量' }), '9');
    await user.type(
      within(dialog).getByRole('textbox', { name: '原因（必填）' }),
      '超量扣减',
    );
    await user.click(within(dialog).getByRole('button', { name: '保存调整' }));

    expect(
      await within(dialog).findByText('玻璃保鲜盒（1000ml）可销售 4 件，不够扣减 9 件'),
    ).toBeVisible();
    expect(screen.getByRole('dialog', { name: '出库调整' })).toBeInTheDocument();
  });
});
