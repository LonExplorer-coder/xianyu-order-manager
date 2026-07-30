import {
  DEFAULT_ORDER_ITEM_TABLE_COLUMNS,
  type TableCellValue,
  type TableTemplateColumn,
} from './table-templates';

export type OrderExportScope = {
  kind: 'current_result' | 'selected_orders';
  orderIds: string[];
};

export type OrderExportInput = {
  scope: OrderExportScope;
  orderTemplateId: string | null;
  orderItemTemplateId: string | null;
  masking: 'default';
};

export type OrderExportWriteResult = {
  orderCount: number;
  orderItemCount: number;
};

export type OrderExportResult =
  | { kind: 'cancelled' }
  | ({
    kind: 'saved';
    fileName: string;
    filePath: string;
  } & OrderExportWriteResult);

export type OrderExportAddressRegion = {
  province: string;
  city: string;
  district: string;
};

export const DEFAULT_ORDER_EXPORT_COLUMNS: TableTemplateColumn[] = [
  { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
  { field: { kind: 'builtin', key: 'alipay_transaction_number' }, displayName: '支付宝交易号' },
  { field: { kind: 'builtin', key: 'platform' }, displayName: '平台' },
  { field: { kind: 'builtin', key: 'seller_account' }, displayName: '卖家账号' },
  { field: { kind: 'builtin', key: 'buyer_nickname' }, displayName: '买家' },
  { field: { kind: 'builtin', key: 'recipient' }, displayName: '收件人' },
  { field: { kind: 'builtin', key: 'phone' }, displayName: '手机号' },
  { field: { kind: 'builtin', key: 'address' }, displayName: '收货地址' },
  { field: { kind: 'builtin', key: 'product_summary' }, displayName: '商品' },
  { field: { kind: 'computed', key: 'item_quantity_total' }, displayName: '商品总数量' },
  { field: { kind: 'computed', key: 'order_total' }, displayName: '成交金额' },
  { field: { kind: 'builtin', key: 'platform_transaction_status' }, displayName: '平台交易状态' },
  { field: { kind: 'builtin', key: 'fulfillment_status' }, displayName: '履约状态' },
  { field: { kind: 'builtin', key: 'ordered_at' }, displayName: '下单时间' },
  { field: { kind: 'builtin', key: 'paid_at' }, displayName: '付款时间' },
  { field: { kind: 'builtin', key: 'created_at' }, displayName: '入库时间' },
];

export const DEFAULT_ORDER_ITEM_EXPORT_COLUMNS: TableTemplateColumn[] = [
  ...DEFAULT_ORDER_ITEM_TABLE_COLUMNS,
];

export function normalizeOrderExportInput(value: unknown): OrderExportInput {
  const input = strictRecord(
    value,
    '订单导出请求',
    ['scope', 'orderTemplateId', 'orderItemTemplateId', 'masking'],
  );
  const scope = strictRecord(input.scope, '订单导出范围', ['kind', 'orderIds']);
  if (scope.kind !== 'current_result' && scope.kind !== 'selected_orders') {
    throw new Error('订单导出范围无效');
  }
  if (input.masking !== 'default') throw new Error('订单导出脱敏方式无效');
  return {
    scope: {
      kind: scope.kind,
      orderIds: normalizeOrderExportOrderIds(scope.orderIds),
    },
    orderTemplateId: optionalTemplateId(input.orderTemplateId, '订单总表模板'),
    orderItemTemplateId: optionalTemplateId(input.orderItemTemplateId, '商品明细表模板'),
    masking: 'default',
  };
}

export function normalizeOrderExportOrderIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('请至少选择一笔订单导出');
  }
  if (value.length > 10_000) throw new Error('一次最多导出 10000 笔订单');
  const ids = value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('订单导出记录标识无效');
    const id = entry.trim();
    if (!id || id.length > 200) throw new Error('订单导出记录标识无效');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('订单导出记录不能重复');
  return ids;
}

export function maskRecipient(value: string): string {
  const characters = normalizedCharacters(value);
  if (characters.length === 0) return '';
  return `${characters[0]}${'*'.repeat(Math.max(2, characters.length - 1))}`;
}

export function maskPhone(value: string): string {
  const digits = value.normalize('NFKC').replace(/\D/gu, '');
  if (digits.length <= 7) return '***';
  return `${digits.slice(0, 3)}${'*'.repeat(digits.length - 7)}${digits.slice(-4)}`;
}

export function maskAddress(region: OrderExportAddressRegion): string {
  const parts = [region.province, region.city, region.district]
    .map((part) => part.normalize('NFKC').trim())
    .filter((part, index, all) => part && all.indexOf(part) === index);
  return parts.length > 0 ? `${parts.join('')}***` : '***';
}

export function maskBuyerNickname(value: string): string {
  const characters = normalizedCharacters(value);
  if (characters.length === 0) return '';
  if (characters.length === 1) return '*';
  return `${characters[0]}${'*'.repeat(Math.max(2, characters.length - 2))}${characters.at(-1)}`;
}

export function defaultMaskedOrderCell(
  fieldKey: string,
  value: TableCellValue,
  region: OrderExportAddressRegion,
): TableCellValue {
  if (typeof value !== 'string') return value;
  switch (fieldKey) {
    case 'buyer_nickname': return maskBuyerNickname(value);
    case 'recipient': return maskRecipient(value);
    case 'phone': return maskPhone(value);
    case 'address': return maskAddress(region);
    default: return value;
  }
}

function normalizedCharacters(value: string): string[] {
  return [...value.normalize('NFKC').trim()];
}

function optionalTemplateId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} ID 格式无效`);
  const id = value.trim();
  if (!id || id.length > 200) throw new Error(`${label} ID 格式无效`);
  return id;
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
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknownKey) throw new Error(`${label}包含未知属性：${unknownKey}`);
  return record;
}
