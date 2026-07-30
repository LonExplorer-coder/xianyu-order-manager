import type { OrderSummary } from './contracts';
import type {
  CustomFieldDefinition,
  CustomFieldType,
  CustomFieldValue,
  CustomFieldValueRecord,
} from './custom-fields';
import type {
  OrderItemWorkbenchItem,
  OrderItemWorkbenchQuery,
  OrderWorkbenchQuery,
} from './order-workbench';
import {
  QUANTITY_SOURCES,
  quantitySourceFromLegacy,
  quantitySourceLabel,
} from './quantity-source';

export const TABLE_TEMPLATE_GRANULARITIES = ['order', 'order_item'] as const;

export type TableTemplateGranularity = (typeof TABLE_TEMPLATE_GRANULARITIES)[number];

export type OrderBuiltinTableFieldId =
  | 'order_number'
  | 'alipay_transaction_number'
  | 'platform'
  | 'seller_account'
  | 'buyer_nickname'
  | 'recipient'
  | 'phone'
  | 'address'
  | 'product_summary'
  | 'initial_source_recognition_status'
  | 'platform_transaction_status'
  | 'fulfillment_status'
  | 'lifecycle_status'
  | 'ordered_at'
  | 'paid_at'
  | 'created_at';

export type OrderItemBuiltinTableFieldId =
  | 'order_number'
  | 'product_title'
  | 'product_spec'
  | 'unit_price'
  | 'quantity'
  | 'quantity_source';

export type BuiltinTableFieldId =
  | OrderBuiltinTableFieldId
  | OrderItemBuiltinTableFieldId;

export type ComputedTableFieldId =
  | 'item_quantity_total'
  | 'order_total'
  | 'item_subtotal';

export type TableFieldReference =
  | { kind: 'builtin'; key: BuiltinTableFieldId }
  | { kind: 'computed'; key: ComputedTableFieldId }
  | { kind: 'custom'; definitionId: string };

export type TableTemplateColumn = {
  field: TableFieldReference;
  displayName: string;
};

