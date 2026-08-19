export type FinanceRecordTypeName =
  | 'order_transaction'
  | 'platform_settlement'
  | 'platform_fee'
  | 'initial_freight'
  | 'return_freight'
  | 'replacement_freight'
  | 'refund'
  | 'interception_fee'
  | 'carrier_claim'
  | 'purchase_cost'
  | 'misc_expense';

export type FinanceDirectionName = 'income' | 'expense';

export type FinanceConfirmedSourceName = 'manual_confirmation';

export type FinanceSourceTypeName =
  | 'order'
  | 'shipment_record'
  | 'aftersales_case'
  | 'purchase_order'
  | 'supplier_return'
  | 'logistics_exception';

export type FinancePendingStatusName = 'pending' | 'cancelled';

export type FinancePendingItemView = {
  id: string;
  type: FinanceRecordTypeName;
  direction: FinanceDirectionName;
  amountCents: number;
  currency: 'CNY';
  status: FinancePendingStatusName;
  confirmedCents: number;
  remainingCents: number;
  sourceType: FinanceSourceTypeName;
  sourceId: string;
  note: string;
  occurredAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
};

export type FinanceRecordView = {
  id: string;
  sequence: number;
  type: FinanceRecordTypeName;
  direction: FinanceDirectionName;
  amountCents: number;
  currency: 'CNY';
  confirmedSource: FinanceConfirmedSourceName;
  confirmedAt: string;
  occurredAt: string;
  pendingItemId: string | null;
  sourceType: FinanceSourceTypeName | null;
  sourceId: string | null;
  reversesRecordId: string | null;
  note: string;
  createdAt: string;
};

export type FinanceTypeTotalView = {
  type: FinanceRecordTypeName;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
};

export type FinancePendingTotalView = {
  type: FinanceRecordTypeName;
  count: number;
  amountCents: number;
  remainingCents: number;
};

export type FundsView = {
  pendingItems: FinancePendingItemView[];
  records: FinanceRecordView[];
  typeTotals: FinanceTypeTotalView[];
  pendingTotals: FinancePendingTotalView[];
  totals: {
    incomeCents: number;
    expenseCents: number;
    netCents: number;
    pendingRemainingCents: number;
  };
};

export type RecordPendingFinanceItemInput = {
  type: FinanceRecordTypeName;
  amountCents: number;
  sourceType: FinanceSourceTypeName;
  sourceId: string;
  note: string;
  occurredAt: string;
};

export type ConfirmPendingFinanceItemInput = {
  pendingItemId: string;
  amountCents: number;
  occurredAt?: string;
  note?: string;
};

export type CancelPendingFinanceItemInput = {
  pendingItemId: string;
  reason: string;
};

export type RecordFinanceRecordInput = {
  type: FinanceRecordTypeName;
  direction: FinanceDirectionName;
  amountCents: number;
  occurredAt: string;
  note: string;
};

export type ReverseFinanceRecordInput = {
  recordId: string;
  amountCents: number;
  occurredAt?: string;
  note: string;
};

export const FINANCE_RECORD_TYPES: readonly FinanceRecordTypeName[] = [
  'order_transaction',
  'platform_settlement',
  'platform_fee',
  'initial_freight',
  'return_freight',
  'replacement_freight',
  'refund',
  'interception_fee',
  'carrier_claim',
  'purchase_cost',
  'misc_expense',
];

const PENDING_TYPES: readonly FinanceRecordTypeName[] = FINANCE_RECORD_TYPES
  .filter((type) => type !== 'misc_expense');

export function financeDirectionOfType(type: FinanceRecordTypeName): FinanceDirectionName {
  if (type === 'order_transaction'
    || type === 'platform_settlement'
    || type === 'carrier_claim') {
    return 'income';
  }
  return 'expense';
}

export function normalizeRecordPendingFinanceItemInput(
  input: unknown,
): RecordPendingFinanceItemInput {
  const record = objectValue(input, '待确认资金事项参数无效');
  rejectUnknownKeys(
    record,
    ['type', 'amountCents', 'sourceType', 'sourceId', 'note', 'occurredAt'],
    '待确认资金事项参数无效',
  );
  const type = financeRecordType(record.type, '待确认资金事项参数无效');
  if (!PENDING_TYPES.includes(type)) {
    throw new Error('其他人工费用或补偿直接录入资金记录，不建立待确认事项');
  }
  return {
    type,
    amountCents: positiveMoney(record.amountCents, '待确认金额无效'),
    sourceType: financeSource(record.sourceType, '来源类型无效'),
    sourceId: identifier(record.sourceId, '来源标识无效'),
    note: requiredNote(record.note, '请填写待确认事项说明'),
    occurredAt: requiredTime(record.occurredAt, '待确认事项发生时间无效'),
  };
}

export function normalizeConfirmPendingFinanceItemInput(
  input: unknown,
): ConfirmPendingFinanceItemInput {
  const record = objectValue(input, '确认待确认事项参数无效');
  rejectUnknownKeys(
    record,
    ['pendingItemId', 'amountCents', 'occurredAt', 'note'],
    '确认待确认事项参数无效',
  );
  return {
    pendingItemId: identifier(record.pendingItemId, '待确认事项标识无效'),
    amountCents: positiveMoney(record.amountCents, '确认金额无效'),
    occurredAt: optionalTime(record.occurredAt, '确认发生时间无效'),
    note: optionalNote(record.note, '确认备注无效'),
  };
}

