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
import type {
  OpenShipmentGroup,
  ShipmentGroupCustomFieldValue,
  ShipmentGroupWorkbenchQuery,
} from './shipment-groups';
import {
  displayedProductSpecification,
  displayedProductTitle,
} from './product-standardization';
import {
  QUANTITY_SOURCES,
  quantitySourceFromLegacy,
  quantitySourceLabel,
} from './quantity-source';

export const TABLE_TEMPLATE_GRANULARITIES = [
  'order',
  'order_item',
  'shipment_group',
] as const;

export type TableTemplateGranularity = (typeof TABLE_TEMPLATE_GRANULARITIES)[number];

/** 按粒度记住的当前表格模板标识；缺键表示该粒度使用默认视图。 */
export type ActiveTableTemplateIds = Partial<Record<TableTemplateGranularity, string>>;

export type OrderBuiltinTableFieldId =
  | 'system_order_number'
  | 'readable_order_number'
  | 'order_number'
  | 'alipay_transaction_number'
  | 'platform'
  | 'seller_account'
  | 'buyer_nickname'
  | 'note'
  | 'recipient'
  | 'phone'
  | 'address'
  | 'product_summary'
  | 'repurchase'
  | 'recipient_total_spend'
  | 'recipient_total_refund'
  | 'initial_source_recognition_status'
  | 'platform_transaction_status'
  | 'fulfillment_status'
  | 'lifecycle_status'
  | 'ordered_at'
  | 'paid_at'
  | 'created_at';

export type OrderItemBuiltinTableFieldId =
  | 'system_order_number'
  | 'readable_order_number'
  | 'order_number'
  | 'item_sequence'
  | 'product_title'
  | 'product_spec'
  | 'sku'
  | 'standard_product_name'
  | 'standard_product_spec'
  | 'unit_price'
  | 'quantity'
  | 'quantity_source';

export type ShipmentGroupBuiltinTableFieldId =
  | 'shipment_group_id'
  | 'formation'
  | 'recipient'
  | 'phone'
  | 'address'
  | 'member_order_numbers'
  | 'purchase_batch'
  | 'product_summary';

export type BuiltinTableFieldId =
  | OrderBuiltinTableFieldId
  | OrderItemBuiltinTableFieldId
  | ShipmentGroupBuiltinTableFieldId;

export type ComputedTableFieldId =
  | 'item_quantity_total'
  | 'order_total'
  | 'item_subtotal'
  | 'shipment_summary'
  | 'logistics_summary'
  | 'aftersales_summary'
  | 'current_todo'
  | 'shipment_group_order_count'
  | 'shipment_group_total_quantity'
  | 'shipment_group_total_amount';

export type TableFieldReference =
  | { kind: 'builtin'; key: BuiltinTableFieldId }
  | { kind: 'computed'; key: ComputedTableFieldId }
  | { kind: 'custom'; definitionId: string };

export type TableTemplateColumn = {
  field: TableFieldReference;
  displayName: string;
};

export type DynamicProductTableGroup = {
  kind: 'dynamic_product_group';
  labels: {
    product: string;
    specification: string;
    quantity: string;
  };
};

export type TableTemplateLayoutItem =
  | TableTemplateColumn
  | DynamicProductTableGroup;

export const DEFAULT_DYNAMIC_PRODUCT_TABLE_GROUP: DynamicProductTableGroup = {
  kind: 'dynamic_product_group',
  labels: {
    product: '商品',
    specification: '款式或规格',
    quantity: '数量',
  },
};

