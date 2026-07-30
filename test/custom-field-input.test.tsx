// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CustomFieldDefinition,
  CustomFieldType,
  CustomFieldValue,
} from '../src/core/custom-fields';
import { CustomFieldInput } from '../src/renderer/CustomFieldInput';

afterEach(cleanup);

function definition(
  type: CustomFieldType,
  overrides: Partial<CustomFieldDefinition> = {},
): CustomFieldDefinition {
  return {
    id: `field-${type}`,
    name: `测试${type}`,
    granularity: 'order',
    type,
    required: false,
    defaultValue: null,
    options: [],
    createdAt: '2026-07-30T08:00:00.000Z',
    updatedAt: '2026-07-30T08:00:00.000Z',
    ...overrides,
  };
}

function ControlledInput({
  field,
  initialValue = null,
}: {
  field: CustomFieldDefinition;
  initialValue?: CustomFieldValue | null;
}) {
  const [value, setValue] = useState<CustomFieldValue | null>(initialValue);
  const [valid, setValid] = useState(true);
  return (
    <>
      <CustomFieldInput
        definition={field}
        value={value}
        onChange={setValue}
        onValidityChange={setValid}
      />
      <output aria-label="当前字段值">{JSON.stringify(value)}</output>
      <output aria-label="当前字段有效性">{String(valid)}</output>
    </>
  );
}

describe('自定义字段输入控件', () => {
  it('按上海时区在 datetime-local 与 UTC ISO 之间双向转换', () => {
    render(
      <ControlledInput
        field={definition('datetime')}
        initialValue="2026-08-01T01:30:00.000Z"
      />,
    );

    const input = screen.getByLabelText('测试datetime');
    expect(input).toHaveValue('2026-08-01T09:30');

    fireEvent.change(input, { target: { value: '2026-08-02T09:30' } });
    expect(screen.getByLabelText('当前字段值')).toHaveTextContent(
      '"2026-08-02T01:30:00.000Z"',
    );
    expect(input).toHaveValue('2026-08-02T09:30');
  });

  it('金额输入精确转换为分且拒绝超过两位的小数', () => {
    render(<ControlledInput field={definition('money')} initialValue={100} />);

    const input = screen.getByLabelText('测试money');
    fireEvent.change(input, { target: { value: '1.005' } });
    expect(input).toHaveValue('1.005');
    const unit = screen.getByText('元');
    const error = screen.getByRole('alert');
    expect(unit).toHaveClass('custom-field__money-unit');
    expect(error).toHaveClass('custom-field__money-error');
    expect(error).toHaveTextContent('金额最多支持两位小数');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', `${unit.id} ${error.id}`);
    expect(screen.getByLabelText('当前字段值')).toHaveTextContent('100');
    expect(screen.getByLabelText('当前字段有效性')).toHaveTextContent('false');

    fireEvent.change(input, { target: { value: '1.999' } });
    expect(input).toHaveValue('1.999');
    expect(screen.getByLabelText('当前字段值')).toHaveTextContent('100');

    fireEvent.change(input, { target: { value: '1.99' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAttribute('aria-describedby', unit.id);
    expect(screen.getByLabelText('当前字段值')).toHaveTextContent('199');
    expect(screen.getByLabelText('当前字段有效性')).toHaveTextContent('true');
    expect(input).toHaveValue('1.99');
  });

  it('复选框提供未设置、是、否三态并明确保留 false', async () => {
    const user = userEvent.setup();
    render(<ControlledInput field={definition('checkbox')} />);

    const input = screen.getByRole('combobox', { name: '测试checkbox' });
    expect(input).toHaveValue('unset');
    expect(screen.getByRole('option', { name: '未设置' })).toBeVisible();
    expect(screen.getByRole('option', { name: '是' })).toBeVisible();
    expect(screen.getByRole('option', { name: '否' })).toBeVisible();

    await user.selectOptions(input, 'false');
    expect(screen.getByLabelText('当前字段值')).toHaveTextContent('false');
    expect(input).toHaveValue('false');

    await user.selectOptions(input, 'true');
    expect(screen.getByLabelText('当前字段值')).toHaveTextContent('true');

    await user.selectOptions(input, 'unset');
    expect(screen.getByLabelText('当前字段值')).toHaveTextContent('null');
  });

  it('每种必填字段都向实际输入控件声明 aria-required', () => {
    const types: CustomFieldType[] = [
      'text',
      'number',
      'money',
      'datetime',
      'single_select',
      'multi_select',
      'checkbox',
    ];
    render(
      <>
        {types.map((type) => (
          <CustomFieldInput
            key={type}
            definition={definition(type, {
              required: true,
              options: type === 'single_select' || type === 'multi_select' ? ['选项'] : [],
            })}
            value={null}
            onChange={() => undefined}
          />
        ))}
      </>,
    );

    for (const type of types) {
      expect(screen.getByLabelText(`测试${type}`)).toHaveAttribute('aria-required', 'true');
    }
  });

  it('作为可选筛选条件时不会错误声明为必填', () => {
    render(
      <CustomFieldInput
        definition={definition('text', { required: true })}
        value={null}
        showRequired={false}
        onChange={() => undefined}
      />,
    );

    expect(screen.getByLabelText('测试text')).toHaveAttribute('aria-required', 'false');
  });
});