export const DEFAULT_ORDER_ITEM_TABLE_COLUMNS: TableTemplateColumn[] = [
  { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
  { field: { kind: 'builtin', key: 'product_title' }, displayName: '原始商品标题' },
  { field: { kind: 'builtin', key: 'product_spec' }, displayName: '原始款式／规格' },
  { field: { kind: 'builtin', key: 'unit_price' }, displayName: '商品单价' },
  { field: { kind: 'builtin', key: 'quantity' }, displayName: '数量' },
  { field: { kind: 'builtin', key: 'quantity_source' }, displayName: '数量来源' },
  { field: { kind: 'computed', key: 'item_subtotal' }, displayName: '商品小计' },
];

type OrderTableTemplateConfiguration = {
  name: string;
  granularity: 'order';
  columns: TableTemplateColumn[];
  query: OrderWorkbenchQuery;
};

type OrderItemTableTemplateConfiguration = {
  name: string;
  granularity: 'order_item';
  columns: TableTemplateColumn[];
  query: OrderItemWorkbenchQuery;
};

export type CreateTableTemplateInput =
  | OrderTableTemplateConfiguration
  | OrderItemTableTemplateConfiguration;

export type UpdateTableTemplateInput = {
  name: string;
  columns: TableTemplateColumn[];
  query: OrderWorkbenchQuery | OrderItemWorkbenchQuery;
};

export type TableTemplate =
  | (OrderTableTemplateConfiguration & {
    id: string;
    createdAt: string;
    updatedAt: string;
  })
  | (OrderItemTableTemplateConfiguration & {
    id: string;
    createdAt: string;
    updatedAt: string;
  });

export type AvailableTableField = {
  reference: TableFieldReference;
  defaultLabel: string;
  valueType: CustomFieldType;
};

export type TableCellValue = CustomFieldValue | null;

export type CustomFieldValueIndex = ReadonlyMap<
  string,
  ReadonlyMap<string, CustomFieldValueRecord>
>;

export type CustomFieldValueProjectionSource =
  | readonly CustomFieldValueRecord[]
  | CustomFieldValueIndex;

const CUSTOM_FIELD_VALUE_INDEX_CACHE = new WeakMap<
  readonly CustomFieldValueRecord[],
  CustomFieldValueIndex
>();

type FixedTableField = AvailableTableField & {
  granularity: TableTemplateGranularity;
};

const ORDER_BUILTIN_FIELDS = [
  fixedField('order', 'builtin', 'order_number', '订单号', 'text'),
  fixedField('order', 'builtin', 'alipay_transaction_number', '支付宝交易号', 'text'),
  fixedField('order', 'builtin', 'platform', '平台', 'text'),
  fixedField('order', 'builtin', 'seller_account', '卖家账号', 'text'),
  fixedField('order', 'builtin', 'buyer_nickname', '买家昵称', 'text'),
  fixedField('order', 'builtin', 'recipient', '收件人', 'text'),
  fixedField('order', 'builtin', 'phone', '手机号', 'text'),
  fixedField('order', 'builtin', 'address', '收货地址', 'text'),
  fixedField('order', 'builtin', 'product_summary', '商品摘要', 'text'),
  fixedField('order', 'builtin', 'initial_source_recognition_status', '识别状态', 'text'),
  fixedField('order', 'builtin', 'platform_transaction_status', '平台交易状态', 'text'),
  fixedField('order', 'builtin', 'fulfillment_status', '履约状态', 'text'),
  fixedField('order', 'builtin', 'lifecycle_status', '订单状态', 'text'),
  fixedField('order', 'builtin', 'ordered_at', '下单时间', 'datetime'),
  fixedField('order', 'builtin', 'paid_at', '付款时间', 'datetime'),
  fixedField('order', 'builtin', 'created_at', '入库时间', 'datetime'),
] as const satisfies readonly FixedTableField[];

const ORDER_COMPUTED_FIELDS = [
  fixedField('order', 'computed', 'item_quantity_total', '商品总数量', 'number'),
  fixedField('order', 'computed', 'order_total', '订单总额', 'money'),
] as const satisfies readonly FixedTableField[];

const ORDER_ITEM_BUILTIN_FIELDS = [
  fixedField('order_item', 'builtin', 'order_number', '订单号', 'text'),
  fixedField('order_item', 'builtin', 'product_title', '原始商品标题', 'text'),
  fixedField('order_item', 'builtin', 'product_spec', '原始款式／规格', 'text'),
  fixedField('order_item', 'builtin', 'unit_price', '商品单价', 'money'),
  fixedField('order_item', 'builtin', 'quantity', '数量', 'number'),
  fixedField('order_item', 'builtin', 'quantity_source', '数量来源', 'text'),
] as const satisfies readonly FixedTableField[];

const ORDER_ITEM_COMPUTED_FIELDS = [
  fixedField('order_item', 'computed', 'item_subtotal', '商品小计', 'money'),
] as const satisfies readonly FixedTableField[];

const FIXED_FIELDS: readonly FixedTableField[] = [
  ...ORDER_BUILTIN_FIELDS,
  ...ORDER_COMPUTED_FIELDS,
  ...ORDER_ITEM_BUILTIN_FIELDS,
  ...ORDER_ITEM_COMPUTED_FIELDS,
];

const ORDER_QUERY_KEYS = [
  'text',
  'buyerText',
  'productText',
  'dateField',
  'dateFrom',
  'dateTo',
  'platform',
  'sellerAccount',
  'initialSourceRecognitionStatus',
  'platformTransactionStatus',
  'fulfillmentStatus',
  'lifecycleStatus',
  'sortField',
  'sortDirection',
  'customFieldFilter',
  'customFieldSort',
] as const;

const ORDER_ITEM_QUERY_KEYS = [
  'sourceTitle',
  'sourceSpec',
  'unitPriceCents',
  'quantity',
  'quantitySource',
  'sortField',
  'sortDirection',
  'customFieldFilter',
  'customFieldSort',
] as const;

const ORDER_DATE_FIELDS = ['ordered_at', 'paid_at', 'created_at'] as const;
const ORDER_SORT_FIELDS = [
  ...ORDER_DATE_FIELDS,
  'amount',
  'platform',
  'seller_account',
  'buyer',
  'product',
  'initial_source_recognition_status',
  'platform_transaction_status',
  'fulfillment_status',
  'lifecycle_status',
] as const;
const RECOGNITION_STATUSES = [
  'waiting_recognition',
  'recognizing',
  'validating',
  'awaiting_confirmation',
  'imported',
  'waiting_retry',
  'failed',
  'duplicate_skipped',
  'cancelled',
] as const;
const PLATFORM_TRANSACTION_STATUSES = ['paid', 'cancelled', 'refunded', 'unknown'] as const;
const FULFILLMENT_STATUSES = ['pending_shipment', 'shipped', 'unknown'] as const;
const LIFECYCLE_STATUSES = ['active', 'trashed', 'deleted', 'all'] as const;
const SORT_DIRECTIONS = ['asc', 'desc'] as const;
const ORDER_ITEM_SORT_FIELDS = [
  'source_title',
  'source_spec',
  'unit_price',
  'quantity',
  'quantity_source',
] as const;

const MAX_TEMPLATE_NAME_LENGTH = 100;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_COLUMNS = 200;
const MAX_QUERY_TEXT_LENGTH = 20_000;
const MAX_CUSTOM_FILTER_ARRAY_LENGTH = 100;

export function availableTableFields(
  granularity: TableTemplateGranularity,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): AvailableTableField[] {
  if (!TABLE_TEMPLATE_GRANULARITIES.includes(granularity)) {
    throw new Error('表格模板数据粒度无效');
  }
  const fixed = FIXED_FIELDS
    .filter((field) => field.granularity === granularity)
    .map(({ granularity: _granularity, ...field }) => cloneAvailableField(field));
  const custom = customFieldDefinitions
    .filter((definition) => definition.granularity === granularity)
    .map((definition): AvailableTableField => ({
      reference: { kind: 'custom', definitionId: definition.id },
      defaultLabel: definition.name,
      valueType: definition.type,
    }));
  return [...fixed, ...custom];
}

export function normalizeCreateTableTemplateInput(
  input: unknown,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): CreateTableTemplateInput {
  const record = strictRecord(
    input,
    '表格模板',
    ['name', 'granularity', 'columns', 'query'],
  );
  const name = nonEmptyText(record.name, '模板名称', MAX_TEMPLATE_NAME_LENGTH);
  const granularity = tableTemplateGranularity(record.granularity);
  const columns = normalizeColumns(record.columns, granularity, customFieldDefinitions);
  const query = normalizeQuery(record.query, granularity, customFieldDefinitions);
  if (granularity === 'order') {
    return { name, granularity, columns, query: query as OrderWorkbenchQuery };
  }
  return { name, granularity, columns, query: query as OrderItemWorkbenchQuery };
}

export function normalizeUpdateTableTemplateInput(
  idValue: unknown,
  granularityValue: unknown,
  input: unknown,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): UpdateTableTemplateInput {
  nonEmptyText(idValue, '模板 ID', MAX_IDENTIFIER_LENGTH);
  const granularity = tableTemplateGranularity(granularityValue);
  const record = strictRecord(
    input,
    '表格模板更新',
    ['name', 'columns', 'query'],
  );
  const normalized = normalizeCreateTableTemplateInput({
    name: record.name,
    granularity,
    columns: record.columns,
    query: record.query,
  }, customFieldDefinitions);
  return {
    name: normalized.name,
    columns: normalized.columns,
    query: normalized.query,
  };
}

export function fieldReferenceKey(reference: TableFieldReference): string {
  switch (reference.kind) {
    case 'builtin':
    case 'computed':
      return `${reference.kind}:${reference.key}`;
    case 'custom':
      return `custom:${reference.definitionId}`;
  }
}

export function tableTemplateNameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export function createCustomFieldValueIndex(
  customFieldValues: readonly CustomFieldValueRecord[],
): CustomFieldValueIndex {
  const index = new Map<string, Map<string, CustomFieldValueRecord>>();
  for (const record of customFieldValues) {
    const ownerId = record.orderItemId ?? record.orderId;
    if (!ownerId) continue;
    let valuesByDefinition = index.get(ownerId);
    if (!valuesByDefinition) {
      valuesByDefinition = new Map<string, CustomFieldValueRecord>();
      index.set(ownerId, valuesByDefinition);
    }
    if (!valuesByDefinition.has(record.definitionId)) {
      valuesByDefinition.set(record.definitionId, record);
    }
  }
  return index;
}

export function projectOrderTableCell(
  order: OrderSummary,
  reference: TableFieldReference,
  customFieldValues: CustomFieldValueProjectionSource = [],
): TableCellValue {
  if (reference.kind === 'custom') {
    return indexedCustomFieldValue(
      customFieldValues,
      order.id,
      reference.definitionId,
    );
  }
  if (reference.kind === 'computed') {
    if (reference.key === 'item_quantity_total') return order.itemCount;
    if (reference.key === 'order_total') return order.amountCents;
    return null;
  }
  switch (reference.key) {
    case 'order_number': return order.orderNumber;
    case 'alipay_transaction_number': return order.alipayTransactionNumber;
    case 'platform': return order.platform;
    case 'seller_account': return order.sellerAccount;
    case 'buyer_nickname': return order.buyerNickname;
    case 'recipient': return order.recipient;
    case 'phone': return order.phone;
    case 'address': return order.addressOriginal;
    case 'product_summary': return order.items
      .map((item) => `${item.sourceTitle}${item.sourceSpec ? ` · ${item.sourceSpec}` : ''} ×${item.quantity}`)
      .join('；');
    case 'initial_source_recognition_status': return order.initialSourceRecognitionStatus;
    case 'platform_transaction_status': return order.platformTransactionStatus;
    case 'fulfillment_status': return order.fulfillmentStatus;
    case 'lifecycle_status': return order.lifecycleStatus;
    case 'ordered_at': return order.orderedAtNormalized;
    case 'paid_at': return order.paidAtNormalized;
    case 'created_at': return order.createdAt;
    default: return null;
  }
}

export function projectOrderItemTableCell(
  item: OrderItemWorkbenchItem & { orderNumber?: string },
  reference: TableFieldReference,
  customFieldValues: CustomFieldValueProjectionSource = [],
): TableCellValue {
  if (reference.kind === 'custom') {
    return indexedCustomFieldValue(
      customFieldValues,
      item.id,
      reference.definitionId,
    );
  }
  if (reference.kind === 'computed') {
    return reference.key === 'item_subtotal' ? item.subtotalCents : null;
  }
  switch (reference.key) {
    case 'order_number': return item.orderNumber ?? null;
    case 'product_title': return item.sourceTitle;
    case 'product_spec': return item.sourceSpec;
    case 'unit_price': return item.unitPriceCents;
    case 'quantity': return item.quantity;
    case 'quantity_source': return quantitySourceLabel(
      item.quantitySource ?? quantitySourceFromLegacy(item.quantityInferred),
    );
    default: return null;
  }
}

function indexedCustomFieldValue(
  source: CustomFieldValueProjectionSource,
  ownerId: string,
  definitionId: string,
): CustomFieldValue | null {
  let index: CustomFieldValueIndex;
  if (Array.isArray(source)) {
    index = CUSTOM_FIELD_VALUE_INDEX_CACHE.get(source) ?? createCustomFieldValueIndex(source);
    CUSTOM_FIELD_VALUE_INDEX_CACHE.set(source, index);
  } else {
    index = source as CustomFieldValueIndex;
  }
  return index.get(ownerId)?.get(definitionId)?.value ?? null;
}

function fixedField(
  granularity: TableTemplateGranularity,
  kind: 'builtin' | 'computed',
  key: BuiltinTableFieldId | ComputedTableFieldId,
  defaultLabel: string,
  valueType: CustomFieldType,
): FixedTableField {
  return {
    granularity,
    reference: kind === 'builtin'
      ? { kind, key: key as BuiltinTableFieldId }
      : { kind, key: key as ComputedTableFieldId },
    defaultLabel,
    valueType,
  };
}

function cloneAvailableField(field: AvailableTableField): AvailableTableField {
  return {
    ...field,
    reference: { ...field.reference },
  };
}

function normalizeColumns(
  value: unknown,
  granularity: TableTemplateGranularity,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): TableTemplateColumn[] {
  if (!Array.isArray(value)) throw new Error('表格模板列必须是数组');
  if (value.length === 0) throw new Error('表格模板至少选择一个字段');
  if (value.length > MAX_COLUMNS) throw new Error(`表格模板字段不能超过 ${MAX_COLUMNS} 个`);
  const availableKeys = new Set(
    availableTableFields(granularity, customFieldDefinitions)
      .map(({ reference }) => fieldReferenceKey(reference)),
  );
  const columns = value.map((entry): TableTemplateColumn => {
    const record = strictRecord(entry, '表格模板列', ['field', 'displayName']);
    const field = normalizeFieldReference(record.field);
    const key = fieldReferenceKey(field);
    if (!availableKeys.has(key)) {
      if (field.kind === 'custom') {
        const definition = customFieldDefinitions.find(({ id }) => id === field.definitionId);
        if (!definition) throw new Error(`自定义字段不存在：${field.definitionId}`);
        throw new Error('自定义字段数据粒度与表格模板不一致');
      }
      throw new Error(`表格模板字段无效：${key}`);
    }
    return {
      field,
      displayName: nonEmptyText(record.displayName, '字段显示名称', MAX_DISPLAY_NAME_LENGTH),
    };
  });
  rejectDuplicates(columns.map(({ field }) => fieldReferenceKey(field)), '表格模板字段不能重复');
  rejectDuplicates(columns.map(({ displayName }) => displayName), '字段显示名称不能重复');
  return columns;
}

function normalizeFieldReference(value: unknown): TableFieldReference {
  const base = strictRecord(value, '字段引用', ['kind', 'key', 'definitionId']);
  if (base.kind === 'custom') {
    assertOnlyKeys(base, '自定义字段引用', ['kind', 'definitionId']);
    return {
      kind: 'custom',
      definitionId: nonEmptyText(base.definitionId, '自定义字段 ID', MAX_IDENTIFIER_LENGTH),
    };
  }
  if (base.kind === 'builtin' || base.kind === 'computed') {
    assertOnlyKeys(base, '固定字段引用', ['kind', 'key']);
    const key = nonEmptyText(base.key, '固定字段 key', MAX_IDENTIFIER_LENGTH);
    return base.kind === 'builtin'
      ? { kind: 'builtin', key: key as BuiltinTableFieldId }
      : { kind: 'computed', key: key as ComputedTableFieldId };
  }
  throw new Error('字段引用类型无效');
}

function normalizeQuery(
  value: unknown,
  granularity: TableTemplateGranularity,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): OrderWorkbenchQuery | OrderItemWorkbenchQuery {
  const allowedKeys = granularity === 'order' ? ORDER_QUERY_KEYS : ORDER_ITEM_QUERY_KEYS;
  const record = strictRecord(value, '表格模板查询', allowedKeys);
  const common = normalizeCustomQueryParts(record, granularity, customFieldDefinitions);
  if (granularity === 'order_item') {
    const query: OrderItemWorkbenchQuery = { ...common };
    if (record.sourceTitle !== undefined) {
      query.sourceTitle = nonEmptySourceText(
        record.sourceTitle,
        '原始商品标题',
        MAX_QUERY_TEXT_LENGTH,
      );
    }
    if (record.sourceSpec !== undefined) {
      query.sourceSpec = nonEmptySourceText(
        record.sourceSpec,
        '原始款式或规格',
        MAX_QUERY_TEXT_LENGTH,
      );
    }
    if (record.unitPriceCents !== undefined) {
      query.unitPriceCents = integerInRange(record.unitPriceCents, '商品单价', 0);
    }
    if (record.quantity !== undefined) {
      query.quantity = integerInRange(record.quantity, '商品数量', 1);
    }
    assignOptionalEnum(
      query,
      'quantitySource',
      record.quantitySource,
      QUANTITY_SOURCES,
      '数量来源',
    );
    assignOptionalEnum(
      query,
      'sortField',
      record.sortField,
      ORDER_ITEM_SORT_FIELDS,
      '商品明细排序字段',
    );
    assignOptionalEnum(query, 'sortDirection', record.sortDirection, SORT_DIRECTIONS, '排序方向');
    if (query.sortField && query.customFieldSort) {
      throw new Error('商品明细一次只能使用一种排序');
    }
    return query;
  }

  const query: OrderWorkbenchQuery = { ...common };
  assignOptionalText(query, 'text', record.text, '综合搜索');
  assignOptionalText(query, 'buyerText', record.buyerText, '买家搜索');
  assignOptionalText(query, 'productText', record.productText, '商品搜索');
  assignOptionalEnum(query, 'dateField', record.dateField, ORDER_DATE_FIELDS, '日期字段');
  assignOptionalDate(query, 'dateFrom', record.dateFrom, '开始日期');
  assignOptionalDate(query, 'dateTo', record.dateTo, '结束日期');
  if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
    throw new Error('开始日期不能晚于结束日期');
  }
  assignOptionalEnum(query, 'platform', record.platform, ['xianyu'] as const, '平台');
  assignOptionalText(query, 'sellerAccount', record.sellerAccount, '卖家账号');
  assignOptionalEnum(
    query,
    'initialSourceRecognitionStatus',
    record.initialSourceRecognitionStatus,
    RECOGNITION_STATUSES,
    '识别状态',
  );
  assignOptionalEnum(
    query,
    'platformTransactionStatus',
    record.platformTransactionStatus,
    PLATFORM_TRANSACTION_STATUSES,
    '平台交易状态',
  );
  assignOptionalEnum(
    query,
    'fulfillmentStatus',
    record.fulfillmentStatus,
    FULFILLMENT_STATUSES,
    '履约状态',
  );
  assignOptionalEnum(
    query,
    'lifecycleStatus',
    record.lifecycleStatus,
    LIFECYCLE_STATUSES,
    '生命周期状态',
  );
  assignOptionalEnum(query, 'sortField', record.sortField, ORDER_SORT_FIELDS, '排序字段');
  assignOptionalEnum(query, 'sortDirection', record.sortDirection, SORT_DIRECTIONS, '排序方向');
  return query;
}

