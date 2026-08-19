import type { InventoryStateName } from './inventory-ledger';

export type SupplierView = {
  supplierId: string;
  name: string;
  contact: string | null;
  note: string | null;
  createdAt: string;
};

export type PurchaseOrderStatus = 'draft' | 'confirmed' | 'cancelled';

export type PurchaseOrderEventType =
  | 'created'
  | 'confirmed'
  | 'quantity_changed'
  | 'expected_date_changed'
  | 'cancelled';

export type PurchaseOrderItemView = {
  id: string;
  standardProductId: string;
  sku: string;
  name: string;
  specification: string;
  quantity: number;
  unitPriceCents: number;
  receivedQuantity: number;
  supplierReturnedQuantity: number;
};

export type PurchaseOrderEventView = {
  sequence: number;
  eventType: PurchaseOrderEventType;
  itemId: string | null;
  quantity: number | null;
  reason: string;
  occurredAt: string;
};

export type PurchaseArrivalItemView = {
  id: string;
  orderItemId: string;
  standardProductId: string;
  sku: string;
  name: string;
  specification: string;
  receivedQuantity: number;
  resellableQuantity: number;
  defectiveQuantity: number;
  scrappedQuantity: number;
};

export type PurchaseArrivalView = {
  id: string;
  occurredAt: string;
  reason: string;
  items: PurchaseArrivalItemView[];
};

export type PurchasePayableView = {
  amountCents: number;
  createdAt: string;
  updatedAt: string;
};

export type PurchaseOrderView = {
  id: string;
  sequence: number;
  supplierId: string;
  supplierName: string;
  planId: string | null;
  planName: string | null;
  status: PurchaseOrderStatus;
  expectedAt: string;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  items: PurchaseOrderItemView[];
  events: PurchaseOrderEventView[];
  arrivals: PurchaseArrivalView[];
  payable: PurchasePayableView | null;
};

export type SupplierReturnItemView = {
  id: string;
  standardProductId: string;
  sku: string;
  name: string;
  specification: string;
  quantity: number;
  state: InventoryStateName;
};

export type SupplierReturnView = {
  id: string;
  supplierId: string;
  supplierName: string;
  purchaseOrderId: string | null;
  reason: string;
  occurredAt: string;
  createdAt: string;
  items: SupplierReturnItemView[];
};

export type PurchaseView = {
  suppliers: SupplierView[];
  orders: PurchaseOrderView[];
  supplierReturns: SupplierReturnView[];
};

export type CreateSupplierInput = {
  name: string;
  contact: string | null;
  note: string | null;
};

export type CreatePurchaseOrderInput = {
  supplierId: string;
  expectedAt: string;
  reason: string;
  items: Array<{
    standardProductId: string;
    quantity: number;
    unitPriceCents: number;
  }>;
};

export type CreatePurchaseOrderFromSuggestionInput = {
  suggestionId: string;
  supplierId: string;
  quantity: number;
  unitPriceCents: number;
  expectedAt: string;
  reason: string;
};

export type PurchaseOrderActionInput = {
  orderId: string;
  reason: string;
};

export type ChangePurchaseOrderItemQuantityInput = {
  orderId: string;
  itemId: string;
  quantity: number;
  reason: string;
};

export type ChangePurchaseOrderExpectedDateInput = {
  orderId: string;
  expectedAt: string;
  reason: string;
};

export type RecordPurchaseArrivalInput = {
  orderId: string;
  occurredAt: string;
  reason: string;
  items: Array<{
    orderItemId: string;
    receivedQuantity: number;
    resellableQuantity?: number;
    defectiveQuantity?: number;
    scrappedQuantity?: number;
  }>;
};

export type RecordSupplierReturnInput = {
  supplierId: string;
  purchaseOrderId: string | null;
  reason: string;
  occurredAt: string;
  items: Array<{
    standardProductId: string;
    quantity: number;
    state: InventoryStateName;
  }>;
};

export function normalizeCreateSupplierInput(input: unknown): CreateSupplierInput {
  const record = objectValue(input, '供应方参数无效');
  rejectUnknownKeys(record, ['name', 'contact', 'note'], '供应方参数无效');
  const contact = optionalBoundedText(record.contact, 100, '供应方联系方式无效');
  const note = optionalBoundedText(record.note, 500, '供应方备注无效');
  return {
    name: boundedText(record.name, 100, '供应方名称无效'),
    contact,
    note,
  };
}

