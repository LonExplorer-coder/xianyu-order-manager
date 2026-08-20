import type {
  FulfillmentStatus,
  OrderFieldChange,
  PlatformTransactionStatus,
  RecognitionItem,
} from './contracts';

export const HISTORICAL_ORDER_COLUMN_KEYS = [
  'platform', 'sellerAccount', 'orderNumber', 'alipayTransactionNumber',
  'buyerNickname', 'recipient', 'phone', 'address', 'orderedAt', 'paidAt',
  'productTotal', 'shippingFee', 'amount', 'platformTransactionStatus',
  'fulfillmentStatus', 'itemTitle', 'itemSpec', 'unitPrice', 'quantity',
] as const;

export type HistoricalOrderColumnKey = (typeof HISTORICAL_ORDER_COLUMN_KEYS)[number];
export type HistoricalOrderColumns = Record<HistoricalOrderColumnKey, number | null>;

export type HistoricalOrderColumnMapping = {
  worksheet: string;
  columns: HistoricalOrderColumns;
};

export type HistoricalOrderImportInput = { columnMapping: HistoricalOrderColumnMapping };
export type HistoricalOrderImportConfirmationInput = HistoricalOrderImportInput & {
  previewToken: string;
};

export type HistoricalOrderWorkbookInspection = {
  worksheets: Array<{ name: string; headers: string[] }>;
  suggestedColumnMapping: HistoricalOrderColumnMapping;
};

export type HistoricalOrderImportAction = 'create' | 'update' | 'duplicate';

export type HistoricalOrderImportPreviewOrder = {
  rowNumbers: number[];
  platform: 'xianyu';
  sellerAccount: string;
  orderNumber: string;
  recipient: string;
  amountCents: number;
  itemCount: number;
  action: HistoricalOrderImportAction;
  existingOrderId: string | null;
  expectedRevision: number | null;
  changes: OrderFieldChange[];
  errors: string[];
};

export type HistoricalOrderImportErrorRow = {
  rowNumber: number;
  platform: string;
  sellerAccount: string;
  orderNumber: string;
  errors: string[];
};

export type HistoricalOrderImportPreview = {
  previewToken: string;
  orders: HistoricalOrderImportPreviewOrder[];
  errorRows: HistoricalOrderImportErrorRow[];
  summary: {
    createOrderCount: number;
    updateOrderCount: number;
    duplicateOrderCount: number;
    errorRowCount: number;
  };
};

export type HistoricalOrderImportResult = {
  createdOrderCount: number;
  updatedOrderCount: number;
  skippedDuplicateOrderCount: number;
  skippedErrorRowCount: number;
};

export type HistoricalOrderImportSelectionOutcome =
  | { kind: 'canceled' }
  | {
    kind: 'selected';
    sessionId: string;
    fileName: string;
    inspection: HistoricalOrderWorkbookInspection;
  };

export type HistoricalOrderErrorRowsDownloadOutcome =
  | { kind: 'cancelled' }
  | { kind: 'saved'; fileName: string; filePath: string; rowCount: number };

export type HistoricalOrderImportCandidate = {
  rowNumbers: number[];
  platform: 'xianyu';
  sellerAccount: string;
  orderNumber: string;
  alipayTransactionNumber: string;
  buyerNickname: string;
  recipient: string;
  phone: string;
  phoneNormalized: string;
  addressOriginal: string;
  addressNormalized: string;
  province: string;
  city: string;
  district: string;
  orderedAtOriginal: string;
  orderedAtNormalized: string;
  paidAtOriginal: string;
  paidAtNormalized: string;
  productTotalCents: number | null;
  shippingFeeCents: number | null;
  amountCents: number;
  platformTransactionStatus: PlatformTransactionStatus;
  fulfillmentStatus: FulfillmentStatus;
  items: Array<RecognitionItem & { id: string }>;
};

export function normalizeHistoricalOrderImportInput(value: unknown): HistoricalOrderImportInput {
  const record = requiredRecord(value, '历史订单导入内容');
  assertExactKeys(record, ['columnMapping'], '历史订单导入');
  return { columnMapping: normalizeHistoricalOrderColumnMapping(record.columnMapping) };
}

export function normalizeHistoricalOrderImportConfirmationInput(
  value: unknown,
): HistoricalOrderImportConfirmationInput {
  const record = requiredRecord(value, '历史订单导入确认内容');
  assertExactKeys(record, ['columnMapping', 'previewToken'], '历史订单导入确认');
  if (
    typeof record.previewToken !== 'string' || !record.previewToken.trim() ||
    record.previewToken.trim().length > 200
  ) throw new Error('历史订单预览标识无效');
  return {
    columnMapping: normalizeHistoricalOrderColumnMapping(record.columnMapping),
    previewToken: record.previewToken.trim(),
  };
}

function normalizeHistoricalOrderColumnMapping(value: unknown): HistoricalOrderColumnMapping {
  const record = requiredRecord(value, '历史订单列映射');
  assertExactKeys(record, ['worksheet', 'columns'], '历史订单列映射');
  if (typeof record.worksheet !== 'string') throw new Error('历史订单工作表名称无效');
  const worksheet = record.worksheet.normalize('NFKC').trim();
  if (!worksheet || worksheet.length > 31) throw new Error('历史订单工作表名称无效');
  const columnsRecord = requiredRecord(record.columns, '历史订单列映射');
  assertExactKeys(columnsRecord, HISTORICAL_ORDER_COLUMN_KEYS, '历史订单列映射');
  const columns = Object.fromEntries(HISTORICAL_ORDER_COLUMN_KEYS.map((key) => {
    const column = columnsRecord[key];
    if (column === null) return [key, null];
    if (!Number.isSafeInteger(column) || (column as number) < 1 || (column as number) > 200) {
      throw new Error('历史订单列编号无效');
    }
    return [key, column as number];
  })) as HistoricalOrderColumns;
  const selected = Object.values(columns).filter((column): column is number => column !== null);
  if (new Set(selected).size !== selected.length) throw new Error('历史订单列不能重复映射');
  return { worksheet, columns };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}无效`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  if (
    Object.keys(record).some((key) => !expected.has(key)) ||
    expectedKeys.some((key) => !Object.hasOwn(record, key))
  ) throw new Error(`${label}字段无效`);
}