export function normalizeCancelPendingFinanceItemInput(
  input: unknown,
): CancelPendingFinanceItemInput {
  const record = objectValue(input, '取消待确认事项参数无效');
  rejectUnknownKeys(record, ['pendingItemId', 'reason'], '取消待确认事项参数无效');
  return {
    pendingItemId: identifier(record.pendingItemId, '待确认事项标识无效'),
    reason: requiredNote(record.reason, '请填写取消原因'),
  };
}

export function normalizeRecordFinanceRecordInput(
  input: unknown,
): RecordFinanceRecordInput {
  const record = objectValue(input, '资金记录参数无效');
  rejectUnknownKeys(
    record,
    ['type', 'direction', 'amountCents', 'occurredAt', 'note'],
    '资金记录参数无效',
  );
  const type = financeRecordType(record.type, '资金记录参数无效');
  const direction = financeDirection(record.direction, '收支方向无效');
  if (type !== 'misc_expense' && financeDirectionOfType(type) !== direction) {
    throw new Error(`${financeRecordTypeLabel(type)}的收支方向只能是${
      financeDirectionLabel(financeDirectionOfType(type))
    }`);
  }
  return {
    type,
    direction,
    amountCents: positiveMoney(record.amountCents, '资金金额无效'),
    occurredAt: requiredTime(record.occurredAt, '资金发生时间无效'),
    note: requiredNote(record.note, '请填写资金记录说明'),
  };
}

export function normalizeReverseFinanceRecordInput(
  input: unknown,
): ReverseFinanceRecordInput {
  const record = objectValue(input, '冲正参数无效');
  rejectUnknownKeys(
    record,
    ['recordId', 'amountCents', 'occurredAt', 'note'],
    '冲正参数无效',
  );
  return {
    recordId: identifier(record.recordId, '资金记录标识无效'),
    amountCents: positiveMoney(record.amountCents, '冲正金额无效'),
    occurredAt: optionalTime(record.occurredAt, '冲正发生时间无效'),
    note: requiredNote(record.note, '请填写冲正原因'),
  };
}

export function financeRecordTypeLabel(type: FinanceRecordTypeName): string {
  const labels: Record<FinanceRecordTypeName, string> = {
    order_transaction: '订单成交金额',
    platform_settlement: '平台实际结算收入',
    platform_fee: '平台服务费',
    initial_freight: '首次发货运费',
    return_freight: '退货运费',
    replacement_freight: '补发运费',
    refund: '退款',
    interception_fee: '物流拦截费用',
    carrier_claim: '丢件赔付或承运方理赔',
    purchase_cost: '商品采购成本',
    misc_expense: '其他人工费用或补偿',
  };
  return labels[type];
}

export function financeDirectionLabel(direction: FinanceDirectionName): string {
  return direction === 'income' ? '收入' : '支出';
}

export function financeConfirmedSourceLabel(source: FinanceConfirmedSourceName): string {
  return source === 'manual_confirmation' ? '人工确认' : source;
}

export function financeSourceLabel(source: FinanceSourceTypeName): string {
  const labels: Record<FinanceSourceTypeName, string> = {
    order: '原始订单',
    shipment_record: '发货记录',
    aftersales_case: '售后处理单',
    purchase_order: '采购订单',
    supplier_return: '供应方退货',
    logistics_exception: '物流异常',
  };
  return labels[source];
}

export function financePendingStatusLabel(status: FinancePendingStatusName): string {
  return status === 'pending' ? '待确认' : '已取消';
}

export function financeMoneyLabel(cents: number): string {
  return `${(cents / 100).toFixed(2)} 元`;
}

function financeRecordType(value: unknown, message: string): FinanceRecordTypeName {
  if (FINANCE_RECORD_TYPES.includes(value as FinanceRecordTypeName)) {
    return value as FinanceRecordTypeName;
  }
  throw new Error(message);
}

function financeDirection(value: unknown, message: string): FinanceDirectionName {
  if (value === 'income' || value === 'expense') return value;
  throw new Error(message);
}

function financeSource(value: unknown, message: string): FinanceSourceTypeName {
  if (value === 'order'
    || value === 'shipment_record'
    || value === 'aftersales_case'
    || value === 'purchase_order'
    || value === 'supplier_return'
    || value === 'logistics_exception') {
    return value;
  }
  throw new Error(message);
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(message);
}

function boundedText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(message);
  return normalized;
}

function requiredNote(value: unknown, message: string): string {
  return boundedText(value, 500, message);
}

function optionalNote(value: unknown, message: string): string {
  if (value === undefined || value === null) return '';
  return requiredNote(value, message);
}

function identifier(value: unknown, message: string): string {
  return boundedText(value, 200, message);
}

function positiveMoney(value: unknown, message: string): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) <= 0
    || Number(value) > 100_000_000_000
  ) throw new Error(message);
  return Number(value);
}

function requiredTime(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(message);
  return normalized;
}

function optionalTime(value: unknown, message: string): string {
  if (value === undefined || value === null) return '';
  return requiredTime(value, message);
}