function normalizeCustomQueryParts(
  record: Record<string, unknown>,
  granularity: TableTemplateGranularity,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): Pick<OrderItemWorkbenchQuery, 'customFieldFilter' | 'customFieldSort'> {
  const result: Pick<OrderItemWorkbenchQuery, 'customFieldFilter' | 'customFieldSort'> = {};
  if (record.customFieldFilter !== undefined) {
    const filter = strictRecord(
      record.customFieldFilter,
      '自定义字段筛选',
      ['definitionId', 'value'],
    );
    const definitionId = nonEmptyText(
      filter.definitionId,
      '自定义筛选字段 ID',
      MAX_IDENTIFIER_LENGTH,
    );
    assertCustomDefinitionGranularity(definitionId, granularity, customFieldDefinitions, '筛选');
    result.customFieldFilter = {
      definitionId,
      value: normalizeCustomFilterValue(filter.value),
    };
  }
  if (record.customFieldSort !== undefined) {
    const sort = strictRecord(
      record.customFieldSort,
      '自定义字段排序',
      ['definitionId', 'direction'],
    );
    const definitionId = nonEmptyText(
      sort.definitionId,
      '自定义排序字段 ID',
      MAX_IDENTIFIER_LENGTH,
    );
    assertCustomDefinitionGranularity(definitionId, granularity, customFieldDefinitions, '排序');
    if (!SORT_DIRECTIONS.includes(sort.direction as 'asc' | 'desc')) {
      throw new Error('自定义字段排序方向无效');
    }
    result.customFieldSort = {
      definitionId,
      direction: sort.direction as 'asc' | 'desc',
    };
  }
  return result;
}