export const DEFAULT_ORDER_TABLE_COLUMNS: TableTemplateLayoutItem[] = [
  { field: { kind: 'builtin', key: 'system_order_number' }, displayName: '系统订单编号' },
  { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
  { field: { kind: 'builtin', key: 'platform' }, displayName: '平台' },
  { field: { kind: 'builtin', key: 'seller_account' }, displayName: '卖家账号' },
  { field: { kind: 'builtin', key: 'buyer_nickname' }, displayName: '买家' },
  { field: { kind: 'builtin', key: 'recipient' }, displayName: '收件人' },
  { field: { kind: 'builtin', key: 'phone' }, displayName: '手机号' },
  { field: { kind: 'builtin', key: 'address' }, displayName: '收货地址' },
  DEFAULT_DYNAMIC_PRODUCT_TABLE_GROUP,
  { field: { kind: 'computed', key: 'item_quantity_total' }, displayName: '商品总数量' },
  { field: { kind: 'computed', key: 'order_total' }, displayName: '成交金额' },
  { field: { kind: 'builtin', key: 'initial_source_recognition_status' }, displayName: '初始来源识别状态' },
  { field: { kind: 'builtin', key: 'platform_transaction_status' }, displayName: '平台交易状态' },
  { field: { kind: 'builtin', key: 'fulfillment_status' }, displayName: '履约状态' },
  { field: { kind: 'builtin', key: 'lifecycle_status' }, displayName: '生命周期状态' },
  { field: { kind: 'builtin', key: 'ordered_at' }, displayName: '下单时间' },
];

export const DEFAULT_ORDER_ITEM_TABLE_COLUMNS: TableTemplateColumn[] = [
  { field: { kind: 'builtin', key: 'system_order_number' }, displayName: '系统订单编号' },
  { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
  { field: { kind: 'builtin', key: 'item_sequence' }, displayName: '商品序号' },
  { field: { kind: 'builtin', key: 'product_title' }, displayName: '原始商品标题' },
  { field: { kind: 'builtin', key: 'product_spec' }, displayName: '原始款式／规格' },
  { field: { kind: 'builtin', key: 'sku' }, displayName: 'SKU' },
  { field: { kind: 'builtin', key: 'standard_product_name' }, displayName: '标准商品名' },
  { field: { kind: 'builtin', key: 'standard_product_spec' }, displayName: '标准规格' },
  { field: { kind: 'builtin', key: 'unit_price' }, displayName: '商品单价' },
  { field: { kind: 'builtin', key: 'quantity' }, displayName: '数量' },
  { field: { kind: 'builtin', key: 'quantity_source' }, displayName: '数量来源' },
  { field: { kind: 'computed', key: 'item_subtotal' }, displayName: '商品小计' },
];

export const DEFAULT_SHIPMENT_GROUP_TABLE_COLUMNS: TableTemplateColumn[] = [
  { field: { kind: 'builtin', key: 'shipment_group_id' }, displayName: '发货组标识' },
  { field: { kind: 'builtin', key: 'formation' }, displayName: '成组方式' },
  { field: { kind: 'builtin', key: 'recipient' }, displayName: '最终收件人' },
  { field: { kind: 'builtin', key: 'phone' }, displayName: '手机号' },
  { field: { kind: 'builtin', key: 'address' }, displayName: '最终收货地址' },
  { field: { kind: 'builtin', key: 'member_order_numbers' }, displayName: '成员订单号' },
  { field: { kind: 'builtin', key: 'purchase_batch' }, displayName: '购买批次' },
  { field: { kind: 'builtin', key: 'product_summary' }, displayName: '商品汇总' },
  {
    field: { kind: 'computed', key: 'shipment_group_order_count' },
    displayName: '合并订单数',
  },
  {
    field: { kind: 'computed', key: 'shipment_group_total_quantity' },
    displayName: '商品总数量',
  },
  {
    field: { kind: 'computed', key: 'shipment_group_total_amount' },
    displayName: '合并总额',
  },
];

type OrderTableTemplateConfiguration = {
  name: string;
  granularity: 'order';
  columns: TableTemplateLayoutItem[];
  query: OrderWorkbenchQuery;
};

type OrderItemTableTemplateConfiguration = {
  name: string;
  granularity: 'order_item';
  columns: TableTemplateColumn[];
  query: OrderItemWorkbenchQuery;
};

type ShipmentGroupTableTemplateConfiguration = {
  name: string;
  granularity: 'shipment_group';
  columns: TableTemplateColumn[];
  query: ShipmentGroupWorkbenchQuery;
};

export type CreateTableTemplateInput =
  | OrderTableTemplateConfiguration
  | OrderItemTableTemplateConfiguration
  | ShipmentGroupTableTemplateConfiguration;

export type UpdateTableTemplateInput = {
  name: string;
  columns: TableTemplateLayoutItem[];
  query: OrderWorkbenchQuery | OrderItemWorkbenchQuery | ShipmentGroupWorkbenchQuery;
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
    })
  | (ShipmentGroupTableTemplateConfiguration & {
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

export type OrderTableProjectionColumn =
  | {
    kind: 'field';
    key: string;
    header: string;
    field: TableFieldReference;
    valueType: CustomFieldType | null;
  }
  | {
    kind: 'dynamic_product';
    key: string;
    header: string;
    itemIndex: number;
    value: 'product' | 'specification' | 'quantity';
    valueType: 'text' | 'number';
  };

export type OrderTableProjectionPlan = {
  maxItemCount: number;
  columns: OrderTableProjectionColumn[];
};

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

type ShipmentGroupCustomFieldValueIndex = ReadonlyMap<
  string,
  ReadonlyMap<string, ShipmentGroupCustomFieldValue>
>;

const SHIPMENT_GROUP_CUSTOM_FIELD_VALUE_INDEX_CACHE = new WeakMap<
  readonly ShipmentGroupCustomFieldValue[],
  ShipmentGroupCustomFieldValueIndex
>();

type FixedTableField = AvailableTableField & {
  granularity: TableTemplateGranularity;
};

const ORDER_BUILTIN_FIELDS = [
  fixedField('order', 'builtin', 'system_order_number', '系统订单编号', 'text'),
  fixedField('order', 'builtin', 'readable_order_number', '可读订单编号', 'text'),
  fixedField('order', 'builtin', 'order_number', '订单号', 'text'),
  fixedField('order', 'builtin', 'alipay_transaction_number', '支付宝交易号', 'text'),
  fixedField('order', 'builtin', 'platform', '平台', 'text'),
  fixedField('order', 'builtin', 'seller_account', '卖家账号', 'text'),
  fixedField('order', 'builtin', 'buyer_nickname', '买家昵称', 'text'),
  fixedField('order', 'builtin', 'note', '备注', 'text'),
  fixedField('order', 'builtin', 'recipient', '收件人', 'text'),
  fixedField('order', 'builtin', 'phone', '手机号', 'text'),
  fixedField('order', 'builtin', 'address', '收货地址', 'text'),
  fixedField('order', 'builtin', 'repurchase', '回购单', 'text'),
  fixedField('order', 'builtin', 'recipient_total_spend', '下单人累计消费', 'money'),
  fixedField('order', 'builtin', 'recipient_total_refund', '下单人累计退款', 'money'),
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
  fixedField('order', 'computed', 'shipment_summary', '发货概况', 'text'),
  fixedField('order', 'computed', 'logistics_summary', '物流概况', 'text'),
  fixedField('order', 'computed', 'aftersales_summary', '售后概况', 'text'),
  fixedField('order', 'computed', 'current_todo', '当前待办', 'text'),
] as const satisfies readonly FixedTableField[];

const ORDER_ITEM_BUILTIN_FIELDS = [
  fixedField('order_item', 'builtin', 'system_order_number', '系统订单编号', 'text'),
  fixedField('order_item', 'builtin', 'readable_order_number', '可读订单编号', 'text'),
  fixedField('order_item', 'builtin', 'order_number', '订单号', 'text'),
  fixedField('order_item', 'builtin', 'item_sequence', '商品序号', 'number'),
  fixedField('order_item', 'builtin', 'product_title', '原始商品标题', 'text'),
  fixedField('order_item', 'builtin', 'product_spec', '原始款式／规格', 'text'),
  fixedField('order_item', 'builtin', 'sku', 'SKU', 'text'),
  fixedField('order_item', 'builtin', 'standard_product_name', '标准商品名', 'text'),
  fixedField('order_item', 'builtin', 'standard_product_spec', '标准规格', 'text'),
  fixedField('order_item', 'builtin', 'unit_price', '商品单价', 'money'),
  fixedField('order_item', 'builtin', 'quantity', '数量', 'number'),
  fixedField('order_item', 'builtin', 'quantity_source', '数量来源', 'text'),
] as const satisfies readonly FixedTableField[];

const ORDER_ITEM_COMPUTED_FIELDS = [
  fixedField('order_item', 'computed', 'item_subtotal', '商品小计', 'money'),
] as const satisfies readonly FixedTableField[];

const SHIPMENT_GROUP_BUILTIN_FIELDS = [
  fixedField('shipment_group', 'builtin', 'shipment_group_id', '发货组标识', 'text'),
  fixedField('shipment_group', 'builtin', 'formation', '成组方式', 'text'),
  fixedField('shipment_group', 'builtin', 'recipient', '最终收件人', 'text'),
  fixedField('shipment_group', 'builtin', 'phone', '手机号', 'text'),
  fixedField('shipment_group', 'builtin', 'address', '最终收货地址', 'text'),
  fixedField('shipment_group', 'builtin', 'member_order_numbers', '成员订单号', 'text'),
  fixedField('shipment_group', 'builtin', 'purchase_batch', '购买批次', 'text'),
  fixedField('shipment_group', 'builtin', 'product_summary', '商品汇总', 'text'),
] as const satisfies readonly FixedTableField[];

const SHIPMENT_GROUP_COMPUTED_FIELDS = [
  fixedField('shipment_group', 'computed', 'shipment_group_order_count', '合并订单数', 'number'),
  fixedField('shipment_group', 'computed', 'shipment_group_total_quantity', '商品总数量', 'number'),
  fixedField('shipment_group', 'computed', 'shipment_group_total_amount', '合并总额', 'money'),
] as const satisfies readonly FixedTableField[];

const FIXED_FIELDS: readonly FixedTableField[] = [
  ...ORDER_BUILTIN_FIELDS,
  ...ORDER_COMPUTED_FIELDS,
  ...ORDER_ITEM_BUILTIN_FIELDS,
  ...ORDER_ITEM_COMPUTED_FIELDS,
  ...SHIPMENT_GROUP_BUILTIN_FIELDS,
  ...SHIPMENT_GROUP_COMPUTED_FIELDS,
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
  'repurchase',
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

const SHIPMENT_GROUP_QUERY_KEYS = [
  'text',
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
const FULFILLMENT_STATUSES = [
  'pending_shipment',
  'partially_shipped',
  'shipped',
  'delivered',
  'unknown',
] as const;
const LIFECYCLE_STATUSES = ['active', 'trashed', 'deleted', 'all'] as const;
const SORT_DIRECTIONS = ['asc', 'desc'] as const;
const ORDER_ITEM_SORT_FIELDS = [
  'source_title',
  'source_spec',
  'unit_price',
  'quantity',
  'quantity_source',
] as const;
const SHIPMENT_GROUP_SORT_FIELDS = [
  'recipient',
  'address',
  'order_count',
  'total_quantity',
  'total_amount',
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
  return normalizeTableTemplateInput(input, customFieldDefinitions, true);
}

export function normalizeStoredTableTemplateInput(
  input: unknown,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): CreateTableTemplateInput {
  return normalizeTableTemplateInput(input, customFieldDefinitions, false);
}

export function normalizeShipmentGroupWorkbenchQuery(
  value: unknown,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): ShipmentGroupWorkbenchQuery {
  return normalizeQuery(
    value,
    'shipment_group',
    customFieldDefinitions,
  ) as ShipmentGroupWorkbenchQuery;
}

function normalizeTableTemplateInput(
  input: unknown,
  customFieldDefinitions: readonly CustomFieldDefinition[],
  enforceFutureHeaderSafety: boolean,
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
    if (enforceFutureHeaderSafety) {
      assertOrderTableLayoutFutureHeaderSafety(columns);
    }
    return { name, granularity, columns, query: query as OrderWorkbenchQuery };
  }
  if (granularity === 'shipment_group') {
    return {
      name,
      granularity,
      columns: columns as TableTemplateColumn[],
      query: query as ShipmentGroupWorkbenchQuery,
    };
  }
  return {
    name,
    granularity,
    columns: columns as TableTemplateColumn[],
    query: query as OrderItemWorkbenchQuery,
  };
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

export function isDynamicProductTableGroup(
  item: TableTemplateLayoutItem,
): item is DynamicProductTableGroup {
  return 'kind' in item && item.kind === 'dynamic_product_group';
}

export function tableTemplateLayoutItemKey(item: TableTemplateLayoutItem): string {
  return isDynamicProductTableGroup(item)
    ? item.kind
    : fieldReferenceKey(item.field);
}

export function tableTemplateCustomFieldDefinitionIds(
  layout: readonly TableTemplateLayoutItem[],
): string[] {
  return layout.flatMap((item) => {
    if (isDynamicProductTableGroup(item)) return [];
    return item.field.kind === 'custom' ? [item.field.definitionId] : [];
  });
}

export function assertOrderTableLayoutFutureHeaderSafety(
  layout: readonly TableTemplateLayoutItem[],
): void {
  const group = layout.find(isDynamicProductTableGroup);
  if (!group || !isDynamicProductTableGroup(group)) return;
  const labels = Object.values(group.labels);
  for (let leftIndex = 0; leftIndex < labels.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < labels.length; rightIndex += 1) {
      const left = labels[leftIndex];
      const right = labels[rightIndex];
      if (
        left === right ||
        hasPositiveIntegerSuffix(left, right) ||
        hasPositiveIntegerSuffix(right, left)
      ) {
        throw new Error(
          `动态商品列组的基础表头“${left}”与“${right}”会在未来序号中冲突；` +
          '请修改其中一个基础表头后重试',
        );
      }
    }
  }
  for (const item of layout) {
    if (isDynamicProductTableGroup(item)) continue;
    const conflictingLabel = labels.find((label) => (
      hasPositiveIntegerSuffix(item.displayName, label)
    ));
    if (conflictingLabel) {
      throw new Error(
        `普通表头“${item.displayName}”会与动态商品列组“${conflictingLabel}”的未来序号表头冲突；` +
        '请修改普通表头或动态商品列组基础表头后重试',
      );
    }
  }
}

function hasPositiveIntegerSuffix(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && /^[1-9]\d*$/u.test(value.slice(prefix.length));
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
    if (reference.key === 'shipment_summary') return order.operations.shipmentSummary;
    if (reference.key === 'logistics_summary') return order.operations.logisticsSummary;
    if (reference.key === 'aftersales_summary') return order.operations.aftersalesSummary;
    if (reference.key === 'current_todo') return order.operations.currentTodo;
    return null;
  }
  switch (reference.key) {
    case 'system_order_number': return order.systemOrderNumber;
    case 'readable_order_number': return order.readableOrderNumber ?? null;
    case 'order_number': return order.orderNumber;
    case 'alipay_transaction_number': return order.alipayTransactionNumber;
    case 'platform': return order.platform;
    case 'seller_account': return order.sellerAccount;
    case 'buyer_nickname': return order.buyerNickname;
    case 'note': return order.note ?? '';
    case 'recipient': return order.recipient;
    case 'phone': return order.phone;
    case 'address': return order.addressOriginal;
    case 'repurchase': {
      const rank = order.spending?.repurchaseRank;
      if (rank === undefined || rank === null) return null;
      return purchaseBatchLabel(rank);
    }
    case 'recipient_total_spend': return order.spending?.totalSpendCents ?? null;
    case 'recipient_total_refund': return order.spending?.totalRefundCents ?? null;
    case 'product_summary': return order.items
      .map((item) => {
        const title = displayedProductTitle(item);
        const specification = displayedProductSpecification(item);
        return `${title}${specification ? ` · ${specification}` : ''} ×${item.quantity}`;
      })
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

/** 购买批次序号的统一展示文案；渲染端与导出共用，保持口径一致。 */
export function purchaseBatchLabel(rank: number): string {
  return rank === 1 ? '首次购买' : `回购（第 ${rank} 次购买）`;
}

export function projectShipmentGroupTableCell(
  group: OpenShipmentGroup,
  reference: TableFieldReference,
  customFieldValues: readonly ShipmentGroupCustomFieldValue[] = [],
): TableCellValue {
  if (reference.kind === 'custom') {
    const index = SHIPMENT_GROUP_CUSTOM_FIELD_VALUE_INDEX_CACHE.get(customFieldValues)
      ?? createShipmentGroupCustomFieldValueIndex(customFieldValues);
    SHIPMENT_GROUP_CUSTOM_FIELD_VALUE_INDEX_CACHE.set(customFieldValues, index);
    return index.get(group.id)?.get(reference.definitionId)?.value ?? null;
  }
  if (reference.kind === 'computed') {
    if (reference.key === 'shipment_group_order_count') return group.orderCount;
    if (reference.key === 'shipment_group_total_quantity') return group.totalQuantity;
    if (reference.key === 'shipment_group_total_amount') return group.totalAmountCents;
    return null;
  }
  switch (reference.key) {
    case 'shipment_group_id': return group.id;
    case 'formation': return group.formation === 'manual' ? '手工调整' : '自动成组';
    case 'recipient': return group.recipient;
    case 'phone': return group.phone;
    case 'address': return group.addressOriginal;
    case 'member_order_numbers': return group.orders.map(({ orderNumber }) => orderNumber).join('；');
    case 'purchase_batch': {
      const ranks = [...new Set(
        group.orders
          .map((order) => order.repurchaseRank)
          .filter((rank): rank is number => rank !== null),
      )].sort((left, right) => left - right);
      if (ranks.length === 0) return null;
      return ranks.map((rank) => purchaseBatchLabel(rank)).join(' · ');
    }
    case 'product_summary': return group.items.map((item) => (
      `${item.title}${item.specification ? ` · ${item.specification}` : ''} ×${item.quantity}`
    )).join('；');
    default: return null;
  }
}

function createShipmentGroupCustomFieldValueIndex(
  values: readonly ShipmentGroupCustomFieldValue[],
): ShipmentGroupCustomFieldValueIndex {
  const index = new Map<string, Map<string, ShipmentGroupCustomFieldValue>>();
  for (const value of values) {
    let valuesByDefinition = index.get(value.shipmentGroupId);
    if (!valuesByDefinition) {
      valuesByDefinition = new Map<string, ShipmentGroupCustomFieldValue>();
      index.set(value.shipmentGroupId, valuesByDefinition);
    }
    if (!valuesByDefinition.has(value.definitionId)) {
      valuesByDefinition.set(value.definitionId, value);
    }
  }
  return index;
}

export function createOrderTableProjectionPlan(
  layout: readonly TableTemplateLayoutItem[],
  orders: readonly OrderSummary[],
  customFieldDefinitions: readonly CustomFieldDefinition[] = [],
  maximumItemCount?: number,
): OrderTableProjectionPlan {
  const observedMaximumItemCount = orders.reduce(
    (maximum, order) => Math.max(maximum, order.items.length),
    0,
  );
  if (maximumItemCount !== undefined && (
    !Number.isSafeInteger(maximumItemCount)
    || maximumItemCount < observedMaximumItemCount
  )) {
    throw new Error('订单商品动态列数无效');
  }
  const maxItemCount = maximumItemCount ?? observedMaximumItemCount;
  const columns = layout.flatMap((item): OrderTableProjectionColumn[] => {
    if (!isDynamicProductTableGroup(item)) {
      return [{
        kind: 'field',
        key: fieldReferenceKey(item.field),
        header: item.displayName,
        field: { ...item.field },
        valueType: orderProjectionValueType(item.field, customFieldDefinitions),
      }];
    }
    const dimensions = [
      ['product', item.labels.product],
      ['specification', item.labels.specification],
      ['quantity', item.labels.quantity],
    ] as const;
    return Array.from({ length: maxItemCount }, (_, itemIndex) => (
      dimensions.map(([value, label]): OrderTableProjectionColumn => ({
        kind: 'dynamic_product',
        key: `dynamic_product_group:${value}:${itemIndex + 1}`,
        header: `${label}${itemIndex + 1}`,
        itemIndex,
        value,
        valueType: value === 'quantity' ? 'number' : 'text',
      }))
    )).flat();
  });
  const columnsByHeader = new Map<string, OrderTableProjectionColumn>();
  for (const column of columns) {
    const headerKey = column.header.normalize('NFKC').trim();
    const existing = columnsByHeader.get(headerKey);
    if (existing) {
      if (existing.kind === 'dynamic_product' || column.kind === 'dynamic_product') {
        throw new Error(
          `动态商品列组生成表头“${column.header}”与其他列冲突；` +
          '请修改动态商品列组的基础表头或冲突列名后重试',
        );
      }
      throw new Error(`表头“${column.header}”重复`);
    }
    columnsByHeader.set(headerKey, column);
  }
  return { maxItemCount, columns };
}

function orderProjectionValueType(
  reference: TableFieldReference,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): CustomFieldType | null {
  if (reference.kind === 'custom') {
    return customFieldDefinitions.find(({ id }) => id === reference.definitionId)?.type ?? null;
  }
  return FIXED_FIELDS.find((field) => (
    field.granularity === 'order' && fieldReferenceKey(field.reference) === fieldReferenceKey(reference)
  ))?.valueType ?? null;
}

export function projectOrderTableProjectionRow(
  plan: OrderTableProjectionPlan,
  order: OrderSummary,
  customFieldValues: CustomFieldValueProjectionSource = [],
): TableCellValue[] {
  return plan.columns.map((column): TableCellValue => {
    if (column.kind === 'field') {
      return projectOrderTableCell(order, column.field, customFieldValues);
    }
    const item = order.items[column.itemIndex];
    if (!item) return null;
    if (column.value === 'product') return displayedProductTitle(item);
    if (column.value === 'specification') return displayedProductSpecification(item);
    return item.quantity;
  });
}

export function projectOrderItemTableCell(
  item: OrderItemWorkbenchItem & {
    systemOrderNumber?: string;
    readableOrderNumber?: string | null;
    orderNumber?: string;
  },
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
    case 'system_order_number': return item.systemOrderNumber ?? null;
    case 'readable_order_number': return item.readableOrderNumber ?? null;
    case 'order_number': return item.orderNumber ?? null;
    case 'item_sequence': return item.position + 1;
    case 'product_title': return item.sourceTitle;
    case 'product_spec': return item.sourceSpec;
    case 'sku': return item.standardProduct?.sku ?? '';
    case 'standard_product_name': return item.standardProduct?.name ?? '';
    case 'standard_product_spec': return item.standardProduct?.specification ?? '';
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
): TableTemplateLayoutItem[] {
  if (!Array.isArray(value)) throw new Error('表格模板列必须是数组');
  if (value.length === 0) throw new Error('表格模板至少选择一个字段');
  if (value.length > MAX_COLUMNS) throw new Error(`表格模板字段不能超过 ${MAX_COLUMNS} 个`);
  const availableKeys = new Set(
    availableTableFields(granularity, customFieldDefinitions)
      .map(({ reference }) => fieldReferenceKey(reference)),
  );
  const columns = value.map((entry): TableTemplateLayoutItem => {
    if (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).kind === 'dynamic_product_group'
    ) {
      if (granularity !== 'order') {
        throw new Error('动态商品列组只能用于订单总表模板');
      }
      const group = strictRecord(entry, '动态商品列组', ['kind', 'labels']);
      const labels = strictRecord(
        group.labels,
        '动态商品列组基础表头',
        ['product', 'specification', 'quantity'],
      );
      const normalized: DynamicProductTableGroup = {
        kind: 'dynamic_product_group',
        labels: {
          product: nonEmptyText(labels.product, '商品基础表头', MAX_DISPLAY_NAME_LENGTH),
          specification: nonEmptyText(
            labels.specification,
            '款式或规格基础表头',
            MAX_DISPLAY_NAME_LENGTH,
          ),
          quantity: nonEmptyText(labels.quantity, '数量基础表头', MAX_DISPLAY_NAME_LENGTH),
        },
      };
      return normalized;
    }
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
  rejectDuplicates(columns.map(tableTemplateLayoutItemKey), '表格模板字段不能重复');
  rejectDuplicates(
    columns.flatMap((column) => (
      isDynamicProductTableGroup(column) ? [] : [column.displayName]
    )),
    '字段显示名称不能重复',
  );
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
): OrderWorkbenchQuery | OrderItemWorkbenchQuery | ShipmentGroupWorkbenchQuery {
  const allowedKeys = granularity === 'order'
    ? ORDER_QUERY_KEYS
    : granularity === 'order_item'
      ? ORDER_ITEM_QUERY_KEYS
      : SHIPMENT_GROUP_QUERY_KEYS;
  const record = strictRecord(value, '表格模板查询', allowedKeys);
  const common = normalizeCustomQueryParts(record, granularity, customFieldDefinitions);
  if (granularity === 'shipment_group') {
    const query: ShipmentGroupWorkbenchQuery = { ...common };
    if (record.text !== undefined) {
      query.text = nonEmptyText(record.text, '综合搜索', MAX_QUERY_TEXT_LENGTH);
    }
    assignOptionalEnum(
      query,
      'sortField',
      record.sortField,
      SHIPMENT_GROUP_SORT_FIELDS,
      '发货组排序字段',
    );
    assignOptionalEnum(query, 'sortDirection', record.sortDirection, SORT_DIRECTIONS, '排序方向');
    if (query.sortField && query.customFieldSort) {
      throw new Error('发货组一次只能使用一种排序');
    }
    return query;
  }
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
      '订单商品明细排序字段',
    );
    assignOptionalEnum(query, 'sortDirection', record.sortDirection, SORT_DIRECTIONS, '排序方向');
    if (query.sortField && query.customFieldSort) {
      throw new Error('订单商品明细一次只能使用一种排序');
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
  if (record.repurchase !== undefined) {
    if (typeof record.repurchase !== 'boolean') throw new Error('回购筛选格式错误');
    query.repurchase = record.repurchase;
  }
  assignOptionalEnum(query, 'sortField', record.sortField, ORDER_SORT_FIELDS, '排序字段');
  assignOptionalEnum(query, 'sortDirection', record.sortDirection, SORT_DIRECTIONS, '排序方向');
  return query;
}

function normalizeCustomQueryParts(
  record: Record<string, unknown>,
  granularity: TableTemplateGranularity,
  customFieldDefinitions: readonly CustomFieldDefinition[],
): Pick<ShipmentGroupWorkbenchQuery, 'customFieldFilter' | 'customFieldSort'> {
  const result: Pick<ShipmentGroupWorkbenchQuery, 'customFieldFilter' | 'customFieldSort'> = {};
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
  TQuery extends OrderWorkbenchQuery | OrderItemWorkbenchQuery | ShipmentGroupWorkbenchQuery,
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
