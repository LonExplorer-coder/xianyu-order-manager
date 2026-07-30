// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CustomFieldDefinition } from '../src/core/custom-fields';
import {
  fieldReferenceKey,
  type CreateTableTemplateInput,
  type TableTemplate,
  type UpdateTableTemplateInput,
} from '../src/core/table-templates';
import { TableTemplatesWorkspace } from '../src/renderer/TableTemplatesWorkspace';

afterEach(cleanup);

const customFieldDefinitions: CustomFieldDefinition[] = [{
  id: 'field-order-note',
  name: '客服备注',
  granularity: 'order',
  type: 'text',
  required: false,
  defaultValue: null,
  options: [],
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
}, {
  id: 'field-item-bin',
  name: '拣货位',
  granularity: 'order_item',
  type: 'single_select',
  required: false,
  defaultValue: null,
  options: ['A-01', 'A-02'],
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
}];

const orderQuery = {
  fulfillmentStatus: 'pending_shipment' as const,
  lifecycleStatus: 'active' as const,
  sortField: 'amount' as const,
  sortDirection: 'desc' as const,
};

const financeTemplate: TableTemplate = {
  id: 'template-finance',
  name: '财务核对',
  granularity: 'order',
  columns: [{
    field: { kind: 'computed', key: 'order_total' },
    displayName: '成交金额',
  }, {
    field: { kind: 'builtin', key: 'order_number' },
    displayName: '订单号',
  }],
  query: {
    lifecycleStatus: 'all',
    sortField: 'paid_at',
    sortDirection: 'asc',
  },
  createdAt: '2026-07-30T01:00:00.000Z',
  updatedAt: '2026-07-30T01:00:00.000Z',
};

function renderWorkspace(overrides: Partial<Parameters<typeof TableTemplatesWorkspace>[0]> = {}) {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const onApply = vi.fn();
  render(
    <TableTemplatesWorkspace
      templates={[]}
      customFieldDefinitions={customFieldDefinitions}
      orderQuery={orderQuery}
      orderItemQuery={{}}
      loading={false}
      error=""
      saving={false}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onDelete={onDelete}
      onApply={onApply}
      {...overrides}
    />,
  );
  return { onCreate, onUpdate, onDelete, onApply };
}