function assertCustomDefinitionGranularity(
  definitionId: string,
  granularity: TableTemplateGranularity,
  customFieldDefinitions: readonly CustomFieldDefinition[],
  usage: string,
): void {
  const definition = customFieldDefinitions.find(({ id }) => id === definitionId);
  if (!definition) throw new Error(`自定义${usage}字段不存在：${definitionId}`);
  if (definition.granularity !== granularity) {
    throw new Error(`自定义${usage}字段数据粒度与表格模板不一致`);
  }
}

function normalizeCustomFilterValue(value: unknown): CustomFieldValue {
  if (typeof value === 'string') {
    if (value.length > MAX_QUERY_TEXT_LENGTH) throw new Error('自定义字段筛选文本过长');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('自定义字段筛选数字必须是有限数字');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_CUSTOM_FILTER_ARRAY_LENGTH) {
      throw new Error(`自定义字段筛选值不能超过 ${MAX_CUSTOM_FILTER_ARRAY_LENGTH} 个`);
    }
    if (!value.every((entry) => typeof entry === 'string')) {
      throw new Error('自定义字段筛选数组只能包含文本');
    }
    return [...value];
  }
  throw new Error('自定义字段筛选值无效');
}

function strictRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, label, allowedKeys);
  return record;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  label: string,
  allowedKeys: readonly string[],
): void {
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknownKey) throw new Error(`${label}包含未知属性：${unknownKey}`);
}

