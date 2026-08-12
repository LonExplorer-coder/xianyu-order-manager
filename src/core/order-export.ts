import {
  DEFAULT_ORDER_ITEM_TABLE_COLUMNS,
  type TableCellValue,
  type TableTemplateColumn,
} from './table-templates';
import type { CustomFieldType } from './custom-fields';
import type { RecognitionBatchItemStatus } from './contracts';
import { FULFILLMENT_STATUS_LABELS, isFulfillmentStatus } from './fulfillment-status';

export type OrderExportScope = {
  kind: 'current_result' | 'selected_orders';
  orderIds: string[];
};

export type OrderExportInput = {
  scope: OrderExportScope;
  orderTemplateId: string | null;
  includeOrderItems: boolean;
  orderItemTemplateId: string | null;
  masking: 'masked' | 'original';
};

export type OrderExportWriteResult = {
  orderCount: number;
  orderItemCount: number | null;
};

export type OrderExportPreviewSheet = {
  name: '订单总表' | '订单商品明细表';
  columns: Array<{ header: string; valueType: CustomFieldType }>;
  rows: string[][];
  totalRowCount: number;
};

export type OrderExportPreviewResult = OrderExportWriteResult & {
  sheets: OrderExportPreviewSheet[];
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

export const DEFAULT_ORDER_ITEM_EXPORT_COLUMNS: TableTemplateColumn[] = [
  ...DEFAULT_ORDER_ITEM_TABLE_COLUMNS,
];

export function normalizeOrderExportInput(value: unknown): OrderExportInput {
  const input = strictRecord(
    value,
    '订单导出请求',
    ['scope', 'orderTemplateId', 'includeOrderItems', 'orderItemTemplateId', 'masking'],
  );
  const scope = strictRecord(input.scope, '订单导出范围', ['kind', 'orderIds']);
  if (scope.kind !== 'current_result' && scope.kind !== 'selected_orders') {
    throw new Error('订单导出范围无效');
  }
  if (input.masking !== 'masked' && input.masking !== 'original') {
    throw new Error('订单导出脱敏方式无效');
  }
  if (typeof input.includeOrderItems !== 'boolean') {
    throw new Error('订单商品明细表导出选项无效');
  }
  const orderItemTemplateId = optionalTemplateId(
    input.orderItemTemplateId,
    '订单商品明细表模板',
  );
  if (!input.includeOrderItems && orderItemTemplateId !== null) {
    throw new Error('未导出订单商品明细表时不能选择其模板');
  }
  return {
    scope: {
      kind: scope.kind,
      orderIds: normalizeOrderExportOrderIds(scope.orderIds),
    },
    orderTemplateId: optionalTemplateId(input.orderTemplateId, '订单总表模板'),
    includeOrderItems: input.includeOrderItems,
    orderItemTemplateId,
    masking: input.masking,
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

export function orderExportBuiltinTextLabel(
  key: string,
  value: string,
): string | undefined {
  if (key === 'platform') return value === 'xianyu' ? '闲鱼' : value;
  if (key === 'platform_transaction_status') {
    return {
      paid: '已付款',
      cancelled: '已取消',
      refunded: '已退款',
      unknown: '未知',
    }[value];
  }
  if (key === 'fulfillment_status') {
    return isFulfillmentStatus(value) ? FULFILLMENT_STATUS_LABELS[value] : undefined;
  }
  if (key === 'lifecycle_status') {
    return {
      active: '正常',
      trashed: '回收站',
      deleted: '已删除',
    }[value];
  }
  if (key === 'initial_source_recognition_status') {
    const labels: Record<RecognitionBatchItemStatus, string> = {
      waiting_recognition: '等待识别',
      recognizing: '识别中',
      validating: '校验中',
      awaiting_confirmation: '待确认',
      imported: '已入库',
      waiting_retry: '等待重试',
      failed: '失败',
      duplicate_skipped: '重复跳过',
      cancelled: '已取消',
    };
    return labels[value as RecognitionBatchItemStatus];
  }
  return undefined;
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
