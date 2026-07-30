import { useEffect, useId, useState } from 'react';

import type {
  CustomFieldDefinition,
  CustomFieldValue,
} from '../core/custom-fields';

export type CustomFieldInputProps = {
  definition: CustomFieldDefinition;
  value: CustomFieldValue | null;
  onChange: (value: CustomFieldValue | null) => void;
  onValidityChange?: (valid: boolean) => void;
  label?: string;
  disabled?: boolean;
  showRequired?: boolean;
};

export function CustomFieldInput({
  definition,
  value,
  onChange,
  onValidityChange,
  label = definition.name,
  disabled = false,
  showRequired = definition.required,
}: CustomFieldInputProps) {
  const control = customFieldControl(
    definition,
    value,
    onChange,
    label,
    disabled,
    showRequired,
    onValidityChange,
  );
  if (definition.type === 'checkbox') {
    return (
      <label className="custom-field custom-field--checkbox">
        {control}
        <span>
          {label}
          {showRequired && <i aria-hidden="true">*</i>}
        </span>
      </label>
    );
  }

  return (
    <label className="custom-field">
      <span className="custom-field__label">
        {label}
        {showRequired && <i aria-hidden="true">*</i>}
      </span>
      {control}
    </label>
  );
}

function customFieldControl(
  definition: CustomFieldDefinition,
  value: CustomFieldValue | null,
  onChange: (value: CustomFieldValue | null) => void,
  label: string,
  disabled: boolean,
  required: boolean,
  onValidityChange?: (valid: boolean) => void,
) {
  switch (definition.type) {
    case 'text':
      return (
        <input
          aria-label={label}
          aria-required={required}
          type="text"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
        />
      );
    case 'number':
      return (
        <input
          aria-label={label}
          aria-required={required}
          type="number"
          step="any"
          value={typeof value === 'number' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(numberValue(event.target.value))}
        />
      );
    case 'money':
      return (
        <MoneyInput
          label={label}
          value={typeof value === 'number' ? value : null}
          required={required}
          disabled={disabled}
          onChange={onChange}
          onValidityChange={onValidityChange}
        />
      );
    case 'datetime':
      return (
        <input
          aria-label={label}
          aria-required={required}
          type="datetime-local"
          value={typeof value === 'string' ? datetimeInputValue(value) : ''}
          disabled={disabled}
          onChange={(event) => {
            const normalized = datetimeIsoValue(event.target.value);
            onValidityChange?.(event.target.value === '' || normalized !== null);
            onChange(normalized);
          }}
        />
      );
    case 'single_select':
      return (
        <select
          aria-label={label}
          aria-required={required}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">未选择</option>
          {definition.options.map((option) => (
            <option value={option} key={option}>{option}</option>
          ))}
        </select>
      );
    case 'multi_select': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <select
          aria-label={label}
          aria-required={required}
          multiple
          value={selected}
          disabled={disabled}
          onChange={(event) => {
            const next = Array.from(event.currentTarget.selectedOptions, (option) => option.value);
            onChange(next.length > 0 ? next : null);
          }}
        >
          {definition.options.map((option) => (
            <option value={option} key={option}>{option}</option>
          ))}
        </select>
      );
    }
    case 'checkbox':
      return (
        <select
          aria-label={label}
          aria-required={required}
          value={value === null ? 'unset' : value ? 'true' : 'false'}
          disabled={disabled}
          onChange={(event) => {
            const nextValue = event.target.value;
            onChange(nextValue === 'unset' ? null : nextValue === 'true');
          }}
        >
          <option value="unset">未设置</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      );
  }
}

function numberValue(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function datetimeInputValue(value: string): string {
  const zonedValue = /(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    ? value
    : `${value}+08:00`;
  const date = new Date(zonedValue);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(
    SHANGHAI_DATE_TIME_FORMAT.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function datetimeIsoValue(value: string): string | null {
  if (value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}:00+08:00`);
  if (!Number.isFinite(date.getTime())) return null;
  return datetimeInputValue(date.toISOString()) === value ? date.toISOString() : null;
}

const SHANGHAI_DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function MoneyInput({
  label,
  value,
  required,
  disabled,
  onChange,
  onValidityChange,
}: {
  label: string;
  value: number | null;
  required: boolean;
  disabled: boolean;
  onChange: (value: CustomFieldValue | null) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const unitId = useId();
  const errorId = useId();
  const [rawValue, setRawValue] = useState(() => formatMoneyValue(value));
  const [error, setError] = useState('');

  useEffect(() => {
    const current = parseMoneyValue(rawValue);
    if (current.valid && current.value === value) return;
    setRawValue(formatMoneyValue(value));
    setError('');
    onValidityChange?.(true);
    // The parent callback is intentionally excluded: external value changes reset validity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span className="custom-field__money">
      <input
        aria-label={label}
        aria-required={required}
        aria-describedby={error ? `${unitId} ${errorId}` : unitId}
        aria-invalid={error ? 'true' : undefined}
        type="text"
        inputMode="decimal"
        pattern="[0-9]+([.][0-9]{0,2})?"
        value={rawValue}
        disabled={disabled}
        onChange={(event) => {
          const nextRawValue = event.target.value;
          const parsed = parseMoneyValue(nextRawValue);
          setRawValue(nextRawValue);
          if (!parsed.valid) {
            setError('金额最多支持两位小数，且不能为负数');
            onValidityChange?.(false);
            return;
          }
          setError('');
          onValidityChange?.(true);
          onChange(parsed.value);
        }}
      />
      <small className="custom-field__money-unit" id={unitId}>元</small>
      {error && (
        <small className="custom-field__money-error" id={errorId} role="alert">
          {error}
        </small>
      )}
    </span>
  );
}

type ParsedMoneyValue =
  | { valid: true; value: number | null }
  | { valid: false };

function parseMoneyValue(rawValue: string): ParsedMoneyValue {
  if (rawValue === '') return { valid: true, value: null };
  const match = /^(\d+)(?:\.(\d{0,2}))?$/u.exec(rawValue);
  if (!match) return { valid: false };
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = (BigInt(match[1]) * 100n) + BigInt(fraction || '0');
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return { valid: false };
  return { valid: true, value: Number(cents) };
}

function formatMoneyValue(value: number | null): string {
  if (value === null) return '';
  const yuan = Math.floor(value / 100);
  const cents = value % 100;
  return `${yuan}.${String(cents).padStart(2, '0')}`;
}