export function normalizeCreatePurchaseOrderInput(
  input: unknown,
): CreatePurchaseOrderInput {
  const record = objectValue(input, '采购订单参数无效');
  rejectUnknownKeys(
    record,
    ['supplierId', 'expectedAt', 'reason', 'items'],
    '采购订单参数无效',
  );
  const rawItems = Array.isArray(record.items) ? record.items : null;
  if (!rawItems || rawItems.length === 0) throw new Error('采购订单至少需要一个商品行');
  const items = rawItems.map((item) => {
    const itemRecord = objectValue(item, '采购订单商品行无效');
    rejectUnknownKeys(
      itemRecord,
      ['standardProductId', 'quantity', 'unitPriceCents'],
      '采购订单商品行无效',
    );
    return {
      standardProductId: identifier(itemRecord.standardProductId, '标准商品标识无效'),
      quantity: positiveQuantity(itemRecord.quantity, '采购数量无效'),
      unitPriceCents: nonNegativeQuantity(itemRecord.unitPriceCents, '采购单价无效'),
    };
  });
  const productIds = new Set(items.map((item) => item.standardProductId));
  if (productIds.size !== items.length) throw new Error('同一商品在一张采购订单中只能占一行');
  return {
    supplierId: identifier(record.supplierId, '供应方标识无效'),
    expectedAt: requiredTime(record.expectedAt, '交期无效'),
    reason: requiredReason(record.reason),
    items,
  };
}

export function normalizeCreatePurchaseOrderFromSuggestionInput(
  input: unknown,
): CreatePurchaseOrderFromSuggestionInput {
  const record = objectValue(input, '建议转入采购订单参数无效');
  rejectUnknownKeys(
    record,
    ['suggestionId', 'supplierId', 'quantity', 'unitPriceCents', 'expectedAt', 'reason'],
    '建议转入采购订单参数无效',
  );
  return {
    suggestionId: identifier(record.suggestionId, '采购建议标识无效'),
    supplierId: identifier(record.supplierId, '供应方标识无效'),
    quantity: positiveQuantity(record.quantity, '采购数量无效'),
    unitPriceCents: nonNegativeQuantity(record.unitPriceCents, '采购单价无效'),
    expectedAt: requiredTime(record.expectedAt, '交期无效'),
    reason: requiredReason(record.reason),
  };
}

export function normalizePurchaseOrderActionInput(input: unknown): PurchaseOrderActionInput {
  const record = objectValue(input, '采购订单操作参数无效');
  rejectUnknownKeys(record, ['orderId', 'reason'], '采购订单操作参数无效');
  return {
    orderId: identifier(record.orderId, '采购订单标识无效'),
    reason: requiredReason(record.reason),
  };
}

export function normalizeChangePurchaseOrderItemQuantityInput(
  input: unknown,
): ChangePurchaseOrderItemQuantityInput {
  const record = objectValue(input, '采购数量变更参数无效');
  rejectUnknownKeys(
    record,
    ['orderId', 'itemId', 'quantity', 'reason'],
    '采购数量变更参数无效',
  );
  return {
    orderId: identifier(record.orderId, '采购订单标识无效'),
    itemId: identifier(record.itemId, '采购订单商品行标识无效'),
    quantity: positiveQuantity(record.quantity, '采购数量无效'),
    reason: requiredReason(record.reason),
  };
}

export function normalizeChangePurchaseOrderExpectedDateInput(
  input: unknown,
): ChangePurchaseOrderExpectedDateInput {
  const record = objectValue(input, '采购交期变更参数无效');
  rejectUnknownKeys(record, ['orderId', 'expectedAt', 'reason'], '采购交期变更参数无效');
  return {
    orderId: identifier(record.orderId, '采购订单标识无效'),
    expectedAt: requiredTime(record.expectedAt, '交期无效'),
    reason: requiredReason(record.reason),
  };
}