function tableTemplateGranularity(value: unknown): TableTemplateGranularity {
  if (!TABLE_TEMPLATE_GRANULARITIES.includes(value as TableTemplateGranularity)) {
    throw new Error('表格模板数据粒度无效');
  }
  return value as TableTemplateGranularity;
}

function nonEmptyText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
}

function nonEmptySourceText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label}不能为空`);
  if (trimmed.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return trimmed;
}

function rejectDuplicates(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function assignOptionalText<TKey extends keyof OrderWorkbenchQuery>(
  target: OrderWorkbenchQuery,
  key: TKey,
  value: unknown,
  label: string,
): void {
  if (value === undefined) return;
  target[key] = nonEmptyText(value, label, MAX_QUERY_TEXT_LENGTH) as OrderWorkbenchQuery[TKey];
}

function assignOptionalEnum<
  TQuery extends OrderWorkbenchQuery | OrderItemWorkbenchQuery,
  TKey extends keyof TQuery,
  TValue extends string,
>(
  target: TQuery,
  key: TKey,
  value: unknown,
  allowed: readonly TValue[],
  label: string,
): void {
  if (value === undefined) return;
  if (!allowed.includes(value as TValue)) throw new Error(`${label}无效`);
  target[key] = value as TQuery[TKey];
}

function integerInRange(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label}无效`);
  }
  return value as number;
}

function assignOptionalDate<TKey extends 'dateFrom' | 'dateTo'>(
  target: OrderWorkbenchQuery,
  key: TKey,
  value: unknown,
  label: string,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !isCalendarDate(value)) throw new Error(`${label}无效`);
  target[key] = value;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
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
  return day <= daysInMonth;
}