describe('表格模板工作台', () => {
  it('新建订单模板时捕获当前查询并保存非空列', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderWorkspace();

    await user.type(screen.getByRole('textbox', { name: '模板名称' }), '待发货清单');
    await user.click(screen.getByRole('button', { name: '创建模板' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    const input = onCreate.mock.calls[0]?.[0] as CreateTableTemplateInput;
    expect(input).toMatchObject({
      name: '待发货清单',
      granularity: 'order',
      query: orderQuery,
    });
    expect(input.columns.length).toBeGreaterThan(0);
    expect(input.columns.map(({ field }) => fieldReferenceKey(field)))
      .toContain('builtin:order_number');
  });

  it('可选择当前粒度字段、修改列名并调整列顺序', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderWorkspace();

    await user.type(screen.getByRole('textbox', { name: '模板名称' }), '客服处理表');
    await user.click(screen.getByRole('button', { name: '清空全部字段' }));
    expect(screen.getByRole('button', { name: '创建模板' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: '订单号' }));
    await user.click(screen.getByRole('checkbox', { name: '商品总数量' }));
    await user.click(screen.getByRole('checkbox', { name: '客服备注' }));
    expect(screen.queryByRole('checkbox', { name: '拣货位' })).not.toBeInTheDocument();

    const orderNumberName = screen.getByRole('textbox', { name: '订单号列名' });
    await user.clear(orderNumberName);
    await user.type(orderNumberName, '平台单号');
    await user.click(screen.getByRole('button', { name: '上移 客服备注' }));
    await user.click(screen.getByRole('button', { name: '上移 客服备注' }));
    await user.click(screen.getByRole('button', { name: '创建模板' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    const input = onCreate.mock.calls[0]?.[0] as CreateTableTemplateInput;
    expect(input.columns.map(({ field }) => fieldReferenceKey(field))).toEqual([
      'custom:field-order-note',
      'builtin:order_number',
      'computed:item_quantity_total',
    ]);
    expect(input.columns.map(({ displayName }) => displayName)).toEqual([
      '客服备注',
      '平台单号',
      '商品总数量',
    ]);
  });

  it('编辑已有模板时锁定数据粒度，并可显式用当前查询覆盖', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderWorkspace({ templates: [financeTemplate] });

    await user.click(screen.getByRole('button', { name: '编辑 财务核对' }));
    expect(screen.getByRole('combobox', { name: '数据粒度' })).toBeDisabled();
    const nameInput = screen.getByRole('textbox', { name: '模板名称' });
    await user.clear(nameInput);
    await user.type(nameInput, '财务复核');

    const orderNumberName = screen.getByRole('textbox', { name: '订单号列名' });
    await user.clear(orderNumberName);
    await user.type(orderNumberName, '平台单号');
    await user.click(screen.getByRole('button', { name: '用当前筛选排序覆盖' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    const [templateId, input] = onUpdate.mock.calls[0] as [string, UpdateTableTemplateInput];
    expect(templateId).toBe(financeTemplate.id);
    expect(input).toMatchObject({ name: '财务复核', query: orderQuery });
    expect(input.columns.map(({ displayName }) => displayName)).toEqual([
      '成交金额',
      '平台单号',
    ]);
  });

  it('可应用已保存模板，删除前要求明确确认', async () => {
    const user = userEvent.setup();
    const { onApply, onDelete } = renderWorkspace({ templates: [financeTemplate] });

    await user.click(screen.getByRole('button', { name: '应用 财务核对' }));
    expect(onApply).toHaveBeenCalledWith(financeTemplate);

    await user.click(screen.getByRole('button', { name: '删除 财务核对' }));
    expect(screen.getByRole('alertdialog', { name: '确认删除模板' }))
      .toHaveTextContent('财务核对');
    await user.click(screen.getByRole('button', { name: '取消删除' }));
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '删除 财务核对' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(financeTemplate.id));
  });

  it('删除确认框可用键盘完整操作并将焦点归还触发按钮', async () => {
    const user = userEvent.setup();
    renderWorkspace({ templates: [financeTemplate] });
    const trigger = screen.getByRole('button', { name: '删除 财务核对' });
    trigger.focus();

    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('alertdialog', { name: '确认删除模板' });
    const cancel = within(dialog).getByRole('button', { name: '取消删除' });
    const confirm = within(dialog).getByRole('button', { name: '确认删除' });
    expect(cancel).toHaveFocus();

    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(confirm).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('商品明细模板只显示商品字段并捕获商品查询', async () => {
    const user = userEvent.setup();
    const itemQuery = {
      customFieldSort: { definitionId: 'field-item-bin', direction: 'asc' as const },
    };
    const { onCreate } = renderWorkspace({ orderItemQuery: itemQuery });

    await user.type(screen.getByRole('textbox', { name: '模板名称' }), '拣货明细');
    await user.selectOptions(screen.getByRole('combobox', { name: '数据粒度' }), 'order_item');
    expect(screen.getByRole('textbox', { name: '模板名称' })).toHaveValue('拣货明细');
    expect(screen.getByRole('checkbox', { name: '拣货位' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '商品小计' })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: '客服备注' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '发货组' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /公式|脱敏/u })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '创建模板' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    const input = onCreate.mock.calls[0]?.[0] as CreateTableTemplateInput;
    expect(input).toMatchObject({ granularity: 'order_item', query: itemQuery });
    expect(input.columns.map(({ field }) => fieldReferenceKey(field)))
      .toContain('computed:item_subtotal');
  });

  it('明确呈现读取错误，保存期间禁用会改变模板的操作', () => {
    renderWorkspace({
      templates: [financeTemplate],
      loading: true,
      error: '表格模板读取失败',
      saving: true,
    });

    expect(screen.getByRole('alert')).toHaveTextContent('表格模板读取失败');
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('正在读取');
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '应用 财务核对' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑 财务核对' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 财务核对' })).toBeDisabled();
  });
});