export function normalizeRecordPurchaseArrivalInput(
  input: unknown,
): RecordPurchaseArrivalInput {
  const record = objectValue(input, '采购到货参数无效');
  rejectUnknownKeys(
    record,
    ['orderId', 'occurredAt', 'reason', 'items'],
    '采购到货参数无效',
  );
  const rawItems = Array.isArray(record.items) ? record.items : null;
  if (!rawItems || rawItems.length === 0) throw new Error('采购到货至少需要一个商品行');
  const items = rawItems.map((item) => {
    const itemRecord = objectValue(item, '采购到货商品行无效');
    rejectUnknownKeys(
      itemRecord,
      ['orderItemId', 'receivedQuantity', 'resellableQuantity', 'defectiveQuantity', 'scrappedQuantity'],
      '采购到货商品行无效',
    );
    const receivedQuantity = positiveQuantity(
      itemRecord.receivedQuantity,
      '到货数量无效',
    );
    const resellableQuantity = optionalQuantity(
      itemRecord.resellableQuantity,
      '合格数量无效',
    );
    const defectiveQuantity = optionalQuantity(
      itemRecord.defectiveQuantity,
      '瑕疵数量无效',
    );
    const scrappedQuantity = optionalQuantity(
      itemRecord.scrappedQuantity,
      '报废数量无效',
    );
    if (resellableQuantity + defectiveQuantity + scrappedQuantity > receivedQuantity) {
      throw new Error('检查分类数量不能超过到货数量');
    }
    return {
      orderItemId: identifier(itemRecord.orderItemId, '采购订单商品行标识无效'),
      receivedQuantity,
      resellableQuantity,
      defectiveQuantity,
      scrappedQuantity,
    };
  });
  const orderItemIds = new Set(items.map((item) => item.orderItemId));
  if (orderItemIds.size !== items.length) {
    throw new Error('同一采购订单商品行在一次到货中只能登记一次');
  }
  return {
    orderId: identifier(record.orderId, '采购订单标识无效'),
    occurredAt: requiredTime(record.occurredAt, '到货时间无效'),
    reason: requiredReason(record.reason),
    items,
  };
}

export function normalizeRecordSupplierReturnInput(
  input: unknown,
): RecordSupplierReturnInput {
  const record = objectValue(input, '供应方退货参数无效');
  rejectUnknownKeys(
    record,
    ['supplierId', 'purchaseOrderId', 'reason', 'occurredAt', 'items'],
    '供应方退货参数无效',
  );
  const rawItems = Array.isArray(record.items) ? record.items : null;
  if (!rawItems || rawItems.length === 0) throw new Error('供应方退货至少需要一个商品行');
  const items = rawItems.map((item) => {
    const itemRecord = objectValue(item, '供应方退货商品行无效');
    rejectUnknownKeys(
      itemRecord,
      ['standardProductId', 'quantity', 'state'],
      '供应方退货商品行无效',
    );
    return {
      standardProductId: identifier(itemRecord.standardProductId, '标准商品标识无效'),
      quantity: positiveQuantity(itemRecord.quantity, '退货数量无效'),
      state: inventoryState(itemRecord.state),
    };
  });
  const lineKeys = new Set(items.map((item) => `${item.standardProductId}|${item.state}`));
  if (lineKeys.size !== items.length) {
    throw new Error('同一商品同一库存状态在一次退货中只能登记一行');
  }
  return {
    supplierId: identifier(record.supplierId, '供应方标识无效'),
    purchaseOrderId: record.purchaseOrderId === undefined || record.purchaseOrderId === null
      ? null
      : identifier(record.purchaseOrderId, '采购订单标识无效'),
    reason: requiredReason(record.reason),
    occurredAt: requiredTime(record.occurredAt, '退货时间无效'),
    items,
  };
}

export function purchaseOrderStatusLabel(status: PurchaseOrderStatus): string {
  const labels: Record<PurchaseOrderStatus, string> = {
    draft: '草稿',
    confirmed: '已确认',
    cancelled: '已取消',
  };
  return labels[status];
}

export function purchaseOrderEventLabel(eventType: PurchaseOrderEventType): string {
  const labels: Record<PurchaseOrderEventType, string> = {
    created: '创建',
    confirmed: '确认',
    quantity_changed: '数量变更',
    expected_date_changed: '交期变更',
    cancelled: '取消',
  };
  return labels[eventType];
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

function optionalBoundedText(value: unknown, maximum: number, message: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return boundedText(value, maximum, message);
}

function requiredReason(value: unknown): string {
  return boundedText(value, 500, '请填写非空原因');
}

function identifier(value: unknown, message: string): string {
  return boundedText(value, 200, message);
}

function requiredTime(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(message);
  return normalized;
}

function positiveQuantity(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(message);
  return Number(value);
}

function nonNegativeQuantity(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(message);
  return Number(value);
}

function optionalQuantity(value: unknown, message: string): number {
  if (value === undefined || value === null || value === '') return 0;
  return nonNegativeQuantity(value, message);
}
