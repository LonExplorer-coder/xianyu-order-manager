export type InventoryStateName =
  | 'sellable'
  | 'awaiting_inspection'
  | 'defective'
  | 'scrapped';

export type InventoryMovementDirection = 'in' | 'out';

export type InventoryMovementSourceType =
  | 'manual_adjustment'
  | 'inspection_result'
  | 'shipment_dispatch'
  | 'replacement_dispatch'
  | 'return_receipt'
  | 'purchase_arrival'
  | 'supplier_return';

export type InventoryProductView = {
  standardProductId: string;
  sku: string;
  name: string;
  specification: string;
  sellableQuantity: number;
  awaitingInspectionQuantity: number;
  defectiveQuantity: number;
  scrappedQuantity: number;
  reservedQuantity: number;
  purchaseInTransitQuantity: number;
};

export type InventoryMovementView = {
  id: string;
  sequence: number;
  standardProductId: string;
  sku: string;
  name: string;
  specification: string;
  quantity: number;
  direction: InventoryMovementDirection;
  state: InventoryStateName;
  sourceType: InventoryMovementSourceType;
  sourceId: string;
  reason: string;
  occurredAt: string;
  createdAt: string;
};

export type InventoryUnmappedPendingView = {
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
  orderCount: number;
};

export type InventoryView = {
  products: InventoryProductView[];
  unmappedPendingShipment: InventoryUnmappedPendingView[];
  movements: InventoryMovementView[];
};

export type RecordInventoryAdjustmentInput = {
  standardProductId: string;
  quantity: number;
  direction: InventoryMovementDirection;
  state: InventoryStateName;
  reason: string;
};

export type RecordInventoryInspectionInput = {
  standardProductId: string;
  sellableQuantity: number;
  defectiveQuantity: number;
  scrappedQuantity: number;
  reason: string;
};

export function normalizeRecordInventoryAdjustmentInput(
  input: unknown,
): RecordInventoryAdjustmentInput {
  const record = objectValue(input, '库存调整参数无效');
  rejectUnknownKeys(
    record,
    ['standardProductId', 'quantity', 'direction', 'state', 'reason'],
    '库存调整参数无效',
  );
  const direction = record.direction;
  if (direction !== 'in' && direction !== 'out') throw new Error('库存方向无效');
  return {
    standardProductId: identifier(record.standardProductId, '标准商品标识无效'),
    quantity: positiveQuantity(record.quantity, '库存数量无效'),
    direction,
    state: inventoryState(record.state),
    reason: requiredReason(record.reason),
  };
}

export function normalizeRecordInventoryInspectionInput(
  input: unknown,
): RecordInventoryInspectionInput {
  const record = objectValue(input, '库存检查参数无效');
  rejectUnknownKeys(
    record,
    ['standardProductId', 'sellableQuantity', 'defectiveQuantity', 'scrappedQuantity', 'reason'],
    '库存检查参数无效',
  );
  const sellableQuantity = nonNegativeQuantity(record.sellableQuantity, '合格数量无效');
  const defectiveQuantity = nonNegativeQuantity(record.defectiveQuantity, '瑕疵数量无效');
  const scrappedQuantity = nonNegativeQuantity(record.scrappedQuantity, '报废数量无效');
  if (sellableQuantity + defectiveQuantity + scrappedQuantity === 0) {
    throw new Error('请至少填写一个大于零的检查结果数量');
  }
  return {
    standardProductId: identifier(record.standardProductId, '标准商品标识无效'),
    sellableQuantity,
    defectiveQuantity,
    scrappedQuantity,
    reason: requiredReason(record.reason),
  };
}

export function inventoryStateLabel(state: InventoryStateName): string {
  const labels: Record<InventoryStateName, string> = {
    sellable: '可销售',
    awaiting_inspection: '待检查',
    defective: '瑕疵品',
    scrapped: '报废',
  };
  return labels[state];
}

export function inventoryMovementDirectionLabel(direction: InventoryMovementDirection): string {
  return direction === 'in' ? '入库' : '出库';
}

export function inventoryMovementSourceLabel(source: InventoryMovementSourceType): string {
  const labels: Record<InventoryMovementSourceType, string> = {
    manual_adjustment: '人工调整',
    inspection_result: '检查结果',
    shipment_dispatch: '订单发出',
    replacement_dispatch: '补发发出',
    return_receipt: '退货签收',
    purchase_arrival: '采购到货',
    supplier_return: '供应方退货',
  };
  return labels[source];
}

function inventoryState(value: unknown): InventoryStateName {
  if (
    value === 'sellable'
    || value === 'awaiting_inspection'
    || value === 'defective'
    || value === 'scrapped'
  ) {
    return value;
  }
  throw new Error('库存状态无效');
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

function requiredReason(value: unknown): string {
  return boundedText(value, 500, '请填写非空原因');
}

function identifier(value: unknown, message: string): string {
  return boundedText(value, 200, message);
}

function positiveQuantity(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(message);
  return Number(value);
}

function nonNegativeQuantity(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(message);
  return Number(value);
}
