// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import { CustomFieldsWorkspace } from '../src/renderer/CustomFieldsWorkspace';

afterEach(cleanup);

function renderWorkspace(createCustomFieldDefinition = vi.fn().mockResolvedValue({})) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  render(
    <CustomFieldsWorkspace
      api={{ createCustomFieldDefinition } as unknown as DesktopApi}
      definitions={[]}
      loading={false}
      loadError=""
      onRefresh={onRefresh}
    />,
  );
  return { createCustomFieldDefinition, onRefresh };
}

describe('自定义字段创建器', () => {
  it('选择设置默认值后必须填写值才能创建字段', async () => {
    const user = userEvent.setup();
    const { createCustomFieldDefinition } = renderWorkspace();

    await user.type(screen.getByRole('textbox', { name: '字段名称' }), '客服备注');
    await user.click(screen.getByRole('checkbox', { name: /设置默认值/u }));
    await user.click(screen.getByRole('button', { name: '创建字段' }));

    expect(createCustomFieldDefinition).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写默认值');
    await waitFor(() => expect(screen.getByRole('button', { name: '创建字段' })).toBeEnabled());
  });

  it('复选框的默认值“否”是有效值而不是未设置', async () => {
    const user = userEvent.setup();
    const { createCustomFieldDefinition } = renderWorkspace();

    await user.type(screen.getByRole('textbox', { name: '字段名称' }), '是否复核');
    await user.selectOptions(screen.getByRole('combobox', { name: '字段类型' }), 'checkbox');
    await user.click(screen.getByRole('checkbox', { name: /设置默认值/u }));
    expect(screen.getByRole('combobox', { name: '默认勾选' })).toHaveValue('false');
    await user.click(screen.getByRole('button', { name: '创建字段' }));

    await waitFor(() => expect(createCustomFieldDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'checkbox', defaultValue: false }),
    ));
  });

  it('数字零是有效默认值而不是未设置', async () => {
    const user = userEvent.setup();
    const { createCustomFieldDefinition } = renderWorkspace();

    await user.type(screen.getByRole('textbox', { name: '字段名称' }), '补寄次数');
    await user.selectOptions(screen.getByRole('combobox', { name: '字段类型' }), 'number');
    await user.click(screen.getByRole('checkbox', { name: /设置默认值/u }));
    await user.type(screen.getByRole('spinbutton', { name: '默认值' }), '0');
    await user.click(screen.getByRole('button', { name: '创建字段' }));

    await waitFor(() => expect(createCustomFieldDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'number', defaultValue: 0 }),
    ));
  });

  it('金额默认值显示非法精度时不能提交上一次合法值', async () => {
    const user = userEvent.setup();
    const { createCustomFieldDefinition } = renderWorkspace();

    await user.type(screen.getByRole('textbox', { name: '字段名称' }), '附加成本');
    await user.selectOptions(screen.getByRole('combobox', { name: '字段类型' }), 'money');
    await user.click(screen.getByRole('checkbox', { name: /设置默认值/u }));
    const defaultInput = screen.getByRole('textbox', { name: '默认值' });
    await user.type(defaultInput, '1.00');
    await user.clear(defaultInput);
    await user.type(defaultInput, '1.005');

    expect(screen.getByRole('button', { name: '创建字段' })).toBeDisabled();
    expect(createCustomFieldDefinition).not.toHaveBeenCalled();
  });

  it('纯空白文本不是可回填的有效默认值', async () => {
    const user = userEvent.setup();
    const { createCustomFieldDefinition } = renderWorkspace();

    await user.type(screen.getByRole('textbox', { name: '字段名称' }), '内部备注');
    await user.click(screen.getByRole('checkbox', { name: /设置默认值/u }));
    await user.type(screen.getByRole('textbox', { name: '默认值' }), '   ');

    expect(screen.getByRole('button', { name: '创建字段' })).toBeDisabled();
    expect(createCustomFieldDefinition).not.toHaveBeenCalled();
  });

  it('明确说明默认值会用于既有及后续订单或商品', () => {
    renderWorkspace();

    expect(screen.getByText(/既有及后续对应数据/u)).toBeVisible();
  });
});
