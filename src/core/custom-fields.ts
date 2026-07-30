export const CUSTOM_FIELD_GRANULARITIES = ['order', 'order_item'] as const;

export type CustomFieldGranularity = (typeof CUSTOM_FIELD_GRANULARITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'money',
  'datetime',
  'single_select',
  'multi_select',
  'checkbox',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export type CustomFieldValue = string | number | boolean | string[];

export type CustomFieldDefinition = {
  id: string;
  name: string;
  granularity: CustomFieldGranularity;
  type: CustomFieldType;
  required: boolean;
  defaultValue: CustomFieldValue | null;
  options: string[];
  createdAt: string;
  updatedAt: string;
};

export type CreateCustomFieldDefinitionInput = Omit<
  CustomFieldDefinition,
  'id' | 'createdAt' | 'updatedAt'
>;

export type CustomFieldValueRecord = {
  definitionId: string;
  orderId: string | null;
  orderItemId: string | null;
  value: CustomFieldValue;
  createdAt: string;
  updatedAt: string;
};

export type SaveCustomFieldValuesInput = {
  orderId: string;
  orderValues: Array<{
    definitionId: string;
    value: CustomFieldValue | null;
  }>;
  itemValues: Array<{
    definitionId: string;
    orderItemId: string;
    value: CustomFieldValue | null;
  }>;
};

export type DraftCustomFieldValues = {
  orderValues: Array<{
    definitionId: string;
    value: CustomFieldValue | null;
  }>;
  itemValues: Array<{
    definitionId: string;
    draftItemId: string;
    value: CustomFieldValue | null;
  }>;
};

export type ConfirmDraftCustomFieldOptions = {
  enforceRequiredItemFields?: boolean;
};

export type CustomFieldFilter = {
  definitionId: string;
  value: CustomFieldValue;
};

export type CustomFieldSort = {
  definitionId: string;
  direction: 'asc' | 'desc';
};

const MAX_FIELD_NAME_LENGTH = 80;
const MAX_OPTION_LENGTH = 120;
const MAX_OPTIONS = 100;
const MAX_TEXT_VALUE_LENGTH = 20_000;

export function normalizeCustomFieldDefinitionInput(
  input: CreateCustomFieldDefinitionInput,
): CreateCustomFieldDefinitionInput {
  if (!input || typeof input !== 'object') throw new Error('自定义字段定义无效');
  const name = normalizeNonEmptyText(input.name, '字段名称', MAX_FIELD_NAME_LENGTH);
  if (!isCustomFieldGranularity(input.granularity)) {
    throw new Error('自定义字段数据粒度无效');
  }
  if (!isCustomFieldType(input.type)) throw new Error('自定义字段类型无效');
  if (typeof input.required !== 'boolean') throw new Error('自定义字段必填声明无效');
  if (!Array.isArray(input.options)) throw new Error('自定义字段可选项无效');

  const options = input.options.map((option) => (
    normalizeNonEmptyText(option, '可选项', MAX_OPTION_LENGTH)
  ));
  if (options.length > MAX_OPTIONS) throw new Error(`自定义字段可选项不能超过 ${MAX_OPTIONS} 个`);
  if (new Set(options).size !== options.length) throw new Error('自定义字段可选项不能重复');
  const isSelect = input.type === 'single_select' || input.type === 'multi_select';
  if (isSelect && options.length === 0) throw new Error('单选或多选字段至少需要一个可选项');
  if (!isSelect && options.length > 0) throw new Error('只有单选或多选字段可以设置可选项');

  const defaultValue = input.defaultValue === null
    ? null
    : normalizeCustomFieldValue(input.type, input.defaultValue, options);
  if (defaultValue !== null && isMissingCustomFieldValue(defaultValue)) {
    throw new Error('自定义字段的默认值不能为空');
  }

  return {
    name,
    granularity: input.granularity,
    type: input.type,
    required: input.required,
    defaultValue,
    options,
  };
}

export function isMissingCustomFieldValue(
  value: CustomFieldValue | null | undefined,
): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function normalizeCustomFieldValue(
  type: CustomFieldType,
  value: unknown,
  options: readonly string[],
): CustomFieldValue {
  switch (type) {
    case 'text': {
      if (typeof value !== 'string') throw new Error('文本字段值必须是文本');
      const normalized = value.normalize('NFKC');
      if (normalized.length > MAX_TEXT_VALUE_LENGTH) {
        throw new Error(`文本字段值不能超过 ${MAX_TEXT_VALUE_LENGTH} 个字符`);
      }
      return normalized;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('数字字段值必须是有限数字');
      }
      return value;
    case 'money':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('金额字段值必须使用非负整数分');
      }
      return value;
    case 'datetime': {
      if (typeof value !== 'string' || !isValidOffsetIsoDateTime(value)) {
        throw new Error('日期时间字段值必须是 ISO 8601 日期时间');
      }
      return new Date(value).toISOString();
    }
    case 'single_select': {
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new Error('单选字段值必须来自已定义的可选项');
      }
      return value;
    }
    case 'multi_select': {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        throw new Error('多选字段值必须是可选项数组');
      }
      if (new Set(value).size !== value.length) throw new Error('多选字段值不能重复');
      const selected = new Set(value);
      if (![...selected].every((entry) => options.includes(entry))) {
        throw new Error('多选字段值必须来自已定义的可选项');
      }
      return options.filter((option) => selected.has(option));
    }
    case 'checkbox':
      if (typeof value !== 'boolean') throw new Error('复选框字段值必须是布尔值');
      return value;
  }
}

export function parseStoredCustomFieldValue(
  serialized: string,
  definition: Pick<CustomFieldDefinition, 'type' | 'options'>,
): CustomFieldValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error('数据库自定义字段值格式错误', { cause: error });
  }
  return normalizeCustomFieldValue(definition.type, parsed, definition.options);
}

export function isCustomFieldGranularity(value: unknown): value is CustomFieldGranularity {
  return CUSTOM_FIELD_GRANULARITIES.includes(value as CustomFieldGranularity);
}

export function isCustomFieldType(value: unknown): value is CustomFieldType {
  return CUSTOM_FIELD_TYPES.includes(value as CustomFieldType);
}

function normalizeNonEmptyText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
}

function isValidOffsetIsoDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (day < 1 || day > daysInMonth) return false;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
